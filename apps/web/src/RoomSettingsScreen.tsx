import type {
  GameModeId,
  GameModeSettings,
  PublicRoomSnapshot
} from "@draw-guess/shared-types";

import { ModeSettingsFields } from "./modes/ModeSettingsFields.js";
import { GAME_MODE_DESCRIPTIONS, GAME_MODE_LABELS } from "./modes/registry.js";
import { PlayerRoster } from "./modes/common.js";
import { roomSettingsDirty, type RoomSettingsDraft } from "./room-settings-state.js";

export function RoomSettingsScreen({
  busy,
  draft,
  onChange,
  onRestart,
  onRestore,
  onReturnToGame,
  onSwitchMode,
  phaseLabel,
  snapshot,
  avatarUrls
}: {
  busy: boolean;
  draft: RoomSettingsDraft;
  onChange: (value: GameModeSettings) => void;
  onRestart: () => void;
  onRestore: () => void;
  onReturnToGame: () => void;
  onSwitchMode: (mode: GameModeId) => void;
  phaseLabel: string;
  snapshot: PublicRoomSnapshot;
  avatarUrls: ReadonlyMap<string, string>;
}) {
  const dirty = roomSettingsDirty(draft);
  const paused = snapshot.runControl.status === "paused";

  return (
    <main className="room-settings-screen" data-ui="room-settings-screen">
      <section
        className={
          paused
            ? "room-settings-status room-settings-status--paused"
            : "room-settings-status"
        }
        role="status"
      >
        <div>
          <p className="eyebrow">Host room control</p>
          <h1>{paused ? "游戏会话仍在进行（当前已暂停）" : "游戏仍在进行"}</h1>
          <p>
            当前为 {GAME_MODE_LABELS[snapshot.game.mode]} · {phaseLabel}。房间{" "}
            <code>{snapshot.roomCode}</code>
          </p>
        </div>
        <div>
          <strong>
            {paused
              ? "应用并重启会退出暂停状态。"
              : "其他玩家仍在游戏中，计时器不会暂停。"}
          </strong>
          <span>你可能仍是当前行动玩家，打开此页面不会停止桌面截图采集。</span>
        </div>
      </section>

      <div className="room-settings-layout">
        <section className="panel players-panel">
          <div className="panel-heading">
            <div>
              <p className="eyebrow">Room members · {snapshot.players.length} 人</p>
              <h2>房间玩家</h2>
            </div>
            <span className="step-pill">成员保持在线</span>
          </div>
          <PlayerRoster avatarUrls={avatarUrls} snapshot={snapshot} />
        </section>

        <section className="panel room-settings-mode-panel">
          <div className="panel-heading">
            <div>
              <p className="eyebrow">Game mode</p>
              <h2>模式选择</h2>
            </div>
          </div>
          <p className="inline-warning">
            切换到不同模式会结束当前游戏并进入目标模式大厅，不会自动开始。
          </p>
          <div className="room-settings-mode-list">
            {(Object.keys(GAME_MODE_LABELS) as GameModeId[]).map((mode) => {
              const selected = mode === snapshot.game.mode;
              const unavailable =
                mode === "draw-relay" &&
                snapshot.game.mode !== "draw-relay" &&
                !snapshot.replayCapability.available;
              return (
                <button
                  aria-pressed={selected}
                  className={selected ? "is-selected" : ""}
                  disabled={selected || unavailable || busy}
                  key={mode}
                  onClick={() => onSwitchMode(mode)}
                  type="button"
                >
                  <strong>{GAME_MODE_LABELS[mode]}</strong>
                  <span>{GAME_MODE_DESCRIPTIONS[mode]}</span>
                  {selected && <small>当前模式</small>}
                </button>
              );
            })}
          </div>
        </section>

        <section
          className="panel settings-panel room-settings-editor"
          data-ui="active-game-settings"
        >
          <div className="panel-heading">
            <div>
              <p className="eyebrow">Restart parameters</p>
              <h2>{GAME_MODE_LABELS[draft.value.mode]}设置草稿</h2>
            </div>
            <span className="step-pill">{dirty ? "有未应用修改" : "当前设置"}</span>
          </div>
          <ModeSettingsFields
            disabled={busy}
            idPrefix="active-room-settings"
            onChange={onChange}
            value={draft.value}
          />
          <section className="room-settings-resource-lock" role="note">
            <strong>内容资源保持只读</strong>
            <p>内容资源请在游戏大厅中修改；进行中的游戏仅支持调整重启参数。</p>
            <p>重启同一模式会保留已配置的词库或参考图，不会在后台上传或删除资源。</p>
          </section>
          <div className="room-settings-actions">
            <button
              className="secondary-button"
              disabled={busy}
              onClick={onReturnToGame}
              type="button"
            >
              返回游戏
            </button>
            <button
              className="secondary-button"
              disabled={!dirty || busy}
              onClick={onRestore}
              type="button"
            >
              恢复当前设置
            </button>
            <button
              className="primary-button"
              data-ui="apply-and-restart"
              disabled={busy}
              onClick={onRestart}
              type="button"
            >
              {busy ? "正在应用并重启…" : "应用并重启游戏"}
            </button>
          </div>
        </section>
      </div>
    </main>
  );
}
