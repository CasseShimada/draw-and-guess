import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { RoomCodeCopyButton } from "./RoomCodeCopyButton.js";

describe("compact room code copy button", () => {
  it("keeps the room code in the brand area without the large invite banner", () => {
    const html = renderToStaticMarkup(
      createElement(RoomCodeCopyButton, {
        roomCode: "ABC234",
        onCopy: vi.fn()
      })
    );

    expect(html).toContain('data-ui="room-code-copy"');
    expect(html).toContain(">房间码</small>");
    expect(html).toContain(">ABC234</code>");
    expect(html).toContain('aria-label="复制房间码 ABC234"');
    expect(html).not.toContain("Invite players");
    expect(html).not.toContain("玩家加入时需要输入此房间码和房间密码");
  });
});
