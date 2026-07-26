import { readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

const webSourceRoot = path.resolve(import.meta.dirname, "..");
const desktopSourceRoot = path.resolve(
  import.meta.dirname,
  "..",
  "..",
  "..",
  "desktop",
  "src"
);

async function source(relativePath: string): Promise<string> {
  return readFile(path.join(webSourceRoot, relativePath), "utf8");
}

async function desktopSource(relativePath: string): Promise<string> {
  return readFile(path.join(desktopSourceRoot, relativePath), "utf8");
}

describe("public theme selector API", () => {
  it("keeps the global platform, screen, mode, phase, and connection hooks", async () => {
    const app = (
      await Promise.all([source("App.tsx"), source("components/AppShell.tsx")])
    ).join("\n");
    for (const hook of [
      'data-ui={embedded ? "app-root" : "theme-root"}',
      "data-platform={platform}",
      "data-screen={screen}",
      "data-mode={mode}",
      "data-phase={phase?.toLowerCase()}",
      "data-connection={connection}",
      'data-theme-mode={embedded ? undefined : "default"}'
    ]) {
      expect(app).toContain(hook);
    }
  });

  it("keeps major home, lobby, room settings, and game component hooks", async () => {
    const files = await Promise.all([
      source("App.tsx"),
      source("components/AppShell.tsx"),
      source("components/HomeActions.tsx"),
      source("RoomSettingsScreen.tsx"),
      source("modes/common.tsx"),
      source("modes/classic/ClassicModeView.tsx"),
      source("modes/reference-copy/ReferenceCopyModeView.tsx"),
      source("modes/draw-relay/DrawRelayModeView.tsx")
    ]);
    const combined = files.join("\n");
    for (const hook of [
      "home-screen",
      "room-entry",
      "game-screen",
      "room-settings-screen",
      "player-list",
      "player-card",
      "chat-panel",
      "chat-input",
      "drawing-board",
      "timer",
      "classic-word-selection",
      "reference-blind-voting",
      "relay-guessing",
      "primary-button"
    ]) {
      expect(combined).toContain(`"${hook}"`);
    }
  });

  it("does not hard-code ordinary colors, borders, or shadows in React style props", async () => {
    const files = await Promise.all([
      source("App.tsx"),
      source("components/AppShell.tsx"),
      source("components/HomeActions.tsx"),
      source("AvatarEditor.tsx"),
      source("PlayerAvatar.tsx"),
      source("RoomSettingsScreen.tsx"),
      source("modes/common.tsx"),
      source("modes/classic/ClassicModeView.tsx"),
      source("modes/reference-copy/ReferenceCopyModeView.tsx"),
      source("modes/draw-relay/DrawRelayModeView.tsx")
    ]);
    const inlineStyleBlocks = files.join("\n").match(/style=\{\{[\s\S]*?\}\}/gu) ?? [];
    for (const block of inlineStyleBlocks) {
      expect(block).not.toMatch(
        /\b(?:background|backgroundColor|border|borderRadius|boxShadow|color|fontFamily)\s*:/u
      );
    }
  });

  it("keeps the default, override, and replacement style layer order explicit", async () => {
    const [webMain, desktopApp, desktopLayer, windowManager] = await Promise.all([
      source("main.tsx"),
      desktopSource("renderer/DesktopApp.tsx"),
      desktopSource("renderer/theme/DesktopThemeStyle.tsx"),
      desktopSource("main/window-manager.ts")
    ]);
    expect(webMain.indexOf("<DefaultWebThemeStyle />")).toBeLessThan(
      webMain.indexOf("<App />")
    );
    expect(desktopApp).toContain(
      'enabled={!(theme.enabled && theme.applyMode === "replace")}'
    );
    expect(desktopApp.indexOf("<DefaultDesktopThemeStyle")).toBeLessThan(
      desktopApp.indexOf("<GameApp")
    );
    expect(desktopLayer.indexOf("DEFAULT_WEB_TEMPLATE_CSS")).toBeLessThan(
      desktopLayer.indexOf("desktopTemplateCss")
    );
    expect(windowManager.indexOf("insertCSS(css")).toBeLessThan(
      windowManager.indexOf("removeInsertedCSS(previousKey)")
    );
  });

  it("keeps gallery images contained and only exposes theme recovery on an alert", async () => {
    const [gallery, css, safetyHost] = await Promise.all([
      source("modes/reference-copy/ReferenceCopyModeView.tsx"),
      source("theme/default-template.css"),
      desktopSource("renderer/theme/ThemeSafetyHost.tsx")
    ]);

    expect(gallery).toContain('data-winner={winner ? "true" : "false"}');
    expect(css).toContain(".gallery-grid article img");
    expect(css).toContain("max-width: 100%");
    expect(css).toContain("object-fit: contain");
    expect(safetyHost).toContain("{hasAlert && (");
    expect(safetyHost).toContain("主题修复");
    expect(safetyHost).not.toContain('{hasAlert ? "主题修复" : "主题"}');
  });
});
