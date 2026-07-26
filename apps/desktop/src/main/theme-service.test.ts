import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { CONTENT_LIMITS } from "@draw-guess/content";

import { RedactingLogger } from "./redacting-logger.js";
import { SettingsService, type EncryptionProvider } from "./settings-service.js";
import { sha256 } from "./theme-compiler.js";
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

    const status = await theme.importFromPath(cssPath, "override");
    expect(status).toMatchObject({
      installed: true,
      enabled: true,
      fileName: "style.css",
      assetCount: 2,
      applyMode: "override",
      themeApiVersion: 1,
      supportedThemeApiVersion: 1
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
    await expect(
      readFile(
        path.join(source, "..", "user-data", "themes", "active", "source.css"),
        "utf8"
      )
    ).resolves.toContain(".entry-card");
    await expect(
      readFile(
        path.join(source, "..", "user-data", "themes", "active", "compiled.css"),
        "utf8"
      )
    ).resolves.toBe(css);

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
    await theme.importFromPath(originalPath, "replace");
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
      ["protected.css", '[data-ui="theme-safety-host"] { display: none !important; }'],
      ["future-api.css", "/* Theme API Version: 99 */\n.entry-card { color: red; }"],
      ["script.css", '.entry-card { behavior: url("x.htc"); }'],
      ["malformed.css", ".entry-card { color: red; "]
    ];

    for (const [name, css] of invalidCases) {
      const candidate = path.join(source, name);
      await writeFile(candidate, css, "utf8");
      await expect(theme.importFromPath(candidate, "replace")).rejects.toThrow();
      expect(await theme.activeCss()).toBe(originalCss);
      expect(theme.status.importedAt).toBe(originalStatus.importedAt);
    }

    const oversized = path.join(source, "oversized.css");
    await writeFile(
      oversized,
      `/*${"x".repeat(CONTENT_LIMITS.themeCssBytes)}*/`,
      "utf8"
    );
    await expect(theme.importFromPath(oversized, "replace")).rejects.toThrow("512 KiB");
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
    await expect(theme.importFromPath(escaping, "override")).rejects.toThrow(
      "符号链接逃逸"
    );

    const valid = path.join(source, "valid.css");
    await writeFile(valid, ".entry-card { color: #123456; }", "utf8");
    await theme.importFromPath(valid, "override");
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

  it("creates and exports the deterministic default template", async () => {
    const { root, theme } = await harness();
    const status = await theme.createFromDefaultTemplate();
    expect(status).toMatchObject({
      installed: true,
      enabled: true,
      applyMode: "replace",
      themeApiVersion: 1
    });
    expect(status.sourcePath).toBeTruthy();
    await expect(readFile(status.sourcePath!, "utf8")).resolves.toContain(
      "Draw & Guess Theme Template"
    );

    const exported = path.join(root, "exported-template.css");
    await theme.exportDefaultTemplate(exported);
    expect(await readFile(exported, "utf8")).toBe(await theme.defaultTemplateCss());
  });

  it("reloads source.css atomically and retains the last compiled theme on failure", async () => {
    const { source, theme } = await harness();
    const cssPath = path.join(source, "editable.css");
    await writeFile(cssPath, ".entry-card { color: red; }", "utf8");
    const imported = await theme.importFromPath(cssPath, "override");
    await writeFile(
      imported.sourcePath!,
      ".entry-card { color: rebeccapurple !important; display: grid; }",
      "utf8"
    );
    const reloaded = await theme.reload();
    expect(reloaded.applyMode).toBe("override");
    const workingCss = await theme.activeCss();
    expect(workingCss).toContain("rebeccapurple !important");

    await writeFile(imported.sourcePath!, '@import "remote.css";', "utf8");
    await expect(theme.reload()).rejects.toThrow("@import");
    expect(await theme.activeCss()).toBe(workingCss);
    expect(theme.status.error).toContain("已保留上一份可用主题");
  });

  it("accepts an empty complete replacement theme and supports temporary suspension", async () => {
    const { source, settings, theme } = await harness();
    const cssPath = path.join(source, "blank.css");
    await writeFile(cssPath, "", "utf8");
    const status = await theme.importFromPath(cssPath, "replace");
    expect(status).toMatchObject({
      enabled: true,
      applyMode: "replace",
      cssBytes: 0
    });
    expect(await theme.activeCss()).toBe("");

    const suspended = theme.suspend("关键画布尺寸为零");
    expect(suspended).toMatchObject({
      enabled: false,
      safeMode: true,
      error: "关键画布尺寸为零"
    });
    expect(settings.settings.customCssEnabled).toBe(true);
    expect((await theme.enable()).enabled).toBe(true);
  });

  it("migrates a legacy manifest and restores the compiled override after restart", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "draw-guess-theme-legacy-"));
    temporaryDirectories.push(root);
    const userData = path.join(root, "user-data");
    const activeRoot = path.join(userData, "themes", "active");
    await mkdir(activeRoot, { recursive: true });
    const settings = new SettingsService(userData, fakeEncryption());
    await settings.initialize();
    await settings.update({ customCssEnabled: true });
    const legacyCss = Buffer.from(
      '[data-ui="theme-root"] .entry-card { color: plum; }',
      "utf8"
    );
    const hash = sha256(legacyCss);
    await Promise.all([
      writeFile(path.join(activeRoot, "style.css"), legacyCss),
      writeFile(
        path.join(activeRoot, "manifest.json"),
        `${JSON.stringify({
          schemaVersion: 1,
          sourceFileName: "legacy.css",
          importedAt: "2026-07-26T00:00:00.000Z",
          cssBytes: legacyCss.byteLength,
          cssSha256: hash,
          assets: []
        })}\n`,
        "utf8"
      )
    ]);

    const migrated = new ThemeService(
      userData,
      settings,
      new RedactingLogger(path.join(userData, "migration-logs"))
    );
    await migrated.initialize();
    expect(migrated.status).toMatchObject({
      installed: true,
      enabled: true,
      applyMode: "override",
      themeApiVersion: 1
    });
    await expect(migrated.activeCss()).resolves.toBe(legacyCss.toString("utf8"));

    const manifest = JSON.parse(
      await readFile(path.join(activeRoot, "manifest.json"), "utf8")
    ) as { schemaVersion?: unknown };
    expect(manifest.schemaVersion).toBe(2);
    const restarted = new ThemeService(
      userData,
      settings,
      new RedactingLogger(path.join(userData, "restart-logs"))
    );
    await restarted.initialize();
    expect(restarted.status).toMatchObject({
      enabled: true,
      applyMode: "override",
      error: null
    });
    await expect(restarted.activeCss()).resolves.toBe(legacyCss.toString("utf8"));
  });
});
