import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import { z } from "zod";

import {
  DesktopSettingsSchema,
  SettingsPatchSchema,
  type DesktopSettings,
  type SettingsPatch
} from "../shared/ipc.js";
import {
  connectionHostKind,
  connectionTargetFromOrigin,
  normalizeConnectionTarget,
  type ConnectionTarget
} from "../shared/server-url.js";

export interface EncryptionProvider {
  isAvailable(): boolean;
  backend(): string;
  encrypt(value: string): Uint8Array;
  decrypt(value: Uint8Array): string;
}

interface StoredSession {
  token: string;
  expiresAt: number;
}

const CredentialFileSchema = z
  .object({
    schemaVersion: z.literal(1),
    sessions: z.record(
      z.string().url(),
      z
        .object({
          encryptedToken: z.string(),
          expiresAt: z.number()
        })
        .strict()
    )
  })
  .strict();

type CredentialFile = z.infer<typeof CredentialFileSchema>;

const DEFAULT_TARGET: ConnectionTarget = {
  host: "127.0.0.1",
  port: 3000,
  security: "http"
};

const DesktopSettingsV5Schema = DesktopSettingsSchema.extend({
  schemaVersion: z.literal(5)
});

export const DEFAULT_DESKTOP_SETTINGS: DesktopSettings = {
  schemaVersion: 6,
  currentClientTarget: DEFAULT_TARGET,
  hostPort: 3000,
  hostBindMode: "loopback-only",
  preferredLanAddressId: null,
  recentConnections: [],
  publicEndpoint: null,
  insecureHttpConfirmations: [],
  minimizeToTray: false,
  launchAtLogin: false,
  stopSharingShortcut: "CommandOrControl+Shift+S",
  qualityPreset: "balanced",
  onboardingComplete: false,
  customCssEnabled: false,
  notificationsEnabled: false,
  ffmpegExecutable: null,
  replayOutputDirectory: null,
  replayMaxJobGiB: 4,
  replayMaxTemporaryGiB: 10,
  replayMinimumFreeGiB: 2,
  cropPresets: {}
};

function safeValue<T>(schema: z.ZodType<T>, value: unknown, fallback: T): T {
  const parsed = schema.safeParse(value);
  return parsed.success ? parsed.data : fallback;
}

function basicTarget(target: ConnectionTarget): ConnectionTarget {
  const normalized = normalizeConnectionTarget(target);
  return {
    host: normalized.host,
    port: normalized.port,
    security: normalized.security
  };
}

function originFor(targetOrOrigin: ConnectionTarget | string): string {
  return typeof targetOrOrigin === "string"
    ? connectionTargetFromOrigin(targetOrOrigin).origin
    : normalizeConnectionTarget(targetOrOrigin).origin;
}

function migratedLegacyTarget(legacy: Record<string, unknown>): ConnectionTarget {
  if (typeof legacy.serverUrl !== "string") {
    return { ...DEFAULT_TARGET };
  }
  try {
    return basicTarget(connectionTargetFromOrigin(legacy.serverUrl));
  } catch {
    return { ...DEFAULT_TARGET };
  }
}

function dedupeRecent(
  recent: DesktopSettings["recentConnections"]
): DesktopSettings["recentConnections"] {
  const sorted = [...recent].sort(
    (left, right) => right.lastConnectedAt - left.lastConnectedAt
  );
  const origins = new Set<string>();
  const result: DesktopSettings["recentConnections"] = [];
  for (const item of sorted) {
    const target = basicTarget(item.target);
    const origin = originFor(target);
    if (origins.has(origin)) {
      continue;
    }
    origins.add(origin);
    result.push({ ...item, target });
    if (result.length === 8) {
      break;
    }
  }
  return result;
}

