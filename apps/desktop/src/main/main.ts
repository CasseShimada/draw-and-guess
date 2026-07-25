import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import electronSquirrelStartup from "electron-squirrel-startup";
import { Notification, app, globalShortcut, powerMonitor, safeStorage } from "electron";

import { PROTOCOL_VERSION } from "@draw-guess/protocol";

import { parseInviteArguments } from "../shared/deep-link.js";
import type { Invite } from "../shared/ipc.js";
import { CaptureSourceService } from "./capture-source-service.js";
import { ContentStorageService } from "./content-storage-service.js";
import { EmbeddedServerService } from "./embedded-server-service.js";
import {
  FixedNotificationService,
  type NativeNotificationHandle
} from "./fixed-notification-service.js";
import { GameClientService } from "./game-client-service.js";
import { registerIpcHandlers } from "./ipc-controller.js";
import { LoginItemService } from "./login-item-service.js";
import { PermissionService } from "./permission-service.js";
import { RedactingLogger } from "./redacting-logger.js";
import { SettingsService, type EncryptionProvider } from "./settings-service.js";
import { ThemeService } from "./theme-service.js";
import { TrayService } from "./tray-service.js";
import { WindowManager, registerLocalScheme } from "./window-manager.js";

app.enableSandbox();
registerLocalScheme();

if (process.env.DRAW_GUESS_USER_DATA) {
  app.setPath("userData", path.resolve(process.env.DRAW_GUESS_USER_DATA));
}

const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock || electronSquirrelStartup) {
  app.quit();
}

let pendingInvite: Invite | null = null;
let activeWindowManager: WindowManager | null = null;
let shutdownRequested = false;
let shutdownComplete = false;
let shutdown: (() => Promise<void>) | null = null;

function deliverInvite(invite: Invite): void {
  if (activeWindowManager) {
    activeWindowManager.sendInvite(invite);
  } else {
    pendingInvite = invite;
  }
}

app.on("second-instance", (_event, argv) => {
  const invite = parseInviteArguments(argv);
  if (invite) {
    deliverInvite(invite);
  } else {
    activeWindowManager?.showMainWindow();
  }
});

app.on("open-url", (event, url) => {
  event.preventDefault();
  const invite = parseInviteArguments([url]);
  if (invite) {
    deliverInvite(invite);
  }
});

const commandLineInvite = parseInviteArguments(process.argv);
if (commandLineInvite) {
  pendingInvite = commandLineInvite;
}

function encryptionProvider(): EncryptionProvider {
  return {
    isAvailable: () => safeStorage.isEncryptionAvailable(),
    backend: () =>
      process.platform === "linux"
        ? safeStorage.getSelectedStorageBackend()
        : "os-keychain",
    encrypt: (value) => safeStorage.encryptString(value),
    decrypt: (value) => safeStorage.decryptString(Buffer.from(value))
  };
}

