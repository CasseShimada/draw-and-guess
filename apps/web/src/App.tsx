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
  RememberedNicknameSchema,
  validateNormalizedAvatarPng,
  type LocalAvatar,
  type LocalContentServices,
  type WordPoolUpload
} from "@draw-guess/content";
import {
  PROTOCOL_VERSION,
  ROOM_REMOVED_CLOSE_CODE,
  ServerJsonMessageSchema,
  decodeViewerFrame,
  type RelayPrivateTask,
  type ServerJsonMessage,
  type WordOption
} from "@draw-guess/protocol";
import type {
  GameModeId,
  GameModeSettings,
  PublicRoomSnapshot,
  PublicWordPoolSummary
} from "@draw-guess/shared-types";

import { AvatarEditor } from "./AvatarEditor.js";
import { RoomCodeCopyButton } from "./RoomCodeCopyButton.js";
import { RoomClosureDialog } from "./RoomClosureDialog.js";
import { RoomSettingsScreen } from "./RoomSettingsScreen.js";
import { WordPackManager } from "./WordPackManager.js";
import { createBrowserContentServices } from "./content-store.js";
import {
  GAME_MODE_DESCRIPTIONS,
  GAME_MODE_LABELS,
  ModeRenderer
} from "./modes/registry.js";
import type { ActualHostControls, GameAsset } from "./modes/types.js";
import {
  canOpenRoomSettings,
  createRestartCommand,
  createRoomSettingsDraft,
  createSwitchModeCommand,
  needsPartialReplayChoice,
  reconcileRoomSettingsDraft,
  roomSettingsDirty,
  snapshotInvalidatesRoomSettings,
  updateRoomSettingsDraft,
  type PartialReplayChoice,
  type RoomScreen,
  type RoomSettingsDraft
} from "./room-settings-state.js";

type ConnectionState = "connecting" | "connected" | "reconnecting" | "offline";

interface ApiErrorBody {
  error?: { message?: string };
}

type ClassicWordOptionsMessage = Extract<
  ServerJsonMessage,
  { type: "classic:word-options" }
>;
type ClassicWordSelectedMessage = Extract<
  ServerJsonMessage,
  { type: "classic:word-selected" }
>;

export function acceptsClassicWordOptions(
  active: PublicRoomSnapshot | null,
  message: ClassicWordOptionsMessage
): boolean {
  return (
    active?.modeSessionId === message.modeSessionId &&
    active.game.mode === "classic" &&
    active.game.phase === "WORD_SELECTION" &&
    active.game.currentDrawerId === active.selfPlayerId &&
    active.game.currentTurnId === message.turnId
  );
}

export function acceptsClassicSelectedWord(
  active: PublicRoomSnapshot | null,
  message: ClassicWordSelectedMessage
): boolean {
  return (
    active?.modeSessionId === message.modeSessionId &&
    active.game.mode === "classic" &&
    active.game.currentDrawerId === active.selfPlayerId &&
    active.game.selfDrawing?.actorStepId === message.actorStepId
  );
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
  initialEntryMode?: "create" | "join";
  joinConnectionControl?: ReactNode;
  lobbyAddon?: ReactNode;
  topbarAddon?: ReactNode;
  onSnapshot?: (snapshot: PublicRoomSnapshot | null) => void;
  onServerMessage?: (message: ServerJsonMessage) => void;
  contentServices?: LocalContentServices;
  embeddedThemeRoot?: boolean;
  themePlatform?: "web" | "desktop";
  themeScreenOverride?: string;
}

function ThemeSurface({
  children,
  connection,
  embedded,
  phase,
  mode,
  platform,
  screen
}: {
  children: ReactNode;
  connection: ConnectionState;
  embedded: boolean;
  phase?: string;
  mode?: GameModeId;
  platform: "web" | "desktop";
  screen: string;
}) {
  const surfaceRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const surface = surfaceRef.current;
    const root = embedded
      ? surface?.closest<HTMLElement>('[data-ui="theme-root"]')
      : surface;
    if (!root) {
      return;
    }
    root.dataset.platform = platform;
    root.dataset.screen = screen;
    root.dataset.connection = connection;
    if (mode) {
      root.dataset.mode = mode;
    } else {
      delete root.dataset.mode;
    }
    if (phase) {
      root.dataset.phase = phase.toLowerCase();
    } else {
      delete root.dataset.phase;
    }
  }, [connection, embedded, mode, phase, platform, screen]);

  return (
    <div
      className="app-theme-surface"
      data-connection={connection}
      data-critical-kind="content"
      data-critical-label="当前应用页面"
      data-critical-ui="app-surface"
      data-mode={mode}
      data-phase={phase?.toLowerCase()}
      data-platform={platform}
      data-screen={screen}
      data-theme-mode={embedded ? undefined : "default"}
      data-ui={embedded ? "app-root" : "theme-root"}
      ref={surfaceRef}
    >
      {children}
    </div>
  );
}

