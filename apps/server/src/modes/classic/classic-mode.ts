import {
  CONTENT_LIMITS,
  WordPoolUploadSchema,
  createWordDeck,
  drawWordOptions,
  markDeckAnswer,
  type NormalizedPoolWord,
  type WordPoolUpload
} from "@draw-guess/content";
import { buildDrawerQueue, resolveGuess } from "@draw-guess/game-rules";
import {
  ClassicModeSettingsSchema,
  ErrorCode,
  type ClientJsonMessage,
  type EncodedImageMimeType
} from "@draw-guess/protocol";
import {
  DEFAULT_CLASSIC_SETTINGS,
  type PublicClassicModeState,
  type PublicPassableActor,
  type PublicTurnResult
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
import type {
  AcceptedModeFrame,
  GameModeController,
  ModeStartReason,
  ModeContext,
  PassCommand,
  PassEffect,
  ReturnToLobbyReason
} from "../game-mode.js";
import type { ClassicModeState } from "./classic-state.js";

const CLASSIC_FRAME_MEMORY_BYTES = 2 * 1024 * 1024;

function state(context: ModeContext): ClassicModeState {
  if (context.room.modeRuntime.mode !== "classic") {
    throw new GameError(ErrorCode.INVALID_STATE, "当前不是经典模式", 409);
  }
  return context.room.modeRuntime.state;
}

function effectiveNow(context: ModeContext): number {
  return context.room.runControl.status === "paused"
    ? context.room.runControl.pausedAt
    : context.now();
}

export interface ClassicModeOptions {
  reconnectGraceMs: number;
  turnResultMs: number;
}

export class ClassicModeController implements GameModeController<"classic"> {
  readonly id = "classic" as const;
  readonly #options: ClassicModeOptions;

  constructor(options: ClassicModeOptions) {
    this.#options = options;
  }

  createLobbyState(): ClassicModeState {
    return {
      phase: "LOBBY",
      settings: { ...DEFAULT_CLASSIC_SETTINGS },
      configuredWordPool: createDefaultRoomWordPool(),
      gameWordPool: null,
      wordDeck: null,
      wordPoolUpdatedAt: null,
      scores: new Map(),
      drawerQueue: [],
      drawerIndex: -1,
      currentDrawerId: null,
      currentTurnId: 0,
      currentRound: 0,
      currentOptions: [],
      currentOptionWords: new Map(),
      selectedWord: null,
      correctGuesserIds: new Set(),
      turnScoreStart: new Map(),
      phaseEndsAt: null,
      turnResult: null,
      pendingTurnEndReason: "TIME_UP",
      actorStepId: null,
      drawing: null,
      passedPlayerIds: new Set(),
      eligibleHandoffPlayerIds: [],
      frameStore: new LatestFrameStore(CLASSIC_FRAME_MEMORY_BYTES)
    };
  }

  publicStateFor(context: ModeContext, viewerId: string): PublicClassicModeState {
    const current = state(context);
    return {
      mode: "classic",
      phase: current.phase,
      settings: { ...current.settings },
      wordPool: structuredClone(
        (current.gameWordPool ?? current.configuredWordPool).summary
      ),
      scores: Object.fromEntries(current.scores),
      currentDrawerId: current.currentDrawerId,
      currentTurnId: current.currentTurnId,
      currentRound: current.currentRound,
      totalRounds: current.settings.rounds,
      turnNumber: Math.max(0, current.drawerIndex + 1),
      totalTurns: current.drawerQueue.length,
      phaseEndsAt: current.phaseEndsAt,
      correctGuesserIds: [...current.correctGuesserIds],
      passedPlayerIds: [...current.passedPlayerIds],
      turnResult: current.turnResult ? structuredClone(current.turnResult) : null,
      selfDrawing:
        current.currentDrawerId === viewerId
          ? publicDrawingLifecycle(current.drawing)
          : null
    };
  }

  passableActors(context: ModeContext, viewerId: string): PublicPassableActor[] {
    const current = state(context);
    const playerId = current.currentDrawerId;
    const actorStepId = current.actorStepId;
    if (
      !playerId ||
      !actorStepId ||
      (viewerId !== playerId && context.room.hostId !== viewerId)
    ) {
      return [];
    }
    if (current.phase === "WORD_SELECTION" || current.phase === "DRAWING") {
      return [
        {
          actorStepId,
          targetPlayerId: playerId,
          phase: current.phase,
          effect: "handoff-input"
        }
      ];
    }
    if (current.phase === "FINALIZING") {
      return [
        {
          actorStepId,
          targetPlayerId: playerId,
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
      throw new GameError(ErrorCode.INVALID_STATE, "只能在经典模式大厅修改设置");
    }
    current.settings = ClassicModeSettingsSchema.parse(value);
  }

  updateWordPool(
    context: ModeContext,
    uploadInput: WordPoolUpload
  ): PublicClassicModeState["wordPool"] {
    const current = state(context);
    if (current.phase !== "LOBBY") {
      throw new GameError(ErrorCode.INVALID_STATE, "只能在大厅为下一局更新词库", 409);
    }
    const now = context.now();
    if (current.wordPoolUpdatedAt !== null && now - current.wordPoolUpdatedAt < 500) {
      throw new GameError(ErrorCode.RATE_LIMITED, "词库更新太频繁，请稍后再试", 429);
    }
    const upload = WordPoolUploadSchema.parse(uploadInput);
    current.configuredWordPool = createRoomWordPool(upload);
    current.wordPoolUpdatedAt = now;
    return structuredClone(current.configuredWordPool.summary);
  }

  start(context: ModeContext, reason: ModeStartReason = "normal"): void {
    const current = state(context);
    if (current.phase !== "LOBBY") {
      throw new GameError(ErrorCode.INVALID_STATE, "经典模式游戏已经开始");
    }
    const connected = [...context.room.players.values()].filter((player) =>
      context.isOpen(player)
    );
    if (connected.length < 2) {
      throw new GameError(ErrorCode.INVALID_STATE, "至少需要两名在线玩家");
    }
    if (
      current.configuredWordPool.built.words.length <
      CONTENT_LIMITS.minimumPlayableWords
    ) {
      throw new GameError(ErrorCode.INVALID_STATE, "本局词池至少需要 3 个有效唯一词条");
    }
    current.drawerQueue = buildDrawerQueue(
      [...context.room.players.values()].map((player) => ({
        playerId: player.id,
        joinedAt: player.joinedAt,
        captureReady: context.isCaptureReady(player)
      })),
      current.settings.rounds
    );
    if (current.drawerQueue.length === 0) {
      throw new GameError(
        ErrorCode.INVALID_STATE,
        "至少需要一名已确认采集来源的桌面玩家"
      );
    }
    current.scores = new Map(
      [...context.room.players.keys()].map((playerId) => [playerId, 0])
    );
    current.gameWordPool = {
      ...current.configuredWordPool,
      upload: structuredClone(current.configuredWordPool.upload),
      built: structuredClone(current.configuredWordPool.built),
      summary: structuredClone(current.configuredWordPool.summary)
    };
    current.wordDeck = createWordDeck(current.gameWordPool.built.words);
    current.drawerIndex = 0;
    if (reason === "normal") {
      context.room.chat = [];
    }
    this.#beginSelection(context, true);
  }

  returnToLobby(context: ModeContext, reason: ReturnToLobbyReason = "completed"): void {
    const current = state(context);
    if (reason !== "restart" && current.phase !== "GAME_RESULT") {
      throw new GameError(ErrorCode.INVALID_STATE, "经典模式游戏尚未结束");
    }
    this.#resetRoundState(context, current);
    current.phase = "LOBBY";
    current.scores.clear();
    if (reason === "completed") {
      context.room.chat = [];
    }
  }

  handleCommand(
    context: ModeContext,
    playerId: string,
    command: ClientJsonMessage
  ): boolean {
    const current = state(context);
    if (command.type === "classic:word-select") {
      this.#assertMutable(context, command.modeSessionId);
      if (
        current.phase !== "WORD_SELECTION" ||
        current.currentDrawerId !== playerId ||
        current.actorStepId !== command.actorStepId
      ) {
        throw new GameError(ErrorCode.FORBIDDEN, "只有当前画手可以选词", 403);
      }
      const option = current.currentOptionWords.get(command.optionId);
      if (!option) {
        throw new GameError(ErrorCode.BAD_MESSAGE, "候选词无效");
      }
      this.#startDrawing(context, option);
      return true;
    }
    if (command.type === "drawing:finish") {
      this.#assertMutable(context, command.modeSessionId);
      if (
        current.phase !== "DRAWING" ||
        current.currentDrawerId !== playerId ||
        current.actorStepId !== command.actorStepId
      ) {
        throw new GameError(ErrorCode.INVALID_STATE, "当前绘制步骤无法完成", 409);
      }
      this.#beginFinalization(context);
      return true;
    }
    if (command.type === "chat:submit" && current.phase === "DRAWING") {
      this.#submitGuess(context, playerId, command.text);
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
    if (
      current.currentDrawerId !== command.targetPlayerId ||
      current.actorStepId !== command.actorStepId
    ) {
      throw new GameError(ErrorCode.INVALID_STATE, "经典模式 actor step 已失效", 409);
    }
    if (current.phase === "FINALIZING") {
      this.#finalize(context, initiatedByHost ? "host-pass" : "self-pass");
      return { kind: "finalize-current-frame" };
    }
    if (current.phase !== "WORD_SELECTION" && current.phase !== "DRAWING") {
      throw new GameError(ErrorCode.INVALID_STATE, "当前阶段不能 Pass", 409);
    }
    const previousPhase = current.phase;
    current.passedPlayerIds.add(command.targetPlayerId);
    context.room.modeScheduler.cancel(this.#phaseTimerKey(context));
    context.revokeCapture(command.targetPlayerId, "session-replaced");
    current.frameStore.clear();
    current.drawing = null;
    const nextPlayerId = current.eligibleHandoffPlayerIds.find(
      (candidateId) =>
        !current.passedPlayerIds.has(candidateId) &&
        context.isCaptureReady(context.room.players.get(candidateId))
    );
    if (!nextPlayerId) {
      this.#endTurn(context, "ALL_PASSED");
      return { kind: "end-without-result", reason: "all-passed" };
    }
    current.currentDrawerId = nextPlayerId;
    current.actorStepId = context.randomId(12);
    current.phaseEndsAt =
      effectiveNow(context) +
      (previousPhase === "WORD_SELECTION"
        ? current.settings.selectionSeconds
        : current.settings.drawingSeconds) *
        1_000;
    if (previousPhase === "WORD_SELECTION") {
      this.#scheduleSelectionDeadline(context);
      this.#sendOptions(context);
    } else {
      if (!current.selectedWord) {
        throw new GameError(ErrorCode.INTERNAL_ERROR, "经典模式答案状态丢失", 500);
      }
      this.#createDrawingLifecycle(context, current.selectedWord, false);
    }
    context.broadcastSnapshots();
    return { kind: "handoff-input" };
  }

  handleAcceptedFrame(
    context: ModeContext,
    playerId: string,
    captureSessionId: number,
    mimeType: EncodedImageMimeType,
    bytes: Uint8Array
  ): AcceptedModeFrame | null {
    const current = state(context);
    const drawing = current.drawing;
    if (
      !drawing ||
      drawing.playerId !== playerId ||
      (drawing.status !== "drawing" && drawing.status !== "finalizing") ||
      drawing.captureSessionId !== captureSessionId
    ) {
      return null;
    }
    const frame = current.frameStore.accept("classic", {
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
    return { frame, audience: "room" };
  }

  latestFrameForViewer(context: ModeContext): AcceptedFrame | null {
    const current = state(context);
    const frame =
      current.phase === "DRAWING" || current.phase === "FINALIZING"
        ? current.frameStore.get("classic")
        : null;
    return frame && current.drawing && current.drawing.status !== "finalized"
      ? { ...frame, captureSessionId: current.drawing.captureSessionId }
      : frame;
  }

  onPlayerConnectionChanged(context: ModeContext, playerId: string): void {
    const current = state(context);
    if (current.currentDrawerId === playerId) {
      const player = context.room.players.get(playerId);
      if (
        (current.phase === "WORD_SELECTION" || current.phase === "DRAWING") &&
        !context.isCaptureReady(player)
      ) {
        this.#scheduleDrawerGrace(context);
      } else if (context.isCaptureReady(player)) {
        context.room.modeScheduler.cancel(this.#drawerGraceKey(context));
        if (current.phase === "WORD_SELECTION") {
          this.#sendOptions(context);
        } else if (current.phase === "DRAWING" && current.selectedWord) {
          this.#sendSelectedWord(context);
          this.#reissueCurrentCapture(context);
        } else if (current.phase === "FINALIZING") {
          this.#reissueCurrentCapture(context);
        }
      }
    }
  }

  pause(_context: ModeContext, _at: number): void {
    // The common scheduler and grant layer owns the frozen runtime resources.
  }

  resume(context: ModeContext, pausedDurationMs: number, captureDelayMs: number): void {
    const current = state(context);
    const delta = pausedDurationMs + captureDelayMs;
    if (current.phaseEndsAt !== null) {
      current.phaseEndsAt += delta;
    }
    if (current.drawing) {
      shiftDrawingDeadlines(current.drawing, delta);
    }
    if (captureDelayMs > 0 && this.requiresCaptureOnResume(context)) {
      if (
        current.drawing?.status === "drawing" ||
        current.drawing?.status === "finalizing"
      ) {
        current.drawing.captureSessionId = context.allocateCaptureSessionId();
      }
      context.room.modeScheduler.scheduleAt(
        `classic:capture-resume:${context.room.modeSessionId}`,
        context.now() + captureDelayMs,
        () => this.#reissueCurrentCapture(context)
      );
    }
  }

  requiresCaptureOnResume(context: ModeContext): boolean {
    const phase = state(context).phase;
    return phase === "DRAWING" || phase === "FINALIZING";
  }

  dispose(context: ModeContext): void {
    const current = state(context);
    current.frameStore.clear();
    current.currentOptionWords.clear();
    current.currentOptions = [];
    current.selectedWord = null;
    current.wordDeck = null;
    current.gameWordPool = null;
    current.drawing = null;
    current.correctGuesserIds.clear();
    current.passedPlayerIds.clear();
  }

  #beginSelection(context: ModeContext, newLogicalTurn: boolean): void {
    const current = state(context);
    const turn = current.drawerQueue[current.drawerIndex];
    if (!turn || !current.wordDeck) {
      throw new GameError(ErrorCode.INVALID_STATE, "没有可用的经典模式画手");
    }
    current.phase = "WORD_SELECTION";
    current.currentDrawerId = turn.playerId;
    current.currentRound = turn.round;
    if (newLogicalTurn) {
      current.currentTurnId = context.allocateLogicalTurnId();
      const options = drawWordOptions(current.wordDeck, 3, (maximum) =>
        context.randomIndex(maximum)
      );
      current.currentOptionWords = new Map(
        options.map((word) => [context.randomId(10), word])
      );
      current.currentOptions = [...current.currentOptionWords].map(([id, word]) => ({
        id,
        label: word.text,
        category: word.category
      }));
      current.eligibleHandoffPlayerIds = [
        turn.playerId,
        ...[
          ...new Set(current.drawerQueue.map((candidate) => candidate.playerId))
        ].filter((candidate) => candidate !== turn.playerId)
      ];
      current.passedPlayerIds.clear();
      current.correctGuesserIds.clear();
      current.turnResult = null;
      current.selectedWord = null;
      current.turnScoreStart = new Map(current.scores);
      current.frameStore.clear();
    }
    current.actorStepId = context.randomId(12);
    current.drawing = null;
    current.phaseEndsAt =
      effectiveNow(context) + current.settings.selectionSeconds * 1_000;
    this.#scheduleSelectionDeadline(context);
    this.#sendOptions(context);
    context.broadcastSnapshots();
    this.#scheduleDrawerGrace(context);
  }

  #scheduleSelectionDeadline(context: ModeContext): void {
    const current = state(context);
    const modeSessionId = context.room.modeSessionId;
    const actorStepId = current.actorStepId;
    const deadline = current.phaseEndsAt;
    if (!actorStepId || deadline === null) {
      return;
    }
    context.room.modeScheduler.scheduleAt(
      this.#phaseTimerKey(context),
      deadline,
      () => {
        if (
          context.room.modeRuntime.mode !== "classic" ||
          context.room.modeSessionId !== modeSessionId
        ) {
          return;
        }
        const latest = state(context);
        if (latest.phase !== "WORD_SELECTION" || latest.actorStepId !== actorStepId) {
          return;
        }
        const values = [...latest.currentOptionWords.values()];
        const option = values[context.randomIndex(values.length)];
        if (option) {
          this.#startDrawing(context, option);
        }
      }
    );
  }

  #startDrawing(context: ModeContext, word: NormalizedPoolWord): void {
    const current = state(context);
    context.room.modeScheduler.cancel(this.#phaseTimerKey(context));
    current.phase = "DRAWING";
    current.selectedWord = word;
    if (current.wordDeck) {
      markDeckAnswer(current.wordDeck, word);
    }
    current.currentOptions = [];
    current.currentOptionWords.clear();
    current.correctGuesserIds.clear();
    current.turnScoreStart = new Map(current.scores);
    current.frameStore.clear();
    current.actorStepId = context.randomId(12);
    this.#createDrawingLifecycle(context, word, true);
    context.broadcastSnapshots();
    this.#scheduleDrawerGrace(context);
  }

  #createDrawingLifecycle(
    context: ModeContext,
    _word: NormalizedPoolWord,
    sendPrivateWord: boolean
  ): void {
    const current = state(context);
    if (!current.currentDrawerId || !current.actorStepId) {
      throw new GameError(ErrorCode.INTERNAL_ERROR, "经典画手状态不存在", 500);
    }
    const captureSessionId = context.allocateCaptureSessionId();
    const drawingEndsAt =
      effectiveNow(context) + current.settings.drawingSeconds * 1_000;
    current.phase = "DRAWING";
    current.phaseEndsAt = drawingEndsAt;
    current.drawing = {
      status: "drawing",
      actorStepId: current.actorStepId,
      playerId: current.currentDrawerId,
      drawingEndsAt,
      captureSessionId,
      latest: null
    };
    if (sendPrivateWord) {
      this.#sendSelectedWord(context);
    } else {
      this.#sendSelectedWord(context);
    }
    context.issueCapture({
      playerId: current.currentDrawerId,
      actorStepId: current.actorStepId,
      captureSessionId,
      stage: "drawing",
      expiresAt: drawingEndsAt
    });
    const modeSessionId = context.room.modeSessionId;
    const actorStepId = current.actorStepId;
    context.room.modeScheduler.scheduleAt(
      this.#phaseTimerKey(context),
      drawingEndsAt,
      () => {
        if (
          context.room.modeRuntime.mode === "classic" &&
          context.room.modeSessionId === modeSessionId &&
          state(context).phase === "DRAWING" &&
          state(context).actorStepId === actorStepId
        ) {
          this.#beginFinalization(context);
        }
      }
    );
  }

  #beginFinalization(
    context: ModeContext,
    reason: PublicTurnResult["reason"] = "TIME_UP"
  ): void {
    const current = state(context);
    if (current.phase !== "DRAWING" || current.drawing?.status !== "drawing") {
      return;
    }
    context.room.modeScheduler.cancel(this.#phaseTimerKey(context));
    context.revokeCapture(current.drawing.playerId, "session-replaced");
    const next = beginDrawingFinalization({
      drawing: current.drawing,
      now: effectiveNow(context),
      captureSessionId: context.allocateCaptureSessionId(),
      notificationEventId: context.randomId(12)
    });
    current.phase = "FINALIZING";
    current.pendingTurnEndReason = reason;
    current.phaseEndsAt = next.finalizationEndsAt;
    current.drawing = next;
    context.issueCapture({
      playerId: next.playerId,
      actorStepId: next.actorStepId,
      captureSessionId: next.captureSessionId,
      stage: "finalizing",
      expiresAt: next.finalizationEndsAt
    });
    context.sendToPlayer(next.playerId, {
      type: "drawing:finalization-started",
      modeSessionId: context.room.modeSessionId,
      actorStepId: next.actorStepId,
      eventId: next.notificationEventId,
      endsAt: next.finalizationEndsAt
    });
    const modeSessionId = context.room.modeSessionId;
    const actorStepId = next.actorStepId;
    context.room.modeScheduler.scheduleAt(
      this.#phaseTimerKey(context),
      next.finalizationEndsAt,
      () => {
        if (
          context.room.modeRuntime.mode === "classic" &&
          context.room.modeSessionId === modeSessionId &&
          state(context).phase === "FINALIZING" &&
          state(context).actorStepId === actorStepId
        ) {
          this.#finalize(context, "deadline");
        }
      }
    );
    context.broadcastSnapshots();
  }

  #finalize(
    context: ModeContext,
    finalizedBy: "deadline" | "self-pass" | "host-pass"
  ): void {
    const current = state(context);
    if (current.phase !== "FINALIZING" || current.drawing?.status !== "finalizing") {
      return;
    }
    context.room.modeScheduler.cancel(this.#phaseTimerKey(context));
    context.revokeCapture(current.drawing.playerId, "finalized", true);
    current.drawing = finalizeDrawing(current.drawing, finalizedBy);
    this.#endTurn(context, current.pendingTurnEndReason);
  }

  #submitGuess(context: ModeContext, playerId: string, text: string): void {
    const current = state(context);
    if (!current.selectedWord || !current.currentDrawerId) {
      throw new GameError(ErrorCode.INVALID_STATE, "当前不能猜词");
    }
    if (playerId === current.currentDrawerId) {
      throw new GameError(ErrorCode.FORBIDDEN, "画手不能参与猜词", 403);
    }
    const player = context.room.players.get(playerId);
    if (!player) {
      throw new GameError(ErrorCode.UNAUTHORIZED, "玩家身份无效", 401);
    }
    const resolution = resolveGuess({
      guess: text,
      answer: current.selectedWord.text,
      aliases: current.selectedWord.aliases,
      guesserId: playerId,
      drawerId: current.currentDrawerId,
      correctGuesserIds: current.correctGuesserIds,
      remainingMs: Math.max(0, (current.phaseEndsAt ?? context.now()) - context.now())
    });
    if (resolution.status === "duplicate") {
      throw new GameError(ErrorCode.INVALID_STATE, "你已经猜对了，本回合不会重复计分");
    }
    if (resolution.status === "incorrect") {
      context.appendChat({
        kind: "chat",
        playerId,
        nickname: player.nickname,
        text
      });
      return;
    }
    if (resolution.status !== "correct") {
      throw new GameError(ErrorCode.FORBIDDEN, "当前不能猜词", 403);
    }
    current.correctGuesserIds.add(playerId);
    current.scores.set(
      playerId,
      (current.scores.get(playerId) ?? 0) + resolution.guesserPoints
    );
    current.scores.set(
      current.currentDrawerId,
      (current.scores.get(current.currentDrawerId) ?? 0) + resolution.drawerPoints
    );
    context.appendChat({
      kind: "correct",
      playerId,
      nickname: player.nickname,
      text: `${player.nickname} 猜对了！`
    });
    context.broadcast({
      type: "guess:correct",
      playerId,
      nickname: player.nickname
    });
    context.broadcastSnapshots();
    if (this.#allOnlineGuessersCorrect(context)) {
      this.#beginFinalization(context, "ALL_GUESSED");
    }
  }

  #allOnlineGuessersCorrect(context: ModeContext): boolean {
    const current = state(context);
    if (!current.currentDrawerId) {
      return false;
    }
    const guessers = [...context.room.players.values()].filter(
      (player) => player.id !== current.currentDrawerId && context.isOpen(player)
    );
    return (
      guessers.length > 0 &&
      guessers.every((player) => current.correctGuesserIds.has(player.id))
    );
  }

  #endTurn(context: ModeContext, reason: PublicTurnResult["reason"]): void {
    const current = state(context);
    context.room.modeScheduler.cancel(this.#phaseTimerKey(context));
    context.room.modeScheduler.cancel(this.#drawerGraceKey(context));
    if (current.currentDrawerId) {
      context.revokeCapture(current.currentDrawerId, "finalized", true);
    }
    current.phase = "TURN_RESULT";
    current.phaseEndsAt = effectiveNow(context) + this.#options.turnResultMs;
    const answer =
      current.selectedWord?.text ?? current.currentOptions[0]?.label ?? "未选择";
    const scoreChanges = [...context.room.players.values()]
      .map((player) => ({
        playerId: player.id,
        nickname: player.nickname,
        points:
          (current.scores.get(player.id) ?? 0) -
          (current.turnScoreStart.get(player.id) ?? 0)
      }))
      .filter((change) => change.points !== 0);
    current.turnResult = { answer, reason, scoreChanges };
    current.currentOptions = [];
    current.currentOptionWords.clear();
    current.correctGuesserIds.clear();
    current.actorStepId = null;
    current.drawing = null;
    context.broadcastSnapshots();
    const modeSessionId = context.room.modeSessionId;
    context.room.modeScheduler.scheduleAt(
      this.#phaseTimerKey(context),
      current.phaseEndsAt,
      () => {
        if (
          context.room.modeRuntime.mode === "classic" &&
          context.room.modeSessionId === modeSessionId &&
          state(context).phase === "TURN_RESULT"
        ) {
          this.#advanceAfterResult(context);
        }
      }
    );
  }

  #advanceAfterResult(context: ModeContext): void {
    const current = state(context);
    if (current.phase !== "TURN_RESULT") {
      return;
    }
    current.frameStore.clear();
    if (current.drawerIndex + 1 < current.drawerQueue.length) {
      current.drawerIndex += 1;
      this.#beginSelection(context, true);
      return;
    }
    current.phase = "GAME_RESULT";
    current.phaseEndsAt = null;
    current.currentDrawerId = null;
    current.currentOptions = [];
    current.currentOptionWords.clear();
    current.selectedWord = null;
    current.correctGuesserIds.clear();
    current.gameWordPool = null;
    current.wordDeck = null;
    current.actorStepId = null;
    current.drawing = null;
    context.broadcastSnapshots();
  }

  #resetRoundState(context: ModeContext, current: ClassicModeState): void {
    context.room.modeScheduler.cancelAll();
    for (const player of context.room.players.values()) {
      context.revokeCapture(player.id, "finalized", true);
    }
    current.drawerQueue = [];
    current.drawerIndex = -1;
    current.currentDrawerId = null;
    current.currentRound = 0;
    current.currentOptions = [];
    current.currentOptionWords.clear();
    current.selectedWord = null;
    current.correctGuesserIds.clear();
    current.phaseEndsAt = null;
    current.turnResult = null;
    current.pendingTurnEndReason = "TIME_UP";
    current.frameStore.clear();
    current.gameWordPool = null;
    current.wordDeck = null;
    current.actorStepId = null;
    current.drawing = null;
    current.passedPlayerIds.clear();
    current.eligibleHandoffPlayerIds = [];
  }

  #sendOptions(context: ModeContext): void {
    const current = state(context);
    if (
      current.phase !== "WORD_SELECTION" ||
      !current.currentDrawerId ||
      !current.actorStepId ||
      current.phaseEndsAt === null
    ) {
      return;
    }
    context.sendToPlayer(current.currentDrawerId, {
      type: "classic:word-options",
      modeSessionId: context.room.modeSessionId,
      actorStepId: current.actorStepId,
      turnId: current.currentTurnId,
      options: current.currentOptions,
      selectionEndsAt: current.phaseEndsAt
    });
  }

  #sendSelectedWord(context: ModeContext): void {
    const current = state(context);
    if (!current.currentDrawerId || !current.actorStepId || !current.selectedWord) {
      return;
    }
    context.sendToPlayer(current.currentDrawerId, {
      type: "classic:word-selected",
      modeSessionId: context.room.modeSessionId,
      actorStepId: current.actorStepId,
      answer: current.selectedWord.text
    });
  }

  #reissueCurrentCapture(context: ModeContext): void {
    const current = state(context);
    const drawing = current.drawing;
    if (!drawing || (drawing.status !== "drawing" && drawing.status !== "finalizing")) {
      return;
    }
    this.#sendSelectedWord(context);
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

  #scheduleDrawerGrace(context: ModeContext): void {
    const current = state(context);
    if (
      (current.phase !== "WORD_SELECTION" && current.phase !== "DRAWING") ||
      !current.currentDrawerId ||
      context.isCaptureReady(context.room.players.get(current.currentDrawerId))
    ) {
      return;
    }
    const key = this.#drawerGraceKey(context);
    if (context.room.modeScheduler.has(key)) {
      return;
    }
    const actorStepId = current.actorStepId;
    context.room.modeScheduler.scheduleAt(
      key,
      effectiveNow(context) + this.#options.reconnectGraceMs,
      () => {
        if (
          context.room.modeRuntime.mode !== "classic" ||
          state(context).actorStepId !== actorStepId
        ) {
          return;
        }
        const latest = state(context);
        const drawer = latest.currentDrawerId
          ? context.room.players.get(latest.currentDrawerId)
          : null;
        if (context.isCaptureReady(drawer)) {
          return;
        }
        const reason =
          drawer && context.isOpen(drawer) && drawer.clientKind === "desktop"
            ? "CAPTURE_UNAVAILABLE"
            : "DRAWER_DISCONNECTED";
        this.#endTurn(context, reason);
      }
    );
  }

  #assertMutable(context: ModeContext, modeSessionId: string): void {
    if (context.room.modeSessionId !== modeSessionId) {
      throw new GameError(ErrorCode.INVALID_STATE, "经典模式会话已失效", 409);
    }
    if (context.room.runControl.status === "paused") {
      throw new GameError(ErrorCode.INVALID_STATE, "游戏已暂停", 409);
    }
  }

  #phaseTimerKey(context: ModeContext): string {
    return `classic:phase:${context.room.modeSessionId}`;
  }

  #drawerGraceKey(context: ModeContext): string {
    return `classic:drawer-grace:${context.room.modeSessionId}`;
  }
}