async function runSmokeCheck(
  resultPath: string,
  windowManager: WindowManager,
  theme: ThemeService
): Promise<void> {
  const window = windowManager.mainWindow;
  if (!window) {
    throw new Error("冒烟测试窗口不存在");
  }
  const renderer = (await window.webContents.executeJavaScript(
    `({
      nodeProcess: typeof process,
      nodeRequire: typeof require,
      bridge: typeof window.drawGuessDesktop,
      protocol: window.location.protocol,
      title: document.title
    })`,
    true
  )) as Record<string, unknown>;
  const server = (await window.webContents.executeJavaScript(
    `window.drawGuessDesktop.server.start({ port: 32100, allowLan: false })`,
    true
  )) as {
    state: string;
    localUrls: string[];
  };
  const healthUrl = server.localUrls[0] ? `${server.localUrls[0]}/health` : null;
  const health = healthUrl
    ? ((await (await fetch(healthUrl)).json()) as { ok?: unknown })
    : null;
  const browserResponse = server.localUrls[0] ? await fetch(server.localUrls[0]) : null;
  const browserHtml = browserResponse ? await browserResponse.text() : "";
  const roomResponse = server.localUrls[0]
    ? await fetch(`${server.localUrls[0]}/api/desktop/rooms`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Draw-Guess-Client": "desktop",
          "X-Draw-Guess-Protocol": String(PROTOCOL_VERSION)
        },
        body: JSON.stringify({
          nickname: "Smoke Host",
          password: "smoke-password"
        })
      })
    : null;
  const roomBody = roomResponse
    ? ((await roomResponse.json()) as {
        sessionToken?: unknown;
        snapshot?: { roomCode?: unknown };
      })
    : null;
  const embedded = {
    browserStatus: browserResponse?.status ?? null,
    browserEntryPresent:
      browserHtml.includes('<div id="root"></div>') &&
      browserHtml.includes("<title>画猜现场"),
    desktopRoomStatus: roomResponse?.status ?? null,
    desktopSessionIssued:
      typeof roomBody?.sessionToken === "string" &&
      typeof roomBody.snapshot?.roomCode === "string",
    desktopCookieIssued: Boolean(roomResponse?.headers.get("set-cookie"))
  };
  const themeSource = path.join(app.getPath("userData"), "smoke-theme-source");
  mkdirSync(themeSource, { recursive: true });
  copyFileSync(
    path.join(app.getAppPath(), "assets", "icon.png"),
    path.join(themeSource, "marker.png")
  );
  const themeCssPath = path.join(themeSource, "style.css");
  writeFileSync(
    themeCssPath,
    [
      ":root { --smoke-theme-marker: packaged-theme-ready; }",
      '[data-ui="home-intro"] { background-image: url("./marker.png"); }'
    ].join("\n"),
    "utf8"
  );
  await theme.importFromPath(themeCssPath);
  const activeThemeCss = await theme.activeCss();
  await windowManager.applyCustomCss(activeThemeCss);
  const themeAssetUrl = activeThemeCss?.match(
    /drawguess-theme:\/\/active\/assets\/[A-Za-z0-9._-]+/u
  )?.[0];
  const themeRuntime = themeAssetUrl
    ? ((await window.webContents.executeJavaScript(
        `new Promise((resolve) => {
          const image = new Image();
          image.onload = () => {
            const root = document.querySelector('[data-ui="theme-root"]');
            resolve({
              assetLoaded: true,
              marker: root
                ? getComputedStyle(root).getPropertyValue('--smoke-theme-marker').trim()
                : null
            });
          };
          image.onerror = () => resolve({ assetLoaded: false, marker: null });
          image.src = ${JSON.stringify(themeAssetUrl)};
        })`,
        true
      )) as { assetLoaded: boolean; marker: string | null })
    : { assetLoaded: false, marker: null };
  writeFileSync(
    resultPath,
    `${JSON.stringify(
      {
        ok:
          renderer.nodeProcess === "undefined" &&
          renderer.nodeRequire === "undefined" &&
          renderer.bridge === "object" &&
          server.state === "running" &&
          health?.ok === true &&
          embedded.browserStatus === 200 &&
          embedded.browserEntryPresent &&
          embedded.desktopRoomStatus === 201 &&
          embedded.desktopSessionIssued &&
          !embedded.desktopCookieIssued &&
          themeRuntime.assetLoaded &&
          themeRuntime.marker === "packaged-theme-ready",
        protocolVersion: PROTOCOL_VERSION,
        renderer,
        server,
        health,
        embedded,
        theme: {
          status: theme.status,
          runtime: themeRuntime,
          assetUrl: themeAssetUrl ?? null
        }
      },
      null,
      2
    )}\n`,
    "utf8"
  );
}