const COMMAND_TYPES = new Set([
  "game:start",
  "game:restart",
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

function commandId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
}

function formValue(values: FormData, name: string): string {
  const value = values.get(name);
  return typeof value === "string" ? value : "";
}

function requestPartialReplayChoice(
  snapshot: PublicRoomSnapshot
): PartialReplayChoice | null | undefined {
  if (!needsPartialReplayChoice(snapshot)) {
    return undefined;
  }
  if (
    window.confirm(
      "是否先编码并保存当前接龙的部分回放？\n确定：编码保存；取消：继续选择。"
    )
  ) {
    return "encode-and-save";
  }
  if (
    window.confirm("要丢弃本次部分回放并继续吗？\n取消将保留当前接龙，不执行操作。")
  ) {
    return "discard";
  }
  return null;
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
    <span
      className={`connection connection--${state}`}
      data-state={state}
      data-ui="connection-status"
      role="status"
    >
      <span className="connection__dot" aria-hidden="true" />
      {labels[state]}
    </span>
  );
}

export function Home({
  busy,
  error,
  initialEntryMode,
  joinConnectionControl,
  topbarAddon,
  avatarControl,
  rememberedNickname,
  onCreate,
  onJoin,
  onManageWords
}: {
  busy: boolean;
  error: string | null;
  initialEntryMode: "create" | "join";
  joinConnectionControl?: ReactNode;
  topbarAddon?: ReactNode;
  avatarControl: ReactNode;
  rememberedNickname: string | null;
  onCreate: (nickname: string, password: string) => Promise<void>;
  onJoin: (roomCode: string, nickname: string, password: string) => Promise<void>;
  onManageWords: () => void;
}) {
  const [entryMode, setEntryMode] = useState<"create" | "join">(initialEntryMode);
  const [nickname, setNickname] = useState(rememberedNickname ?? "");
  const nicknameEditedRef = useRef(false);
  useEffect(() => setEntryMode(initialEntryMode), [initialEntryMode]);
  useEffect(() => {
    if (!nicknameEditedRef.current) {
      setNickname(rememberedNickname ?? "");
    }
  }, [rememberedNickname]);

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
    <main className="home-shell" data-screen="home" data-ui="home-screen">
      <section className="home-intro" data-ui="home-intro">
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
          {topbarAddon}
          <button onClick={onManageWords} type="button">
            词库管理
          </button>
        </div>
        <div
          className="entry-tabs"
          data-ui="entry-tabs"
          role="tablist"
          aria-label="进入方式"
        >
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
          <form
            className="entry-form"
            data-ui="create-room-form"
            onSubmit={submitCreate}
          >
            <div>
              <p className="eyebrow">成为今晚的主持人</p>
              <h2>开一个新房间</h2>
              <p className="muted">房间与参考图只保存在服务器内存中。</p>
            </div>
            <label>
              你的昵称（可留空随机；将添加 #四位数字）
              <input
                autoComplete="nickname"
                data-critical-kind="input"
                data-critical-label="创建房间昵称"
                data-critical-ui="create-nickname-input"
                data-ui="text-input"
                name="nickname"
                maxLength={24}
                onChange={(event) => {
                  nicknameEditedRef.current = true;
                  setNickname(event.currentTarget.value);
                }}
                placeholder="留空将随机生成"
                value={nickname}
              />
            </label>
            {avatarControl}
            <label>
              房间密码
              <input
                data-critical-kind="input"
                data-critical-label="创建房间密码"
                data-critical-ui="create-password-input"
                data-ui="password-input"
                name="password"
                minLength={4}
                maxLength={128}
                placeholder="至少 4 位"
                type="password"
                required
              />
            </label>
            {error && (
              <p className="form-error" role="alert">
                {error}
              </p>
            )}
            <button
              className="primary-button"
              data-action="create-room"
              data-critical-kind="action"
              data-critical-label="创建并进入房间"
              data-critical-ui="create-room-action"
              data-ui="primary-button"
              disabled={busy}
              type="submit"
            >
              {busy ? "正在创建…" : "创建并进入"}
            </button>
          </form>
        ) : (
          <form className="entry-form" data-ui="join-room-form" onSubmit={submitJoin}>
            <div>
              <p className="eyebrow">朋友已经开场？</p>
              <h2>输入房间连接信息</h2>
            </div>
            {joinConnectionControl}
            <label>
              六位房间码
              <input
                data-critical-kind="input"
                data-critical-label="六位房间码"
                data-critical-ui="room-code-input"
                data-ui="room-code-input"
                name="roomCode"
                maxLength={6}
                minLength={6}
                placeholder="ABC234"
                autoCapitalize="characters"
                required
              />
            </label>
            <label>
              你的昵称（可留空随机；将添加 #四位数字）
              <input
                autoComplete="nickname"
                data-critical-kind="input"
                data-critical-label="加入房间昵称"
                data-critical-ui="join-nickname-input"
                data-ui="text-input"
                name="nickname"
                maxLength={24}
                onChange={(event) => {
                  nicknameEditedRef.current = true;
                  setNickname(event.currentTarget.value);
                }}
                placeholder="留空将随机生成"
                value={nickname}
              />
            </label>
            <label>
              房间密码
              <input
                data-critical-kind="input"
                data-critical-label="加入房间密码"
                data-critical-ui="join-password-input"
                data-ui="password-input"
                name="password"
                minLength={4}
                maxLength={128}
                type="password"
                required
              />
            </label>
            {avatarControl}
            {error && (
              <p className="form-error" data-ui="join-error" role="alert">
                {error}
              </p>
            )}
            <button
              className="primary-button"
              data-action="join-room"
              data-critical-kind="action"
              data-critical-label="加入房间"
              data-critical-ui="join-room-action"
              data-ui="primary-button"
              disabled={busy}
              type="submit"
            >
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
            data-action="pass-turn"
            data-critical-kind="action"
            data-critical-label={`Pass：${self ? text : (player?.nickname ?? "玩家")}`}
            data-critical-ui={`pass-${actor.actorStepId}`}
            data-ui="secondary-button"
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
  initialEntryMode = "create",
  joinConnectionControl,
  lobbyAddon,
  topbarAddon,
  onSnapshot,
  onServerMessage,
  contentServices,
  embeddedThemeRoot = false,
  themePlatform = "web",
  themeScreenOverride
}: AppProps = {}) {
  const contentRef = useRef<LocalContentServices | null>(null);
  contentRef.current ??= contentServices ?? createBrowserContentServices();
  const content = contentRef.current;

  const [snapshot, setSnapshot] = useState<PublicRoomSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [roomClosureNotice, setRoomClosureNotice] = useState<string | null>(null);
  const [roomScreen, setRoomScreen] = useState<RoomScreen>("game");
  const [roomSettingsDraft, setRoomSettingsDraft] = useState<RoomSettingsDraft | null>(
    null
  );
  const [restartSubmitting, setRestartSubmitting] = useState(false);
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
  const [rememberedNickname, setRememberedNickname] = useState<string | null>(null);
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

  const reportEntryError = useCallback((message: string) => {
    if (toastTimerRef.current !== null) {
      window.clearTimeout(toastTimerRef.current);
      toastTimerRef.current = null;
    }
    setError(message);
  }, []);

  const copyRoomCode = useCallback(
    async (roomCode: string) => {
      try {
        if (!navigator.clipboard?.writeText) {
          throw new Error("clipboard unavailable");
        }
        await navigator.clipboard.writeText(roomCode);
        notify(`房间码 ${roomCode} 已复制`);
      } catch {
        notify(`无法自动复制，请手动记下房间码 ${roomCode}`);
      }
    },
    [notify]
  );

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

  useEffect(() => {
    let disposed = false;
    void content.nickname
      .get()
      .then((nickname) => {
        if (!disposed) {
          setRememberedNickname(nickname);
        }
      })
      .catch(() => undefined);
    return () => {
      disposed = true;
    };
  }, [content]);

  const rememberManualNickname = useCallback(
    (nicknameInput: string) => {
      const parsed = RememberedNicknameSchema.safeParse(nicknameInput);
      if (!parsed.success) {
        return;
      }
      setRememberedNickname(parsed.data);
      void content.nickname.put(parsed.data).catch(() => {
        notify("房间可正常进入，但未能在本机记住昵称");
      });
    },
    [content, notify]
  );

  const clearFrame = useCallback(() => {
    if (frameUrlRef.current) {
      URL.revokeObjectURL(frameUrlRef.current);
    }
    frameUrlRef.current = null;
    frameCaptureSessionRef.current = null;
    latestSequenceRef.current = -1;
    setFrameUrl(null);
  }, []);

  const announceClosedRoom = useCallback((message: string) => {
    setConnection("offline");
    setWordManagerOpen(false);
    setRoomClosureNotice(message.trim() || "房间已关闭，请确认后返回主界面");
  }, []);

  const confirmClosedRoom = useCallback(() => {
    const message = roomClosureNotice ?? "房间已关闭";
    clearFrame();
    snapshotRef.current = null;
    frameContextRef.current = "";
    avatarSyncKeyRef.current = "";
    setRoomClosureNotice(null);
    setRoomScreen("game");
    setRoomSettingsDraft(null);
    setRestartSubmitting(false);
    setSnapshot(null);
    setConnection("offline");
    setWordOptions([]);
    setWordOptionsActorStepId(null);
    setCurrentWord(null);
    setSavedReplayAvailable(false);
    onSnapshot?.(null);
    reportEntryError(`${message}。你已返回主界面。`);
  }, [clearFrame, onSnapshot, reportEntryError, roomClosureNotice]);

  const applySnapshot = useCallback(
    (next: PublicRoomSnapshot) => {
      setRoomClosureNotice(null);
      const nextContext = drawingContext(next);
      if (frameContextRef.current !== nextContext || !acceptsLiveFrame(next)) {
        clearFrame();
        frameContextRef.current = nextContext;
      }
      const previous = snapshotRef.current;
      if (snapshotInvalidatesRoomSettings(previous, next)) {
        setRoomScreen("game");
        setRoomSettingsDraft(null);
        setRestartSubmitting(false);
      } else {
        setRoomSettingsDraft((draft) => reconcileRoomSettingsDraft(draft, next));
      }
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
          if (acceptsClassicWordOptions(active, message)) {
            setWordOptions(message.options);
            setWordOptionsActorStepId(message.actorStepId);
            setCurrentWord(null);
          }
          break;
        }
        case "classic:word-selected": {
          const active = snapshotRef.current;
          if (acceptsClassicSelectedWord(active, message)) {
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
          setRestartSubmitting(false);
          notify(message.message);
          break;
        case "pong":
          setServerOffset(message.serverNow - Date.now());
          break;
        default:
          break;
      }
    },
    [applySnapshot, notify, onServerMessage, onSnapshot, showFinalizationNotification]
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
      setRoomScreen("game");
      setRoomSettingsDraft(null);
      setRestartSubmitting(false);
    }
  }, [snapshot]);

  useEffect(() => {
    if (roomScreen === "room-settings" && connection !== "connected") {
      setRoomScreen("game");
      setRoomSettingsDraft(null);
      setRestartSubmitting(false);
    }
  }, [connection, roomScreen]);

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
          if (type === "game:restart") {
            setRestartSubmitting(false);
          }
          notify(sendError instanceof Error ? sendError.message : "消息发送失败");
        });
        return;
      }
      const socket = socketRef.current;
      if (!socket || socket.readyState !== WebSocket.OPEN) {
        if (type === "game:restart") {
          setRestartSubmitting(false);
        }
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
      socket.addEventListener("close", (event) => {
        if (disposed) {
          return;
        }
        if (event.code === ROOM_REMOVED_CLOSE_CODE) {
          announceClosedRoom(event.reason);
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
  }, [
    applyFrame,
    handleServerMessage,
    announceClosedRoom,
    notify,
    snapshot?.roomCode,
    transport
  ]);

  useEffect(() => {
    if (!transport) {
      return;
    }
    return transport.onEvent((event) => {
      if (event.kind === "connection") {
        setConnection(event.state);
        if (event.state === "offline" && event.error) {
          announceClosedRoom(event.error);
        } else if (event.error) {
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
  }, [announceClosedRoom, applyFrame, handleServerMessage, notify, send, transport]);

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
    rememberManualNickname(nickname);
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
    rememberManualNickname(nickname);
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
      applySnapshot(response.snapshot);
    } catch (requestError) {
      reportEntryError(
        requestError instanceof Error ? requestError.message : "加入房间失败"
      );
    } finally {
      setBusy(false);
    }
  };

  const openWordManager = useCallback(() => {
    if (
      roomScreen === "room-settings" &&
      roomSettingsDraft &&
      roomSettingsDirty(roomSettingsDraft) &&
      !window.confirm("尚有未应用的设置修改。放弃修改并打开词库管理吗？")
    ) {
      return;
    }
    if (roomScreen === "room-settings") {
      setRoomScreen("game");
      setRoomSettingsDraft(null);
      setRestartSubmitting(false);
    }
    setWordManagerOpen(true);
  }, [roomScreen, roomSettingsDraft]);

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
            onManageWords: openWordManager,
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
      openWordManager,
      send,
      serverOffset,
      snapshot,
      uploadReference,
      uploadWordPool,
      wordOptions,
      wordOptionsActorStepId
    ]
  );

  const openRoomSettings = () => {
    const active = snapshotRef.current;
    if (!active || !canOpenRoomSettings(active)) {
      return;
    }
    // This is intentionally local UI state: opening the page must not alter
    // the authoritative mode phase, timers, capture grant, or other clients.
    setRoomSettingsDraft(createRoomSettingsDraft(active));
    setRestartSubmitting(false);
    setRoomScreen("room-settings");
  };

  const returnToGame = () => {
    if (
      roomSettingsDraft &&
      roomSettingsDirty(roomSettingsDraft) &&
      !window.confirm("尚有未应用的设置修改。放弃修改并返回当前游戏吗？")
    ) {
      return;
    }
    setRoomSettingsDraft(null);
    setRestartSubmitting(false);
    setRoomScreen("game");
  };

  const restoreRoomSettings = () => {
    const active = snapshotRef.current;
    if (!active) {
      return;
    }
    setRoomSettingsDraft(createRoomSettingsDraft(active));
  };

  const changeRoomSettings = (value: GameModeSettings) => {
    setRoomSettingsDraft((draft) =>
      draft ? updateRoomSettingsDraft(draft, value) : draft
    );
  };

  const restartGame = () => {
    const active = snapshotRef.current;
    const draft = roomSettingsDraft;
    if (!active || !draft || restartSubmitting) {
      return;
    }
    if (
      !window.confirm(
        "应用设置将立即结束当前游戏，清空本局进度并开始新的一局。房间成员不会被移除。"
      )
    ) {
      return;
    }
    const partialReplay = requestPartialReplayChoice(active);
    if (partialReplay === null) {
      return;
    }
    try {
      const command = createRestartCommand(active, draft, partialReplay);
      setRestartSubmitting(true);
      send(command);
    } catch (restartError) {
      notify(
        restartError instanceof Error ? restartError.message : "房间设置草稿已经失效"
      );
    }
  };

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
    const partialReplay = requestPartialReplayChoice(active);
    if (partialReplay === null) {
      return;
    }
    send(createSwitchModeCommand(active, targetMode, partialReplay));
  };

  if (wordManagerOpen) {
    return (
      <ThemeSurface
        connection={connection}
        embedded={embeddedThemeRoot}
        mode={snapshot?.game.mode}
        phase={snapshot?.game.phase}
        platform={themePlatform}
        screen={themeScreenOverride ?? "word-manager"}
      >
        <WordPackManager onClose={() => setWordManagerOpen(false)} services={content} />
      </ThemeSurface>
    );
  }
  if (loading) {
    return (
      <ThemeSurface
        connection={connection}
        embedded={embeddedThemeRoot}
        platform={themePlatform}
        screen={themeScreenOverride ?? "loading"}
      >
        <main className="loading-screen" data-ui="loading-state">
          <span className="brand__mark">画</span>
          <p>正在恢复现场…</p>
        </main>
      </ThemeSurface>
    );
  }
  if (!snapshot || !modeProps) {
    return (
      <ThemeSurface
        connection={connection}
        embedded={embeddedThemeRoot}
        platform={themePlatform}
        screen={themeScreenOverride ?? "home"}
      >
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
          initialEntryMode={initialEntryMode}
          joinConnectionControl={joinConnectionControl}
          rememberedNickname={rememberedNickname}
          topbarAddon={topbarAddon}
          onCreate={createRoom}
          onJoin={joinRoom}
          onManageWords={openWordManager}
        />
      </ThemeSurface>
    );
  }

  const isLogicalHost = snapshot.hostId === snapshot.selfPlayerId;
  const isLobby = snapshot.game.phase === "LOBBY";
  const showRoomSettings =
    roomScreen === "room-settings" &&
    isLogicalHost &&
    !isLobby &&
    roomSettingsDraft !== null;
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
    <ThemeSurface
      connection={connection}
      embedded={embeddedThemeRoot}
      mode={snapshot.game.mode}
      phase={snapshot.game.phase}
      platform={themePlatform}
      screen={
        themeScreenOverride ??
        (showRoomSettings ? "room-settings" : isLobby ? "lobby" : "game")
      }
    >
      <div
        className="app-shell"
        data-critical-kind="content"
        data-critical-label="当前游戏页面"
        data-critical-ui="game-screen"
        data-mode={snapshot.game.mode}
        data-phase={snapshot.game.phase.toLowerCase()}
        data-role={isLogicalHost ? "host" : "player"}
        data-ui="game-screen"
      >
        <header className="topbar" data-ui="topbar">
          <div className="brand">
            <span className="brand__mark" aria-hidden="true">
              画
            </span>
            <span>
              <strong>画猜现场</strong>
              <RoomCodeCopyButton
                onCopy={() => void copyRoomCode(snapshot.roomCode)}
                roomCode={snapshot.roomCode}
              />
            </span>
          </div>
          <div className="topbar__status">
            <button
              className="topbar-content-button"
              onClick={openWordManager}
              type="button"
            >
              词库
            </button>
            {isLogicalHost && isLobby ? (
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
            {isLogicalHost && !isLobby && (
              <button
                className="topbar-content-button"
                data-action={showRoomSettings ? "return-to-game" : "open-room-settings"}
                data-critical-kind="action"
                data-critical-label={showRoomSettings ? "返回游戏" : "返回房间设置"}
                data-critical-ui="room-settings-toggle"
                data-ui="room-settings-toggle"
                onClick={showRoomSettings ? returnToGame : openRoomSettings}
                type="button"
              >
                {showRoomSettings ? "返回游戏" : "返回房间"}
              </button>
            )}
            {hostControls && snapshot.runControl.status === "running" && (
              <button
                className="topbar-content-button"
                data-ui="actual-host-pause"
                onClick={() =>
                  void hostControls
                    .pause(snapshot.roomCode)
                    .catch((hostError: unknown) =>
                      notify(
                        hostError instanceof Error ? hostError.message : "暂停失败"
                      )
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
                    void Notification.requestPermission().then(
                      setNotificationPermission
                    )
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

        {showRoomSettings && roomSettingsDraft ? (
          <RoomSettingsScreen
            avatarUrls={avatarUrls}
            busy={restartSubmitting}
            draft={roomSettingsDraft}
            onChange={changeRoomSettings}
            onRestart={restartGame}
            onRestore={restoreRoomSettings}
            onReturnToGame={returnToGame}
            onSwitchMode={switchMode}
            phaseLabel={PHASE_LABELS[snapshot.game.phase] ?? snapshot.game.phase}
            snapshot={snapshot}
          />
        ) : (
          <>
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
                        selected
                          ? "mode-selection-card is-selected"
                          : "mode-selection-card"
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
                  <p>
                    计时、输入与画面上传均已冻结。保留本地画布，等待服务器主机恢复。
                  </p>
                  <div className="settings-actions">
                    {isLogicalHost && (
                      <button
                        className="secondary-button"
                        onClick={openRoomSettings}
                        type="button"
                      >
                        进入房间设置
                      </button>
                    )}
                    {hostControls && (
                      <button
                        className="primary-button"
                        onClick={() =>
                          void hostControls
                            .resume(snapshot.roomCode)
                            .catch((hostError: unknown) =>
                              notify(
                                hostError instanceof Error
                                  ? hostError.message
                                  : "恢复失败"
                              )
                            )
                        }
                        type="button"
                      >
                        恢复全场
                      </button>
                    )}
                  </div>
                </section>
              </div>
            )}
          </>
        )}

        {error && (
          <button
            className="toast"
            data-ui="game-toast"
            onClick={() => setError(null)}
            type="button"
          >
            {error}
          </button>
        )}
        {roomClosureNotice && (
          <RoomClosureDialog
            message={roomClosureNotice}
            onConfirm={confirmClosedRoom}
          />
        )}
      </div>
    </ThemeSurface>
  );
}
