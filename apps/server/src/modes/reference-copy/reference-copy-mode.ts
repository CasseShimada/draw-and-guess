import {
  REFERENCE_PREPARING_TIMEOUT_MS,
  SYNCHRONIZED_COUNTDOWN_MS,
  shuffledCopy
} from "@draw-guess/game-rules";
import {
  ErrorCode,
  ReferenceCopySettingsSchema,
  type ClientJsonMessage,
  type EncodedImageMimeType
} from "@draw-guess/protocol";
import {
  DEFAULT_REFERENCE_COPY_SETTINGS,
  type PublicPassableActor,
  type PublicReferenceCopyModeState
} from "@draw-guess/shared-types";

import { GameError } from "../../errors.js";
import {
  beginDrawingFinalization,
  finalizeDrawing,
  publicDrawingLifecycle,
  shiftDrawingDeadlines
} from "../../services/drawing-finalization-service.js";
import { LatestFrameStore, type AcceptedFrame } from "../../services/frame-store.js";
import type {
  AcceptedModeFrame,
  GameModeController,
  ModeContext,
  PassCommand,
  PassEffect
} from "../game-mode.js";
import type {
  ReferenceCopyModeState,
  ReferenceParticipantState
} from "./reference-copy-state.js";
import type { ReferenceAsset } from "./reference-assets.js";

const REFERENCE_FRAME_MEMORY_BYTES = 64 * 1024 * 1024;

function state(context: ModeContext): ReferenceCopyModeState {
  if (context.room.modeRuntime.mode !== "reference-copy") {
    throw new GameError(ErrorCode.INVALID_STATE, "当前不是参考图临摹模式", 409);
  }
  return context.room.modeRuntime.state;
}

function effectiveNow(context: ModeContext): number {
  return context.room.runControl.status === "paused"
    ? context.room.runControl.pausedAt
    : context.now();
}

export class ReferenceCopyModeController implements GameModeController<"reference-copy"> {
  readonly id = "reference-copy" as const;

  createLobbyState(): ReferenceCopyModeState {
    return {
      phase: "LOBBY",
      settings: { ...DEFAULT_REFERENCE_COPY_SETTINGS },
      reference: null,
      participants: new Map(),
      preparingEndsAt: null,
      startsAt: null,
      endsAt: null,
      votingEndsAt: null,
      submissions: new Map(),
      ballots: new Map(),
      gallery: null,
      frameStore: new LatestFrameStore(REFERENCE_FRAME_MEMORY_BYTES),
      transitionedToVoting: false
    };
  }

