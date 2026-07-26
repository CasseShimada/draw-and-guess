import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import {
  DesktopControlCenterNav,
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
        onOpen: vi.fn(),
        serverState: "stopped"
      })
    );

    expect(html).toContain('class="desktop-toolbar"');
    expect(html).toContain('aria-label="打开桌面控制中心"');
    expect(html).toContain(">控制中心</button>");
    expect(html).not.toContain('data-ui="connection-management"');
    expect(html).not.toContain(">联机</button>");
    expect(html).not.toContain(">采集</button>");
    expect(html).not.toContain(">偏好设置</strong>");
    expect(html).not.toContain(">诊断</strong>");
  });

  it("keeps all desktop tools inside one sectioned control center", () => {
    const html = renderToStaticMarkup(
      createElement(DesktopControlCenterNav, {
        activePanel: "capture",
        captureActive: false,
        captureReady: true,
        connectionManagementAvailable: true,
        onSelect: vi.fn(),
        serverState: "running"
      })
    );

    expect(html).toContain('aria-label="桌面控制中心分区"');
    expect(html).toContain('data-ui="connection-management"');
    expect(html).toContain('data-ui="capture-management"');
    expect(html).toContain('data-ui="desktop-preferences"');
    expect(html).toContain('data-ui="desktop-diagnostics"');
    expect(html).toContain(">联机</strong>");
    expect(html).toContain(">采集</strong>");
    expect(html).toContain(">偏好设置</strong>");
    expect(html).toContain(">诊断</strong>");
    expect(html.match(/aria-selected="true"/gu) ?? []).toHaveLength(1);
  });
});
