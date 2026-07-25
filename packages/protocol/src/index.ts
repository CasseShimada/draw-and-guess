import { z } from "zod";

import {
  CLASSIC_PHASES,
  DRAW_RELAY_PHASES,
  GAME_MODE_IDS,
  REFERENCE_COPY_PHASES,
  type ClassicModeSettings,
  type DrawRelaySettings,
  type PublicRoomSnapshot,
  type ReferenceCopySettings,
  type WordOption
} from "@draw-guess/shared-types";

export const PROTOCOL_VERSION = 4;
export const APPLICATION_VERSION = "0.5.0";
export const MAX_JSON_MESSAGE_BYTES = 16 * 1024;
export const MAX_ENCODED_IMAGE_BYTES = 2 * 1024 * 1024;
export const MAX_FRAME_PACKET_BYTES = MAX_ENCODED_IMAGE_BYTES + 8;
export const MIN_FRAME_INTERVAL_MS = 800;
export const SLOW_CLIENT_BUFFER_BYTES = 2 * 1024 * 1024;

export const ErrorCode = {
  BAD_MESSAGE: "BAD_MESSAGE",
  UNAUTHORIZED: "UNAUTHORIZED",
  FORBIDDEN: "FORBIDDEN",
  NOT_FOUND: "NOT_FOUND",
  INVALID_STATE: "INVALID_STATE",
  RATE_LIMITED: "RATE_LIMITED",
  INVALID_FRAME: "INVALID_FRAME",
  PROTOCOL_MISMATCH: "PROTOCOL_MISMATCH",
  CAPABILITY_UNAVAILABLE: "CAPABILITY_UNAVAILABLE",
  INTERNAL_ERROR: "INTERNAL_ERROR"
} as const;

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

export const ConnectionInfoSchema = z
  .object({
    service: z.literal("draw-guess"),
    appVersion: z.string().min(1).max(64),
    protocolVersion: z.number().int().positive(),
    serverInstanceId: z.string().min(32).max(160),
    now: z.number().finite(),
    websocketPath: z.literal("/ws"),
    capabilities: z
      .object({
        browser: z.literal(true),
        desktop: z.literal(true)
      })
      .strict()
  })
  .strict();

export type ConnectionInfo = z.infer<typeof ConnectionInfoSchema>;

const NicknameSchema = z
  .string()
  .trim()
  .min(1)
  .max(24)
  .transform((value) =>
    [...value]
      .filter((character) => {
        const code = character.charCodeAt(0);
        return !((code >= 0 && code <= 31) || (code >= 127 && code <= 159));
      })
      .join("")
  )
  .refine((value) => value.length > 0);

const RoomCodeSchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z0-9]{6}$/);
const IdSchema = z.string().min(1).max(160);
const ModeSessionIdSchema = z.string().min(8).max(160);
const CommandIdSchema = z.string().min(1).max(160);
const RevisionSchema = z.string().regex(/^[a-f0-9]{64}$/);

export const CreateRoomRequestSchema = z
  .object({
    nickname: NicknameSchema,
    password: z.string().min(4).max(128)
  })
  .strict();

export const JoinRoomRequestSchema = z
  .object({
    roomCode: RoomCodeSchema,
    nickname: NicknameSchema,
    password: z.string().min(4).max(128)
  })
  .strict();

export const ClassicModeSettingsSchema = z
  .object({
    drawingSeconds: z.number().int().min(15).max(180),
    selectionSeconds: z.number().int().min(5).max(60),
    rounds: z.number().int().min(1).max(5)
  })
  .strict();

export const ReferenceCopySettingsSchema = z
  .object({
    durationSeconds: z.number().int().min(1).max(10_800),
    votingSeconds: z.number().int().min(10).max(600)
  })
  .strict();

export const DrawRelaySettingsSchema = z
  .object({
    drawingSeconds: z.number().int().min(1).max(10_800),
    guessingSeconds: z.number().int().min(1).max(600)
  })
  .strict();

export const GameModeSettingsSchema = z.discriminatedUnion("mode", [
  z
    .object({
      mode: z.literal("classic"),
      settings: ClassicModeSettingsSchema
    })
    .strict(),
  z
    .object({
      mode: z.literal("reference-copy"),
      settings: ReferenceCopySettingsSchema
    })
    .strict(),
  z
    .object({
      mode: z.literal("draw-relay"),
      settings: DrawRelaySettingsSchema
    })
    .strict()
]);

