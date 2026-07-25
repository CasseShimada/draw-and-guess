import { contextBridge, ipcRenderer } from "electron";
import { z, type ZodType } from "zod";

import {
  BootstrapSchema,
  AvatarRevisionResultSchema,
  AvatarRoomArgsSchema,
  BinaryValueSchema,
  CapturePermissionStatusSchema,
  CaptureSourceSchema,
  ConfigureGameSchema,
  CreateRoomArgsSchema,
  DesktopRoomResponseSchema,
  DesktopSettingsSchema,
  DiagnosticsExportResultSchema,
  DiagnosticEntrySchema,
  EmbeddedServerStatusSchema,
  GameAssetResultSchema,
  GetGameAssetArgsSchema,
  GameEventSchema,
  GetAvatarArgsSchema,
  GetRelayTaskArgsSchema,
  InviteSchema,
  IPC_CHANNELS,
  JoinRoomArgsSchema,
  SaveWordPackFileArgsSchema,
  HostRoomArgsSchema,
  ReplaySavedFileSchema,
  SettingsPatchSchema,
  SharingStateSchema,
  StartServerArgsSchema,
  ThemeStatusSchema,
  UploadFrameArgsSchema,
  UploadFrameResultSchema,
  UploadAvatarArgsSchema,
  UploadReferenceArgsSchema,
  UploadReferenceResultSchema,
  UploadWordPoolArgsSchema,
  UploadWordPoolResultSchema,
  WordPackFileDtoSchema,
  type DesktopBridge
} from "../shared/ipc.js";
import {
  DesktopClientMessageSchema,
  ReplayHostCapabilitySchema,
  RelayPrivateTaskResponseSchema
} from "@draw-guess/protocol";
import {
  LocalAvatarSchema,
  WordPackFileSchema,
  WordPackSelectionSchema,
  WordPackSummarySchema
} from "@draw-guess/content";

async function invoke<Input, Output>(
  channel: string,
  inputSchema: ZodType<Input>,
  outputSchema: ZodType<Output>,
  input: Input
): Promise<Output> {
  const safeInput = inputSchema.parse(input);
  const output = (await ipcRenderer.invoke(channel, safeInput)) as unknown;
  return outputSchema.parse(output);
}

function subscribe<Value>(
  channel: string,
  schema: ZodType<Value>,
  listener: (value: Value) => void
): () => void {
  const handler = (_event: Electron.IpcRendererEvent, raw: unknown) => {
    const parsed = schema.safeParse(raw);
    if (parsed.success) {
      listener(parsed.data);
    }
  };
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
}

