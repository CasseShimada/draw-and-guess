import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type ReactNode
} from "react";

import {
  CONTENT_LIMITS,
  validateNormalizedAvatarPng,
  type LocalAvatar,
  type LocalContentServices,
  type WordPoolUpload
} from "@draw-guess/content";
import {
  PROTOCOL_VERSION,
  ServerJsonMessageSchema,
  decodeViewerFrame,
  type RelayPrivateTask,
  type ServerJsonMessage,
  type WordOption
} from "@draw-guess/protocol";
import type {
  GameModeId,
  PublicRoomSnapshot,
  PublicWordPoolSummary
} from "@draw-guess/shared-types";

import { AvatarEditor } from "./AvatarEditor.js";
import { WordPackManager } from "./WordPackManager.js";
import { createBrowserContentServices } from "./content-store.js";
import { GAME_MODE_LABELS, ModeRenderer } from "./modes/registry.js";
import type { ActualHostControls, GameAsset } from "./modes/types.js";

type ConnectionState = "connecting" | "connected" | "reconnecting" | "offline";

interface ApiErrorBody {
  error?: { message?: string };
}

export type TransportEvent =
  | { kind: "message"; message: ServerJsonMessage }
  | { kind: "frame"; packet: Uint8Array }
  | { kind: "connection"; state: ConnectionState; error?: string };

export interface DesktopGameTransport {
  resume(): Promise<{ snapshot: PublicRoomSnapshot } | null>;
  createRoom(
    nickname: string,
    password: string
  ): Promise<{ snapshot: PublicRoomSnapshot }>;
  joinRoom(
    roomCode: string,
    nickname: string,
    password: string
  ): Promise<{ snapshot: PublicRoomSnapshot }>;
  send(message: object): Promise<void>;
  uploadWordPool(
    roomCode: string,
    wordPool: WordPoolUpload
  ): Promise<{ wordPool: PublicWordPoolSummary }>;
  uploadReference(
    roomCode: string,
    mimeType: "image/png" | "image/jpeg" | "image/webp",
    bytes: Uint8Array
  ): Promise<{
    reference: {
      revision: string;
      mimeType: "image/png" | "image/jpeg" | "image/webp";
      width: number;
      height: number;
      byteLength: number;
    };
  }>;
  deleteReference(roomCode: string): Promise<void>;
  getAsset(roomCode: string, path: string): Promise<GameAsset>;
  getRelayTask(
    roomCode: string,
    actorStepId: string
  ): Promise<{ task: RelayPrivateTask }>;
  uploadAvatar(roomCode: string, bytes: Uint8Array): Promise<{ revision: string }>;
  deleteAvatar(roomCode: string): Promise<void>;
  getAvatar(
    roomCode: string,
    playerId: string,
    revision: string
  ): Promise<Uint8Array | null>;
  onEvent(listener: (event: TransportEvent) => void): () => void;
}

export interface AppProps {
  transport?: DesktopGameTransport;
  hostControls?: ActualHostControls;
  notificationsEnabled?: boolean;
  initialRoomCode?: string;
  lobbyAddon?: ReactNode;
  topbarAddon?: ReactNode;
  onSnapshot?: (snapshot: PublicRoomSnapshot | null) => void;
  onServerMessage?: (message: ServerJsonMessage) => void;
  invitationText?: (roomCode: string) => string;
  contentServices?: LocalContentServices;
}

const COMMAND_TYPES = new Set([
  "game:start",
  "game:return-lobby",
  "room:switch-mode",
  "turn:pass",
  "drawing:finish",
  "classic:word-select",
  "reference:ready",
  "reference:set-like",
  "reference:finish-ballot",
  "relay:recording-consent",
  "relay:task-ready",
  "relay:submit-guess"
]);

const PHASE_LABELS: Record<string, string> = {
  LOBBY: "大厅",
  PREPARING: "准备中",
  COUNTDOWN: "倒计时",
  WORD_SELECTION: "选词",
  DRAWING: "绘画中",
  FINALIZING: "展示收尾",
  GUESSING: "猜词中",
  BLIND_VOTING: "匿名投票",
  TURN_RESULT: "回合结算",
  GAME_RESULT: "最终排名",
  GALLERY: "作品画廊",
  RESULT: "接龙揭晓"
};

const GAME_MODE_DESCRIPTIONS: Record<GameModeId, string> = {
  classic: "轮流画、猜词、计分",
  "reference-copy": "全员同时根据参考图绘制，结束后展示作品",
  "draw-relay": "按随机顺序看图猜词再绘制，结束后回看完整传递过程"
};

function commandId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
}

function formValue(values: FormData, name: string): string {
  const value = values.get(name);
  return typeof value === "string" ? value : "";
}

async function responseError(response: Response, fallback: string): Promise<Error> {
  const body = (await response.json().catch(() => ({}))) as ApiErrorBody;
  return new Error(body.error?.message ?? fallback);
}

async function apiRequest<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...options,
    credentials: "same-origin",
    headers: {
      ...(options?.body ? { "Content-Type": "application/json" } : {}),
      ...options?.headers
    }
  });
  if (!response.ok) {
    throw await responseError(response, "请求失败，请稍后重试");
  }
  return (await response.json()) as T;
}

