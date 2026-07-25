import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";

import type { PublicPlayer, PublicRoomSnapshot } from "@draw-guess/shared-types";

import { PlayerAvatar } from "../PlayerAvatar.js";
import type { GameAsset } from "./types.js";

export function formatDuration(secondsInput: number): string {
  const seconds = Math.max(0, Math.floor(secondsInput));
  const hours = Math.floor(seconds / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  const rest = seconds % 60;
  return [hours, minutes, rest]
    .map((value) => String(value).padStart(2, "0"))
    .join(":");
}

export function useCountdown(endsAt: number | null, serverOffset: number): number {
  const [value, setValue] = useState(0);
  useEffect(() => {
    const update = () =>
      setValue(
        endsAt
          ? Math.max(0, Math.ceil((endsAt - (Date.now() + serverOffset)) / 1_000))
          : 0
      );
    update();
    const timer = window.setInterval(update, 250);
    return () => window.clearInterval(timer);
  }, [endsAt, serverOffset]);
  return value;
}

export function useAssetUrl(
  path: string | null,
  loadAsset: (path: string) => Promise<GameAsset>
): {
  url: string | null;
  loading: boolean;
  error: string | null;
} {
  const [state, setState] = useState<{
    url: string | null;
    loading: boolean;
    error: string | null;
  }>({ url: null, loading: Boolean(path), error: null });
  useEffect(() => {
    let disposed = false;
    let url: string | null = null;
    if (!path) {
      setState({ url: null, loading: false, error: null });
      return;
    }
    setState({ url: null, loading: true, error: null });
    void loadAsset(path)
      .then((asset) => {
        if (disposed) {
          return;
        }
        const buffer = new ArrayBuffer(asset.bytes.byteLength);
        new Uint8Array(buffer).set(asset.bytes);
        url = URL.createObjectURL(new Blob([buffer], { type: asset.mimeType }));
        setState({ url, loading: false, error: null });
      })
      .catch((error: unknown) => {
        if (!disposed) {
          setState({
            url: null,
            loading: false,
            error: error instanceof Error ? error.message : "图片读取失败"
          });
        }
      });
    return () => {
      disposed = true;
      if (url) {
        URL.revokeObjectURL(url);
      }
    };
  }, [loadAsset, path]);
  return state;
}

export function PlayerRoster({
  snapshot,
  avatarUrls,
  scores,
  activePlayerId,
  detail
}: {
  snapshot: PublicRoomSnapshot;
  avatarUrls: ReadonlyMap<string, string>;
  scores?: Readonly<Record<string, number>>;
  activePlayerId?: string | null;
  detail?: (player: PublicPlayer) => ReactNode;
}) {
  const players = useMemo(
    () =>
      [...snapshot.players].sort((left, right) =>
        scores
          ? (scores[right.id] ?? 0) - (scores[left.id] ?? 0) ||
            left.joinedAt - right.joinedAt
          : left.joinedAt - right.joinedAt
      ),
    [scores, snapshot.players]
  );
  return (
    <div className="player-list" data-ui="player-list">
      {players.map((player, index) => (
        <div className="player-row" data-ui="player-row" key={player.id}>
          <span className="player-row__rank">{String(index + 1).padStart(2, "0")}</span>
          <PlayerAvatar avatarUrl={avatarUrls.get(player.id)} player={player} />
          <span className="player-row__identity">
            <strong>{player.nickname}</strong>
            <span className="player-row__meta">
              {player.isHost && <em>房主</em>}
              {player.id === activePlayerId && <em>当前行动</em>}
              <span className={player.connected ? "online" : "offline"}>
                {player.connected ? "在线" : "离线"}
              </span>
              {detail?.(player)}
            </span>
          </span>
          {scores && (
            <strong className="player-row__score">{scores[player.id] ?? 0}</strong>
          )}
        </div>
      ))}
    </div>
  );
}

export function Chat({
  snapshot,
  send,
  disabledMessage
}: {
  snapshot: PublicRoomSnapshot;
  send: (message: Record<string, unknown>) => void;
  disabledMessage?: string;
}) {
  const [text, setText] = useState("");
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const value = text.trim();
    if (!value) {
      return;
    }
    send({ type: "chat:submit", text: value });
    setText("");
  };
  return (
    <section className="chat-panel panel" data-ui="chat">
      <div className="chat-log" aria-live="polite" data-ui="chat-log">
        {snapshot.chat.length === 0 ? (
          <p className="chat-empty">还没有消息。</p>
        ) : (
          snapshot.chat.map((entry) => (
            <p className={`chat-line chat-line--${entry.kind}`} key={entry.id}>
              {entry.nickname && <strong>{entry.nickname}</strong>}
              <span>{entry.text}</span>
            </p>
          ))
        )}
      </div>
      {disabledMessage ? (
        <p className="drawer-notice">{disabledMessage}</p>
      ) : (
        <form className="chat-form" onSubmit={submit}>
          <label className="sr-only" htmlFor="room-chat-input">
            输入聊天
          </label>
          <input
            id="room-chat-input"
            maxLength={280}
            onChange={(event) => setText(event.target.value)}
            placeholder="输入消息，回车发送…"
            value={text}
          />
          <button type="submit">发送</button>
        </form>
      )}
    </section>
  );
}

export function DrawingPreview({
  frameUrl,
  emptyText,
  alt = "服务器已接受的最新展示画面"
}: {
  frameUrl: string | null;
  emptyText: string;
  alt?: string;
}) {
  return (
    <div className="drawing-board" data-ui="server-accepted-preview">
      {frameUrl ? (
        <img alt={alt} draggable={false} src={frameUrl} />
      ) : (
        <div className="board-empty">
          <span aria-hidden="true">✦</span>
          <strong>{emptyText}</strong>
          <p>这里仅显示服务器实际接受的画面。</p>
        </div>
      )}
      <span className="live-chip">SERVER ACCEPTED</span>
    </div>
  );
}
