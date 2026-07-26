import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import {
  DesktopDock,
  canManageConnectionPanel,
  visibleDesktopPanel
} from "./DesktopDock.js";

describe("desktop dock access", () => {
  it("allows connection management before joining and for the actual host", () => {
    expect(canManageConnectionPanel(false, false)).toBe(true);
    expect(canManageConnectionPanel(true, true)).toBe(true);
  });

  it("removes connection management after a remote player joins", () => {
    expect(canManageConnectionPanel(true, false)).toBe(false);
    expect(visibleDesktopPanel("connection", false)).toBeNull();
    expect(visibleDesktopPanel("capture", false)).toBe("capture");

    const html = renderToStaticMarkup(
      createElement(DesktopDock, {
        activePanel: null,
        captureActive: false,
        captureReady: false,
        connectionManagementAvailable: false,
        onToggle: vi.fn(),
        serverState: "stopped"
      })
    );

    expect(html).toContain('class="desktop-toolbar"');
    expect(html).toContain('aria-label="桌面应用工具"');
    expect(html).not.toContain('data-ui="connection-management"');
    expect(html).not.toContain(">联机</button>");
    expect(html).toContain(">采集</button>");
    expect(html).toContain(">设置</button>");
    expect(html).toContain(">诊断</button>");
  });
});
