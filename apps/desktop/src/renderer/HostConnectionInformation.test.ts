import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { HostConnectionInformation } from "./HostConnectionInformation.js";
import type { DesktopSettings, EmbeddedServerStatus } from "../shared/ipc.js";

describe("host connection information", () => {
  it("keeps the room code visible when the server is only listening locally", () => {
    const settings = {
      preferredLanAddressId: null,
      publicEndpoint: null
    } as DesktopSettings;
    const status: EmbeddedServerStatus = {
      state: "running",
      bindMode: "loopback-only",
      boundHost: "127.0.0.1",
      requestedPort: 3000,
      actualPort: 3000,
      serverInstanceId: "s".repeat(43),
      loopbackOrigin: "http://127.0.0.1:3000",
      lanAddresses: [],
      executablePath: "draw-guess.exe",
      error: null
    };

    const html = renderToStaticMarkup(
      createElement(HostConnectionInformation, {
        roomCode: "ABC234",
        settings,
        status,
        onSettings: vi.fn()
      })
    );

    expect(html).toContain('data-ui="host-network-room-code"');
    expect(html).toContain(">ABC234</code>");
    expect(html).toContain('aria-label="复制房间码 ABC234"');
    expect(html).toContain("当前为“仅本机”");
  });
});