  publicStateFor(context: ModeContext, viewerId: string): PublicReferenceCopyModeState {
    const current = state(context);
    const canSeeReferenceMetadata =
      current.phase !== "LOBBY" || context.room.hostId === viewerId;
    const asset = current.reference;
    const ballot = current.ballots.get(viewerId) ?? null;
    return {
      mode: "reference-copy",
      phase: current.phase,
      settings: { ...current.settings },
      reference: {
        isSet: asset !== null,
        revision: canSeeReferenceMetadata ? (asset?.revision ?? null) : null,
        mimeType: canSeeReferenceMetadata ? (asset?.mimeType ?? null) : null,
        width: canSeeReferenceMetadata ? (asset?.width ?? null) : null,
        height: canSeeReferenceMetadata ? (asset?.height ?? null) : null,
        byteLength: canSeeReferenceMetadata ? (asset?.byteLength ?? null) : null
      },
      participants: [...current.participants.values()].map((participant) => ({
        playerId: participant.playerId,
        status: participant.status,
        connected: context.isOpen(context.room.players.get(participant.playerId)),
        ready: participant.ready,
        hasAcceptedFrame:
          participant.drawing?.status === "drawing" ||
          participant.drawing?.status === "finalizing"
            ? participant.drawing.latest !== null
            : participant.finalFrame !== null
      })),
      preparingEndsAt: current.preparingEndsAt,
      startsAt: current.startsAt,
      endsAt: current.endsAt,
      votingEndsAt: current.votingEndsAt,
      selfDrawing: publicDrawingLifecycle(
        current.participants.get(viewerId)?.drawing ?? null
      ),
      selfBallot: ballot
        ? {
            ballotId: ballot.ballotId,
            actorStepId: ballot.actorStepId,
            items: ballot.items.map((item) => ({
              ballotItemId: item.ballotItemId,
              liked: ballot.likedSubmissionIds.has(item.submissionId)
            })),
            cursor: ballot.cursor,
            status: ballot.status,
            likedCount: ballot.likedSubmissionIds.size
          }
        : null,
      gallery: current.gallery
        ? {
            resultId: current.gallery.resultId,
            entries: [...current.submissions.values()].map((submission) => ({
              resultItemId:
                current.gallery!.resultItemBySubmissionId.get(
                  submission.submissionId
                ) ?? "",
              authorId: submission.authorId,
              likes:
                current.gallery!.likesBySubmissionId.get(submission.submissionId) ?? 0,
              winner: current.gallery!.winnerSubmissionIds.has(submission.submissionId)
            })),
            participants: [...current.participants.values()].map((participant) => {
              const submission = [...current.submissions.values()].find(
                (candidate) => candidate.authorId === participant.playerId
              );
              return {
                playerId: participant.playerId,
                status:
                  participant.status === "passed"
                    ? ("passed" as const)
                    : participant.finalFrame
                      ? ("finalized" as const)
                      : ("no-submission" as const),
                resultItemId: submission
                  ? (current.gallery!.resultItemBySubmissionId.get(
                      submission.submissionId
                    ) ?? null)
                  : null
              };
            })
          }
        : null
    };
  }

  passableActors(context: ModeContext, viewerId: string): PublicPassableActor[] {
    const current = state(context);
    const isHost = context.room.hostId === viewerId;
    if (current.phase === "DRAWING" || current.phase === "FINALIZING") {
      return [...current.participants.values()].flatMap((participant) => {
        const drawing = participant.drawing;
        if (
          !drawing ||
          (drawing.status !== "drawing" && drawing.status !== "finalizing") ||
          (!isHost && participant.playerId !== viewerId)
        ) {
          return [];
        }
        return [
          {
            actorStepId: drawing.actorStepId,
            targetPlayerId: participant.playerId,
            phase: current.phase,
            effect:
              drawing.status === "drawing"
                ? ("withdraw-submission" as const)
                : ("finalize-current-frame" as const)
          }
        ];
      });
    }
    if (current.phase === "BLIND_VOTING") {
      return [...current.ballots.values()].flatMap((ballot) =>
        ballot.status === "active" && (isHost || ballot.voterId === viewerId)
          ? [
              {
                actorStepId: ballot.actorStepId,
                targetPlayerId: ballot.voterId,
                phase: current.phase,
                effect: "finish-ballot" as const
              }
            ]
          : []
      );
    }
    return [];
  }

  updateSettings(context: ModeContext, value: unknown): void {
    const current = state(context);
    if (current.phase !== "LOBBY") {
      throw new GameError(ErrorCode.INVALID_STATE, "只能在临摹大厅修改设置");
    }
    current.settings = ReferenceCopySettingsSchema.parse(value);
  }

  setReference(context: ModeContext, asset: ReferenceAsset): void {
    const current = state(context);
    if (current.phase !== "LOBBY") {
      throw new GameError(ErrorCode.INVALID_STATE, "只能在临摹大厅设置参考图", 409);
    }
    current.reference = asset;
  }

  deleteReference(context: ModeContext): void {
    const current = state(context);
    if (current.phase !== "LOBBY") {
      throw new GameError(ErrorCode.INVALID_STATE, "只能在临摹大厅删除参考图", 409);
    }
    current.reference = null;
  }