/** @deprecated Use ClassicModeSettingsSchema. */
export const GameSettingsSchema = ClassicModeSettingsSchema;

const clientMessage = <Shape extends z.ZodRawShape>(shape: Shape) =>
  z
    .object({
      protocolVersion: z.literal(PROTOCOL_VERSION),
      ...shape
    })
    .strict();

const RoomSyncMessageSchema = clientMessage({ type: z.literal("room:sync") });
const ModeSettingsMessageSchema = clientMessage({
  type: z.literal("mode:settings"),
  value: GameModeSettingsSchema
});
const GameStartMessageSchema = clientMessage({
  type: z.literal("game:start"),
  commandId: CommandIdSchema
});
const GameReturnLobbyMessageSchema = clientMessage({
  type: z.literal("game:return-lobby"),
  commandId: CommandIdSchema
});
const SwitchModeMessageSchema = clientMessage({
  type: z.literal("room:switch-mode"),
  modeSessionId: ModeSessionIdSchema,
  targetMode: z.enum(GAME_MODE_IDS),
  commandId: CommandIdSchema,
  partialReplay: z.enum(["encode-and-save", "discard"]).optional()
});
const PassMessageSchema = clientMessage({
  type: z.literal("turn:pass"),
  modeSessionId: ModeSessionIdSchema,
  actorStepId: IdSchema,
  targetPlayerId: IdSchema,
  commandId: CommandIdSchema
});
const DrawingFinishMessageSchema = clientMessage({
  type: z.literal("drawing:finish"),
  modeSessionId: ModeSessionIdSchema,
  actorStepId: IdSchema,
  commandId: CommandIdSchema
});
const WordSelectMessageSchema = clientMessage({
  type: z.literal("classic:word-select"),
  modeSessionId: ModeSessionIdSchema,
  actorStepId: IdSchema,
  optionId: IdSchema,
  commandId: CommandIdSchema
});
const ReferenceReadyMessageSchema = clientMessage({
  type: z.literal("reference:ready"),
  modeSessionId: ModeSessionIdSchema,
  referenceRevision: RevisionSchema,
  commandId: CommandIdSchema
});
const ReferenceLikeMessageSchema = clientMessage({
  type: z.literal("reference:set-like"),
  modeSessionId: ModeSessionIdSchema,
  ballotId: IdSchema,
  ballotItemId: IdSchema,
  liked: z.boolean(),
  commandId: CommandIdSchema
});
const ReferenceFinishBallotMessageSchema = clientMessage({
  type: z.literal("reference:finish-ballot"),
  modeSessionId: ModeSessionIdSchema,
  ballotId: IdSchema,
  commandId: CommandIdSchema
});
const RelayRecordingConsentMessageSchema = clientMessage({
  type: z.literal("relay:recording-consent"),
  modeSessionId: ModeSessionIdSchema,
  confirmed: z.boolean(),
  commandId: CommandIdSchema
});
const RelayTaskReadyMessageSchema = clientMessage({
  type: z.literal("relay:task-ready"),
  modeSessionId: ModeSessionIdSchema,
  actorStepId: IdSchema,
  revision: RevisionSchema.nullable(),
  commandId: CommandIdSchema
});
const RelaySubmitGuessMessageSchema = clientMessage({
  type: z.literal("relay:submit-guess"),
  modeSessionId: ModeSessionIdSchema,
  actorStepId: IdSchema,
  guess: z.string().trim().min(1).max(160),
  commandId: CommandIdSchema
});
const ChatSubmitMessageSchema = clientMessage({
  type: z.literal("chat:submit"),
  text: z.string().trim().min(1).max(280)
});
const FrameAckMessageSchema = clientMessage({
  type: z.literal("frame:ack"),
  captureSessionId: z.number().int().nonnegative().max(0xffffffff),
  sequence: z.number().int().nonnegative().max(0xffffffff)
});
const PingMessageSchema = clientMessage({
  type: z.literal("ping"),
  timestamp: z.number().finite()
});
const CaptureReadyMessageSchema = clientMessage({
  type: z.literal("capture:ready"),
  ready: z.boolean(),
  reason: z.string().trim().min(1).max(160).optional()
});

