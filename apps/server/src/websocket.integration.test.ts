import {
  PROTOCOL_VERSION,
  decodeViewerFrame,
  encodeUploadFrame,
  type ClientJsonMessage,
  type ServerJsonMessage
} from "@draw-guess/protocol";
import type { IncomingMessage } from "node:http";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket, { type ClientOptions, type RawData } from "ws";

import { createApp } from "./app.js";
import type { ServerConfig } from "./config.js";

const JPEG = Uint8Array.from([0xff, 0xd8, 0x33, 0xff, 0xd9]);
type ClientMessagePayload<Message = ClientJsonMessage> =
  Message extends ClientJsonMessage ? Omit<Message, "protocolVersion"> : never;

class SocketInbox {
  readonly json: ServerJsonMessage[] = [];
  readonly binary: Uint8Array[] = [];
  readonly #waiters = new Set<() => void>();

  constructor(readonly socket: WebSocket) {
    socket.on("message", (data: RawData, isBinary: boolean) => {
      if (isBinary) {
        this.binary.push(new Uint8Array(Buffer.from(data as Buffer)));
      } else {
        this.json.push(JSON.parse(data.toString()) as ServerJsonMessage);
      }
      for (const wake of this.#waiters) {
        wake();
      }
    });
  }

  send(message: ClientMessagePayload): void {
    this.socket.send(JSON.stringify({ protocolVersion: PROTOCOL_VERSION, ...message }));
  }

  async waitForJson<T extends ServerJsonMessage["type"]>(
    type: T,
    predicate?: (message: Extract<ServerJsonMessage, { type: T }>) => boolean
  ): Promise<Extract<ServerJsonMessage, { type: T }>> {
    const find = () =>
      this.json.find(
        (message): message is Extract<ServerJsonMessage, { type: T }> =>
          message.type === type &&
          (!predicate || predicate(message as Extract<ServerJsonMessage, { type: T }>))
      );
    const existing = find();
    if (existing) {
      return existing;
    }
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.#waiters.delete(check);
        reject(new Error(`等待 ${type} 超时`));
      }, 2_000);
      const check = () => {
        const found = find();
        if (!found) {
          return;
        }
        clearTimeout(timeout);
        this.#waiters.delete(check);
        resolve(found);
      };
      this.#waiters.add(check);
    });
  }

  async waitForBinary(): Promise<Uint8Array> {
    const existing = this.binary[0];
    if (existing) {
      return existing;
    }
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.#waiters.delete(check);
        reject(new Error("等待二进制帧超时"));
      }, 2_000);
      const check = () => {
        const found = this.binary[0];
        if (!found) {
          return;
        }
        clearTimeout(timeout);
        this.#waiters.delete(check);
        resolve(found);
      };
      this.#waiters.add(check);
    });
  }
}

async function openSocket(url: string, options?: ClientOptions): Promise<SocketInbox> {
  const socket = new WebSocket(url, options);
  const inbox = new SocketInbox(socket);
  await new Promise<void>((resolve, reject) => {
    socket.once("open", () => resolve());
    socket.once("error", reject);
  });
  return inbox;
}

function firstHeader(value: string | string[] | undefined): string {
  return Array.isArray(value) ? (value[0] ?? "") : (value ?? "");
}

function testConfig(): ServerConfig {
  return {
    host: "127.0.0.1",
    port: 3000,
    allowedOrigins: new Set(),
    trustedProxyAddresses: new Set(),
    cookieSecure: false,
    roomIdleTtlMs: 60_000,
    reconnectGraceMs: 1_000,
    desktopSessionTtlMs: 60_000,
    turnResultMs: 250
  };
}

