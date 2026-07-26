import { useEffect, useState, type FormEvent } from "react";

import type {
  DrawRelaySettings,
  PublicDrawRelayModeState
} from "@draw-guess/shared-types";
import type { RelayPrivateTask } from "@draw-guess/protocol";

import { WordPoolPanel } from "../../WordPoolPanel.js";
import {
  Chat,
  DrawingPreview,
  PlayerRoster,
  formatDuration,
  useAssetUrl,
  useCountdown
} from "../common.js";
import { ModeSettingsFields } from "../ModeSettingsFields.js";
import type { ModeViewProps } from "../types.js";

export function DrawRelayModeView({
  snapshot,
  game,
  send,
  serverOffset,
  frameUrl,
  avatarUrls,
  content,
  uploadWordPool,
  onManageWords,
  loadRelayTask,
  loadAsset,
  hostControls,
  notify
}: ModeViewProps & { game: PublicDrawRelayModeState }) {
  const isHost = snapshot.hostId === snapshot.selfPlayerId;
  const [settings, setSettings] = useState<DrawRelaySettings>(game.settings);
  const [task, setTask] = useState<RelayPrivateTask | null>(null);
  const [taskError, setTaskError] = useState<string | null>(null);
  const [guess, setGuess] = useState("");
  const activeTask = game.selfTask;
  const activeTaskId = activeTask?.actorStepId ?? null;
  const taskArtifactPath =
    task?.kind === "drawing" && task.available && task.revision
      ? `/api/rooms/${snapshot.roomCode}/relay/artifacts/${task.artifactId}/${task.revision}`
      : null;
  const taskAsset = useAssetUrl(taskArtifactPath, loadAsset);
  const countdown = useCountdown(game.phaseEndsAt, serverOffset);
  const finalizationCountdown = useCountdown(
    game.selfDrawing?.status === "finalizing"
      ? game.selfDrawing.finalizationEndsAt
      : null,
    serverOffset
  );

  useEffect(
    () => setSettings({ ...game.settings }),
    [game.settings.drawingSeconds, game.settings.guessingSeconds]
  );
  useEffect(() => {
    let disposed = false;
    setTask(null);
    setTaskError(null);
    if (!activeTaskId) {
      return;
    }
    void loadRelayTask(activeTaskId)
      .then((value) => {
        if (!disposed) {
          setTask(value);
        }
      })
      .catch((error: unknown) => {
        if (!disposed) {
          setTaskError(error instanceof Error ? error.message : "接龙私密任务读取失败");
        }
      });
    return () => {
      disposed = true;
    };
  }, [activeTaskId, loadRelayTask]);

  useEffect(() => {
    if (
      activeTask?.kind !== "drawing" ||
      activeTask.ready ||
      task?.kind !== "drawing"
    ) {
      return;
    }
    if (task.available && (!task.revision || !taskAsset.url)) {
      return;
    }
    send({
      type: "relay:task-ready",
      modeSessionId: snapshot.modeSessionId,
      actorStepId: activeTask.actorStepId,
      revision: task.revision
    });
  }, [activeTask, send, snapshot.modeSessionId, task, taskAsset.url]);

  if (game.phase === "LOBBY") {
    const capability = snapshot.replayCapability;
    const selfConfirmed = game.recordingConfirmedPlayerIds.includes(
      snapshot.selfPlayerId
    );
    const canStart =
      capability.available &&
      snapshot.players.length >= 2 &&
      snapshot.players.every(
        (player) =>
          player.captureReady && game.recordingConfirmedPlayerIds.includes(player.id)
      );
    return (
      <main className="room-layout room-layout--lobby" data-ui="relay-lobby">
        <section className="panel recording-notice" data-ui="relay-recording-notice">
          <div className="panel-heading">
            <div>
              <p className="eyebrow">Visible recording notice</p>
              <h2>本局会记录服务器已接受的绘画帧</h2>
            </div>
            <span className="step-pill">
              {capability.available ? "FFmpeg 可用" : "不可用"}
            </span>
          </div>
          <p>
            不录制整块桌面、系统光标、聊天、麦克风或暂停时间。最终 MP4
            仅保存在实际主机电脑，由房主手动分发。
          </p>
          {!capability.available ? (
            <p className="inline-error" data-ui="ffmpeg-unavailable">
              {capability.message}
            </p>
          ) : (
            <p>
              {capability.ffmpegVersion} · {capability.encoder}
            </p>
          )}
          <button
            className={selfConfirmed ? "secondary-button" : "primary-button"}
            data-action="confirm-recording"
            data-critical-kind="action"
            data-critical-label="确认接龙录像说明"
            data-critical-ui="relay-recording-consent"
            data-ui={selfConfirmed ? "secondary-button" : "primary-button"}
            onClick={() =>
              send({
                type: "relay:recording-consent",
                modeSessionId: snapshot.modeSessionId,
                confirmed: !selfConfirmed
              })
            }
            type="button"
          >
            {selfConfirmed ? "已确认录制提示（点击撤回）" : "我已了解并确认"}
          </button>
        </section>
        <section className="panel players-panel">
          <div className="panel-heading">
            <h2>接龙顺序将在开始时随机冻结</h2>
          </div>
          <PlayerRoster
            avatarUrls={avatarUrls}
            detail={(player) => (
              <span>
                {game.recordingConfirmedPlayerIds.includes(player.id)
                  ? "已确认"
                  : "待确认"}
                {" · "}
                {player.captureReady ? "采集已准备" : "采集未准备"}
              </span>
            )}
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
        <section className="panel settings-panel" data-ui="relay-settings">
          <div className="panel-heading">
            <h2>接龙行动时间</h2>
          </div>
          <ModeSettingsFields
            disabled={!isHost}
            idPrefix="relay-lobby-settings"
            onChange={(value) => {
              if (value.mode === "draw-relay") {
                setSettings(value.settings);
              }
            }}
            value={{ mode: "draw-relay", settings }}
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
                    value: { mode: "draw-relay", settings }
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
                data-critical-label="开始绘画接龙"
                data-critical-ui="start-relay-game"
                data-ui="primary-button"
                disabled={!canStart}
                onClick={() => send({ type: "game:start" })}
                type="button"
              >
                随机顺序并开始接龙
              </button>
            </div>
          )}
          {!canStart && isHost && (
            <p className="inline-warning">
              需要 FFmpeg、至少两人、全员确认录制提示与桌面采集。
            </p>
          )}
        </section>
      </main>
    );
  }

  if (game.phase === "PREPARING" || game.phase === "COUNTDOWN") {
    const isActive = game.activePlayerId === snapshot.selfPlayerId;
    return (
      <main className="center-stage" data-ui="relay-preparing">
        {isActive ? (
          <section className="choice-card private-task">
            <p className="eyebrow">只对你可见 · 私密接龙输入</p>
            {task?.kind === "word" ? (
              <>
                <h1>{task.word}</h1>
                <p>请在外部绘图软件中画这个词。其他玩家看不到它。</p>
                {!activeTask?.ready && (
                  <button
                    className="primary-button"
                    data-action="ready-private-task"
                    data-critical-kind="action"
                    data-critical-label="确认私密接龙任务"
                    data-critical-ui="relay-task-ready"
                    data-ui="primary-button"
                    onClick={() =>
                      send({
                        type: "relay:task-ready",
                        modeSessionId: snapshot.modeSessionId,
                        actorStepId: task.actorStepId,
                        revision: null
                      })
                    }
                    type="button"
                  >
                    题目已看清，开始 3 秒倒计时
                  </button>
                )}
                {game.phase === "COUNTDOWN" && (
                  <strong>{formatDuration(countdown)}</strong>
                )}
              </>
            ) : (
              <p>{taskError ?? "正在安全读取私密任务…"}</p>
            )}
          </section>
        ) : (
          <section className="waiting-card">
            <p className="eyebrow">Relay waiting</p>
            <h1>等待当前玩家准备</h1>
            <p>题目、画面和猜词在结果揭晓前保持私密。</p>
          </section>
        )}
      </main>
    );
  }

  if (game.phase === "GUESSING") {
    const isActive = game.activePlayerId === snapshot.selfPlayerId;
    const submit = (event: FormEvent) => {
      event.preventDefault();
      const value = guess.trim();
      if (!value || !activeTaskId) {
        return;
      }
      send({
        type: "relay:submit-guess",
        modeSessionId: snapshot.modeSessionId,
        actorStepId: activeTaskId,
        guess: value
      });
      setGuess("");
    };
    return (
      <main className="center-stage" data-ui="relay-guessing">
        {isActive ? (
          <section className="choice-card private-task">
            <p className="eyebrow">只对你可见 · 看画猜词</p>
            {taskAsset.url ? (
              <img
                alt="上一位玩家冻结的接龙画面"
                className="reference-image"
                data-critical-kind="content"
                data-critical-label="当前私密接龙画面"
                data-critical-ui="relay-private-image"
                data-ui="private-task-image"
                src={taskAsset.url}
              />
            ) : (
              <p>{taskError ?? taskAsset.error ?? "正在加载私密画面…"}</p>
            )}
            {activeTask?.ready && (
              <form className="entry-form" onSubmit={submit}>
                <label>
                  你的猜词
                  <input
                    autoComplete="off"
                    data-critical-kind="input"
                    data-critical-label="接龙猜词输入"
                    data-critical-ui="relay-guess-input"
                    data-ui="guess-input"
                    maxLength={80}
                    onChange={(event) => setGuess(event.target.value)}
                    value={guess}
                  />
                </label>
                <button
                  className="primary-button"
                  data-action="submit-relay-guess"
                  data-critical-kind="action"
                  data-critical-label="提交接龙猜词"
                  data-critical-ui="relay-guess-submit"
                  data-ui="primary-button"
                  type="submit"
                >
                  私密提交 · {formatDuration(countdown)}
                </button>
              </form>
            )}
          </section>
        ) : (
          <section className="waiting-card">
            <p className="eyebrow">Private guessing</p>
            <h1>当前玩家正在猜词</h1>
            <p>猜词不会写入聊天，也不会在本局结束前公开。</p>
          </section>
        )}
      </main>
    );
  }

  if (game.phase === "DRAWING" || game.phase === "FINALIZING") {
    const isActive = game.activePlayerId === snapshot.selfPlayerId;
    const drawing = game.selfDrawing;
    return (
      <main className="game-grid" data-ui="relay-drawing">
        <section className="game-main">
          <div className="game-toolbar">
            <strong>{game.phase === "FINALIZING" ? "展示收尾" : "绘画接龙中"}</strong>
            <span
              className="timer"
              data-critical-kind="content"
              data-critical-label="接龙绘画剩余时间"
              data-critical-ui="relay-timer"
              data-ui="timer"
            >
              {formatDuration(
                game.phase === "FINALIZING" ? finalizationCountdown : countdown
              )}
            </span>
          </div>
          {isActive && task?.kind === "word" && (
            <aside className="secret-strip">
              <span>你的私密绘画提示</span>
              <strong>{task.word}</strong>
            </aside>
          )}
          {game.phase === "FINALIZING" && isActive && (
            <section
              className="finalization-prompt"
              data-ui="drawing-finalization-prompt"
            >
              <strong>请缩放或平移，完整展示作品</strong>
              <p>固定 10 秒后冻结；Pass 会立即采用当前已同步画面。</p>
            </section>
          )}
          <DrawingPreview
            emptyText={isActive ? "等待你的第一张同步画面" : "当前画面保持私密"}
            frameUrl={isActive ? frameUrl : null}
          />
          {isActive && drawing?.status === "drawing" && (
            <button
              className="primary-button"
              data-action="finish-drawing"
              data-critical-kind="action"
              data-critical-label="完成接龙绘制"
              data-critical-ui="finish-relay-drawing"
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
          <Chat send={send} snapshot={snapshot} />
        </section>
        <aside className="panel scoreboard">
          <div className="panel-heading">
            <h2>冻结的随机顺序</h2>
            <strong>
              {game.stepIndex + 1}/{game.totalSteps}
            </strong>
          </div>
          <PlayerRoster
            activePlayerId={game.activePlayerId}
            avatarUrls={avatarUrls}
            detail={(player) => (
              <span>
                {game.order.find((entry) => entry.playerId === player.id)?.status ??
                  "waiting"}
              </span>
            )}
            snapshot={snapshot}
          />
        </aside>
      </main>
    );
  }

  const result = game.result;
  return (
    <main className="relay-result" data-ui="relay-result">
      <section className="final-heading">
        <p className="eyebrow">Relay reveal</p>
        <h1>
          {result?.startingWord ?? "起始词"} → {result?.finalGuess ?? "未作答"}
        </h1>
        <p>最终状态：{result?.finalGuessReason ?? "all-passed"}</p>
      </section>
      <section className="relay-chain">
        {result?.history.map((entry, index) =>
          entry.kind === "guess" ? (
            <article className="relay-chain__guess" key={`guess:${index}`}>
              <strong>
                {snapshot.players.find((player) => player.id === entry.playerId)
                  ?.nickname ?? "玩家"}
              </strong>
              <span>{entry.guess ?? `未作答（${entry.status}）`}</span>
            </article>
          ) : (
            <RelayResultDrawing
              author={
                snapshot.players.find((player) => player.id === entry.playerId)
                  ?.nickname ?? "玩家"
              }
              key={`draw:${index}`}
              loadAsset={loadAsset}
              path={
                entry.resultArtifactId && result
                  ? `/api/rooms/${snapshot.roomCode}/relay/results/${result.resultId}/artifacts/${entry.resultArtifactId}`
                  : null
              }
              status={entry.status}
            />
          )
        )}
      </section>
      <section className="panel replay-status" data-ui="relay-replay-status">
        <h2>主机本地回放</h2>
        <p>
          {game.replay.status === "saved"
            ? `已保存 ${(game.replay.byteLength / 1024 / 1024).toFixed(1)} MiB`
            : game.replay.status === "failed" || game.replay.status === "unavailable"
              ? game.replay.message
              : game.replay.status}
        </p>
        {hostControls?.replay && game.replay.status === "saved" && (
          <div className="settings-actions">
            <button
              onClick={() => void hostControls.replay!.openFile(snapshot.roomCode)}
              type="button"
            >
              播放本地 MP4
            </button>
            <button
              onClick={() => void hostControls.replay!.openFolder(snapshot.roomCode)}
              type="button"
            >
              打开所在目录
            </button>
          </div>
        )}
        {hostControls?.replay &&
          game.replay.status === "failed" &&
          game.replay.canRetry && (
            <button
              className="primary-button"
              onClick={() =>
                void hostControls
                  .replay!.retry(snapshot.roomCode)
                  .catch((error: unknown) =>
                    notify(error instanceof Error ? error.message : "回放重试失败")
                  )
              }
              type="button"
            >
              修复设置后重试压制
            </button>
          )}
        {!hostControls?.replay && <p>回放保存在实际主机电脑，请向房主手动索取。</p>}
      </section>
      {isHost && (
        <button
          className="primary-button"
          data-action="return-to-lobby"
          data-critical-kind="action"
          data-critical-label="返回接龙模式大厅"
          data-critical-ui="return-relay-lobby"
          data-ui="primary-button"
          onClick={() => send({ type: "game:return-lobby" })}
          type="button"
        >
          返回接龙大厅
        </button>
      )}
    </main>
  );
}

function RelayResultDrawing({
  path,
  loadAsset,
  author,
  status
}: {
  path: string | null;
  loadAsset: ModeViewProps["loadAsset"];
  author: string;
  status: string;
}) {
  const asset = useAssetUrl(path, loadAsset);
  return (
    <article className="relay-chain__drawing">
      <strong>{author}</strong>
      {asset.url ? (
        <img alt={`${author} 的接龙画面`} src={asset.url} />
      ) : (
        <span>{status === "completed" ? "画面不可用" : status}</span>
      )}
    </article>
  );
}
