import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { HostRoomCodeBanner } from "./HostRoomCodeBanner.js";

describe("host room code banner", () => {
  it("makes the room code and copy action explicit to the host", () => {
    const html = renderToStaticMarkup(
      createElement(HostRoomCodeBanner, {
        roomCode: "ABC234",
        onCopy: vi.fn()
      })
    );

    expect(html).toContain('data-ui="host-room-code"');
    expect(html).toContain("六位房间码");
    expect(html).toContain(">ABC234</code>");
    expect(html).toContain('aria-label="复制房间码 ABC234"');
    expect(html).toContain("玩家加入时需要输入此房间码和房间密码");
  });
});
