import { createHash } from "node:crypto";

import { WordPoolUploadSchema, type WordPoolUpload } from "@draw-guess/content";
import {
  FINAL_PRESENTATION_GRACE_SECONDS,
  SYNCHRONIZED_COUNTDOWN_MS,
  shuffledCopy
} from "@draw-guess/game-rules";
import {
  DrawRelaySettingsSchema,
  ErrorCode,
  type ClientJsonMessage,
  type EncodedImageMimeType
} from "@draw-guess/protocol";
import {
  DEFAULT_DRAW_RELAY_SETTINGS,
  type PublicDrawRelayModeState,
  type PublicPassableActor,
  type PublicRelayPlayer,
  type PublicReplayStatus
} from "@draw-guess/shared-types";

import { GameError } from "../../errors.js";
import { createDefaultRoomWordPool, createRoomWordPool } from "../../room-content.js";
import {
  beginDrawingFinalization,
  finalizeDrawing,
  publicDrawingLifecycle,
  shiftDrawingDeadlines
} from "../../services/drawing-finalization-service.js";
import { LatestFrameStore, type AcceptedFrame } from "../../services/frame-store.js";
import type { ReplayService } from "../../services/replay-service.js";
import type {
  AcceptedModeFrame,
  GameModeController,
  ModeContext,
  PassCommand,
  PassEffect
} from "../game-mode.js";
import type {
  DrawRelayModeState,
  RelayActorStep,
  RelayArtifact,
  RelayImmutableInput
} from "./draw-relay-state.js";

const RELAY_FRAME_MEMORY_BYTES = 4 * 1024 * 1024;

function state(context: ModeContext): DrawRelayModeState {
  if (context.room.modeRuntime.mode !== "draw-relay") {
    throw new GameError(ErrorCode.INVALID_STATE, "当前不是绘画接龙模式", 409);
  }
  return context.room.modeRuntime.state;
}

function effectiveNow(context: ModeContext): number {
  return context.room.runControl.status === "paused"
    ? context.room.runControl.pausedAt
    : context.now();
}

function contentHash(kind: "word" | "drawing", value: string): string {
  return createHash("sha256").update(`${kind}\u0000${value}`).digest("hex");
}

function validRelayGuess(input: string): string {
  const value = input.trim();
  if (
    [...value].length < 1 ||
    [...value].length > 80 ||
    /[\p{Cc}\p{Cf}\p{Cs}]/u.test(value)
  ) {
    throw new GameError(
      ErrorCode.BAD_MESSAGE,
      "猜词必须是 1～80 个 Unicode 字符且不能包含控制字符"
    );
  }
  return value;
}

export type RelayPrivateTask =
  | {
      kind: "word";
      actorStepId: string;
      word: string;
    }
  | {
      kind: "drawing";
      actorStepId: string;
      artifactId: string;
      revision: string | null;
      available: boolean;
    };

export class DrawRelayModeController implements GameModeController<"draw-relay"> {
  readonly id = "draw-relay" as const;
  readonly #replay: ReplayService;

  constructor(replay: ReplayService) {
    this.#replay = replay;
  }

  createLobbyState(): DrawRelayModeState {
    const capability = this.#replay.capabilityService.capability;
    return {
      phase: "LOBBY",
      settings: { ...DEFAULT_DRAW_RELAY_SETTINGS },
      configuredWordPool: createDefaultRoomWordPool(),
      wordPoolUpdatedAt: null,
      gameWordPool: null,
      recordingConfirmedPlayerIds: new Set(),
      participantOrder: [],
      cursor: 0,
      startingWord: null,
      activeStep: null,
      history: [],
      artifacts: new Map(),
      startsAt: null,
      phaseEndsAt: null,
      result: null,
      replayJobId: null,
      replay: capability.available
        ? { status: "idle" }
        : { status: "unavailable", message: capability.message },
      frameStore: new LatestFrameStore(RELAY_FRAME_MEMORY_BYTES),
      passedPlayerIds: new Set(),
      replayStartedAt: null,
      replayPausedAt: null,
      replayPausedTotalMs: 0
    };
  }

