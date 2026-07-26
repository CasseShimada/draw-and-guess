import { useEffect, useRef, useState, type ChangeEvent } from "react";

import type {
  PublicReferenceCopyModeState,
  ReferenceCopySettings
} from "@draw-guess/shared-types";

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

function participantLabel(
  status: PublicReferenceCopyModeState["participants"][number]["status"]
): string {
  const labels = {
    preparing: "正在加载参考图",
    countdown: "准备完成",
    drawing: "绘制中",
    finalizing: "展示收尾",
    finalized: "已完成",
    passed: "已 Pass",
    "no-submission": "未收到画面"
  } as const;
  return labels[status];
}

export function ReferenceCopyModeView({
  snapshot,
  game,
  send,
  serverOffset,
  frameUrl,
  avatarUrls,
  uploadReference,
  deleteReference,
  loadAsset,
  notify
}: ModeViewProps & { game: PublicReferenceCopyModeState }) {
  const isHost = snapshot.hostId === snapshot.selfPlayerId;
  const [settings, setSettings] = useState<ReferenceCopySettings>(game.settings);
  const [uploading, setUploading] = useState(false);
  const [ballotIndex, setBallotIndex] = useState(0);
  const readyKeyRef = useRef("");
  const referencePath =
    game.reference.revision && game.phase !== "LOBBY"
      ? `/api/rooms/${snapshot.roomCode}/reference/${game.reference.revision}`
      : game.reference.revision && isHost
        ? `/api/rooms/${snapshot.roomCode}/reference/${game.reference.revision}`
        : null;
  const referenceAsset = useAssetUrl(referencePath, loadAsset);
  const ballot = game.selfBallot;
  const safeBallotIndex = ballot
    ? Math.min(Math.max(0, ballotIndex), Math.max(0, ballot.items.length - 1))
    : 0;
  const ballotItem = ballot?.items[safeBallotIndex] ?? null;
  const ballotPath =
    ballot && ballotItem
      ? `/api/rooms/${snapshot.roomCode}/reference-ballots/${ballot.ballotId}/items/${ballotItem.ballotItemId}`
      : null;
  const ballotAsset = useAssetUrl(ballotPath, loadAsset);
  const drawingCountdown = useCountdown(game.endsAt, serverOffset);
  const phaseCountdown = useCountdown(
    game.preparingEndsAt ?? game.startsAt ?? game.votingEndsAt,
    serverOffset
  );
  const finalizationCountdown = useCountdown(
    game.selfDrawing?.status === "finalizing"
      ? game.selfDrawing.finalizationEndsAt
      : null,
    serverOffset
  );

  useEffect(
    () => setSettings({ ...game.settings }),
    [game.settings.durationSeconds, game.settings.votingSeconds]
  );
  useEffect(() => {
    if (ballot) {
      setBallotIndex(ballot.cursor);
    }
  }, [ballot?.ballotId, ballot?.cursor]);
  useEffect(() => setBallotIndex(ballot?.cursor ?? 0), [ballot?.ballotId]);

  const upload = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) {
      return;
    }
    if (
      file.type !== "image/png" &&
      file.type !== "image/jpeg" &&
      file.type !== "image/webp"
    ) {
      notify("请选择静态 PNG、JPEG 或 WebP");
      return;
    }
    setUploading(true);
    try {
      const result = await uploadReference(file);
      notify(
        `参考图已规范化：${result.width}×${result.height} · ${(
          result.byteLength /
          1024 /
          1024
        ).toFixed(2)} MiB`
      );
    } catch (error) {
      notify(error instanceof Error ? error.message : "参考图上传失败");
    } finally {
      setUploading(false);
    }
  };

  const removeReference = async () => {
    try {
      await deleteReference();
      notify("参考图已删除");
    } catch (error) {
      notify(error instanceof Error ? error.message : "参考图删除失败");
    }
  };

  const markReferenceReady = () => {
    if (game.phase !== "PREPARING" || !game.reference.revision) {
      return;
    }
    const key = `${snapshot.modeSessionId}:${game.reference.revision}`;
    if (readyKeyRef.current === key) {
      return;
    }
    readyKeyRef.current = key;
    send({
      type: "reference:ready",
      modeSessionId: snapshot.modeSessionId,
      referenceRevision: game.reference.revision
    });
  };

  if (game.phase === "LOBBY") {
    const canStart =
      game.reference.isSet &&
      snapshot.players.length >= 2 &&
      snapshot.players.every((player) => player.captureReady);
    return (
      <main className="room-layout room-layout--lobby" data-ui="reference-lobby">
        <section className="panel players-panel">
          <div className="panel-heading">
            <div>
              <p className="eyebrow">Reference copy</p>
              <h2>并行临摹参与者</h2>
            </div>
          </div>
          <PlayerRoster
            avatarUrls={avatarUrls}
            detail={(player) => (
              <span>{player.captureReady ? "采集已准备" : "需要桌面采集"}</span>
            )}
            snapshot={snapshot}
          />
        </section>
        <section className="panel reference-upload" data-ui="reference-upload">
          <div className="panel-heading">
            <div>
              <p className="eyebrow">Host only · Memory only</p>
              <h2>参考图</h2>
            </div>
            <span className="step-pill">
              {game.reference.isSet ? "已设置" : "未设置"}
            </span>
          </div>
          {isHost && (
            <div className="settings-actions">
              <label className="secondary-button file-button">
                {uploading ? "正在规范化…" : "选择静态图片"}
                <input
                  accept="image/png,image/jpeg,image/webp"
                  disabled={uploading}
                  onChange={(event) => void upload(event)}
                  type="file"
                />
              </label>
              {game.reference.isSet && (
                <button
                  className="secondary-button"
                  onClick={() => void removeReference()}
                  type="button"
                >
                  删除参考图
                </button>
              )}
            </div>
          )}
          {referenceAsset.url && (
            <img
              alt="房主设置的临摹参考图"
              className="reference-image"
              src={referenceAsset.url}
            />
          )}
          <p className="muted">
            服务器仅在当前房间内存中保存规范化版本；切换模式或清理房间会释放。
          </p>
        </section>
        <section className="panel settings-panel" data-ui="reference-settings">
          <div className="panel-heading">
            <h2>临摹与盲选时长</h2>
          </div>
          <ModeSettingsFields
            disabled={!isHost}
            idPrefix="reference-lobby-settings"
            onChange={(value) => {
              if (value.mode === "reference-copy") {
                setSettings(value.settings);
              }
            }}
            value={{ mode: "reference-copy", settings }}
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
                    value: { mode: "reference-copy", settings }
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
                data-critical-label="开始参考图临摹"
                data-critical-ui="start-reference-game"
                data-ui="primary-button"
                disabled={!canStart}
                onClick={() => send({ type: "game:start" })}
                type="button"
              >
                开始并预加载参考图
              </button>
            </div>
          )}
          {!canStart && isHost && (
            <p className="inline-warning">
              至少两名玩家、参考图和全员桌面采集准备完成后才能开始。
            </p>
          )}
        </section>
      </main>
    );
  }

  if (game.phase === "PREPARING" || game.phase === "COUNTDOWN") {
    return (
      <main className="center-stage" data-ui="reference-preparing">
        <section
          className="choice-card reference-preparing-card"
          data-critical-kind="content"
          data-critical-label="参考图与准备倒计时"
          data-critical-ui="reference-preparing-content"
        >
          <p className="eyebrow">
            {game.phase === "PREPARING" ? "预加载参考图" : "统一倒计时"}
          </p>
          <h1>{formatDuration(phaseCountdown)}</h1>
          {referenceAsset.url ? (
            <img
              alt="临摹参考图"
              className="reference-image"
              data-critical-kind="content"
              data-critical-label="当前临摹参考图"
              data-critical-ui="reference-image"
              data-ui="reference-image"
              onLoad={markReferenceReady}
              src={referenceAsset.url}
            />
          ) : (
            <p>{referenceAsset.error ?? "正在下载并解码参考图…"}</p>
          )}
          <PlayerRoster
            avatarUrls={avatarUrls}
            detail={(player) => {
              const participant = game.participants.find(
                (candidate) => candidate.playerId === player.id
              );
              return <span>{participant?.ready ? "已就绪" : "正在加载"}</span>;
            }}
            snapshot={snapshot}
          />
        </section>
      </main>
    );
  }

  if (game.phase === "DRAWING" || game.phase === "FINALIZING") {
    const selfDrawing = game.selfDrawing;
    return (
      <main className="reference-drawing" data-ui="reference-drawing">
        <section className="reference-split">
          <article>
            <h2>参考图</h2>
            {referenceAsset.url && (
              <img
                alt="临摹参考图"
                className="reference-image"
                data-critical-kind="content"
                data-critical-label="当前临摹参考图"
                data-critical-ui="reference-image"
                data-ui="reference-image"
                src={referenceAsset.url}
              />
            )}
          </article>
          <article>
            <h2>我的服务器展示画面</h2>
            <DrawingPreview emptyText="等待本人第一张同步画面" frameUrl={frameUrl} />
          </article>
        </section>
        <section className="panel reference-status">
          <div className="game-toolbar">
            <strong>
              {selfDrawing?.status === "finalizing"
                ? "展示收尾：请缩放或平移，完整展示作品"
                : "并行临摹中"}
            </strong>
            <span
              className="timer"
              data-critical-kind="content"
              data-critical-label="临摹剩余时间"
              data-critical-ui="reference-timer"
              data-ui="timer"
            >
              {formatDuration(
                selfDrawing?.status === "finalizing"
                  ? finalizationCountdown
                  : drawingCountdown
              )}
            </span>
          </div>
          {selfDrawing?.status === "finalizing" && (
            <p data-ui="drawing-finalization-prompt">
              固定 10 秒收尾正在进行。Pass 会立即采用当前已同步画面。
            </p>
          )}
          {selfDrawing?.status === "drawing" && (
            <button
              className="primary-button"
              data-action="finish-drawing"
              data-critical-kind="action"
              data-critical-label="完成临摹"
              data-critical-ui="finish-reference-drawing"
              data-ui="primary-button"
              onClick={() =>
                send({
                  type: "drawing:finish",
                  modeSessionId: snapshot.modeSessionId,
                  actorStepId: selfDrawing.actorStepId
                })
              }
              type="button"
            >
              完成绘制，进入展示收尾
            </button>
          )}
          <div className="participant-status-grid">
            {game.participants.map((participant) => (
              <span key={participant.playerId}>
                {snapshot.players.find((player) => player.id === participant.playerId)
                  ?.nickname ?? "玩家"}
                ：{participantLabel(participant.status)}
                {participant.hasAcceptedFrame ? " · 已收到画面" : ""}
              </span>
            ))}
          </div>
        </section>
        <Chat send={send} snapshot={snapshot} />
      </main>
    );
  }

  if (game.phase === "BLIND_VOTING") {
    return (
      <main className="blind-voting" data-ui="reference-blind-voting">
        <section className="reference-split">
          <article>
            <h2>参考图</h2>
            {referenceAsset.url && (
              <img
                alt="临摹参考图"
                className="reference-image"
                src={referenceAsset.url}
              />
            )}
          </article>
          <article data-ui="anonymous-ballot-item">
            <div className="panel-heading">
              <h2>
                匿名作品 {ballot ? safeBallotIndex + 1 : 0}/{ballot?.items.length ?? 0}
              </h2>
              <strong>{formatDuration(phaseCountdown)}</strong>
            </div>
            {ballotAsset.url ? (
              <img
                alt={`匿名临摹作品 ${safeBallotIndex + 1}`}
                className="reference-image"
                data-critical-kind="content"
                data-critical-label="当前匿名投票作品"
                data-critical-ui="reference-ballot-image"
                data-ui="ballot-image"
                src={ballotAsset.url}
              />
            ) : (
              <p>{ballotAsset.error ?? "正在读取匿名作品…"}</p>
            )}
            {ballot && ballot.status === "active" && ballotItem && (
              <>
                <label className="like-toggle">
                  <input
                    data-critical-kind="input"
                    data-critical-label="作品点赞选项"
                    data-critical-ui="reference-like-input"
                    data-ui="vote-input"
                    checked={ballotItem.liked}
                    onChange={(event) =>
                      send({
                        type: "reference:set-like",
                        modeSessionId: snapshot.modeSessionId,
                        ballotId: ballot.ballotId,
                        ballotItemId: ballotItem.ballotItemId,
                        liked: event.target.checked
                      })
                    }
                    type="checkbox"
                  />
                  喜欢这幅作品
                </label>
                <div className="settings-actions">
                  <button
                    disabled={safeBallotIndex === 0}
                    onClick={() => {
                      const nextIndex = safeBallotIndex - 1;
                      const nextItem = ballot.items[nextIndex];
                      if (nextItem) {
                        setBallotIndex(nextIndex);
                        send({
                          type: "reference:set-like",
                          modeSessionId: snapshot.modeSessionId,
                          ballotId: ballot.ballotId,
                          ballotItemId: nextItem.ballotItemId,
                          liked: nextItem.liked
                        });
                      }
                    }}
                    type="button"
                  >
                    上一幅
                  </button>
                  <button
                    disabled={safeBallotIndex + 1 >= ballot.items.length}
                    onClick={() => {
                      const nextIndex = safeBallotIndex + 1;
                      const nextItem = ballot.items[nextIndex];
                      if (nextItem) {
                        setBallotIndex(nextIndex);
                        send({
                          type: "reference:set-like",
                          modeSessionId: snapshot.modeSessionId,
                          ballotId: ballot.ballotId,
                          ballotItemId: nextItem.ballotItemId,
                          liked: nextItem.liked
                        });
                      }
                    }}
                    type="button"
                  >
                    下一幅
                  </button>
                  <button
                    className="primary-button"
                    data-action="finish-voting"
                    data-critical-kind="action"
                    data-critical-label="完成匿名投票"
                    data-critical-ui="finish-reference-voting"
                    data-ui="primary-button"
                    onClick={() =>
                      send({
                        type: "reference:finish-ballot",
                        modeSessionId: snapshot.modeSessionId,
                        ballotId: ballot.ballotId
                      })
                    }
                    type="button"
                  >
                    完成盲选
                  </button>
                </div>
                <p>已点赞 {ballot.likedCount} 幅；揭晓前不显示作者与总票数。</p>
              </>
            )}
          </article>
        </section>
      </main>
    );
  }

  const gallery = game.gallery;
  return (
    <main className="reference-gallery" data-ui="reference-gallery">
      <section className="final-heading">
        <p className="eyebrow">Gallery</p>
        <h1>临摹作品揭晓</h1>
      </section>
      <section className="gallery-grid">
        {gallery?.entries.map((entry) => (
          <GalleryItem
            author={
              snapshot.players.find((player) => player.id === entry.authorId)
                ?.nickname ?? "玩家"
            }
            key={entry.resultItemId}
            likes={entry.likes}
            loadAsset={loadAsset}
            path={`/api/rooms/${snapshot.roomCode}/reference-results/${gallery.resultId}/items/${entry.resultItemId}`}
            winner={entry.winner}
          />
        ))}
        {gallery?.entries.length === 0 && <p>本局没有有效作品。</p>}
      </section>
      {isHost && (
        <button
          className="primary-button"
          data-action="return-to-lobby"
          data-critical-kind="action"
          data-critical-label="返回临摹模式大厅"
          data-critical-ui="return-reference-lobby"
          data-ui="primary-button"
          onClick={() => send({ type: "game:return-lobby" })}
          type="button"
        >
          返回临摹大厅
        </button>
      )}
    </main>
  );
}

function GalleryItem({
  path,
  loadAsset,
  author,
  likes,
  winner
}: {
  path: string;
  loadAsset: ModeViewProps["loadAsset"];
  author: string;
  likes: number;
  winner: boolean;
}) {
  const asset = useAssetUrl(path, loadAsset);
  return (
    <article className={winner ? "gallery-item gallery-item--winner" : "gallery-item"}>
      {asset.url && <img alt={`${author} 的临摹作品`} src={asset.url} />}
      <strong>{author}</strong>
      <span>{likes} 赞</span>
      {winner && <em>并列获胜</em>}
    </article>
  );
}