const CommonClientMessageSchemas = [
  RoomSyncMessageSchema,
  ModeSettingsMessageSchema,
  GameStartMessageSchema,
  GameReturnLobbyMessageSchema,
  SwitchModeMessageSchema,
  PassMessageSchema,
  DrawingFinishMessageSchema,
  WordSelectMessageSchema,
  ReferenceReadyMessageSchema,
  ReferenceLikeMessageSchema,
  ReferenceFinishBallotMessageSchema,
  RelayRecordingConsentMessageSchema,
  RelayTaskReadyMessageSchema,
  RelaySubmitGuessMessageSchema,
  ChatSubmitMessageSchema,
  FrameAckMessageSchema,
  PingMessageSchema
] as const;

export const BrowserClientMessageSchema = z.discriminatedUnion("type", [
  ...CommonClientMessageSchemas
]);

export const DesktopClientMessageSchema = z.discriminatedUnion("type", [
  ...CommonClientMessageSchemas,
  CaptureReadyMessageSchema
]);

export type BrowserClientMessage = z.infer<typeof BrowserClientMessageSchema>;
export type DesktopClientMessage = z.infer<typeof DesktopClientMessageSchema>;
export type ClientJsonMessage = BrowserClientMessage | DesktopClientMessage;

const PublicPlayerSchema = z
  .object({
    id: IdSchema,
    nickname: z.string(),
    isHost: z.boolean(),
    connected: z.boolean(),
    clientKind: z.enum(["browser", "desktop"]).nullable(),
    captureReady: z.boolean(),
    avatarRevision: RevisionSchema.nullable(),
    joinedAt: z.number()
  })
  .strict();

export const PublicWordPoolSummarySchema = z
  .object({
    revision: RevisionSchema,
    packs: z.array(
      z
        .object({
          name: z.string(),
          selectedCategoryNames: z.array(z.string()),
          enabledWordCount: z.number().int().nonnegative()
        })
        .strict()
    ),
    uniqueWordCount: z.number().int().nonnegative()
  })
  .strict();

const PublicChatEntrySchema = z
  .object({
    id: IdSchema,
    kind: z.enum(["chat", "correct", "system"]),
    playerId: IdSchema.nullable(),
    nickname: z.string().nullable(),
    text: z.string(),
    createdAt: z.number()
  })
  .strict();

const PublicTurnResultSchema = z
  .object({
    answer: z.string(),
    reason: z.enum([
      "TIME_UP",
      "ALL_GUESSED",
      "DRAWER_DISCONNECTED",
      "CAPTURE_UNAVAILABLE",
      "ALL_PASSED"
    ]),
    scoreChanges: z.array(
      z
        .object({
          playerId: IdSchema,
          nickname: z.string(),
          points: z.number()
        })
        .strict()
    )
  })
  .strict();

const PublicRunControlSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("idle") }).strict(),
  z
    .object({
      status: z.literal("running"),
      resumedAt: z.number().nullable(),
      captureResumesAt: z.number().nullable()
    })
    .strict(),
  z
    .object({
      status: z.literal("paused"),
      pausedAt: z.number(),
      pausedBy: z.literal("server-host"),
      phaseAtPause: z.enum([
        ...CLASSIC_PHASES,
        ...REFERENCE_COPY_PHASES,
        ...DRAW_RELAY_PHASES
      ])
    })
    .strict()
]);

export const ReplayHostCapabilitySchema = z.discriminatedUnion("available", [
  z
    .object({
      available: z.literal(true),
      ffmpegVersion: z.string(),
      executableSource: z.enum(["path", "configured"]),
      encoder: z.enum(["libx264", "mpeg4"])
    })
    .strict(),
  z
    .object({
      available: z.literal(false),
      reasonCode: z.enum([
        "not-configured",
        "not-found",
        "not-executable",
        "probe-failed",
        "no-supported-encoder",
        "output-not-writable",
        "insufficient-space"
      ]),
      message: z.string()
    })
    .strict()
]);

const PublicReplayStatusSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("unavailable"), message: z.string() }).strict(),
  z.object({ status: z.literal("idle") }).strict(),
  z.object({ status: z.literal("recording") }).strict(),
  z.object({ status: z.literal("preparing") }).strict(),
  z
    .object({
      status: z.literal("encoding"),
      progress: z.number().min(0).max(1).nullable()
    })
    .strict(),
  z
    .object({
      status: z.literal("saved"),
      byteLength: z.number().int().nonnegative()
    })
    .strict(),
  z
    .object({
      status: z.literal("failed"),
      message: z.string(),
      canRetry: z.boolean()
    })
    .strict()
]);