  publicStateFor(context: ModeContext, viewerId: string): PublicDrawRelayModeState {
    const current = state(context);
    const step = current.activeStep;
    const selfTask =
      step?.playerId === viewerId
        ? step.kind === "guessing"
          ? {
              actorStepId: step.actorStepId,
              kind: "drawing" as const,
              ready: step.ready,
              artifactAvailable:
                step.immutableInput.kind === "drawing" &&
                step.immutableInput.frame !== null
            }
          : {
              actorStepId: step.actorStepId,
              kind: "word" as const,
              ready: step.ready
            }
        : null;
    return {
      mode: "draw-relay",
      phase: current.phase,
      settings: { ...current.settings },
      wordPool: structuredClone(
        (current.gameWordPool ?? current.configuredWordPool).summary
      ),
      order: current.participantOrder.map((playerId, position) => ({
        playerId,
        position,
        status: this.#playerStatus(current, playerId)
      })),
      activePlayerId: step?.playerId ?? null,
      stepIndex: current.history.length,
      totalSteps: Math.max(0, current.participantOrder.length * 2 - 2),
      startsAt: current.startsAt,
      phaseEndsAt: current.phaseEndsAt,
      recordingConfirmedPlayerIds: [...current.recordingConfirmedPlayerIds],
      selfTask,
      selfDrawing:
        step?.playerId === viewerId ? publicDrawingLifecycle(step.drawing) : null,
      replay: structuredClone(this.#currentReplayStatus(current)),
      result: current.result
        ? {
            resultId: current.result.resultId,
            startingWord: current.result.startingWord,
            finalGuess: current.result.finalGuess,
            finalGuessReason: current.result.finalGuessReason,
            history: current.history.map((entry) =>
              entry.kind === "guess"
                ? {
                    kind: "guess" as const,
                    playerId: entry.playerId,
                    status: entry.status,
                    guess: entry.guess
                  }
                : {
                    kind: "draw" as const,
                    playerId: entry.playerId,
                    status: entry.status,
                    resultArtifactId: entry.artifact
                      ? (current.result!.resultArtifactIds.get(
                          entry.artifact.artifactId
                        ) ?? null)
                      : null
                  }
            )
          }
        : null
    };
  }

  passableActors(context: ModeContext, viewerId: string): PublicPassableActor[] {
    const current = state(context);
    const step = current.activeStep;
    if (!step || (viewerId !== step.playerId && context.room.hostId !== viewerId)) {
      return [];
    }
    if (
      current.phase === "PREPARING" ||
      current.phase === "COUNTDOWN" ||
      current.phase === "DRAWING" ||
      current.phase === "GUESSING"
    ) {
      return [
        {
          actorStepId: step.actorStepId,
          targetPlayerId: step.playerId,
          phase: current.phase,
          effect: "handoff-input"
        }
      ];
    }
    if (current.phase === "FINALIZING") {
      return [
        {
          actorStepId: step.actorStepId,
          targetPlayerId: step.playerId,
          phase: current.phase,
          effect: "finalize-current-frame"
        }
      ];
    }
    return [];
  }

  updateSettings(context: ModeContext, value: unknown): void {
    const current = state(context);
    if (current.phase !== "LOBBY") {
      throw new GameError(ErrorCode.INVALID_STATE, "只能在接龙大厅修改设置");
    }
    current.settings = DrawRelaySettingsSchema.parse(value);
  }

  updateWordPool(
    context: ModeContext,
    uploadInput: WordPoolUpload
  ): PublicDrawRelayModeState["wordPool"] {
    const current = state(context);
    if (current.phase !== "LOBBY") {
      throw new GameError(ErrorCode.INVALID_STATE, "只能在接龙大厅更新词库", 409);
    }
    const now = context.now();
    if (current.wordPoolUpdatedAt !== null && now - current.wordPoolUpdatedAt < 500) {
      throw new GameError(ErrorCode.RATE_LIMITED, "词库更新太频繁，请稍后再试", 429);
    }
    current.configuredWordPool = createRoomWordPool(
      WordPoolUploadSchema.parse(uploadInput)
    );
    current.wordPoolUpdatedAt = now;
    return structuredClone(current.configuredWordPool.summary);
  }

  async start(context: ModeContext): Promise<void> {
    const current = state(context);
    if (current.phase !== "LOBBY") {
      throw new GameError(ErrorCode.INVALID_STATE, "绘画接龙已经开始");
    }
    const capability = await this.#replay.capabilityService.revalidate();
    if (!capability.available) {
      current.replay = { status: "unavailable", message: capability.message };
      throw new GameError(ErrorCode.CAPABILITY_UNAVAILABLE, capability.message, 409);
    }
    const players = [...context.room.players.values()];
    if (players.length < 2) {
      throw new GameError(ErrorCode.INVALID_STATE, "绘画接龙至少需要两名玩家");
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
    const unconfirmed = players.filter(
      (player) => !current.recordingConfirmedPlayerIds.has(player.id)
    );
    if (unconfirmed.length > 0) {
      throw new GameError(
        ErrorCode.INVALID_STATE,
        `以下玩家尚未确认主机录制提示：${unconfirmed
          .map((player) => player.nickname)
          .join("、")}`
      );
    }
    if (current.configuredWordPool.built.words.length < 1) {
      throw new GameError(ErrorCode.INVALID_STATE, "接龙词池至少需要一个有效词语");
    }
    const estimatedReplayBytes =
      Math.max(1, players.length - 1) *
      (current.settings.drawingSeconds + FINAL_PRESENTATION_GRACE_SECONDS) *
      512 *
      1024;
    const replayJobId = await this.#replay.startJob(estimatedReplayBytes);
    const order = shuffledCopy(
      players.map((player) => player.id),
      (maximum) => context.randomIndex(maximum)
    );
    const words = current.configuredWordPool.built.words;
    const startingWord = words[context.randomIndex(words.length)];
    if (!startingWord) {
      await this.#replay.discard(replayJobId);
      throw new GameError(ErrorCode.INVALID_STATE, "接龙起始词无法生成");
    }
    current.gameWordPool = {
      ...current.configuredWordPool,
      upload: structuredClone(current.configuredWordPool.upload),
      built: structuredClone(current.configuredWordPool.built),
      summary: structuredClone(current.configuredWordPool.summary)
    };
    current.participantOrder = order;
    current.cursor = 0;
    current.startingWord = startingWord;
    current.history = [];
    current.artifacts.clear();
    current.frameStore.clear();
    current.passedPlayerIds.clear();
    current.result = null;
    current.replayJobId = replayJobId;
    context.room.lastReplayJobId = replayJobId;
    current.replay = { status: "recording" };
    current.replayStartedAt = effectiveNow(context);
    current.replayPausedAt = null;
    current.replayPausedTotalMs = 0;
    this.#replay.addEvent(replayJobId, {
      kind: "starting-word",
      text: `起始词：${startingWord.text}`
    });
    const wordInput: Extract<RelayImmutableInput, { kind: "word" }> = {
      kind: "word",
      wordId: startingWord.id,
      text: startingWord.text,
      contentHash: contentHash("word", startingWord.text)
    };
    this.#createDrawingPreparation(context, 0, wordInput, wordInput);
    context.broadcastSnapshots();
  }

