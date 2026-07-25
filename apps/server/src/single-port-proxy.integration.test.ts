import { createConnection, createServer, type Socket } from "node:net";

import {
  PROTOCOL_VERSION,
  decodeViewerFrame,
  encodeUploadFrame,
  type ServerJsonMessage
} from "@draw-guess/protocol";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket, { type ClientOptions, type RawData } from "ws";

import { startServer, type RunningServer } from "./server.js";

const JPEG = Uint8Array.from([0xff, 0xd8, 0x44, 0xff, 0xd9]);

class Inbox {
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
      for (const waiter of this.#waiters) {
        waiter();
      }
    });
  }

  send(message: Record<string, unknown>): void {
    this.socket.send(JSON.stringify({ protocolVersion: PROTOCOL_VERSION, ...message }));
  }

  waitForJson<T extends ServerJsonMessage["type"]>(
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
      return Promise.resolve(existing);
    }
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.#waiters.delete(check);
        reject(new Error(`等待 ${type} 超时`));
      }, 3_000);
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

  waitForBinary(): Promise<Uint8Array> {
    const existing = this.binary[0];
    if (existing) {
      return Promise.resolve(existing);
    }
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.#waiters.delete(check);
        reject(new Error("等待代理二进制帧超时"));
      }, 3_000);
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

async function openSocket(url: string, options?: ClientOptions) {
  const socket = new WebSocket(url, options);
  const inbox = new Inbox(socket);
  await new Promise<void>((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  return inbox;
}

async function tcpProxy(targetPort: number) {
  const sockets = new Set<Socket>();
  const server = createServer((client) => {
    sockets.add(client);
    const upstream = createConnection({
      host: "127.0.0.1",
      port: targetPort
    });
    sockets.add(upstream);
    client.pipe(upstream).pipe(client);
    const cleanup = () => {
      sockets.delete(client);
      sockets.delete(upstream);
      client.destroy();
      upstream.destroy();
    };
    client.once("error", cleanup);
    upstream.once("error", cleanup);
    client.once("close", cleanup);
    upstream.once("close", cleanup);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("代理没有返回端口");
  }
  return {
    port: address.port,
    async close() {
      for (const socket of sockets) {
        socket.destroy();
      }
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      );
    }
  };
}

describe("single-port raw TCP forwarding", () => {
  let running: RunningServer | null = null;
  const sockets: WebSocket[] = [];
  let closeProxy: (() => Promise<void>) | null = null;

  afterEach(async () => {
    for (const socket of sockets) {
      socket.terminate();
    }
    sockets.length = 0;
    await closeProxy?.().catch(() => undefined);
    closeProxy = null;
    await running?.close();
    running = null;
  });

  it("carries HTTP, WebSocket control, chat, and a binary drawing frame over one external port", async () => {
    running = await startServer({
      host: "127.0.0.1",
      port: 0,
      serveStatic: false,
      startCleanup: false
    });
    const proxy = await tcpProxy(running.port);
    closeProxy = () => proxy.close();
    expect(proxy.port).not.toBe(running.port);
    const externalOrigin = `http://127.0.0.1:${String(proxy.port)}`;

    const preflight = await fetch(`${externalOrigin}/api/connection-info`);
    expect(preflight.status).toBe(200);
    expect((await preflight.json()) as object).toMatchObject({
      service: "draw-guess",
      protocolVersion: PROTOCOL_VERSION
    });

    const created = await fetch(`${externalOrigin}/api/desktop/rooms`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-draw-guess-client": "desktop",
        "x-draw-guess-protocol": String(PROTOCOL_VERSION)
      },
      body: JSON.stringify({ nickname: "代理画手", password: "secret" })
    });
    expect(created.status).toBe(201);
    const createdBody = (await created.json()) as {
      sessionToken: string;
      snapshot: { roomCode: string };
    };
    const roomCode = createdBody.snapshot.roomCode;
    const joined = await fetch(`${externalOrigin}/api/rooms/${roomCode}/join`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        roomCode,
        nickname: "代理猜词者",
        password: "secret"
      })
    });
    expect(joined.status).toBe(200);
    const cookie = joined.headers.get("set-cookie")?.split(";")[0];
    expect(cookie).toBeTruthy();

    const wsUrl = `ws://127.0.0.1:${String(
      proxy.port
    )}/ws?protocolVersion=${String(PROTOCOL_VERSION)}`;
    const host = await openSocket(wsUrl, {
      headers: {
        Authorization: `Bearer ${createdBody.sessionToken}`,
        "X-Draw-Guess-Client": "desktop",
        "X-Draw-Guess-Protocol": String(PROTOCOL_VERSION)
      }
    });
    const guest = await openSocket(wsUrl, {
      headers: { Cookie: cookie! },
      origin: externalOrigin
    });
    sockets.push(host.socket, guest.socket);
    await host.waitForJson("room:snapshot");
    await guest.waitForJson("room:snapshot");

    guest.send({ type: "chat:submit", text: "代理聊天成功" });
    expect(
      await host.waitForJson(
        "chat:message",
        (message) => message.text === "代理聊天成功"
      )
    ).toMatchObject({ text: "代理聊天成功" });

    host.send({ type: "capture:ready", ready: true });
    await host.waitForJson(
      "room:snapshot",
      (message) =>
        message.snapshot.players.find(
          (player) => player.id === message.snapshot.selfPlayerId
        )?.captureReady === true
    );
    host.send({ type: "game:start", commandId: "proxy-start" });
    const options = await host.waitForJson("classic:word-options");
    host.send({
      type: "classic:word-select",
      modeSessionId: options.modeSessionId,
      actorStepId: options.actorStepId,
      optionId: options.options[0]!.id,
      commandId: "proxy-word"
    });
    const capture = await host.waitForJson(
      "capture:start",
      (message) => message.stage === "drawing"
    );
    host.socket.send(encodeUploadFrame(capture.captureSessionId, JPEG), {
      binary: true,
      compress: false
    });
    const frame = decodeViewerFrame(await guest.waitForBinary());
    expect(frame.captureSessionId).toBe(capture.captureSessionId);
    expect([...frame.imageBytes]).toEqual([...JPEG]);

    const guestClosed = new Promise<void>((resolve) => {
      if (guest.socket.readyState === WebSocket.CLOSED) {
        resolve();
      } else {
        guest.socket.once("close", () => resolve());
      }
    });
    await proxy.close();
    closeProxy = null;
    await guestClosed;
    expect(
      (await fetch(`http://127.0.0.1:${String(running.port)}/api/connection-info`))
        .status
    ).toBe(200);
  });
});
