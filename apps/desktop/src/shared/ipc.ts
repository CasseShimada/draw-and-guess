import { z } from "zod";

import {
  ConnectionInfoSchema,
  PublicRoomSnapshotSchema,
  PublicWordPoolSummarySchema,
  ServerJsonMessageSchema
} from "@draw-guess/protocol";
import type {
  DesktopClientMessageSchema,
  RelayPrivateTaskResponseSchema,
  ReplayHostCapabilitySchema
} from "@draw-guess/protocol";
import type { NormalizedCrop } from "@draw-guess/capture-core";
import { CONTENT_LIMITS, WordPoolUploadSchema } from "@draw-guess/content";
import type {
  LocalAvatarSchema,
  WordPackFileSchema,
  WordPackSelectionSchema,
  WordPackSummarySchema
} from "@draw-guess/content";
import {
  ConnectionTargetSchema,
  NormalizedConnectionTargetSchema,
  TransportSecuritySchema,
  connectionHostKind,
  connectionTargetFromOrigin
} from "./server-url.js";

export const IPC_CHANNELS = {
  bootstrap: "desktop:bootstrap",
  settingsUpdate: "settings:update",
  settingsClear: "settings:clear",
  settingsChooseFfmpeg: "settings:choose-ffmpeg",
  settingsChooseReplayDirectory: "settings:choose-replay-directory",
  serverStart: "server:start",
  serverStop: "server:stop",
  serverStatus: "server:status",
  serverPause: "server:pause",
  serverResume: "server:resume",
  serverRefreshNetworks: "server:refresh-networks",
  connectionTest: "connection:test",
  systemOpenFirewallSettings: "system:open-firewall-settings",
  replayRevalidate: "replay:revalidate",
  replayRetry: "replay:retry",
  replaySaved: "replay:saved",
  replayOpenFile: "replay:open-file",
  replayOpenFolder: "replay:open-folder",
  gameConfigure: "game:configure",
  gameCreateRoom: "game:create-room",
  gameJoinRoom: "game:join-room",
  gameResume: "game:resume",
  gameSend: "game:send",
  gameUploadFrame: "game:upload-frame",
  gameDisconnect: "game:disconnect",
  gameWordPoolUpload: "game:word-pool:upload",
  gameReferenceUpload: "game:reference:upload",
  gameReferenceDelete: "game:reference:delete",
  gameAssetGet: "game:asset:get",
  gameRelayTaskGet: "game:relay-task:get",
  gameAvatarUpload: "game:avatar:upload",
  gameAvatarDelete: "game:avatar:delete",
  gameAvatarGet: "game:avatar:get",
  gameEvent: "game:event",
  captureListSources: "capture:list-sources",
  captureSelectSource: "capture:select-source",
  capturePermission: "capture:permission",
  sharingStop: "sharing:stop",
  sharingState: "sharing:state",
  sharingStopRequested: "sharing:stop-requested",
  windowHide: "window:hide",
  diagnosticsRead: "diagnostics:read",
  diagnosticsExport: "diagnostics:export",
  themeStatus: "theme:status",
  themeImport: "theme:import",
  themeEnable: "theme:enable",
  themeDisable: "theme:disable",
  themeDelete: "theme:delete",
  contentWordPacksList: "content:word-packs:list",
  contentWordPacksGet: "content:word-packs:get",
  contentWordPacksPut: "content:word-packs:put",
  contentWordPacksRemove: "content:word-packs:remove",
  contentWordSelectionGet: "content:word-selection:get",
  contentWordSelectionPut: "content:word-selection:put",
  contentWordFilesOpen: "content:word-files:open",
  contentWordFilesSave: "content:word-files:save",
  contentAvatarGet: "content:avatar:get",
  contentAvatarPut: "content:avatar:put",
  contentAvatarRemove: "content:avatar:remove"
} as const;

