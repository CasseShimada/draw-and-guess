import { createHash } from "node:crypto";
import {
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile
} from "node:fs/promises";
import path from "node:path";

import {
  BUILTIN_WORD_PACK,
  CONTENT_LIMITS,
  LocalAvatarSchema,
  LocalAvatarSourceSchema,
  RememberedNicknameSchema,
  WordPackFileSchema,
  WordPackSelectionSchema,
  parseWordPackBytes,
  serializeWordPack,
  summarizeWordPack,
  validateAvatarInputPng,
  validateNormalizedAvatarPng,
  type LocalAvatar,
  type WordPackFile,
  type WordPackSelection,
  type WordPackSummary
} from "@draw-guess/content";
import { z } from "zod";

const AvatarSourceMetadataSchema = z
  .object({
    mimeType: LocalAvatarSourceSchema.shape.mimeType,
    width: LocalAvatarSourceSchema.shape.width,
    height: LocalAvatarSourceSchema.shape.height,
    byteLength: LocalAvatarSourceSchema.shape.byteLength,
    sha256: LocalAvatarSourceSchema.shape.sha256
  })
  .strict()
  .refine(
    (source) => source.width * source.height <= CONTENT_LIMITS.avatarInputMaxPixels,
    "头像源文件像素数超限"
  );
const AvatarMetadataSchema = z
  .object({
    schemaVersion: LocalAvatarSchema.shape.schemaVersion,
    mimeType: LocalAvatarSchema.shape.mimeType,
    width: LocalAvatarSchema.shape.width,
    height: LocalAvatarSchema.shape.height,
    byteLength: LocalAvatarSchema.shape.byteLength,
    sha256: LocalAvatarSchema.shape.sha256,
    updatedAt: LocalAvatarSchema.shape.updatedAt,
    source: AvatarSourceMetadataSchema.optional()
  })
  .strict();
const PreferencesFileSchema = z
  .object({
    schemaVersion: z.literal(1),
    wordSelection: WordPackSelectionSchema.nullable(),
    rememberedNickname: RememberedNicknameSchema.nullable().default(null)
  })
  .strict();

type AvatarMetadata = z.infer<typeof AvatarMetadataSchema>;
type PreferencesFile = z.infer<typeof PreferencesFileSchema>;

