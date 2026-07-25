import type { GameModeId } from "@draw-guess/shared-types";

export interface CaptureGrant {
  permission: "frame:upload";
  roomCode: string;
  playerId: string;
  socketIdentity: object;
  mode: GameModeId;
  modeSessionId: string;
  actorStepId: string;
  captureSessionId: number;
  stage: "drawing" | "finalizing";
  expiresAt: number;
}

export class CaptureGrantService {
  issue(input: Omit<CaptureGrant, "permission">): CaptureGrant {
    return { permission: "frame:upload", ...input };
  }

  validates(
    grant: CaptureGrant | null,
    input: {
      roomCode: string;
      playerId: string;
      socketIdentity: object;
      mode: GameModeId;
      modeSessionId: string;
      captureSessionId: number;
      now: number;
    }
  ): grant is CaptureGrant {
    return Boolean(
      grant &&
      grant.permission === "frame:upload" &&
      grant.roomCode === input.roomCode &&
      grant.playerId === input.playerId &&
      grant.socketIdentity === input.socketIdentity &&
      grant.mode === input.mode &&
      grant.modeSessionId === input.modeSessionId &&
      grant.captureSessionId === input.captureSessionId &&
      grant.expiresAt > input.now
    );
  }
}