const PublicDrawingLifecycleSchema = z.discriminatedUnion("status", [
  z
    .object({
      status: z.literal("drawing"),
      actorStepId: IdSchema,
      drawingEndsAt: z.number(),
      captureSessionId: z.number().int().nonnegative().max(0xffffffff),
      acceptedSequence: z.number().int().nonnegative(),
      acceptedRevision: RevisionSchema.nullable()
    })
    .strict(),
  z
    .object({
      status: z.literal("finalizing"),
      actorStepId: IdSchema,
      finalizationStartedAt: z.number(),
      finalizationEndsAt: z.number(),
      captureSessionId: z.number().int().nonnegative().max(0xffffffff),
      acceptedSequence: z.number().int().nonnegative(),
      acceptedRevision: RevisionSchema.nullable(),
      baselineAcceptedRevision: RevisionSchema.nullable(),
      notificationEventId: IdSchema
    })
    .strict(),
  z
    .object({
      status: z.literal("finalized"),
      actorStepId: IdSchema,
      finalRevision: RevisionSchema.nullable(),
      finalizedBy: z.enum(["deadline", "self-pass", "host-pass"])
    })
    .strict()
]);

const PublicPassableActorSchema = z
  .object({
    actorStepId: IdSchema,
    targetPlayerId: IdSchema,
    phase: z.enum([...CLASSIC_PHASES, ...REFERENCE_COPY_PHASES, ...DRAW_RELAY_PHASES]),
    effect: z.enum([
      "handoff-input",
      "withdraw-submission",
      "finalize-current-frame",
      "finish-ballot"
    ])
  })
  .strict();

const ClassicModeStateSchema = z
  .object({
    mode: z.literal("classic"),
    phase: z.enum(CLASSIC_PHASES),
    settings: ClassicModeSettingsSchema,
    wordPool: PublicWordPoolSummarySchema,
    scores: z.record(z.string(), z.number()),
    currentDrawerId: IdSchema.nullable(),
    currentTurnId: z.number().int().nonnegative(),
    currentRound: z.number().int().nonnegative(),
    totalRounds: z.number().int().nonnegative(),
    turnNumber: z.number().int().nonnegative(),
    totalTurns: z.number().int().nonnegative(),
    phaseEndsAt: z.number().nullable(),
    correctGuesserIds: z.array(IdSchema),
    passedPlayerIds: z.array(IdSchema),
    turnResult: PublicTurnResultSchema.nullable(),
    selfDrawing: PublicDrawingLifecycleSchema.nullable()
  })
  .strict();

const ReferenceAssetSchema = z
  .object({
    isSet: z.boolean(),
    revision: RevisionSchema.nullable(),
    mimeType: z.enum(["image/png", "image/jpeg", "image/webp"]).nullable(),
    width: z.number().int().positive().nullable(),
    height: z.number().int().positive().nullable(),
    byteLength: z.number().int().positive().nullable()
  })
  .strict();

const ReferenceParticipantSchema = z
  .object({
    playerId: IdSchema,
    status: z.enum([
      "preparing",
      "countdown",
      "drawing",
      "finalizing",
      "finalized",
      "passed",
      "no-submission"
    ]),
    connected: z.boolean(),
    ready: z.boolean(),
    hasAcceptedFrame: z.boolean()
  })
  .strict();

const ReferenceBallotSchema = z
  .object({
    ballotId: IdSchema,
    actorStepId: IdSchema,
    items: z.array(
      z
        .object({
          ballotItemId: IdSchema,
          liked: z.boolean()
        })
        .strict()
    ),
    cursor: z.number().int().nonnegative(),
    status: z.enum(["active", "completed", "passed", "timed-out"]),
    likedCount: z.number().int().nonnegative()
  })
  .strict();