export function migrateAvatarMetadata(input: unknown): AvatarMetadata | null {
  const current = AvatarMetadataSchema.safeParse(input);
  if (current.success) {
    return current.data;
  }
  if (typeof input !== "object" || input === null) {
    return null;
  }
  const legacy = input as Record<string, unknown>;
  const migrated = AvatarMetadataSchema.safeParse({
    schemaVersion: 1,
    mimeType: legacy.mimeType,
    width: legacy.width,
    height: legacy.height,
    byteLength: legacy.byteLength,
    sha256: legacy.sha256,
    updatedAt: legacy.updatedAt,
    source: legacy.source
  });
  return migrated.success ? migrated.data : null;
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

async function atomicWrite(
  filePath: string,
  bytes: Uint8Array | string
): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${String(process.pid)}.${crypto.randomUUID()}.tmp`;
  const backup = `${filePath}.${String(process.pid)}.bak`;
  await writeFile(temporary, bytes, {
    ...(typeof bytes === "string" ? { encoding: "utf8" as const } : {}),
    mode: 0o600
  });
  let movedOriginal = false;
  try {
    if (await exists(filePath)) {
      await rm(backup, { force: true });
      await rename(filePath, backup);
      movedOriginal = true;
    }
    await rename(temporary, filePath);
    if (movedOriginal) {
      await rm(backup, { force: true });
    }
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    if (movedOriginal && !(await exists(filePath))) {
      await rename(backup, filePath).catch(() => undefined);
    }
    throw error;
  }
}

async function atomicWriteGroup(
  entries: ReadonlyArray<{ filePath: string; value: Uint8Array | string }>,
  removePaths: readonly string[] = []
): Promise<void> {
  const nonce = `${String(process.pid)}.${crypto.randomUUID()}`;
  const entryPaths = new Set(entries.map((entry) => entry.filePath));
  const targets = [
    ...entries.map((entry) => entry.filePath),
    ...removePaths.filter((filePath) => !entryPaths.has(filePath))
  ];
  await Promise.all(
    targets.map((filePath) => mkdir(path.dirname(filePath), { recursive: true }))
  );
  const temporary = new Map(
    entries.map((entry) => [entry.filePath, `${entry.filePath}.${nonce}.tmp`])
  );
  const backups = new Map(
    targets.map((filePath) => [filePath, `${filePath}.${nonce}.bak`])
  );
  try {
    await Promise.all(
      entries.map((entry) =>
        writeFile(temporary.get(entry.filePath)!, entry.value, {
          ...(typeof entry.value === "string" ? { encoding: "utf8" as const } : {}),
          mode: 0o600
        })
      )
    );
  } catch (error) {
    await Promise.all(
      [...temporary.values()].map((filePath) => rm(filePath, { force: true }))
    ).catch(() => undefined);
    throw error;
  }
  const backedUp = new Set<string>();
  const installed = new Set<string>();
  try {
    for (const target of targets) {
      if (await exists(target)) {
        await rename(target, backups.get(target)!);
        backedUp.add(target);
      }
    }
    for (const entry of entries) {
      await rename(temporary.get(entry.filePath)!, entry.filePath);
      installed.add(entry.filePath);
    }
    await Promise.all(
      [...backedUp].map((target) => rm(backups.get(target)!, { force: true }))
    ).catch(() => undefined);
  } catch (error) {
    await Promise.all(
      [...temporary.values()].map((filePath) => rm(filePath, { force: true }))
    ).catch(() => undefined);
    await Promise.all(
      [...installed].map((filePath) => rm(filePath, { force: true }))
    ).catch(() => undefined);
    for (const target of backedUp) {
      await rename(backups.get(target)!, target).catch(() => undefined);
    }
    throw error;
  }
}

async function readLimited(filePath: string, maximum: number): Promise<Uint8Array> {
  const info = await stat(filePath);
  if (!info.isFile() || info.size < 1 || info.size > maximum) {
    throw new Error("本地内容文件大小无效");
  }
  return new Uint8Array(await readFile(filePath));
}

export class ContentStorageService {
  readonly #root: string;
  readonly #wordPacks: string;
  readonly #profile: string;
  readonly #avatarPath: string;
  readonly #avatarSourcePath: string;
  readonly #profilePath: string;
  readonly #preferencesPath: string;
  #preferencesWrites: Promise<void> = Promise.resolve();

  constructor(userDataPath: string) {
    this.#root = path.join(userDataPath, "content", "v1");
    this.#wordPacks = path.join(this.#root, "word-packs");
    this.#profile = path.join(userDataPath, "profile");
    this.#avatarPath = path.join(this.#profile, "avatar.png");
    this.#avatarSourcePath = path.join(this.#profile, "avatar-source.png");
    this.#profilePath = path.join(this.#profile, "profile.json");
    this.#preferencesPath = path.join(this.#root, "preferences.json");
  }

  async initialize(): Promise<void> {
    await Promise.all([
      mkdir(this.#wordPacks, { recursive: true }),
      mkdir(this.#profile, { recursive: true })
    ]);
  }

  async listWordPacks(): Promise<WordPackSummary[]> {
    const entries = await readdir(this.#wordPacks, { withFileTypes: true });
    const summaries: WordPackSummary[] = [];
    for (const entry of entries) {
      if (
        !entry.isFile() ||
        !/^[a-f0-9-]{36}\.json$/i.test(entry.name) ||
        summaries.length >= CONTENT_LIMITS.localWordPacks
      ) {
        continue;
      }
      try {
        const pack = parseWordPackBytes(
          await readLimited(
            path.join(this.#wordPacks, entry.name),
            CONTENT_LIMITS.wordPackFileBytes
          )
        );
        summaries.push(summarizeWordPack(pack));
      } catch {
        // A corrupt individual pack is ignored and never overwrites other packs.
      }
    }
    return summaries.sort(
      (left, right) =>
        left.name.localeCompare(right.name, "zh-CN") || left.id.localeCompare(right.id)
    );
  }

  async getWordPack(id: string): Promise<WordPackFile | null> {
    const parsedId = z.uuid().parse(id);
    if (parsedId === BUILTIN_WORD_PACK.id) {
      return structuredClone(BUILTIN_WORD_PACK);
    }
    try {
      return parseWordPackBytes(
        await readLimited(
          path.join(this.#wordPacks, `${parsedId}.json`),
          CONTENT_LIMITS.wordPackFileBytes
        )
      );
    } catch {
      return null;
    }
  }

  async putWordPack(packInput: WordPackFile): Promise<void> {
    const pack = WordPackFileSchema.parse(packInput);
    if (pack.id === BUILTIN_WORD_PACK.id) {
      throw new Error("内置基础词库是只读的，请先复制");
    }
    const summaries = await this.listWordPacks();
    if (
      !summaries.some((summary) => summary.id === pack.id) &&
      summaries.length >= CONTENT_LIMITS.localWordPacks
    ) {
      throw new Error("本机最多保存 200 个用户词库包");
    }
    await atomicWrite(
      path.join(this.#wordPacks, `${pack.id}.json`),
      serializeWordPack(pack)
    );
  }

  async removeWordPack(id: string): Promise<void> {
    const parsedId = z.uuid().parse(id);
    if (parsedId === BUILTIN_WORD_PACK.id) {
      throw new Error("内置基础词库不能删除");
    }
    await rm(path.join(this.#wordPacks, `${parsedId}.json`), { force: true });
  }

  async getAvatar(): Promise<LocalAvatar | null> {
    try {
      const metadata = migrateAvatarMetadata(
        JSON.parse(await readFile(this.#profilePath, "utf8")) as unknown
      );
      if (!metadata) {
        return null;
      }
      const bytes = await readLimited(this.#avatarPath, CONTENT_LIMITS.avatarBytes);
      validateNormalizedAvatarPng(bytes);
      if (createHash("sha256").update(bytes).digest("hex") !== metadata.sha256) {
        return null;
      }
      const { source: sourceMetadata, ...avatarMetadata } = metadata;
      let source: LocalAvatar["source"];
      if (sourceMetadata) {
        try {
          const sourceBytes = await readLimited(
            this.#avatarSourcePath,
            CONTENT_LIMITS.avatarInputBytes
          );
          const sourceInfo = validateAvatarInputPng(sourceBytes);
          if (
            sourceBytes.byteLength !== sourceMetadata.byteLength ||
            sourceInfo.width !== sourceMetadata.width ||
            sourceInfo.height !== sourceMetadata.height ||
            createHash("sha256").update(sourceBytes).digest("hex") !==
              sourceMetadata.sha256
          ) {
            throw new Error("头像源文件元数据不一致");
          }
          source = { ...sourceMetadata, bytes: sourceBytes };
        } catch {
          source = undefined;
        }
      }
      return LocalAvatarSchema.parse({
        ...avatarMetadata,
        bytes,
        ...(source ? { source } : {})
      });
    } catch {
      return null;
    }
  }

  async putAvatar(avatarInput: LocalAvatar): Promise<void> {
    const avatar = LocalAvatarSchema.parse(avatarInput);
    validateNormalizedAvatarPng(avatar.bytes);
    if (createHash("sha256").update(avatar.bytes).digest("hex") !== avatar.sha256) {
      throw new Error("头像 SHA-256 与规范化 PNG 不一致");
    }
    if (avatar.source) {
      const sourceInfo = validateAvatarInputPng(avatar.source.bytes);
      if (
        sourceInfo.width !== avatar.source.width ||
        sourceInfo.height !== avatar.source.height ||
        createHash("sha256").update(avatar.source.bytes).digest("hex") !==
          avatar.source.sha256
      ) {
        throw new Error("头像源文件与元数据不一致");
      }
    }
    const { bytes, source, ...avatarMetadata } = avatar;
    const sourceMetadata = source
      ? AvatarSourceMetadataSchema.parse(
          Object.fromEntries(Object.entries(source).filter(([key]) => key !== "bytes"))
        )
      : undefined;
    const metadata = AvatarMetadataSchema.parse({
      ...avatarMetadata,
      ...(sourceMetadata ? { source: sourceMetadata } : {})
    });
    await atomicWriteGroup(
      [
        { filePath: this.#avatarPath, value: bytes },
        {
          filePath: this.#profilePath,
          value: `${JSON.stringify(metadata, null, 2)}\n`
        },
        ...(source ? [{ filePath: this.#avatarSourcePath, value: source.bytes }] : [])
      ],
      source ? [] : [this.#avatarSourcePath]
    );
  }

  async removeAvatar(): Promise<void> {
    await Promise.all([
      rm(this.#avatarPath, { force: true }),
      rm(this.#avatarSourcePath, { force: true }),
      rm(this.#profilePath, { force: true })
    ]);
  }

  async #readPreferencesFile(): Promise<PreferencesFile> {
    try {
      return PreferencesFileSchema.parse(
        JSON.parse(await readFile(this.#preferencesPath, "utf8")) as unknown
      );
    } catch {
      return {
        schemaVersion: 1,
        wordSelection: null,
        rememberedNickname: null
      };
    }
  }

  #updatePreferences(
    update: (preferences: PreferencesFile) => PreferencesFile
  ): Promise<void> {
    const operation = this.#preferencesWrites.then(async () => {
      const next = PreferencesFileSchema.parse(
        update(await this.#readPreferencesFile())
      );
      await atomicWrite(this.#preferencesPath, `${JSON.stringify(next, null, 2)}\n`);
    });
    this.#preferencesWrites = operation.catch(() => undefined);
    return operation;
  }

  async getWordSelection(): Promise<WordPackSelection | null> {
    await this.#preferencesWrites;
    return (await this.#readPreferencesFile()).wordSelection;
  }

  async putWordSelection(selectionInput: WordPackSelection): Promise<void> {
    const wordSelection = WordPackSelectionSchema.parse(selectionInput);
    await this.#updatePreferences((preferences) => ({
      ...preferences,
      wordSelection
    }));
  }

  async getRememberedNickname(): Promise<string | null> {
    await this.#preferencesWrites;
    return (await this.#readPreferencesFile()).rememberedNickname;
  }

  async putRememberedNickname(nicknameInput: string): Promise<void> {
    const rememberedNickname = RememberedNicknameSchema.parse(nicknameInput);
    await this.#updatePreferences((preferences) => ({
      ...preferences,
      rememberedNickname
    }));
  }

  async readImportFiles(
    filePaths: readonly string[]
  ): Promise<Array<{ name: string; bytes: Uint8Array }>> {
    const files: Array<{ name: string; bytes: Uint8Array }> = [];
    for (const filePath of filePaths.slice(0, 20)) {
      files.push({
        name: path.basename(filePath),
        bytes: await readLimited(filePath, CONTENT_LIMITS.wordPackFileBytes)
      });
    }
    return files;
  }

  async saveExport(filePath: string, bytes: Uint8Array): Promise<void> {
    parseWordPackBytes(bytes);
    await atomicWrite(filePath, bytes);
  }

  async reset(): Promise<void> {
    await this.#preferencesWrites;
    await Promise.all([
      rm(this.#root, { recursive: true, force: true }),
      this.removeAvatar()
    ]);
    await this.initialize();
  }
}
