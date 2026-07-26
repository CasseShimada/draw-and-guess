import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import postcss from "postcss";
import { afterEach, describe, expect, it } from "vitest";

import {
  compileThemeCss,
  THEME_ROOT_SELECTOR,
  themeApiVersionFromSource
} from "./theme-compiler.js";

const temporaryDirectories: string[] = [];

async function sourceRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "draw-guess-theme-compiler-"));
  temporaryDirectories.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

describe("theme CSS compiler", () => {
  it("supports blank replacement themes and high-freedom design properties", async () => {
    const root = await sourceRoot();
    await expect(
      compileThemeCss("", {
        themeId: "blank",
        applyMode: "replace",
        sourceRoot: root,
        themeApiVersion: 1
      })
    ).resolves.toEqual({ css: "", assets: [], warnings: [] });

    const result = await compileThemeCss(
      `
        :root { --accent: hotpink; display: grid !important; }
        * { display: flex !important; position: fixed; z-index: 999999; filter: blur(1px); opacity: .8; pointer-events: none; }
        .panel + .panel { margin-inline-start: 1rem; }
        button:hover::before { content: "主题"; transform: scale(2); }
        @media (max-width: 500px) { .panel { grid-template-columns: 1fr; } }
        @container card (width > 20rem) { .panel { color: red; } }
        @keyframes glow { from { opacity: .2; } to { opacity: 1; } }
        .panel { animation: glow 1s infinite; }
      `,
      {
        themeId: "freedom",
        applyMode: "override",
        sourceRoot: root,
        themeApiVersion: 1
      }
    );

    expect(result.css).toContain(`${THEME_ROOT_SELECTOR} {`);
    expect(result.css).toContain(`${THEME_ROOT_SELECTOR} *`);
    expect(result.css).toContain(`${THEME_ROOT_SELECTOR} button:hover::before`);
    expect(result.css).toContain(`${THEME_ROOT_SELECTOR} .panel + .panel`);
    expect(result.css).toContain("display: flex !important");
    expect(result.css).toContain("pointer-events: none");
    expect(result.css).toContain("@media (max-width: 500px)");
    expect(result.css).toContain("@container card (width > 20rem)");
    expect(result.css).toMatch(/@keyframes dg-theme-[a-f0-9]{12}-glow/u);
    expect(result.css).toMatch(/animation: dg-theme-[a-f0-9]{12}-glow/u);
  });

  it("rewrites local assets while rejecting network, imports, traversal, and safety selectors", async () => {
    const root = await sourceRoot();
    await writeFile(path.join(root, "paper.png"), Uint8Array.from([1, 2, 3]));
    const valid = await compileThemeCss('.panel { background: url("./paper.png"); }', {
      themeId: "asset",
      applyMode: "override",
      sourceRoot: root,
      themeApiVersion: 1
    });
    expect(valid.assets).toHaveLength(1);
    expect(valid.css).toMatch(
      /drawguess-theme:\/\/active\/assets\/[a-f0-9]{16}-paper\.png/u
    );

    for (const source of [
      '@import "theme.css";',
      '.panel { background: url("https://example.invalid/a.png"); }',
      '.panel { background: image-set("https://example.invalid/a.png" 1x); }',
      '.panel { background: image-set("./paper.png" 1x); }',
      '.panel { background: url("data:image/png;base64,AA"); }',
      '.panel { background: url("../outside.png"); }',
      "[data-theme-safety-host] { display: none !important; }",
      ":root + #drawguess-theme-safety-host { display: none !important; }"
    ]) {
      await expect(
        compileThemeCss(source, {
          themeId: "invalid",
          applyMode: "replace",
          sourceRoot: root,
          themeApiVersion: 1
        })
      ).rejects.toThrow();
    }
  });

  it("rejects incompatible theme API versions without deleting source data", async () => {
    const root = await sourceRoot();
    await expect(
      compileThemeCss(".panel { color: red; }", {
        themeId: "future",
        applyMode: "replace",
        sourceRoot: root,
        themeApiVersion: 99
      })
    ).rejects.toThrow("主题接口版本 99");
  });

  it("reads a declared API version and rejects conflicting template headers", () => {
    expect(
      themeApiVersionFromSource("/* Theme API Version: 1 */\n.panel { color: red; }")
    ).toBe(1);
    expect(themeApiVersionFromSource(".panel { color: red; }")).toBe(1);
    expect(() =>
      themeApiVersionFromSource(
        "/* Theme API Version: 1 */\n/* Theme API Version: 2 */"
      )
    ).toThrow("冲突");
    expect(() => themeApiVersionFromSource("/* Theme API Version: unknown */")).toThrow(
      "正整数"
    );
  });

  it("compiles the generated default template using only scoped rules", async () => {
    const templatePath = path.resolve(
      import.meta.dirname,
      "..",
      "..",
      "assets",
      "drawguess-theme-template.css"
    );
    const source = await readFile(templatePath, "utf8");
    const result = await compileThemeCss(source, {
      themeId: "default-template-test",
      applyMode: "replace",
      sourceRoot: path.dirname(templatePath),
      themeApiVersion: themeApiVersionFromSource(source)
    });

    expect(result.assets).toEqual([]);
    expect(result.css.length).toBeGreaterThan(50_000);
    for (const hook of [
      "home-screen",
      "room-entry",
      "primary-button",
      "player-card",
      "chat-panel",
      "drawing-board",
      "timer",
      "result-card",
      "desktop-toolbar",
      "settings-panel",
      "theme-preview"
    ]) {
      expect(source).toContain(`[data-ui="${hook}"]`);
    }
    postcss.parse(result.css).walkRules((rule) => {
      if (
        rule.parent?.type === "atrule" &&
        /^(?:-\w+-)?keyframes$/iu.test(rule.parent.name)
      ) {
        return;
      }
      for (const selector of rule.selectors) {
        expect(selector.startsWith(THEME_ROOT_SELECTOR)).toBe(true);
      }
    });
  });
});
