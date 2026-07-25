import type { NormalizedPoolWord } from "@draw-guess/content";
import type {
  DrawRelayPhase,
  DrawRelaySettings,
  PublicReplayStatus
} from "@draw-guess/shared-types";

import type { RoomWordPool } from "../../room-content.js";
import type { InternalDrawingLifecycle } from "../../services/drawing-finalization-service.js";
import type { AcceptedFrame, LatestFrameStore } from "../../services/frame-store.js";

export type RelayImmutableInput =
  | {
      kind: "word";
      wordId: string;
      text: string;
      contentHash: string;
    }
  | {
      kind: "drawing";
      artifactId: string;
      revision: string | null;
      contentHash: string;
      frame: AcceptedFrame | null;
    };

export interface RelayArtifact {
  artifactId: string;
  frame: AcceptedFrame | null;
}

export type RelayHistoryEntry =
  | {
      kind: "draw";
      playerId: string;
      input: RelayImmutableInput;
      artifact: RelayArtifact | null;
      status: "completed" | "passed" | "timed-out" | "no-frame";
    }
  | {
      kind: "guess";
      playerId: string;
      inputArtifactId: string;
      guess: string | null;
      status: "completed" | "passed" | "timed-out";
    };

export interface RelayActorStep {
  actorStepId: string;
  playerId: string;
  position: number;
  kind: "drawing" | "guessing";
  immutableInput: RelayImmutableInput;
  drawingPrompt: Extract<RelayImmutableInput, { kind: "word" }> | null;
  ready: boolean;
  drawing: InternalDrawingLifecycle | null;
  submittedGuess: string | null;
}

export interface RelayResult {
  resultId: string;
  startingWord: string;
  finalGuess: string | null;
  finalGuessReason: "completed" | "pass" | "timeout" | "all-passed";
  resultArtifactIds: Map<string, string>;
}

export interface DrawRelayModeState {
  phase: DrawRelayPhase;
  settings: DrawRelaySettings;
  configuredWordPool: RoomWordPool;
  wordPoolUpdatedAt: number | null;
  gameWordPool: RoomWordPool | null;
  recordingConfirmedPlayerIds: Set<string>;
  participantOrder: string[];
  cursor: number;
  startingWord: NormalizedPoolWord | null;
  activeStep: RelayActorStep | null;
  history: RelayHistoryEntry[];
  artifacts: Map<string, RelayArtifact>;
  startsAt: number | null;
  phaseEndsAt: number | null;
  result: RelayResult | null;
  replayJobId: string | null;
  replay: PublicReplayStatus;
  frameStore: LatestFrameStore;
  passedPlayerIds: Set<string>;
  replayStartedAt: number | null;
  replayPausedAt: number | null;
  replayPausedTotalMs: number;
}