export function desktopIpcErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : "桌面操作失败";
  return message.replace(/^Error invoking remote method '[^']+': Error: /u, "");
}

export const NormalizedCropSchema = z
  .object({
    x: z.number().min(0).max(1),
    y: z.number().min(0).max(1),
    width: z.number().positive().max(1),
    height: z.number().positive().max(1)
  })
  .refine((crop) => crop.x + crop.width <= 1)
  .refine((crop) => crop.y + crop.height <= 1);

export const DesktopSettingsSchema = z
  .object({
    schemaVersion: z.literal(5),
    currentClientTarget: ConnectionTargetSchema,
    hostPort: z.number().int().min(1).max(65_535),
    hostBindMode: z.enum(["loopback-only", "lan"]),
    preferredLanAddressId: z.string().min(1).max(512).nullable(),
    recentConnections: z
      .array(
        z
          .object({
            target: ConnectionTargetSchema,
            label: z.string().trim().min(1).max(80).nullable(),
            lastConnectedAt: z.number().int().nonnegative()
          })
          .strict()
      )
      .max(8),
    publicEndpoint: z
      .object({
        target: ConnectionTargetSchema,
        label: z.string().trim().min(1).max(80).nullable()
      })
      .strict()
      .superRefine((endpoint, context) => {
        if (connectionHostKind(endpoint.target.host) !== "public") {
          context.addIssue({
            code: "custom",
            path: ["target", "host"],
            message: "公网分享信息必须使用公网主机名或公网 IP"
          });
        }
      })
      .nullable(),
    insecureHttpConfirmations: z
      .array(z.string().url())
      .max(20)
      .superRefine((origins, context) => {
        origins.forEach((origin, index) => {
          try {
            const target = connectionTargetFromOrigin(origin);
            if (
              target.origin !== origin ||
              target.security !== "http" ||
              connectionHostKind(target.host) !== "public"
            ) {
              throw new Error();
            }
          } catch {
            context.addIssue({
              code: "custom",
              path: [index],
              message: "明文确认必须绑定规范化的公网 HTTP origin"
            });
          }
        });
      }),
    minimizeToTray: z.boolean(),
    launchAtLogin: z.boolean(),
    stopSharingShortcut: z.string().min(1).max(64),
    qualityPreset: z.enum(["data-saver", "balanced", "high"]),
    onboardingComplete: z.boolean(),
    customCssEnabled: z.boolean(),
    notificationsEnabled: z.boolean(),
    ffmpegExecutable: z.string().min(1).max(4_096).nullable(),
    replayOutputDirectory: z.string().min(1).max(4_096).nullable(),
    replayMaxJobGiB: z.number().int().min(1).max(4),
    replayMaxTemporaryGiB: z.number().int().min(1).max(10),
    replayMinimumFreeGiB: z.number().int().min(1).max(2),
    cropPresets: z.record(z.string().min(1).max(160), NormalizedCropSchema)
  })
  .strict();

export const SettingsPatchSchema = DesktopSettingsSchema.omit({
  schemaVersion: true
})
  .partial()
  .strict();

export const CaptureSourceSchema = z
  .object({
    id: z.string().min(1).max(256),
    name: z.string().min(1).max(512),
    type: z.enum(["window", "screen"]),
    thumbnailDataUrl: z.string().startsWith("data:image/"),
    appIconDataUrl: z.string().startsWith("data:image/").nullable(),
    displayId: z.string().nullable(),
    isOwnApp: z.boolean()
  })
  .strict();

export const CapturePermissionStatusSchema = z
  .object({
    platform: z.enum(["win32", "darwin", "linux"]),
    status: z.enum([
      "granted",
      "denied",
      "restricted",
      "not-determined",
      "portal",
      "unavailable"
    ]),
    message: z.string(),
    restartRequired: z.boolean()
  })
  .strict();

export const HostBindModeSchema = z.enum(["loopback-only", "lan"]);

