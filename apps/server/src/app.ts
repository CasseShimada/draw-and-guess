import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";

import { CONTENT_LIMITS, WordPoolUploadSchema } from "@draw-guess/content";
import {
  APPLICATION_VERSION,
  ConnectionInfoSchema,
  CreateRoomRequestSchema,
  ErrorCode,
  JoinRoomRequestSchema,
  PROTOCOL_VERSION
} from "@draw-guess/protocol";
import cookie from "@fastify/cookie";
import fastifyStatic from "@fastify/static";
import Fastify, {
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest
} from "fastify";
import { z } from "zod";

import { loadConfig, type ServerConfig } from "./config.js";
import { GameError, GameService } from "./game-service.js";
import { REFERENCE_IMAGE_LIMITS } from "./modes/reference-copy/reference-assets.js";
import type { ReplayHostConfig } from "./services/ffmpeg-capability-service.js";
import { attachWebSocketServer } from "./websocket.js";

const SESSION_COOKIE = "dg_session";
const RoomCodeParamsSchema = z.object({
  id: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z0-9]{6}$/)
});
const AvatarParamsSchema = z
  .object({
    id: z
      .string()
      .trim()
      .toUpperCase()
      .regex(/^[A-Z0-9]{6}$/),
    playerId: z.string().min(1).max(128),
    revision: z.string().regex(/^[a-f0-9]{64}$/)
  })
  .strict();
const RevisionParamsSchema = RoomCodeParamsSchema.extend({
  revision: z.string().regex(/^[a-f0-9]{64}$/)
}).strict();
const ReferenceBallotParamsSchema = RoomCodeParamsSchema.extend({
  ballotId: z.string().min(1).max(160),
  ballotItemId: z.string().min(1).max(160)
}).strict();
const ReferenceResultParamsSchema = RoomCodeParamsSchema.extend({
  resultId: z.string().min(1).max(160),
  resultItemId: z.string().min(1).max(160)
}).strict();
const RelayTaskParamsSchema = RoomCodeParamsSchema.extend({
  actorStepId: z.string().min(1).max(160)
}).strict();
const RelayArtifactParamsSchema = RoomCodeParamsSchema.extend({
  artifactId: z.string().min(1).max(160),
  revision: z.string().regex(/^[a-f0-9]{64}$/)
}).strict();
const RelayResultParamsSchema = RoomCodeParamsSchema.extend({
  resultId: z.string().min(1).max(160),
  resultArtifactId: z.string().min(1).max(160)
}).strict();

export interface CreateAppOptions {
  config?: ServerConfig;
  service?: GameService;
  serveStatic?: boolean;
  webRoot?: string;
  startCleanup?: boolean;
  hostControlKey?: string | null;
  replayConfig?: ReplayHostConfig;
  appVersion?: string;
  serverInstanceId?: string;
  additionalAllowedOrigins?: readonly string[];
  trustedProxyAddresses?: readonly string[];
}

function defaultWebRoot(): string {
  const entryDirectory = path.dirname(path.resolve(process.argv[1] ?? process.cwd()));
  return path.resolve(entryDirectory, "../../web/dist");
}

function sessionToken(request: FastifyRequest): string {
  const token = request.cookies[SESSION_COOKIE];
  if (!token) {
    throw new GameError(ErrorCode.UNAUTHORIZED, "请先创建或加入房间", 401);
  }
  return token;
}

function bearerToken(request: FastifyRequest): string {
  const authorization = request.headers.authorization;
  if (!authorization?.startsWith("Bearer ")) {
    throw new GameError(ErrorCode.UNAUTHORIZED, "桌面会话不存在", 401);
  }
  const token = authorization.slice("Bearer ".length).trim();
  if (!token) {
    throw new GameError(ErrorCode.UNAUTHORIZED, "桌面会话不存在", 401);
  }
  return token;
}

function singleHeader(value: string | string[] | undefined): string | null {
  return Array.isArray(value) ? (value[0] ?? null) : (value ?? null);
}

