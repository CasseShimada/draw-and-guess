import http, { createServer as createHttpServer } from "node:http";
import { createConnection } from "node:net";
import type { Duplex } from "node:stream";

import { PROTOCOL_VERSION, type ServerJsonMessage } from "@draw-guess/protocol";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";

import { startServer, type RunningServer } from "./server.js";

async function reverseProxy(targetPort: number) {
  const tunnels = new Set<Duplex>();
  const server = createHttpServer((request, response) => {
    const upstream = http.request(
      {
        host: "127.0.0.1",
        port: targetPort,
        method: request.method,
        path: request.url,
        headers: {
          ...request.headers,
          host: `127.0.0.1:${String(targetPort)}`,
          "x-forwarded-proto": "https",
          "x-forwarded-host": "public.example"
        }
      },
      (upstreamResponse) => {
        response.writeHead(
          upstreamResponse.statusCode ?? 502,
          upstreamResponse.headers
        );
        upstreamResponse.pipe(response);
      }
    );
    upstream.on("error", () => response.destroy());
    request.pipe(upstream);
  });
  server.on("upgrade", (request, socket, head) => {
    const upstream = createConnection({
      host: "127.0.0.1",
      port: targetPort
    });
    tunnels.add(socket);
    tunnels.add(upstream);
    upstream.once("connect", () => {
      const headers = {
        ...request.headers,
        host: `127.0.0.1:${String(targetPort)}`,
        "x-forwarded-proto": "https",
        "x-forwarded-host": "public.example"
      };
      const lines = [
        `${request.method ?? "GET"} ${request.url ?? "/"} HTTP/1.1`,
        ...Object.entries(headers).flatMap(([name, value]) =>
          value === undefined
            ? []
            : Array.isArray(value)
              ? value.map((item) => `${name}: ${item}`)
              : [`${name}: ${value}`]
        ),
        "",
        ""
      ];
      upstream.write(lines.join("\r\n"));
      if (head.byteLength > 0) {
        upstream.write(head);
      }
      socket.pipe(upstream).pipe(socket);
    });
    const cleanup = () => {
      tunnels.delete(socket);
      tunnels.delete(upstream);
      socket.destroy();
      upstream.destroy();
    };
    socket.once("error", cleanup);
    upstream.once("error", cleanup);
    socket.once("close", cleanup);
    upstream.once("close", cleanup);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("reverse proxy did not bind");
  }
  return {
    port: address.port,
    async close() {
      for (const tunnel of tunnels) {
        tunnel.destroy();
      }
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      );
    }
  };
}

describe("trusted HTTPS-terminating reverse proxy behavior", () => {
  let running: RunningServer | null = null;
  let closeProxy: (() => Promise<void>) | null = null;
  const sockets: WebSocket[] = [];

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

  it("uses Secure cookies and upgrades an explicitly configured public browser origin", async () => {
    running = await startServer({
      host: "127.0.0.1",
      port: 0,
      serveStatic: false,
      startCleanup: false,
      additionalAllowedOrigins: ["https://public.example"],
      trustedProxyAddresses: ["127.0.0.1"]
    });
    const proxy = await reverseProxy(running.port);
    closeProxy = () => proxy.close();
    expect(proxy.port).not.toBe(running.port);
    const proxyOrigin = `http://127.0.0.1:${String(proxy.port)}`;

    const created = await fetch(`${proxyOrigin}/api/rooms`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ nickname: "HTTPS 代理玩家", password: "secret" })
    });
    expect(created.status).toBe(201);
    const cookieHeader = created.headers.get("set-cookie");
    expect(cookieHeader).toContain("Secure");
    expect(cookieHeader).toContain("HttpOnly");
    const cookie = cookieHeader?.split(";")[0];
    const roomCode = ((await created.json()) as { snapshot: { roomCode: string } })
      .snapshot.roomCode;

    const socket = new WebSocket(
      `ws://127.0.0.1:${String(
        proxy.port
      )}/ws?protocolVersion=${String(PROTOCOL_VERSION)}`,
      {
        origin: "https://public.example",
        headers: { Cookie: cookie! }
      }
    );
    sockets.push(socket);
    const messages: ServerJsonMessage[] = [];
    socket.on("message", (data) => {
      messages.push(JSON.parse(data.toString()) as ServerJsonMessage);
    });
    await new Promise<void>((resolve, reject) => {
      socket.once("open", resolve);
      socket.once("error", reject);
    });
    socket.send(
      JSON.stringify({
        protocolVersion: PROTOCOL_VERSION,
        type: "room:sync"
      })
    );
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error("reverse-proxy snapshot timeout")),
        2_000
      );
      const poll = setInterval(() => {
        if (
          messages.some(
            (message) =>
              message.type === "room:snapshot" && message.snapshot.roomCode === roomCode
          )
        ) {
          clearTimeout(timeout);
          clearInterval(poll);
          resolve();
        }
      }, 5);
    });
  });
});
