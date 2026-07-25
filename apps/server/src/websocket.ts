import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";

import {
  BrowserClientMessageSchema,
  DesktopClientMessageSchema,
  ErrorCode,
  MAX_FRAME_PACKET_BYTES,
  MAX_JSON_MESSAGE_BYTES,
  PROTOCOL_VERSION,
  type ClientJsonMessage
} from "@draw-guess/protocol";
import type { FastifyInstance } from "fastify";
import { WebSocketServer, type RawData, type WebSocket } from "ws";

import type { ServerConfig } from "./config.js";
import { GameError, type GameService, type RoomAccess } from "./game-service.js";

type ConnectionContext = {
  kind: "browser" | "desktop";
  access: RoomAccess;
};

function rejectUpgrade(socket: Duplex, status: 400 | 401 | 403 | 404 | 426): void {
  const reason =
    status === 401
      ? "Unauthorized"
      : status === 403
        ? "Forbidden"
        : status === 404
          ? "Not Found"
          : status === 426
            ? "Upgrade Required"
            : "Bad Request";
  const body =
    status === 426
      ? `Protocol version mismatch. Please upgrade Draw Guess to protocol ${String(
          PROTOCOL_VERSION
        )}.`
      : "";
  socket.write(
    `HTTP/1.1 ${status} ${reason}\r\n` +
      "Connection: close\r\n" +
      "Content-Type: text/plain; charset=utf-8\r\n" +
      `X-Draw-Guess-Protocol: ${String(PROTOCOL_VERSION)}\r\n` +
      `Content-Length: ${String(Buffer.byteLength(body))}\r\n\r\n${body}`
  );
  socket.destroy();
}

function bearerToken(request: IncomingMessage): string | null {
  const authorization = request.headers.authorization;
  if (!authorization?.startsWith("Bearer ")) {
    return null;
  }
  const token = authorization.slice("Bearer ".length).trim();
  return token || null;
}

function parseCookieHeader(header: string | undefined): Record<string, string> {
  if (!header) {
    return {};
  }
  return Object.fromEntries(
    header.split(";").flatMap((part) => {
      const separator = part.indexOf("=");
      if (separator <= 0) {
        return [];
      }
      const key = part.slice(0, separator).trim();
      const value = part.slice(separator + 1).trim();
      try {
        return [[key, decodeURIComponent(value)]];
      } catch {
        return [];
      }
    })
  );
}

function singleHeader(value: string | string[] | undefined): string | null {
  return Array.isArray(value) ? (value[0] ?? null) : (value ?? null);
}

export function isBrowserOriginAllowed(
  request: IncomingMessage,
  allowedOrigins: ReadonlySet<string>
): boolean {
  const origin = request.headers.origin;
  if (!origin) {
    return false;
  }
  if (allowedOrigins.has(origin)) {
    return true;
  }
  try {
    const parsed = new URL(origin);
    return (
      (parsed.protocol === "http:" || parsed.protocol === "https:") &&
      parsed.host === request.headers.host
    );
  } catch {
    return false;
  }
}

function asUtf8(data: RawData): string {
  if (Array.isArray(data)) {
    return Buffer.concat(data).toString("utf8");
  }
  if (data instanceof ArrayBuffer) {
    return Buffer.from(data).toString("utf8");
  }
  return data.toString("utf8");
}

function asPacket(data: RawData): Uint8Array {
  if (Buffer.isBuffer(data)) {
    return data;
  }
  if (Array.isArray(data)) {
    return Buffer.concat(data);
  }
  return new Uint8Array(data);
}