function clientErrorStatus(error: unknown): number | null {
  if (
    typeof error !== "object" ||
    error === null ||
    !("statusCode" in error) ||
    typeof error.statusCode !== "number"
  ) {
    return null;
  }
  return error.statusCode >= 400 && error.statusCode < 500 ? error.statusCode : null;
}

function assertDesktopRequest(request: FastifyRequest): void {
  if (
    request.headers.origin ||
    singleHeader(request.headers["x-draw-guess-client"]) !== "desktop" ||
    singleHeader(request.headers["x-draw-guess-protocol"]) !== String(PROTOCOL_VERSION)
  ) {
    throw new GameError(ErrorCode.FORBIDDEN, "此接口只接受桌面主进程请求", 403);
  }
}

function authenticatedRoomAccess(request: FastifyRequest, service: GameService) {
  if (request.headers.authorization) {
    assertDesktopRequest(request);
    return service.resumeSession(bearerToken(request), "desktop");
  }
  return service.resumeSession(sessionToken(request), "browser");
}

function assertAccessRoom(
  roomCode: string,
  access: ReturnType<GameService["resumeSession"]>
): void {
  if (access.room.roomCode !== roomCode) {
    throw new GameError(ErrorCode.FORBIDDEN, "无权访问这个房间", 403);
  }
}

function setSessionCookie(
  request: FastifyRequest,
  reply: FastifyReply,
  token: string,
  config: ServerConfig
): void {
  const remoteAddress = request.raw.socket.remoteAddress ?? "";
  const normalizedRemoteAddress = remoteAddress.startsWith("::ffff:")
    ? remoteAddress.slice("::ffff:".length)
    : remoteAddress;
  const forwardedProtocol = singleHeader(request.headers["x-forwarded-proto"]);
  const forwardedHost = singleHeader(request.headers["x-forwarded-host"]);
  const secureFromTrustedProxy =
    config.trustedProxyAddresses.has(normalizedRemoteAddress) &&
    forwardedProtocol === "https" &&
    Boolean(forwardedHost) &&
    config.allowedOrigins.has(`https://${forwardedHost}`);
  reply.setCookie(SESSION_COOKIE, token, {
    path: "/",
    httpOnly: true,
    sameSite: "lax",
    secure: config.cookieSecure || secureFromTrustedProxy,
    maxAge: 7 * 24 * 60 * 60
  });
}

