import { useEffect, useRef, type ReactNode } from "react";

import type { GameModeId, PublicRoomSnapshot } from "@draw-guess/shared-types";

import { RoomCodeCopyButton } from "../RoomCodeCopyButton.js";
import { GAME_MODE_DESCRIPTIONS, GAME_MODE_LABELS } from "../modes/registry.js";
import type { ActualHostControls } from "../modes/types.js";

export type ConnectionState = "connecting" | "connected" | "reconnecting" | "offline";

export function ThemeSurface({
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

export function ConnectionStatus({ state }: { state: ConnectionState }) {
  const labels: Record<ConnectionState, string> = {
    connecting: "连接中",
    connected: "已连接",
    reconnecting: "重连中",
    offline: "已离线"
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

export function AppTopBar({
  connection,
  menu,
  modeLabel,
  onCopyRoomCode,
  phaseLabel,
  roomCode
}: {
  connection: ConnectionState;
  menu: ReactNode;
  modeLabel: string;
  onCopyRoomCode: () => void;
  phaseLabel: string;
  roomCode: string;
}) {
  return (
    <header className="topbar" data-ui="topbar">
      <div className="brand">
        <span className="brand__mark" aria-hidden="true">
          画
        </span>
        <strong>画猜现场</strong>
      </div>
      <div className="topbar__room">
        <RoomCodeCopyButton onCopy={onCopyRoomCode} roomCode={roomCode} />
      </div>
      <div className="topbar__status">
        <span className="mode-chip">{modeLabel}</span>
        <span className="phase-label">{phaseLabel}</span>
        <ConnectionStatus state={connection} />
        {menu}
      </div>
    </header>
  );
}

export function AppMoreMenu({
  auxiliaryAction,
  busy,
  desktopControl,
  notificationAction,
  onLeave,
  onManageWords,
  showWordManager
}: {
  auxiliaryAction?: ReactNode;
  busy: boolean;
  desktopControl?: ReactNode;
  notificationAction?: ReactNode;
  onLeave: () => void;
  onManageWords: () => void;
  showWordManager: boolean;
}) {
  return (
    <details className="app-more-menu" data-ui="app-more-menu">
      <summary aria-label="打开更多房间功能">更多</summary>
      <div className="app-more-menu__popover">
        <div className="app-more-menu__heading">
          <strong>房间工具</strong>
          <small>游戏外的辅助功能集中在这里</small>
        </div>
        {desktopControl}
        {showWordManager && (
          <button
            className="menu-action"
            data-action="manage-word-packs"
            onClick={onManageWords}
            type="button"
          >
            词库管理
          </button>
        )}
        {notificationAction}
        {auxiliaryAction}
        <div className="app-more-menu__danger">
          <small>离开当前房间并返回首页；房主离开时房间也会结束。</small>
          <button
            className="danger-button"
            data-action="leave-room"
            data-critical-kind="action"
            data-critical-label="退出房间"
            data-critical-ui="leave-room"
            data-ui="leave-room"
            disabled={busy}
            onClick={onLeave}
            type="button"
          >
            {busy ? "正在退出…" : "退出房间"}
          </button>
        </div>
      </div>
    </details>
  );
}

function PassActions({
  snapshot,
  send
}: {
  snapshot: PublicRoomSnapshot;
  send: (message: Record<string, unknown>) => void;
}) {
  const effectText = {
    "handoff-input": "跳过当前输入并交给下一位",
    "withdraw-submission": "退出本次临摹且不提交作品",
    "finalize-current-frame": "立即以服务器已接受的画面定稿",
    "finish-ballot": "保留已点赞作品并跳过剩余匿名作品"
  } as const;

  return (
    <>
      {snapshot.passableActors.map((actor) => {
        const player = snapshot.players.find(
          (candidate) => candidate.id === actor.targetPlayerId
        );
        const self = actor.targetPlayerId === snapshot.selfPlayerId;
        const text = effectText[actor.effect];
        return (
          <button
            className="secondary-button"
            data-action="pass-turn"
            data-critical-kind="action"
            data-critical-label={`Pass：${self ? text : (player?.nickname ?? "玩家")}`}
            data-critical-ui={`pass-${actor.actorStepId}`}
            data-ui="secondary-button"
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
    </>
  );
}

function isResultPhase(snapshot: PublicRoomSnapshot): boolean {
  return (
    (snapshot.game.mode === "classic" && snapshot.game.phase === "GAME_RESULT") ||
    (snapshot.game.mode === "reference-copy" && snapshot.game.phase === "GALLERY") ||
    (snapshot.game.mode === "draw-relay" && snapshot.game.phase === "RESULT")
  );
}

export function ContextActionBar({
  hostControls,
  isLogicalHost,
  onOpenSettings,
  onPause,
  send,
  snapshot
}: {
  hostControls?: ActualHostControls;
  isLogicalHost: boolean;
  onOpenSettings: () => void;
  onPause: () => void;
  send: (message: Record<string, unknown>) => void;
  snapshot: PublicRoomSnapshot;
}) {
  const canReturnToLobby = isLogicalHost && isResultPhase(snapshot);
  const canPause =
    hostControls !== undefined &&
    snapshot.game.phase !== "LOBBY" &&
    snapshot.runControl.status === "running";
  const hasActions = snapshot.passableActors.length > 0 || isLogicalHost || canPause;

  if (
    snapshot.game.phase === "LOBBY" ||
    snapshot.runControl.status === "paused" ||
    !hasActions
  ) {
    return null;
  }

  return (
    <nav
      aria-label="当前阶段操作"
      className="context-action-bar"
      data-ui="context-action-bar"
    >
      <div className="context-action-bar__label">
        <span>当前阶段</span>
        <strong>{GAME_MODE_LABELS[snapshot.game.mode]}</strong>
      </div>
      <div className="context-action-bar__actions">
        {snapshot.passableActors.length > 0 && (
          <PassActions send={send} snapshot={snapshot} />
        )}
        {canPause && (
          <button
            className="secondary-button"
            data-action="pause-game"
            data-ui="actual-host-pause"
            onClick={onPause}
            type="button"
          >
            暂停全场
          </button>
        )}
        {isLogicalHost && !canReturnToLobby && (
          <button
            className="secondary-button"
            data-action="open-room-settings"
            data-critical-kind="action"
            data-critical-label="打开本局设置"
            data-critical-ui="room-settings-toggle"
            data-ui="room-settings-toggle"
            onClick={onOpenSettings}
            type="button"
          >
            本局设置
          </button>
        )}
        {canReturnToLobby && (
          <button
            className="primary-button"
            data-action="return-to-lobby"
            data-critical-kind="action"
            data-critical-label="返回房间大厅"
            data-critical-ui="return-to-lobby"
            data-ui="primary-button"
            onClick={() => send({ type: "game:return-lobby" })}
            type="button"
          >
            返回房间大厅
          </button>
        )}
      </div>
    </nav>
  );
}

export function LobbyModeSelector({
  onSwitchMode,
  snapshot
}: {
  onSwitchMode: (mode: GameModeId) => void;
  snapshot: PublicRoomSnapshot;
}) {
  if (snapshot.hostId !== snapshot.selfPlayerId) {
    return (
      <section className="lobby-mode-summary" data-ui="lobby-mode-summary">
        <span className="eyebrow">本局模式</span>
        <strong>{GAME_MODE_LABELS[snapshot.game.mode]}</strong>
        <p>{GAME_MODE_DESCRIPTIONS[snapshot.game.mode]}</p>
      </section>
    );
  }

  return (
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
            onClick={() => onSwitchMode(mode)}
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
  );
}

export function LobbyLayout({
  children,
  modeSelector,
  sidebar
}: {
  children: ReactNode;
  modeSelector: ReactNode;
  sidebar: ReactNode;
}) {
  return (
    <div className="lobby-workspace" data-ui="lobby-layout">
      <section className="lobby-workspace__main">
        <div className="lobby-workspace__heading">
          <div>
            <p className="eyebrow">Room setup</p>
            <h1>选好玩法，等朋友到齐</h1>
          </div>
          <span>房主完成本局设置后即可开始</span>
        </div>
        {modeSelector}
        {children}
      </section>
      <aside className="lobby-workspace__sidebar" aria-label="房间状态与个人设置">
        {sidebar}
      </aside>
    </div>
  );
}

export function GameWorkspace({
  actionBar,
  children
}: {
  actionBar: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="game-workspace" data-ui="game-workspace">
      {actionBar}
      <div className="game-workspace__stage">{children}</div>
    </div>
  );
}
