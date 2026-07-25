import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  app,
  BrowserWindow,
  ipcMain,
  net,
  protocol,
  screen,
  session,
  type IpcMainInvokeEvent,
  type WebPreferences
} from "electron";

import {
  IPC_CHANNELS,
  SharingStateSchema,
  type GameEvent,
  type Invite,
  type SharingState
} from "../shared/ipc.js";
import type { CaptureSourceService } from "./capture-source-service.js";
import type { RedactingLogger } from "./redacting-logger.js";
import type { SettingsService } from "./settings-service.js";
import { THEME_PROTOCOL } from "./theme-service.js";

export const LOCAL_APP_PROTOCOL = "drawguess-app";
export const LOCAL_APP_ORIGIN = `${LOCAL_APP_PROTOCOL}://app`;

export const SECURE_WEB_PREFERENCES: Readonly<
  Pick<
    WebPreferences,
    | "nodeIntegration"
    | "contextIsolation"
    | "sandbox"
    | "webSecurity"
    | "allowRunningInsecureContent"
    | "webviewTag"
  >
> = {
  nodeIntegration: false,
  contextIsolation: true,
  sandbox: true,
  webSecurity: true,
  allowRunningInsecureContent: false,
  webviewTag: false
};

export function registerLocalScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: LOCAL_APP_PROTOCOL,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        corsEnabled: false,
        stream: true
      }
    },
    {
      scheme: THEME_PROTOCOL,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        corsEnabled: false,
        stream: true
      }
    }
  ]);
}

function isWayland(): boolean {
  return (
    process.platform === "linux" &&
    (process.env.XDG_SESSION_TYPE?.toLowerCase() === "wayland" ||
      Boolean(process.env.WAYLAND_DISPLAY))
  );
}

