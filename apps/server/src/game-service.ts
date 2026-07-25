import { randomInt } from "node:crypto";

import type { WordPoolUpload } from "@draw-guess/content";
import {
  ErrorCode,
  MIN_FRAME_INTERVAL_MS,
  SLOW_CLIENT_BUFFER_BYTES,
  decodeUploadFrame,
  encodeViewerFrame,
  serializeServerMessage,
  type ClientJsonMessage,
  type ServerMessagePayload
} from "@draw-guess/protocol";
import type {
  GameModeId,
  PublicChatEntry,
  PublicRoomSnapshot,
  ReplayHostCapability
} from "@draw-guess/shared-types";

import { validateRoomAvatar, type RoomAvatar } from "./avatar-service.js";
import type { ServerConfig } from "./config.js";
import { GameError } from "./errors.js";
import type { ModeContext } from "./modes/game-mode.js";
import { GameModeRegistry } from "./modes/mode-registry.js";
import {
  normalizeReferenceAsset,
  type ReferenceAsset
} from "./modes/reference-copy/reference-assets.js";
import { CaptureGrantService } from "./services/capture-grant-service.js";
import type { ReplayHostConfig } from "./services/ffmpeg-capability-service.js";
import { ModeScheduler } from "./services/mode-scheduler.js";
import { PassCoordinator } from "./services/pass-coordinator.js";
import { ReplayService, type ReplaySavedFile } from "./services/replay-service.js";
import {
  SessionStore,
  hashPassword,
  randomId,
  randomRoomCode,
  sanitizeNickname,
  verifyPassword,
  type PlayerSession
} from "./security.js";
import type { GameSocket, Player, Room } from "./types.js";

export { GameError } from "./errors.js";

const SOCKET_OPEN = 1;
const MAX_CHAT_HISTORY = 100;
const CHAT_RATE_LIMIT = 5;
const CHAT_RATE_WINDOW_MS = 1_000;
const AVATAR_RATE_LIMIT = 5;
const AVATAR_RATE_WINDOW_MS = 60_000;
const REFERENCE_UPLOAD_RATE_LIMIT = 10;
const REFERENCE_UPLOAD_RATE_WINDOW_MS = 60_000;
const RESUME_CAPTURE_DELAY_MS = 3_000;
const MAX_PROCESSED_COMMAND_IDS = 2_048;
const PROCESSED_COMMAND_TTL_MS = 15 * 60_000;

export interface GameServiceOptions {
  roomIdleTtlMs: number;
  reconnectGraceMs: number;
  desktopSessionTtlMs: number;
  turnResultMs: number;
  now?: () => number;
  randomIndex?: (maximum: number) => number;
  replayService?: ReplayService;
  replayConfig?: ReplayHostConfig;
  hostControlKey?: string | null;
}

export interface RoomAccess {
  room: Room;
  player: Player;
  session: PlayerSession;
}

export interface RoomJoinResult {
  sessionToken: string;
  sessionExpiresAt: number;
  snapshot: PublicRoomSnapshot;
}

export type FrameAcceptance =
  { accepted: true; sequence: number } | { accepted: false; reason: string };

function modeIsTerminal(room: Room): boolean {
  switch (room.modeRuntime.mode) {
    case "classic":
      return (
        room.modeRuntime.state.phase === "LOBBY" ||
        room.modeRuntime.state.phase === "GAME_RESULT"
      );
    case "reference-copy":
      return (
        room.modeRuntime.state.phase === "LOBBY" ||
        room.modeRuntime.state.phase === "GALLERY"
      );
    case "draw-relay":
      return (
        room.modeRuntime.state.phase === "LOBBY" ||
        room.modeRuntime.state.phase === "RESULT"
      );
  }
}

export class GameService {
  readonly rooms = new Map<string, Room>();
  readonly sessions = new SessionStore();
  readonly replayService: ReplayService;
  readonly #registry: GameModeRegistry;
  readonly #captureGrants = new CaptureGrantService();
  readonly #passCoordinator = new PassCoordinator();
  readonly #chatWindows = new Map<string, number[]>();
  readonly #avatarWindows = new Map<string, number[]>();
  readonly #referenceUploadWindows = new Map<string, number[]>();
  readonly #options: GameServiceOptions;
  readonly #now: () => number;
  readonly #randomIndex: (maximum: number) => number;
  readonly #hostControlKey: string | null;
  #initialization: Promise<void> | null = null;