export function migrateDesktopSettings(input: unknown): DesktopSettings {
  const current = DesktopSettingsSchema.safeParse(input);
  if (current.success) {
    return {
      ...current.data,
      recentConnections: dedupeRecent(current.data.recentConnections)
    };
  }
  const version5 = DesktopSettingsV5Schema.safeParse(input);
  if (version5.success) {
    return DesktopSettingsSchema.parse({
      ...version5.data,
      schemaVersion: 6,
      minimizeToTray: false,
      recentConnections: dedupeRecent(version5.data.recentConnections)
    });
  }
  if (typeof input !== "object" || input === null) {
    return structuredClone(DEFAULT_DESKTOP_SETTINGS);
  }
  const legacy = input as Record<string, unknown>;
  const target = migratedLegacyTarget(legacy);
  const hostPort = safeValue(
    DesktopSettingsSchema.shape.hostPort,
    typeof legacy.port === "number" ? legacy.port : legacy.hostPort,
    DEFAULT_DESKTOP_SETTINGS.hostPort
  );
  const candidate: DesktopSettings = {
    schemaVersion: 6,
    currentClientTarget: target,
    hostPort,
    hostBindMode: legacy.allowLan === true ? "lan" : "loopback-only",
    preferredLanAddressId: null,
    recentConnections: [
      {
        target,
        label: null,
        lastConnectedAt: 0
      }
    ],
    publicEndpoint: null,
    insecureHttpConfirmations: [],
    minimizeToTray: false,
    launchAtLogin: safeValue(
      DesktopSettingsSchema.shape.launchAtLogin,
      legacy.launchAtLogin,
      DEFAULT_DESKTOP_SETTINGS.launchAtLogin
    ),
    stopSharingShortcut: safeValue(
      DesktopSettingsSchema.shape.stopSharingShortcut,
      legacy.stopSharingShortcut,
      DEFAULT_DESKTOP_SETTINGS.stopSharingShortcut
    ),
    qualityPreset: safeValue(
      DesktopSettingsSchema.shape.qualityPreset,
      legacy.qualityPreset,
      DEFAULT_DESKTOP_SETTINGS.qualityPreset
    ),
    onboardingComplete: safeValue(
      DesktopSettingsSchema.shape.onboardingComplete,
      legacy.onboardingComplete,
      DEFAULT_DESKTOP_SETTINGS.onboardingComplete
    ),
    customCssEnabled: safeValue(
      DesktopSettingsSchema.shape.customCssEnabled,
      legacy.customCssEnabled,
      DEFAULT_DESKTOP_SETTINGS.customCssEnabled
    ),
    notificationsEnabled: safeValue(
      DesktopSettingsSchema.shape.notificationsEnabled,
      legacy.notificationsEnabled,
      DEFAULT_DESKTOP_SETTINGS.notificationsEnabled
    ),
    ffmpegExecutable: safeValue(
      DesktopSettingsSchema.shape.ffmpegExecutable,
      legacy.ffmpegExecutable,
      DEFAULT_DESKTOP_SETTINGS.ffmpegExecutable
    ),
    replayOutputDirectory: safeValue(
      DesktopSettingsSchema.shape.replayOutputDirectory,
      legacy.replayOutputDirectory,
      DEFAULT_DESKTOP_SETTINGS.replayOutputDirectory
    ),
    replayMaxJobGiB: safeValue(
      DesktopSettingsSchema.shape.replayMaxJobGiB,
      legacy.replayMaxJobGiB,
      DEFAULT_DESKTOP_SETTINGS.replayMaxJobGiB
    ),
    replayMaxTemporaryGiB: safeValue(
      DesktopSettingsSchema.shape.replayMaxTemporaryGiB,
      legacy.replayMaxTemporaryGiB,
      DEFAULT_DESKTOP_SETTINGS.replayMaxTemporaryGiB
    ),
    replayMinimumFreeGiB: safeValue(
      DesktopSettingsSchema.shape.replayMinimumFreeGiB,
      legacy.replayMinimumFreeGiB,
      DEFAULT_DESKTOP_SETTINGS.replayMinimumFreeGiB
    ),
    cropPresets: safeValue(
      DesktopSettingsSchema.shape.cropPresets,
      legacy.cropPresets,
      DEFAULT_DESKTOP_SETTINGS.cropPresets
    )
  };
  const migrated = DesktopSettingsSchema.safeParse(candidate);
  return migrated.success ? migrated.data : structuredClone(DEFAULT_DESKTOP_SETTINGS);
}

export class SettingsService {
  readonly #settingsPath: string;
  readonly #credentialsPath: string;
  readonly #encryption: EncryptionProvider;
  #settings: DesktopSettings = structuredClone(DEFAULT_DESKTOP_SETTINGS);
  #credentials: CredentialFile = { schemaVersion: 1, sessions: {} };
  readonly #memorySessions = new Map<string, StoredSession>();
  #writeChain: Promise<void> = Promise.resolve();

