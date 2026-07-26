import { writeFile } from "node:fs/promises";

import {
  app,
  dialog,
  globalShortcut,
  ipcMain,
  shell,
  type IpcMainInvokeEvent
} from "electron";
import { z, type ZodType } from "zod";

import {
  AvatarRevisionResultSchema,
  AvatarRoomArgsSchema,
  BinaryValueSchema,
  BootstrapSchema,
  CapturePermissionStatusSchema,
  CaptureSourceSchema,
  ConnectionTestArgsSchema,
  ConnectionTestResultSchema,
  ConfigureGameSchema,
  CreateRoomArgsSchema,
  CreateRoomResponseSchema,
  DesktopRoomResponseSchema,
  DesktopSettingsSchema,
  DiagnosticsExportResultSchema,
  DiagnosticEntrySchema,
  EmbeddedServerStatusSchema,
  GameAssetResultSchema,
  GetGameAssetArgsSchema,
  GetAvatarArgsSchema,
  GetRelayTaskArgsSchema,
  HostRoomArgsSchema,
  HostRoomPasswordArgsSchema,
  IPC_CHANNELS,
  JoinRoomArgsSchema,
  SaveWordPackFileArgsSchema,
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
  WordPackFileDtoSchema
} from "../shared/ipc.js";
import {
  LocalAvatarSchema,
  RememberedNicknameSchema,
  ThemeApplyModeSchema,
  WordPackFileSchema,
  WordPackSelectionSchema,
  WordPackSummarySchema,
  sanitizeExportFilename
} from "@draw-guess/content";
import type { CaptureSourceService } from "./capture-source-service.js";
import type { ConnectionPreflightService } from "./connection-preflight-service.js";
import type { ContentStorageService } from "./content-storage-service.js";
import type { EmbeddedServerService } from "./embedded-server-service.js";
import type { GameClientService } from "./game-client-service.js";
import type { FixedNotificationService } from "./fixed-notification-service.js";
import type { LoginItemService } from "./login-item-service.js";
import type { LocalRoomCoordinator } from "./local-room-coordinator.js";
import type { PermissionService } from "./permission-service.js";
import type { RedactingLogger } from "./redacting-logger.js";
import type { SettingsService } from "./settings-service.js";
import type { TrayService } from "./tray-service.js";
import type { ThemeService } from "./theme-service.js";
import type { WindowManager } from "./window-manager.js";
import {
  DesktopClientMessageSchema,
  ReplayHostCapabilitySchema,
  RelayPrivateTaskResponseSchema
} from "@draw-guess/protocol";

interface IpcServices {
  windowManager: WindowManager;
  settings: SettingsService;
  embeddedServer: EmbeddedServerService;
  gameClient: GameClientService;
  localRooms: LocalRoomCoordinator;
  connectionPreflight: ConnectionPreflightService;
  notifications: FixedNotificationService;
  loginItems: LoginItemService;
  captureSources: CaptureSourceService;
  permission: PermissionService;
  logger: RedactingLogger;
  tray: TrayService;
  content: ContentStorageService;
  theme: ThemeService;
}

function platform(): "win32" | "darwin" | "linux" {
  if (process.platform === "darwin" || process.platform === "linux") {
    return process.platform;
  }
  return "win32";
}

