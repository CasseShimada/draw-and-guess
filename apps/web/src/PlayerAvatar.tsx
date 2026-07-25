import { useEffect, useState } from "react";

import type { PublicPlayer } from "@draw-guess/shared-types";

const PLACEHOLDER_COLORS = ["#f4c84b", "#b8ddd7", "#f4b4aa", "#c8c1e8"];

function stableColor(playerId: string): string {
  let hash = 0x811c9dc5;
  for (const character of playerId) {
    hash = Math.imul(hash ^ character.charCodeAt(0), 0x01000193);
  }
  return PLACEHOLDER_COLORS[(hash >>> 0) % PLACEHOLDER_COLORS.length]!;
}

export function PlayerAvatar({
  player,
  avatarUrl,
  className = ""
}: {
  player: Pick<PublicPlayer, "id" | "nickname" | "avatarRevision">;
  avatarUrl?: string | null;
  className?: string;
}) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [avatarUrl]);
  const showImage = Boolean(player.avatarRevision && avatarUrl && !failed);
  return (
    <span
      className={`avatar player-avatar ${showImage ? "player-avatar--image" : ""} ${className}`}
      data-ui="player-avatar"
      style={showImage ? undefined : { background: stableColor(player.id) }}
    >
      {showImage ? (
        <img
          alt={`${player.nickname} 的头像`}
          draggable={false}
          onError={() => setFailed(true)}
          src={avatarUrl ?? undefined}
        />
      ) : (
        <span aria-hidden="true">{[...player.nickname][0] ?? "?"}</span>
      )}
    </span>
  );
}