  constructor(options: GameServiceOptions) {
    this.#options = options;
    this.#now = options.now ?? Date.now;
    this.#randomIndex = options.randomIndex ?? randomInt;
    this.#hostControlKey = options.hostControlKey ?? null;
    this.replayService =
      options.replayService ?? new ReplayService(options.replayConfig);
    this.#registry = new GameModeRegistry(
      {
        reconnectGraceMs: options.reconnectGraceMs,
        turnResultMs: options.turnResultMs
      },
      this.replayService
    );
  }

  static fromConfig(
    config: ServerConfig,
    hostOptions: Pick<
      GameServiceOptions,
      "hostControlKey" | "replayConfig" | "replayService"
    > = {}
  ): GameService {
    return new GameService({
      roomIdleTtlMs: config.roomIdleTtlMs,
      reconnectGraceMs: config.reconnectGraceMs,
      desktopSessionTtlMs: config.desktopSessionTtlMs,
      turnResultMs: config.turnResultMs,
      ...hostOptions
    });
  }

  initialize(): Promise<void> {
    this.#initialization ??= this.replayService.initialize();
    return this.#initialization;
  }

  async createRoom(
    nicknameInput: string,
    password: string,
    sessionKind: PlayerSession["kind"] = "browser"
  ): Promise<RoomJoinResult> {
    const nickname = this.#tagNickname(this.#validateNickname(nicknameInput), []);
    let roomCode = randomRoomCode();
    while (this.rooms.has(roomCode)) {
      roomCode = randomRoomCode();
    }
    const now = this.#now();
    const player = this.#createPlayer(nickname, now);
    const room: Room = {
      roomCode,
      password: await hashPassword(password),
      hostId: player.id,
      players: new Map([[player.id, player]]),
      chat: [],
      lastActivityAt: now,
      modeSessionId: randomId(16),
      modeRuntime: this.#registry.createRuntime("classic"),
      modePreferences: this.#registry.createDefaultPreferences(),
      modeScheduler: new ModeScheduler({ now: this.#now }),
      runControl: { status: "idle" },
      nextCaptureSessionId: 0,
      nextLogicalTurnId: 0,
      processedCommandIds: new Map(),
      modeTransitioning: false,
      lastReplayJobId: null,
      hostGraceTimer: null,
      drawerGraceTimers: new Map()
    };
    this.rooms.set(roomCode, room);
    const issued = this.sessions.issue(
      roomCode,
      player.id,
      now,
      sessionKind,
      sessionKind === "desktop" ? this.#options.desktopSessionTtlMs : undefined
    );
    return {
      sessionToken: issued.token,
      sessionExpiresAt: issued.session.expiresAt,
      snapshot: this.snapshot(room, player.id)
    };
  }

  async joinRoom(
    roomCodeInput: string,
    nicknameInput: string,
    password: string,
    sessionKind: PlayerSession["kind"] = "browser"
  ): Promise<RoomJoinResult> {
    const room = this.#requireRoom(roomCodeInput.toUpperCase());
    if (room.modeRuntime.state.phase !== "LOBBY" || room.modeTransitioning) {
      throw new GameError(ErrorCode.INVALID_STATE, "游戏已经开始，暂时不能加入", 409);
    }
    if (!(await verifyPassword(password, room.password))) {
      throw new GameError(ErrorCode.UNAUTHORIZED, "房间密码错误", 401);
    }
    const nickname = this.#tagNickname(
      this.#validateNickname(nicknameInput),
      room.players.values()
    );
    const now = this.#now();
    const player = this.#createPlayer(nickname, now);
    room.players.set(player.id, player);
    room.lastActivityAt = now;
    const issued = this.sessions.issue(
      room.roomCode,
      player.id,
      now,
      sessionKind,
      sessionKind === "desktop" ? this.#options.desktopSessionTtlMs : undefined
    );
    this.broadcastSnapshots(room);
    return {
      sessionToken: issued.token,
      sessionExpiresAt: issued.session.expiresAt,
      snapshot: this.snapshot(room, player.id)
    };
  }

  resumeSession(token: string, expectedKind?: PlayerSession["kind"]): RoomAccess {
    const session = this.sessions.verify(token, this.#now());
    if (!session || (expectedKind && session.kind !== expectedKind)) {
      throw new GameError(ErrorCode.UNAUTHORIZED, "会话已失效", 401);
    }
    const room = this.rooms.get(session.roomCode);
    const player = room?.players.get(session.playerId);
    if (!room || !player) {
      throw new GameError(ErrorCode.UNAUTHORIZED, "房间会话已失效", 401);
    }
    return { room, player, session };
  }

  snapshot(room: Room, selfPlayerId: string): PublicRoomSnapshot {
    this.#normalizeRunControl(room);
    const context = this.#context(room);
    const controller = this.#registry.controller(room.modeRuntime.mode);
    return {
      roomCode: room.roomCode,
      hostId: room.hostId,
      selfPlayerId,
      modeSessionId: room.modeSessionId,
      players: [...room.players.values()]
        .sort(
          (left, right) =>
            left.joinedAt - right.joinedAt || left.id.localeCompare(right.id)
        )
        .map((player) => ({
          id: player.id,
          nickname: player.nickname,
          isHost: player.id === room.hostId,
          connected: this.#isOpen(player.socket),
          clientKind: player.clientKind,
          captureReady: this.#isCaptureReady(player),
          avatarRevision: player.avatar?.revision ?? null,
          joinedAt: player.joinedAt
        })),
      chat: room.chat.map((entry) => ({ ...entry })),
      serverNow: this.#now(),
      runControl: structuredClone(room.runControl),
      replayCapability: structuredClone(
        this.replayService.capabilityService.capability
      ),
      passableActors: controller.passableActors(context, selfPlayerId),
      game: controller.publicStateFor(context, selfPlayerId)
    };
  }

  connectPlayer(
    access: RoomAccess,
    socket: GameSocket,
    clientKind: PlayerSession["kind"] = access.session.kind
  ): void {
    const { room, player } = access;
    if (
      this.rooms.get(room.roomCode) !== room ||
      room.players.get(player.id) !== player ||
      access.session.kind !== clientKind
    ) {
      throw new GameError(ErrorCode.FORBIDDEN, "会话与连接类型不匹配", 403);
    }
    if (player.socket !== socket) {
      const previousSocket = player.socket;
      const previousGrant = player.uploadGrant;
      if (previousSocket && this.#isOpen(previousSocket)) {
        if (previousGrant) {
          this.#send(previousSocket, {
            type: "capture:stop",
            captureSessionId: previousGrant.captureSessionId,
            reason: "connection-replaced"
          });
        }
        previousSocket.close(4001, "已在另一连接重连");
      }
      this.#clearPlayerFrameDrain(player);
      player.captureReady = false;
      player.uploadGrant = null;
      player.lastFrameAt = null;
    }
    player.socket = socket;
    player.clientKind = clientKind;
    room.lastActivityAt = this.#now();
    this.#send(socket, {
      type: "room:snapshot",
      snapshot: this.snapshot(room, player.id)
    });
    const controller = this.#registry.controller(room.modeRuntime.mode);
    controller.onPlayerConnectionChanged(this.#context(room), player.id);
    const latestFrame = controller.latestFrameForViewer(this.#context(room), player.id);
    if (latestFrame) {
      this.#deliverLatestFrame(
        player,
        encodeViewerFrame(
          latestFrame.captureSessionId,
          latestFrame.sequence,
          latestFrame.bytes
        )
      );
    }
    this.#updateHostGrace(room);
    this.broadcastSnapshots(room);
  }

  disconnectPlayer(roomCode: string, playerId: string, socket: GameSocket): void {
    const room = this.rooms.get(roomCode);
    const player = room?.players.get(playerId);
    if (!room || !player || player.socket !== socket) {
      return;
    }
    this.#clearPlayerFrameDrain(player);
    player.socket = null;
    player.clientKind = null;
    player.captureReady = false;
    player.uploadGrant = null;
    player.lastFrameAt = null;
    room.lastActivityAt = this.#now();
    this.#registry
      .controller(room.modeRuntime.mode)
      .onPlayerConnectionChanged(this.#context(room), playerId);
    this.#updateHostGrace(room);
    this.broadcastSnapshots(room);
  }

  setCaptureReady(
    roomCode: string,
    playerId: string,
    socket: GameSocket,
    ready: boolean,
    reason?: string
  ): void {
    const room = this.#requireRoom(roomCode);
    const player = this.#requirePlayer(room, playerId);
    if (
      player.socket !== socket ||
      player.clientKind !== "desktop" ||
      !this.#isOpen(socket)
    ) {
      throw new GameError(
        ErrorCode.FORBIDDEN,
        "只有当前已认证桌面连接可以更新采集状态",
        403
      );
    }
    player.captureReady = ready;
    player.lastFrameAt = null;
    room.lastActivityAt = this.#now();
    if (!ready) {
      this.#revokeCapture(
        room,
        playerId,
        "permission-revoked",
        true,
        reason === "user-stopped" ? "user-stopped" : "source-unavailable"
      );
    }
    this.#send(socket, {
      type: "capture:status",
      ready,
      ...(reason ? { reason } : {})
    });
    this.#registry
      .controller(room.modeRuntime.mode)
      .onPlayerConnectionChanged(this.#context(room), playerId);
    this.broadcastSnapshots(room);
  }

  async handleClientMessage(
    access: RoomAccess,
    socket: GameSocket,
    message: ClientJsonMessage
  ): Promise<void> {
    const { room, player } = access;
    if (
      this.rooms.get(room.roomCode) !== room ||
      room.players.get(player.id) !== player ||
      player.socket !== socket ||
      !this.#isOpen(socket)
    ) {
      throw new GameError(ErrorCode.UNAUTHORIZED, "连接会话已失效", 401);
    }
    if (message.type === "room:sync") {
      this.connectPlayer(access, socket, access.session.kind);
      return;
    }
    if (message.type === "ping") {
      this.#send(socket, {
        type: "pong",
        timestamp: message.timestamp,
        serverNow: this.#now()
      });
      return;
    }
    if (message.type === "frame:ack") {
      return;
    }
    if (message.type === "capture:ready") {
      if (room.runControl.status === "paused") {
        throw new GameError(ErrorCode.INVALID_STATE, "游戏已暂停", 409);
      }
      if (access.session.kind !== "desktop") {
        throw new GameError(ErrorCode.FORBIDDEN, "浏览器连接不能声明采集能力", 403);
      }
      this.setCaptureReady(
        room.roomCode,
        player.id,
        socket,
        message.ready,
        message.reason
      );
      return;
    }

    const commandId = "commandId" in message ? message.commandId : null;
    const commandKey = commandId ? `${player.id}:${commandId}` : null;
    if (commandKey && room.processedCommandIds.has(commandKey)) {
      return;
    }
    if (commandKey) {
      room.processedCommandIds.set(commandKey, this.#now());
      this.#pruneProcessedCommands(room);
    }
    try {
      await this.#dispatchCommand(room, player.id, message);
      room.lastActivityAt = this.#now();
      this.#normalizeRunControl(room);
    } catch (error) {
      if (commandKey) {
        room.processedCommandIds.delete(commandKey);
      }
      throw error;
    }
  }

  updateWordPool(roomCode: string, playerId: string, upload: WordPoolUpload) {
    const room = this.#requireRoom(roomCode);
    this.#requireHost(room, playerId);
    const context = this.#context(room);
    let summary;
    if (room.modeRuntime.mode === "classic") {
      summary = this.#registry.classic.updateWordPool(context, upload);
    } else if (room.modeRuntime.mode === "draw-relay") {
      summary = this.#registry.drawRelay.updateWordPool(context, upload);
    } else {
      throw new GameError(ErrorCode.INVALID_STATE, "参考图临摹模式不使用词库", 409);
    }
    this.broadcastSnapshots(room);
    return summary;
  }

  updateAvatar(roomCode: string, playerId: string, bytes: Uint8Array): RoomAvatar {
    const room = this.#requireRoom(roomCode);
    const player = this.#requirePlayer(room, playerId);
    if (
      !this.#acceptWindow(
        this.#avatarWindows,
        roomCode,
        playerId,
        AVATAR_RATE_LIMIT,
        AVATAR_RATE_WINDOW_MS
      )
    ) {
      throw new GameError(ErrorCode.RATE_LIMITED, "头像更新太频繁，请稍后再试", 429);
    }
    try {
      player.avatar = validateRoomAvatar(bytes);
    } catch (error) {
      throw new GameError(
        ErrorCode.BAD_MESSAGE,
        error instanceof Error ? error.message : "头像格式无效"
      );
    }
    room.lastActivityAt = this.#now();
    this.broadcastSnapshots(room);
    return player.avatar;
  }

  deleteAvatar(roomCode: string, playerId: string): void {
    const room = this.#requireRoom(roomCode);
    const player = this.#requirePlayer(room, playerId);
    player.avatar = null;
    room.lastActivityAt = this.#now();
    this.broadcastSnapshots(room);
  }

  avatar(
    roomCode: string,
    requesterId: string,
    playerId: string,
    revision: string
  ): RoomAvatar {
    const room = this.#requireRoom(roomCode);
    this.#requirePlayer(room, requesterId);
    const avatar = this.#requirePlayer(room, playerId).avatar;
    if (!avatar || avatar.revision !== revision) {
      throw new GameError(ErrorCode.NOT_FOUND, "头像版本不存在", 404);
    }
    return avatar;
  }

  async setReference(
    roomCode: string,
    playerId: string,
    bytes: Uint8Array,
    declaredMimeType: string
  ): Promise<ReferenceAsset> {
    const room = this.#requireRoom(roomCode);
    this.#requireHost(room, playerId);
    if (room.modeRuntime.mode !== "reference-copy") {
      throw new GameError(ErrorCode.INVALID_STATE, "当前不是参考图临摹模式", 409);
    }
    if (room.modeRuntime.state.phase !== "LOBBY") {
      throw new GameError(ErrorCode.INVALID_STATE, "只能在临摹大厅设置参考图", 409);
    }
    if (
      !this.#acceptWindow(
        this.#referenceUploadWindows,
        roomCode,
        playerId,
        REFERENCE_UPLOAD_RATE_LIMIT,
        REFERENCE_UPLOAD_RATE_WINDOW_MS
      )
    ) {
      throw new GameError(ErrorCode.RATE_LIMITED, "参考图上传太频繁，请稍后再试", 429);
    }
    let asset: ReferenceAsset;
    try {
      asset = await normalizeReferenceAsset(bytes, declaredMimeType);
    } catch (error) {
      throw new GameError(
        ErrorCode.BAD_MESSAGE,
        error instanceof Error ? error.message : "参考图无效"
      );
    }
    this.#registry.referenceCopy.setReference(this.#context(room), asset);
    room.lastActivityAt = this.#now();
    this.broadcastSnapshots(room);
    return asset;
  }

  deleteReference(roomCode: string, playerId: string): void {
    const room = this.#requireRoom(roomCode);
    this.#requireHost(room, playerId);
    this.#registry.referenceCopy.deleteReference(this.#context(room));
    room.lastActivityAt = this.#now();
    this.broadcastSnapshots(room);
  }

  referenceAsset(roomCode: string, viewerId: string, revision: string): ReferenceAsset {
    const room = this.#requireRoom(roomCode);
    this.#requirePlayer(room, viewerId);
    return this.#registry.referenceCopy.referenceAsset(
      this.#context(room),
      viewerId,
      revision
    );
  }

  referenceBallotAsset(
    roomCode: string,
    viewerId: string,
    ballotId: string,
    ballotItemId: string
  ) {
    const room = this.#requireRoom(roomCode);
    this.#requirePlayer(room, viewerId);
    return this.#registry.referenceCopy.ballotAsset(
      this.#context(room),
      viewerId,
      ballotId,
      ballotItemId
    );
  }

  referenceGalleryAsset(
    roomCode: string,
    viewerId: string,
    resultId: string,
    resultItemId: string
  ) {
    const room = this.#requireRoom(roomCode);
    this.#requirePlayer(room, viewerId);
    return this.#registry.referenceCopy.galleryAsset(
      this.#context(room),
      resultId,
      resultItemId
    );
  }

  relayPrivateTask(roomCode: string, viewerId: string) {
    const room = this.#requireRoom(roomCode);
    this.#requirePlayer(room, viewerId);
    return this.#registry.drawRelay.privateTask(this.#context(room), viewerId);
  }

  relayActiveArtifact(
    roomCode: string,
    viewerId: string,
    artifactId: string,
    revision: string
  ) {
    const room = this.#requireRoom(roomCode);
    this.#requirePlayer(room, viewerId);
    return this.#registry.drawRelay.activeArtifact(
      this.#context(room),
      viewerId,
      artifactId,
      revision
    );
  }

  relayResultArtifact(
    roomCode: string,
    viewerId: string,
    resultId: string,
    resultArtifactId: string
  ) {
    const room = this.#requireRoom(roomCode);
    this.#requirePlayer(room, viewerId);
    return this.#registry.drawRelay.resultArtifact(
      this.#context(room),
      resultId,
      resultArtifactId
    );
  }

  handleDesktopFrame(
    access: RoomAccess,
    socket: GameSocket,
    packet: Uint8Array
  ): FrameAcceptance {
    const { room, player } = access;
    if (
      packet.byteLength < 5 ||
      player.socket !== socket ||
      player.clientKind !== "desktop" ||
      !this.#isOpen(socket) ||
      room.modeTransitioning ||
      room.runControl.status === "paused"
    ) {
      return { accepted: false, reason: "UPLOAD_NOT_AUTHORIZED" };
    }
    let decoded;
    try {
      decoded = decodeUploadFrame(packet);
    } catch {
      return { accepted: false, reason: "INVALID_FRAME_PACKET" };
    }
    if (!decoded.mimeType) {
      return { accepted: false, reason: "INVALID_IMAGE" };
    }
    const now = this.#now();
    if (
      !this.#captureGrants.validates(player.uploadGrant, {
        roomCode: room.roomCode,
        playerId: player.id,
        socketIdentity: socket,
        mode: room.modeRuntime.mode,
        modeSessionId: room.modeSessionId,
        captureSessionId: decoded.captureSessionId,
        now
      })
    ) {
      return { accepted: false, reason: "UPLOAD_NOT_AUTHORIZED" };
    }
    if (
      player.lastFrameAt !== null &&
      now - player.lastFrameAt < MIN_FRAME_INTERVAL_MS
    ) {
      return { accepted: false, reason: "FRAME_RATE_LIMITED" };
    }
    const accepted = this.#registry
      .controller(room.modeRuntime.mode)
      .handleAcceptedFrame(
        this.#context(room),
        player.id,
        decoded.captureSessionId,
        decoded.mimeType,
        decoded.imageBytes
      );
    if (!accepted) {
      return { accepted: false, reason: "FRAME_NOT_ACCEPTED" };
    }
    player.lastFrameAt = now;
    room.lastActivityAt = now;
    const viewerPacket = encodeViewerFrame(
      accepted.frame.captureSessionId,
      accepted.frame.sequence,
      accepted.frame.bytes
    );
    const audience =
      accepted.audience === "room" ? [...room.players.values()] : [player];
    for (const target of audience) {
      this.#deliverLatestFrame(target, viewerPacket);
    }
    return { accepted: true, sequence: accepted.frame.sequence };
  }

  async changePasswordFromEmbeddedHost(
    hostControlKey: string,
    roomCode: string,
    password: string
  ): Promise<void> {
    this.#requireHostControl(hostControlKey);
    const room = this.#requireRoom(roomCode);
    if (password.length < 4 || password.length > 128) {
      throw new GameError(ErrorCode.BAD_MESSAGE, "房间密码必须为 4 到 128 个字符");
    }
    room.password = await hashPassword(password);
    room.lastActivityAt = this.#now();
    this.#appendChat(room, {
      kind: "system",
      playerId: null,
      nickname: null,
      text: "实际主机已更新房间密码"
    });
    this.broadcastSnapshots(room);
  }

  pauseFromEmbeddedHost(hostControlKey: string, roomCode: string): void {
    this.#requireHostControl(hostControlKey);
    const room = this.#requireRoom(roomCode);
    if (room.runControl.status === "paused") {
      return;
    }
    if (room.runControl.status !== "running" || modeIsTerminal(room)) {
      throw new GameError(ErrorCode.INVALID_STATE, "当前没有可暂停的游戏计时", 409);
    }
    const at = this.#now();
    const controller = this.#registry.controller(room.modeRuntime.mode);
    room.modeScheduler.pauseAll(at);
    controller.pause(this.#context(room), at);
    room.runControl = {
      status: "paused",
      pausedAt: at,
      pausedBy: "server-host",
      phaseAtPause: room.modeRuntime.state.phase
    };
    for (const player of room.players.values()) {
      this.#revokeCapture(room, player.id, "paused", false);
    }
    this.#appendChat(room, {
      kind: "system",
      playerId: null,
      nickname: null,
      text: "实际主机已暂停游戏"
    });
    this.broadcastSnapshots(room);
  }

  resumeFromEmbeddedHost(hostControlKey: string, roomCode: string): void {
    this.#requireHostControl(hostControlKey);
    const room = this.#requireRoom(roomCode);
    if (room.runControl.status === "running") {
      return;
    }
    if (room.runControl.status !== "paused") {
      throw new GameError(ErrorCode.INVALID_STATE, "当前游戏未暂停", 409);
    }
    const now = this.#now();
    const pausedDurationMs = Math.max(0, now - room.runControl.pausedAt);
    const controller = this.#registry.controller(room.modeRuntime.mode);
    const captureDelayMs = controller.requiresCaptureOnResume(this.#context(room))
      ? RESUME_CAPTURE_DELAY_MS
      : 0;
    room.runControl = {
      status: "running",
      resumedAt: now,
      captureResumesAt: captureDelayMs > 0 ? now + captureDelayMs : null
    };
    room.modeScheduler.resumeAll(now, captureDelayMs);
    controller.resume(this.#context(room), pausedDurationMs, captureDelayMs);
    this.#appendChat(room, {
      kind: "system",
      playerId: null,
      nickname: null,
      text: captureDelayMs > 0 ? "游戏已恢复，采集将在 3 秒后继续" : "游戏已恢复"
    });
    this.broadcastSnapshots(room);
  }

  async revalidateReplayFromEmbeddedHost(
    hostControlKey: string,
    config?: ReplayHostConfig
  ): Promise<ReplayHostCapability> {
    this.#requireHostControl(hostControlKey);
    if (config) {
      this.replayService.configure(config);
    }
    const capability = await this.replayService.capabilityService.revalidate();
    for (const room of this.rooms.values()) {
      if (
        room.modeRuntime.mode === "draw-relay" &&
        room.modeRuntime.state.phase === "LOBBY"
      ) {
        room.modeRuntime.state.replay = capability.available
          ? { status: "idle" }
          : { status: "unavailable", message: capability.message };
        this.broadcastSnapshots(room);
      }
    }
    return capability;
  }

  async retryReplayFromEmbeddedHost(
    hostControlKey: string,
    roomCode: string
  ): Promise<ReplaySavedFile> {
    this.#requireHostControl(hostControlKey);
    const room = this.#requireRoom(roomCode);
    const jobId =
      room.modeRuntime.mode === "draw-relay"
        ? (room.modeRuntime.state.replayJobId ?? room.lastReplayJobId)
        : room.lastReplayJobId;
    if (!jobId) {
      throw new GameError(ErrorCode.NOT_FOUND, "接龙回放任务不存在", 404);
    }
    if (room.modeRuntime.mode === "draw-relay") {
      room.modeRuntime.state.replay = { status: "encoding", progress: null };
      this.broadcastSnapshots(room);
    }
    try {
      const result = await this.replayService.retry(jobId);
      if (room.modeRuntime.mode === "draw-relay") {
        room.modeRuntime.state.replay = this.replayService.status(jobId);
        this.broadcastSnapshots(room);
      }
      return result;
    } catch (error) {
      if (room.modeRuntime.mode === "draw-relay") {
        room.modeRuntime.state.replay = {
          status: "failed",
          message: error instanceof Error ? error.message : "回放重试失败",
          canRetry: true
        };
        this.broadcastSnapshots(room);
      }
      throw error;
    }
  }

  savedReplayFromEmbeddedHost(
    hostControlKey: string,
    roomCode: string
  ): ReplaySavedFile | null {
    this.#requireHostControl(hostControlKey);
    const room = this.#requireRoom(roomCode);
    const jobId =
      room.modeRuntime.mode === "draw-relay"
        ? (room.modeRuntime.state.replayJobId ?? room.lastReplayJobId)
        : room.lastReplayJobId;
    return jobId ? this.replayService.savedFile(jobId) : null;
  }

  broadcastSnapshots(room: Room): void {
    this.#normalizeRunControl(room);
    for (const player of room.players.values()) {
      if (this.#isOpen(player.socket)) {
        this.#send(player.socket, {
          type: "room:snapshot",
          snapshot: this.snapshot(room, player.id)
        });
      }
    }
  }

  sendError(socket: GameSocket, error: unknown): void {
    const gameError =
      error instanceof GameError
        ? error
        : new GameError(ErrorCode.INTERNAL_ERROR, "服务器处理失败", 500);
    this.#send(socket, {
      type: "error",
      code: gameError.code,
      message: gameError.message
    });
  }

  cleanupInactive(now = this.#now()): string[] {
    const removed: string[] = [];
    this.sessions.cleanup(now);
    for (const room of this.rooms.values()) {
      const anyoneConnected = [...room.players.values()].some((player) =>
        this.#isOpen(player.socket)
      );
      if (
        !anyoneConnected &&
        now - room.lastActivityAt >= this.#options.roomIdleTtlMs
      ) {
        removed.push(room.roomCode);
        this.destroyRoom(room.roomCode);
      }
    }
    return removed;
  }

  destroyRoom(roomCode: string): void {
    const room = this.rooms.get(roomCode);
    if (!room) {
      return;
    }
    const context = this.#context(room);
    this.#registry.controller(room.modeRuntime.mode).dispose(context, "room-destroyed");
    room.modeScheduler.cancelAll();
    if (room.hostGraceTimer) {
      clearTimeout(room.hostGraceTimer);
      room.hostGraceTimer = null;
    }
    for (const timer of room.drawerGraceTimers.values()) {
      clearTimeout(timer);
    }
    room.drawerGraceTimers.clear();
    for (const player of room.players.values()) {
      this.#clearPlayerFrameDrain(player);
      player.captureReady = false;
      player.uploadGrant = null;
      player.avatar = null;
      if (this.#isOpen(player.socket)) {
        this.#send(player.socket, {
          type: "capture:stop",
          captureSessionId: 0,
          reason: "server-shutdown"
        });
        player.socket.close(4004, "房间已清理");
      }
    }
    this.sessions.removeRoom(roomCode);
    this.rooms.delete(roomCode);
    for (const windows of [
      this.#chatWindows,
      this.#avatarWindows,
      this.#referenceUploadWindows
    ]) {
      for (const key of windows.keys()) {
        if (key.startsWith(`${roomCode}:`)) {
          windows.delete(key);
        }
      }
    }
  }

  async shutdown(): Promise<void> {
    for (const roomCode of [...this.rooms.keys()]) {
      this.destroyRoom(roomCode);
    }
    this.#chatWindows.clear();
    this.#avatarWindows.clear();
    this.#referenceUploadWindows.clear();
    await this.replayService.shutdown();
  }

  async #dispatchCommand(
    room: Room,
    playerId: string,
    message: ClientJsonMessage
  ): Promise<void> {
    if (room.modeTransitioning && message.type !== "room:switch-mode") {
      throw new GameError(ErrorCode.INVALID_STATE, "模式正在切换，请稍后重试", 409);
    }
    const controller = this.#registry.controller(room.modeRuntime.mode);
    const context = this.#context(room);
    if (message.type === "room:switch-mode") {
      await this.#switchMode(room, playerId, message);
      return;
    }
    if (
      room.runControl.status === "paused" &&
      !(message.type === "turn:pass" && room.hostId === playerId)
    ) {
      throw new GameError(ErrorCode.INVALID_STATE, "游戏已暂停", 409);
    }
    switch (message.type) {
      case "mode:settings":
        this.#requireHost(room, playerId);
        if (message.value.mode !== room.modeRuntime.mode) {
          throw new GameError(ErrorCode.INVALID_STATE, "设置不属于当前模式", 409);
        }
        controller.updateSettings(context, message.value.settings);
        this.broadcastSnapshots(room);
        return;
      case "game:start":
        this.#requireHost(room, playerId);
        if (room.runControl.status !== "idle") {
          throw new GameError(ErrorCode.INVALID_STATE, "游戏已经开始", 409);
        }
        room.runControl = {
          status: "running",
          resumedAt: null,
          captureResumesAt: null
        };
        try {
          await controller.start(context);
        } catch (error) {
          room.runControl = { status: "idle" };
          throw error;
        }
        this.broadcastSnapshots(room);
        return;
      case "game:return-lobby":
        this.#requireHost(room, playerId);
        await controller.returnToLobby(context);
        room.runControl = { status: "idle" };
        this.broadcastSnapshots(room);
        return;
      case "turn:pass":
        await this.#passCoordinator.execute(context, controller, playerId, message);
        this.#normalizeRunControl(room);
        this.broadcastSnapshots(room);
        return;
      case "chat:submit":
        if (
          !this.#acceptWindow(
            this.#chatWindows,
            room.roomCode,
            playerId,
            CHAT_RATE_LIMIT,
            CHAT_RATE_WINDOW_MS
          )
        ) {
          throw new GameError(ErrorCode.RATE_LIMITED, "发送太快，请稍后再试", 429);
        }
        if (await controller.handleCommand(context, playerId, message)) {
          return;
        }
        this.#appendChat(room, {
          kind: "chat",
          playerId,
          nickname: this.#requirePlayer(room, playerId).nickname,
          text: message.text
        });
        return;
      default:
        if (await controller.handleCommand(context, playerId, message)) {
          this.#normalizeRunControl(room);
          return;
        }
        throw new GameError(ErrorCode.BAD_MESSAGE, "当前模式不支持这个命令");
    }
  }

  async #switchMode(
    room: Room,
    playerId: string,
    message: Extract<ClientJsonMessage, { type: "room:switch-mode" }>
  ): Promise<void> {
    this.#requireHost(room, playerId);
    if (message.modeSessionId !== room.modeSessionId) {
      throw new GameError(ErrorCode.INVALID_STATE, "模式切换请求已失效", 409);
    }
    if (message.targetMode === room.modeRuntime.mode) {
      return;
    }
    if (message.targetMode === "draw-relay") {
      const capability = await this.replayService.capabilityService.revalidate();
      if (!capability.available) {
        throw new GameError(ErrorCode.CAPABILITY_UNAVAILABLE, capability.message, 409);
      }
    }
    if (room.modeTransitioning) {
      return;
    }
    if (
      room.modeRuntime.mode === "draw-relay" &&
      room.modeRuntime.state.replayJobId &&
      room.modeRuntime.state.phase !== "RESULT" &&
      !message.partialReplay
    ) {
      throw new GameError(
        ErrorCode.INVALID_STATE,
        "请先选择保存部分回放或丢弃本次录制",
        409
      );
    }
    room.modeTransitioning = true;
    const oldMode = room.modeRuntime.mode;
    const oldController = this.#registry.controller(oldMode);
    const context = this.#context(room);
    try {
      const at = this.#now();
      if (room.runControl.status === "running") {
        room.modeScheduler.pauseAll(at);
        oldController.pause(context, at);
      }
      for (const player of room.players.values()) {
        this.#revokeCapture(room, player.id, "mode-switched", true);
      }
      if (
        oldMode === "draw-relay" &&
        room.modeRuntime.mode === "draw-relay" &&
        room.modeRuntime.state.replayJobId &&
        room.modeRuntime.state.phase !== "RESULT" &&
        message.partialReplay
      ) {
        await this.#registry.drawRelay.handlePartialReplay(
          context,
          message.partialReplay
        );
      }
      oldController.dispose(context, "mode-switch");
      this.#registry.rememberPreferences(room.modeRuntime, room.modePreferences);
      room.modeScheduler.cancelAll();
      room.modeSessionId = randomId(16);
      room.modeRuntime = this.#registry.createRuntime(
        message.targetMode,
        room.modePreferences
      );
      room.runControl = { status: "idle" };
      room.nextCaptureSessionId = 0;
      room.nextLogicalTurnId = 0;
      room.chat = [];
      this.#appendChat(room, {
        kind: "system",
        playerId: null,
        nickname: null,
        text: `房主已切换到${this.#modeLabel(message.targetMode)}`
      });
    } finally {
      room.modeTransitioning = false;
    }
    this.broadcastSnapshots(room);
  }

  #context(room: Room): ModeContext {
    return {
      room,
      now: this.#now,
      randomId,
      randomIndex: this.#randomIndex,
      allocateCaptureSessionId: () => {
        room.nextCaptureSessionId = (room.nextCaptureSessionId + 1) >>> 0;
        if (room.nextCaptureSessionId === 0) {
          room.nextCaptureSessionId = 1;
        }
        return room.nextCaptureSessionId;
      },
      allocateLogicalTurnId: () => {
        room.nextLogicalTurnId = (room.nextLogicalTurnId + 1) >>> 0;
        if (room.nextLogicalTurnId === 0) {
          room.nextLogicalTurnId = 1;
        }
        return room.nextLogicalTurnId;
      },
      isOpen: (player) => Boolean(player && this.#isOpen(player.socket)),
      isCaptureReady: (player) => Boolean(player && this.#isCaptureReady(player)),
      sendToPlayer: (playerId, message) => {
        const player = room.players.get(playerId);
        if (player && this.#isOpen(player.socket)) {
          this.#send(player.socket, message);
        }
      },
      broadcast: (message) => this.#broadcast(room, message),
      broadcastSnapshots: () => this.broadcastSnapshots(room),
      issueCapture: (input) => this.#issueCapture(room, input),
      revokeCapture: (playerId, reason, releaseSource) =>
        this.#revokeCapture(room, playerId, reason, releaseSource ?? false),
      appendChat: (entry) => this.#appendChat(room, entry)
    };
  }

  #issueCapture(
    room: Room,
    input: {
      playerId: string;
      actorStepId: string;
      captureSessionId: number;
      stage: "drawing" | "finalizing";
      expiresAt: number;
    }
  ): boolean {
    const player = room.players.get(input.playerId);
    const socket = player?.socket;
    if (
      room.runControl.status === "paused" ||
      room.modeTransitioning ||
      !player ||
      !socket ||
      !this.#isCaptureReady(player) ||
      input.expiresAt <= this.#now()
    ) {
      return false;
    }
    if (
      player.uploadGrant &&
      player.uploadGrant.captureSessionId !== input.captureSessionId
    ) {
      this.#revokeCapture(room, player.id, "session-replaced", false);
    }
    player.uploadGrant = this.#captureGrants.issue({
      roomCode: room.roomCode,
      playerId: player.id,
      socketIdentity: socket,
      mode: room.modeRuntime.mode,
      modeSessionId: room.modeSessionId,
      actorStepId: input.actorStepId,
      captureSessionId: input.captureSessionId,
      stage: input.stage,
      expiresAt: input.expiresAt
    });
    player.lastFrameAt = null;
    this.#send(socket, {
      type: "capture:start",
      modeSessionId: room.modeSessionId,
      actorStepId: input.actorStepId,
      captureSessionId: input.captureSessionId,
      stage: input.stage,
      intervalMs: MIN_FRAME_INTERVAL_MS
    });
    return true;
  }

  #revokeCapture(
    room: Room,
    playerId: string,
    reason:
      | "session-replaced"
      | "paused"
      | "finalized"
      | "mode-switched"
      | "permission-revoked",
    releaseSource: boolean,
    releaseReason?:
      | "turn-ended"
      | "source-unavailable"
      | "permission-revoked"
      | "connection-replaced"
      | "user-stopped"
      | "mode-switched"
      | "server-shutdown"
  ): void {
    const player = room.players.get(playerId);
    if (!player) {
      return;
    }
    const captureSessionId = player.uploadGrant?.captureSessionId;
    player.uploadGrant = null;
    player.lastFrameAt = null;
    this.#clearPlayerFrameDrain(player);
    if (captureSessionId === undefined || !this.#isOpen(player.socket)) {
      return;
    }
    if (!releaseSource) {
      this.#send(player.socket, {
        type: "capture:stop-upload",
        captureSessionId,
        reason
      });
      return;
    }
    this.#send(player.socket, {
      type: "capture:stop",
      captureSessionId,
      reason:
        releaseReason ??
        (reason === "mode-switched"
          ? "mode-switched"
          : reason === "permission-revoked"
            ? "permission-revoked"
            : "turn-ended")
    });
  }

  #appendChat(
    room: Room,
    entry: {
      kind: "chat" | "correct" | "system";
      playerId: string | null;
      nickname: string | null;
      text: string;
    }
  ): void {
    const value: PublicChatEntry = {
      id: randomId(10),
      ...entry,
      createdAt: this.#now()
    };
    room.chat.push(value);
    if (room.chat.length > MAX_CHAT_HISTORY) {
      room.chat.splice(0, room.chat.length - MAX_CHAT_HISTORY);
    }
    room.lastActivityAt = this.#now();
    this.#broadcast(room, { type: "chat:message", ...value });
  }

  #deliverLatestFrame(player: Player, packet: Uint8Array): void {
    const socket = player.socket;
    player.pendingFramePacket = packet;
    if (!this.#isOpen(socket)) {
      return;
    }
    if (socket.bufferedAmount <= SLOW_CLIENT_BUFFER_BYTES && !player.frameDrainTimer) {
      const latest = player.pendingFramePacket;
      player.pendingFramePacket = null;
      if (latest) {
        this.#sendFrame(socket, latest);
      }
      return;
    }
    this.#scheduleFrameDrain(player);
  }

  #scheduleFrameDrain(player: Player): void {
    if (player.frameDrainTimer) {
      return;
    }
    player.frameDrainTimer = setTimeout(() => {
      player.frameDrainTimer = null;
      const socket = player.socket;
      if (!this.#isOpen(socket)) {
        player.pendingFramePacket = null;
        return;
      }
      if (socket.bufferedAmount > SLOW_CLIENT_BUFFER_BYTES) {
        this.#scheduleFrameDrain(player);
        return;
      }
      const packet = player.pendingFramePacket;
      player.pendingFramePacket = null;
      if (packet) {
        this.#sendFrame(socket, packet);
      }
    }, MIN_FRAME_INTERVAL_MS);
    player.frameDrainTimer.unref();
  }

  #clearPlayerFrameDrain(player: Player): void {
    if (player.frameDrainTimer) {
      clearTimeout(player.frameDrainTimer);
      player.frameDrainTimer = null;
    }
    player.pendingFramePacket = null;
  }

  #updateHostGrace(room: Room): void {
    const host = room.players.get(room.hostId);
    if (host && this.#isOpen(host.socket)) {
      if (room.hostGraceTimer) {
        clearTimeout(room.hostGraceTimer);
        room.hostGraceTimer = null;
      }
      return;
    }
    if (room.hostGraceTimer) {
      return;
    }
    room.hostGraceTimer = setTimeout(() => {
      room.hostGraceTimer = null;
      const currentHost = room.players.get(room.hostId);
      if (currentHost && this.#isOpen(currentHost.socket)) {
        return;
      }
      const successor = [...room.players.values()]
        .filter((player) => this.#isOpen(player.socket))
        .sort(
          (left, right) =>
            left.joinedAt - right.joinedAt || left.id.localeCompare(right.id)
        )[0];
      if (!successor) {
        return;
      }
      room.hostId = successor.id;
      this.#appendChat(room, {
        kind: "system",
        playerId: null,
        nickname: null,
        text: `${successor.nickname} 已成为新房主`
      });
      this.broadcastSnapshots(room);
    }, this.#options.reconnectGraceMs);
    room.hostGraceTimer.unref();
  }

  #normalizeRunControl(room: Room): void {
    if (modeIsTerminal(room) && room.runControl.status !== "idle") {
      room.runControl = { status: "idle" };
    }
  }

  #pruneProcessedCommands(room: Room): void {
    const threshold = this.#now() - PROCESSED_COMMAND_TTL_MS;
    for (const [key, timestamp] of room.processedCommandIds) {
      if (timestamp < threshold) {
        room.processedCommandIds.delete(key);
      }
    }
    while (room.processedCommandIds.size > MAX_PROCESSED_COMMAND_IDS) {
      const oldest = room.processedCommandIds.keys().next().value;
      if (!oldest) {
        break;
      }
      room.processedCommandIds.delete(oldest);
    }
  }

  #acceptWindow(
    windows: Map<string, number[]>,
    roomCode: string,
    playerId: string,
    limit: number,
    windowMs: number
  ): boolean {
    const now = this.#now();
    const key = `${roomCode}:${playerId}`;
    const recent = (windows.get(key) ?? []).filter(
      (timestamp) => now - timestamp < windowMs
    );
    if (recent.length >= limit) {
      windows.set(key, recent);
      return false;
    }
    recent.push(now);
    windows.set(key, recent);
    return true;
  }

  #createPlayer(nickname: string, joinedAt: number): Player {
    return {
      id: randomId(),
      nickname,
      joinedAt,
      socket: null,
      clientKind: null,
      captureReady: false,
      uploadGrant: null,
      lastFrameAt: null,
      frameDrainTimer: null,
      pendingFramePacket: null,
      avatar: null
    };
  }

  #validateNickname(value: string): string {
    const nickname = sanitizeNickname(value);
    if (!nickname || [...nickname].length > 24) {
      throw new GameError(ErrorCode.BAD_MESSAGE, "昵称格式不正确");
    }
    return nickname;
  }

  #tagNickname(nickname: string, players: Iterable<Player>): string {
    const usedTags = new Set(
      [...players]
        .map((player) => /#(\d{4})$/u.exec(player.nickname)?.[1])
        .filter((tag): tag is string => Boolean(tag))
    );
    if (usedTags.size >= 10_000) {
      throw new GameError(ErrorCode.INVALID_STATE, "房间昵称编号已用完", 409);
    }
    const start = randomInt(10_000);
    for (let offset = 0; offset < 10_000; offset += 1) {
      const tag = String((start + offset) % 10_000).padStart(4, "0");
      if (!usedTags.has(tag)) {
        return `${nickname}#${tag}`;
      }
    }
    throw new GameError(ErrorCode.INVALID_STATE, "房间昵称编号已用完", 409);
  }

  #requireRoom(roomCode: string): Room {
    const room = this.rooms.get(roomCode.toUpperCase());
    if (!room) {
      throw new GameError(ErrorCode.NOT_FOUND, "房间不存在", 404);
    }
    return room;
  }

  #requirePlayer(room: Room, playerId: string): Player {
    const player = room.players.get(playerId);
    if (!player) {
      throw new GameError(ErrorCode.UNAUTHORIZED, "玩家身份无效", 401);
    }
    return player;
  }

  #requireHost(room: Room, playerId: string): void {
    this.#requirePlayer(room, playerId);
    if (room.hostId !== playerId) {
      throw new GameError(ErrorCode.FORBIDDEN, "只有当前房主可以执行此操作", 403);
    }
  }

  #requireHostControl(value: string): void {
    if (!this.#hostControlKey || value !== this.#hostControlKey) {
      throw new GameError(
        ErrorCode.FORBIDDEN,
        "此操作只允许实际内嵌服务器主机执行",
        403
      );
    }
  }

  #isOpen(socket: GameSocket | null | undefined): socket is GameSocket {
    return Boolean(socket && socket.readyState === SOCKET_OPEN);
  }

  #isCaptureReady(player: Player): boolean {
    return (
      player.captureReady &&
      player.clientKind === "desktop" &&
      this.#isOpen(player.socket)
    );
  }

  #broadcast(room: Room, message: ServerMessagePayload): void {
    for (const player of room.players.values()) {
      if (this.#isOpen(player.socket)) {
        this.#send(player.socket, message);
      }
    }
  }

  #send(socket: GameSocket, message: ServerMessagePayload): void {
    if (!this.#isOpen(socket)) {
      return;
    }
    try {
      socket.send(serializeServerMessage(message));
    } catch {
      // The close event owns presence cleanup.
    }
  }

  #sendFrame(socket: GameSocket, packet: Uint8Array): void {
    if (!this.#isOpen(socket)) {
      return;
    }
    try {
      socket.send(packet, { binary: true, compress: false });
    } catch {
      // The close event owns presence cleanup.
    }
  }

  #modeLabel(mode: GameModeId): string {
    switch (mode) {
      case "classic":
        return "经典画猜";
      case "reference-copy":
        return "参考图临摹";
      case "draw-relay":
        return "绘画接龙";
    }
  }
}
