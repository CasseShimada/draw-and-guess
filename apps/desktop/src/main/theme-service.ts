import { randomUUID } from "node:crypto";
import {
  copyFile,
  mkdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile
} from "node:fs/promises";
import path from "node:path";

import {
  CONTENT_LIMITS,
  THEME_API_VERSION,
  ThemeApplyModeSchema,
  type ThemeApplyMode
} from "@draw-guess/content";
import { protocol } from "electron";
import { z } from "zod";

import { ThemeStatusSchema, type ThemeStatus } from "../shared/ipc.js";
import {
  compileThemeCss,
  isInside,
  sha256,
  THEME_PROTOCOL,
  themeApiVersionFromSource,
  type CompiledThemeAsset
} from "./theme-compiler.js";
import type { RedactingLogger } from "./redacting-logger.js";
import type { SettingsService } from "./settings-service.js";

export { THEME_PROTOCOL } from "./theme-compiler.js";

const SOURCE_FILE = "source.css";
const COMPILED_FILE = "compiled.css";
const MANIFEST_FILE = "manifest.json";
const COMPILED_ASSET_DIRECTORY = "assets";
const HASH_SCHEMA = z.string().regex(/^[a-f0-9]{64}$/u);
const THEME_ASSET_MIME_SCHEMA = z.enum([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
  "font/woff",
  "font/woff2"
]);

const ThemeAssetSchema = z
  .object({
    sourcePath: z.string().min(1).max(512),
    compiledPath: z.string().regex(/^assets\/[a-f0-9]{16}-[A-Za-z0-9._-]+$/u),
    byteLength: z.number().int().positive(),
    sha256: HASH_SCHEMA,
    mimeType: THEME_ASSET_MIME_SCHEMA
  })
  .strict();

export const ThemeManifestSchema = z
  .object({
    schemaVersion: z.literal(2),
    themeApiVersion: z.number().int().positive(),
    applyMode: ThemeApplyModeSchema,
    sourceFile: z.literal(SOURCE_FILE),
    compiledFile: z.literal(COMPILED_FILE),
    sourceFileName: z.string().min(1).max(260),
    sourceBytes: z.number().int().nonnegative().max(CONTENT_LIMITS.themeCssBytes),
    compiledBytes: z.number().int().nonnegative().max(CONTENT_LIMITS.themeCssBytes),
    sourceHash: HASH_SCHEMA,
    compiledHash: HASH_SCHEMA,
    updatedAt: z.string().datetime({ offset: true }),
    assets: z.array(ThemeAssetSchema).max(CONTENT_LIMITS.themeAssetFiles)
  })
  .strict();

const LegacyThemeAssetSchema = z
  .object({
    original: z.string().min(1).max(512),
    storedName: z.string().regex(/^[a-f0-9]{16}-[A-Za-z0-9._-]+$/u),
    byteLength: z.number().int().positive(),
    sha256: HASH_SCHEMA,
    mimeType: THEME_ASSET_MIME_SCHEMA
  })
  .strict();

const LegacyThemeManifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    sourceFileName: z.string().min(1).max(260),
    importedAt: z.string().datetime({ offset: true }),
    cssBytes: z.number().int().positive().max(CONTENT_LIMITS.themeCssBytes),
    cssSha256: HASH_SCHEMA,
    assets: z.array(LegacyThemeAssetSchema).max(CONTENT_LIMITS.themeAssetFiles)
  })
  .strict();

export type ThemeManifest = z.infer<typeof ThemeManifestSchema>;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "未知主题错误";
}

function normalizedAssetSegments(reference: string): string[] {
  const segments = reference
    .replaceAll("\\", "/")
    .split("/")
    .filter((segment) => segment !== ".");
  if (segments.some((segment) => !segment || segment === "..")) {
    throw new Error(`主题素材路径无效：${reference}`);
  }
  return segments;
}

export class ThemeService {
  readonly #themesRoot: string;
  readonly #activeRoot: string;
  readonly #templatePath: string;
  readonly #settings: SettingsService;
  readonly #logger: RedactingLogger;
  #manifest: ThemeManifest | null = null;
  #safeMode = false;
  #error: string | null = null;

