import {
  PROTOCOL_VERSION,
  SLOW_CLIENT_BUFFER_BYTES,
  ServerJsonMessageSchema,
  RelayPrivateTaskResponseSchema,
  encodeUploadFrame,
  isValidEncodedImage,
  type DesktopClientMessage
} from "@draw-guess/protocol";
import {
  CONTENT_LIMITS,
  WordPoolUploadSchema,
  validateNormalizedAvatarPng,
  type WordPoolUpload
} from "@draw-guess/content";
import { boundedBackoff } from "@draw-guess/capture-core";
import { z } from "zod";
import WebSocket, { type RawData } from "ws";

import {
  AvatarRevisionResultSchema,
  DesktopRoomResponseSchema,
  GameAssetResultSchema,
  GameEventSchema,
  UploadReferenceResultSchema,
  UploadWordPoolResultSchema,
  type GameEvent
} from "../shared/ipc.js";
import {
  normalizeConnectionTarget,
  websocketUrl,
  type ConnectionTarget,
  type NormalizedConnectionTarget
} from "../shared/server-url.js";
import type { ConnectionPreflightService } from "./connection-preflight-service.js";
import { DesktopRequestError } from "./desktop-request-error.js";
import {
  ConnectionPreflightError,
  describeJoinRoomFailure,
  joinRoomFailureMessage,
  type JoinRoomFailurePhase
} from "./join-room-failure.js";
import type { RedactingLogger } from "./redacting-logger.js";
import type { SettingsService } from "./settings-service.js";

const DesktopSessionResponseSchema = z
  .object({
    sessionToken: z.string().min(20),
    expiresAt: z.number(),
    snapshot: DesktopRoomResponseSchema.shape.snapshot
  })
  .strict();

const ApiErrorSchema = z
  .object({
    error: z
      .object({
        code: z.string().optional(),
        message: z.string().optional()
      })
      .optional()
  })
  .passthrough();

type EventListener = (event: GameEvent) => void;

function asUint8Array(data: RawData): Uint8Array {
  if (Buffer.isBuffer(data)) {
    return new Uint8Array(data);
  }
  if (Array.isArray(data)) {
    return new Uint8Array(Buffer.concat(data));
  }
  return new Uint8Array(data);
}

export class GameClientService {
  readonly #settings: SettingsService;
  readonly #logger: RedactingLogger;
  readonly #preflight: ConnectionPreflightService;
  readonly #listeners = new Set<EventListener>();
  readonly #requestControllers = new Set<AbortController>();
  #target: NormalizedConnectionTarget;
  #token: string | null = null;
  #socket: WebSocket | null = null;
  #reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  #heartbeat: ReturnType<typeof setInterval> | null = null;
  #attempt = 0;
  #epoch = 0;
  #manualDisconnect = true;

  constructor(
    settings: SettingsService,
    logger: RedactingLogger,
    preflight: ConnectionPreflightService
  ) {
    this.#settings = settings;
    this.#logger = logger;
    this.#preflight = preflight;
    this.#target = normalizeConnectionTarget(settings.settings.currentClientTarget);
  }

  get target(): NormalizedConnectionTarget {
    return structuredClone(this.#target);
  }

  onEvent(listener: EventListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  async configure(targetInput: ConnectionTarget): Promise<void> {
    const target = normalizeConnectionTarget(targetInput);
    if (target.origin !== this.#target.origin) {
      await this.disconnect();
      this.#target = target;
      this.#token = null;
    }
    await this.#settings.update({
      currentClientTarget: {
        host: target.host,
        port: target.port,
        security: target.security
      }
    });
  }