  returnToLobby(context: ModeContext): void {
    const current = state(context);
    if (current.phase !== "RESULT") {
      throw new GameError(ErrorCode.INVALID_STATE, "接龙尚未结束");
    }
    this.#clearRuntime(context, false);
    current.phase = "LOBBY";
    current.recordingConfirmedPlayerIds.clear();
    current.replay = this.#replay.capabilityService.capability.available
      ? { status: "idle" }
      : {
          status: "unavailable",
          message: this.#replay.capabilityService.capability.message
        };
    context.broadcastSnapshots();
  }

  handleCommand(
    context: ModeContext,
    playerId: string,
    command: ClientJsonMessage
  ): boolean {
    const current = state(context);
    if (command.type === "relay:recording-consent") {
      if (
        command.modeSessionId !== context.room.modeSessionId ||
        current.phase !== "LOBBY"
      ) {
        throw new GameError(ErrorCode.INVALID_STATE, "接龙录制确认已失效", 409);
      }
      if (command.confirmed) {
        current.recordingConfirmedPlayerIds.add(playerId);
      } else {
        current.recordingConfirmedPlayerIds.delete(playerId);
      }
      context.broadcastSnapshots();
      return true;
    }
    if (command.type === "relay:task-ready") {
      this.#assertMutable(context, command.modeSessionId);
      const step = current.activeStep;
      if (
        !step ||
        step.playerId !== playerId ||
        step.actorStepId !== command.actorStepId ||
        step.ready
      ) {
        throw new GameError(ErrorCode.INVALID_STATE, "接龙私密任务 ready 已失效", 409);
      }
      if (
        step.kind === "guessing" &&
        (step.immutableInput.kind !== "drawing" ||
          step.immutableInput.revision !== command.revision)
      ) {
        throw new GameError(ErrorCode.INVALID_STATE, "接龙画面 revision 不匹配", 409);
      }
      step.ready = true;
      if (step.kind === "guessing") {
        this.#startGuessing(context);
      } else {
        this.#beginDrawingCountdown(context);
      }
      return true;
    }
    if (command.type === "relay:submit-guess") {
      this.#assertMutable(context, command.modeSessionId);
      const step = current.activeStep;
      if (
        current.phase !== "GUESSING" ||
        !step ||
        step.kind !== "guessing" ||
        step.playerId !== playerId ||
        step.actorStepId !== command.actorStepId
      ) {
        throw new GameError(ErrorCode.INVALID_STATE, "当前不能提交接龙猜词", 409);
      }
      this.#acceptGuess(context, step, validRelayGuess(command.guess));
      return true;
    }
    if (command.type === "drawing:finish") {
      this.#assertMutable(context, command.modeSessionId);
      const step = current.activeStep;
      if (
        current.phase !== "DRAWING" ||
        !step ||
        step.playerId !== playerId ||
        step.actorStepId !== command.actorStepId ||
        step.drawing?.status !== "drawing"
      ) {
        throw new GameError(ErrorCode.INVALID_STATE, "当前接龙绘制无法完成", 409);
      }
      this.#beginFinalization(context);
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
    const step = current.activeStep;
    if (
      !step ||
      step.playerId !== command.targetPlayerId ||
      step.actorStepId !== command.actorStepId
    ) {
      throw new GameError(ErrorCode.INVALID_STATE, "接龙 actor step 已失效", 409);
    }
    if (current.phase === "FINALIZING" && step.drawing?.status === "finalizing") {
      this.#finalizeDrawingStep(context, initiatedByHost ? "host-pass" : "self-pass");
      return { kind: "finalize-current-frame" };
    }
    if (
      current.phase !== "PREPARING" &&
      current.phase !== "COUNTDOWN" &&
      current.phase !== "DRAWING" &&
      current.phase !== "GUESSING"
    ) {
      throw new GameError(ErrorCode.INVALID_STATE, "当前接龙阶段不能 Pass", 409);
    }
    this.#passActiveStep(context, "passed");
    return state(context).phase === "RESULT"
      ? { kind: "end-without-result", reason: "last-player-passed" }
      : { kind: "handoff-input" };
  }

  handleAcceptedFrame(
    context: ModeContext,
    playerId: string,
    captureSessionId: number,
    mimeType: EncodedImageMimeType,
    bytes: Uint8Array
  ): AcceptedModeFrame | null {
    const current = state(context);
    const step = current.activeStep;
    const drawing = step?.drawing;
    if (
      !step ||
      step.playerId !== playerId ||
      !drawing ||
      (drawing.status !== "drawing" && drawing.status !== "finalizing") ||
      drawing.captureSessionId !== captureSessionId
    ) {
      return null;
    }
    const frame = current.frameStore.accept(step.actorStepId, {
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
    if (current.replayJobId) {
      this.#replay.recordFrame(
        current.replayJobId,
        step.actorStepId,
        playerId,
        frame,
        this.#activeReplayTime(context),
        drawing.status
      );
    }
    return { frame, audience: "self" };
  }

  latestFrameForViewer(context: ModeContext, viewerId: string): AcceptedFrame | null {
    const current = state(context);
    const step = current.activeStep;
    const frame =
      step?.playerId === viewerId &&
      (step.drawing?.status === "drawing" || step.drawing?.status === "finalizing")
        ? current.frameStore.get(step.actorStepId)
        : null;
    return frame && step?.drawing && step.drawing.status !== "finalized"
      ? { ...frame, captureSessionId: step.drawing.captureSessionId }
      : frame;
  }

  onPlayerConnectionChanged(context: ModeContext, playerId: string): void {
    const step = state(context).activeStep;
    const drawing = step?.drawing;
    if (
      step?.playerId === playerId &&
      drawing &&
      (drawing.status === "drawing" || drawing.status === "finalizing") &&
      context.isCaptureReady(context.room.players.get(playerId))
    ) {
      this.#issueCapture(context, drawing);
    }
  }

  pause(context: ModeContext, at: number): void {
    const current = state(context);
    if (current.replayStartedAt !== null && current.replayPausedAt === null) {
      current.replayPausedAt = at;
    }
  }

  resume(context: ModeContext, pausedDurationMs: number, captureDelayMs: number): void {
    const current = state(context);
    current.replayPausedTotalMs += pausedDurationMs + captureDelayMs;
    current.replayPausedAt = null;
    const delta = pausedDurationMs + captureDelayMs;
    if (current.startsAt !== null) {
      current.startsAt += delta;
    }
    if (current.phaseEndsAt !== null) {
      current.phaseEndsAt += delta;
    }
    if (current.activeStep?.drawing) {
      shiftDrawingDeadlines(current.activeStep.drawing, delta);
      if (
        captureDelayMs > 0 &&
        (current.activeStep.drawing.status === "drawing" ||
          current.activeStep.drawing.status === "finalizing")
      ) {
        current.activeStep.drawing.captureSessionId =
          context.allocateCaptureSessionId();
      }
    }
    if (captureDelayMs > 0 && this.requiresCaptureOnResume(context)) {
      context.room.modeScheduler.scheduleAt(
        `relay:capture-resume:${context.room.modeSessionId}`,
        context.now() + captureDelayMs,
        () => {
          const drawing = state(context).activeStep?.drawing;
          if (drawing?.status === "drawing" || drawing?.status === "finalizing") {
            this.#issueCapture(context, drawing);
          }
        }
      );
    }
  }

  requiresCaptureOnResume(context: ModeContext): boolean {
    const drawing = state(context).activeStep?.drawing;
    return drawing?.status === "drawing" || drawing?.status === "finalizing";
  }

  dispose(context: ModeContext): void {
    this.#clearRuntime(context, true);
  }

  async handlePartialReplay(
    context: ModeContext,
    choice: "encode-and-save" | "discard"
  ): Promise<void> {
    const current = state(context);
    const jobId = current.replayJobId;
    if (!jobId) {
      return;
    }
    if (choice === "discard") {
      await this.#replay.discard(jobId);
      current.replayJobId = null;
      if (context.room.lastReplayJobId === jobId) {
        context.room.lastReplayJobId = null;
      }
      return;
    }
    current.replay = { status: "preparing" };
    void this.#replay.finalize(jobId, true).catch(() => undefined);
  }

  privateTask(context: ModeContext, viewerId: string): RelayPrivateTask {
    const current = state(context);
    const step = current.activeStep;
    if (!step || step.playerId !== viewerId || current.phase === "RESULT") {
      throw new GameError(ErrorCode.FORBIDDEN, "当前没有属于你的接龙私密任务", 403);
    }
    if (step.kind === "guessing") {
      if (step.immutableInput.kind !== "drawing") {
        throw new GameError(ErrorCode.INTERNAL_ERROR, "接龙画面任务状态损坏", 500);
      }
      return {
        kind: "drawing",
        actorStepId: step.actorStepId,
        artifactId: step.immutableInput.artifactId,
        revision: step.immutableInput.revision,
        available: step.immutableInput.frame !== null
      };
    }
    const prompt = step.drawingPrompt;
    if (!prompt) {
      throw new GameError(ErrorCode.INTERNAL_ERROR, "接龙绘制提示状态损坏", 500);
    }
    return {
      kind: "word",
      actorStepId: step.actorStepId,
      word: prompt.text
    };
  }

  activeArtifact(
    context: ModeContext,
    viewerId: string,
    artifactId: string,
    revision: string
  ): AcceptedFrame {
    const step = state(context).activeStep;
    if (
      !step ||
      step.playerId !== viewerId ||
      step.kind !== "guessing" ||
      step.immutableInput.kind !== "drawing" ||
      step.immutableInput.artifactId !== artifactId ||
      step.immutableInput.revision !== revision ||
      !step.immutableInput.frame
    ) {
      throw new GameError(ErrorCode.NOT_FOUND, "接龙私密画面不存在或已失效", 404);
    }
    return step.immutableInput.frame;
  }

  resultArtifact(
    context: ModeContext,
    resultId: string,
    resultArtifactId: string
  ): AcceptedFrame {
    const current = state(context);
    if (
      current.phase !== "RESULT" ||
      !current.result ||
      current.result.resultId !== resultId
    ) {
      throw new GameError(ErrorCode.NOT_FOUND, "接龙结果已失效", 404);
    }
    const artifactId = [...current.result.resultArtifactIds].find(
      ([, publicId]) => publicId === resultArtifactId
    )?.[0];
    const artifact = artifactId ? current.artifacts.get(artifactId) : undefined;
    if (!artifact?.frame) {
      throw new GameError(ErrorCode.NOT_FOUND, "接龙结果画面不存在", 404);
    }
    return artifact.frame;
  }

  #createDrawingPreparation(
    context: ModeContext,
    position: number,
    immutableInput: RelayImmutableInput,
    drawingPrompt: Extract<RelayImmutableInput, { kind: "word" }>
  ): void {
    const current = state(context);
    const playerId = current.participantOrder[position];
    if (!playerId) {
      this.#finishResult(context, null, "all-passed");
      return;
    }
    current.cursor = position;
    current.phase = "PREPARING";
    current.startsAt = null;
    current.phaseEndsAt = null;
    current.activeStep = {
      actorStepId: context.randomId(12),
      playerId,
      position,
      kind: "drawing",
      immutableInput,
      drawingPrompt,
      ready: false,
      drawing: null,
      submittedGuess: null
    };
  }

  #createGuessingPreparation(
    context: ModeContext,
    position: number,
    input: Extract<RelayImmutableInput, { kind: "drawing" }>
  ): void {
    const current = state(context);
    const playerId = current.participantOrder[position];
    if (!playerId) {
      this.#finishResult(context, null, "all-passed");
      return;
    }
    current.cursor = position;
    current.phase = "GUESSING";
    current.startsAt = null;
    current.phaseEndsAt = null;
    current.activeStep = {
      actorStepId: context.randomId(12),
      playerId,
      position,
      kind: "guessing",
      immutableInput: input,
      drawingPrompt: null,
      ready: false,
      drawing: null,
      submittedGuess: null
    };
  }

