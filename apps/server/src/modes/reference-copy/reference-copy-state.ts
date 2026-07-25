import type {
  ReferenceCopyPhase,
  ReferenceCopySettings
} from "@draw-guess/shared-types";

import type { InternalDrawingLifecycle } from "../../services/drawing-finalization-service.js";
import type { AcceptedFrame, LatestFrameStore } from "../../services/frame-store.js";
import type { ReferenceAsset } from "./reference-assets.js";

export type ReferenceParticipantStatus =
  | "preparing"
  | "countdown"
  | "drawing"
  | "finalizing"
  | "finalized"
  | "passed"
  | "no-submission";

export interface ReferenceParticipantState {
  playerId: string;
  status: ReferenceParticipantStatus;
  ready: boolean;
  drawing: InternalDrawingLifecycle | null;
  finalFrame: AcceptedFrame | null;
}

export interface ReferenceSubmission {
  submissionId: string;
  authorId: string;
  frame: AcceptedFrame;
}

export interface ReferenceBallotItem {
  ballotItemId: string;
  submissionId: string;
}

export interface ReferenceBallot {
  ballotId: string;
  actorStepId: string;
  voterId: string;
  items: ReferenceBallotItem[];
  cursor: number;
  likedSubmissionIds: Set<string>;
  status: "active" | "completed" | "passed" | "timed-out";
}

export interface ReferenceGalleryResult {
  resultId: string;
  resultItemBySubmissionId: Map<string, string>;
  likesBySubmissionId: Map<string, number>;
  winnerSubmissionIds: Set<string>;
}

export interface ReferenceCopyModeState {
  phase: ReferenceCopyPhase;
  settings: ReferenceCopySettings;
  reference: ReferenceAsset | null;
  participants: Map<string, ReferenceParticipantState>;
  preparingEndsAt: number | null;
  startsAt: number | null;
  endsAt: number | null;
  votingEndsAt: number | null;
  submissions: Map<string, ReferenceSubmission>;
  ballots: Map<string, ReferenceBallot>;
  gallery: ReferenceGalleryResult | null;
  frameStore: LatestFrameStore;
  transitionedToVoting: boolean;
}