export const LanAddressSchema = z
  .object({
    id: z.string().min(1).max(512),
    interfaceName: z.string().min(1).max(256),
    address: z.string().min(7).max(15),
    netmask: z.string().min(7).max(15),
    cidr: z.string().min(1).max(64).nullable(),
    kind: z.enum(["private", "link-local", "other"]),
    recommended: z.boolean()
  })
  .strict();

export const EmbeddedServerStatusSchema = z
  .object({
    state: z.enum(["stopped", "starting", "running", "stopping", "error"]),
    bindMode: HostBindModeSchema,
    boundHost: z.enum(["127.0.0.1", "0.0.0.0"]).nullable(),
    requestedPort: z.number().int().min(1).max(65_535).nullable(),
    actualPort: z.number().int().min(1).max(65_535).nullable(),
    serverInstanceId: z.string().min(32).max(160).nullable(),
    loopbackOrigin: z.string().url().nullable(),
    lanAddresses: z.array(LanAddressSchema),
    executablePath: z.string().min(1).max(4_096).nullable(),
    error: z.string().nullable()
  })
  .strict();

export const ThemeStatusSchema = z
  .object({
    installed: z.boolean(),
    enabled: z.boolean(),
    fileName: z.string().nullable(),
    importedAt: z.string().nullable(),
    assetCount: z.number().int().nonnegative(),
    cssBytes: z.number().int().nonnegative(),
    safeMode: z.boolean(),
    error: z.string().nullable()
  })
  .strict();

export const BootstrapSchema = z
  .object({
    appVersion: z.string(),
    platform: z.enum(["win32", "darwin", "linux"]),
    packaged: z.boolean(),
    secureStorageAvailable: z.boolean(),
    systemNotificationSupported: z.boolean(),
    settings: DesktopSettingsSchema,
    server: EmbeddedServerStatusSchema,
    permission: CapturePermissionStatusSchema,
    theme: ThemeStatusSchema
  })
  .strict();

export const DesktopRoomResponseSchema = z
  .object({
    snapshot: PublicRoomSnapshotSchema
  })
  .strict();

export const CreateRoomResponseSchema = DesktopRoomResponseSchema.extend({
  target: ConnectionTargetSchema,
  server: EmbeddedServerStatusSchema
}).strict();

export const ConfigureGameSchema = z
  .object({
    target: ConnectionTargetSchema
  })
  .strict();

export const CreateRoomArgsSchema = z
  .object({
    nickname: z.string().trim().min(1).max(24),
    password: z.string().min(4).max(128)
  })
  .strict();

export const JoinRoomArgsSchema = z
  .object({
    target: ConnectionTargetSchema,
    confirmInsecureHttp: z.boolean().default(false),
    roomCode: z
      .string()
      .trim()
      .toUpperCase()
      .regex(/^[A-Z0-9]{6}$/),
    nickname: z.string().trim().min(1).max(24),
    password: z.string().min(4).max(128)
  })
  .strict();

export const StartServerArgsSchema = z
  .object({
    port: z.number().int().min(1).max(65_535),
    bindMode: HostBindModeSchema,
    restart: z.boolean().default(false)
  })
  .strict();

export const ConnectionDiagnosticCodeSchema = z.enum([
  "success",
  "invalid-input",
  "dns-failed",
  "connection-refused",
  "timeout",
  "tls-failed",
  "wrong-service",
  "protocol-mismatch",
  "insecure-confirmation"
]);

export const ConnectionTestArgsSchema = z
  .object({
    target: z
      .object({
        host: z.string().min(1).max(512),
        port: z.number().finite(),
        security: TransportSecuritySchema
      })
      .strict(),
    confirmInsecureHttp: z.boolean().default(false)
  })
  .strict();