  #beginDrawingCountdown(context: ModeContext): void {
    const current = state(context);
    const step = current.activeStep;
    if (!step || step.kind !== "drawing" || !step.ready) {
      return;
    }
    current.phase = "COUNTDOWN";
    current.startsAt = effectiveNow(context) + SYNCHRONIZED_COUNTDOWN_MS;
    current.phaseEndsAt = current.startsAt;
    const modeSessionId = context.room.modeSessionId;
    const actorStepId = step.actorStepId;
    context.room.modeScheduler.scheduleAt(
      this.#phaseTimerKey(context),
      current.startsAt,
      () => {
        if (
          context.room.modeRuntime.mode === "draw-relay" &&
          context.room.modeSessionId === modeSessionId &&
          state(context).activeStep?.actorStepId === actorStepId &&
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
    const step = current.activeStep;
    if (!step || step.kind !== "drawing") {
      return;
    }
    const drawingEndsAt =
      effectiveNow(context) + current.settings.drawingSeconds * 1_000;
    step.drawing = {
      status: "drawing",
      actorStepId: step.actorStepId,
      playerId: step.playerId,
      drawingEndsAt,
      captureSessionId: context.allocateCaptureSessionId(),
      latest: null
    };
    current.phase = "DRAWING";
    current.startsAt = null;
    current.phaseEndsAt = drawingEndsAt;
    this.#issueCapture(context, step.drawing);
    const modeSessionId = context.room.modeSessionId;
    const actorStepId = step.actorStepId;
    context.room.modeScheduler.scheduleAt(
      this.#phaseTimerKey(context),
      drawingEndsAt,
      () => {
        if (
          context.room.modeRuntime.mode === "draw-relay" &&
          context.room.modeSessionId === modeSessionId &&
          state(context).activeStep?.actorStepId === actorStepId &&
          state(context).phase === "DRAWING"
        ) {
          this.#beginFinalization(context);
        }
      }
    );
    context.broadcastSnapshots();
  }

  #beginFinalization(context: ModeContext): void {
    const current = state(context);
    const step = current.activeStep;
    if (!step || step.drawing?.status !== "drawing") {
      return;
    }
    context.room.modeScheduler.cancel(this.#phaseTimerKey(context));
    context.revokeCapture(step.playerId, "session-replaced");
    const finalizing = beginDrawingFinalization({
      drawing: step.drawing,
      now: effectiveNow(context),
      captureSessionId: context.allocateCaptureSessionId(),
      notificationEventId: context.randomId(12)
    });
    step.drawing = finalizing;
    current.phase = "FINALIZING";
    current.phaseEndsAt = finalizing.finalizationEndsAt;
    this.#issueCapture(context, finalizing);
    context.sendToPlayer(step.playerId, {
      type: "drawing:finalization-started",
      modeSessionId: context.room.modeSessionId,
      actorStepId: step.actorStepId,
      eventId: finalizing.notificationEventId,
      endsAt: finalizing.finalizationEndsAt
    });
    const modeSessionId = context.room.modeSessionId;
    const actorStepId = step.actorStepId;
    context.room.modeScheduler.scheduleAt(
      this.#phaseTimerKey(context),
      finalizing.finalizationEndsAt,
      () => {
        if (
          context.room.modeRuntime.mode === "draw-relay" &&
          context.room.modeSessionId === modeSessionId &&
          state(context).activeStep?.actorStepId === actorStepId &&
          state(context).phase === "FINALIZING"
        ) {
          this.#finalizeDrawingStep(context, "deadline");
        }
      }
    );
    context.broadcastSnapshots();
  }

  #finalizeDrawingStep(
    context: ModeContext,
    finalizedBy: "deadline" | "self-pass" | "host-pass"
  ): void {
    const current = state(context);
    const step = current.activeStep;
    if (!step || step.drawing?.status !== "finalizing") {
      return;
    }
    context.room.modeScheduler.cancel(this.#phaseTimerKey(context));
    context.revokeCapture(step.playerId, "finalized", true);
    const finalized = finalizeDrawing(step.drawing, finalizedBy);
    step.drawing = finalized;
    const artifactId = context.randomId(16);
    const artifact: RelayArtifact = {
      artifactId,
      frame: finalized.finalFrame
    };
    current.artifacts.set(artifactId, artifact);
    current.history.push({
      kind: "draw",
      playerId: step.playerId,
      input: step.immutableInput,
      artifact,
      status: finalized.finalFrame ? "completed" : "no-frame"
    });
    const nextPosition = step.position + 1;
    if (nextPosition >= current.participantOrder.length) {
      this.#finishResult(context, null, "all-passed");
      return;
    }
    const drawingInput: Extract<RelayImmutableInput, { kind: "drawing" }> = {
      kind: "drawing",
      artifactId,
      revision: finalized.finalFrame?.revision ?? null,
      contentHash: finalized.finalFrame
        ? contentHash("drawing", finalized.finalFrame.revision)
        : contentHash("drawing", `no-frame:${artifactId}`),
      frame: finalized.finalFrame
    };
    this.#createGuessingPreparation(context, nextPosition, drawingInput);
    context.broadcastSnapshots();
  }

  #startGuessing(context: ModeContext): void {
    const current = state(context);
    const step = current.activeStep;
    if (!step || step.kind !== "guessing" || !step.ready) {
      return;
    }
    current.phase = "GUESSING";
    current.phaseEndsAt =
      effectiveNow(context) + current.settings.guessingSeconds * 1_000;
    const modeSessionId = context.room.modeSessionId;
    const actorStepId = step.actorStepId;
    context.room.modeScheduler.scheduleAt(
      this.#phaseTimerKey(context),
      current.phaseEndsAt,
      () => {
        if (
          context.room.modeRuntime.mode === "draw-relay" &&
          context.room.modeSessionId === modeSessionId &&
          state(context).activeStep?.actorStepId === actorStepId &&
          state(context).phase === "GUESSING"
        ) {
          this.#passActiveStep(context, "timed-out");
        }
      }
    );
    context.broadcastSnapshots();
  }

  #acceptGuess(context: ModeContext, step: RelayActorStep, guess: string): void {
    const current = state(context);
    context.room.modeScheduler.cancel(this.#phaseTimerKey(context));
    if (step.immutableInput.kind !== "drawing") {
      throw new GameError(ErrorCode.INTERNAL_ERROR, "接龙猜词输入状态损坏", 500);
    }
    step.submittedGuess = guess;
    current.history.push({
      kind: "guess",
      playerId: step.playerId,
      inputArtifactId: step.immutableInput.artifactId,
      guess,
      status: "completed"
    });
    if (current.replayJobId) {
      this.#replay.addEvent(current.replayJobId, {
        kind: "guess",
        text: `猜词：${guess}`
      });
    }
    if (step.position === current.participantOrder.length - 1) {
      this.#finishResult(context, guess, "completed");
      return;
    }
    const prompt: Extract<RelayImmutableInput, { kind: "word" }> = {
      kind: "word",
      wordId: context.randomId(12),
      text: guess,
      contentHash: contentHash("word", guess)
    };
    this.#createDrawingPreparation(context, step.position, step.immutableInput, prompt);
    context.broadcastSnapshots();
  }

  #passActiveStep(context: ModeContext, status: "passed" | "timed-out"): void {
    const current = state(context);
    const step = current.activeStep;
    if (!step) {
      return;
    }
    context.room.modeScheduler.cancel(this.#phaseTimerKey(context));
    context.revokeCapture(step.playerId, "finalized", true);
    current.frameStore.delete(step.actorStepId);
    current.passedPlayerIds.add(step.playerId);
    if (step.kind === "guessing") {
      if (step.immutableInput.kind !== "drawing") {
        throw new GameError(ErrorCode.INTERNAL_ERROR, "接龙 Pass 输入损坏", 500);
      }
      current.history.push({
        kind: "guess",
        playerId: step.playerId,
        inputArtifactId: step.immutableInput.artifactId,
        guess: null,
        status
      });
    } else {
      current.history.push({
        kind: "draw",
        playerId: step.playerId,
        input: step.immutableInput,
        artifact: null,
        status
      });
    }
    if (current.replayJobId) {
      this.#replay.addEvent(current.replayJobId, {
        kind: status === "passed" ? "pass" : "timeout",
        text: status === "passed" ? "本步骤 Pass" : "本步骤超时"
      });
    }
    const nextPosition = step.position + 1;
    if (nextPosition >= current.participantOrder.length) {
      this.#finishResult(context, null, status === "passed" ? "pass" : "timeout");
      return;
    }
    if (step.immutableInput.kind === "word") {
      this.#createDrawingPreparation(
        context,
        nextPosition,
        step.immutableInput,
        step.immutableInput
      );
    } else {
      this.#createGuessingPreparation(context, nextPosition, step.immutableInput);
    }
    context.broadcastSnapshots();
  }

  #finishResult(
    context: ModeContext,
    finalGuess: string | null,
    reason: "completed" | "pass" | "timeout" | "all-passed"
  ): void {
    const current = state(context);
    context.room.modeScheduler.cancel(this.#phaseTimerKey(context));
    if (current.activeStep) {
      context.revokeCapture(current.activeStep.playerId, "finalized", true);
    }
    const startingWord = current.startingWord?.text ?? "";
    current.phase = "RESULT";
    current.startsAt = null;
    current.phaseEndsAt = null;
    current.activeStep = null;
    current.result = {
      resultId: context.randomId(16),
      startingWord,
      finalGuess,
      finalGuessReason: reason,
      resultArtifactIds: new Map(
        [...current.artifacts.keys()].map((artifactId) => [
          artifactId,
          context.randomId(16)
        ])
      )
    };
    if (current.replayJobId) {
      this.#replay.addEvent(current.replayJobId, {
        kind: "final-comparison",
        text: `起始词：${startingWord} · 最终猜词：${finalGuess ?? "未作答"}`
      });
      const modeSessionId = context.room.modeSessionId;
      const jobId = current.replayJobId;
      current.replay = { status: "preparing" };
      void this.#replay
        .finalize(jobId)
        .then(() => {
          if (
            context.room.modeRuntime.mode === "draw-relay" &&
            context.room.modeSessionId === modeSessionId &&
            state(context).replayJobId === jobId
          ) {
            state(context).replay = this.#replay.status(jobId);
            context.broadcastSnapshots();
          }
        })
        .catch((error: unknown) => {
          if (
            context.room.modeRuntime.mode === "draw-relay" &&
            context.room.modeSessionId === modeSessionId &&
            state(context).replayJobId === jobId
          ) {
            state(context).replay = {
              status: "failed",
              message: error instanceof Error ? error.message : "回放压制失败",
              canRetry: true
            };
            context.broadcastSnapshots();
          }
        });
    }
    context.broadcastSnapshots();
  }

  #issueCapture(
    context: ModeContext,
    drawing:
      | Extract<NonNullable<RelayActorStep["drawing"]>, { status: "drawing" }>
      | Extract<NonNullable<RelayActorStep["drawing"]>, { status: "finalizing" }>
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

  #activeReplayTime(context: ModeContext): number {
    const current = state(context);
    if (current.replayStartedAt === null) {
      return 0;
    }
    const end =
      current.replayPausedAt ??
      (context.room.runControl.status === "paused"
        ? context.room.runControl.pausedAt
        : context.now());
    return Math.max(0, end - current.replayStartedAt - current.replayPausedTotalMs);
  }

  #currentReplayStatus(current: DrawRelayModeState): PublicReplayStatus {
    if (current.replayJobId) {
      const stored = this.#replay.status(current.replayJobId);
      if (current.replay.status === "preparing" || current.replay.status === "failed") {
        return current.replay;
      }
      return stored;
    }
    return current.replay;
  }

  #playerStatus(
    current: DrawRelayModeState,
    playerId: string
  ): PublicRelayPlayer["status"] {
    if (current.activeStep?.playerId === playerId) {
      return "active";
    }
    const entries = current.history.filter((entry) => entry.playerId === playerId);
    if (entries.some((entry) => entry.status === "passed")) {
      return "passed";
    }
    if (entries.some((entry) => entry.status === "timed-out")) {
      return "timed-out";
    }
    if (entries.length > 0) {
      return "completed";
    }
    return "waiting";
  }

  #clearRuntime(context: ModeContext, switching: boolean): void {
    const current = state(context);
    context.room.modeScheduler.cancelAll();
    if (current.activeStep) {
      context.revokeCapture(
        current.activeStep.playerId,
        switching ? "mode-switched" : "finalized",
        true
      );
    }
    current.participantOrder = [];
    current.cursor = 0;
    current.startingWord = null;
    current.activeStep = null;
    current.history = [];
    current.artifacts.clear();
    current.frameStore.clear();
    current.gameWordPool = null;
    current.startsAt = null;
    current.phaseEndsAt = null;
    current.result = null;
    current.passedPlayerIds.clear();
    current.replayStartedAt = null;
    current.replayPausedAt = null;
    current.replayPausedTotalMs = 0;
  }

  #assertMutable(context: ModeContext, modeSessionId: string): void {
    if (context.room.modeSessionId !== modeSessionId) {
      throw new GameError(ErrorCode.INVALID_STATE, "接龙模式会话已失效", 409);
    }
    if (context.room.runControl.status === "paused") {
      throw new GameError(ErrorCode.INVALID_STATE, "游戏已暂停", 409);
    }
  }

  #phaseTimerKey(context: ModeContext): string {
    return `relay:phase:${context.room.modeSessionId}`;
  }
}