describe("real HTTP + WebSocket protocol-v4 integration", () => {
  const sockets: WebSocket[] = [];
  let activeApp: FastifyInstance | null = null;

  afterEach(async () => {
    for (const socket of sockets) {
      socket.terminate();
    }
    sockets.length = 0;
    if (activeApp) {
      await activeApp.close();
      activeApp = null;
    }
  });

  it("authenticates desktop capture, scopes private words, relays frames, and finalizes before result", async () => {
    const { app } = await createApp({
      config: testConfig(),
      serveStatic: false,
      startCleanup: false
    });
    activeApp = app;
    await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address();
    if (!address || typeof address === "string") {
      throw new Error("测试服务器地址无效");
    }
    const origin = `http://127.0.0.1:${String(address.port)}`;
    const wsBase =
      `ws://127.0.0.1:${String(address.port)}/ws?protocolVersion=` +
      String(PROTOCOL_VERSION);

    const created = await app.inject({
      method: "POST",
      url: "/api/desktop/rooms",
      headers: {
        "x-draw-guess-client": "desktop",
        "x-draw-guess-protocol": String(PROTOCOL_VERSION)
      },
      payload: { nickname: "画手", password: "secret" }
    });
    const createdBody = created.json<{
      sessionToken: string;
      snapshot: { roomCode: string };
    }>();
    const roomCode = createdBody.snapshot.roomCode;
    const joined = await app.inject({
      method: "POST",
      url: `/api/rooms/${roomCode}/join`,
      payload: { roomCode, nickname: "猜词者", password: "secret" }
    });
    const guestCookie = firstHeader(joined.headers["set-cookie"]).split(";")[0]!;

    const host = await openSocket(wsBase, {
      headers: {
        Authorization: `Bearer ${createdBody.sessionToken}`,
        "X-Draw-Guess-Client": "desktop",
        "X-Draw-Guess-Protocol": String(PROTOCOL_VERSION)
      }
    });
    const guest = await openSocket(wsBase, {
      headers: { Cookie: guestCookie },
      origin
    });
    sockets.push(host.socket, guest.socket);
    await host.waitForJson("room:snapshot");
    await guest.waitForJson("room:snapshot");

    guest.socket.send(
      JSON.stringify({
        protocolVersion: PROTOCOL_VERSION,
        type: "capture:ready",
        ready: true
      })
    );
    expect((await guest.waitForJson("error")).code).toBe("BAD_MESSAGE");
    guest.socket.send(
      JSON.stringify({
        protocolVersion: PROTOCOL_VERSION,
        type: "room:pause",
        commandId: "remote-pause-forgery"
      })
    );
    expect(guest.json.filter((message) => message.type === "error")).toHaveLength(1);
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(
      guest.json.filter((message) => message.type === "error").at(-1)
    ).toMatchObject({ code: "BAD_MESSAGE" });

    host.send({ type: "capture:ready", ready: true });
    await host.waitForJson(
      "room:snapshot",
      (message) =>
        message.snapshot.players.find(
          (player) => player.id === message.snapshot.selfPlayerId
        )?.captureReady === true
    );
    host.send({
      type: "mode:settings",
      value: {
        mode: "classic",
        settings: {
          drawingSeconds: 60,
          selectionSeconds: 15,
          rounds: 1
        }
      }
    });
    host.send({ type: "game:start", commandId: "ws-start" });
    const options = await host.waitForJson("classic:word-options");
    expect(guest.json.some((message) => message.type === "classic:word-options")).toBe(
      false
    );
    host.send({
      type: "classic:word-select",
      modeSessionId: options.modeSessionId,
      actorStepId: options.actorStepId,
      optionId: options.options[0]!.id,
      commandId: "ws-select"
    });
    const privateWord = await host.waitForJson("classic:word-selected");
    const captureStart = await host.waitForJson(
      "capture:start",
      (message) => message.stage === "drawing"
    );
    expect(captureStart.actorStepId).toBe(privateWord.actorStepId);
    expect(guest.json.some((message) => message.type === "classic:word-selected")).toBe(
      false
    );
    expect(JSON.stringify(guest.json)).not.toContain(privateWord.answer);

    host.socket.send(encodeUploadFrame(captureStart.captureSessionId, JPEG), {
      binary: true,
      compress: false
    });
    const relayed = decodeViewerFrame(await guest.waitForBinary());
    expect(relayed.captureSessionId).toBe(captureStart.captureSessionId);
    expect([...relayed.imageBytes]).toEqual([...JPEG]);

    guest.send({ type: "chat:submit", text: privateWord.answer });
    const finalizing = await guest.waitForJson(
      "room:snapshot",
      (message) =>
        message.snapshot.game.mode === "classic" &&
        message.snapshot.game.phase === "FINALIZING"
    );
    if (finalizing.snapshot.game.mode !== "classic") {
      throw new Error("expected classic finalization");
    }
    expect(finalizing.snapshot.game.turnResult).toBeNull();
    host.send({
      type: "turn:pass",
      modeSessionId: privateWord.modeSessionId,
      actorStepId: privateWord.actorStepId,
      targetPlayerId: finalizing.snapshot.hostId,
      commandId: "ws-finalize"
    });
    const result = await guest.waitForJson(
      "room:snapshot",
      (message) =>
        message.snapshot.game.mode === "classic" &&
        message.snapshot.game.phase === "TURN_RESULT"
    );
    if (result.snapshot.game.mode !== "classic") {
      throw new Error("expected classic result");
    }
    expect(result.snapshot.game.turnResult?.answer).toBe(privateWord.answer);
    expect(result.snapshot.game.scores[result.snapshot.selfPlayerId]).toBeGreaterThan(
      0
    );
    const binaryCount = guest.binary.length;

    host.socket.send(encodeUploadFrame(captureStart.captureSessionId, JPEG), {
      binary: true,
      compress: false
    });
    expect((await host.waitForJson("error")).code).toBe("INVALID_FRAME");
    expect(guest.binary).toHaveLength(binaryCount);

    const gameResult = await guest.waitForJson(
      "room:snapshot",
      (message) =>
        message.snapshot.game.mode === "classic" &&
        message.snapshot.game.phase === "GAME_RESULT"
    );
    expect(gameResult.snapshot.runControl.status).toBe("idle");
  });

  it("returns an explicit protocol-upgrade response before authentication", async () => {
    const config = testConfig();
    config.allowedOrigins.add("http://localhost");
    const { app } = await createApp({
      config,
      serveStatic: false,
      startCleanup: false
    });
    activeApp = app;
    await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address();
    if (!address || typeof address === "string") {
      throw new Error("测试服务器地址无效");
    }
    const socket = new WebSocket(
      `ws://127.0.0.1:${String(address.port)}/ws?protocolVersion=3`,
      { origin: "http://localhost" }
    );
    sockets.push(socket);
    const response = await new Promise<{
      statusCode: number;
      protocol: string;
      body: string;
    }>((resolve, reject) => {
      socket.once("unexpected-response", (_request, incoming: IncomingMessage) => {
        const chunks: Buffer[] = [];
        incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
        incoming.on("end", () =>
          resolve({
            statusCode: incoming.statusCode ?? 0,
            protocol: firstHeader(incoming.headers["x-draw-guess-protocol"]),
            body: Buffer.concat(chunks).toString("utf8")
          })
        );
      });
      socket.once("error", reject);
    });
    expect(response).toEqual({
      statusCode: 426,
      protocol: String(PROTOCOL_VERSION),
      body: expect.stringContaining("Please upgrade")
    });
  });
});