  referenceAsset(
    context: ModeContext,
    viewerId: string,
    revision: string
  ): ReferenceAsset {
    const current = state(context);
    const asset = current.reference;
    if (!asset || asset.revision !== revision) {
      throw new GameError(ErrorCode.NOT_FOUND, "参考图版本不存在", 404);
    }
    if (current.phase === "LOBBY" && context.room.hostId !== viewerId) {
      throw new GameError(ErrorCode.FORBIDDEN, "参考图尚未向参与者开放", 403);
    }
    if (
      current.phase !== "LOBBY" &&
      !current.participants.has(viewerId) &&
      current.phase !== "GALLERY"
    ) {
      throw new GameError(ErrorCode.FORBIDDEN, "无权读取这张参考图", 403);
    }
    return asset;
  }

  ballotAsset(
    context: ModeContext,
    viewerId: string,
    ballotId: string,
    ballotItemId: string
  ): AcceptedFrame {
    const current = state(context);
    if (current.phase !== "BLIND_VOTING") {
      throw new GameError(ErrorCode.NOT_FOUND, "匿名作品已失效", 404);
    }
    const ballot = current.ballots.get(viewerId);
    if (!ballot || ballot.ballotId !== ballotId) {
      throw new GameError(ErrorCode.FORBIDDEN, "匿名选票不属于当前玩家", 403);
    }
    const item = ballot.items.find(
      (candidate) => candidate.ballotItemId === ballotItemId
    );
    const submission = item ? current.submissions.get(item.submissionId) : undefined;
    if (!submission) {
      throw new GameError(ErrorCode.NOT_FOUND, "匿名作品不存在", 404);
    }
    return submission.frame;
  }

  galleryAsset(
    context: ModeContext,
    resultId: string,
    resultItemId: string
  ): AcceptedFrame {
    const current = state(context);
    if (
      current.phase !== "GALLERY" ||
      !current.gallery ||
      current.gallery.resultId !== resultId
    ) {
      throw new GameError(ErrorCode.NOT_FOUND, "临摹结果已失效", 404);
    }
    const submissionId = [...current.gallery.resultItemBySubmissionId].find(
      ([, itemId]) => itemId === resultItemId
    )?.[0];
    const submission = submissionId ? current.submissions.get(submissionId) : undefined;
    if (!submission) {
      throw new GameError(ErrorCode.NOT_FOUND, "结果作品不存在", 404);
    }
    return submission.frame;
  }