function websocketUrl(): string {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${window.location.host}/ws?protocolVersion=${String(
    PROTOCOL_VERSION
  )}`;
}

function StatusDot({ state }: { state: ConnectionState }) {
  const labels: Record<ConnectionState, string> = {
    connecting: "正在连接",
    connected: "已连接",
    reconnecting: "正在重连",
    offline: "连接断开"
  };
  return (
    <span className={`connection connection--${state}`} role="status">
      <span className="connection__dot" aria-hidden="true" />
      {labels[state]}
    </span>
  );
}

function Home({
  busy,
  error,
  initialRoomCode,
  avatarControl,
  onCreate,
  onJoin,
  onManageWords
}: {
  busy: boolean;
  error: string | null;
  initialRoomCode?: string;
  avatarControl: ReactNode;
  onCreate: (nickname: string, password: string) => Promise<void>;
  onJoin: (roomCode: string, nickname: string, password: string) => Promise<void>;
  onManageWords: () => void;
}) {
  const requestedRoom =
    initialRoomCode ??
    new URLSearchParams(window.location.search).get("room")?.toUpperCase() ??
    "";
  const [entryMode, setEntryMode] = useState<"create" | "join">(
    requestedRoom ? "join" : "create"
  );

  const submitCreate = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const values = new FormData(event.currentTarget);
    void onCreate(formValue(values, "nickname"), formValue(values, "password"));
  };
  const submitJoin = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const values = new FormData(event.currentTarget);
    void onJoin(
      formValue(values, "roomCode"),
      formValue(values, "nickname"),
      formValue(values, "password")
    );
  };

  return (
    <main className="home-shell" data-ui="home">
      <section className="home-intro">
        <div className="brand brand--large">
          <span className="brand__mark" aria-hidden="true">
            画
          </span>
          <span>
            <strong>画猜现场</strong>
            <small>DRAW &amp; GUESS LIVE</small>
          </span>
        </div>
        <div className="home-intro__copy">
          <p className="eyebrow">三种玩法 · 桌面窗口采集 · 跨平台联机</p>
          <h1>
            认真画。
            <br />
            放心猜。
          </h1>
          <p>
            经典画猜、同步临摹与私密接龙共用一个房间。桌面端只上传服务器需要的最新画面。
          </p>
        </div>
        <div className="signal-card" aria-label="产品特点">
          <span>
            <strong>01</strong> 三种模式
          </span>
          <span>
            <strong>02</strong> 最新帧优先
          </span>
          <span>
            <strong>03</strong> 服务端裁决
          </span>
        </div>
      </section>

      <section className="entry-card" data-ui="room-entry">
        <div className="home-content-actions">
          <button onClick={onManageWords} type="button">
            词库管理
          </button>
        </div>
        <div className="entry-tabs" role="tablist" aria-label="进入方式">
          <button
            className={entryMode === "create" ? "active" : ""}
            onClick={() => setEntryMode("create")}
            role="tab"
            type="button"
          >
            创建房间
          </button>
          <button
            className={entryMode === "join" ? "active" : ""}
            onClick={() => setEntryMode("join")}
            role="tab"
            type="button"
          >
            加入房间
          </button>
        </div>

        {entryMode === "create" ? (
          <form className="entry-form" onSubmit={submitCreate}>
            <div>
              <p className="eyebrow">成为今晚的主持人</p>
              <h2>开一个新房间</h2>
              <p className="muted">房间与参考图只保存在服务器内存中。</p>
            </div>
            <label>
              你的昵称
              <input
                name="nickname"
                maxLength={24}
                placeholder="例如：小画家"
                required
              />
            </label>
            {avatarControl}
            <label>
              房间密码
              <input
                name="password"
                minLength={4}
                maxLength={128}
                placeholder="至少 4 位"
                type="password"
                required
              />
            </label>
            {error && <p className="form-error">{error}</p>}
            <button className="primary-button" disabled={busy} type="submit">
              {busy ? "正在创建…" : "创建并进入"}
            </button>
          </form>
        ) : (
          <form className="entry-form" onSubmit={submitJoin}>
            <div>
              <p className="eyebrow">朋友已经开场？</p>
              <h2>输入邀请信息</h2>
            </div>
            <label>
              六位房间码
              <input
                defaultValue={requestedRoom}
                name="roomCode"
                maxLength={6}
                minLength={6}
                placeholder="ABC234"
                autoCapitalize="characters"
                required
              />
            </label>
            <label>
              你的昵称
              <input
                name="nickname"
                maxLength={24}
                placeholder="例如：猜猜看"
                required
              />
            </label>
            {avatarControl}
            <label>
              房间密码
              <input name="password" type="password" required />
            </label>
            {error && <p className="form-error">{error}</p>}
            <button className="primary-button" disabled={busy} type="submit">
              {busy ? "正在加入…" : "加入房间"}
            </button>
          </form>
        )}
      </section>
    </main>
  );
}

function drawingContext(snapshot: PublicRoomSnapshot): string {
  const { game } = snapshot;
  const self = game.selfDrawing;
  if (game.mode === "classic") {
    return [
      snapshot.modeSessionId,
      game.mode,
      game.currentTurnId,
      game.currentDrawerId ?? "-",
      self?.actorStepId ?? "-"
    ].join(":");
  }
  return [snapshot.modeSessionId, game.mode, self?.actorStepId ?? "-"].join(":");
}

function acceptsLiveFrame(snapshot: PublicRoomSnapshot): boolean {
  return snapshot.game.phase === "DRAWING" || snapshot.game.phase === "FINALIZING";
}

function knownCaptureSession(snapshot: PublicRoomSnapshot): number | null {
  const drawing = snapshot.game.selfDrawing;
  return drawing && drawing.status !== "finalized" ? drawing.captureSessionId : null;
}

function PassControls({
  snapshot,
  send
}: {
  snapshot: PublicRoomSnapshot;
  send: (message: Record<string, unknown>) => void;
}) {
  if (snapshot.passableActors.length === 0) {
    return null;
  }
  const effectText = {
    "handoff-input": "跳过当前输入并交给下一位",
    "withdraw-submission": "退出本次临摹且不提交作品",
    "finalize-current-frame": "立即以服务器已接受的画面定稿",
    "finish-ballot": "保留已点赞作品并跳过剩余匿名作品"
  } as const;
  return (
    <aside className="pass-controls" data-ui="pass-controls">
      {snapshot.passableActors.map((actor) => {
        const player = snapshot.players.find(
          (candidate) => candidate.id === actor.targetPlayerId
        );
        const self = actor.targetPlayerId === snapshot.selfPlayerId;
        const text = effectText[actor.effect];
        return (
          <button
            className="secondary-button"
            key={actor.actorStepId}
            onClick={() => {
              if (
                !window.confirm(
                  `${self ? "你" : (player?.nickname ?? "该玩家")}将${text}。确定 Pass 吗？`
                )
              ) {
                return;
              }
              send({
                type: "turn:pass",
                modeSessionId: snapshot.modeSessionId,
                actorStepId: actor.actorStepId,
                targetPlayerId: actor.targetPlayerId
              });
            }}
            type="button"
          >
            Pass · {self ? text : `${player?.nickname ?? "玩家"}：${text}`}
          </button>
        );
      })}
    </aside>
  );
}

export function App({
  transport,
  hostControls,
  notificationsEnabled = true,
  initialRoomCode,
  lobbyAddon,
  topbarAddon,
  onSnapshot,
  onServerMessage,
  invitationText,
  contentServices
}: AppProps = {}) {
  const contentRef = useRef<LocalContentServices | null>(null);
  contentRef.current ??= contentServices ?? createBrowserContentServices();
  const content = contentRef.current;

  const [snapshot, setSnapshot] = useState<PublicRoomSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [connection, setConnection] = useState<ConnectionState>("offline");
  const [wordOptions, setWordOptions] = useState<WordOption[]>([]);
  const [wordOptionsActorStepId, setWordOptionsActorStepId] = useState<string | null>(
    null
  );
  const [currentWord, setCurrentWord] = useState<string | null>(null);
  const [frameUrl, setFrameUrl] = useState<string | null>(null);
  const [serverOffset, setServerOffset] = useState(0);
  const [wordManagerOpen, setWordManagerOpen] = useState(false);
  const [localAvatar, setLocalAvatar] = useState<LocalAvatar | null>(null);
  const [avatarLoaded, setAvatarLoaded] = useState(false);
  const [avatarUrls, setAvatarUrls] = useState<Map<string, string>>(new Map());
  const [savedReplayAvailable, setSavedReplayAvailable] = useState(false);
  const [notificationPermission, setNotificationPermission] = useState<
    NotificationPermission | "unsupported"
  >(typeof Notification === "undefined" ? "unsupported" : Notification.permission);

  const socketRef = useRef<WebSocket | null>(null);
  const snapshotRef = useRef<PublicRoomSnapshot | null>(null);
  const frameUrlRef = useRef<string | null>(null);
  const frameContextRef = useRef("");
  const frameCaptureSessionRef = useRef<number | null>(null);
  const latestSequenceRef = useRef(-1);
  const avatarCacheRef = useRef(new Map<string, { revision: string; url: string }>());
  const avatarSyncKeyRef = useRef("");
  const notificationEventIdsRef = useRef(new Set<string>());
  const toastTimerRef = useRef<number | null>(null);

  const notify = useCallback((message: string) => {
    if (toastTimerRef.current !== null) {
      window.clearTimeout(toastTimerRef.current);
    }
    setError(message);
    toastTimerRef.current = window.setTimeout(() => {
      setError(null);
      toastTimerRef.current = null;
    }, 5_000);
  }, []);

  useEffect(
    () => () => {
      if (toastTimerRef.current !== null) {
        window.clearTimeout(toastTimerRef.current);
      }
    },
    []
  );

  useEffect(() => {
    let disposed = false;
    void content.avatar
      .getActive()
      .then((avatar) => {
        if (!disposed) {
          setLocalAvatar(avatar);
          setAvatarLoaded(true);
        }
      })
      .catch((loadError: unknown) => {
        if (!disposed) {
          notify(loadError instanceof Error ? loadError.message : "读取本地头像失败");
          setAvatarLoaded(true);
        }
      });
    return () => {
      disposed = true;
    };
  }, [content, notify]);

  const clearFrame = useCallback(() => {
    if (frameUrlRef.current) {
      URL.revokeObjectURL(frameUrlRef.current);
    }
    frameUrlRef.current = null;
    frameCaptureSessionRef.current = null;
    latestSequenceRef.current = -1;
    setFrameUrl(null);
  }, []);

  const applySnapshot = useCallback(
    (next: PublicRoomSnapshot) => {
      const nextContext = drawingContext(next);
      if (frameContextRef.current !== nextContext || !acceptsLiveFrame(next)) {
        clearFrame();
        frameContextRef.current = nextContext;
      }
      const previous = snapshotRef.current;
      if (
        !previous ||
        previous.modeSessionId !== next.modeSessionId ||
        next.game.mode !== "classic" ||
        previous.game.mode !== "classic" ||
        previous.game.currentTurnId !== next.game.currentTurnId
      ) {
        setWordOptions([]);
        setWordOptionsActorStepId(null);
        setCurrentWord(null);
      }
      setServerOffset(next.serverNow - Date.now());
      snapshotRef.current = next;
      setSnapshot(next);
      onSnapshot?.(next);
    },
    [clearFrame, onSnapshot]
  );

  const applyFrame = useCallback((packet: Uint8Array) => {
    const active = snapshotRef.current;
    if (!active || !acceptsLiveFrame(active)) {
      return null;
    }
    let frame;
    try {
      frame = decodeViewerFrame(packet);
    } catch {
      return null;
    }
    if (!frame.mimeType) {
      return null;
    }
    const knownSession = knownCaptureSession(active);
    if (knownSession !== null && frame.captureSessionId !== knownSession) {
      return null;
    }
    if (frameCaptureSessionRef.current !== frame.captureSessionId) {
      frameCaptureSessionRef.current = frame.captureSessionId;
      latestSequenceRef.current = -1;
    }
    if (frame.sequence <= latestSequenceRef.current) {
      return null;
    }
    latestSequenceRef.current = frame.sequence;
    const buffer = new ArrayBuffer(frame.imageBytes.byteLength);
    new Uint8Array(buffer).set(frame.imageBytes);
    const nextUrl = URL.createObjectURL(new Blob([buffer], { type: frame.mimeType }));
    if (frameUrlRef.current) {
      URL.revokeObjectURL(frameUrlRef.current);
    }
    frameUrlRef.current = nextUrl;
    setFrameUrl(nextUrl);
    return frame;
  }, []);

  const showFinalizationNotification = useCallback(
    (modeSessionId: string, actorStepId: string, eventId: string) => {
      const notificationKey = `${modeSessionId}:${actorStepId}:${eventId}`;
      if (notificationEventIdsRef.current.has(notificationKey)) {
        return;
      }
      notificationEventIdsRef.current.add(notificationKey);
      const text = "绘画进入 10 秒展示收尾，请保持最终画面稳定。";
      notify(text);
      if (
        !transport &&
        notificationsEnabled &&
        typeof Notification !== "undefined" &&
        Notification.permission === "granted"
      ) {
        const notification = new Notification("画猜现场", {
          body: text,
          tag: notificationKey
        });
        notification.onclick = () => {
          window.focus();
          notification.close();
        };
      }
    },
    [notificationsEnabled, notify, transport]
  );

  const handleServerMessage = useCallback(
    (message: ServerJsonMessage) => {
      onServerMessage?.(message);
      switch (message.type) {
        case "room:snapshot":
          applySnapshot(message.snapshot);
          break;
        case "classic:word-options": {
          const active = snapshotRef.current;
          if (
            active?.modeSessionId === message.modeSessionId &&
            active.game.mode === "classic" &&
            active.game.currentDrawerId === active.selfPlayerId
          ) {
            setWordOptions(message.options);
            setWordOptionsActorStepId(message.actorStepId);
            setCurrentWord(null);
          }
          break;
        }
        case "classic:word-selected": {
          const active = snapshotRef.current;
          if (
            active?.modeSessionId === message.modeSessionId &&
            wordOptionsActorStepId === message.actorStepId
          ) {
            setCurrentWord(message.answer);
            setWordOptions([]);
          }
          break;
        }
        case "drawing:finalization-started":
          if (
            snapshotRef.current?.modeSessionId === message.modeSessionId &&
            snapshotRef.current.game.selfDrawing?.actorStepId === message.actorStepId
          ) {
            showFinalizationNotification(
              message.modeSessionId,
              message.actorStepId,
              message.eventId
            );
          }
          break;
        case "chat:message": {
          const current = snapshotRef.current;
          if (current && !current.chat.some((entry) => entry.id === message.id)) {
            const updated: PublicRoomSnapshot = {
              ...current,
              chat: [
                ...current.chat,
                {
                  id: message.id,
                  kind: message.kind,
                  playerId: message.playerId,
                  nickname: message.nickname,
                  text: message.text,
                  createdAt: message.createdAt
                }
              ].slice(-100)
            };
            snapshotRef.current = updated;
            setSnapshot(updated);
            onSnapshot?.(updated);
          }
          break;
        }
        case "error":
          notify(message.message);
          break;
        case "pong":
          setServerOffset(message.serverNow - Date.now());
          break;
        default:
          break;
      }
    },
    [
      applySnapshot,
      notify,
      onServerMessage,
      onSnapshot,
      showFinalizationNotification,
      wordOptionsActorStepId
    ]
  );

  const finalizing = snapshot?.game.selfDrawing?.status === "finalizing";
  useEffect(() => {
    document.title = finalizing ? "展示收尾 · 画猜现场" : "画猜现场";
    return () => {
      document.title = "画猜现场";
    };
  }, [finalizing]);

  useEffect(() => {
    if (!snapshot) {
      notificationEventIdsRef.current.clear();
    }
  }, [snapshot]);

  useEffect(() => {
    const resume = transport
      ? transport.resume()
      : apiRequest<{ snapshot: PublicRoomSnapshot }>("/api/session");
    void resume
      .then((result) => {
        if (result) {
          applySnapshot(result.snapshot);
        } else {
          snapshotRef.current = null;
          setSnapshot(null);
          onSnapshot?.(null);
        }
      })
      .catch((resumeError: unknown) => {
        snapshotRef.current = null;
        setSnapshot(null);
        onSnapshot?.(null);
        if (transport) {
          notify(resumeError instanceof Error ? resumeError.message : "恢复会话失败");
        }
      })
      .finally(() => setLoading(false));
  }, [applySnapshot, notify, onSnapshot, transport]);

  const send = useCallback(
    (message: Record<string, unknown>) => {
      const type = typeof message.type === "string" ? message.type : "";
      const payload = {
        ...message,
        ...(COMMAND_TYPES.has(type) && !message.commandId
          ? { commandId: commandId() }
          : {}),
        protocolVersion: PROTOCOL_VERSION
      };
      if (transport) {
        void transport.send(payload).catch((sendError: unknown) => {
          notify(sendError instanceof Error ? sendError.message : "消息发送失败");
        });
        return;
      }
      const socket = socketRef.current;
      if (!socket || socket.readyState !== WebSocket.OPEN) {
        notify("连接尚未恢复，请稍后再试");
        return;
      }
      socket.send(JSON.stringify(payload));
    },
    [notify, transport]
  );

  useEffect(() => {
    if (transport) {
      return;
    }
    if (!snapshot?.roomCode) {
      setConnection("offline");
      return;
    }
    let disposed = false;
    let retryTimer: number | null = null;
    let retryAttempt = 0;

    const connect = () => {
      if (disposed) {
        return;
      }
      setConnection(retryAttempt === 0 ? "connecting" : "reconnecting");
      const socket = new WebSocket(websocketUrl());
      socket.binaryType = "arraybuffer";
      socketRef.current = socket;
      socket.addEventListener("open", () => {
        retryAttempt = 0;
        setConnection("connected");
        socket.send(
          JSON.stringify({
            protocolVersion: PROTOCOL_VERSION,
            type: "room:sync"
          })
        );
      });
      socket.addEventListener("message", (event) => {
        if (typeof event.data === "string") {
          let json: unknown;
          try {
            json = JSON.parse(event.data) as unknown;
          } catch {
            notify("收到无法识别的服务器消息");
            return;
          }
          const parsed = ServerJsonMessageSchema.safeParse(json);
          if (!parsed.success) {
            notify("服务器协议版本或消息格式不兼容");
            return;
          }
          handleServerMessage(parsed.data);
          return;
        }
        if (!(event.data instanceof ArrayBuffer)) {
          return;
        }
        const accepted = applyFrame(new Uint8Array(event.data));
        if (accepted && socket.readyState === WebSocket.OPEN) {
          socket.send(
            JSON.stringify({
              protocolVersion: PROTOCOL_VERSION,
              type: "frame:ack",
              captureSessionId: accepted.captureSessionId,
              sequence: accepted.sequence
            })
          );
        }
      });
      socket.addEventListener("close", () => {
        if (disposed) {
          return;
        }
        setConnection("reconnecting");
        retryAttempt += 1;
        retryTimer = window.setTimeout(
          connect,
          Math.min(10_000, 500 * 2 ** Math.min(5, retryAttempt))
        );
      });
      socket.addEventListener("error", () => socket.close());
    };

    connect();
    const pingTimer = window.setInterval(() => {
      if (socketRef.current?.readyState === WebSocket.OPEN) {
        socketRef.current.send(
          JSON.stringify({
            protocolVersion: PROTOCOL_VERSION,
            type: "ping",
            timestamp: Date.now()
          })
        );
      }
    }, 20_000);
    return () => {
      disposed = true;
      window.clearInterval(pingTimer);
      if (retryTimer !== null) {
        window.clearTimeout(retryTimer);
      }
      socketRef.current?.close();
      socketRef.current = null;
    };
  }, [applyFrame, handleServerMessage, notify, snapshot?.roomCode, transport]);

  useEffect(() => {
    if (!transport) {
      return;
    }
    return transport.onEvent((event) => {
      if (event.kind === "connection") {
        setConnection(event.state);
        if (event.error) {
          notify(event.error);
        }
      } else if (event.kind === "message") {
        handleServerMessage(event.message);
      } else {
        const accepted = applyFrame(event.packet);
        if (accepted) {
          send({
            type: "frame:ack",
            captureSessionId: accepted.captureSessionId,
            sequence: accepted.sequence
          });
        }
      }
    });
  }, [applyFrame, handleServerMessage, notify, send, transport]);

  useEffect(() => {
    const replay = hostControls?.replay;
    const code = snapshot?.roomCode;
    if (!replay || !code) {
      setSavedReplayAvailable(false);
      return;
    }
    let disposed = false;
    const check = () => {
      void replay
        .saved(code)
        .then((saved) => {
          if (!disposed) {
            setSavedReplayAvailable(Boolean(saved));
          }
        })
        .catch(() => {
          if (!disposed) {
            setSavedReplayAvailable(false);
          }
        });
    };
    check();
    const timer = window.setInterval(check, 3_000);
    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, [hostControls?.replay, snapshot?.roomCode, snapshot?.modeSessionId]);

  useEffect(() => clearFrame, [clearFrame]);

  const roomCode = () => {
    const value = snapshotRef.current?.roomCode;
    if (!value) {
      throw new Error("尚未加入房间");
    }
    return value;
  };

  const uploadWordPool = useCallback(
    async (wordPool: WordPoolUpload) => {
      const code = roomCode();
      if (transport) {
        await transport.uploadWordPool(code, wordPool);
      } else {
        await apiRequest<{ wordPool: PublicWordPoolSummary }>(
          `/api/rooms/${encodeURIComponent(code)}/word-pool`,
          { method: "PUT", body: JSON.stringify(wordPool) }
        );
      }
    },
    [transport]
  );

  const uploadReference = useCallback(
    async (file: File) => {
      if (
        file.type !== "image/png" &&
        file.type !== "image/jpeg" &&
        file.type !== "image/webp"
      ) {
        throw new Error("参考图必须是静态 PNG、JPEG 或 WebP");
      }
      const code = roomCode();
      const bytes = new Uint8Array(await file.arrayBuffer());
      if (transport) {
        const result = await transport.uploadReference(code, file.type, bytes);
        return result.reference;
      }
      const response = await fetch(`/api/rooms/${encodeURIComponent(code)}/reference`, {
        method: "PUT",
        credentials: "same-origin",
        headers: { "Content-Type": file.type },
        body: bytes
      });
      if (!response.ok) {
        throw await responseError(response, "参考图上传失败");
      }
      const result = (await response.json()) as {
        reference: {
          revision: string;
          mimeType: "image/png" | "image/jpeg" | "image/webp";
          width: number;
          height: number;
          byteLength: number;
        };
      };
      return result.reference;
    },
    [transport]
  );

  const deleteReference = useCallback(async () => {
    const code = roomCode();
    if (transport) {
      await transport.deleteReference(code);
      return;
    }
    const response = await fetch(`/api/rooms/${encodeURIComponent(code)}/reference`, {
      method: "DELETE",
      credentials: "same-origin"
    });
    if (!response.ok) {
      throw await responseError(response, "参考图删除失败");
    }
  }, [transport]);

  const loadAsset = useCallback(
    async (path: string): Promise<GameAsset> => {
      const code = roomCode();
      const prefix = `/api/rooms/${encodeURIComponent(code)}/`;
      if (!path.startsWith(prefix)) {
        throw new Error("游戏素材地址不属于当前房间");
      }
      if (transport) {
        return transport.getAsset(code, path);
      }
      const response = await fetch(path, { credentials: "same-origin" });
      if (!response.ok) {
        throw await responseError(response, "游戏素材读取失败");
      }
      const mimeType = response.headers.get("content-type")?.split(";")[0]?.trim();
      if (
        mimeType !== "image/png" &&
        mimeType !== "image/jpeg" &&
        mimeType !== "image/webp"
      ) {
        throw new Error("服务器返回了不支持的素材类型");
      }
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.byteLength < 1 || bytes.byteLength > 20 * 1024 * 1024) {
        throw new Error("服务器素材大小无效");
      }
      return { mimeType, bytes };
    },
    [transport]
  );

  const loadRelayTask = useCallback(
    async (actorStepId: string): Promise<RelayPrivateTask> => {
      const code = roomCode();
      if (transport) {
        return (await transport.getRelayTask(code, actorStepId)).task;
      }
      const result = await apiRequest<{ task: RelayPrivateTask }>(
        `/api/rooms/${encodeURIComponent(
          code
        )}/relay/tasks/${encodeURIComponent(actorStepId)}`
      );
      return result.task;
    },
    [transport]
  );

  const uploadAvatar = useCallback(
    async (code: string, bytesInput: Uint8Array) => {
      const bytes = new Uint8Array(bytesInput);
      validateNormalizedAvatarPng(bytes);
      if (transport) {
        await transport.uploadAvatar(code, bytes);
        return;
      }
      const response = await fetch(`/api/rooms/${encodeURIComponent(code)}/me/avatar`, {
        method: "PUT",
        credentials: "same-origin",
        headers: { "Content-Type": "image/png" },
        body: bytes
      });
      if (!response.ok) {
        throw await responseError(response, "头像上传失败");
      }
    },
    [transport]
  );

  const deleteAvatar = useCallback(
    async (code: string) => {
      if (transport) {
        await transport.deleteAvatar(code);
        return;
      }
      const response = await fetch(`/api/rooms/${encodeURIComponent(code)}/me/avatar`, {
        method: "DELETE",
        credentials: "same-origin"
      });
      if (!response.ok) {
        throw await responseError(response, "头像删除同步失败");
      }
    },
    [transport]
  );

  const loadAvatar = useCallback(
    async (
      code: string,
      playerId: string,
      revision: string
    ): Promise<Uint8Array | null> => {
      if (transport) {
        return transport.getAvatar(code, playerId, revision);
      }
      const response = await fetch(
        `/api/rooms/${encodeURIComponent(code)}/players/${encodeURIComponent(
          playerId
        )}/avatar/${encodeURIComponent(revision)}`,
        { credentials: "same-origin" }
      );
      if (response.status === 404) {
        return null;
      }
      if (!response.ok) {
        throw new Error("头像读取失败");
      }
      const contentLength = Number(response.headers.get("content-length") ?? "0");
      if (contentLength > CONTENT_LIMITS.avatarBytes) {
        throw new Error("头像响应超过大小上限");
      }
      const bytes = new Uint8Array(await response.arrayBuffer());
      validateNormalizedAvatarPng(bytes);
      return bytes;
    },
    [transport]
  );

  const avatarSignature =
    snapshot?.players
      .map((player) => `${player.id}:${player.avatarRevision ?? "-"}`)
      .join("|") ?? "";
  useEffect(() => {
    const active = snapshotRef.current;
    if (!active) {
      for (const cached of avatarCacheRef.current.values()) {
        URL.revokeObjectURL(cached.url);
      }
      avatarCacheRef.current.clear();
      setAvatarUrls(new Map());
      return;
    }
    let disposed = false;
    const desired = new Set(active.players.map((player) => player.id));
    for (const [playerId, cached] of avatarCacheRef.current) {
      const player = active.players.find((candidate) => candidate.id === playerId);
      if (
        !desired.has(playerId) ||
        !player?.avatarRevision ||
        player.avatarRevision !== cached.revision
      ) {
        URL.revokeObjectURL(cached.url);
        avatarCacheRef.current.delete(playerId);
      }
    }
    void Promise.all(
      active.players.map(async (player) => {
        const revision = player.avatarRevision;
        if (!revision || avatarCacheRef.current.get(player.id)?.revision === revision) {
          return;
        }
        try {
          const bytes = await loadAvatar(active.roomCode, player.id, revision);
          if (!bytes || disposed) {
            return;
          }
          const buffer = new ArrayBuffer(bytes.byteLength);
          new Uint8Array(buffer).set(bytes);
          const url = URL.createObjectURL(new Blob([buffer], { type: "image/png" }));
          const previous = avatarCacheRef.current.get(player.id);
          if (previous) {
            URL.revokeObjectURL(previous.url);
          }
          avatarCacheRef.current.set(player.id, { revision, url });
        } catch {
          // The stable initials remain visible when an avatar cannot be loaded.
        }
      })
    ).then(() => {
      if (!disposed) {
        setAvatarUrls(
          new Map(
            [...avatarCacheRef.current].map(([playerId, cached]) => [
              playerId,
              cached.url
            ])
          )
        );
      }
    });
    return () => {
      disposed = true;
    };
  }, [avatarSignature, loadAvatar, snapshot?.roomCode]);

  useEffect(
    () => () => {
      for (const cached of avatarCacheRef.current.values()) {
        URL.revokeObjectURL(cached.url);
      }
      avatarCacheRef.current.clear();
    },
    []
  );

  const selfAvatarRevision = snapshot?.players.find(
    (player) => player.id === snapshot.selfPlayerId
  )?.avatarRevision;
  useEffect(() => {
    if (!snapshot || !avatarLoaded) {
      return;
    }
    const key = `${snapshot.roomCode}:${snapshot.selfPlayerId}:${
      localAvatar?.sha256 ?? "none"
    }:${selfAvatarRevision ?? "none"}`;
    if (avatarSyncKeyRef.current === key) {
      return;
    }
    avatarSyncKeyRef.current = key;
    if (localAvatar && selfAvatarRevision !== localAvatar.sha256) {
      void uploadAvatar(snapshot.roomCode, localAvatar.bytes).catch(
        (avatarError: unknown) =>
          notify(
            avatarError instanceof Error
              ? `头像未同步：${avatarError.message}`
              : "头像未同步"
          )
      );
    } else if (!localAvatar && selfAvatarRevision) {
      void deleteAvatar(snapshot.roomCode).catch((avatarError: unknown) =>
        notify(
          avatarError instanceof Error
            ? `头像删除未同步：${avatarError.message}`
            : "头像删除未同步"
        )
      );
    }
  }, [
    avatarLoaded,
    deleteAvatar,
    localAvatar,
    notify,
    selfAvatarRevision,
    snapshot,
    uploadAvatar
  ]);

  const createRoom = async (nickname: string, password: string) => {
    setBusy(true);
    setError(null);
    try {
      const response = transport
        ? await transport.createRoom(nickname, password)
        : await apiRequest<{ snapshot: PublicRoomSnapshot }>("/api/rooms", {
            method: "POST",
            body: JSON.stringify({ nickname, password })
          });
      applySnapshot(response.snapshot);
    } catch (requestError) {
      notify(requestError instanceof Error ? requestError.message : "创建失败");
    } finally {
      setBusy(false);
    }
  };

  const joinRoom = async (
    roomCodeInput: string,
    nickname: string,
    password: string
  ) => {
    setBusy(true);
    setError(null);
    const code = roomCodeInput.trim().toUpperCase();
    try {
      const response = transport
        ? await transport.joinRoom(code, nickname, password)
        : await apiRequest<{ snapshot: PublicRoomSnapshot }>(
            `/api/rooms/${encodeURIComponent(code)}/join`,
            {
              method: "POST",
              body: JSON.stringify({ roomCode: code, nickname, password })
            }
          );
      if (!transport) {
        window.history.replaceState({}, "", `/?room=${code}`);
      }
      applySnapshot(response.snapshot);
    } catch (requestError) {
      notify(requestError instanceof Error ? requestError.message : "加入失败");
    } finally {
      setBusy(false);
    }
  };

  const modeProps = useMemo(
    () =>
      snapshot
        ? {
            snapshot,
            send,
            serverOffset,
            frameUrl,
            wordOptions,
            wordOptionsActorStepId,
            currentWord,
            avatarUrls,
            content,
            uploadWordPool,
            uploadReference,
            deleteReference,
            loadAsset,
            loadRelayTask,
            onManageWords: () => setWordManagerOpen(true),
            notify,
            hostControls
          }
        : null,
    [
      avatarUrls,
      content,
      currentWord,
      deleteReference,
      frameUrl,
      hostControls,
      loadAsset,
      loadRelayTask,
      notify,
      send,
      serverOffset,
      snapshot,
      uploadReference,
      uploadWordPool,
      wordOptions,
      wordOptionsActorStepId
    ]
  );

  const switchMode = (targetMode: GameModeId) => {
    const active = snapshotRef.current;
    if (!active || targetMode === active.game.mode) {
      return;
    }
    if (
      !window.confirm(
        `确认从“${GAME_MODE_LABELS[active.game.mode]}”切换到“${GAME_MODE_LABELS[targetMode]}”吗？当前阶段会结束。`
      )
    ) {
      return;
    }
    let partialReplay: "encode-and-save" | "discard" | undefined;
    if (active.game.mode === "draw-relay" && active.game.phase !== "LOBBY") {
      if (
        window.confirm(
          "是否先编码并保存当前接龙的部分回放？\n确定：编码保存；取消：继续选择。"
        )
      ) {
        partialReplay = "encode-and-save";
      } else if (
        window.confirm(
          "要丢弃本次部分回放并继续切换吗？\n取消将保留当前接龙，不执行切换。"
        )
      ) {
        partialReplay = "discard";
      } else {
        return;
      }
    }
    send({
      type: "room:switch-mode",
      modeSessionId: active.modeSessionId,
      targetMode,
      ...(partialReplay ? { partialReplay } : {})
    });
  };

  if (wordManagerOpen) {
    return (
      <WordPackManager onClose={() => setWordManagerOpen(false)} services={content} />
    );
  }
  if (loading) {
    return (
      <main className="loading-screen">
        <span className="brand__mark">画</span>
        <p>正在恢复现场…</p>
      </main>
    );
  }
  if (!snapshot || !modeProps) {
    return (
      <Home
        avatarControl={
          <AvatarEditor
            avatar={localAvatar}
            onChange={setLocalAvatar}
            services={content}
          />
        }
        busy={busy}
        error={error}
        initialRoomCode={initialRoomCode}
        onCreate={createRoom}
        onJoin={joinRoom}
        onManageWords={() => setWordManagerOpen(true)}
      />
    );
  }

  const isLogicalHost = snapshot.hostId === snapshot.selfPlayerId;
  const isLobby = snapshot.game.phase === "LOBBY";
  const resumeDelay =
    snapshot.runControl.status === "running" &&
    snapshot.runControl.captureResumesAt !== null
      ? Math.max(
          0,
          Math.ceil(
            (snapshot.runControl.captureResumesAt - (Date.now() + serverOffset)) / 1_000
          )
        )
      : 0;

  return (
    <div className="app-shell" data-ui="game-shell">
      <header className="topbar" data-ui="topbar">
        <div className="brand">
          <span className="brand__mark" aria-hidden="true">
            画
          </span>
          <span>
            <strong>画猜现场</strong>
            <small>{snapshot.roomCode}</small>
          </span>
        </div>
        <div className="topbar__status">
          <button
            className="topbar-content-button"
            onClick={() => setWordManagerOpen(true)}
            type="button"
          >
            词库
          </button>
          {isLogicalHost ? (
            <label className="mode-switcher">
              <span className="sr-only">切换游戏模式</span>
              <select
                aria-label="游戏模式"
                onChange={(event) => switchMode(event.target.value as GameModeId)}
                value={snapshot.game.mode}
              >
                {(Object.keys(GAME_MODE_LABELS) as GameModeId[]).map((mode) => (
                  <option
                    disabled={
                      mode === "draw-relay" &&
                      snapshot.game.mode !== "draw-relay" &&
                      !snapshot.replayCapability.available
                    }
                    key={mode}
                    value={mode}
                  >
                    {GAME_MODE_LABELS[mode]}
                  </option>
                ))}
              </select>
            </label>
          ) : (
            <span className="mode-chip">{GAME_MODE_LABELS[snapshot.game.mode]}</span>
          )}
          {hostControls && snapshot.runControl.status === "running" && (
            <button
              className="topbar-content-button"
              data-ui="actual-host-pause"
              onClick={() =>
                void hostControls
                  .pause(snapshot.roomCode)
                  .catch((hostError: unknown) =>
                    notify(hostError instanceof Error ? hostError.message : "暂停失败")
                  )
              }
              type="button"
            >
              暂停全场
            </button>
          )}
          {hostControls && snapshot.runControl.status === "paused" && (
            <button
              className="topbar-content-button"
              data-ui="actual-host-resume"
              onClick={() =>
                void hostControls
                  .resume(snapshot.roomCode)
                  .catch((hostError: unknown) =>
                    notify(hostError instanceof Error ? hostError.message : "恢复失败")
                  )
              }
              type="button"
            >
              恢复全场
            </button>
          )}
          {hostControls?.replay && savedReplayAvailable && (
            <button
              className="topbar-content-button"
              onClick={() =>
                void hostControls
                  .replay!.openFile(snapshot.roomCode)
                  .catch((hostError: unknown) =>
                    notify(
                      hostError instanceof Error ? hostError.message : "无法打开回放"
                    )
                  )
              }
              type="button"
            >
              打开上次回放
            </button>
          )}
          {!transport &&
            notificationsEnabled &&
            notificationPermission === "default" && (
              <button
                className="topbar-content-button"
                onClick={() =>
                  void Notification.requestPermission().then(setNotificationPermission)
                }
                type="button"
              >
                开启收尾通知
              </button>
            )}
          {topbarAddon}
          <span className="phase-label">
            {PHASE_LABELS[snapshot.game.phase] ?? snapshot.game.phase}
          </span>
          <StatusDot state={connection} />
        </div>
      </header>

      {resumeDelay > 0 && (
        <div className="resume-banner" role="status">
          全场已恢复，采集将在 {resumeDelay} 秒后继续。
        </div>
      )}
      <PassControls send={send} snapshot={snapshot} />
      {isLobby && isLogicalHost && (
        <section
          aria-label="选择游戏模式"
          className="mode-selection-cards"
          data-ui="mode-selection-cards"
        >
          {(Object.keys(GAME_MODE_LABELS) as GameModeId[]).map((mode) => {
            const selected = mode === snapshot.game.mode;
            const capabilityBlocked =
              mode === "draw-relay" && !snapshot.replayCapability.available;
            return (
              <button
                aria-pressed={selected}
                className={
                  selected ? "mode-selection-card is-selected" : "mode-selection-card"
                }
                disabled={selected || capabilityBlocked}
                key={mode}
                onClick={() => switchMode(mode)}
                type="button"
              >
                <strong>{GAME_MODE_LABELS[mode]}</strong>
                <span>{GAME_MODE_DESCRIPTIONS[mode]}</span>
                {mode === "draw-relay" && (
                  <em className={capabilityBlocked ? "is-unavailable" : ""}>
                    {snapshot.replayCapability.available
                      ? `主机 FFmpeg 可用 · ${snapshot.replayCapability.encoder}`
                      : snapshot.replayCapability.message}
                  </em>
                )}
                {selected && <small>当前模式</small>}
              </button>
            );
          })}
        </section>
      )}
      <ModeRenderer {...modeProps} />

      {isLobby && (
        <section className="mode-lobby-extras">
          {lobbyAddon}
          <section className="panel lobby-profile-panel" data-ui="local-profile">
            <div className="panel-heading">
              <div>
                <p className="eyebrow">Local profile</p>
                <h2>房间与头像</h2>
              </div>
              <span className="step-pill">可选</span>
            </div>
            {invitationText && (
              <label>
                邀请信息
                <textarea
                  onFocus={(event) => event.currentTarget.select()}
                  readOnly
                  value={invitationText(snapshot.roomCode)}
                />
              </label>
            )}
            <AvatarEditor
              avatar={localAvatar}
              label="当前房间头像"
              onChange={setLocalAvatar}
              services={content}
            />
          </section>
        </section>
      )}

      {snapshot.runControl.status === "paused" && (
        <div
          aria-labelledby="pause-title"
          aria-modal="true"
          className="pause-overlay"
          data-ui="pause-overlay"
          role="dialog"
        >
          <section>
            <p className="eyebrow">Actual server host</p>
            <h2 id="pause-title">全场已暂停</h2>
            <p>计时、输入与画面上传均已冻结。保留本地画布，等待服务器主机恢复。</p>
            {hostControls && (
              <button
                className="primary-button"
                onClick={() =>
                  void hostControls
                    .resume(snapshot.roomCode)
                    .catch((hostError: unknown) =>
                      notify(
                        hostError instanceof Error ? hostError.message : "恢复失败"
                      )
                    )
                }
                type="button"
              >
                恢复全场
              </button>
            )}
          </section>
        </div>
      )}

      {error && (
        <button className="toast" onClick={() => setError(null)} type="button">
          {error}
        </button>
      )}
    </div>
  );
}