const ReferenceGallerySchema = z
  .object({
    resultId: IdSchema,
    entries: z.array(
      z
        .object({
          resultItemId: IdSchema,
          authorId: IdSchema,
          likes: z.number().int().nonnegative(),
          winner: z.boolean()
        })
        .strict()
    ),
    participants: z.array(
      z
        .object({
          playerId: IdSchema,
          status: z.enum(["finalized", "passed", "no-submission"]),
          resultItemId: IdSchema.nullable()
        })
        .strict()
    )
  })
  .strict();

const ReferenceCopyModeStateSchema = z
  .object({
    mode: z.literal("reference-copy"),
    phase: z.enum(REFERENCE_COPY_PHASES),
    settings: ReferenceCopySettingsSchema,
    reference: ReferenceAssetSchema,
    participants: z.array(ReferenceParticipantSchema),
    preparingEndsAt: z.number().nullable(),
    startsAt: z.number().nullable(),
    endsAt: z.number().nullable(),
    votingEndsAt: z.number().nullable(),
    selfDrawing: PublicDrawingLifecycleSchema.nullable(),
    selfBallot: ReferenceBallotSchema.nullable(),
    gallery: ReferenceGallerySchema.nullable()
  })
  .strict();

const RelayPlayerSchema = z
  .object({
    playerId: IdSchema,
    position: z.number().int().nonnegative(),
    status: z.enum(["waiting", "active", "completed", "passed", "timed-out"])
  })
  .strict();

const RelayTaskSchema = z.discriminatedUnion("kind", [
  z
    .object({
      actorStepId: IdSchema,
      kind: z.literal("word"),
      ready: z.boolean()
    })
    .strict(),
  z
    .object({
      actorStepId: IdSchema,
      kind: z.literal("drawing"),
      ready: z.boolean(),
      artifactAvailable: z.boolean()
    })
    .strict()
]);

const RelayResultEntrySchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("draw"),
      playerId: IdSchema,
      status: z.enum(["completed", "passed", "timed-out", "no-frame"]),
      resultArtifactId: IdSchema.nullable()
    })
    .strict(),
  z
    .object({
      kind: z.literal("guess"),
      playerId: IdSchema,
      status: z.enum(["completed", "passed", "timed-out"]),
      guess: z.string().nullable()
    })
    .strict()
]);

const RelayResultSchema = z
  .object({
    resultId: IdSchema,
    startingWord: z.string(),
    finalGuess: z.string().nullable(),
    finalGuessReason: z.enum(["completed", "pass", "timeout", "all-passed"]),
    history: z.array(RelayResultEntrySchema)
  })
  .strict();

const DrawRelayModeStateSchema = z
  .object({
    mode: z.literal("draw-relay"),
    phase: z.enum(DRAW_RELAY_PHASES),
    settings: DrawRelaySettingsSchema,
    wordPool: PublicWordPoolSummarySchema,
    order: z.array(RelayPlayerSchema),
    activePlayerId: IdSchema.nullable(),
    stepIndex: z.number().int().nonnegative(),
    totalSteps: z.number().int().nonnegative(),
    startsAt: z.number().nullable(),
    phaseEndsAt: z.number().nullable(),
    recordingConfirmedPlayerIds: z.array(IdSchema),
    selfTask: RelayTaskSchema.nullable(),
    selfDrawing: PublicDrawingLifecycleSchema.nullable(),
    replay: PublicReplayStatusSchema,
    result: RelayResultSchema.nullable()
  })
  .strict();

export const PublicModeStateSchema = z.discriminatedUnion("mode", [
  ClassicModeStateSchema,
  ReferenceCopyModeStateSchema,
  DrawRelayModeStateSchema
]);

export const PublicRoomSnapshotSchema = z
  .object({
    roomCode: RoomCodeSchema,
    hostId: IdSchema,
    selfPlayerId: IdSchema,
    modeSessionId: ModeSessionIdSchema,
    players: z.array(PublicPlayerSchema),
    chat: z.array(PublicChatEntrySchema),
    serverNow: z.number(),
    runControl: PublicRunControlSchema,
    replayCapability: ReplayHostCapabilitySchema,
    passableActors: z.array(PublicPassableActorSchema),
    game: PublicModeStateSchema
  })
  .strict();

export const RelayPrivateTaskSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("word"),
      actorStepId: IdSchema,
      word: z.string()
    })
    .strict(),
  z
    .object({
      kind: z.literal("drawing"),
      actorStepId: IdSchema,
      artifactId: IdSchema,
      revision: RevisionSchema.nullable(),
      available: z.boolean()
    })
    .strict()
]);