  constructor(userDataPath: string, encryption: EncryptionProvider) {
    this.#settingsPath = path.join(userDataPath, "settings.json");
    this.#credentialsPath = path.join(userDataPath, "credentials.json");
    this.#encryption = encryption;
  }

  get secureStorageAvailable(): boolean {
    return (
      this.#encryption.isAvailable() && this.#encryption.backend() !== "basic_text"
    );
  }

  get settings(): DesktopSettings {
    return structuredClone(this.#settings);
  }

  async initialize(): Promise<void> {
    this.#settings = migrateDesktopSettings(await this.#readJson(this.#settingsPath));
    await this.#writeJson(this.#settingsPath, this.#settings);

    if (this.secureStorageAvailable) {
      const parsed = CredentialFileSchema.safeParse(
        await this.#readJson(this.#credentialsPath)
      );
      this.#credentials = parsed.success
        ? this.#normalizeCredentials(parsed.data)
        : { schemaVersion: 1, sessions: {} };
      await this.#writeJson(this.#credentialsPath, this.#credentials);
    }
  }

  async update(patchInput: SettingsPatch): Promise<DesktopSettings> {
    const patch = SettingsPatchSchema.parse(patchInput);
    const candidate: DesktopSettings = {
      ...this.#settings,
      ...patch,
      currentClientTarget: patch.currentClientTarget
        ? basicTarget(patch.currentClientTarget)
        : this.#settings.currentClientTarget,
      recentConnections: patch.recentConnections
        ? dedupeRecent(patch.recentConnections)
        : this.#settings.recentConnections,
      publicEndpoint:
        patch.publicEndpoint === undefined
          ? this.#settings.publicEndpoint
          : patch.publicEndpoint
            ? {
                ...patch.publicEndpoint,
                target: basicTarget(patch.publicEndpoint.target)
              }
            : null,
      insecureHttpConfirmations: patch.insecureHttpConfirmations
        ? [...new Set(patch.insecureHttpConfirmations.map(originFor))].slice(-20)
        : this.#settings.insecureHttpConfirmations,
      cropPresets: patch.cropPresets ?? this.#settings.cropPresets
    };
    if (Object.keys(candidate.cropPresets).length > 50) {
      throw new Error("最多保存 50 个裁切预设");
    }
    if (candidate.replayMaxTemporaryGiB < candidate.replayMaxJobGiB) {
      throw new Error("总临时回放配额不能小于单局配额");
    }
    this.#settings = DesktopSettingsSchema.parse(candidate);
    await this.#writeJson(this.#settingsPath, this.#settings);
    return this.settings;
  }

  async addRecentConnection(
    targetInput: ConnectionTarget,
    label: string | null = null,
    now = Date.now()
  ): Promise<DesktopSettings> {
    const target = basicTarget(targetInput);
    const origin = originFor(target);
    return this.update({
      recentConnections: [
        { target, label, lastConnectedAt: now },
        ...this.#settings.recentConnections.filter(
          (item) => originFor(item.target) !== origin
        )
      ].slice(0, 8)
    });
  }

