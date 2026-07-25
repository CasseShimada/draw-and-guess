import { FINAL_PRESENTATION_GRACE_MS } from "@draw-guess/game-rules";
import type { PublicDrawingLifecycle } from "@draw-guess/shared-types";

import type { AcceptedFrame } from "./frame-store.js";

export type InternalDrawingLifecycle =
  | {
      status: "drawing";
      actorStepId: string;
      playerId: string;
      drawingEndsAt: number;
      captureSessionId: number;
      latest: AcceptedFrame | null;
    }
  | {
      status: "finalizing";
      actorStepId: string;
      playerId: string;
      finalizationStartedAt: number;
      finalizationEndsAt: number;
      captureSessionId: number;
      baseline: AcceptedFrame | null;
      latest: AcceptedFrame | null;
      notificationEventId: string;
    }
  | {
      status: "finalized";
      actorStepId: string;
      playerId: string;
      finalFrame: AcceptedFrame | null;
      finalizedBy: "deadline" | "self-pass" | "host-pass";
    };

export interface BeginFinalizationInput {
  drawing: Extract<InternalDrawingLifecycle, { status: "drawing" }>;
  now: number;
  captureSessionId: number;
  notificationEventId: string;
}

export function beginDrawingFinalization(
  input: BeginFinalizationInput
): Extract<InternalDrawingLifecycle, { status: "finalizing" }> {
  return {
    status: "finalizing",
    actorStepId: input.drawing.actorStepId,
    playerId: input.drawing.playerId,
    finalizationStartedAt: input.now,
    finalizationEndsAt: input.now + FINAL_PRESENTATION_GRACE_MS,
    captureSessionId: input.captureSessionId,
    baseline: input.drawing.latest,
    latest: input.drawing.latest,
    notificationEventId: input.notificationEventId
  };
}

export function finalizeDrawing(
  drawing: Extract<InternalDrawingLifecycle, { status: "finalizing" }>,
  finalizedBy: "deadline" | "self-pass" | "host-pass"
): Extract<InternalDrawingLifecycle, { status: "finalized" }> {
  return {
    status: "finalized",
    actorStepId: drawing.actorStepId,
    playerId: drawing.playerId,
    finalFrame: drawing.latest ?? drawing.baseline,
    finalizedBy
  };
}

export function publicDrawingLifecycle(
  drawing: InternalDrawingLifecycle | null
): PublicDrawingLifecycle | null {
  if (!drawing) {
    return null;
  }
  switch (drawing.status) {
    case "drawing":
      return {
        status: "drawing",
        actorStepId: drawing.actorStepId,
        drawingEndsAt: drawing.drawingEndsAt,
        captureSessionId: drawing.captureSessionId,
        acceptedSequence: drawing.latest?.sequence ?? 0,
        acceptedRevision: drawing.latest?.revision ?? null
      };
    case "finalizing":
      return {
        status: "finalizing",
        actorStepId: drawing.actorStepId,
        finalizationStartedAt: drawing.finalizationStartedAt,
        finalizationEndsAt: drawing.finalizationEndsAt,
        captureSessionId: drawing.captureSessionId,
        acceptedSequence: drawing.latest?.sequence ?? 0,
        acceptedRevision: drawing.latest?.revision ?? null,
        baselineAcceptedRevision: drawing.baseline?.revision ?? null,
        notificationEventId: drawing.notificationEventId
      };
    case "finalized":
      return {
        status: "finalized",
        actorStepId: drawing.actorStepId,
        finalRevision: drawing.finalFrame?.revision ?? null,
        finalizedBy: drawing.finalizedBy
      };
  }
}

export function shiftDrawingDeadlines(
  drawing: InternalDrawingLifecycle,
  deltaMs: number
): void {
  if (drawing.status === "drawing") {
    drawing.drawingEndsAt += deltaMs;
  } else if (drawing.status === "finalizing") {
    drawing.finalizationStartedAt += deltaMs;
    drawing.finalizationEndsAt += deltaMs;
  }
}
