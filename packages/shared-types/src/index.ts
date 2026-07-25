export const GAME_MODE_IDS = ["classic", "reference-copy", "draw-relay"] as const;

export type GameModeId = (typeof GAME_MODE_IDS)[number];

export const CLASSIC_PHASES = [
  "LOBBY",
  "WORD_SELECTION",
  "DRAWING",
  "FINALIZING",
  "TURN_RESULT",
  "GAME_RESULT"
] as const;

export const REFERENCE_COPY_PHASES = [
  "LOBBY",
  "PREPARING",
  "COUNTDOWN",
  "DRAWING",
  "FINALIZING",
  "BLIND_VOTING",
  "GALLERY"
] as const;

export const DRAW_RELAY_PHASES = [
  "LOBBY",
  "PREPARING",
  "COUNTDOWN",
  "DRAWING",
  "FINALIZING",
  "GUESSING",
  "RESULT"
] as const;

export type ClassicPhase = (typeof CLASSIC_PHASES)[number];
export type ReferenceCopyPhase = (typeof REFERENCE_COPY_PHASES)[number];
export type DrawRelayPhase = (typeof DRAW_RELAY_PHASES)[number];
export type GamePhaseId = ClassicPhase | ReferenceCopyPhase | DrawRelayPhase;

export interface ClassicModeSettings {
  drawingSeconds: number;
  selectionSeconds: number;
  rounds: number;
}

export interface ReferenceCopySettings {
  durationSeconds: number;
  votingSeconds: number;
}

export interface DrawRelaySettings {
  drawingSeconds: number;
  guessingSeconds: number;
}

export type GameModeSettings =
  | { mode: "classic"; settings: ClassicModeSettings }
  | { mode: "reference-copy"; settings: ReferenceCopySettings }
  | { mode: "draw-relay"; settings: DrawRelaySettings };

export const DEFAULT_CLASSIC_SETTINGS: ClassicModeSettings = {
  drawingSeconds: 60,
  selectionSeconds: 15,
  rounds: 2
};

export const DEFAULT_REFERENCE_COPY_SETTINGS: ReferenceCopySettings = {
  durationSeconds: 600,
  votingSeconds: 120
};

export const DEFAULT_DRAW_RELAY_SETTINGS: DrawRelaySettings = {
  drawingSeconds: 60,
  guessingSeconds: 30
};

export interface PublicPlayer {
  id: string;
  nickname: string;
  isHost: boolean;
  connected: boolean;
  clientKind: "browser" | "desktop" | null;
  captureReady: boolean;
  avatarRevision: string | null;
  joinedAt: number;
}

export interface PublicWordPoolSummary {
  revision: string;
  packs: Array<{
    name: string;
    selectedCategoryNames: string[];
    enabledWordCount: number;
  }>;
  uniqueWordCount: number;
}

export interface PublicChatEntry {
  id: string;
  kind: "chat" | "correct" | "system";
  playerId: string | null;
  nickname: string | null;
  text: string;
  createdAt: number;
}

export interface PublicTurnResult {
  answer: string;
  reason:
    | "TIME_UP"
    | "ALL_GUESSED"
    | "DRAWER_DISCONNECTED"
    | "CAPTURE_UNAVAILABLE"
    | "ALL_PASSED";
  scoreChanges: Array<{
    playerId: string;
    nickname: string;
    points: number;
  }>;
}

export interface WordOption {
  id: string;
  label: string;
  category: string;
}

export type PublicRunControl =
  | { status: "idle" }
  | {
      status: "running";
      resumedAt: number | null;
      captureResumesAt: number | null;
    }
  | {
      status: "paused";
      pausedAt: number;
      pausedBy: "server-host";
      phaseAtPause: GamePhaseId;
    };

export type ReplayHostCapability =
  | {
      available: true;
      ffmpegVersion: string;
      executableSource: "path" | "configured";
      encoder: "libx264" | "mpeg4";
    }
  | {
      available: false;
      reasonCode:
        | "not-configured"
        | "not-found"
        | "not-executable"
        | "probe-failed"
        | "no-supported-encoder"
        | "output-not-writable"
        | "insufficient-space";
      message: string;
    };

export type PublicReplayStatus =
  | { status: "unavailable"; message: string }
  | { status: "idle" }
  | { status: "recording" }
  | { status: "preparing" }
  | { status: "encoding"; progress: number | null }
  | { status: "saved"; byteLength: number }
  | { status: "failed"; message: string; canRetry: boolean };

export type PublicDrawingLifecycle =
  | {
      status: "drawing";
      actorStepId: string;
      drawingEndsAt: number;
      captureSessionId: number;
      acceptedSequence: number;
      acceptedRevision: string | null;
    }
  | {
      status: "finalizing";
      actorStepId: string;
      finalizationStartedAt: number;
      finalizationEndsAt: number;
      captureSessionId: number;
      acceptedSequence: number;
      acceptedRevision: string | null;
      baselineAcceptedRevision: string | null;
      notificationEventId: string;
    }
  | {
      status: "finalized";
      actorStepId: string;
      finalRevision: string | null;
      finalizedBy: "deadline" | "self-pass" | "host-pass";
    };

