import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  SettingsService,
  migrateDesktopSettings,
  type EncryptionProvider
} from "./settings-service.js";

const temporaryDirectories: string[] = [];

function fakeEncryption(available = true): EncryptionProvider {
  return {
    isAvailable: () => available,
    backend: () => (available ? "test-keychain" : "unavailable"),
    encrypt: (value) => Buffer.from(`sealed:${value}`, "utf8"),
    decrypt: (value) =>
      Buffer.from(value)
        .toString("utf8")
        .replace(/^sealed:/, "")
  };
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

describe("settings service", () => {
  it("migrates legacy settings to safe v4 defaults", () => {
    expect(
      migrateDesktopSettings({
        schemaVersion: 1,
        port: 4567,
        allowLan: true,
        serverUrl: "http://127.0.0.1:4567"
      })
    ).toMatchObject({
      schemaVersion: 4,
      hostPort: 4567,
      allowLan: true,
      minimizeToTray: true,
      notificationsEnabled: false
    });
  });

  it("persists only encrypted desktop sessions", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "draw-guess-settings-"));
    temporaryDirectories.push(directory);
    const service = new SettingsService(directory, fakeEncryption());
    await service.initialize();
    await service.saveSession(
      "http://127.0.0.1:3000",
      "super-secret-token",
      Date.now() + 60_000
    );
    expect(await service.session("http://127.0.0.1:3000")).toBe("super-secret-token");
    const file = await readFile(path.join(directory, "credentials.json"), "utf8");
    expect(file).not.toContain("super-secret-token");
    expect(file).toContain("encryptedToken");
  });

  it("keeps sessions memory-only when secure storage is unavailable", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "draw-guess-settings-"));
    temporaryDirectories.push(directory);
    const service = new SettingsService(directory, fakeEncryption(false));
    await service.initialize();
    await service.saveSession(
      "http://127.0.0.1:3000",
      "memory-only",
      Date.now() + 60_000
    );
    expect(await service.session("http://127.0.0.1:3000")).toBe("memory-only");
    await expect(
      readFile(path.join(directory, "credentials.json"), "utf8")
    ).rejects.toThrow();
  });

  it("serializes concurrent atomic writes without reusing temporary files", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "draw-guess-settings-"));
    temporaryDirectories.push(directory);
    const service = new SettingsService(directory, fakeEncryption());
    await service.initialize();
    await Promise.all([
      service.update({ allowLan: true }),
      service.update({ hostPort: 4567 }),
      service.update({ qualityPreset: "high" })
    ]);
    const persisted = JSON.parse(
      await readFile(path.join(directory, "settings.json"), "utf8")
    ) as Record<string, unknown>;
    expect(persisted).toMatchObject({
      schemaVersion: 4,
      allowLan: true,
      hostPort: 4567,
      qualityPreset: "high"
    });
    expect(
      (await readdir(directory)).filter((name) => /\.(?:tmp|bak)$/u.test(name))
    ).toEqual([]);
  });
});
