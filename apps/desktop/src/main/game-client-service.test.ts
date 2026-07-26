import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { PROTOCOL_VERSION, ROOM_REMOVED_CLOSE_CODE } from "@draw-guess/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ConnectionPreflightService } from "./connection-preflight-service.js";
import { GameClientService, roomRemovalMessage } from "./game-client-service.js";
import { RedactingLogger } from "./redacting-logger.js";
import { SettingsService, type EncryptionProvider } from "./settings-service.js";

const directories: string[] = [];
const encryption: EncryptionProvider = {
  isAvailable: () => false,
  backend: () => "unavailable",
  encrypt: (value) => Buffer.from(value),
  decrypt: (value) => Buffer.from(value).toString("utf8")
};

function connectionInfoResponse(): Response {
  return new Response(
    JSON.stringify({
      service: "draw-guess",
      appVersion: "0.5.9",
      protocolVersion: PROTOCOL_VERSION,
      serverInstanceId: "i".repeat(43),
      now: Date.now(),
      websocketPath: "/ws",
      capabilities: { browser: true, desktop: true }
    }),
    { headers: { "content-type": "application/json" } }
  );
}

afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

describe("game client target epochs", () => {
  it("treats a removed-room close as terminal instead of reconnecting", () => {
    expect(roomRemovalMessage(ROOM_REMOVED_CLOSE_CODE, "房主已关闭房间")).toBe(
      "房主已关闭房间"
    );
    expect(roomRemovalMessage(ROOM_REMOVED_CLOSE_CODE, "  ")).toBe(
      "房间已关闭，请重新创建或加入房间"
    );
    expect(roomRemovalMessage(1006, "网络中断")).toBeNull();
  });

  it("actively aborts an old request and discards its session when the target changes", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "draw-guess-client-"));
    directories.push(directory);
    const settings = new SettingsService(directory, encryption);
    await settings.initialize();
    const logger = new RedactingLogger(directory);
    const preflight = new ConnectionPreflightService(settings, logger, {
      fetch: async () => connectionInfoResponse()
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

describe("join-room failure diagnostics", () => {
  it("shows and logs a refused-port cause with an actionable suggestion", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "draw-guess-client-"));
    directories.push(directory);
    const settings = new SettingsService(directory, encryption);
    await settings.initialize();
    const logger = new RedactingLogger(directory);
    const refused = Object.assign(new Error("connect ECONNREFUSED"), {
      code: "ECONNREFUSED"
    });
    const preflight = new ConnectionPreflightService(settings, logger, {
      fetch: async () => {
        throw new TypeError("fetch failed", { cause: refused });
      }
    });
    const client = new GameClientService(settings, logger, preflight);

    await expect(
      client.joinRoom(
        { host: "192.168.1.8", port: 3000, security: "http" },
        "ABC234",
        "不应写日志的昵称",
        "not-in-the-log"
      )
    ).rejects.toThrow(
      /加入房间失败（连接预检）：目标地址的该端口拒绝连接.*主机必须监听 0\.0\.0\.0/u
    );

    const diagnostic = logger.entries().at(-1)?.message ?? "";
    expect(diagnostic).toContain("加入房间失败");
    expect(diagnostic).toContain('"code":"connection-refused"');
    expect(diagnostic).toContain('"phase":"连接预检"');
    expect(diagnostic).not.toContain("不应写日志的昵称");
    expect(diagnostic).not.toContain("not-in-the-log");
  });

  it("distinguishes a rejected password after a successful server preflight", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "draw-guess-client-"));
    directories.push(directory);
    const settings = new SettingsService(directory, encryption);
    await settings.initialize();
    const logger = new RedactingLogger(directory);
    const preflight = new ConnectionPreflightService(settings, logger, {
      fetch: async () => connectionInfoResponse()
    });
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async () =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              error: { code: "UNAUTHORIZED", message: "房间密码错误" }
            }),
            {
              status: 401,
              headers: { "content-type": "application/json" }
            }
          )
        )
      )
    );
    const client = new GameClientService(settings, logger, preflight);

    await expect(
      client.joinRoom(
        { host: "127.0.0.1", port: 3000, security: "http" },
        "ABC234",
        "玩家",
        "wrong-secret"
      )
    ).rejects.toThrow(
      /加入房间失败（验证房间）：房间密码错误.*房主可能刚刚修改过密码/u
    );

    const diagnostic = logger.entries().at(-1)?.message ?? "";
    expect(diagnostic).toContain('"code":"UNAUTHORIZED"');
    expect(diagnostic).toContain('"reason":"房间密码错误"');
    expect(diagnostic).not.toContain("wrong-secret");
  });
});
