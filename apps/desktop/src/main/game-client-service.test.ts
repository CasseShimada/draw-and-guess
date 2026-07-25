import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { PROTOCOL_VERSION } from "@draw-guess/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ConnectionPreflightService } from "./connection-preflight-service.js";
import { GameClientService } from "./game-client-service.js";
import { RedactingLogger } from "./redacting-logger.js";
import { SettingsService, type EncryptionProvider } from "./settings-service.js";

const directories: string[] = [];
const encryption: EncryptionProvider = {
  isAvailable: () => false,
  backend: () => "unavailable",
  encrypt: (value) => Buffer.from(value),
  decrypt: (value) => Buffer.from(value).toString("utf8")
};

afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

describe("game client target epochs", () => {
  it("actively aborts an old request and discards its session when the target changes", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "draw-guess-client-"));
    directories.push(directory);
    const settings = new SettingsService(directory, encryption);
    await settings.initialize();
    const logger = new RedactingLogger(directory);
    const preflight = new ConnectionPreflightService(settings, logger, {
      fetch: async () =>
        new Response(
          JSON.stringify({
            service: "draw-guess",
            appVersion: "0.5.0",
            protocolVersion: PROTOCOL_VERSION,
            serverInstanceId: "i".repeat(43),
            now: Date.now(),
            websocketPath: "/ws",
            capabilities: { browser: true, desktop: true }
          }),
          { headers: { "content-type": "application/json" } }
        )
    });

    let requestStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      requestStarted = resolve;
    });
    const fetchMock = vi.fn<typeof fetch>(async (_input, init): Promise<Response> => {
      requestStarted();
      return new Promise<Response>((resolve, reject) => {
        const timer = setTimeout(
          () =>
            resolve(
              new Response(
                JSON.stringify({
                  sessionToken: "late-token-that-must-never-be-accepted",
                  expiresAt: Date.now() + 60_000,
                  snapshot: {}
                }),
                { status: 201, headers: { "content-type": "application/json" } }
              )
            ),
          100
        );
        init?.signal?.addEventListener(
          "abort",
          () => {
            clearTimeout(timer);
            reject(new DOMException("aborted", "AbortError"));
          },
          { once: true }
        );
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const client = new GameClientService(settings, logger, preflight);
    const oldRequest = client.createRoom(
      { host: "127.0.0.1", port: 3000, security: "http" },
      "旧服务器玩家",
      "secret"
    );
    const oldRequestAssertion = expect(oldRequest).rejects.toThrow();
    await started;
    await client.configure({
      host: "example.com",
      port: 443,
      security: "https"
    });
    await oldRequestAssertion;
    expect(client.target.origin).toBe("https://example.com");
    expect(settings.settings.currentClientTarget).toEqual({
      host: "example.com",
      port: 443,
      security: "https"
    });
    expect(await settings.session("http://127.0.0.1:3000")).toBeNull();
    expect(settings.settings.recentConnections).toEqual([]);
  });
});