export const ConnectionTestResultSchema = z.discriminatedUnion("ok", [
  z
    .object({
      ok: z.literal(true),
      code: z.literal("success"),
      message: z.string().min(1).max(512),
      target: NormalizedConnectionTargetSchema,
      info: ConnectionInfoSchema,
      latencyMs: z.number().int().nonnegative()
    })
    .strict(),
  z
    .object({
      ok: z.literal(false),
      code: ConnectionDiagnosticCodeSchema.exclude(["success"]),
      message: z.string().min(1).max(512),
      target: NormalizedConnectionTargetSchema.nullable(),
      latencyMs: z.number().int().nonnegative().nullable()
    })
    .strict()
]);

export const BinaryValueSchema = z.custom<Uint8Array>(
  (value) => value instanceof Uint8Array,
  "需要 Uint8Array"
);

export const WordPackFileDtoSchema = z
  .object({
    name: z.string().min(1).max(260),
    bytes: BinaryValueSchema.refine(
      (bytes) => bytes.byteLength <= CONTENT_LIMITS.wordPackFileBytes,
      "词库文件超过 2 MiB"
    )
  })
  .strict();

export const SaveWordPackFileArgsSchema = z
  .object({
    suggestedName: z.string().min(1).max(80),
    bytes: BinaryValueSchema.refine(
      (bytes) => bytes.byteLength <= CONTENT_LIMITS.wordPackFileBytes,
      "词库文件超过 2 MiB"
    )
  })
  .strict();

export const UploadFrameArgsSchema = z
  .object({
    captureSessionId: z.number().int().nonnegative().max(0xffffffff),
    bytes: BinaryValueSchema
  })
  .strict();

export const UploadFrameResultSchema = z
  .object({
    accepted: z.boolean(),
    reason: z.string().optional()
  })
  .strict();

const RoomCodeSchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z0-9]{6}$/);

export const UploadWordPoolArgsSchema = z
  .object({
    roomCode: RoomCodeSchema,
    wordPool: WordPoolUploadSchema
  })
  .strict();

export const UploadWordPoolResultSchema = z
  .object({
    wordPool: PublicWordPoolSummarySchema
  })
  .strict();

export const UploadReferenceArgsSchema = z
  .object({
    roomCode: RoomCodeSchema,
    mimeType: z.enum(["image/png", "image/jpeg", "image/webp"]),
    bytes: BinaryValueSchema.refine(
      (bytes) => bytes.byteLength <= 20 * 1024 * 1024,
      "参考图超过 20 MiB"
    )
  })
  .strict();

export const UploadReferenceResultSchema = z
  .object({
    reference: z
      .object({
        revision: z.string().regex(/^[a-f0-9]{64}$/),
        mimeType: z.enum(["image/png", "image/jpeg", "image/webp"]),
        width: z.number().int().positive(),
        height: z.number().int().positive(),
        byteLength: z.number().int().positive()
      })
      .strict()
  })
  .strict();

export const GetGameAssetArgsSchema = z
  .object({
    roomCode: RoomCodeSchema,
    path: z
      .string()
      .min(1)
      .max(1_024)
      .regex(/^\/api\/rooms\/[A-Z0-9]{6}\//)
  })
  .strict()
  .refine((value) => value.path.startsWith(`/api/rooms/${value.roomCode}/`));

export const GetRelayTaskArgsSchema = z
  .object({
    roomCode: RoomCodeSchema,
    actorStepId: z.string().min(1).max(160)
  })
  .strict();

export const GameAssetResultSchema = z
  .object({
    mimeType: z.enum(["image/png", "image/jpeg", "image/webp"]),
    bytes: BinaryValueSchema
  })
  .strict();

export const HostRoomArgsSchema = z.object({ roomCode: RoomCodeSchema }).strict();

export const ReplaySavedFileSchema = z
  .object({
    path: z.string().min(1).max(4_096),
    byteLength: z.number().int().positive()
  })
  .strict();

export const UploadAvatarArgsSchema = z
  .object({
    roomCode: RoomCodeSchema,
    bytes: BinaryValueSchema.refine(
      (bytes) => bytes.byteLength <= CONTENT_LIMITS.avatarBytes,
      "头像超过 512 KiB"
    )
  })
  .strict();

export const AvatarRevisionResultSchema = z
  .object({
    revision: z.string().regex(/^[a-f0-9]{64}$/)
  })
  .strict();

export const AvatarRoomArgsSchema = z
  .object({
    roomCode: RoomCodeSchema
  })
  .strict();

export const GetAvatarArgsSchema = z
  .object({
    roomCode: RoomCodeSchema,
    playerId: z.string().min(1).max(128),
    revision: z.string().regex(/^[a-f0-9]{64}$/)
  })
  .strict();

export const GameEventSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("message"),
      message: ServerJsonMessageSchema
    })
    .strict(),
  z
    .object({
      kind: z.literal("frame"),
      packet: BinaryValueSchema
    })
    .strict(),
  z
    .object({
      kind: z.literal("connection"),
      state: z.enum(["connecting", "connected", "reconnecting", "offline"]),
      error: z.string().optional()
    })
    .strict()
]);

