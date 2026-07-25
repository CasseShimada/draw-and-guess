import type { IncomingMessage } from "node:http";

import { describe, expect, it } from "vitest";

import { isBrowserOriginAllowed } from "./websocket.js";

function request(origin: string, host: string): IncomingMessage {
  return {
    headers: { origin, host }
  } as IncomingMessage;
}

describe("browser WebSocket origin policy", () => {
  it("accepts an exact LAN same-origin Host without trusting a subnet", () => {
    expect(
      isBrowserOriginAllowed(
        request("http://192.168.1.20:3000", "192.168.1.20:3000"),
        new Set()
      )
    ).toBe(true);
  });

  it("accepts only an explicitly configured public proxy origin when Host changes", () => {
    const allowed = new Set(["https://public.example"]);
    expect(
      isBrowserOriginAllowed(
        request("https://public.example", "127.0.0.1:3000"),
        allowed
      )
    ).toBe(true);
    expect(
      isBrowserOriginAllowed(
        request("https://attacker.example", "127.0.0.1:3000"),
        allowed
      )
    ).toBe(false);
  });

  it("rejects missing, malformed, and cross-site origins", () => {
    expect(
      isBrowserOriginAllowed(
        { headers: { host: "192.168.1.20:3000" } } as IncomingMessage,
        new Set()
      )
    ).toBe(false);
    expect(
      isBrowserOriginAllowed(
        request("http://evil.example", "192.168.1.20:3000"),
        new Set()
      )
    ).toBe(false);
  });
});
