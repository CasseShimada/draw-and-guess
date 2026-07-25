import type { NormalizedPoolWord, WordDeck } from "@draw-guess/content";
import type {
  ClassicModeSettings,
  ClassicPhase,
  PublicTurnResult,
  WordOption
} from "@draw-guess/shared-types";

import type { RoomWordPool } from "../../room-content.js";
import type { InternalDrawingLifecycle } from "../../services/drawing-finalization-service.js";
import type { LatestFrameStore } from "../../services/frame-store.js";

export interface ClassicDrawerTurn {
  playerId: string;
  round: number;
}

export interface ClassicModeState {
  phase: ClassicPhase;
  settings: ClassicModeSettings;
  configuredWordPool: RoomWordPool;
  gameWordPool: RoomWordPool | null;
  wordDeck: WordDeck | null;
  wordPoolUpdatedAt: number | null;
  scores: Map<string, number>;
  drawerQueue: ClassicDrawerTurn[];
  drawerIndex: number;
  currentDrawerId: string | null;
  currentTurnId: number;
  currentRound: number;
  currentOptions: WordOption[];
  currentOptionWords: Map<string, NormalizedPoolWord>;
  selectedWord: NormalizedPoolWord | null;
  correctGuesserIds: Set<string>;
  turnScoreStart: Map<string, number>;
  phaseEndsAt: number | null;
  turnResult: PublicTurnResult | null;
  pendingTurnEndReason: PublicTurnResult["reason"];
  actorStepId: string | null;
  drawing: InternalDrawingLifecycle | null;
  passedPlayerIds: Set<string>;
  eligibleHandoffPlayerIds: string[];
  frameStore: LatestFrameStore;
}