export interface PublicPassableActor {
  actorStepId: string;
  targetPlayerId: string;
  phase: GamePhaseId;
  effect:
    | "handoff-input"
    | "withdraw-submission"
    | "finalize-current-frame"
    | "finish-ballot";
}

export interface PublicClassicModeState {
  mode: "classic";
  phase: ClassicPhase;
  settings: ClassicModeSettings;
  wordPool: PublicWordPoolSummary;
  scores: Record<string, number>;
  currentDrawerId: string | null;
  currentTurnId: number;
  currentRound: number;
  totalRounds: number;
  turnNumber: number;
  totalTurns: number;
  phaseEndsAt: number | null;
  correctGuesserIds: string[];
  passedPlayerIds: string[];
  turnResult: PublicTurnResult | null;
  selfDrawing: PublicDrawingLifecycle | null;
}

export interface PublicReferenceAsset {
  isSet: boolean;
  revision: string | null;
  mimeType: "image/png" | "image/jpeg" | "image/webp" | null;
  width: number | null;
  height: number | null;
  byteLength: number | null;
}

export interface PublicReferenceParticipant {
  playerId: string;
  status:
    | "preparing"
    | "countdown"
    | "drawing"
    | "finalizing"
    | "finalized"
    | "passed"
    | "no-submission";
  connected: boolean;
  ready: boolean;
  hasAcceptedFrame: boolean;
}

export interface PublicReferenceBallot {
  ballotId: string;
  actorStepId: string;
  items: Array<{
    ballotItemId: string;
    liked: boolean;
  }>;
  cursor: number;
  status: "active" | "completed" | "passed" | "timed-out";
  likedCount: number;
}

export interface PublicReferenceGalleryEntry {
  resultItemId: string;
  authorId: string;
  likes: number;
  winner: boolean;
}

export interface PublicReferenceParticipantResult {
  playerId: string;
  status: "finalized" | "passed" | "no-submission";
  resultItemId: string | null;
}

export interface PublicReferenceCopyModeState {
  mode: "reference-copy";
  phase: ReferenceCopyPhase;
  settings: ReferenceCopySettings;
  reference: PublicReferenceAsset;
  participants: PublicReferenceParticipant[];
  preparingEndsAt: number | null;
  startsAt: number | null;
  endsAt: number | null;
  votingEndsAt: number | null;
  selfDrawing: PublicDrawingLifecycle | null;
  selfBallot: PublicReferenceBallot | null;
  gallery: {
    resultId: string;
    entries: PublicReferenceGalleryEntry[];
    participants: PublicReferenceParticipantResult[];
  } | null;
}

export interface PublicRelayPlayer {
  playerId: string;
  position: number;
  status: "waiting" | "active" | "completed" | "passed" | "timed-out";
}

export type PublicRelayTaskDescriptor =
  | {
      actorStepId: string;
      kind: "word";
      ready: boolean;
    }
  | {
      actorStepId: string;
      kind: "drawing";
      ready: boolean;
      artifactAvailable: boolean;
    };

export type PublicRelayResultEntry =
  | {
      kind: "draw";
      playerId: string;
      status: "completed" | "passed" | "timed-out" | "no-frame";
      resultArtifactId: string | null;
    }
  | {
      kind: "guess";
      playerId: string;
      status: "completed" | "passed" | "timed-out";
      guess: string | null;
    };

export interface PublicDrawRelayModeState {
  mode: "draw-relay";
  phase: DrawRelayPhase;
  settings: DrawRelaySettings;
  wordPool: PublicWordPoolSummary;
  order: PublicRelayPlayer[];
  activePlayerId: string | null;
  stepIndex: number;
  totalSteps: number;
  startsAt: number | null;
  phaseEndsAt: number | null;
  recordingConfirmedPlayerIds: string[];
  selfTask: PublicRelayTaskDescriptor | null;
  selfDrawing: PublicDrawingLifecycle | null;
  replay: PublicReplayStatus;
  result: {
    resultId: string;
    startingWord: string;
    finalGuess: string | null;
    finalGuessReason: "completed" | "pass" | "timeout" | "all-passed";
    history: PublicRelayResultEntry[];
  } | null;
}

export type PublicModeState =
  PublicClassicModeState | PublicReferenceCopyModeState | PublicDrawRelayModeState;

export interface PublicRoomSnapshot {
  roomCode: string;
  hostId: string;
  selfPlayerId: string;
  modeSessionId: string;
  players: PublicPlayer[];
  chat: PublicChatEntry[];
  serverNow: number;
  runControl: PublicRunControl;
  replayCapability: ReplayHostCapability;
  passableActors: PublicPassableActor[];
  game: PublicModeState;
}

export function assertNever(value: never, message = "未处理的判别联合成员"): never {
  throw new Error(`${message}: ${JSON.stringify(value)}`);
}

/** @deprecated Use ClassicModeSettings. */
export type GameSettings = ClassicModeSettings;
/** @deprecated Use DEFAULT_CLASSIC_SETTINGS. */
export const DEFAULT_GAME_SETTINGS = DEFAULT_CLASSIC_SETTINGS;
/** @deprecated Use ClassicPhase. */
export type GamePhase = ClassicPhase;
/** @deprecated Use CLASSIC_PHASES. */
export const GAME_PHASES = CLASSIC_PHASES;