async function boot(): Promise<void> {
  if (!hasSingleInstanceLock || electronSquirrelStartup) {
    return;
  }
  await app.whenReady();
  if (process.platform === "win32") {
    app.setAppUserModelId("com.drawguess.desktop");
  }
  if (app.isPackaged) {
    app.setAsDefaultProtocolClient("drawguess");
  } else {
    app.setAsDefaultProtocolClient("drawguess", process.execPath, [
      path.resolve(process.argv[1] ?? ".")
    ]);
  }

  const logger = new RedactingLogger(path.join(app.getPath("userData"), "logs"));
  const settings = new SettingsService(app.getPath("userData"), encryptionProvider());
  await settings.initialize();
  const theme = new ThemeService(app.getPath("userData"), settings, logger);
  const safeThemeStartup =
    process.argv.includes("--safe-mode") ||
    process.argv.includes("--disable-custom-css");
  await theme.initialize(safeThemeStartup);
  await theme.registerProtocol();
  const content = new ContentStorageService(app.getPath("userData"));
  await content.initialize();
  const loginItems = new LoginItemService();
  const captureSources = new CaptureSourceService(logger);
  const permission = new PermissionService();
  const windowManager = new WindowManager(settings, captureSources, logger);
  activeWindowManager = windowManager;
  await windowManager.registerLocalProtocol();
  windowManager.configureSession();
  const startHidden = settings.settings.minimizeToTray && loginItems.wasOpenedAtLogin();
  await windowManager.createMainWindow(!startHidden);
  await windowManager.applyCustomCss(await theme.activeCss());

  const embeddedServer = new EmbeddedServerService(
    path.join(app.getAppPath(), "dist", "browser"),
    logger,
    {
      replayConfig: () => ({
        configuredExecutable: settings.settings.ffmpegExecutable,
        outputDirectory:
          settings.settings.replayOutputDirectory ??
          path.join(app.getPath("videos"), "Draw Guess Replays"),
        temporaryDirectory: path.join(app.getPath("userData"), "replay-jobs"),
        maxJobBytes: settings.settings.replayMaxJobGiB * 1024 ** 3,
        maxTotalTemporaryBytes: settings.settings.replayMaxTemporaryGiB * 1024 ** 3,
        minimumFreeBytes: settings.settings.replayMinimumFreeGiB * 1024 ** 3
      })
    }
  );
  const gameClient = new GameClientService(settings, logger);
  const notifications = new FixedNotificationService({
    enabled: () => settings.settings.notificationsEnabled,
    supported: () => Notification.isSupported(),
    focused: () => windowManager.mainWindow?.isFocused() ?? false,
    focusWindow: () => windowManager.showMainWindow(),
    show: ({ title, body, onClick, onClose }): NativeNotificationHandle => {
      const notification = new Notification({ title, body });
      notification.once("click", onClick);
      notification.once("close", onClose);
      notification.show();
      return { close: () => notification.close() };
    }
  });
  const requestStopSharing = () => windowManager.requestStopSharing();
  const disableTheme = () => {
    void theme
      .disable()
      .then(async () => {
        await windowManager.applyCustomCss(null);
        tray.updateTheme(false);
        windowManager.showMainWindow();
      })
      .catch((error: unknown) =>
        logger.warn("托盘安全恢复自定义 CSS 失败", {
          message: error instanceof Error ? error.message : "unknown"
        })
      );
  };
  const tray = new TrayService(
    () => windowManager.showMainWindow(),
    requestStopSharing,
    disableTheme,
    () => app.quit(),
    logger
  );
  tray.create();
  tray.updateTheme(theme.status.enabled);

  const unregisterIpc = registerIpcHandlers({
    windowManager,
    settings,
    embeddedServer,
    gameClient,
    notifications,
    loginItems,
    captureSources,
    permission,
    logger,
    tray,
    content,
    theme
  });
  const unsubscribeGame = gameClient.onEvent((event) => {
    if (event.kind === "message") {
      notifications.handle(event.message);
    }
    windowManager.sendGameEvent(event);
  });
  const unsubscribeServer = embeddedServer.onStatus((status) =>
    windowManager.sendServerStatus(status)
  );

  if (
    !globalShortcut.register(settings.settings.stopSharingShortcut, requestStopSharing)
  ) {
    logger.warn("全局停止共享快捷键注册失败", {
      shortcut: settings.settings.stopSharingShortcut
    });
  }

  shutdown = async () => {
    if (shutdownRequested) {
      return;
    }
    shutdownRequested = true;
    logger.info("应用正在安全退出");
    windowManager.requestStopSharing();
    await gameClient.disconnect();
    logger.info("游戏连接已关闭");
    await embeddedServer.stop();
    logger.info("内置服务器已关闭");
    globalShortcut.unregisterAll();
    unsubscribeGame();
    unsubscribeServer();
    notifications.dispose();
    unregisterIpc();
    tray.destroy();
    windowManager.setQuitting();
    windowManager.closeAll();
    logger.info("应用窗口与托盘已关闭");
    await logger.flush();
    shutdownComplete = true;
  };

  app.on("activate", () => windowManager.showMainWindow());
  powerMonitor.on("shutdown", () => {
    void shutdown?.();
  });

  if (pendingInvite) {
    windowManager.sendInvite(pendingInvite);
    pendingInvite = null;
  }

  const smokeResultPath = process.env.DRAW_GUESS_SMOKE_RESULT;
  if (smokeResultPath) {
    let smokePassed = false;
    try {
      await runSmokeCheck(path.resolve(smokeResultPath), windowManager, theme);
      smokePassed = true;
    } catch (error) {
      writeFileSync(
        path.resolve(smokeResultPath),
        `${JSON.stringify({
          ok: false,
          error: error instanceof Error ? error.message : "smoke failed"
        })}\n`,
        "utf8"
      );
    } finally {
      await shutdown();
      app.exit(smokePassed ? 0 : 1);
    }
  }
}

app.on("before-quit", (event) => {
  if (shutdownComplete || !shutdown) {
    return;
  }
  event.preventDefault();
  void shutdown().finally(() => app.quit());
});

void boot().catch(async (error: unknown) => {
  console.error(error);
  if (shutdown) {
    await shutdown().catch(() => undefined);
  }
  app.exit(1);
});
