import { describe, expect, it } from "vitest";

import {
  desktopInvitationText,
  normalizeServerUrl,
  websocketUrl
} from "./server-url.js";

describe("desktop server URL policy", () => {
  it("allows local HTTP and requires HTTPS for public hosts", () => {
    expect(normalizeServerUrl("http://127.0.0.1:3000/")).toBe("http://127.0.0.1:3000");
    expect(normalizeServerUrl("http://192.168.1.2:3000")).toBe(
      "http://192.168.1.2:3000"
    );
    expect(() => normalizeServerUrl("http://example.com")).toThrow("HTTPS");
    expect(normalizeServerUrl("https://example.com")).toBe("https://example.com");
  });

  it("builds a root WSS endpoint without carrying secrets", () => {
    expect(websocketUrl("https://example.com")).toBe("wss://example.com/ws");
    expect(() => normalizeServerUrl("https://user:secret@example.com")).toThrow(
      "用户名或密码"
    );
  });

  it("builds password-free desktop and browser invitations", () => {
    const invitation = desktopInvitationText("http://192.168.1.2:3000", "abc234");
    expect(invitation).toContain(
      "drawguess://join?server=http%3A%2F%2F192.168.1.2%3A3000&room=ABC234"
    );
    expect(invitation).toContain("http://192.168.1.2:3000/?room=ABC234");
    expect(invitation).not.toMatch(/password|token|secret/i);
  });
});
