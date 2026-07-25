import type { WordPoolUpload } from "@draw-guess/content";
import type {
  ClassicModeSettings,
  DrawRelaySettings,
  PublicChatEntry,
  PublicRunControl,
  ReferenceCopySettings
} from "@draw-guess/shared-types";

import type { RoomAvatar } from "./avatar-service.js";
import type { ClassicModeState } from "./modes/classic/classic-state.js";
import type { DrawRelayModeState } from "./modes/draw-relay/draw-relay-state.js";
import type { ReferenceCopyModeState } from "./modes/reference-copy/reference-copy-state.js";
import type { CaptureGrant } from "./services/capture-grant-service.js";
import type { ModeScheduler } from "./services/mode-scheduler.js";
import type { PasswordDigest } from "./security.js";

export interface GameSocket {
  readonly readyState: number;
  readonly bufferedAmount: number;
  send(
    data: string | Uint8Array,
    options?: { binary?: boolean; compress?: boolean }
  ): void;
  close(code?: number, reason?: string): void;
}

export interface Player {
  id: string;
  nickname: string;
  joinedAt: number;
  socket: GameSocket | null;
  clientKind: "browser" | "desktop" | null;
  captureReady: boolean;
  uploadGrant: CaptureGrant | null;
  lastFrameAt: number | null;
  frameDrainTimer: NodeJS.Timeout | null;
  pendingFramePacket: Uint8Array | null;
  avatar: RoomAvatar | null;
}

export type RoomModeRuntime =
  | {
      mode: "classic";
      state: ClassicModeState;
    }
  | {
      mode: "reference-copy";
      state: ReferenceCopyModeState;
    }
  | {
      mode: "draw-relay";
      state: DrawRelayModeState;
    };

export interface RoomModePreferences {
  classic: {
    settings: ClassicModeSettings;
    wordPool: WordPoolUpload;
  };
  "reference-copy": {
    settings: ReferenceCopySettings;
  };
  "draw-relay": {
    settings: DrawRelaySettings;
    wordPool: WordPoolUpload;
  };
}

export interface Room {
  roomCode: string;
  password: PasswordDigest;
  hostId: string;
  players: Map<string, Player>;
  chat: PublicChatEntry[];
  lastActivityAt: number;
  modeSessionId: string;
  modeRuntime: RoomModeRuntime;
  modePreferences: RoomModePreferences;
  modeScheduler: ModeScheduler;
  runControl: PublicRunControl;
  nextCaptureSessionId: number;
  nextLogicalTurnId: number;
  processedCommandIds: Map<string, number>;
  modeTransitioning: boolean;
  lastReplayJobId: string | null;
  hostGraceTimer: NodeJS.Timeout | null;
  drawerGraceTimers: Map<string, NodeJS.Timeout>;
}
