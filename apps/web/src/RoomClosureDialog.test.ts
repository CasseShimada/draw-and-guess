import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { RoomClosureDialog } from "./RoomClosureDialog.js";

describe("room closure confirmation", () => {
  it("keeps the terminal reason in a modal confirmation before returning home", () => {
    const html = renderToStaticMarkup(
      createElement(RoomClosureDialog, {
        message: "房主已退出，房间服务已停止",
        onConfirm: vi.fn()
      })
    );

    expect(html).toContain('role="alertdialog"');
    expect(html).toContain('aria-modal="true"');
    expect(html).toContain('data-ui="room-closure-dialog"');
    expect(html).toContain("房主已退出，房间服务已停止");
    expect(html).toContain('data-ui="confirm-room-closure"');
    expect(html).toContain("确定并返回主界面");
  });
});