const bridge: DesktopBridge = {
  bootstrap: () =>
    invoke(IPC_CHANNELS.bootstrap, z.undefined(), BootstrapSchema, undefined),
  settings: {
    update: (patch) =>
      invoke(
        IPC_CHANNELS.settingsUpdate,
        SettingsPatchSchema,
        DesktopSettingsSchema,
        patch
      ),
    clear: () =>
      invoke(
        IPC_CHANNELS.settingsClear,
        z.undefined(),
        DesktopSettingsSchema,
        undefined
      ),
    chooseFfmpegExecutable: () =>
      invoke(
        IPC_CHANNELS.settingsChooseFfmpeg,
        z.undefined(),
        z.string().min(1).max(4_096).nullable(),
        undefined
      ),
    chooseReplayOutputDirectory: () =>
      invoke(
        IPC_CHANNELS.settingsChooseReplayDirectory,
        z.undefined(),
        z.string().min(1).max(4_096).nullable(),
        undefined
      )
  },
  server: {
    start: (args) =>
      invoke(
        IPC_CHANNELS.serverStart,
        StartServerArgsSchema,
        EmbeddedServerStatusSchema,
        args
      ),
    stop: () =>
      invoke(
        IPC_CHANNELS.serverStop,
        z.undefined(),
        EmbeddedServerStatusSchema,
        undefined
      ),
    pause: async (roomCode) => {
      await invoke(IPC_CHANNELS.serverPause, HostRoomArgsSchema, z.void(), {
        roomCode
      });
    },
    resume: async (roomCode) => {
      await invoke(IPC_CHANNELS.serverResume, HostRoomArgsSchema, z.void(), {
        roomCode
      });
    },
    onStatus: (listener) =>
      subscribe(IPC_CHANNELS.serverStatus, EmbeddedServerStatusSchema, listener)
  },
  replay: {
    revalidate: () =>
      invoke(
        IPC_CHANNELS.replayRevalidate,
        z.undefined(),
        ReplayHostCapabilitySchema,
        undefined
      ),
    retry: (roomCode) =>
      invoke(IPC_CHANNELS.replayRetry, HostRoomArgsSchema, ReplaySavedFileSchema, {
        roomCode
      }),
    saved: (roomCode) =>
      invoke(
        IPC_CHANNELS.replaySaved,
        HostRoomArgsSchema,
        ReplaySavedFileSchema.nullable(),
        { roomCode }
      ),
    openFile: async (roomCode) => {
      await invoke(IPC_CHANNELS.replayOpenFile, HostRoomArgsSchema, z.void(), {
        roomCode
      });
    },
    openFolder: async (roomCode) => {
      await invoke(IPC_CHANNELS.replayOpenFolder, HostRoomArgsSchema, z.void(), {
        roomCode
      });
    }
  },
  game: {
    configure: async (serverUrl) => {
      await invoke(IPC_CHANNELS.gameConfigure, ConfigureGameSchema, z.void(), {
        serverUrl
      });
    },
    createRoom: (args) =>
      invoke(
        IPC_CHANNELS.gameCreateRoom,
        CreateRoomArgsSchema,
        DesktopRoomResponseSchema,
        args
      ),
    joinRoom: (args) =>
      invoke(
        IPC_CHANNELS.gameJoinRoom,
        JoinRoomArgsSchema,
        DesktopRoomResponseSchema,
        args
      ),
    resume: (serverUrl) =>
      invoke(
        IPC_CHANNELS.gameResume,
        ConfigureGameSchema,
        DesktopRoomResponseSchema.nullable(),
        { serverUrl }
      ),
    send: async (message) => {
      await invoke(
        IPC_CHANNELS.gameSend,
        DesktopClientMessageSchema,
        z.void(),
        message
      );
    },
    uploadFrame: (captureSessionId, bytes) =>
      invoke(
        IPC_CHANNELS.gameUploadFrame,
        UploadFrameArgsSchema,
        UploadFrameResultSchema,
        { captureSessionId, bytes: new Uint8Array(bytes) }
      ),
    uploadWordPool: (roomCode, wordPool) =>
      invoke(
        IPC_CHANNELS.gameWordPoolUpload,
        UploadWordPoolArgsSchema,
        UploadWordPoolResultSchema,
        { roomCode, wordPool }
      ),
    uploadReference: (roomCode, mimeType, bytes) =>
      invoke(
        IPC_CHANNELS.gameReferenceUpload,
        UploadReferenceArgsSchema,
        UploadReferenceResultSchema,
        { roomCode, mimeType, bytes: new Uint8Array(bytes) }
      ),
    deleteReference: async (roomCode) => {
      await invoke(IPC_CHANNELS.gameReferenceDelete, HostRoomArgsSchema, z.void(), {
        roomCode
      });
    },
    getAsset: (roomCode, path) =>
      invoke(IPC_CHANNELS.gameAssetGet, GetGameAssetArgsSchema, GameAssetResultSchema, {
        roomCode,
        path
      }),
    getRelayTask: (roomCode, actorStepId) =>
      invoke(
        IPC_CHANNELS.gameRelayTaskGet,
        GetRelayTaskArgsSchema,
        RelayPrivateTaskResponseSchema,
        { roomCode, actorStepId }
      ),
    uploadAvatar: (roomCode, bytes) =>
      invoke(
        IPC_CHANNELS.gameAvatarUpload,
        UploadAvatarArgsSchema,
        AvatarRevisionResultSchema,
        { roomCode, bytes: new Uint8Array(bytes) }
      ),
    deleteAvatar: async (roomCode) => {
      await invoke(IPC_CHANNELS.gameAvatarDelete, AvatarRoomArgsSchema, z.void(), {
        roomCode
      });
    },
    getAvatar: (roomCode, playerId, revision) =>
      invoke(
        IPC_CHANNELS.gameAvatarGet,
        GetAvatarArgsSchema,
        BinaryValueSchema.nullable(),
        { roomCode, playerId, revision }
      ),
    disconnect: async () => {
      await invoke(IPC_CHANNELS.gameDisconnect, z.undefined(), z.void(), undefined);
    },
    onEvent: (listener) => subscribe(IPC_CHANNELS.gameEvent, GameEventSchema, listener)
  },
  capture: {
    listSources: () =>
      invoke(
        IPC_CHANNELS.captureListSources,
        z.undefined(),
        z.array(CaptureSourceSchema),
        undefined
      ),
    selectSource: async (sourceId) => {
      await invoke(
        IPC_CHANNELS.captureSelectSource,
        z.string().min(1).max(256),
        z.void(),
        sourceId
      );
    },
    permission: () =>
      invoke(
        IPC_CHANNELS.capturePermission,
        z.undefined(),
        CapturePermissionStatusSchema,
        undefined
      )
  },
  sharing: {
    stop: async () => {
      await invoke(IPC_CHANNELS.sharingStop, z.undefined(), z.void(), undefined);
    },
    setState: async (state) => {
      await invoke(IPC_CHANNELS.sharingState, SharingStateSchema, z.void(), state);
    },
    onState: (listener) =>
      subscribe(IPC_CHANNELS.sharingState, SharingStateSchema, listener),
    onStopRequested: (listener) =>
      subscribe(IPC_CHANNELS.sharingStopRequested, z.null(), () => listener())
  },
  app: {
    hideToTray: async () => {
      await invoke(IPC_CHANNELS.windowHide, z.undefined(), z.void(), undefined);
    },
    onInvite: (listener) =>
      subscribe(IPC_CHANNELS.inviteReceived, InviteSchema, listener)
  },
  diagnostics: {
    read: () =>
      invoke(
        IPC_CHANNELS.diagnosticsRead,
        z.undefined(),
        z.array(DiagnosticEntrySchema),
        undefined
      ),
    export: () =>
      invoke(
        IPC_CHANNELS.diagnosticsExport,
        z.undefined(),
        DiagnosticsExportResultSchema,
        undefined
      )
  },
  theme: {
    status: () =>
      invoke(IPC_CHANNELS.themeStatus, z.undefined(), ThemeStatusSchema, undefined),
    import: () =>
      invoke(IPC_CHANNELS.themeImport, z.undefined(), ThemeStatusSchema, undefined),
    enable: () =>
      invoke(IPC_CHANNELS.themeEnable, z.undefined(), ThemeStatusSchema, undefined),
    disable: () =>
      invoke(IPC_CHANNELS.themeDisable, z.undefined(), ThemeStatusSchema, undefined),
    delete: () =>
      invoke(IPC_CHANNELS.themeDelete, z.undefined(), ThemeStatusSchema, undefined)
  },
  content: {
    wordPacks: {
      list: () =>
        invoke(
          IPC_CHANNELS.contentWordPacksList,
          z.undefined(),
          z.array(WordPackSummarySchema),
          undefined
        ),
      get: (id) =>
        invoke(
          IPC_CHANNELS.contentWordPacksGet,
          z.uuid(),
          WordPackFileSchema.nullable(),
          id
        ),
      put: async (pack) => {
        await invoke(
          IPC_CHANNELS.contentWordPacksPut,
          WordPackFileSchema,
          z.void(),
          pack
        );
      },
      remove: async (id) => {
        await invoke(IPC_CHANNELS.contentWordPacksRemove, z.uuid(), z.void(), id);
      }
    },
    wordSelection: {
      get: () =>
        invoke(
          IPC_CHANNELS.contentWordSelectionGet,
          z.undefined(),
          WordPackSelectionSchema.nullable(),
          undefined
        ),
      put: async (selection) => {
        await invoke(
          IPC_CHANNELS.contentWordSelectionPut,
          WordPackSelectionSchema,
          z.void(),
          selection
        );
      }
    },
    wordFiles: {
      open: () =>
        invoke(
          IPC_CHANNELS.contentWordFilesOpen,
          z.undefined(),
          z.array(WordPackFileDtoSchema),
          undefined
        ),
      save: (suggestedName, bytes) =>
        invoke(
          IPC_CHANNELS.contentWordFilesSave,
          SaveWordPackFileArgsSchema,
          z.boolean(),
          { suggestedName, bytes: new Uint8Array(bytes) }
        )
    },
    avatar: {
      get: () =>
        invoke(
          IPC_CHANNELS.contentAvatarGet,
          z.undefined(),
          LocalAvatarSchema.nullable(),
          undefined
        ),
      put: async (avatar) => {
        await invoke(
          IPC_CHANNELS.contentAvatarPut,
          LocalAvatarSchema,
          z.void(),
          avatar
        );
      },
      remove: async () => {
        await invoke(
          IPC_CHANNELS.contentAvatarRemove,
          z.undefined(),
          z.void(),
          undefined
        );
      }
    }
  }
};

Object.freeze(bridge.settings);
Object.freeze(bridge.server);
Object.freeze(bridge.replay);
Object.freeze(bridge.game);
Object.freeze(bridge.capture);
Object.freeze(bridge.sharing);
Object.freeze(bridge.app);
Object.freeze(bridge.diagnostics);
Object.freeze(bridge.theme);
Object.freeze(bridge.content.wordPacks);
Object.freeze(bridge.content.wordSelection);
Object.freeze(bridge.content.wordFiles);
Object.freeze(bridge.content.avatar);
Object.freeze(bridge.content);
contextBridge.exposeInMainWorld("drawGuessDesktop", Object.freeze(bridge));