  async createRoom(
    targetInput: ConnectionTarget,
    nickname: string,
    password: string,
    confirmInsecureHttp = false
  ): Promise<z.infer<typeof DesktopRoomResponseSchema>> {
    await this.#requireSuccessfulPreflight(targetInput, confirmInsecureHttp);
    await this.configure(targetInput);
    const response = await this.#request("/api/desktop/rooms", {
      method: "POST",
      body: JSON.stringify({ nickname, password })
    });
    const session = DesktopSessionResponseSchema.parse(response);
    await this.#acceptSession(session.sessionToken, session.expiresAt);
    return DesktopRoomResponseSchema.parse({ snapshot: session.snapshot });
  }

  async joinRoom(
    targetInput: ConnectionTarget,
    roomCode: string,
    nickname: string,
    password: string,
    confirmInsecureHttp = false
  ): Promise<z.infer<typeof DesktopRoomResponseSchema>> {
    let phase: JoinRoomFailurePhase = "preflight";
    try {
      const preflight = await this.#requireSuccessfulPreflight(
        targetInput,
        confirmInsecureHttp
      );
      phase = "target-configuration";
      await this.configure(preflight.target);
      phase = "join-request";
      const response = await this.#request(
        `/api/desktop/rooms/${encodeURIComponent(roomCode)}/join`,
        {
          method: "POST",
          body: JSON.stringify({ roomCode, nickname, password })
        }
      );
      phase = "response-validation";
      const session = DesktopSessionResponseSchema.parse(response);
      phase = "session-setup";
      await this.#acceptSession(session.sessionToken, session.expiresAt);
      await this.#settings.addRecentConnection(this.#target);
      return DesktopRoomResponseSchema.parse({ snapshot: session.snapshot });
    } catch (error) {
      const failure = describeJoinRoomFailure(error, phase);
      let origin: string | null = null;
      try {
        origin = normalizeConnectionTarget(targetInput).origin;
      } catch {
        // The invalid-input diagnostic already explains why normalization failed.
      }
      this.#logger.warn("加入房间失败", {
        origin,
        phase: failure.phaseLabel,
        code: failure.code,
        reason: failure.reason,
        suggestion: failure.suggestion
      });
      throw new Error(joinRoomFailureMessage(failure), { cause: error });
    }
  }

  async resume(
    targetInput: ConnectionTarget
  ): Promise<z.infer<typeof DesktopRoomResponseSchema> | null> {
    await this.configure(targetInput);
    const token = await this.#settings.session(this.#target);
    if (!token) {
      return null;
    }
    try {
      const response = await this.#request("/api/desktop/session", {
        method: "GET",
        token
      });
      const parsed = DesktopRoomResponseSchema.parse(response);
      this.#token = token;
      this.#connect(false);
      return parsed;
    } catch (error) {
      if (error instanceof DesktopRequestError && error.status === 401) {
        await this.#settings.clearSession(this.#target);
        this.#token = null;
        return null;
      }
      throw error;
    }
  }

  send(messageInput: DesktopClientMessage): void {
    const message = messageInput;
    const socket = this.#socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      throw new Error("游戏连接尚未恢复");
    }
    socket.send(JSON.stringify(message));
  }

  uploadFrame(
    captureSessionId: number,
    bytesInput: Uint8Array
  ): { accepted: boolean; reason?: string } {
    const socket = this.#socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      return { accepted: false, reason: "连接未就绪" };
    }
    if (socket.bufferedAmount > SLOW_CLIENT_BUFFER_BYTES) {
      return { accepted: false, reason: "网络拥塞，已跳过旧帧" };
    }
    const bytes = new Uint8Array(bytesInput);
    if (!isValidEncodedImage(bytes)) {
      return { accepted: false, reason: "编码结果不是有效的 JPEG/WebP" };
    }
    let packet: Uint8Array;
    try {
      packet = encodeUploadFrame(captureSessionId, bytes);
    } catch (error) {
      return {
        accepted: false,
        reason: error instanceof Error ? error.message : "图片包无效"
      };
    }
    socket.send(packet, { binary: true, compress: false });
    return { accepted: true };
  }

  async uploadWordPool(
    roomCode: string,
    wordPoolInput: WordPoolUpload
  ): Promise<z.infer<typeof UploadWordPoolResultSchema>> {
    const wordPool = WordPoolUploadSchema.parse(wordPoolInput);
    const response = await this.#request(
      `/api/rooms/${encodeURIComponent(roomCode)}/word-pool`,
      {
        method: "PUT",
        token: this.#requireToken(),
        body: JSON.stringify(wordPool)
      }
    );
    return UploadWordPoolResultSchema.parse(response);
  }

  async uploadReference(
    roomCode: string,
    mimeType: "image/png" | "image/jpeg" | "image/webp",
    bytesInput: Uint8Array
  ): Promise<z.infer<typeof UploadReferenceResultSchema>> {
    const bytes = new Uint8Array(bytesInput);
    if (bytes.byteLength < 1 || bytes.byteLength > 20 * 1024 * 1024) {
      throw new Error("参考图必须在 1 字节到 20 MiB 之间");
    }
    const body = new ArrayBuffer(bytes.byteLength);
    new Uint8Array(body).set(bytes);
    const response = await this.#request(
      `/api/rooms/${encodeURIComponent(roomCode)}/reference`,
      {
        method: "PUT",
        token: this.#requireToken(),
        body,
        contentType: mimeType
      }
    );
    return UploadReferenceResultSchema.parse(response);
  }

  async deleteReference(roomCode: string): Promise<void> {
    await this.#rawRequest(`/api/rooms/${encodeURIComponent(roomCode)}/reference`, {
      method: "DELETE",
      token: this.#requireToken()
    });
  }

  async getAsset(
    roomCode: string,
    pathname: string
  ): Promise<z.infer<typeof GameAssetResultSchema>> {
    const prefix = `/api/rooms/${encodeURIComponent(roomCode)}/`;
    if (!pathname.startsWith(prefix)) {
      throw new Error("游戏素材地址不属于当前房间");
    }
    const response = await this.#rawRequest(pathname, {
      method: "GET",
      token: this.#requireToken()
    });
    const mimeType = response.headers.get("content-type")?.split(";")[0]?.trim();
    if (
      mimeType !== "image/png" &&
      mimeType !== "image/jpeg" &&
      mimeType !== "image/webp"
    ) {
      throw new Error("服务器返回了不支持的游戏素材类型");
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength < 1 || bytes.byteLength > 20 * 1024 * 1024) {
      throw new Error("服务器游戏素材大小无效");
    }
    return GameAssetResultSchema.parse({ mimeType, bytes });
  }

  async getRelayTask(roomCode: string, actorStepId: string) {
    const response = await this.#request(
      `/api/rooms/${encodeURIComponent(roomCode)}/relay/tasks/${encodeURIComponent(
        actorStepId
      )}`,
      {
        method: "GET",
        token: this.#requireToken()
      }
    );
    return RelayPrivateTaskResponseSchema.parse(response);
  }

  async uploadAvatar(
    roomCode: string,
    bytesInput: Uint8Array
  ): Promise<z.infer<typeof AvatarRevisionResultSchema>> {
    const bytes = new Uint8Array(bytesInput);
    validateNormalizedAvatarPng(bytes);
    const body = new ArrayBuffer(bytes.byteLength);
    new Uint8Array(body).set(bytes);
    const response = await this.#request(
      `/api/rooms/${encodeURIComponent(roomCode)}/me/avatar`,
      {
        method: "PUT",
        token: this.#requireToken(),
        body,
        contentType: "image/png"
      }
    );
    return AvatarRevisionResultSchema.parse(response);
  }

  async deleteAvatar(roomCode: string): Promise<void> {
    await this.#rawRequest(`/api/rooms/${encodeURIComponent(roomCode)}/me/avatar`, {
      method: "DELETE",
      token: this.#requireToken()
    });
  }

  async getAvatar(
    roomCode: string,
    playerId: string,
    revision: string
  ): Promise<Uint8Array | null> {
    const response = await this.#rawRequest(
      `/api/rooms/${encodeURIComponent(roomCode)}/players/${encodeURIComponent(
        playerId
      )}/avatar/${encodeURIComponent(revision)}`,
      {
        method: "GET",
        token: this.#requireToken(),
        allowNotFound: true
      }
    );
    if (response.status === 404) {
      return null;
    }
    const contentLength = Number(response.headers.get("content-length") ?? "0");
    if (contentLength > CONTENT_LIMITS.avatarBytes) {
      throw new Error("服务器头像响应超过大小上限");
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    validateNormalizedAvatarPng(bytes);
    return bytes;
  }

  disconnect(): Promise<void> {
    this.#manualDisconnect = true;
    this.#epoch += 1;
    this.#clearTimers();
    for (const controller of this.#requestControllers) {
      controller.abort();
    }
    this.#requestControllers.clear();
    const socket = this.#socket;
    this.#socket = null;
    if (socket && socket.readyState < WebSocket.CLOSING) {
      socket.close(1000, "桌面客户端主动断开");
    }
    this.#emit({ kind: "connection", state: "offline" });
    return Promise.resolve();
  }

  async clearSession(): Promise<void> {
    await this.disconnect();
    await this.#settings.clearSession(this.#target);
    this.#token = null;
  }

  async #acceptSession(token: string, expiresAt: number): Promise<void> {
    this.#token = token;
    await this.#settings.saveSession(this.#target, token, expiresAt);
    this.#connect(false);
  }

  #connect(reconnecting: boolean): void {
    const token = this.#token;
    if (!token) {
      return;
    }
    this.#manualDisconnect = false;
    this.#epoch += 1;
    const epoch = this.#epoch;
    this.#clearTimers();
    if (this.#socket && this.#socket.readyState < WebSocket.CLOSING) {
      this.#socket.close(1000, "连接已替换");
    }
    this.#emit({
      kind: "connection",
      state: reconnecting ? "reconnecting" : "connecting"
    });
    const socket = new WebSocket(
      `${websocketUrl(this.#target)}?protocolVersion=${String(PROTOCOL_VERSION)}`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          "X-Draw-Guess-Client": "desktop",
          "X-Draw-Guess-Protocol": String(PROTOCOL_VERSION)
        },
        perMessageDeflate: false,
        maxPayload: 2 * 1024 * 1024 + 8
      }
    );
    this.#socket = socket;

    socket.on("open", () => {
      if (this.#epoch !== epoch || this.#socket !== socket) {
        socket.close();
        return;
      }
      this.#attempt = 0;
      this.#emit({ kind: "connection", state: "connected" });
      socket.send(
        JSON.stringify({
          protocolVersion: PROTOCOL_VERSION,
          type: "room:sync"
        })
      );
      this.#heartbeat = setInterval(() => {
        if (socket.readyState === WebSocket.OPEN) {
          socket.send(
            JSON.stringify({
              protocolVersion: PROTOCOL_VERSION,
              type: "ping",
              timestamp: Date.now()
            })
          );
        }
      }, 20_000);
    });

    socket.on("message", (data, isBinary) => {
      if (this.#epoch !== epoch || this.#socket !== socket) {
        return;
      }
      if (isBinary) {
        this.#emit({ kind: "frame", packet: asUint8Array(data) });
        return;
      }
      let parsedJson: unknown;
      try {
        parsedJson = JSON.parse(Buffer.from(asUint8Array(data)).toString("utf8"));
      } catch {
        this.#logger.warn("服务器返回了无效 JSON");
        return;
      }
      const parsed = ServerJsonMessageSchema.safeParse(parsedJson);
      if (!parsed.success) {
        this.#logger.warn("服务器消息 schema 或协议版本不匹配");
        return;
      }
      this.#emit({ kind: "message", message: parsed.data });
    });

    socket.on("close", (code) => {
      if (this.#epoch !== epoch || this.#socket !== socket) {
        return;
      }
      this.#socket = null;
      this.#clearTimers();
      if (this.#manualDisconnect) {
        this.#emit({ kind: "connection", state: "offline" });
        return;
      }
      this.#attempt += 1;
      const delay = boundedBackoff(this.#attempt);
      this.#logger.warn("游戏连接中断，准备重连", { code, delay });
      this.#emit({ kind: "connection", state: "reconnecting" });
      this.#reconnectTimer = setTimeout(() => this.#connect(true), delay);
    });

    socket.on("error", (error) => {
      this.#logger.warn("游戏 WebSocket 错误", { message: error.message });
    });

    socket.on("unexpected-response", (_request, response) => {
      this.#logger.warn("服务器拒绝 WebSocket", {
        statusCode: response.statusCode
      });
    });
  }

  async #request(
    pathname: string,
    options: {
      method: "GET" | "POST" | "PUT" | "DELETE";
      body?: string | ArrayBuffer;
      token?: string;
      contentType?: string;
    }
  ): Promise<unknown> {
    const response = await this.#rawRequest(pathname, options);
    return (await response.json().catch(() => null)) as unknown;
  }

  async #rawRequest(
    pathname: string,
    options: {
      method: "GET" | "POST" | "PUT" | "DELETE";
      body?: string | ArrayBuffer;
      token?: string;
      contentType?: string;
      allowNotFound?: boolean;
    }
  ): Promise<Response> {
    const epoch = this.#epoch;
    const controller = new AbortController();
    this.#requestControllers.add(controller);
    let response: Response;
    try {
      response = await fetch(`${this.#target.origin}${pathname}`, {
        method: options.method,
        headers: {
          Accept: "application/json",
          ...(options.body
            ? { "Content-Type": options.contentType ?? "application/json" }
            : {}),
          "X-Draw-Guess-Client": "desktop",
          "X-Draw-Guess-Protocol": String(PROTOCOL_VERSION),
          ...(options.token ? { Authorization: `Bearer ${options.token}` } : {})
        },
        ...(options.body ? { body: options.body } : {}),
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]),
        redirect: "error"
      });
    } finally {
      this.#requestControllers.delete(controller);
    }
    if (epoch !== this.#epoch) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error("连接目标已更改，旧服务器响应已丢弃");
    }
    if (!response.ok && !(options.allowNotFound && response.status === 404)) {
      const body = (await response.json().catch(() => null)) as unknown;
      const parsed = ApiErrorSchema.safeParse(body);
      throw new DesktopRequestError(
        response.status,
        parsed.success
          ? (parsed.data.error?.message ?? "服务器请求失败")
          : "服务器请求失败",
        parsed.success ? parsed.data.error?.code : undefined
      );
    }
    return response;
  }

  #requireToken(): string {
    if (!this.#token) {
      throw new Error("桌面会话不存在，请重新加入房间");
    }
    return this.#token;
  }

  async #requireSuccessfulPreflight(
    target: ConnectionTarget,
    confirmInsecureHttp: boolean
  ) {
    const result = await this.#preflight.test(target, confirmInsecureHttp);
    if (!result.ok) {
      throw new ConnectionPreflightError(result);
    }
    return result;
  }

  #emit(eventInput: GameEvent): void {
    const event = GameEventSchema.parse(eventInput);
    for (const listener of this.#listeners) {
      listener(event);
    }
  }

  #clearTimers(): void {
    if (this.#reconnectTimer) {
      clearTimeout(this.#reconnectTimer);
      this.#reconnectTimer = null;
    }
    if (this.#heartbeat) {
      clearInterval(this.#heartbeat);
      this.#heartbeat = null;
    }
  }
}