  start(context: ModeContext): void {
    const current = state(context);
    if (current.phase !== "LOBBY") {
      throw new GameError(ErrorCode.INVALID_STATE, "临摹游戏已经开始");
    }
    if (!current.reference) {
      throw new GameError(ErrorCode.INVALID_STATE, "请先上传参考图");
    }
    const players = [...context.room.players.values()];
    const connected = players.filter((player) => context.isOpen(player));
    if (connected.length < 2) {
      throw new GameError(ErrorCode.INVALID_STATE, "临摹至少需要两名在线玩家");
    }
    const unavailable = players.filter(
      (player) => !context.isOpen(player) || !context.isCaptureReady(player)
    );
    if (unavailable.length > 0) {
      throw new GameError(
        ErrorCode.INVALID_STATE,
        `以下玩家尚未使用桌面端确认采集来源：${unavailable
          .map((player) => player.nickname)
          .join("、")}`
      );
    }
    current.participants = new Map(
      players.map((player) => [
        player.id,
        {
          playerId: player.id,
          status: "preparing",
          ready: false,
          drawing: null,
          finalFrame: null
        } satisfies ReferenceParticipantState
      ])
    );
    current.submissions.clear();
    current.ballots.clear();
    current.gallery = null;
    current.frameStore.clear();
    current.transitionedToVoting = false;
    current.phase = "PREPARING";
    current.preparingEndsAt = effectiveNow(context) + REFERENCE_PREPARING_TIMEOUT_MS;
    current.startsAt = null;
    current.endsAt = null;
    current.votingEndsAt = null;
    const modeSessionId = context.room.modeSessionId;
    context.room.modeScheduler.scheduleAt(
      this.#preparingTimerKey(context),
      current.preparingEndsAt,
      () => {
        if (
          context.room.modeRuntime.mode !== "reference-copy" ||
          context.room.modeSessionId !== modeSessionId ||
          state(context).phase !== "PREPARING"
        ) {
          return;
        }
        const missing = [...state(context).participants.values()]
          .filter((participant) => !participant.ready)
          .map(
            (participant) =>
              context.room.players.get(participant.playerId)?.nickname ?? "未知玩家"
          );
        this.#returnToLobbyAfterPreparationFailure(
          context,
          `参考图预加载超时：${missing.join("、")}`
        );
      }
    );
    context.broadcastSnapshots();
  }

  returnToLobby(context: ModeContext): void {
    const current = state(context);
    if (current.phase !== "GALLERY") {
      throw new GameError(ErrorCode.INVALID_STATE, "临摹结果尚未揭晓");
    }
    this.#clearRuntime(context, false);
    current.phase = "LOBBY";
    context.broadcastSnapshots();
  }

  handleCommand(
    context: ModeContext,
    playerId: string,
    command: ClientJsonMessage
  ): boolean {
    const current = state(context);
    if (command.type === "reference:ready") {
      this.#assertMutable(context, command.modeSessionId);
      if (
        current.phase !== "PREPARING" ||
        current.reference?.revision !== command.referenceRevision
      ) {
        throw new GameError(ErrorCode.INVALID_STATE, "参考图 ready 已失效", 409);
      }
      const participant = current.participants.get(playerId);
      if (!participant) {
        throw new GameError(ErrorCode.FORBIDDEN, "你不属于本局临摹参与者", 403);
      }
      participant.ready = true;
      if ([...current.participants.values()].every((candidate) => candidate.ready)) {
        this.#beginCountdown(context);
      } else {
        context.broadcastSnapshots();
      }
      return true;
    }
    if (command.type === "drawing:finish") {
      this.#assertMutable(context, command.modeSessionId);
      const participant = current.participants.get(playerId);
      if (
        !participant ||
        participant.drawing?.status !== "drawing" ||
        participant.drawing.actorStepId !== command.actorStepId
      ) {
        throw new GameError(ErrorCode.INVALID_STATE, "当前临摹绘制步骤无法完成", 409);
      }
      this.#beginParticipantFinalization(context, participant);
      return true;
    }
    if (command.type === "reference:set-like") {
      this.#assertMutable(context, command.modeSessionId);
      this.#setLike(
        context,
        playerId,
        command.ballotId,
        command.ballotItemId,
        command.liked
      );
      return true;
    }
    if (command.type === "reference:finish-ballot") {
      this.#assertMutable(context, command.modeSessionId);
      const ballot = current.ballots.get(playerId);
      if (
        current.phase !== "BLIND_VOTING" ||
        !ballot ||
        ballot.ballotId !== command.ballotId ||
        ballot.status !== "active"
      ) {
        throw new GameError(ErrorCode.INVALID_STATE, "匿名选票已经结束", 409);
      }
      ballot.status = "completed";
      this.#maybeReveal(context);
      return true;
    }
    return false;
  }

  resolvePass(
    context: ModeContext,
    command: PassCommand,
    initiatedByHost: boolean
  ): PassEffect {
    const current = state(context);
    const participant = current.participants.get(command.targetPlayerId);
    const drawing = participant?.drawing;
    if (
      drawing &&
      drawing.actorStepId === command.actorStepId &&
      drawing.status === "drawing"
    ) {
      participant.status = "passed";
      participant.drawing = null;
      participant.finalFrame = null;
      current.frameStore.delete(participant.playerId);
      context.room.modeScheduler.cancel(
        this.#finalizationTimerKey(context, participant.playerId)
      );
      context.revokeCapture(participant.playerId, "finalized", true);
      this.#maybeEnterVoting(context);
      context.broadcastSnapshots();
      return { kind: "withdraw-submission" };
    }
    if (
      drawing &&
      drawing.actorStepId === command.actorStepId &&
      drawing.status === "finalizing"
    ) {
      this.#finalizeParticipant(
        context,
        participant,
        initiatedByHost ? "host-pass" : "self-pass"
      );
      return { kind: "finalize-current-frame" };
    }
    const ballot = current.ballots.get(command.targetPlayerId);
    if (
      current.phase === "BLIND_VOTING" &&
      ballot?.actorStepId === command.actorStepId &&
      ballot.status === "active"
    ) {
      ballot.status = "passed";
      this.#maybeReveal(context);
      return { kind: "finish-ballot", keepExistingLikes: true };
    }
    throw new GameError(ErrorCode.INVALID_STATE, "临摹 Pass actor step 已失效", 409);
  }

  handleAcceptedFrame(
    context: ModeContext,
    playerId: string,
    captureSessionId: number,
    mimeType: EncodedImageMimeType,
    bytes: Uint8Array
  ): AcceptedModeFrame | null {
    const current = state(context);
    const participant = current.participants.get(playerId);
    const drawing = participant?.drawing;
    if (
      !drawing ||
      (drawing.status !== "drawing" && drawing.status !== "finalizing") ||
      drawing.captureSessionId !== captureSessionId
    ) {
      return null;
    }
    const frame = current.frameStore.accept(playerId, {
      playerId,
      captureSessionId,
      mimeType,
      bytes,
      capturedAt: context.now()
    });
    if (!frame) {
      return null;
    }
    drawing.latest = frame;
    return { frame, audience: "self" };
  }

  latestFrameForViewer(context: ModeContext, viewerId: string): AcceptedFrame | null {
    const current = state(context);
    const drawing = current.participants.get(viewerId)?.drawing;
    const frame =
      drawing?.status === "drawing" || drawing?.status === "finalizing"
        ? current.frameStore.get(viewerId)
        : null;
    return frame && drawing && drawing.status !== "finalized"
      ? { ...frame, captureSessionId: drawing.captureSessionId }
      : frame;
  }

  onPlayerConnectionChanged(context: ModeContext, playerId: string): void {
    const participant = state(context).participants.get(playerId);
    const drawing = participant?.drawing;
    if (
      drawing &&
      (drawing.status === "drawing" || drawing.status === "finalizing") &&
      context.isCaptureReady(context.room.players.get(playerId))
    ) {
      this.#issueDrawingCapture(context, drawing);
    }
  }

  pause(_context: ModeContext, _at: number): void {
    // Common scheduler/grant orchestration freezes this parallel state machine.
  }

  resume(context: ModeContext, pausedDurationMs: number, captureDelayMs: number): void {
    const current = state(context);
    const delta = pausedDurationMs + captureDelayMs;
    for (const key of [
      "preparingEndsAt",
      "startsAt",
      "endsAt",
      "votingEndsAt"
    ] as const) {
      if (current[key] !== null) {
        current[key] += delta;
      }
    }
    for (const participant of current.participants.values()) {
      if (participant.drawing) {
        shiftDrawingDeadlines(participant.drawing, delta);
        if (
          captureDelayMs > 0 &&
          (participant.drawing.status === "drawing" ||
            participant.drawing.status === "finalizing")
        ) {
          participant.drawing.captureSessionId = context.allocateCaptureSessionId();
        }
      }
    }
    if (captureDelayMs > 0 && this.requiresCaptureOnResume(context)) {
      context.room.modeScheduler.scheduleAt(
        `reference:capture-resume:${context.room.modeSessionId}`,
        context.now() + captureDelayMs,
        () => {
          for (const participant of state(context).participants.values()) {
            if (
              participant.drawing?.status === "drawing" ||
              participant.drawing?.status === "finalizing"
            ) {
              this.#issueDrawingCapture(context, participant.drawing);
            }
          }
        }
      );
    }
  }

  requiresCaptureOnResume(context: ModeContext): boolean {
    return [...state(context).participants.values()].some(
      (participant) =>
        participant.drawing?.status === "drawing" ||
        participant.drawing?.status === "finalizing"
    );
  }

  dispose(context: ModeContext): void {
    this.#clearRuntime(context, true);
  }

  #beginCountdown(context: ModeContext): void {
    const current = state(context);
    context.room.modeScheduler.cancel(this.#preparingTimerKey(context));
    current.phase = "COUNTDOWN";
    current.preparingEndsAt = null;
    current.startsAt = effectiveNow(context) + SYNCHRONIZED_COUNTDOWN_MS;
    current.endsAt = current.startsAt + current.settings.durationSeconds * 1_000;
    for (const participant of current.participants.values()) {
      participant.status = "countdown";
    }
    const modeSessionId = context.room.modeSessionId;
    context.room.modeScheduler.scheduleAt(
      this.#countdownTimerKey(context),
      current.startsAt,
      () => {
        if (
          context.room.modeRuntime.mode === "reference-copy" &&
          context.room.modeSessionId === modeSessionId &&
          state(context).phase === "COUNTDOWN"
        ) {
          this.#startDrawing(context);
        }
      }
    );
    context.broadcastSnapshots();
  }

  #startDrawing(context: ModeContext): void {
    const current = state(context);
    if (current.phase !== "COUNTDOWN" || current.endsAt === null) {
      return;
    }
    current.phase = "DRAWING";
    for (const participant of current.participants.values()) {
      const drawing = {
        status: "drawing" as const,
        actorStepId: context.randomId(12),
        playerId: participant.playerId,
        drawingEndsAt: current.endsAt,
        captureSessionId: context.allocateCaptureSessionId(),
        latest: null
      };
      participant.status = "drawing";
      participant.drawing = drawing;
      this.#issueDrawingCapture(context, drawing);
    }
    const modeSessionId = context.room.modeSessionId;
    context.room.modeScheduler.scheduleAt(
      this.#drawingTimerKey(context),
      current.endsAt,
      () => {
        if (
          context.room.modeRuntime.mode === "reference-copy" &&
          context.room.modeSessionId === modeSessionId &&
          (state(context).phase === "DRAWING" || state(context).phase === "FINALIZING")
        ) {
          for (const participant of state(context).participants.values()) {
            if (participant.drawing?.status === "drawing") {
              this.#beginParticipantFinalization(context, participant);
            }
          }
        }
      }
    );
    context.broadcastSnapshots();
  }

  #beginParticipantFinalization(
    context: ModeContext,
    participant: ReferenceParticipantState
  ): void {
    const current = state(context);
    const drawing = participant.drawing;
    if (!drawing || drawing.status !== "drawing") {
      return;
    }
    context.revokeCapture(participant.playerId, "session-replaced");
    const finalizing = beginDrawingFinalization({
      drawing,
      now: effectiveNow(context),
      captureSessionId: context.allocateCaptureSessionId(),
      notificationEventId: context.randomId(12)
    });
    participant.status = "finalizing";
    participant.drawing = finalizing;
    this.#issueDrawingCapture(context, finalizing);
    context.sendToPlayer(participant.playerId, {
      type: "drawing:finalization-started",
      modeSessionId: context.room.modeSessionId,
      actorStepId: finalizing.actorStepId,
      eventId: finalizing.notificationEventId,
      endsAt: finalizing.finalizationEndsAt
    });
    const modeSessionId = context.room.modeSessionId;
    context.room.modeScheduler.scheduleAt(
      this.#finalizationTimerKey(context, participant.playerId),
      finalizing.finalizationEndsAt,
      () => {
        if (
          context.room.modeRuntime.mode === "reference-copy" &&
          context.room.modeSessionId === modeSessionId
        ) {
          const latest = state(context).participants.get(participant.playerId);
          if (latest?.drawing?.status === "finalizing") {
            this.#finalizeParticipant(context, latest, "deadline");
          }
        }
      }
    );
    this.#updateTopDrawingPhase(current);
    context.broadcastSnapshots();
  }

  #finalizeParticipant(
    context: ModeContext,
    participant: ReferenceParticipantState,
    finalizedBy: "deadline" | "self-pass" | "host-pass"
  ): void {
    if (participant.drawing?.status !== "finalizing") {
      return;
    }
    context.room.modeScheduler.cancel(
      this.#finalizationTimerKey(context, participant.playerId)
    );
    context.revokeCapture(participant.playerId, "finalized", true);
    const finalized = finalizeDrawing(participant.drawing, finalizedBy);
    participant.drawing = finalized;
    participant.finalFrame = finalized.finalFrame;
    participant.status = finalized.finalFrame ? "finalized" : "no-submission";
    this.#maybeEnterVoting(context);
    context.broadcastSnapshots();
  }

  #maybeEnterVoting(context: ModeContext): void {
    const current = state(context);
    this.#updateTopDrawingPhase(current);
    if (
      current.transitionedToVoting ||
      [...current.participants.values()].some(
        (participant) =>
          participant.status === "drawing" || participant.status === "finalizing"
      )
    ) {
      return;
    }
    current.transitionedToVoting = true;
    context.room.modeScheduler.cancel(this.#drawingTimerKey(context));
    for (const participant of current.participants.values()) {
      context.revokeCapture(participant.playerId, "finalized", true);
      if (participant.finalFrame) {
        const submissionId = context.randomId(16);
        current.submissions.set(submissionId, {
          submissionId,
          authorId: participant.playerId,
          frame: participant.finalFrame
        });
      }
    }
    const submissions = [...current.submissions.values()];
    for (const participant of current.participants.values()) {
      const order = shuffledCopy(submissions, (maximum) =>
        context.randomIndex(maximum)
      );
      current.ballots.set(participant.playerId, {
        ballotId: context.randomId(16),
        actorStepId: context.randomId(12),
        voterId: participant.playerId,
        items: order.map((submission) => ({
          ballotItemId: context.randomId(16),
          submissionId: submission.submissionId
        })),
        cursor: 0,
        likedSubmissionIds: new Set(),
        status: "active"
      });
    }
    current.phase = "BLIND_VOTING";
    current.votingEndsAt =
      effectiveNow(context) + current.settings.votingSeconds * 1_000;
    if (submissions.length === 0) {
      for (const ballot of current.ballots.values()) {
        ballot.status = "completed";
      }
      this.#reveal(context);
      return;
    }
    const modeSessionId = context.room.modeSessionId;
    context.room.modeScheduler.scheduleAt(
      this.#votingTimerKey(context),
      current.votingEndsAt,
      () => {
        if (
          context.room.modeRuntime.mode === "reference-copy" &&
          context.room.modeSessionId === modeSessionId &&
          state(context).phase === "BLIND_VOTING"
        ) {
          for (const ballot of state(context).ballots.values()) {
            if (ballot.status === "active") {
              ballot.status = "timed-out";
            }
          }
          this.#reveal(context);
        }
      }
    );
  }

  #setLike(
    context: ModeContext,
    voterId: string,
    ballotId: string,
    ballotItemId: string,
    liked: boolean
  ): void {
    const current = state(context);
    const ballot = current.ballots.get(voterId);
    if (
      current.phase !== "BLIND_VOTING" ||
      !ballot ||
      ballot.ballotId !== ballotId ||
      ballot.status !== "active"
    ) {
      throw new GameError(ErrorCode.INVALID_STATE, "匿名选票已经结束", 409);
    }
    const item = ballot.items.find(
      (candidate) => candidate.ballotItemId === ballotItemId
    );
    if (!item) {
      throw new GameError(ErrorCode.NOT_FOUND, "匿名作品不存在", 404);
    }
    ballot.cursor = ballot.items.indexOf(item);
    if (liked) {
      ballot.likedSubmissionIds.add(item.submissionId);
    } else {
      ballot.likedSubmissionIds.delete(item.submissionId);
    }
    context.broadcastSnapshots();
  }

  #maybeReveal(context: ModeContext): void {
    const current = state(context);
    if (
      current.phase === "BLIND_VOTING" &&
      [...current.ballots.values()].every((ballot) => ballot.status !== "active")
    ) {
      this.#reveal(context);
    } else {
      context.broadcastSnapshots();
    }
  }

  #reveal(context: ModeContext): void {
    const current = state(context);
    if (current.phase !== "BLIND_VOTING") {
      return;
    }
    context.room.modeScheduler.cancel(this.#votingTimerKey(context));
    const likesBySubmissionId = new Map(
      [...current.submissions.keys()].map((submissionId) => [submissionId, 0])
    );
    for (const ballot of current.ballots.values()) {
      for (const submissionId of ballot.likedSubmissionIds) {
        if (likesBySubmissionId.has(submissionId)) {
          likesBySubmissionId.set(
            submissionId,
            (likesBySubmissionId.get(submissionId) ?? 0) + 1
          );
        }
      }
    }
    const highest =
      likesBySubmissionId.size > 0 ? Math.max(...likesBySubmissionId.values()) : null;
    current.gallery = {
      resultId: context.randomId(16),
      resultItemBySubmissionId: new Map(
        [...current.submissions.keys()].map((submissionId) => [
          submissionId,
          context.randomId(16)
        ])
      ),
      likesBySubmissionId,
      winnerSubmissionIds: new Set(
        highest === null
          ? []
          : [...likesBySubmissionId]
              .filter(([, likes]) => likes === highest)
              .map(([submissionId]) => submissionId)
      )
    };
    current.phase = "GALLERY";
    current.votingEndsAt = null;
    context.broadcastSnapshots();
  }

  #issueDrawingCapture(
    context: ModeContext,
    drawing:
      | Extract<
          NonNullable<ReferenceParticipantState["drawing"]>,
          { status: "drawing" }
        >
      | Extract<
          NonNullable<ReferenceParticipantState["drawing"]>,
          { status: "finalizing" }
        >
  ): void {
    context.issueCapture({
      playerId: drawing.playerId,
      actorStepId: drawing.actorStepId,
      captureSessionId: drawing.captureSessionId,
      stage: drawing.status,
      expiresAt:
        drawing.status === "drawing"
          ? drawing.drawingEndsAt
          : drawing.finalizationEndsAt
    });
  }

  #updateTopDrawingPhase(current: ReferenceCopyModeState): void {
    if (
      [...current.participants.values()].some(
        (participant) => participant.status === "drawing"
      )
    ) {
      current.phase = "DRAWING";
    } else if (
      [...current.participants.values()].some(
        (participant) => participant.status === "finalizing"
      )
    ) {
      current.phase = "FINALIZING";
    }
  }

  #returnToLobbyAfterPreparationFailure(context: ModeContext, message: string): void {
    const current = state(context);
    this.#clearRuntime(context, false);
    current.phase = "LOBBY";
    context.appendChat({
      kind: "system",
      playerId: null,
      nickname: null,
      text: message
    });
    context.broadcastSnapshots();
  }

  #clearRuntime(context: ModeContext, clearReference: boolean): void {
    const current = state(context);
    context.room.modeScheduler.cancelAll();
    for (const participant of current.participants.values()) {
      context.revokeCapture(participant.playerId, "mode-switched", true);
    }
    current.participants.clear();
    current.submissions.clear();
    current.ballots.clear();
    current.gallery = null;
    current.frameStore.clear();
    current.preparingEndsAt = null;
    current.startsAt = null;
    current.endsAt = null;
    current.votingEndsAt = null;
    current.transitionedToVoting = false;
    if (clearReference) {
      current.reference = null;
    }
  }

  #assertMutable(context: ModeContext, modeSessionId: string): void {
    if (context.room.modeSessionId !== modeSessionId) {
      throw new GameError(ErrorCode.INVALID_STATE, "临摹模式会话已失效", 409);
    }
    if (context.room.runControl.status === "paused") {
      throw new GameError(ErrorCode.INVALID_STATE, "游戏已暂停", 409);
    }
  }

  #preparingTimerKey(context: ModeContext): string {
    return `reference:preparing:${context.room.modeSessionId}`;
  }

  #countdownTimerKey(context: ModeContext): string {
    return `reference:countdown:${context.room.modeSessionId}`;
  }

  #drawingTimerKey(context: ModeContext): string {
    return `reference:drawing:${context.room.modeSessionId}`;
  }

  #finalizationTimerKey(context: ModeContext, playerId: string): string {
    return `reference:finalizing:${context.room.modeSessionId}:${playerId}`;
  }

  #votingTimerKey(context: ModeContext): string {
    return `reference:voting:${context.room.modeSessionId}`;
  }
}