export const RelayPrivateTaskResponseSchema = z
  .object({ task: RelayPrivateTaskSchema })
  .strict();

export type RelayPrivateTask = z.infer<typeof RelayPrivateTaskSchema>;

const WordOptionSchema = z
  .object({
    id: IdSchema,
    label: z.string(),
    category: z.string()
  })
  .strict();

export const ServerMessagePayloadSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("room:snapshot"),
      snapshot: PublicRoomSnapshotSchema
    })
    .strict(),
  z
    .object({
      type: z.literal("classic:word-options"),
      modeSessionId: ModeSessionIdSchema,
      actorStepId: IdSchema,
      turnId: z.number().int().nonnegative(),
      options: z.array(WordOptionSchema),
      selectionEndsAt: z.number()
    })
    .strict(),
  z
    .object({
      type: z.literal("classic:word-selected"),
      modeSessionId: ModeSessionIdSchema,
      actorStepId: IdSchema,
      answer: z.string()
    })
    .strict(),
  z
    .object({
      type: z.literal("capture:status"),
      ready: z.boolean(),
      reason: z.string().optional()
    })
    .strict(),
  z
    .object({
      type: z.literal("capture:start"),
      modeSessionId: ModeSessionIdSchema,
      actorStepId: IdSchema,
      captureSessionId: z.number().int().nonnegative().max(0xffffffff),
      stage: z.enum(["drawing", "finalizing"]),
      intervalMs: z.number().int().min(MIN_FRAME_INTERVAL_MS)
    })
    .strict(),
  z
    .object({
      type: z.literal("capture:stop-upload"),
      captureSessionId: z.number().int().nonnegative().max(0xffffffff),
      reason: z.enum([
        "session-replaced",
        "paused",
        "finalized",
        "mode-switched",
        "permission-revoked"
      ])
    })
    .strict(),
  z
    .object({
      type: z.literal("capture:stop"),
      captureSessionId: z.number().int().nonnegative().max(0xffffffff),
      reason: z.enum([
        "turn-ended",
        "source-unavailable",
        "permission-revoked",
        "connection-replaced",
        "user-stopped",
        "mode-switched",
        "server-shutdown"
      ])
    })
    .strict(),
  z
    .object({
      type: z.literal("drawing:finalization-started"),
      modeSessionId: ModeSessionIdSchema,
      actorStepId: IdSchema,
      eventId: IdSchema,
      endsAt: z.number()
    })
    .strict(),
  z
    .object({
      type: z.literal("chat:message"),
      id: IdSchema,
      kind: z.enum(["chat", "correct", "system"]),
      playerId: IdSchema.nullable(),
      nickname: z.string().nullable(),
      text: z.string(),
      createdAt: z.number()
    })
    .strict(),
  z
    .object({
      type: z.literal("guess:correct"),
      playerId: IdSchema,
      nickname: z.string()
    })
    .strict(),
  z
    .object({
      type: z.literal("error"),
      code: z.enum(ErrorCode),
      message: z.string()
    })
    .strict(),
  z
    .object({
      type: z.literal("pong"),
      timestamp: z.number(),
      serverNow: z.number()
    })
    .strict()
]);

export const ServerJsonMessageSchema = z.intersection(
  z.object({ protocolVersion: z.literal(PROTOCOL_VERSION) }),
  ServerMessagePayloadSchema
);

export type ServerMessagePayload = z.infer<typeof ServerMessagePayloadSchema>;
export type ServerJsonMessage = z.infer<typeof ServerJsonMessageSchema>;

export type EncodedImageMimeType = "image/jpeg" | "image/webp";

export interface UploadFrame {
  captureSessionId: number;
  imageBytes: Uint8Array;
  mimeType: EncodedImageMimeType | null;
}

export interface ViewerFrame extends UploadFrame {
  sequence: number;
}

function assertUInt32(value: number, field: string): void {
  if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) {
    throw new RangeError(`${field} 必须是 UInt32`);
  }
}

export function isValidJpeg(bytes: Uint8Array): boolean {
  return (
    bytes.byteLength >= 4 &&
    bytes[0] === 0xff &&
    bytes[1] === 0xd8 &&
    bytes[bytes.byteLength - 2] === 0xff &&
    bytes[bytes.byteLength - 1] === 0xd9
  );
}