  constructor(
    userDataPath: string,
    settings: SettingsService,
    logger: RedactingLogger,
    templatePath = path.resolve(
      process.cwd(),
      "apps",
      "desktop",
      "assets",
      "drawguess-theme-template.css"
    )
  ) {
    this.#themesRoot = path.resolve(userDataPath, "themes");
    this.#activeRoot = path.join(this.#themesRoot, "active");
    this.#templatePath = path.resolve(templatePath);
    this.#settings = settings;
    this.#logger = logger;
  }

  get status(): ThemeStatus {
    const compatible = this.#manifest?.themeApiVersion === THEME_API_VERSION;
    return ThemeStatusSchema.parse({
      installed: Boolean(this.#manifest),
      enabled:
        Boolean(this.#manifest) &&
        compatible &&
        this.#settings.settings.customCssEnabled &&
        !this.#safeMode,
      fileName: this.#manifest?.sourceFileName ?? null,
      importedAt: this.#manifest?.updatedAt ?? null,
      assetCount: this.#manifest?.assets.length ?? 0,
      cssBytes: this.#manifest?.compiledBytes ?? 0,
      safeMode: this.#safeMode,
      error: this.#error,
      applyMode: this.#manifest?.applyMode ?? null,
      themeApiVersion: this.#manifest?.themeApiVersion ?? null,
      supportedThemeApiVersion: THEME_API_VERSION,
      sourcePath: this.#manifest ? path.join(this.#activeRoot, SOURCE_FILE) : null,
      workDirectory: this.#manifest ? this.#activeRoot : this.#themesRoot
    });
  }

  async initialize(safeMode = false): Promise<void> {
    await mkdir(this.#themesRoot, { recursive: true });
    this.#safeMode = safeMode;
    if (safeMode && this.#settings.settings.customCssEnabled) {
      await this.#settings.update({ customCssEnabled: false });
    }
    try {
      const rawManifest = JSON.parse(
        await readFile(path.join(this.#activeRoot, MANIFEST_FILE), "utf8")
      ) as unknown;
      const current = ThemeManifestSchema.safeParse(rawManifest);
      this.#manifest = current.success
        ? current.data
        : await this.#migrateLegacy(LegacyThemeManifestSchema.parse(rawManifest));
      const sourceChanged = await this.#validateActiveFiles(this.#manifest);
      if (this.#manifest.themeApiVersion !== THEME_API_VERSION) {
        this.#safeMode = true;
        this.#error = `主题接口版本 ${String(
          this.#manifest.themeApiVersion
        )} 与当前版本 ${String(THEME_API_VERSION)} 不兼容；源文件已保留`;
      } else {
        this.#error = sourceChanged
          ? "source.css 已在外部修改；当前继续使用上一份 compiled.css，请点击“重新载入 CSS”"
          : null;
      }
    } catch (error) {
      this.#manifest = null;
      if (await this.#activeExists()) {
        this.#error = `本地主题无效：${errorMessage(error)}`;
      }
    }
  }

  async activeCss(): Promise<string | null> {
    if (!this.status.enabled || !this.#manifest) {
      return null;
    }
    try {
      const css = await readFile(
        path.join(this.#activeRoot, this.#manifest.compiledFile),
        "utf8"
      );
      const bytes = Buffer.from(css, "utf8");
      if (
        bytes.byteLength !== this.#manifest.compiledBytes ||
        sha256(bytes) !== this.#manifest.compiledHash
      ) {
        throw new Error("主题 compiled.css 与 manifest 校验不一致");
      }
      return css;
    } catch (error) {
      this.#safeMode = true;
      this.#error = `主题 CSS 读取失败：${errorMessage(error)}`;
      return null;
    }
  }

  async importFromPath(
    cssPathInput: string,
    applyMode: ThemeApplyMode
  ): Promise<ThemeStatus> {
    const cssPath = path.resolve(cssPathInput);
    const info = await stat(cssPath);
    if (
      !info.isFile() ||
      path.extname(cssPath).toLowerCase() !== ".css" ||
      info.size > CONTENT_LIMITS.themeCssBytes
    ) {
      throw new Error("CSS 文件必须是不超过 512 KiB 的 .css 文件");
    }
    const sourceRoot = await realpath(path.dirname(cssPath));
    const source = await readFile(cssPath, "utf8");
    return this.#installSource({
      source,
      sourceRoot,
      sourceFileName: path.basename(cssPath),
      applyMode,
      enableAfterInstall: true
    });
  }

  async createFromDefaultTemplate(): Promise<ThemeStatus> {
    const source = await this.defaultTemplateCss();
    return this.#installSource({
      source,
      sourceRoot: path.dirname(this.#templatePath),
      sourceFileName: "drawguess-theme-template.css",
      applyMode: "replace",
      enableAfterInstall: true
    });
  }

  async defaultTemplateCss(): Promise<string> {
    const css = await readFile(this.#templatePath, "utf8");
    if (
      !css.includes(`Theme API Version: ${String(THEME_API_VERSION)}`) ||
      !css.includes("Apply Mode: replace")
    ) {
      throw new Error("内置默认模板版本头无效");
    }
    return css;
  }

  async exportDefaultTemplate(targetPathInput: string): Promise<void> {
    const targetPath = path.resolve(targetPathInput);
    if (path.extname(targetPath).toLowerCase() !== ".css") {
      throw new Error("默认模板必须导出为 .css 文件");
    }
    const css = await this.defaultTemplateCss();
    await writeFile(targetPath, css, { encoding: "utf8", mode: 0o600 });
  }

  async reload(): Promise<ThemeStatus> {
    if (!this.#manifest) {
      throw new Error("当前没有可重新载入的主题");
    }
    const sourcePath = path.join(this.#activeRoot, SOURCE_FILE);
    const source = await readFile(sourcePath, "utf8");
    return this.#installSource({
      source,
      sourceRoot: await realpath(this.#activeRoot),
      sourceFileName: this.#manifest.sourceFileName,
      applyMode: this.#manifest.applyMode,
      enableAfterInstall: this.#settings.settings.customCssEnabled
    });
  }

  async enable(): Promise<ThemeStatus> {
    if (!this.#manifest) {
      throw new Error("当前没有已导入的自定义 CSS");
    }
    if (this.#manifest.themeApiVersion !== THEME_API_VERSION) {
      throw new Error(
        `主题接口版本不兼容：主题为 ${String(
          this.#manifest.themeApiVersion
        )}，应用支持 ${String(THEME_API_VERSION)}`
      );
    }
    this.#safeMode = false;
    this.#error = null;
    await this.#settings.update({ customCssEnabled: true });
    return this.status;
  }

  suspend(reason: string): ThemeStatus {
    this.#safeMode = true;
    this.#error = reason.trim() || "自定义 CSS 导致当前必要界面不可用";
    this.#logger.warn("本地主题已自动进入安全模式", {
      reason: this.#error
    });
    return this.status;
  }

  async disable(): Promise<ThemeStatus> {
    this.#safeMode = false;
    this.#error = null;
    await this.#settings.update({ customCssEnabled: false });
    return this.status;
  }

  async delete(): Promise<ThemeStatus> {
    await this.disable();
    if (!isInside(this.#themesRoot, this.#activeRoot)) {
      throw new Error("主题目录边界校验失败");
    }
    await rm(this.#activeRoot, { recursive: true, force: true });
    this.#manifest = null;
    this.#error = null;
    return this.status;
  }

  get workDirectory(): string {
    return this.#manifest ? this.#activeRoot : this.#themesRoot;
  }

  registerProtocol(): Promise<void> {
    protocol.handle(THEME_PROTOCOL, (request) => this.responseForProtocol(request.url));
    return Promise.resolve();
  }

  async responseForProtocol(requestUrl: string): Promise<Response> {
    try {
      const url = new URL(requestUrl);
      if (url.protocol !== `${THEME_PROTOCOL}:` || url.host !== "active") {
        return new Response("Not found", { status: 404 });
      }
      const match = /^\/assets\/([^/]+)$/u.exec(decodeURIComponent(url.pathname));
      const compiledName = match?.[1];
      const asset = this.#manifest?.assets.find(
        (candidate) =>
          candidate.compiledPath === `${COMPILED_ASSET_DIRECTORY}/${compiledName ?? ""}`
      );
      if (!compiledName || !asset || path.basename(compiledName) !== compiledName) {
        return new Response("Not found", { status: 404 });
      }
      const assetRoot = path.join(this.#activeRoot, COMPILED_ASSET_DIRECTORY);
      const target = path.resolve(assetRoot, compiledName);
      if (!isInside(assetRoot, target)) {
        return new Response("Forbidden", { status: 403 });
      }
      const bytes = await readFile(target);
      if (bytes.byteLength !== asset.byteLength || sha256(bytes) !== asset.sha256) {
        return new Response("Not found", { status: 404 });
      }
      return new Response(Uint8Array.from(bytes), {
        headers: {
          "Content-Type": asset.mimeType,
          "Content-Length": String(bytes.byteLength),
          "Cache-Control": "private, max-age=31536000, immutable",
          "Content-Security-Policy": "default-src 'none'",
          "X-Content-Type-Options": "nosniff"
        }
      });
    } catch {
      return new Response("Bad request", { status: 400 });
    }
  }

  async #installSource({
    source,
    sourceRoot,
    sourceFileName,
    applyMode,
    enableAfterInstall
  }: {
    source: string;
    sourceRoot: string;
    sourceFileName: string;
    applyMode: ThemeApplyMode;
    enableAfterInstall: boolean;
  }): Promise<ThemeStatus> {
    const staging = path.join(this.#themesRoot, `.staging-${randomUUID()}`);
    const backup = path.join(this.#themesRoot, `.backup-${randomUUID()}`);
    if (!isInside(this.#themesRoot, staging) || !isInside(this.#themesRoot, backup)) {
      throw new Error("主题暂存目录无效");
    }

    const previousManifest = this.#manifest;
    const previousSafeMode = this.#safeMode;
    const previousEnabled = this.#settings.settings.customCssEnabled;
    let hadActive = false;
    let swapped = false;
    try {
      const themeApiVersion = themeApiVersionFromSource(source);
      const compiled = await compileThemeCss(source, {
        themeId: "active",
        applyMode,
        sourceRoot,
        themeApiVersion
      });
      await this.#writeStaging(
        staging,
        source,
        sourceFileName,
        applyMode,
        themeApiVersion,
        compiled.css,
        compiled.assets
      );
      const manifest = ThemeManifestSchema.parse(
        JSON.parse(await readFile(path.join(staging, MANIFEST_FILE), "utf8")) as unknown
      );
      hadActive = await this.#activeExists();
      if (hadActive) {
        await rename(this.#activeRoot, backup);
      }
      try {
        await rename(staging, this.#activeRoot);
        swapped = true;
      } catch (error) {
        if (hadActive) {
          await rename(backup, this.#activeRoot).catch(() => undefined);
        }
        throw error;
      }
      await this.#settings.update({ customCssEnabled: enableAfterInstall });
      this.#manifest = manifest;
      this.#safeMode = false;
      this.#error = null;
      await rm(backup, { recursive: true, force: true }).catch(() => undefined);
      this.#logger.info("本地主题已原子编译并安装", {
        applyMode,
        assetCount: manifest.assets.length,
        compiledBytes: manifest.compiledBytes,
        themeApiVersion: manifest.themeApiVersion
      });
      return this.status;
    } catch (error) {
      await rm(staging, { recursive: true, force: true }).catch(() => undefined);
      if (swapped) {
        await rm(this.#activeRoot, { recursive: true, force: true }).catch(
          () => undefined
        );
        if (hadActive) {
          await rename(backup, this.#activeRoot).catch(() => undefined);
        }
      }
      this.#manifest = previousManifest;
      this.#safeMode = previousSafeMode;
      this.#error = `主题编译失败，已保留上一份可用主题：${errorMessage(error)}`;
      if (this.#settings.settings.customCssEnabled !== previousEnabled) {
        await this.#settings
          .update({ customCssEnabled: previousEnabled })
          .catch(() => undefined);
      }
      throw error;
    }
  }

  async #writeStaging(
    staging: string,
    source: string,
    sourceFileName: string,
    applyMode: ThemeApplyMode,
    themeApiVersion: number,
    compiledCss: string,
    assets: CompiledThemeAsset[]
  ): Promise<void> {
    await mkdir(path.join(staging, COMPILED_ASSET_DIRECTORY), { recursive: true });
    for (const asset of assets) {
      const sourceTarget = path.resolve(
        staging,
        ...normalizedAssetSegments(asset.sourceReference)
      );
      if (!isInside(staging, sourceTarget)) {
        throw new Error("主题源素材复制目标越界");
      }
      await mkdir(path.dirname(sourceTarget), { recursive: true });
      await copyFile(asset.sourcePath, sourceTarget);

      const compiledTarget = path.join(
        staging,
        COMPILED_ASSET_DIRECTORY,
        asset.compiledName
      );
      await copyFile(asset.sourcePath, compiledTarget);
    }

    const sourceBytes = Buffer.from(source, "utf8");
    const compiledBytes = Buffer.from(compiledCss, "utf8");
    const manifest = ThemeManifestSchema.parse({
      schemaVersion: 2,
      themeApiVersion,
      applyMode,
      sourceFile: SOURCE_FILE,
      compiledFile: COMPILED_FILE,
      sourceFileName,
      sourceBytes: sourceBytes.byteLength,
      compiledBytes: compiledBytes.byteLength,
      sourceHash: sha256(sourceBytes),
      compiledHash: sha256(compiledBytes),
      updatedAt: new Date().toISOString(),
      assets: assets.map((asset) => ({
        sourcePath: asset.sourceReference,
        compiledPath: `${COMPILED_ASSET_DIRECTORY}/${asset.compiledName}`,
        byteLength: asset.byteLength,
        sha256: asset.sha256,
        mimeType: asset.mimeType
      }))
    });
    await Promise.all([
      writeFile(path.join(staging, SOURCE_FILE), sourceBytes, { mode: 0o600 }),
      writeFile(path.join(staging, COMPILED_FILE), compiledBytes, { mode: 0o600 }),
      writeFile(
        path.join(staging, MANIFEST_FILE),
        `${JSON.stringify(manifest, null, 2)}\n`,
        { encoding: "utf8", mode: 0o600 }
      )
    ]);
  }

  async #validateActiveFiles(manifest: ThemeManifest): Promise<boolean> {
    const [source, compiled] = await Promise.all([
      readFile(path.join(this.#activeRoot, manifest.sourceFile)),
      readFile(path.join(this.#activeRoot, manifest.compiledFile))
    ]);
    if (
      compiled.byteLength !== manifest.compiledBytes ||
      sha256(compiled) !== manifest.compiledHash
    ) {
      throw new Error("主题 compiled.css 与 manifest 校验不一致");
    }
    if (source.byteLength > CONTENT_LIMITS.themeCssBytes) {
      throw new Error("主题 source.css 超过 512 KiB");
    }
    return (
      source.byteLength !== manifest.sourceBytes ||
      sha256(source) !== manifest.sourceHash
    );
  }

  async #migrateLegacy(legacy: z.infer<typeof LegacyThemeManifestSchema>) {
    const legacyCssPath = path.join(this.#activeRoot, "style.css");
    const bytes = await readFile(legacyCssPath);
    if (bytes.byteLength !== legacy.cssBytes || sha256(bytes) !== legacy.cssSha256) {
      throw new Error("旧主题 CSS 与 manifest 校验不一致");
    }
    const manifest = ThemeManifestSchema.parse({
      schemaVersion: 2,
      themeApiVersion: THEME_API_VERSION,
      applyMode: "override",
      sourceFile: SOURCE_FILE,
      compiledFile: COMPILED_FILE,
      sourceFileName: legacy.sourceFileName,
      sourceBytes: bytes.byteLength,
      compiledBytes: bytes.byteLength,
      sourceHash: legacy.cssSha256,
      compiledHash: legacy.cssSha256,
      updatedAt: legacy.importedAt,
      assets: legacy.assets.map((asset) => ({
        sourcePath: asset.original,
        compiledPath: `${COMPILED_ASSET_DIRECTORY}/${asset.storedName}`,
        byteLength: asset.byteLength,
        sha256: asset.sha256,
        mimeType: asset.mimeType
      }))
    });
    await Promise.all([
      writeFile(path.join(this.#activeRoot, SOURCE_FILE), bytes, { mode: 0o600 }),
      writeFile(path.join(this.#activeRoot, COMPILED_FILE), bytes, { mode: 0o600 }),
      writeFile(
        path.join(this.#activeRoot, MANIFEST_FILE),
        `${JSON.stringify(manifest, null, 2)}\n`,
        { encoding: "utf8", mode: 0o600 }
      )
    ]);
    this.#logger.info("已将旧版主题清单迁移到 schema 2", {
      applyMode: "override",
      themeApiVersion: THEME_API_VERSION
    });
    return manifest;
  }

  async #activeExists(): Promise<boolean> {
    try {
      return (await stat(this.#activeRoot)).isDirectory();
    } catch {
      return false;
    }
  }
}