export const SharingStateSchema = z
  .object({
    active: z.boolean(),
    sourceName: z.string().max(512).nullable(),
    captureSessionId: z.number().int().nonnegative().nullable(),
    endsAt: z.number().nullable()
  })
  .strict();

export const DiagnosticEntrySchema = z
  .object({
    timestamp: z.string(),
    level: z.enum(["info", "warn", "error"]),
    message: z.string()
  })
  .strict();

export const DiagnosticsExportResultSchema = z
  .object({
    exported: z.boolean(),
    path: z.string().nullable()
  })
  .strict();

export type DesktopSettings = z.infer<typeof DesktopSettingsSchema>;
export type SettingsPatch = z.infer<typeof SettingsPatchSchema>;
export type CapturePermissionStatus = z.infer<typeof CapturePermissionStatusSchema>;
export type EmbeddedServerStatus = z.infer<typeof EmbeddedServerStatusSchema>;
export type ThemeStatus = z.infer<typeof ThemeStatusSchema>;
export type Bootstrap = z.infer<typeof BootstrapSchema>;
export type GameEvent = z.infer<typeof GameEventSchema>;
export type SharingState = z.infer<typeof SharingStateSchema>;
export type DiagnosticEntry = z.infer<typeof DiagnosticEntrySchema>;
export type ConnectionTestResult = z.infer<typeof ConnectionTestResultSchema>;

