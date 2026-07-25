import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { CONTENT_LIMITS } from "@draw-guess/content";

import { RedactingLogger } from "./redacting-logger.js";
import { SettingsService, type EncryptionProvider } from "./settings-service.js";
import { ThemeService } from "./theme-service.js";

const temporaryDirectories: string[] = [];

function fakeEncryption(): EncryptionProvider {
  return {
    isAvailable: () => false,
    backend: () => "unavailable",
    encrypt: (value) => Buffer.from(value, "utf8"),
    decrypt: (value) => Buffer.from(value).toString("utf8")
  };
}

async function harness() {
  const root = await mkdtemp(path.join(tmpdir(), "draw-guess-theme-"));
  temporaryDirectories.push(root);
  const userData = path.join(root, "user-data");
  const source = path.join(root, "source");
  await mkdir(source, { recursive: true });
  const settings = new SettingsService(userData, fakeEncryption());
  await settings.initialize();
  const logger = new RedactingLogger(path.join(userData, "logs"));
  const theme = new ThemeService(userData, settings, logger);
  await theme.initialize();
  return { root, userData, source, settings, theme };
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

describe("desktop custom CSS service", () => {
  it("imports scoped CSS, copies only referenced assets, and serves them read-only", async () => {
    const { source, theme } = await harness();
    await Promise.all([
      writeFile(path.join(source, "background.png"), Uint8Array.from([1, 2, 3])),
      writeFile(path.join(source, "unused.png"), Uint8Array.from([9, 9, 9])),
      writeFile(path.join(source, "local.woff2"), Uint8Array.from([4, 5, 6]))
    ]);
    const cssPath = path.join(source, "style.css");
    await writeFile(
      cssPath,
      [
        ":root { --theme-accent: #7c5cff; background: #101218; }",
        ".entry-card { background-image: url('./background.png'); }",
        "@font-face { font-family: 'Microsoft YaHei'; src: url('./local.woff2') format('woff2'); }",
        "@keyframes pulse { from { opacity: .8; } to { opacity: 1; } }",
        "[data-ui='word-pack-manager'] { color: var(--theme-accent); font-family: 'Microsoft YaHei'; animation: pulse 1s; }"
      ].join("\n"),
      "utf8"
    );

    const status = await theme.importFromPath(cssPath);
    expect(status).toMatchObject({
      installed: true,
      enabled: true,
      fileName: "style.css",
      assetCount: 2
    });
    const css = await theme.activeCss();
    expect(css).toContain('[data-ui="theme-root"] {');
    expect(css).toContain('[data-ui="theme-root"] .entry-card');
    expect(css).toContain("[data-ui=\"theme-root\"] [data-ui='word-pack-manager']");
    expect(css).toContain("drawguess-theme://active/assets/");
    expect(css).not.toContain("./background.png");
    expect(css).not.toContain("unused.png");
    expect(css).not.toContain("@keyframes pulse");
    expect(css).not.toContain("font-family: 'Microsoft YaHei'");
    expect(css).toMatch(/@keyframes dg-theme-[a-f0-9]{12}-pulse/u);
    expect(css).toMatch(/font-family: ['"]dg-theme-[a-f0-9]{12}-Microsoft-YaHei/u);

    const assetUrl = css?.match(
      /drawguess-theme:\/\/active\/assets\/[a-f0-9]{16}-background\.png/u
    )?.[0];
    expect(assetUrl).toBeDefined();
    const response = await theme.responseForProtocol(assetUrl!);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(response.headers.get("content-security-policy")).toBe("default-src 'none'");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(
      Uint8Array.from([1, 2, 3])
    );
    await expect(
      readFile(
        path.join(source, "..", "user-data", "themes", "active", "assets", "unused.png")
      )
    ).rejects.toThrow();
    expect(
      (
        await theme.responseForProtocol(
          "drawguess-theme://active/assets/%2e%2e%2fmanifest.json"
        )
      ).status
    ).not.toBe(200);

    expect((await theme.disable()).enabled).toBe(false);
    expect(await theme.activeCss()).toBeNull();
    expect((await theme.enable()).enabled).toBe(true);
    expect((await theme.delete()).installed).toBe(false);
    expect(await theme.activeCss()).toBeNull();
  });

  it("rejects active content, remote and escaping URLs, and preserves the old theme", async () => {
    const { source, theme } = await harness();
    const originalPath = path.join(source, "original.css");
    await writeFile(originalPath, ".entry-card { color: rebeccapurple; }", "utf8");
    await theme.importFromPath(originalPath);
    const originalCss = await theme.activeCss();
    const originalStatus = theme.status;

    const invalidCases: Array<[string, string]> = [
      ["import.css", '@import url("https://example.invalid/theme.css");'],
      [
        "https.css",
        '.entry-card { background: url("https://example.invalid/a.png"); }'
      ],
      ["file.css", '.entry-card { background: url("file:///tmp/a.png"); }'],
      ["absolute.css", '.entry-card { background: url("C:/Windows/a.png"); }'],
      ["traversal.css", '.entry-card { background: url("../outside.png"); }'],
      ["protected.css", '[data-ui="protected-safety"] { display: none !important; }'],
      [
        "reserved-root.css",
        '[data-ui="theme-root"] + nav { display: none !important; }'
      ],
      ["script.css", '.entry-card { behavior: url("x.htc"); }'],
      ["malformed.css", ".entry-card { color: red; "]
    ];

    for (const [name, css] of invalidCases) {
      const candidate = path.join(source, name);
      await writeFile(candidate, css, "utf8");
      await expect(theme.importFromPath(candidate)).rejects.toThrow();
      expect(await theme.activeCss()).toBe(originalCss);
      expect(theme.status.importedAt).toBe(originalStatus.importedAt);
    }

    const oversized = path.join(source, "oversized.css");
    await writeFile(
      oversized,
      `/*${"x".repeat(CONTENT_LIMITS.themeCssBytes)}*/`,
      "utf8"
    );
    await expect(theme.importFromPath(oversized)).rejects.toThrow("512 KiB");
    expect(await theme.activeCss()).toBe(originalCss);
  });

  it("rejects an asset symlink escaping the source and disables themes in safe mode", async () => {
    const { root, source, userData, settings, theme } = await harness();
    const outside = path.join(root, "outside.png");
    const link = path.join(source, "escape.png");
    await writeFile(outside, Uint8Array.from([1]));
    try {
      await symlink(outside, link, "file");
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        (error.code === "EPERM" || error.code === "EACCES")
      ) {
        return;
      }
      throw error;
    }
    const escaping = path.join(source, "escaping.css");
    await writeFile(
      escaping,
      '.entry-card { background: url("./escape.png"); }',
      "utf8"
    );
    await expect(theme.importFromPath(escaping)).rejects.toThrow("符号链接逃逸");

    const valid = path.join(source, "valid.css");
    await writeFile(valid, ".entry-card { color: #123456; }", "utf8");
    await theme.importFromPath(valid);
    expect(theme.status.enabled).toBe(true);

    const safeTheme = new ThemeService(
      userData,
      settings,
      new RedactingLogger(path.join(userData, "safe-logs"))
    );
    await safeTheme.initialize(true);
    expect(safeTheme.status).toMatchObject({
      installed: true,
      enabled: false,
      safeMode: true
    });
    expect(settings.settings.customCssEnabled).toBe(false);
    expect(await safeTheme.activeCss()).toBeNull();
  });
});