export class WindowManager {
  readonly #settings: SettingsService;
  readonly #captureSources: CaptureSourceService;
  readonly #logger: RedactingLogger;
  #mainWindow: BrowserWindow | null = null;
  #overlayWindow: BrowserWindow | null = null;
  #quitting = false;
  #customCssKey: string | null = null;
  #sharingState: SharingState = {
    active: false,
    sourceName: null,
    captureSessionId: null,
    endsAt: null
  };

  constructor(
    settings: SettingsService,
    captureSources: CaptureSourceService,
    logger: RedactingLogger
  ) {
    this.#settings = settings;
    this.#captureSources = captureSources;
    this.#logger = logger;
  }

  get mainWindow(): BrowserWindow | null {
    return this.#mainWindow;
  }

  registerLocalProtocol(): Promise<void> {
    const rendererRoot = path.resolve(app.getAppPath(), "dist", "renderer");
    protocol.handle(LOCAL_APP_PROTOCOL, async (request) => {
      const parsed = new URL(request.url);
      if (parsed.host !== "app") {
        return new Response("Not found", { status: 404 });
      }
      let pathname: string;
      try {
        pathname = decodeURIComponent(parsed.pathname);
      } catch {
        return new Response("Bad request", { status: 400 });
      }
      const relativePath =
        pathname === "/" || pathname === "" ? "index.html" : pathname.slice(1);
      const target = path.resolve(rendererRoot, relativePath);
      if (target !== rendererRoot && !target.startsWith(`${rendererRoot}${path.sep}`)) {
        return new Response("Forbidden", { status: 403 });
      }
      return net.fetch(pathToFileURL(target).toString());
    });
    return Promise.resolve();
  }

  configureSession(): void {
    const trusted = (url: string): boolean => this.isTrustedUrl(url);
    const allowedPermission = (permission: string): boolean =>
      permission === "media" ||
      permission === "clipboard-sanitized-write" ||
      (permission === "notifications" && this.#settings.settings.notificationsEnabled);
    session.defaultSession.setPermissionCheckHandler(
      (webContents, permission, requestingOrigin) =>
        allowedPermission(permission) &&
        Boolean(webContents) &&
        trusted(webContents?.getURL() ?? "") &&
        trusted(requestingOrigin)
    );
    session.defaultSession.setPermissionRequestHandler(
      (webContents, permission, callback) => {
        callback(allowedPermission(permission) && trusted(webContents.getURL()));
      }
    );
    session.defaultSession.setDisplayMediaRequestHandler(
      (request, callback) => {
        if (
          !request.videoRequested ||
          request.audioRequested ||
          !this.isTrustedUrl(request.securityOrigin)
        ) {
          callback({});
          return;
        }
        const source = this.#captureSources.takeSelectedSource();
        if (!source && !isWayland()) {
          callback({});
          return;
        }
        callback(source ? { video: source } : {});
      },
      { useSystemPicker: isWayland() }
    );
  }

  async createMainWindow(showWhenReady = true): Promise<BrowserWindow> {
    if (this.#mainWindow && !this.#mainWindow.isDestroyed()) {
      return this.#mainWindow;
    }
    const preload =
      process.env.DRAW_GUESS_PRELOAD_PATH ??
      path.join(app.getAppPath(), "dist", "preload", "preload.cjs");
    const window = new BrowserWindow({
      width: 1320,
      height: 860,
      minWidth: 980,
      minHeight: 680,
      show: false,
      backgroundColor: "#101417",
      title: "画猜现场",
      autoHideMenuBar: true,
      webPreferences: {
        ...SECURE_WEB_PREFERENCES,
        preload: path.resolve(preload),
        spellcheck: false
      }
    });
    this.#mainWindow = window;
    this.#secureWebContents(window);
    window.on("close", (event) => {
      if (this.#quitting) {
        return;
      }
      event.preventDefault();
      if (this.#settings.settings.minimizeToTray) {
        window.hide();
      } else {
        app.quit();
      }
    });
    window.on("closed", () => {
      if (this.#mainWindow === window) {
        this.#mainWindow = null;
        this.#customCssKey = null;
      }
    });
    window.once("ready-to-show", () => {
      if (showWhenReady) {
        window.show();
      }
    });
    await window.loadURL(this.#rendererUrl(false));
    return window;
  }

  showMainWindow(): void {
    const window = this.#mainWindow;
    if (!window || window.isDestroyed()) {
      void this.createMainWindow();
      return;
    }
    if (window.isMinimized()) {
      window.restore();
    }
    window.show();
    window.focus();
  }

  isTrustedUrl(value: string): boolean {
    try {
      const parsed = new URL(value);
      if (parsed.protocol === `${LOCAL_APP_PROTOCOL}:` && parsed.host === "app") {
        return true;
      }
      const developmentUrl = process.env.DRAW_GUESS_DESKTOP_DEV_URL;
      return Boolean(
        developmentUrl && parsed.origin === new URL(developmentUrl).origin
      );
    } catch {
      return false;
    }
  }

  assertTrustedIpc(event: IpcMainInvokeEvent): void {
    const senderUrl = event.senderFrame?.url ?? event.sender.getURL();
    if (!this.isTrustedUrl(senderUrl)) {
      this.#logger.warn("已拒绝不可信 IPC sender", { senderUrl });
      throw new Error("IPC sender 不可信");
    }
    const allowed = [this.#mainWindow, this.#overlayWindow].some(
      (window) =>
        window && !window.isDestroyed() && window.webContents.id === event.sender.id
    );
    if (!allowed) {
      throw new Error("IPC sender 不属于应用窗口");
    }
  }

  sendGameEvent(event: GameEvent): void {
    this.#sendToMain(IPC_CHANNELS.gameEvent, event);
  }

  sendServerStatus(status: unknown): void {
    this.#sendToMain(IPC_CHANNELS.serverStatus, status);
  }

  sendInvite(invite: Invite): void {
    this.#sendToMain(IPC_CHANNELS.inviteReceived, invite);
    this.showMainWindow();
  }

  requestStopSharing(): void {
    this.#sendToMain(IPC_CHANNELS.sharingStopRequested, null);
    if (this.#overlayWindow && !this.#overlayWindow.isDestroyed()) {
      this.#overlayWindow.webContents.send(IPC_CHANNELS.sharingStopRequested, null);
    }
  }

  async applyCustomCss(css: string | null): Promise<void> {
    const window = this.#mainWindow;
    if (!window || window.isDestroyed()) {
      return;
    }
    if (this.#customCssKey) {
      await window.webContents
        .removeInsertedCSS(this.#customCssKey)
        .catch(() => undefined);
      this.#customCssKey = null;
    }
    if (css) {
      this.#customCssKey = await window.webContents.insertCSS(css, {
        cssOrigin: "user"
      });
    }
  }

  async setSharingState(stateInput: SharingState): Promise<void> {
    this.#sharingState = SharingStateSchema.parse(stateInput);
    if (this.#sharingState.active) {
      await this.#ensureOverlay();
      this.#overlayWindow?.webContents.send(
        IPC_CHANNELS.sharingState,
        this.#sharingState
      );
    } else if (this.#overlayWindow && !this.#overlayWindow.isDestroyed()) {
      this.#overlayWindow.destroy();
      this.#overlayWindow = null;
    }
  }

  setQuitting(): void {
    this.#quitting = true;
  }

  closeAll(): void {
    this.#quitting = true;
    for (const window of [this.#overlayWindow, this.#mainWindow]) {
      if (window && !window.isDestroyed()) {
        window.destroy();
      }
    }
    this.#overlayWindow = null;
    this.#mainWindow = null;
    this.#customCssKey = null;
    ipcMain.removeAllListeners(IPC_CHANNELS.sharingStopRequested);
  }

  async #ensureOverlay(): Promise<void> {
    if (this.#overlayWindow && !this.#overlayWindow.isDestroyed()) {
      return;
    }
    const workArea = screen.getPrimaryDisplay().workArea;
    const width = 360;
    const height = 56;
    const preload =
      process.env.DRAW_GUESS_OVERLAY_PRELOAD_PATH ??
      path.join(app.getAppPath(), "dist", "preload", "overlay-preload.cjs");
    const overlay = new BrowserWindow({
      width,
      height,
      x: Math.round(workArea.x + (workArea.width - width) / 2),
      y: workArea.y + 16,
      frame: false,
      transparent: true,
      resizable: false,
      movable: true,
      alwaysOnTop: true,
      skipTaskbar: true,
      focusable: true,
      hasShadow: true,
      webPreferences: {
        ...SECURE_WEB_PREFERENCES,
        preload: path.resolve(preload)
      }
    });
    overlay.setContentProtection(true);
    overlay.setAlwaysOnTop(true, "floating");
    overlay.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    this.#overlayWindow = overlay;
    this.#secureWebContents(overlay);
    overlay.on("closed", () => {
      if (this.#overlayWindow === overlay) {
        this.#overlayWindow = null;
      }
    });
    await overlay.loadURL(this.#rendererUrl(true));
  }

  #rendererUrl(overlay: boolean): string {
    const developmentUrl = process.env.DRAW_GUESS_DESKTOP_DEV_URL;
    if (developmentUrl) {
      const url = new URL(developmentUrl);
      if (overlay) {
        url.searchParams.set("overlay", "1");
      }
      return url.toString();
    }
    return `${LOCAL_APP_ORIGIN}/${overlay ? "?overlay=1" : ""}`;
  }

  #secureWebContents(window: BrowserWindow): void {
    window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    window.webContents.on("will-navigate", (event, targetUrl) => {
      if (!this.isTrustedUrl(targetUrl)) {
        event.preventDefault();
      }
    });
    window.webContents.on("will-attach-webview", (event) => {
      event.preventDefault();
    });
  }

  #sendToMain(channel: string, value: unknown): void {
    const window = this.#mainWindow;
    if (window && !window.isDestroyed()) {
      window.webContents.send(channel, value);
    }
  }
}