export function isValidWebp(bytes: Uint8Array): boolean {
  if (
    bytes.byteLength < 12 ||
    bytes[0] !== 0x52 ||
    bytes[1] !== 0x49 ||
    bytes[2] !== 0x46 ||
    bytes[3] !== 0x46 ||
    bytes[8] !== 0x57 ||
    bytes[9] !== 0x45 ||
    bytes[10] !== 0x42 ||
    bytes[11] !== 0x50
  ) {
    return false;
  }
  const declaredLength =
    new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(4, true) +
    8;
  return declaredLength === bytes.byteLength;
}

export function detectEncodedImageMimeType(
  bytes: Uint8Array
): EncodedImageMimeType | null {
  if (isValidJpeg(bytes)) {
    return "image/jpeg";
  }
  if (isValidWebp(bytes)) {
    return "image/webp";
  }
  return null;
}

export function isValidEncodedImage(bytes: Uint8Array): boolean {
  return detectEncodedImageMimeType(bytes) !== null;
}

function assertImageLength(imageBytes: Uint8Array): void {
  if (imageBytes.byteLength === 0 || imageBytes.byteLength > MAX_ENCODED_IMAGE_BYTES) {
    throw new RangeError("图片长度无效");
  }
}

export function encodeUploadFrame(
  captureSessionId: number,
  imageBytes: Uint8Array
): Uint8Array {
  assertUInt32(captureSessionId, "captureSessionId");
  assertImageLength(imageBytes);
  const packet = new Uint8Array(4 + imageBytes.byteLength);
  new DataView(packet.buffer).setUint32(0, captureSessionId);
  packet.set(imageBytes, 4);
  return packet;
}

export function decodeUploadFrame(packet: Uint8Array): UploadFrame {
  if (packet.byteLength < 5 || packet.byteLength > MAX_ENCODED_IMAGE_BYTES + 4) {
    throw new RangeError("上传图片包长度无效");
  }
  const view = new DataView(packet.buffer, packet.byteOffset, packet.byteLength);
  const imageBytes = packet.subarray(4);
  const captureSessionId = view.getUint32(0);
  return {
    captureSessionId,
    imageBytes,
    mimeType: detectEncodedImageMimeType(imageBytes)
  };
}

export function encodeViewerFrame(
  captureSessionId: number,
  sequence: number,
  imageBytes: Uint8Array
): Uint8Array {
  assertUInt32(captureSessionId, "captureSessionId");
  assertUInt32(sequence, "sequence");
  assertImageLength(imageBytes);
  const packet = new Uint8Array(8 + imageBytes.byteLength);
  const view = new DataView(packet.buffer);
  view.setUint32(0, captureSessionId);
  view.setUint32(4, sequence);
  packet.set(imageBytes, 8);
  return packet;
}

export function decodeViewerFrame(packet: Uint8Array): ViewerFrame {
  if (packet.byteLength < 9 || packet.byteLength > MAX_ENCODED_IMAGE_BYTES + 8) {
    throw new RangeError("下行图片包长度无效");
  }
  const view = new DataView(packet.buffer, packet.byteOffset, packet.byteLength);
  const imageBytes = packet.subarray(8);
  const captureSessionId = view.getUint32(0);
  return {
    captureSessionId,
    sequence: view.getUint32(4),
    imageBytes,
    mimeType: detectEncodedImageMimeType(imageBytes)
  };
}

export function shouldAcceptViewerFrame(
  packet: Uint8Array,
  currentCaptureSessionId: number,
  latestSequence: number
): ViewerFrame | null {
  try {
    const frame = decodeViewerFrame(packet);
    if (
      frame.captureSessionId !== currentCaptureSessionId ||
      frame.sequence <= latestSequence ||
      frame.mimeType === null
    ) {
      return null;
    }
    return frame;
  } catch {
    return null;
  }
}

export function serializeServerMessage(message: ServerMessagePayload): string {
  return JSON.stringify({ protocolVersion: PROTOCOL_VERSION, ...message });
}

export type {
  ClassicModeSettings,
  DrawRelaySettings,
  PublicRoomSnapshot,
  ReferenceCopySettings,
  WordOption
};
/** @deprecated Use ClassicModeSettings. */
export type GameSettings = ClassicModeSettings;
