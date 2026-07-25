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
import { normalizeServerUrl } from "../shared/server-url.js";

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

export const DEFAULT_DESKTOP_SETTINGS: DesktopSettings = {
  schemaVersion: 4,
  serverUrl: "http://127.0.0.1:3000",
  hostPort: 3000,
  allowLan: false,
  minimizeToTray: true,
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

export function migrateDesktopSettings(input: unknown): DesktopSettings {
  const current = DesktopSettingsSchema.safeParse(input);
  if (current.success) {
    return current.data;
  }
  if (typeof input !== "object" || input === null) {
    return { ...DEFAULT_DESKTOP_SETTINGS };
  }
  const legacy = input as Record<string, unknown>;
  const candidate = {
    ...DEFAULT_DESKTOP_SETTINGS,
    serverUrl:
      typeof legacy.serverUrl === "string"
        ? legacy.serverUrl
        : DEFAULT_DESKTOP_SETTINGS.serverUrl,
    hostPort:
      typeof legacy.port === "number"
        ? legacy.port
        : typeof legacy.hostPort === "number"
          ? legacy.hostPort
          : DEFAULT_DESKTOP_SETTINGS.hostPort,
    allowLan:
      typeof legacy.allowLan === "boolean"
        ? legacy.allowLan
        : DEFAULT_DESKTOP_SETTINGS.allowLan,
    onboardingComplete:
      typeof legacy.onboardingComplete === "boolean"
        ? legacy.onboardingComplete
        : DEFAULT_DESKTOP_SETTINGS.onboardingComplete,
    customCssEnabled:
      typeof legacy.customCssEnabled === "boolean"
        ? legacy.customCssEnabled
        : DEFAULT_DESKTOP_SETTINGS.customCssEnabled,
    notificationsEnabled:
      typeof legacy.notificationsEnabled === "boolean"
        ? legacy.notificationsEnabled
        : DEFAULT_DESKTOP_SETTINGS.notificationsEnabled,
    ffmpegExecutable:
      typeof legacy.ffmpegExecutable === "string" ? legacy.ffmpegExecutable : null,
    replayOutputDirectory:
      typeof legacy.replayOutputDirectory === "string"
        ? legacy.replayOutputDirectory
        : null,
    replayMaxJobGiB:
      typeof legacy.replayMaxJobGiB === "number"
        ? legacy.replayMaxJobGiB
        : DEFAULT_DESKTOP_SETTINGS.replayMaxJobGiB,
    replayMaxTemporaryGiB:
      typeof legacy.replayMaxTemporaryGiB === "number"
        ? legacy.replayMaxTemporaryGiB
        : DEFAULT_DESKTOP_SETTINGS.replayMaxTemporaryGiB,
    replayMinimumFreeGiB:
      typeof legacy.replayMinimumFreeGiB === "number"
        ? legacy.replayMinimumFreeGiB
        : DEFAULT_DESKTOP_SETTINGS.replayMinimumFreeGiB
  };
  const migrated = DesktopSettingsSchema.safeParse(candidate);
  return migrated.success ? migrated.data : { ...DEFAULT_DESKTOP_SETTINGS };
}

export class SettingsService {
  readonly #settingsPath: string;
  readonly #credentialsPath: string;
  readonly #encryption: EncryptionProvider;
  #settings: DesktopSettings = { ...DEFAULT_DESKTOP_SETTINGS };
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
    try {
      this.#settings.serverUrl = normalizeServerUrl(this.#settings.serverUrl);
    } catch {
      this.#settings.serverUrl = DEFAULT_DESKTOP_SETTINGS.serverUrl;
    }
    await this.#writeJson(this.#settingsPath, this.#settings);

    if (this.secureStorageAvailable) {
      const parsed = CredentialFileSchema.safeParse(
        await this.#readJson(this.#credentialsPath)
      );
      this.#credentials = parsed.success
        ? parsed.data
        : { schemaVersion: 1, sessions: {} };
    }
  }

  async update(patchInput: SettingsPatch): Promise<DesktopSettings> {
    const patch = SettingsPatchSchema.parse(patchInput);
    const candidate: DesktopSettings = {
      ...this.#settings,
      ...patch,
      serverUrl: patch.serverUrl
        ? normalizeServerUrl(patch.serverUrl)
        : this.#settings.serverUrl,
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

  async reset(): Promise<DesktopSettings> {
    this.#settings = { ...DEFAULT_DESKTOP_SETTINGS, cropPresets: {} };
    this.#credentials = { schemaVersion: 1, sessions: {} };
    this.#memorySessions.clear();
    await Promise.all([
      this.#writeJson(this.#settingsPath, this.#settings),
      rm(this.#credentialsPath, { force: true })
    ]);
    return this.settings;
  }

  async saveSession(
    serverUrl: string,
    token: string,
    expiresAt: number
  ): Promise<void> {
    const origin = normalizeServerUrl(serverUrl);
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

  async session(serverUrl: string, now = Date.now()): Promise<string | null> {
    const origin = normalizeServerUrl(serverUrl);
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

  async clearSession(serverUrl: string): Promise<void> {
    const origin = normalizeServerUrl(serverUrl);
    this.#memorySessions.delete(origin);
    delete this.#credentials.sessions[origin];
    if (this.secureStorageAvailable) {
      await this.#writeJson(this.#credentialsPath, this.#credentials);
    }
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