export function attachWebSocketServer(
  app: FastifyInstance,
  service: GameService,
  config: ServerConfig
): WebSocketServer {
  const server = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_FRAME_PACKET_BYTES,
    perMessageDeflate: false
  });
  const alive = new WeakMap<WebSocket, boolean>();

  const handleConnection = (webSocket: WebSocket, context: ConnectionContext): void => {
    alive.set(webSocket, true);
    webSocket.on("pong", () => alive.set(webSocket, true));

    try {
      service.connectPlayer(context.access, webSocket, context.kind);
    } catch (error) {
      service.sendError(webSocket, error);
      webSocket.close(4003, "连接鉴权失败");
      return;
    }

    webSocket.on("message", (data, isBinary) => {
      if (isBinary) {
        if (context.kind !== "desktop") {
          service.sendError(
            webSocket,
            new GameError(ErrorCode.FORBIDDEN, "浏览器连接不能上传图片", 403)
          );
          return;
        }
        const result = service.handleDesktopFrame(
          context.access,
          webSocket,
          asPacket(data)
        );
        if (!result.accepted && result.reason !== "FRAME_RATE_LIMITED") {
          service.sendError(
            webSocket,
            new GameError(ErrorCode.INVALID_FRAME, "图片帧被拒绝")
          );
        }
        return;
      }

      const raw = asUtf8(data);
      if (Buffer.byteLength(raw, "utf8") > MAX_JSON_MESSAGE_BYTES) {
        service.sendError(
          webSocket,
          new GameError(ErrorCode.BAD_MESSAGE, "消息体过大")
        );
        return;
      }

      let json: unknown;
      try {
        json = JSON.parse(raw);
      } catch {
        service.sendError(
          webSocket,
          new GameError(ErrorCode.BAD_MESSAGE, "JSON 消息格式错误")
        );
        return;
      }

      const parsed =
        context.kind === "desktop"
          ? DesktopClientMessageSchema.safeParse(json)
          : BrowserClientMessageSchema.safeParse(json);
      if (!parsed.success) {
        service.sendError(
          webSocket,
          new GameError(ErrorCode.BAD_MESSAGE, "客户端消息或协议版本无效")
        );
        return;
      }

      const message: ClientJsonMessage = parsed.data;
      void service
        .handleClientMessage(context.access, webSocket, message)
        .catch((error: unknown) => service.sendError(webSocket, error));
    });

    webSocket.on("close", () => {
      service.disconnectPlayer(
        context.access.room.roomCode,
        context.access.player.id,
        webSocket
      );
    });

    webSocket.on("error", () => {
      // The close event performs authoritative presence and grant cleanup.
    });
  };

  const onUpgrade = (request: IncomingMessage, socket: Duplex, head: Buffer): void => {
    let url: URL;
    try {
      url = new URL(
        request.url ?? "/",
        `http://${request.headers.host ?? "localhost"}`
      );
    } catch {
      rejectUpgrade(socket, 400);
      return;
    }
    if (url.pathname !== "/ws") {
      rejectUpgrade(socket, 404);
      return;
    }
    if (url.searchParams.get("protocolVersion") !== String(PROTOCOL_VERSION)) {
      rejectUpgrade(socket, 426);
      return;
    }

    let context: ConnectionContext;
    const token = bearerToken(request);
    if (token) {
      if (
        request.headers.origin ||
        singleHeader(request.headers["x-draw-guess-client"]) !== "desktop" ||
        singleHeader(request.headers["x-draw-guess-protocol"]) !==
          String(PROTOCOL_VERSION)
      ) {
        rejectUpgrade(socket, 403);
        return;
      }
      try {
        context = {
          kind: "desktop",
          access: service.resumeSession(token, "desktop")
        };
      } catch {
        rejectUpgrade(socket, 401);
        return;
      }
    } else {
      if (!isBrowserOriginAllowed(request, config.allowedOrigins)) {
        rejectUpgrade(socket, 403);
        return;
      }
      const sessionToken = parseCookieHeader(request.headers.cookie).dg_session;
      if (!sessionToken) {
        rejectUpgrade(socket, 401);
        return;
      }
      try {
        context = {
          kind: "browser",
          access: service.resumeSession(sessionToken, "browser")
        };
      } catch {
        rejectUpgrade(socket, 401);
        return;
      }
    }

    server.handleUpgrade(request, socket, head, (webSocket) => {
      handleConnection(webSocket, context);
    });
  };

  app.server.on("upgrade", onUpgrade);
  const heartbeat = setInterval(() => {
    for (const webSocket of server.clients) {
      if (alive.get(webSocket) === false) {
        webSocket.terminate();
        continue;
      }
      alive.set(webSocket, false);
      webSocket.ping();
    }
  }, 30_000);
  heartbeat.unref();

  app.addHook("preClose", async () => {
    clearInterval(heartbeat);
    app.server.off("upgrade", onUpgrade);
    for (const webSocket of server.clients) {
      webSocket.close(1001, "服务器关闭");
    }
    if (server.clients.size > 0) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      for (const webSocket of server.clients) {
        webSocket.terminate();
      }
    }
    server.close();
  });

  return server;
}
