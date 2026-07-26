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
  it("exits on window close by default unless tray mode is explicitly enabled", () => {
    expect(migrateDesktopSettings(null).minimizeToTray).toBe(false);
  });

  it("deterministically migrates schema 4 to schema 6 without losing unrelated settings", () => {
    expect(
      migrateDesktopSettings({
        schemaVersion: 4,
        hostPort: 4567,
        allowLan: true,
        serverUrl: "https://Example.COM:443",
        minimizeToTray: false,
        launchAtLogin: true,
        stopSharingShortcut: "CommandOrControl+Alt+S",
        qualityPreset: "high",
        onboardingComplete: true,
        customCssEnabled: true,
        notificationsEnabled: true,
        ffmpegExecutable: "C:\\ffmpeg.exe",
        replayOutputDirectory: "C:\\replays",
        replayMaxJobGiB: 2,
        replayMaxTemporaryGiB: 6,
        replayMinimumFreeGiB: 1,
        cropPresets: {
          source: { x: 0, y: 0, width: 1, height: 1 }
        }
      })
    ).toMatchObject({
      schemaVersion: 6,
      currentClientTarget: {
        host: "example.com",
        port: 443,
        security: "https"
      },
      hostPort: 4567,
      hostBindMode: "lan",
      minimizeToTray: false,
      launchAtLogin: true,
      qualityPreset: "high",
      notificationsEnabled: true,
      cropPresets: {
        source: { x: 0, y: 0, width: 1, height: 1 }
      }
    });
  });

  it("resets the old schema-5 tray default once, then preserves explicit schema-6 choices", () => {
    const version5 = {
      ...migrateDesktopSettings(null),
      schemaVersion: 5,
      minimizeToTray: true,
      onboardingComplete: true
    };
    const migrated = migrateDesktopSettings(version5);
    expect(migrated).toMatchObject({
      schemaVersion: 6,
      minimizeToTray: false,
      onboardingComplete: true
    });
    expect(
      migrateDesktopSettings({ ...migrated, minimizeToTray: true }).minimizeToTray
    ).toBe(true);
  });

  it("falls back safely when a legacy server URL is invalid", () => {
    expect(
      migrateDesktopSettings({
        schemaVersion: 4,
        serverUrl: "javascript:alert(1)",
        hostPort: 3000,
        allowLan: false
      }).currentClientTarget
    ).toEqual({ host: "127.0.0.1", port: 3000, security: "http" });
  });

  it("persists only encrypted, origin-isolated desktop sessions", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "draw-guess-settings-"));
    temporaryDirectories.push(directory);
    const service = new SettingsService(directory, fakeEncryption());
    await service.initialize();
    await service.saveSession(
      { host: "example.com", port: 443, security: "https" },
      "server-a-token",
      Date.now() + 60_000
    );
    await service.saveSession(
      { host: "example.com", port: 444, security: "https" },
      "server-b-token",
      Date.now() + 60_000
    );
    expect(
      await service.session({ host: "example.com", port: 443, security: "https" })
    ).toBe("server-a-token");
    expect(
      await service.session({ host: "example.com", port: 444, security: "https" })
    ).toBe("server-b-token");
    const file = await readFile(path.join(directory, "credentials.json"), "utf8");
    expect(file).not.toContain("server-a-token");
    expect(file).not.toContain("server-b-token");
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

  it("deduplicates, limits, and deletes recent successful targets", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "draw-guess-settings-"));
    temporaryDirectories.push(directory);
    const service = new SettingsService(directory, fakeEncryption());
    await service.initialize();
    for (let port = 3000; port < 3010; port += 1) {
      await service.addRecentConnection(
        { host: "192.168.1.20", port, security: "http" },
        null,
        port
      );
    }
    expect(service.settings.recentConnections).toHaveLength(8);
    await service.addRecentConnection(
      { host: "192.168.1.20", port: 3009, security: "http" },
      "重复项",
      9999
    );
    expect(service.settings.recentConnections).toHaveLength(8);
    expect(service.settings.recentConnections[0]?.label).toBe("重复项");
    await service.removeRecentConnection({
      host: "192.168.1.20",
      port: 3009,
      security: "http"
    });
    expect(
      service.settings.recentConnections.some((entry) => entry.target.port === 3009)
    ).toBe(false);
  });

  it("serializes concurrent atomic writes without reusing temporary files", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "draw-guess-settings-"));
    temporaryDirectories.push(directory);
    const service = new SettingsService(directory, fakeEncryption());
    await service.initialize();
    await Promise.all([
      service.update({ hostBindMode: "lan" }),
      service.update({ hostPort: 4567 }),
      service.update({ qualityPreset: "high" })
    ]);
    const persisted = JSON.parse(
      await readFile(path.join(directory, "settings.json"), "utf8")
    ) as Record<string, unknown>;
    expect(persisted).toMatchObject({
      schemaVersion: 6,
      hostBindMode: "lan",
      hostPort: 4567,
      qualityPreset: "high"
    });
    expect(
      (await readdir(directory)).filter((name) => /\.(?:tmp|bak)$/u.test(name))
    ).toEqual([]);
  });
});