  async removeRecentConnection(
    targetInput: ConnectionTarget
  ): Promise<DesktopSettings> {
    const origin = originFor(targetInput);
    return this.update({
      recentConnections: this.#settings.recentConnections.filter(
        (item) => originFor(item.target) !== origin
      )
    });
  }

  insecureHttpConfirmed(targetInput: ConnectionTarget): boolean {
    const target = normalizeConnectionTarget(targetInput);
    return this.#settings.insecureHttpConfirmations.includes(target.origin);
  }

  async confirmInsecureHttp(targetInput: ConnectionTarget): Promise<void> {
    const target = normalizeConnectionTarget(targetInput);
    if (target.security !== "http" || connectionHostKind(target.host) !== "public") {
      return;
    }
    await this.update({
      insecureHttpConfirmations: [
        ...this.#settings.insecureHttpConfirmations.filter(
          (origin) => origin !== target.origin
        ),
        target.origin
      ].slice(-20)
    });
  }

  async reset(): Promise<DesktopSettings> {
    this.#settings = structuredClone(DEFAULT_DESKTOP_SETTINGS);
    this.#credentials = { schemaVersion: 1, sessions: {} };
    this.#memorySessions.clear();
    await Promise.all([
      this.#writeJson(this.#settingsPath, this.#settings),
      rm(this.#credentialsPath, { force: true })
    ]);
    return this.settings;
  }

  async saveSession(
    targetOrOrigin: ConnectionTarget | string,
    token: string,
    expiresAt: number
  ): Promise<void> {
    const origin = originFor(targetOrOrigin);
    this.#memorySessions.set(origin, { token, expiresAt });
    if (!this.secureStorageAvailable) {
      return;
    }
    const encrypted = this.#encryption.encrypt(token);
    this.#credentials.sessions[origin] = {
      encryptedToken: Buffer.from(encrypted).toString("base64"),
      expiresAt
    };
    await this.#writeJson(this.#credentialsPath, this.#credentials);
  }

  async session(
    targetOrOrigin: ConnectionTarget | string,
    now = Date.now()
  ): Promise<string | null> {
    const origin = originFor(targetOrOrigin);
    const memory = this.#memorySessions.get(origin);
    if (memory) {
      if (memory.expiresAt > now) {
        return memory.token;
      }
      this.#memorySessions.delete(origin);
    }
    if (!this.secureStorageAvailable) {
      return null;
    }
    const stored = this.#credentials.sessions[origin];
    if (!stored || stored.expiresAt <= now) {
      if (stored) {
        delete this.#credentials.sessions[origin];
        await this.#writeJson(this.#credentialsPath, this.#credentials);
      }
      return null;
    }
    try {
      const token = this.#encryption.decrypt(
        Buffer.from(stored.encryptedToken, "base64")
      );
      this.#memorySessions.set(origin, { token, expiresAt: stored.expiresAt });
      return token;
    } catch {
      delete this.#credentials.sessions[origin];
      await this.#writeJson(this.#credentialsPath, this.#credentials);
      return null;
    }
  }

  async clearSession(targetOrOrigin: ConnectionTarget | string): Promise<void> {
    const origin = originFor(targetOrOrigin);
    this.#memorySessions.delete(origin);
    delete this.#credentials.sessions[origin];
    if (this.secureStorageAvailable) {
      await this.#writeJson(this.#credentialsPath, this.#credentials);
    }
  }

  #normalizeCredentials(credentials: CredentialFile): CredentialFile {
    const sessions: CredentialFile["sessions"] = {};
    for (const [rawOrigin, stored] of Object.entries(credentials.sessions)) {
      try {
        sessions[originFor(rawOrigin)] = stored;
      } catch {
        // Invalid legacy origins are discarded instead of crossing server boundaries.
      }
    }
    return { schemaVersion: 1, sessions };
  }

  async #readJson(filePath: string): Promise<unknown> {
    try {
      return JSON.parse(await readFile(filePath, "utf8")) as unknown;
    } catch {
      return null;
    }
  }

  async #writeJson(filePath: string, value: unknown): Promise<void> {
    const serialized = `${JSON.stringify(value, null, 2)}\n`;
    const operation = async () => {
      await mkdir(path.dirname(filePath), { recursive: true });
      const nonce = `${String(process.pid)}.${randomUUID()}`;
      const temporaryPath = `${filePath}.${nonce}.tmp`;
      const backupPath = `${filePath}.${nonce}.bak`;
      await writeFile(temporaryPath, serialized, {
        encoding: "utf8",
        mode: 0o600
      });
      let movedOriginal = false;
      try {
        try {
          if ((await stat(filePath)).isFile()) {
            await rename(filePath, backupPath);
            movedOriginal = true;
          }
        } catch {
          // A missing destination has nothing to back up.
        }
        await rename(temporaryPath, filePath);
        if (movedOriginal) {
          await rm(backupPath, { force: true }).catch(() => undefined);
        }
      } catch (error) {
        await rm(temporaryPath, { force: true }).catch(() => undefined);
        if (movedOriginal) {
          await rm(filePath, { force: true }).catch(() => undefined);
          await rename(backupPath, filePath).catch(() => undefined);
        }
        throw error;
      }
    };
    const queued = this.#writeChain.then(operation, operation);
    this.#writeChain = queued.catch(() => undefined);
    await queued;
  }
}