export async function createApp(options: CreateAppOptions = {}): Promise<{
  app: FastifyInstance;
  service: GameService;
  config: ServerConfig;
  serverInstanceId: string;
}> {
  const baseConfig = options.config ?? loadConfig();
  const config: ServerConfig = {
    ...baseConfig,
    allowedOrigins: new Set([
      ...baseConfig.allowedOrigins,
      ...(options.additionalAllowedOrigins ?? [])
    ]),
    trustedProxyAddresses: new Set([
      ...baseConfig.trustedProxyAddresses,
      ...(options.trustedProxyAddresses ?? [])
    ])
  };
  const serverInstanceId =
    options.serverInstanceId ?? randomBytes(32).toString("base64url");
  const appVersion = options.appVersion ?? APPLICATION_VERSION;
  const service =
    options.service ??
    GameService.fromConfig(config, {
      hostControlKey: options.hostControlKey,
      replayConfig: options.replayConfig
    });
  await service.initialize();
  const app = Fastify({
    logger:
      process.env.NODE_ENV === "test"
        ? false
        : {
            level: process.env.LOG_LEVEL ?? "info",
            redact: {
              paths: [
                "req.headers.authorization",
                "req.headers.cookie",
                "req.body.password",
                "password",
                "token",
                "answer"
              ],
              censor: "[REDACTED]"
            }
          },
    bodyLimit: 32 * 1024,
    trustProxy: false
  });

  await app.register(cookie);
  app.addContentTypeParser(
    ["image/png", "image/jpeg", "image/webp"],
    { parseAs: "buffer" },
    (_request, body, done) => done(null, body)
  );

  app.addHook("onSend", (_request, reply, _payload, done) => {
    reply
      .header("X-Content-Type-Options", "nosniff")
      .header("Referrer-Policy", "no-referrer")
      .header("X-Frame-Options", "DENY")
      .header(
        "Content-Security-Policy",
        "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
          "img-src 'self' blob: data:; connect-src 'self' ws: wss:; " +
          "object-src 'none'; base-uri 'none'; frame-ancestors 'none'"
      );
    done();
  });

  app.get("/health", () => ({
    ok: true,
    service: "draw-guess",
    now: Date.now()
  }));

  app.get("/api/connection-info", (_request, reply) => {
    reply.header("Cache-Control", "no-store").type("application/json; charset=utf-8");
    return ConnectionInfoSchema.parse({
      service: "draw-guess",
      appVersion,
      protocolVersion: PROTOCOL_VERSION,
      serverInstanceId,
      now: Date.now(),
      websocketPath: "/ws",
      capabilities: {
        browser: true,
        desktop: true
      }
    });
  });

  app.post("/api/rooms", async (request, reply) => {
    const parsed = CreateRoomRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      throw new GameError(ErrorCode.BAD_MESSAGE, "昵称或房间密码格式不正确");
    }
    const result = await service.createRoom(
      parsed.data.nickname,
      parsed.data.password,
      "browser"
    );
    setSessionCookie(request, reply, result.sessionToken, config);
    reply.code(201);
    return { snapshot: result.snapshot };
  });

  app.post("/api/rooms/:id/join", async (request, reply) => {
    const params = RoomCodeParamsSchema.safeParse(request.params);
    const body = JoinRoomRequestSchema.safeParse(request.body);
    if (!params.success || !body.success || params.data.id !== body.data.roomCode) {
      throw new GameError(ErrorCode.BAD_MESSAGE, "加入房间信息格式不正确");
    }
    const result = await service.joinRoom(
      params.data.id,
      body.data.nickname,
      body.data.password,
      "browser"
    );
    setSessionCookie(request, reply, result.sessionToken, config);
    return { snapshot: result.snapshot };
  });

  app.get("/api/rooms/:id", (request) => {
    const params = RoomCodeParamsSchema.safeParse(request.params);
    if (!params.success) {
      throw new GameError(ErrorCode.BAD_MESSAGE, "房间码格式不正确");
    }
    const access = service.resumeSession(sessionToken(request), "browser");
    if (access.room.roomCode !== params.data.id) {
      throw new GameError(ErrorCode.FORBIDDEN, "无权查看这个房间", 403);
    }
    return { snapshot: service.snapshot(access.room, access.player.id) };
  });

  app.get("/api/session", (request) => {
    const access = service.resumeSession(sessionToken(request), "browser");
    return { snapshot: service.snapshot(access.room, access.player.id) };
  });

  app.post("/api/desktop/rooms", async (request, reply) => {
    assertDesktopRequest(request);
    const parsed = CreateRoomRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      throw new GameError(ErrorCode.BAD_MESSAGE, "昵称或房间密码格式不正确");
    }
    const result = await service.createRoom(
      parsed.data.nickname,
      parsed.data.password,
      "desktop"
    );
    reply.code(201);
    return {
      sessionToken: result.sessionToken,
      expiresAt: result.sessionExpiresAt,
      snapshot: result.snapshot
    };
  });

  app.post("/api/desktop/rooms/:id/join", async (request) => {
    assertDesktopRequest(request);
    const params = RoomCodeParamsSchema.safeParse(request.params);
    const body = JoinRoomRequestSchema.safeParse(request.body);
    if (!params.success || !body.success || params.data.id !== body.data.roomCode) {
      throw new GameError(ErrorCode.BAD_MESSAGE, "加入房间信息格式不正确");
    }
    const result = await service.joinRoom(
      params.data.id,
      body.data.nickname,
      body.data.password,
      "desktop"
    );
    return {
      sessionToken: result.sessionToken,
      expiresAt: result.sessionExpiresAt,
      snapshot: result.snapshot
    };
  });

  app.get("/api/desktop/session", (request) => {
    assertDesktopRequest(request);
    const access = service.resumeSession(bearerToken(request), "desktop");
    return { snapshot: service.snapshot(access.room, access.player.id) };
  });

  app.put(
    "/api/rooms/:id/word-pool",
    { bodyLimit: CONTENT_LIMITS.wordPoolUploadBytes },
    (request) => {
      const params = RoomCodeParamsSchema.safeParse(request.params);
      const upload = WordPoolUploadSchema.safeParse(request.body);
      if (!params.success || !upload.success) {
        throw new GameError(ErrorCode.BAD_MESSAGE, "本局词池格式不正确");
      }
      const access = authenticatedRoomAccess(request, service);
      assertAccessRoom(params.data.id, access);
      return {
        wordPool: service.updateWordPool(params.data.id, access.player.id, upload.data)
      };
    }
  );

  app.put(
    "/api/rooms/:id/reference",
    { bodyLimit: REFERENCE_IMAGE_LIMITS.inputBytes },
    async (request) => {
      const params = RoomCodeParamsSchema.safeParse(request.params);
      if (!params.success || !Buffer.isBuffer(request.body)) {
        throw new GameError(ErrorCode.BAD_MESSAGE, "参考图请求格式不正确");
      }
      const contentType = request.headers["content-type"]?.split(";")[0]?.trim();
      if (
        contentType !== "image/png" &&
        contentType !== "image/jpeg" &&
        contentType !== "image/webp"
      ) {
        throw new GameError(ErrorCode.BAD_MESSAGE, "参考图类型不受支持");
      }
      const access = authenticatedRoomAccess(request, service);
      assertAccessRoom(params.data.id, access);
      const asset = await service.setReference(
        params.data.id,
        access.player.id,
        new Uint8Array(request.body),
        contentType
      );
      return {
        reference: {
          revision: asset.revision,
          mimeType: asset.mimeType,
          width: asset.width,
          height: asset.height,
          byteLength: asset.byteLength
        }
      };
    }
  );

  app.delete("/api/rooms/:id/reference", (request, reply) => {
    const params = RoomCodeParamsSchema.safeParse(request.params);
    if (!params.success) {
      throw new GameError(ErrorCode.BAD_MESSAGE, "房间码格式不正确");
    }
    const access = authenticatedRoomAccess(request, service);
    assertAccessRoom(params.data.id, access);
    service.deleteReference(params.data.id, access.player.id);
    reply.code(204);
    return reply.send();
  });

  app.get("/api/rooms/:id/reference/:revision", (request, reply) => {
    const params = RevisionParamsSchema.safeParse(request.params);
    if (!params.success) {
      throw new GameError(ErrorCode.BAD_MESSAGE, "参考图地址格式不正确");
    }
    const access = authenticatedRoomAccess(request, service);
    assertAccessRoom(params.data.id, access);
    const asset = service.referenceAsset(
      params.data.id,
      access.player.id,
      params.data.revision
    );
    reply
      .header("Cache-Control", "private, no-store")
      .header("Content-Disposition", "inline")
      .header("ETag", `"${asset.revision}"`)
      .type(asset.mimeType);
    return reply.send(Buffer.from(asset.bytes));
  });

  app.get(
    "/api/rooms/:id/reference-ballots/:ballotId/items/:ballotItemId",
    (request, reply) => {
      const params = ReferenceBallotParamsSchema.safeParse(request.params);
      if (!params.success) {
        throw new GameError(ErrorCode.BAD_MESSAGE, "匿名作品地址格式不正确");
      }
      const access = authenticatedRoomAccess(request, service);
      assertAccessRoom(params.data.id, access);
      const frame = service.referenceBallotAsset(
        params.data.id,
        access.player.id,
        params.data.ballotId,
        params.data.ballotItemId
      );
      reply
        .header("Cache-Control", "private, no-store")
        .header("Content-Disposition", "inline")
        .header("ETag", `"${frame.revision}"`)
        .type(frame.mimeType);
      return reply.send(Buffer.from(frame.bytes));
    }
  );

  app.get(
    "/api/rooms/:id/reference-results/:resultId/items/:resultItemId",
    (request, reply) => {
      const params = ReferenceResultParamsSchema.safeParse(request.params);
      if (!params.success) {
        throw new GameError(ErrorCode.BAD_MESSAGE, "临摹结果地址格式不正确");
      }
      const access = authenticatedRoomAccess(request, service);
      assertAccessRoom(params.data.id, access);
      const frame = service.referenceGalleryAsset(
        params.data.id,
        access.player.id,
        params.data.resultId,
        params.data.resultItemId
      );
      reply
        .header("Cache-Control", "private, no-store")
        .header("Content-Disposition", "inline")
        .header("ETag", `"${frame.revision}"`)
        .type(frame.mimeType);
      return reply.send(Buffer.from(frame.bytes));
    }
  );

  app.get("/api/rooms/:id/relay/tasks/:actorStepId", (request) => {
    const params = RelayTaskParamsSchema.safeParse(request.params);
    if (!params.success) {
      throw new GameError(ErrorCode.BAD_MESSAGE, "接龙任务地址格式不正确");
    }
    const access = authenticatedRoomAccess(request, service);
    assertAccessRoom(params.data.id, access);
    const task = service.relayPrivateTask(params.data.id, access.player.id);
    if (task.actorStepId !== params.data.actorStepId) {
      throw new GameError(ErrorCode.NOT_FOUND, "接龙任务已失效", 404);
    }
    return { task };
  });

  app.get("/api/rooms/:id/relay/artifacts/:artifactId/:revision", (request, reply) => {
    const params = RelayArtifactParamsSchema.safeParse(request.params);
    if (!params.success) {
      throw new GameError(ErrorCode.BAD_MESSAGE, "接龙画面地址格式不正确");
    }
    const access = authenticatedRoomAccess(request, service);
    assertAccessRoom(params.data.id, access);
    const frame = service.relayActiveArtifact(
      params.data.id,
      access.player.id,
      params.data.artifactId,
      params.data.revision
    );
    reply
      .header("Cache-Control", "private, no-store")
      .header("Content-Disposition", "inline")
      .header("ETag", `"${frame.revision}"`)
      .type(frame.mimeType);
    return reply.send(Buffer.from(frame.bytes));
  });

  app.get(
    "/api/rooms/:id/relay/results/:resultId/artifacts/:resultArtifactId",
    (request, reply) => {
      const params = RelayResultParamsSchema.safeParse(request.params);
      if (!params.success) {
        throw new GameError(ErrorCode.BAD_MESSAGE, "接龙结果地址格式不正确");
      }
      const access = authenticatedRoomAccess(request, service);
      assertAccessRoom(params.data.id, access);
      const frame = service.relayResultArtifact(
        params.data.id,
        access.player.id,
        params.data.resultId,
        params.data.resultArtifactId
      );
      reply
        .header("Cache-Control", "private, no-store")
        .header("Content-Disposition", "inline")
        .header("ETag", `"${frame.revision}"`)
        .type(frame.mimeType);
      return reply.send(Buffer.from(frame.bytes));
    }
  );

  app.put(
    "/api/rooms/:id/me/avatar",
    { bodyLimit: CONTENT_LIMITS.avatarBytes },
    (request) => {
      const params = RoomCodeParamsSchema.safeParse(request.params);
      if (!params.success || !Buffer.isBuffer(request.body)) {
        throw new GameError(ErrorCode.BAD_MESSAGE, "头像请求格式不正确");
      }
      const contentType = request.headers["content-type"]?.split(";")[0]?.trim();
      if (contentType !== "image/png") {
        throw new GameError(ErrorCode.BAD_MESSAGE, "头像仅支持 PNG", 415);
      }
      const access = authenticatedRoomAccess(request, service);
      assertAccessRoom(params.data.id, access);
      const avatar = service.updateAvatar(
        params.data.id,
        access.player.id,
        new Uint8Array(request.body)
      );
      return { revision: avatar.revision };
    }
  );

  app.delete("/api/rooms/:id/me/avatar", (request, reply) => {
    const params = RoomCodeParamsSchema.safeParse(request.params);
    if (!params.success) {
      throw new GameError(ErrorCode.BAD_MESSAGE, "房间码格式不正确");
    }
    const access = authenticatedRoomAccess(request, service);
    assertAccessRoom(params.data.id, access);
    service.deleteAvatar(params.data.id, access.player.id);
    reply.code(204);
    return reply.send();
  });

  app.get("/api/rooms/:id/players/:playerId/avatar/:revision", (request, reply) => {
    const params = AvatarParamsSchema.safeParse(request.params);
    if (!params.success) {
      throw new GameError(ErrorCode.BAD_MESSAGE, "头像地址格式不正确");
    }
    const access = authenticatedRoomAccess(request, service);
    assertAccessRoom(params.data.id, access);
    const avatar = service.avatar(
      params.data.id,
      access.player.id,
      params.data.playerId,
      params.data.revision
    );
    const etag = `"${avatar.revision}"`;
    reply
      .header("ETag", etag)
      .header("Cache-Control", "private, max-age=31536000, immutable")
      .type("image/png");
    if (request.headers["if-none-match"] === etag) {
      reply.code(304);
      return reply.send();
    }
    return reply.send(Buffer.from(avatar.bytes));
  });

  app.addHook("preClose", async () => {
    await service.shutdown();
  });
  attachWebSocketServer(app, service, config);

  let cleanupTimer: NodeJS.Timeout | null = null;
  if (options.startCleanup !== false) {
    cleanupTimer = setInterval(() => service.cleanupInactive(), 60_000);
    cleanupTimer.unref();
    app.addHook("onClose", () => {
      if (cleanupTimer) {
        clearInterval(cleanupTimer);
      }
    });
  }

  const webRoot = options.webRoot ?? defaultWebRoot();
  if (options.serveStatic !== false && existsSync(webRoot)) {
    await app.register(fastifyStatic, {
      root: webRoot,
      prefix: "/",
      maxAge: "1h",
      immutable: false
    });
    app.setNotFoundHandler((request, reply) => {
      if (
        request.method === "GET" &&
        !request.url.startsWith("/api/") &&
        request.headers.accept?.includes("text/html")
      ) {
        return reply.header("Cache-Control", "no-store").sendFile("index.html");
      }
      return reply.code(404).send({
        error: { code: ErrorCode.NOT_FOUND, message: "资源不存在" }
      });
    });
  }

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof GameError) {
      return reply.code(error.statusCode).send({
        error: { code: error.code, message: error.message }
      });
    }
    if (error instanceof z.ZodError) {
      return reply.code(400).send({
        error: { code: ErrorCode.BAD_MESSAGE, message: "请求格式不正确" }
      });
    }
    const statusCode = clientErrorStatus(error);
    if (statusCode) {
      return reply.code(statusCode).send({
        error: {
          code: ErrorCode.BAD_MESSAGE,
          message:
            statusCode === 413
              ? "请求内容超过大小上限"
              : statusCode === 415
                ? "请求内容类型不受支持"
                : "请求格式不正确"
        }
      });
    }
    request.log.error({ err: error }, "request failed");
    return reply.code(500).send({
      error: { code: ErrorCode.INTERNAL_ERROR, message: "服务器处理失败" }
    });
  });

  return { app, service, config, serverInstanceId };
}
