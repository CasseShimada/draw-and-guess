import type {
  ClientJsonMessage,
  EncodedImageMimeType,
  ServerMessagePayload
} from "@draw-guess/protocol";
import type {
  GameModeId,
  PublicModeState,
  PublicPassableActor
} from "@draw-guess/shared-types";

import type { Player, Room, RoomModeRuntime } from "../types.js";
import type { AcceptedFrame } from "../services/frame-store.js";

export type PassCommand = Extract<ClientJsonMessage, { type: "turn:pass" }>;

export type PassEffect =
  | { kind: "handoff-input" }
  | { kind: "withdraw-submission" }
  | { kind: "finalize-current-frame" }
  | { kind: "finish-ballot"; keepExistingLikes: true }
  | {
      kind: "end-without-result";
      reason: "all-passed" | "last-player-passed";
    };

export interface AcceptedModeFrame {
  frame: AcceptedFrame;
  audience: "self" | "room";
}

export type ModeStartReason = "normal" | "restart";
export type ReturnToLobbyReason = "completed" | "restart";

export interface ModeContext {
  room: Room;
  now(): number;
  randomId(bytes?: number): string;
  randomIndex(maximum: number): number;
  allocateCaptureSessionId(): number;
  allocateLogicalTurnId(): number;
  isOpen(player: Player | null | undefined): boolean;
  isCaptureReady(player: Player | null | undefined): boolean;
  sendToPlayer(playerId: string, message: ServerMessagePayload): void;
  broadcast(message: ServerMessagePayload): void;
  broadcastSnapshots(): void;
  issueCapture(input: {
    playerId: string;
    actorStepId: string;
    captureSessionId: number;
    stage: "drawing" | "finalizing";
    expiresAt: number;
  }): boolean;
  revokeCapture(
    playerId: string,
    reason:
      | "session-replaced"
      | "paused"
      | "finalized"
      | "mode-switched"
      | "permission-revoked",
    releaseSource?: boolean
  ): void;
  appendChat(entry: {
    kind: "chat" | "correct" | "system";
    playerId: string | null;
    nickname: string | null;
    text: string;
  }): void;
}

export interface GameModeController<Mode extends GameModeId = GameModeId> {
  readonly id: Mode;
  createLobbyState(): Extract<RoomModeRuntime, { mode: Mode }>["state"];
  publicStateFor(context: ModeContext, viewerId: string): PublicModeState;
  passableActors(context: ModeContext, viewerId: string): PublicPassableActor[];
  updateSettings(context: ModeContext, value: unknown): void;
  start(context: ModeContext, reason?: ModeStartReason): Promise<void> | void;
  returnToLobby(
    context: ModeContext,
    reason?: ReturnToLobbyReason
  ): Promise<void> | void;
  handleCommand(
    context: ModeContext,
    playerId: string,
    command: ClientJsonMessage
  ): Promise<boolean> | boolean;
  resolvePass(
    context: ModeContext,
    command: PassCommand,
    initiatedByHost: boolean
  ): Promise<PassEffect> | PassEffect;
  handleAcceptedFrame(
    context: ModeContext,
    playerId: string,
    captureSessionId: number,
    mimeType: EncodedImageMimeType,
    bytes: Uint8Array
  ): AcceptedModeFrame | null;
  latestFrameForViewer(context: ModeContext, viewerId: string): AcceptedFrame | null;
  onPlayerConnectionChanged(context: ModeContext, playerId: string): void;
  pause(context: ModeContext, at: number): void;
  resume(context: ModeContext, pausedDurationMs: number, captureDelayMs: number): void;
  requiresCaptureOnResume(context: ModeContext): boolean;
  dispose(context: ModeContext, reason: "mode-switch" | "room-destroyed"): void;
}
