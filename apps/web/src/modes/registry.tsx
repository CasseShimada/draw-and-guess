import type { ReactNode } from "react";

import type { GameModeId } from "@draw-guess/shared-types";

import { ClassicModeView } from "./classic/ClassicModeView.js";
import { DrawRelayModeView } from "./draw-relay/DrawRelayModeView.js";
import { ReferenceCopyModeView } from "./reference-copy/ReferenceCopyModeView.js";
import type { ModeViewProps } from "./types.js";

export const GAME_MODE_LABELS = {
  classic: "经典你画我猜",
  "reference-copy": "参考图临摹",
  "draw-relay": "绘画接龙"
} as const;

export const GAME_MODE_DESCRIPTIONS: Record<GameModeId, string> = {
  classic: "轮流画、猜词、计分",
  "reference-copy": "全员同时根据参考图绘制，结束后展示作品",
  "draw-relay": "按随机顺序看图猜词再绘制，结束后回看完整传递过程"
};

type RegisteredModeRenderer = (props: ModeViewProps) => ReactNode;

const MODE_RENDERERS = {
  classic: (props) => {
    const game = props.snapshot.game;
    if (game.mode !== "classic") {
      throw new Error("经典模式 renderer 收到不匹配的公开状态");
    }
    return <ClassicModeView {...props} game={game} />;
  },
  "reference-copy": (props) => {
    const game = props.snapshot.game;
    if (game.mode !== "reference-copy") {
      throw new Error("临摹模式 renderer 收到不匹配的公开状态");
    }
    return <ReferenceCopyModeView {...props} game={game} />;
  },
  "draw-relay": (props) => {
    const game = props.snapshot.game;
    if (game.mode !== "draw-relay") {
      throw new Error("接龙模式 renderer 收到不匹配的公开状态");
    }
    return <DrawRelayModeView {...props} game={game} />;
  }
} satisfies Record<GameModeId, RegisteredModeRenderer>;

export function ModeRenderer(props: ModeViewProps) {
  return MODE_RENDERERS[props.snapshot.game.mode](props);
}