export function registerIpcHandlers(services: IpcServices): () => void {
  const channels: string[] = [];

  const handle = <Input, Output>(
    channel: string,
    inputSchema: ZodType<Input>,
    outputSchema: ZodType<Output>,
    operation: (input: Input, event: IpcMainInvokeEvent) => Promise<Output> | Output
  ) => {
    ipcMain.removeHandler(channel);
    ipcMain.handle(channel, async (event, rawInput) => {
      services.windowManager.assertTrustedIpc(event);
      const input = inputSchema.parse(rawInput);
      const result = await operation(input, event);
      return outputSchema.parse(result);
    });
    channels.push(channel);
  };

  handle(IPC_CHANNELS.bootstrap, z.undefined(), BootstrapSchema, () => ({
    appVersion: app.getVersion(),
    platform: platform(),
    packaged: app.isPackaged,
    secureStorageAvailable: services.settings.secureStorageAvailable,
    systemNotificationSupported: services.notifications.supported,
    settings: services.settings.settings,
    server: services.embeddedServer.status,
    permission: services.permission.status(),
    theme: services.theme.status
  }));

  handle(
    IPC_CHANNELS.settingsUpdate,
    SettingsPatchSchema,
    DesktopSettingsSchema,
    async (patch) => {
      const previous = services.settings.settings;
      const shortcutChanged =
        patch.stopSharingShortcut !== undefined &&
        patch.stopSharingShortcut !== previous.stopSharingShortcut;
      const nextLaunchAtLogin = patch.launchAtLogin ?? previous.launchAtLogin;
      const nextMinimizeToTray = patch.minimizeToTray ?? previous.minimizeToTray;
      const loginItemChanged =
        patch.launchAtLogin !== undefined ||
        (patch.minimizeToTray !== undefined && previous.launchAtLogin);
      if (shortcutChanged) {
        globalShortcut.unregister(previous.stopSharingShortcut);
        if (
          !globalShortcut.register(patch.stopSharingShortcut!, () =>
            services.windowManager.requestStopSharing()
          )
        ) {
          globalShortcut.register(previous.stopSharingShortcut, () =>
            services.windowManager.requestStopSharing()
          );
          throw new Error("快捷键不可用，请换一个组合键");
        }
      }
      try {
        if (loginItemChanged) {
          await services.loginItems.apply(nextLaunchAtLogin, nextMinimizeToTray);
        }
        const next = await services.settings.update(patch);
        if (patch.publicEndpoint !== undefined) {
          services.embeddedServer.configurePublicEndpoint(
            next.publicEndpoint?.target ?? null
          );
        }
        return next;
      } catch (error) {
        if (loginItemChanged) {
          await services.loginItems
            .apply(previous.launchAtLogin, previous.minimizeToTray)
            .catch(() => undefined);
        }
        if (shortcutChanged) {
          globalShortcut.unregister(patch.stopSharingShortcut!);
          globalShortcut.register(previous.stopSharingShortcut, () =>
            services.windowManager.requestStopSharing()
          );
        }
        throw error;
      }
    }
  );

  handle(IPC_CHANNELS.settingsClear, z.undefined(), DesktopSettingsSchema, async () => {
    const previousShortcut = services.settings.settings.stopSharingShortcut;
    await services.gameClient.clearSession();
    await services.loginItems.apply(false, false);
    const next = await services.settings.reset();
    await services.content.reset();
    await services.theme.delete();
    services.embeddedServer.configurePublicEndpoint(null);
    await services.windowManager.applyCustomCss(null);
    services.tray.updateTheme(false);
    globalShortcut.unregister(previousShortcut);
    if (
      !globalShortcut.register(next.stopSharingShortcut, () =>
        services.windowManager.requestStopSharing()
      )
    ) {
      services.logger.warn("默认停止共享快捷键注册失败", {
        shortcut: next.stopSharingShortcut
      });
    }
    return next;
  });

  handle(
    IPC_CHANNELS.settingsChooseFfmpeg,
    z.undefined(),
    z.string().min(1).max(4_096).nullable(),
    async () => {
      const options: Electron.OpenDialogOptions = {
        title: "选择 FFmpeg 可执行文件",
        properties: ["openFile"],
        ...(process.platform === "win32"
          ? {
              filters: [
                { name: "FFmpeg", extensions: ["exe"] },
                { name: "所有文件", extensions: ["*"] }
              ]
            }
          : {})
      };
      const owner = services.windowManager.mainWindow;
      const result = owner
        ? await dialog.showOpenDialog(owner, options)
        : await dialog.showOpenDialog(options);
      return result.canceled ? null : (result.filePaths[0] ?? null);
    }
  );

  handle(
    IPC_CHANNELS.settingsChooseReplayDirectory,
    z.undefined(),
    z.string().min(1).max(4_096).nullable(),
    async () => {
      const options: Electron.OpenDialogOptions = {
        title: "选择接龙回放保存目录",
        properties: ["openDirectory", "createDirectory"]
      };
      const owner = services.windowManager.mainWindow;
      const result = owner
        ? await dialog.showOpenDialog(owner, options)
        : await dialog.showOpenDialog(options);
      return result.canceled ? null : (result.filePaths[0] ?? null);
    }
  );

  handle(
    IPC_CHANNELS.serverStart,
    StartServerArgsSchema,
    EmbeddedServerStatusSchema,
    async ({ port, bindMode, restart }) => {
      if (restart && services.embeddedServer.status.state === "running") {
        await services.gameClient.clearSession().catch((error: unknown) => {
          services.logger.warn("重启服务前清除本地会话文件失败", {
            message: error instanceof Error ? error.message : "未知错误"
          });
        });
      }
      const status = await services.embeddedServer.start(port, bindMode, restart);
      if (status.state === "running" && status.actualPort) {
        await services.settings.update({
          hostPort: port,
          hostBindMode: bindMode
        });
        await services.gameClient.configure({
          host: "127.0.0.1",
          port: status.actualPort,
          security: "http"
        });
      }
      return status;
    }
  );

  handle(
    IPC_CHANNELS.serverStop,
    z.undefined(),
    EmbeddedServerStatusSchema,
    async () => {
      await services.gameClient.clearSession().catch((error: unknown) => {
        services.logger.warn("停止服务前清除本地会话文件失败", {
          message: error instanceof Error ? error.message : "未知错误"
        });
      });
      return services.embeddedServer.stop();
    }
  );

  handle(IPC_CHANNELS.serverPause, HostRoomArgsSchema, z.void(), ({ roomCode }) =>
    services.embeddedServer.pause(roomCode)
  );

  handle(IPC_CHANNELS.serverResume, HostRoomArgsSchema, z.void(), ({ roomCode }) =>
    services.embeddedServer.resume(roomCode)
  );

  handle(
    IPC_CHANNELS.serverChangeRoomPassword,
    HostRoomPasswordArgsSchema,
    z.void(),
    async ({ roomCode, password }) =>
      services.embeddedServer.changeRoomPassword(roomCode, password)
  );

  handle(
    IPC_CHANNELS.serverCloseRoom,
    HostRoomArgsSchema,
    z.void(),
    async ({ roomCode }) => {
      services.embeddedServer.closeRoom(roomCode);
      await services.gameClient.clearSession().catch((error: unknown) => {
        services.logger.warn("房间已关闭，但清除本地会话文件失败", {
          message: error instanceof Error ? error.message : "未知错误"
        });
      });
    }
  );

  handle(
    IPC_CHANNELS.serverRefreshNetworks,
    z.undefined(),
    EmbeddedServerStatusSchema,
    () => services.embeddedServer.refreshNetworks()
  );

  handle(
    IPC_CHANNELS.connectionTest,
    ConnectionTestArgsSchema,
    ConnectionTestResultSchema,
    ({ target, confirmInsecureHttp }) =>
      services.connectionPreflight.test(target, confirmInsecureHttp)
  );

  handle(IPC_CHANNELS.replayRevalidate, z.undefined(), ReplayHostCapabilitySchema, () =>
    services.embeddedServer.revalidateReplay()
  );

  handle(
    IPC_CHANNELS.replayRetry,
    HostRoomArgsSchema,
    ReplaySavedFileSchema,
    ({ roomCode }) => services.embeddedServer.retryReplay(roomCode)
  );

  handle(
    IPC_CHANNELS.replaySaved,
    HostRoomArgsSchema,
    ReplaySavedFileSchema.nullable(),
    ({ roomCode }) => services.embeddedServer.savedReplay(roomCode)
  );

  handle(
    IPC_CHANNELS.replayOpenFile,
    HostRoomArgsSchema,
    z.void(),
    async ({ roomCode }) => {
      const saved = services.embeddedServer.savedReplay(roomCode);
      if (!saved) {
        throw new Error("本地回放尚未生成");
      }
      const error = await shell.openPath(saved.path);
      if (error) {
        throw new Error(error);
      }
    }
  );

  handle(
    IPC_CHANNELS.replayOpenFolder,
    HostRoomArgsSchema,
    z.void(),
    ({ roomCode }) => {
      const saved = services.embeddedServer.savedReplay(roomCode);
      if (!saved) {
        throw new Error("本地回放尚未生成");
      }
      shell.showItemInFolder(saved.path);
    }
  );

  handle(
    IPC_CHANNELS.gameConfigure,
    ConfigureGameSchema,
    z.void(),
    async ({ target }) => services.gameClient.configure(target)
  );

  handle(
    IPC_CHANNELS.gameCreateRoom,
    CreateRoomArgsSchema,
    CreateRoomResponseSchema,
    async ({ nickname, password }) => services.localRooms.createRoom(nickname, password)
  );

  handle(
    IPC_CHANNELS.gameJoinRoom,
    JoinRoomArgsSchema,
    DesktopRoomResponseSchema,
    async ({ target, roomCode, nickname, password, confirmInsecureHttp }) =>
      services.gameClient.joinRoom(
        target,
        roomCode,
        nickname,
        password,
        confirmInsecureHttp
      )
  );

  handle(
    IPC_CHANNELS.gameResume,
    ConfigureGameSchema,
    DesktopRoomResponseSchema.nullable(),
    async ({ target }) => services.gameClient.resume(target)
  );

  handle(IPC_CHANNELS.gameSend, DesktopClientMessageSchema, z.void(), (message) =>
    services.gameClient.send(message)
  );

  handle(
    IPC_CHANNELS.gameUploadFrame,
    UploadFrameArgsSchema,
    UploadFrameResultSchema,
    ({ captureSessionId, bytes }) =>
      services.gameClient.uploadFrame(captureSessionId, bytes)
  );

  handle(
    IPC_CHANNELS.gameWordPoolUpload,
    UploadWordPoolArgsSchema,
    UploadWordPoolResultSchema,
    ({ roomCode, wordPool }) => services.gameClient.uploadWordPool(roomCode, wordPool)
  );

  handle(
    IPC_CHANNELS.gameReferenceUpload,
    UploadReferenceArgsSchema,
    UploadReferenceResultSchema,
    ({ roomCode, mimeType, bytes }) =>
      services.gameClient.uploadReference(roomCode, mimeType, bytes)
  );

  handle(
    IPC_CHANNELS.gameReferenceDelete,
    HostRoomArgsSchema,
    z.void(),
    async ({ roomCode }) => services.gameClient.deleteReference(roomCode)
  );

  handle(
    IPC_CHANNELS.gameAssetGet,
    GetGameAssetArgsSchema,
    GameAssetResultSchema,
    ({ roomCode, path }) => services.gameClient.getAsset(roomCode, path)
  );

  handle(
    IPC_CHANNELS.gameRelayTaskGet,
    GetRelayTaskArgsSchema,
    RelayPrivateTaskResponseSchema,
    ({ roomCode, actorStepId }) =>
      services.gameClient.getRelayTask(roomCode, actorStepId)
  );

  handle(
    IPC_CHANNELS.gameAvatarUpload,
    UploadAvatarArgsSchema,
    AvatarRevisionResultSchema,
    ({ roomCode, bytes }) => services.gameClient.uploadAvatar(roomCode, bytes)
  );

  handle(
    IPC_CHANNELS.gameAvatarDelete,
    AvatarRoomArgsSchema,
    z.void(),
    async ({ roomCode }) => services.gameClient.deleteAvatar(roomCode)
  );

  handle(
    IPC_CHANNELS.gameAvatarGet,
    GetAvatarArgsSchema,
    BinaryValueSchema.nullable(),
    ({ roomCode, playerId, revision }) =>
      services.gameClient.getAvatar(roomCode, playerId, revision)
  );

  handle(IPC_CHANNELS.gameLeaveRoom, z.undefined(), z.void(), async () =>
    services.gameClient.leaveRoom()
  );

  handle(IPC_CHANNELS.gameDisconnect, z.undefined(), z.void(), async () =>
    services.gameClient.disconnect()
  );

  handle(
    IPC_CHANNELS.captureListSources,
    z.undefined(),
    z.array(CaptureSourceSchema),
    async () => services.captureSources.listSources()
  );

  handle(
    IPC_CHANNELS.captureSelectSource,
    z.string().min(1).max(256),
    z.void(),
    (sourceId) => services.captureSources.selectSource(sourceId)
  );

  handle(
    IPC_CHANNELS.capturePermission,
    z.undefined(),
    CapturePermissionStatusSchema,
    () => services.permission.status()
  );

  handle(IPC_CHANNELS.sharingStop, z.undefined(), z.void(), () =>
    services.windowManager.requestStopSharing()
  );

  handle(IPC_CHANNELS.sharingState, SharingStateSchema, z.void(), async (state) => {
    await services.windowManager.setSharingState(state);
    services.tray.updateSharing(state);
  });

  handle(IPC_CHANNELS.windowHide, z.undefined(), z.void(), () => {
    services.windowManager.mainWindow?.hide();
  });

  handle(IPC_CHANNELS.systemOpenFirewallSettings, z.undefined(), z.void(), async () => {
    if (process.platform !== "win32") {
      throw new Error("请在系统设置中手动打开防火墙或网络安全页面");
    }
    await shell.openExternal("ms-settings:windowsdefender-firewall");
  });

  handle(
    IPC_CHANNELS.diagnosticsRead,
    z.undefined(),
    z.array(DiagnosticEntrySchema),
    () => services.logger.entries()
  );

  handle(
    IPC_CHANNELS.diagnosticsExport,
    z.undefined(),
    DiagnosticsExportResultSchema,
    async () => {
      const result = await dialog.showSaveDialog({
        title: "导出脱敏诊断",
        defaultPath: `draw-guess-diagnostics-${new Date()
          .toISOString()
          .slice(0, 10)}.json`,
        filters: [{ name: "JSON", extensions: ["json"] }]
      });
      if (result.canceled || !result.filePath) {
        return { exported: false, path: null };
      }
      const payload = {
        exportedAt: new Date().toISOString(),
        appVersion: app.getVersion(),
        platform: process.platform,
        arch: process.arch,
        packaged: app.isPackaged,
        settings: services.settings.settings,
        server: services.embeddedServer.status,
        permission: services.permission.status(),
        theme: services.theme.status,
        logs: services.logger.entries()
      };
      await writeFile(result.filePath, `${JSON.stringify(payload, null, 2)}\n`, {
        encoding: "utf8",
        mode: 0o600
      });
      return { exported: true, path: result.filePath };
    }
  );

  handle(
    IPC_CHANNELS.contentWordPacksList,
    z.undefined(),
    z.array(WordPackSummarySchema),
    () => services.content.listWordPacks()
  );

  handle(
    IPC_CHANNELS.contentWordPacksGet,
    z.uuid(),
    WordPackFileSchema.nullable(),
    (id) => services.content.getWordPack(id)
  );

  handle(IPC_CHANNELS.contentWordPacksPut, WordPackFileSchema, z.void(), async (pack) =>
    services.content.putWordPack(pack)
  );

  handle(IPC_CHANNELS.contentWordPacksRemove, z.uuid(), z.void(), async (id) =>
    services.content.removeWordPack(id)
  );

  handle(
    IPC_CHANNELS.contentWordSelectionGet,
    z.undefined(),
    WordPackSelectionSchema.nullable(),
    () => services.content.getWordSelection()
  );

  handle(
    IPC_CHANNELS.contentWordSelectionPut,
    WordPackSelectionSchema,
    z.void(),
    async (selection) => services.content.putWordSelection(selection)
  );

  handle(
    IPC_CHANNELS.contentWordFilesOpen,
    z.undefined(),
    z.array(WordPackFileDtoSchema),
    async () => {
      const result = await dialog.showOpenDialog({
        title: "导入词库包",
        properties: ["openFile", "multiSelections"],
        filters: [
          {
            name: "Draw Guess Word Pack",
            extensions: ["drawguess-words.json", "json"]
          }
        ]
      });
      if (result.canceled) {
        return [];
      }
      return services.content.readImportFiles(result.filePaths);
    }
  );

  handle(
    IPC_CHANNELS.contentWordFilesSave,
    SaveWordPackFileArgsSchema,
    z.boolean(),
    async ({ suggestedName, bytes }) => {
      const result = await dialog.showSaveDialog({
        title: "导出词库包",
        defaultPath: `${sanitizeExportFilename(suggestedName)}.drawguess-words.json`,
        filters: [
          {
            name: "Draw Guess Word Pack",
            extensions: ["drawguess-words.json"]
          }
        ]
      });
      if (result.canceled || !result.filePath) {
        return false;
      }
      const target = result.filePath.endsWith(".drawguess-words.json")
        ? result.filePath
        : `${result.filePath}.drawguess-words.json`;
      await services.content.saveExport(target, bytes);
      return true;
    }
  );

  handle(
    IPC_CHANNELS.contentAvatarGet,
    z.undefined(),
    LocalAvatarSchema.nullable(),
    () => services.content.getAvatar()
  );

  handle(IPC_CHANNELS.contentAvatarPut, LocalAvatarSchema, z.void(), async (avatar) =>
    services.content.putAvatar(avatar)
  );

  handle(IPC_CHANNELS.contentAvatarRemove, z.undefined(), z.void(), async () =>
    services.content.removeAvatar()
  );

  handle(
    IPC_CHANNELS.contentNicknameGet,
    z.undefined(),
    RememberedNicknameSchema.nullable(),
    () => services.content.getRememberedNickname()
  );

  handle(
    IPC_CHANNELS.contentNicknamePut,
    RememberedNicknameSchema,
    z.void(),
    async (nickname) => services.content.putRememberedNickname(nickname)
  );

  handle(
    IPC_CHANNELS.themeStatus,
    z.undefined(),
    ThemeStatusSchema,
    () => services.theme.status
  );

  handle(
    IPC_CHANNELS.themeImport,
    ThemeApplyModeSchema,
    ThemeStatusSchema,
    async (applyMode) => {
      const result = await dialog.showOpenDialog({
        title: applyMode === "replace" ? "导入完整替换主题" : "导入 CSS 覆盖主题",
        properties: ["openFile"],
        filters: [{ name: "CSS", extensions: ["css"] }]
      });
      if (result.canceled || !result.filePaths[0]) {
        return services.theme.status;
      }
      await services.theme.importFromPath(result.filePaths[0], applyMode);
      await services.windowManager.applyCustomCss(await services.theme.activeCss());
      const appliedStatus = services.theme.status;
      services.tray.updateTheme(appliedStatus.enabled);
      services.windowManager.sendThemeStatus(appliedStatus);
      return appliedStatus;
    }
  );

  handle(
    IPC_CHANNELS.themeCreateDefault,
    z.undefined(),
    ThemeStatusSchema,
    async () => {
      await services.theme.createFromDefaultTemplate();
      await services.windowManager.applyCustomCss(await services.theme.activeCss());
      const appliedStatus = services.theme.status;
      services.tray.updateTheme(appliedStatus.enabled);
      services.windowManager.sendThemeStatus(appliedStatus);
      return appliedStatus;
    }
  );

  handle(IPC_CHANNELS.themeExportDefault, z.undefined(), z.boolean(), async () => {
    const result = await dialog.showSaveDialog({
      title: "导出画猜现场默认主题模板",
      defaultPath: "drawguess-theme-template.css",
      filters: [{ name: "CSS", extensions: ["css"] }]
    });
    if (result.canceled || !result.filePath) {
      return false;
    }
    const target = result.filePath.toLowerCase().endsWith(".css")
      ? result.filePath
      : `${result.filePath}.css`;
    await services.theme.exportDefaultTemplate(target);
    return true;
  });

  handle(IPC_CHANNELS.themeOpenFolder, z.undefined(), z.void(), async () => {
    const error = await shell.openPath(services.theme.workDirectory);
    if (error) {
      throw new Error(`无法打开主题文件夹：${error}`);
    }
  });

  handle(IPC_CHANNELS.themeReload, z.undefined(), ThemeStatusSchema, async () => {
    await services.theme.reload();
    await services.windowManager.applyCustomCss(await services.theme.activeCss());
    const appliedStatus = services.theme.status;
    services.tray.updateTheme(appliedStatus.enabled);
    services.windowManager.sendThemeStatus(appliedStatus);
    return appliedStatus;
  });

  handle(
    IPC_CHANNELS.themeSuspend,
    z.string().trim().min(1).max(1_000),
    ThemeStatusSchema,
    async (reason) => {
      const status = services.theme.suspend(reason);
      await services.windowManager.applyCustomCss(null);
      services.tray.updateTheme(false);
      services.windowManager.sendThemeStatus(status);
      return status;
    }
  );

  handle(IPC_CHANNELS.themeEnable, z.undefined(), ThemeStatusSchema, async () => {
    await services.theme.enable();
    await services.windowManager.applyCustomCss(await services.theme.activeCss());
    const appliedStatus = services.theme.status;
    services.tray.updateTheme(appliedStatus.enabled);
    services.windowManager.sendThemeStatus(appliedStatus);
    return appliedStatus;
  });

  handle(IPC_CHANNELS.themeDisable, z.undefined(), ThemeStatusSchema, async () => {
    const status = await services.theme.disable();
    await services.windowManager.applyCustomCss(null);
    services.tray.updateTheme(false);
    services.windowManager.sendThemeStatus(status);
    return status;
  });

  handle(IPC_CHANNELS.themeDelete, z.undefined(), ThemeStatusSchema, async () => {
    const status = await services.theme.delete();
    await services.windowManager.applyCustomCss(null);
    services.tray.updateTheme(false);
    services.windowManager.sendThemeStatus(status);
    return status;
  });

  return () => {
    for (const channel of channels) {
      ipcMain.removeHandler(channel);
    }
  };
}
