import { describe, expect, it } from "vitest";

import {
  ConnectionPortConflictError,
  ConnectionSecurityConflictError,
  connectionHostKind,
  connectionTargetFromOrigin,
  normalizeConnectionTarget,
  parseConnectionAddress,
  parseConnectionTargetInput,
  websocketUrl
} from "./server-url.js";

describe("desktop connection target policy", () => {
  it.each([
    [
      { address: "192.168.1.20", port: 3000 },
      {
        host: "192.168.1.20",
        port: 3000,
        security: "http",
        origin: "http://192.168.1.20:3000",
        websocketOrigin: "ws://192.168.1.20:3000"
      }
    ],
    [
      { address: "192.168.1.20:3000", port: 3000 },
      {
        host: "192.168.1.20",
        port: 3000,
        security: "http",
        origin: "http://192.168.1.20:3000",
        websocketOrigin: "ws://192.168.1.20:3000"
      }
    ],
    [
      { address: "http://192.168.1.20:3000" },
      {
        host: "192.168.1.20",
        port: 3000,
        security: "http",
        origin: "http://192.168.1.20:3000",
        websocketOrigin: "ws://192.168.1.20:3000"
      }
    ],
    [
      { address: "DRAW-HOST.local:3000" },
      {
        host: "draw-host.local",
        port: 3000,
        security: "http",
        origin: "http://draw-host.local:3000",
        websocketOrigin: "ws://draw-host.local:3000"
      }
    ],
    [
      { address: "Example.COM", port: 443 },
      {
        host: "example.com",
        port: 443,
        security: "https",
        origin: "https://example.com",
        websocketOrigin: "wss://example.com"
      }
    ],
    [
      { address: "https://example.com:443" },
      {
        host: "example.com",
        port: 443,
        security: "https",
        origin: "https://example.com",
        websocketOrigin: "wss://example.com"
      }
    ],
    [
      { address: "example.com", port: 1, security: "https" as const },
      {
        host: "example.com",
        port: 1,
        security: "https",
        origin: "https://example.com:1",
        websocketOrigin: "wss://example.com:1"
      }
    ],
    [
      { address: "example.com", port: 65_535, security: "https" as const },
      {
        host: "example.com",
        port: 65_535,
        security: "https",
        origin: "https://example.com:65535",
        websocketOrigin: "wss://example.com:65535"
      }
    ]
  ])("normalizes supported address form %#", (input, expected) => {
    expect(parseConnectionTargetInput(input)).toEqual(expected);
  });

  it.each([
    ["example.com", 0],
    ["example.com", 65_536],
    ["example.com", -1],
    ["example.com", 1.5],
    ["example.com", Number.NaN]
  ])("rejects invalid port %#", (address, port) => {
    expect(() =>
      parseConnectionTargetInput({ address, port, security: "https" })
    ).toThrow("端口");
  });

  it.each([
    "https://user:secret@example.com",
    "https://example.com/path",
    ["https://example.com/", "?", "room", "=ABC234"].join(""),
    "https://example.com/#fragment",
    "file:///tmp/server",
    "javascript:alert(1)",
    "data:text/plain,test",
    ["drawguess", "://join"].join(""),
    " example.com",
    "example.com ",
    "example.com\n",
    "exa mple.com",
    "http://[::1]:3000",
    "0.0.0.0",
    "example..com",
    "999.1.1.1"
  ])("rejects ambiguous or unsafe address %s", (address) => {
    expect(() => parseConnectionAddress(address)).toThrow();
  });

  it("requires an explicit choice when address and field ports conflict", () => {
    expect(() =>
      parseConnectionTargetInput({
        address: "192.168.1.20:4000",
        port: 3000,
        security: "http"
      })
    ).toThrow(ConnectionPortConflictError);
  });

  it("does not silently override an explicit URL scheme", () => {
    expect(() =>
      parseConnectionTargetInput({
        address: "https://example.com",
        port: 443,
        security: "http"
      })
    ).toThrow(ConnectionSecurityConflictError);
  });

  it("allows explicit public HTTP but keeps it classified as public", () => {
    const target = connectionTargetFromOrigin("http://example.com:45678");
    expect(target).toMatchObject({
      security: "http",
      port: 45_678,
      origin: "http://example.com:45678"
    });
    expect(connectionHostKind(target.host)).toBe("public");
  });

  it("derives REST and WebSocket from the same normalized target", () => {
    const target = normalizeConnectionTarget({
      host: "example.com",
      port: 443,
      security: "https"
    });
    expect(target.origin).toBe("https://example.com");
    expect(websocketUrl(target)).toBe("wss://example.com/ws");
  });
});