export interface DesktopBridge {
  bootstrap(): Promise<Bootstrap>;
  settings: {
    update(patch: SettingsPatch): Promise<DesktopSettings>;
    clear(): Promise<DesktopSettings>;
    chooseFfmpegExecutable(): Promise<string | null>;
    chooseReplayOutputDirectory(): Promise<string | null>;
  };
  server: {
    start(args: z.input<typeof StartServerArgsSchema>): Promise<EmbeddedServerStatus>;
    stop(): Promise<EmbeddedServerStatus>;
    pause(roomCode: string): Promise<void>;
    resume(roomCode: string): Promise<void>;
    refreshNetworks(): Promise<EmbeddedServerStatus>;
    onStatus(listener: (status: EmbeddedServerStatus) => void): () => void;
  };
  connection: {
    test(args: z.input<typeof ConnectionTestArgsSchema>): Promise<ConnectionTestResult>;
  };
  replay: {
    revalidate(): Promise<z.infer<typeof ReplayHostCapabilitySchema>>;
    retry(roomCode: string): Promise<z.infer<typeof ReplaySavedFileSchema>>;
    saved(roomCode: string): Promise<z.infer<typeof ReplaySavedFileSchema> | null>;
    openFile(roomCode: string): Promise<void>;
    openFolder(roomCode: string): Promise<void>;
  };
  game: {
    configure(target: z.input<typeof ConnectionTargetSchema>): Promise<void>;
    createRoom(
      args: z.input<typeof CreateRoomArgsSchema>
    ): Promise<z.infer<typeof CreateRoomResponseSchema>>;
    joinRoom(
      args: z.input<typeof JoinRoomArgsSchema>
    ): Promise<z.infer<typeof DesktopRoomResponseSchema>>;
    resume(
      target: z.input<typeof ConnectionTargetSchema>
    ): Promise<z.infer<typeof DesktopRoomResponseSchema> | null>;
    send(message: z.input<typeof DesktopClientMessageSchema>): Promise<void>;
    uploadFrame(
      captureSessionId: number,
      bytes: Uint8Array
    ): Promise<z.infer<typeof UploadFrameResultSchema>>;
    uploadWordPool(
      roomCode: string,
      wordPool: z.infer<typeof WordPoolUploadSchema>
    ): Promise<z.infer<typeof UploadWordPoolResultSchema>>;
    uploadReference(
      roomCode: string,
      mimeType: "image/png" | "image/jpeg" | "image/webp",
      bytes: Uint8Array
    ): Promise<z.infer<typeof UploadReferenceResultSchema>>;
    deleteReference(roomCode: string): Promise<void>;
    getAsset(
      roomCode: string,
      path: string
    ): Promise<z.infer<typeof GameAssetResultSchema>>;
    getRelayTask(
      roomCode: string,
      actorStepId: string
    ): Promise<z.infer<typeof RelayPrivateTaskResponseSchema>>;
    uploadAvatar(
      roomCode: string,
      bytes: Uint8Array
    ): Promise<z.infer<typeof AvatarRevisionResultSchema>>;
    deleteAvatar(roomCode: string): Promise<void>;
    getAvatar(
      roomCode: string,
      playerId: string,
      revision: string
    ): Promise<Uint8Array | null>;
    disconnect(): Promise<void>;
    onEvent(listener: (event: GameEvent) => void): () => void;
  };
  capture: {
    listSources(): Promise<z.infer<typeof CaptureSourceSchema>[]>;
    selectSource(sourceId: string): Promise<void>;
    permission(): Promise<CapturePermissionStatus>;
  };
  sharing: {
    stop(): Promise<void>;
    setState(state: SharingState): Promise<void>;
    onState(listener: (state: SharingState) => void): () => void;
    onStopRequested(listener: () => void): () => void;
  };
  app: {
    hideToTray(): Promise<void>;
    openFirewallSettings(): Promise<void>;
  };
  diagnostics: {
    read(): Promise<DiagnosticEntry[]>;
    export(): Promise<z.infer<typeof DiagnosticsExportResultSchema>>;
  };
  theme: {
    status(): Promise<ThemeStatus>;
    import(): Promise<ThemeStatus>;
    enable(): Promise<ThemeStatus>;
    disable(): Promise<ThemeStatus>;
    delete(): Promise<ThemeStatus>;
  };
  content: {
    wordPacks: {
      list(): Promise<z.infer<typeof WordPackSummarySchema>[]>;
      get(id: string): Promise<z.infer<typeof WordPackFileSchema> | null>;
      put(pack: z.infer<typeof WordPackFileSchema>): Promise<void>;
      remove(id: string): Promise<void>;
    };
    wordSelection: {
      get(): Promise<z.infer<typeof WordPackSelectionSchema> | null>;
      put(selection: z.infer<typeof WordPackSelectionSchema>): Promise<void>;
    };
    wordFiles: {
      open(): Promise<z.infer<typeof WordPackFileDtoSchema>[]>;
      save(suggestedName: string, bytes: Uint8Array): Promise<boolean>;
    };
    avatar: {
      get(): Promise<z.infer<typeof LocalAvatarSchema> | null>;
      put(avatar: z.infer<typeof LocalAvatarSchema>): Promise<void>;
      remove(): Promise<void>;
    };
  };
}

export type { NormalizedCrop };
