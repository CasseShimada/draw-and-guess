import { useEffect, useState } from "react";

import type {
  ClassicModeSettings,
  PublicClassicModeState
} from "@draw-guess/shared-types";

import { WordPoolPanel } from "../../WordPoolPanel.js";
import {
  Chat,
  DrawingPreview,
  PlayerRoster,
  formatDuration,
  useCountdown
} from "../common.js";
import { ModeSettingsFields } from "../ModeSettingsFields.js";
import type { ModeViewProps } from "../types.js";

export function ClassicModeView({
  snapshot,
  game,
  send,
  serverOffset,
  frameUrl,
  wordOptions,
  wordOptionsActorStepId,
  currentWord,
  avatarUrls,
  content,
  uploadWordPool,
  onManageWords,
  notify
}: ModeViewProps & { game: PublicClassicModeState }) {
  const isHost = snapshot.hostId === snapshot.selfPlayerId;
  const isDrawer = game.currentDrawerId === snapshot.selfPlayerId;
  const [settings, setSettings] = useState<ClassicModeSettings>(game.settings);
  const countdown = useCountdown(game.phaseEndsAt, serverOffset);
  const finalizationSeconds = useCountdown(
    game.selfDrawing?.status === "finalizing"
      ? game.selfDrawing.finalizationEndsAt
      : null,
    serverOffset
  );
  useEffect(
    () => setSettings({ ...game.settings }),
    [game.settings.drawingSeconds, game.settings.rounds, game.settings.selectionSeconds]
  );

  if (game.phase === "LOBBY") {
    return (
      <main className="room-layout room-layout--lobby" data-ui="classic-lobby">
        <section className="panel players-panel">
          <div className="panel-heading">
            <div>
              <p className="eyebrow">Classic · {snapshot.players.length} 人</p>
              <h2>经典画猜玩家席</h2>
            </div>
          </div>
          <PlayerRoster
            avatarUrls={avatarUrls}
            scores={game.scores}
            snapshot={snapshot}
          />
        </section>
        <WordPoolPanel
          game={game}
          onManageWords={onManageWords}
          onMessage={notify}
          services={content}
          snapshot={snapshot}
          upload={uploadWordPool}
        />
        <section className="panel settings-panel" data-ui="classic-settings">
          <div className="panel-heading">
            <div>
              <p className="eyebrow">Game setup</p>
              <h2>经典模式设置</h2>
            </div>
            {!isHost && <span className="step-pill">等待房主</span>}
          </div>
          <ModeSettingsFields
            disabled={!isHost}
            idPrefix="classic-lobby-settings"
            onChange={(value) => {
              if (value.mode === "classic") {
                setSettings(value.settings);
              }
            }}
            value={{ mode: "classic", settings }}
          />
          {isHost && (
            <div className="settings-actions">
              <button
                className="secondary-button"
                data-action="save-mode-settings"
                data-ui="secondary-button"
                onClick={() =>
                  send({
                    type: "mode:settings",
                    value: { mode: "classic", settings }
                  })
                }
                type="button"
              >
                保存设置
              </button>
              <button
                className="primary-button"
                data-action="start-game"
                data-critical-kind="action"
                data-critical-label="开始经典画猜"
                data-critical-ui="start-classic-game"
                data-ui="primary-button"
                disabled={game.wordPool.uniqueWordCount < 3}
                onClick={() => send({ type: "game:start" })}
                type="button"
              >
                开始经典画猜
              </button>
            </div>
          )}
        </section>
      </main>
    );
  }

  if (game.phase === "WORD_SELECTION") {
    const drawer = snapshot.players.find(
      (player) => player.id === game.currentDrawerId
    );
    return (
      <main className="center-stage" data-ui="classic-word-selection">
        <div
          className="stage-counter"
          data-critical-kind="content"
          data-critical-label="选词阶段与剩余时间"
          data-critical-ui="classic-selection-status"
          data-ui="timer"
        >
          <span>第 {game.currentRound} 轮</span>
          <strong>{formatDuration(countdown)}</strong>
        </div>
        {isDrawer ? (
          <section className="choice-card">
            <p className="eyebrow">只对你可见</p>
            <h1>挑一个词开始画</h1>
            <div className="word-options">
              {wordOptions.map((option, index) => (
                <button
                  data-action="select-word"
                  data-critical-kind="action"
                  data-critical-label={`选择题目：${option.label}`}
                  data-critical-ui={`classic-word-option-${String(index + 1)}`}
                  data-ui="word-option"
                  key={option.id}
                  onClick={() => {
                    if (wordOptionsActorStepId) {
                      send({
                        type: "classic:word-select",
                        modeSessionId: snapshot.modeSessionId,
                        actorStepId: wordOptionsActorStepId,
                        optionId: option.id
                      });
                    }
                  }}
                  type="button"
                >
                  <span>0{index + 1}</span>
                  <strong>{option.label}</strong>
                  <small>{option.category}</small>
                </button>
              ))}
            </div>
            {wordOptions.length === 0 && <p>正在获取私密候选词…</p>}
          </section>
        ) : (
          <section className="waiting-card">
            <p className="eyebrow">Word selection</p>
            <h1>{drawer?.nickname ?? "画手"} 正在选词</h1>
            <p>候选词只发送给当前画手。</p>
          </section>
        )}
      </main>
    );
  }

  if (game.phase === "DRAWING" || game.phase === "FINALIZING") {
    const drawing = game.selfDrawing;
    const finalizing = game.phase === "FINALIZING";
    return (
      <main className="game-grid" data-ui="classic-drawing">
        <section className="game-main">
          <div className="game-toolbar">
            <strong>
              第 {game.currentRound} 轮 · {finalizing ? "展示收尾" : "绘画中"}
            </strong>
            <div
              className={`timer ${countdown <= 10 ? "timer--urgent" : ""}`}
              data-critical-kind="content"
              data-critical-label="经典模式剩余时间"
              data-critical-ui="classic-timer"
              data-state={countdown <= 10 ? "urgent" : "normal"}
              data-ui="timer"
            >
              <small>{finalizing ? "收尾剩余" : "剩余"}</small>
              <strong>
                {formatDuration(finalizing ? finalizationSeconds : countdown)}
              </strong>
            </div>
          </div>
          {isDrawer && (
            <aside className="secret-strip">
              <span>你的题目</span>
              <strong>{currentWord ?? "正在确认题目…"}</strong>
            </aside>
          )}
          {finalizing && (
            <section
              className="finalization-prompt"
              data-ui="drawing-finalization-prompt"
            >
              <strong>请在外部绘图软件中缩放或平移，完整展示作品</strong>
              <p>服务器会继续接受画面，固定 10 秒后冻结最后一帧。</p>
            </section>
          )}
          <DrawingPreview
            emptyText={isDrawer ? "等待你的第一张同步画面" : "等待画手画面"}
            frameUrl={frameUrl}
          />
          {isDrawer && game.phase === "DRAWING" && drawing?.status === "drawing" && (
            <button
              className="primary-button"
              data-action="finish-drawing"
              data-critical-kind="action"
              data-critical-label="完成绘制"
              data-critical-ui="finish-classic-drawing"
              data-ui="primary-button"
              onClick={() =>
                send({
                  type: "drawing:finish",
                  modeSessionId: snapshot.modeSessionId,
                  actorStepId: drawing.actorStepId
                })
              }
              type="button"
            >
              完成绘制，进入 10 秒展示收尾
            </button>
          )}
          <Chat
            disabledMessage={isDrawer ? "画手不能猜词，可以专心完成画面。" : undefined}
            send={send}
            snapshot={snapshot}
          />
        </section>
        <aside className="scoreboard panel">
          <div className="panel-heading">
            <h2>实时排名</h2>
            <strong>
              {game.turnNumber}/{game.totalTurns}
            </strong>
          </div>
          <PlayerRoster
            activePlayerId={game.currentDrawerId}
            avatarUrls={avatarUrls}
            scores={game.scores}
            snapshot={snapshot}
          />
        </aside>
      </main>
    );
  }

  if (game.phase === "TURN_RESULT") {
    const labels: Record<
      NonNullable<PublicClassicModeState["turnResult"]>["reason"],
      string
    > = {
      TIME_UP: "时间到",
      ALL_GUESSED: "全员猜中",
      DRAWER_DISCONNECTED: "画手离线",
      CAPTURE_UNAVAILABLE: "采集来源不可用",
      ALL_PASSED: "全部画手已 Pass"
    };
    return (
      <main className="center-stage" data-ui="classic-turn-result">
        <section className="result-card">
          <p className="eyebrow">
            {game.turnResult ? labels[game.turnResult.reason] : "回合结束"}
          </p>
          <h1>{game.turnResult?.answer ?? "本回合结束"}</h1>
          <div className="score-changes">
            {game.turnResult?.scoreChanges.map((change) => (
              <span key={change.playerId}>
                {change.nickname} <strong>+{change.points}</strong>
              </span>
            ))}
          </div>
          <small>{countdown > 0 ? `${countdown} 秒后继续` : "正在推进…"}</small>
        </section>
      </main>
    );
  }

  const ranking = [...snapshot.players].sort(
    (left, right) =>
      (game.scores[right.id] ?? 0) - (game.scores[left.id] ?? 0) ||
      left.joinedAt - right.joinedAt
  );
  return (
    <main className="final-stage" data-ui="classic-game-result">
      <section className="final-heading">
        <p className="eyebrow">Game result</p>
        <h1>今晚的画猜榜</h1>
      </section>
      <section className="podium">
        {ranking.map((player, index) => (
          <div className={`podium-row podium-row--${index + 1}`} key={player.id}>
            <span>#{index + 1}</span>
            <strong>{player.nickname}</strong>
            <em>{game.scores[player.id] ?? 0} 分</em>
          </div>
        ))}
      </section>
    </main>
  );
}
