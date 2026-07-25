import path from "node:path";

import { app, Menu, nativeImage, Tray } from "electron";

import type { SharingState } from "../shared/ipc.js";
import type { RedactingLogger } from "./redacting-logger.js";

export class TrayService {
  readonly #iconPath: string;
  readonly #showWindow: () => void;
  readonly #stopSharing: () => void;
  readonly #quit: () => void;
  readonly #disableTheme: () => void;
  readonly #logger: RedactingLogger;
  #tray: Tray | null = null;
  #sharing: SharingState = {
    active: false,
    sourceName: null,
    captureSessionId: null,
    endsAt: null
  };
  #themeEnabled = false;

  constructor(
    showWindow: () => void,
    stopSharing: () => void,
    disableTheme: () => void,
    quit: () => void,
    logger: RedactingLogger
  ) {
    this.#iconPath = path.join(app.getAppPath(), "assets", "icon.png");
    this.#showWindow = showWindow;
    this.#stopSharing = stopSharing;
    this.#disableTheme = disableTheme;
    this.#quit = quit;
    this.#logger = logger;
  }

  create(): void {
    if (this.#tray) {
      return;
    }
    try {
      const image = nativeImage.createFromPath(this.#iconPath).resize({
        width: 20,
        height: 20
      });
      this.#tray = new Tray(image);
      this.#tray.on("double-click", this.#showWindow);
      this.#rebuildMenu();
    } catch (error) {
      this.#logger.warn("系统托盘不可用", {
        message: error instanceof Error ? error.message : "unknown"
      });
    }
  }

  updateSharing(state: SharingState): void {
    this.#sharing = state;
    this.#rebuildMenu();
  }

  updateTheme(enabled: boolean): void {
    this.#themeEnabled = enabled;
    this.#rebuildMenu();
  }

  destroy(): void {
    this.#tray?.destroy();
    this.#tray = null;
  }

  #rebuildMenu(): void {
    if (!this.#tray) {
      return;
    }
    this.#tray.setToolTip(
      this.#sharing.active ? "画猜现场 · 正在共享" : "画猜现场 · 未共享"
    );
    this.#tray.setContextMenu(
      Menu.buildFromTemplate([
        {
          label: "显示画猜现场",
          click: this.#showWindow
        },
        {
          label: this.#sharing.active ? "立即停止共享" : "当前未共享",
          enabled: this.#sharing.active,
          click: this.#stopSharing
        },
        {
          label: this.#themeEnabled
            ? "禁用自定义 CSS（安全恢复）"
            : "自定义 CSS 未启用",
          enabled: this.#themeEnabled,
          click: this.#disableTheme
        },
        { type: "separator" },
        {
          label: "退出",
          click: this.#quit
        }
      ])
    );
  }
}
