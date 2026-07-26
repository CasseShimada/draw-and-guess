import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import electronSquirrelStartup from "electron-squirrel-startup";
import { Notification, app, globalShortcut, powerMonitor, safeStorage } from "electron";

import { ConnectionInfoSchema, PROTOCOL_VERSION } from "@draw-guess/protocol";

import { CaptureSourceService } from "./capture-source-service.js";
import { ConnectionPreflightService } from "./connection-preflight-service.js";
import { ContentStorageService } from "./content-storage-service.js";
import { EmbeddedServerService } from "./embedded-server-service.js";
import {
  FixedNotificationService,
  type NativeNotificationHandle
} from "./fixed-notification-service.js";
import { GameClientService } from "./game-client-service.js";
import { registerIpcHandlers } from "./ipc-controller.js";
import { LoginItemService } from "./login-item-service.js";
import { LocalRoomCoordinator } from "./local-room-coordinator.js";
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

let activeWindowManager: WindowManager | null = null;
let shutdownRequested = false;
let shutdownComplete = false;
let shutdown: (() => Promise<void>) | null = null;

app.on("second-instance", () => activeWindowManager?.showMainWindow());

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
    `window.drawGuessDesktop.server.start({ port: 32100, bindMode: "loopback-only", restart: false })`,
    true
  )) as {
    state: string;
    loopbackOrigin: string | null;
    serverInstanceId: string | null;
  };
  const healthUrl = server.loopbackOrigin ? `${server.loopbackOrigin}/health` : null;
  const health = healthUrl
    ? ((await (await fetch(healthUrl)).json()) as { ok?: unknown })
    : null;
  const connectionInfo = server.loopbackOrigin
    ? ConnectionInfoSchema.parse(
        await (await fetch(`${server.loopbackOrigin}/api/connection-info`)).json()
      )
    : null;
  const browserResponse = server.loopbackOrigin
    ? await fetch(server.loopbackOrigin)
    : null;
  const browserHtml = browserResponse ? await browserResponse.text() : "";
  const roomResponse = server.loopbackOrigin
    ? await fetch(`${server.loopbackOrigin}/api/desktop/rooms`, {
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
  const networkUi = (await window.webContents.executeJavaScript(
    `new Promise((resolve) => {
      const joinButton = [...document.querySelectorAll("button")].find(
        (button) => button.textContent?.trim() === "加入房间"
      );
      joinButton?.click();
      requestAnimationFrame(() => requestAnimationFrame(() => {
        const labels = [...document.querySelectorAll("label")];
        const addressLabel = labels.find((label) =>
          label.textContent?.includes("服务器地址或 IP")
        );
        const portLabel = labels.find((label) =>
          label.textContent?.trim().startsWith("端口")
        );
        const securityLabel = labels.find((label) =>
          label.textContent?.includes("连接安全性")
        );
        const bindMode = labels.find((label) =>
          label.textContent?.includes("绑定模式")
        );
        const toolbar = document.querySelector(".desktop-toolbar");
        const toolbarBounds = toolbar?.getBoundingClientRect();
        resolve({
          addressIsText:
            addressLabel?.querySelector("input")?.getAttribute("type") === "text",
          hasPort: portLabel?.querySelector("input")?.getAttribute("type") === "number",
          hasSecurity: Boolean(securityLabel?.querySelector("select")),
          hasBindModes:
            bindMode?.textContent?.includes("仅本机") === true &&
            bindMode?.textContent?.includes("局域网 / 可做端口转发") === true,
          toolbarIntegratedWithHomeActions:
            Boolean(toolbar) && Boolean(toolbar?.closest(".home-content-actions")),
          toolbarAtTop:
            Boolean(toolbarBounds) &&
            toolbarBounds.top >= 0 &&
            toolbarBounds.bottom < window.innerHeight / 2,
          toolbarInsideViewport:
            Boolean(toolbarBounds) &&
            toolbarBounds.right <= window.innerWidth &&
            toolbarBounds.left >= 0,
          noExternalInviteBridge:
            typeof window.drawGuessDesktop.app.onInvite === "undefined"
        });
      }));
    })`,
    true
  )) as Record<string, unknown>;
  const captureUi = (await window.webContents.executeJavaScript(
    `(async () => {
      document.querySelector('[data-ui="desktop-control-center-trigger"]')?.click();
      const captureButton = await new Promise((resolve) => {
        const deadline = Date.now() + 5_000;
        const inspect = () => {
          const button = document.querySelector('[data-ui="capture-management"]');
          if (button || Date.now() >= deadline) {
            resolve(button);
            return;
          }
          setTimeout(inspect, 50);
        };
        inspect();
      });
      captureButton?.click();
      const panel = await new Promise((resolve) => {
        const deadline = Date.now() + 5_000;
        const inspect = () => {
          const candidate = document.querySelector(
            ".capture-studio.desktop-panel--open"
          );
          if (candidate || Date.now() >= deadline) {
            resolve(candidate);
            return;
          }
          setTimeout(inspect, 50);
        };
        inspect();
      });
      const toolbar = panel?.querySelector(".crop-toolbar");
      const sample = document.createElement("button");
      sample.textContent = "对比度检查";
      toolbar?.append(sample);
      const parseRgb = (value) =>
        (value.match(/[\\d.]+/g) ?? []).slice(0, 3).map(Number);
      const luminance = (value) => {
        const channels = parseRgb(value).map((channel) => {
          const normalized = channel / 255;
          return normalized <= 0.04045
            ? normalized / 12.92
            : ((normalized + 0.055) / 1.055) ** 2.4;
        });
        return (
          (channels[0] ?? 0) * 0.2126 +
          (channels[1] ?? 0) * 0.7152 +
          (channels[2] ?? 0) * 0.0722
        );
      };
      const contrast = (element) => {
        const style = getComputedStyle(element);
        const foreground = luminance(style.color);
        const background = luminance(style.backgroundColor);
        return (Math.max(foreground, background) + 0.05) /
          (Math.min(foreground, background) + 0.05);
      };
      const enabledContrast = toolbar ? contrast(sample) : 0;
      sample.disabled = true;
      const disabledContrast = toolbar ? contrast(sample) : 0;
      sample.remove();
      panel?.querySelector('button[aria-label="关闭采集工作室"]')?.click();
      return {
        panelOpened: Boolean(panel),
        enabledContrast,
        disabledContrast,
        enabledReadable: enabledContrast >= 4.5,
        disabledReadable: disabledContrast >= 4.5
      };
    })()`,
    true
  )) as Record<string, unknown>;
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
  await theme.importFromPath(themeCssPath, "override");
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
  const autoLocalCreate = (await window.webContents.executeJavaScript(
    `(async () => {
      await window.drawGuessDesktop.server.stop();
      const response = await window.drawGuessDesktop.game.createRoom({
        nickname: "Auto-start Smoke Host",
        password: "smoke-password"
      });
      const refreshed = await window.drawGuessDesktop.bootstrap();
      const roomCodeUi = await new Promise((resolve) => {
        const deadline = Date.now() + 5_000;
        const inspect = () => {
          const copyButton = document.querySelector('[data-ui="room-code-copy"]');
          const displayedCode = copyButton?.querySelector("code")?.textContent?.trim();
          const compactInTopbar = Boolean(copyButton?.closest('[data-ui="topbar"]'));
          const desktopToolbar = document.querySelector(".desktop-toolbar");
          const toolbarIntegratedInTopbar = Boolean(
            desktopToolbar?.closest('[data-ui="topbar"]')
          );
          const largeInviteBannerAbsent =
            document.querySelector(".host-room-code-banner") === null;
          const lobbyConnectionModuleAbsent =
            document.querySelector('[data-ui="host-network-info"]') === null;
          if (
            displayedCode === response.snapshot.roomCode &&
            compactInTopbar &&
            toolbarIntegratedInTopbar &&
            largeInviteBannerAbsent &&
            lobbyConnectionModuleAbsent
          ) {
            resolve({
              visible: true,
              displayedCode,
              hasCopyButton: copyButton?.tagName === "BUTTON",
              compactInTopbar,
              toolbarIntegratedInTopbar,
              largeInviteBannerAbsent,
              lobbyConnectionModuleAbsent
            });
            return;
          }
          if (Date.now() >= deadline) {
            resolve({
              visible: false,
              displayedCode: displayedCode ?? null,
              hasCopyButton: copyButton?.tagName === "BUTTON",
              compactInTopbar,
              toolbarIntegratedInTopbar,
              largeInviteBannerAbsent,
              lobbyConnectionModuleAbsent
            });
            return;
          }
          setTimeout(inspect, 50);
        };
        inspect();
      });
      const toastUi = await new Promise((resolve) => {
        const startButton = [...document.querySelectorAll("button")].find(
          (button) => button.textContent?.trim() === "开始经典画猜"
        );
        startButton?.click();
        const deadline = Date.now() + 5_000;
        const inspect = () => {
          const toast = document.querySelector('[data-ui="game-toast"]');
          const toolbar = document.querySelector(".desktop-toolbar");
          const toastBounds = toast?.getBoundingClientRect();
          const toolbarBounds = toolbar?.getBoundingClientRect();
          if ((toast && toolbar) || Date.now() >= deadline) {
            const separated =
              Boolean(toastBounds && toolbarBounds) &&
              (toastBounds.bottom <= toolbarBounds.top ||
                toolbarBounds.bottom <= toastBounds.top);
            resolve({
              visible: Boolean(toast),
              explainsMinimumPlayers:
                toast?.textContent?.includes("至少") === true,
              separatedFromToolbar: separated
            });
            toast?.click();
            return;
          }
          setTimeout(inspect, 50);
        };
        inspect();
      });
      const selfNickname =
        response.snapshot.players.find(
          (player) => player.id === response.snapshot.selfPlayerId
        )?.nickname ?? null;
      return {
        roomCode: response.snapshot.roomCode,
        selfNickname,
        target: response.target,
        server: response.server,
        persistedTarget: refreshed.settings.currentClientTarget,
        defaultMinimizeToTray: refreshed.settings.minimizeToTray,
        roomCodeUi,
        toastUi
      };
    })()`,
    true
  )) as {
    roomCode: unknown;
    selfNickname: unknown;
    target: { host?: unknown; port?: unknown; security?: unknown };
    server: {
      state?: unknown;
      actualPort?: unknown;
      serverInstanceId?: unknown;
    };
    persistedTarget: { host?: unknown; port?: unknown; security?: unknown };
    defaultMinimizeToTray: unknown;
    roomCodeUi: {
      visible?: unknown;
      displayedCode?: unknown;
      hasCopyButton?: unknown;
      compactInTopbar?: unknown;
      toolbarIntegratedInTopbar?: unknown;
      largeInviteBannerAbsent?: unknown;
      lobbyConnectionModuleAbsent?: unknown;
    };
    toastUi: {
      visible?: unknown;
      explainsMinimumPlayers?: unknown;
      separatedFromToolbar?: unknown;
    };
  };
  windowManager.sendGameEvent({
    kind: "connection",
    state: "offline",
    error: "房主已退出，房间服务已停止"
  });
  const roomClosureConfirmationUi = (await window.webContents.executeJavaScript(
    `new Promise((resolve) => {
      const deadline = Date.now() + 5_000;
      const inspectDialog = () => {
        const dialog = document.querySelector('[data-ui="room-closure-dialog"]');
        const confirmButton = dialog?.querySelector(
          '[data-ui="confirm-room-closure"]'
        );
        if (dialog && confirmButton) {
          const roomCodeBeforeConfirmation = document
            .querySelector('[data-ui="room-code-copy"] code')
            ?.textContent?.trim();
          const homeBeforeConfirmation = Boolean(
            document.querySelector('[data-ui="home-screen"]')
          );
          confirmButton.click();
          const inspectHome = () => {
            const homeAfterConfirmation = Boolean(
              document.querySelector('[data-ui="home-screen"]')
            );
            const roomCodeHiddenAfterConfirmation =
              document.querySelector('[data-ui="room-code-copy"]') === null;
            if (
              (homeAfterConfirmation && roomCodeHiddenAfterConfirmation) ||
              Date.now() >= deadline
            ) {
              resolve({
                dialogVisible: true,
                reasonVisible:
                  dialog.textContent?.includes(
                    "房主已退出，房间服务已停止"
                  ) === true,
                confirmationActionVisible: true,
                heldRoomUntilConfirmation:
                  roomCodeBeforeConfirmation ===
                    ${JSON.stringify(autoLocalCreate.roomCode)} &&
                  !homeBeforeConfirmation,
                homeAfterConfirmation,
                roomCodeHiddenAfterConfirmation
              });
              return;
            }
            setTimeout(inspectHome, 50);
          };
          setTimeout(inspectHome, 0);
          return;
        }
        if (Date.now() >= deadline) {
          resolve({
            dialogVisible: false,
            reasonVisible: false,
            confirmationActionVisible: Boolean(confirmButton),
            heldRoomUntilConfirmation: false,
            homeAfterConfirmation: Boolean(
              document.querySelector('[data-ui="home-screen"]')
            ),
            roomCodeHiddenAfterConfirmation:
              document.querySelector('[data-ui="room-code-copy"]') === null
          });
          return;
        }
        setTimeout(inspectDialog, 50);
      };
      inspectDialog();
    })`,
    true
  )) as Record<string, unknown>;
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error("刷新桌面界面以恢复房主状态超时"));
    }, 10_000);
    window.webContents.once("did-finish-load", () => {
      clearTimeout(timeout);
      resolve();
    });
    window.webContents.reload();
  });
  const hostRoomRuntime = (await window.webContents.executeJavaScript(
    `(async () => {
      const roomCode = ${JSON.stringify(autoLocalCreate.roomCode)};
      const target = ${JSON.stringify(autoLocalCreate.target)};
      const controlCenterTrigger = await new Promise((resolve) => {
        const deadline = Date.now() + 5_000;
        const inspect = () => {
          const button = document.querySelector(
            '[data-ui="desktop-control-center-trigger"]'
          );
          const displayedCode = document
            .querySelector('[data-ui="room-code-copy"] code')
            ?.textContent?.trim();
          if (button && displayedCode === roomCode) {
            resolve(button);
            return;
          }
          if (Date.now() >= deadline) {
            resolve(null);
            return;
          }
          setTimeout(inspect, 50);
        };
        inspect();
      });
      controlCenterTrigger?.click();
      const connectionButton = await new Promise((resolve) => {
        const deadline = Date.now() + 5_000;
        const inspect = () => {
          const button = document.querySelector(
            '[data-ui="connection-management"]'
          );
          if (button) {
            resolve(button);
            return;
          }
          if (Date.now() >= deadline) {
            resolve(null);
            return;
          }
          setTimeout(inspect, 50);
        };
        inspect();
      });
      connectionButton?.click();
      const connectionPanelUi = await new Promise((resolve) => {
        const deadline = Date.now() + 5_000;
        const inspect = () => {
          const panel = document.querySelector(
            ".connection-panel.desktop-panel--open"
          );
          if (panel || Date.now() >= deadline) {
            const bounds = panel?.getBoundingClientRect();
            const grid = panel?.querySelector(".connection-grid");
            const description = panel?.querySelector(".connection-card > p");
            const input = panel?.querySelector(".connection-card input");
            const columnTracks = grid
              ? getComputedStyle(grid).gridTemplateColumns.split(" ").filter(Boolean)
              : [];
            resolve({
              visible: Boolean(panel),
              wideLayout:
                Boolean(bounds) &&
                bounds.width >= Math.min(950, window.innerWidth - 220),
              twoReadableColumns: columnTracks.length === 2,
              descriptionFontSize: description
                ? Number.parseFloat(getComputedStyle(description).fontSize)
                : 0,
              inputFontSize: input
                ? Number.parseFloat(getComputedStyle(input).fontSize)
                : 0,
              noBottomFloatingToolbar:
                document.querySelector(".desktop-root > .desktop-toolbar") === null
            });
            return;
          }
          setTimeout(inspect, 50);
        };
        inspect();
      });
      const passwordControlUi = await new Promise((resolve) => {
        const deadline = Date.now() + 5_000;
        const inspect = () => {
          const control = document.querySelector(
            '[data-ui="actual-host-room-password"]'
          );
          if (
            control &&
            control.textContent?.includes(roomCode) &&
            control.querySelectorAll('input[type="password"]').length === 2 &&
            control.querySelector('[data-ui="actual-host-close-room"]')
          ) {
            resolve({
              visible: true,
              hasTwoPasswordInputs: true,
              hasCloseRoomAction: true
            });
            return;
          }
          if (Date.now() >= deadline) {
            resolve({
              visible: false,
              hasTwoPasswordInputs:
                control?.querySelectorAll('input[type="password"]').length === 2,
              hasCloseRoomAction: Boolean(
                control?.querySelector('[data-ui="actual-host-close-room"]')
              )
            });
            return;
          }
          setTimeout(inspect, 50);
        };
        inspect();
      });
      await window.drawGuessDesktop.server.changeRoomPassword(
        roomCode,
        "rotated-smoke-password"
      );
      let rejectedJoinMessage = null;
      try {
        await window.drawGuessDesktop.game.joinRoom({
          target,
          confirmInsecureHttp: false,
          roomCode,
          nickname: "Rejected Smoke Player",
          password: "smoke-password"
        });
      } catch (error) {
        rejectedJoinMessage =
          error instanceof Error ? error.message : String(error);
      }
      const diagnostics = await window.drawGuessDesktop.diagnostics.read();
      const joinFailureDiagnostic =
        [...diagnostics]
          .reverse()
          .find((entry) => entry.message.startsWith("加入房间失败"))?.message ??
        null;
      document.querySelector('[data-ui="desktop-diagnostics"]')?.click();
      const joinFailureDiagnosticUi = await new Promise((resolve) => {
        const deadline = Date.now() + 5_000;
        const inspect = () => {
          const highlight = document.querySelector(
            '[data-ui="join-failure-diagnostic"]'
          );
          if (
            highlight?.textContent?.includes("房间密码错误") &&
            highlight.textContent.includes("最近一次加入失败")
          ) {
            resolve({ visible: true, explainsPasswordFailure: true });
            return;
          }
          if (Date.now() >= deadline) {
            resolve({
              visible: Boolean(highlight),
              explainsPasswordFailure:
                highlight?.textContent?.includes("房间密码错误") === true
            });
            return;
          }
          setTimeout(inspect, 50);
        };
        inspect();
      });
      return {
        connectionPanelUi,
        passwordControlUi,
        rejectedJoinMessage,
        joinFailureDiagnostic,
        joinFailureDiagnosticUi
      };
    })()`,
    true
  )) as {
    connectionPanelUi: {
      visible?: unknown;
      wideLayout?: unknown;
      twoReadableColumns?: unknown;
      descriptionFontSize?: unknown;
      inputFontSize?: unknown;
      noBottomFloatingToolbar?: unknown;
    };
    passwordControlUi: {
      visible?: unknown;
      hasTwoPasswordInputs?: unknown;
      hasCloseRoomAction?: unknown;
    };
    rejectedJoinMessage: unknown;
    joinFailureDiagnostic: unknown;
    joinFailureDiagnosticUi: {
      visible?: unknown;
      explainsPasswordFailure?: unknown;
    };
  };
  const rotatedJoinResponse =
    typeof autoLocalCreate.roomCode === "string" &&
    autoLocalCreate.target.host === "127.0.0.1" &&
    typeof autoLocalCreate.target.port === "number"
      ? await fetch(
          `http://127.0.0.1:${String(
            autoLocalCreate.target.port
          )}/api/desktop/rooms/${encodeURIComponent(autoLocalCreate.roomCode)}/join`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "X-Draw-Guess-Client": "desktop",
              "X-Draw-Guess-Protocol": String(PROTOCOL_VERSION)
            },
            body: JSON.stringify({
              roomCode: autoLocalCreate.roomCode,
              nickname: "Auto-start Smoke Host",
              password: "rotated-smoke-password"
            })
          }
        )
      : null;
  const rotatedJoinBody = rotatedJoinResponse
    ? ((await rotatedJoinResponse.json()) as {
        snapshot?: { players?: Array<{ nickname?: unknown }> };
      })
    : null;
  const rotatedNicknames =
    rotatedJoinBody?.snapshot?.players
      ?.map((player) => player.nickname)
      .filter((nickname): nickname is string => typeof nickname === "string") ?? [];
  const rotatedPassword = {
    joinStatus: rotatedJoinResponse?.status ?? null,
    taggedNicknames: rotatedNicknames,
    uniqueNicknames: new Set(rotatedNicknames).size === rotatedNicknames.length
  };
  const inGameThemePath = path.join(themeSource, "in-game-theme-switch.css");
  writeFileSync(
    inGameThemePath,
    ["/* Theme API Version: 1 */", ":root { --smoke-game-theme-switch: active; }"].join(
      "\n"
    ),
    "utf8"
  );
  await theme.importFromPath(inGameThemePath, "override");
  await windowManager.applyCustomCss(await theme.activeCss());
  windowManager.sendThemeStatus(theme.status);
  const inGameThemeSwitch = (await window.webContents.executeJavaScript(
    `(async () => {
      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline) {
        const root = document.querySelector('[data-ui="theme-root"]');
        const marker = root
          ? getComputedStyle(root)
              .getPropertyValue("--smoke-game-theme-switch")
              .trim()
          : null;
        const roomCode = document
          .querySelector('[data-ui="room-code-copy"] code')
          ?.textContent?.trim();
        const connectionState = document
          .querySelector('[data-ui="connection-status"]')
          ?.getAttribute("data-state");
        const status = await window.drawGuessDesktop.theme.status();
        if (
          marker === "active" &&
          roomCode === ${JSON.stringify(autoLocalCreate.roomCode)} &&
          connectionState === "connected" &&
          status.enabled &&
          status.applyMode === "override"
        ) {
          const bootstrap = await window.drawGuessDesktop.bootstrap();
          return {
            appliedWithoutReload: true,
            marker,
            roomCode,
            connectionState,
            serverInstanceId: bootstrap.server.serverInstanceId,
            defaultLayerPresent: Boolean(
              document.querySelector(
                'style[data-style-layer="default-desktop-template"]'
              )
            )
          };
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      return {
        appliedWithoutReload: false,
        marker: null,
        roomCode: null,
        connectionState: null,
        serverInstanceId: null,
        defaultLayerPresent: false
      };
    })()`,
    true
  )) as {
    appliedWithoutReload?: unknown;
    marker?: unknown;
    roomCode?: unknown;
    connectionState?: unknown;
    serverInstanceId?: unknown;
    defaultLayerPresent?: unknown;
  };
  const closedRoomUi = (await window.webContents.executeJavaScript(
    `(async () => {
      document.querySelector('button[aria-label="关闭诊断"]')?.click();
      document.querySelector('[data-ui="desktop-control-center-trigger"]')?.click();
      const connectionButton = await new Promise((resolve) => {
        const deadline = Date.now() + 5_000;
        const inspect = () => {
          const button = document.querySelector(
            '[data-ui="connection-management"]'
          );
          if (button || Date.now() >= deadline) {
            resolve(button);
            return;
          }
          setTimeout(inspect, 50);
        };
        inspect();
      });
      connectionButton?.click();
      const closeButton = await new Promise((resolve) => {
        const deadline = Date.now() + 5_000;
        const inspect = () => {
          const button = document.querySelector(
            '[data-ui="actual-host-close-room"]'
          );
          if (button || Date.now() >= deadline) {
            resolve(button);
            return;
          }
          setTimeout(inspect, 50);
        };
        inspect();
      });
      const previousConfirm = window.confirm;
      window.confirm = () => true;
      closeButton?.click();
      window.confirm = previousConfirm;
      const result = await new Promise((resolve) => {
        const deadline = Date.now() + 5_000;
        const inspect = async () => {
          const homeVisible = Boolean(
            document.querySelector('[data-ui="home-screen"]')
          );
          const roomCodeHidden =
            document.querySelector('[data-ui="room-code-copy"]') === null;
          if ((homeVisible && roomCodeHidden) || Date.now() >= deadline) {
            const bootstrap = await window.drawGuessDesktop.bootstrap();
            resolve({
              closeActionVisible: Boolean(closeButton),
              homeVisible,
              roomCodeHidden,
              serverStillRunning: bootstrap.server.state === "running"
            });
            return;
          }
          setTimeout(inspect, 50);
        };
        void inspect();
      });
      return result;
    })()`,
    true
  )) as {
    closeActionVisible?: unknown;
    homeVisible?: unknown;
    roomCodeHidden?: unknown;
    serverStillRunning?: unknown;
  };
  const closedRoomJoinResponse =
    typeof autoLocalCreate.roomCode === "string" &&
    autoLocalCreate.target.host === "127.0.0.1" &&
    typeof autoLocalCreate.target.port === "number"
      ? await fetch(
          `http://127.0.0.1:${String(
            autoLocalCreate.target.port
          )}/api/desktop/rooms/${encodeURIComponent(autoLocalCreate.roomCode)}/join`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "X-Draw-Guess-Client": "desktop",
              "X-Draw-Guess-Protocol": String(PROTOCOL_VERSION)
            },
            body: JSON.stringify({
              roomCode: autoLocalCreate.roomCode,
              nickname: "Closed Room Probe",
              password: "rotated-smoke-password"
            })
          }
        )
      : null;
  const closedRoom = {
    ...closedRoomUi,
    joinStatus: closedRoomJoinResponse?.status ?? null
  };
  const packagedTemplate = await theme.defaultTemplateCss();
  const templateRuntime = {
    byteLength: Buffer.byteLength(packagedTemplate, "utf8"),
    hasVersionHeader: packagedTemplate.includes("Theme API Version: 1"),
    hasReplaceHeader: packagedTemplate.includes("Apply Mode: replace"),
    hasWebHooks:
      packagedTemplate.includes('[data-ui="home-screen"]') &&
      packagedTemplate.includes('[data-ui="drawing-board"]'),
    hasDesktopHooks:
      packagedTemplate.includes('[data-ui="settings-panel"]') &&
      packagedTemplate.includes('[data-ui="theme-preview"]'),
    excludesSafetyHosts:
      !packagedTemplate.includes('[data-ui="theme-safety-host"]') &&
      !packagedTemplate.includes('[data-ui="sharing-safety"]')
  };

  const recoverableCssPath = path.join(themeSource, "recoverable-hidden-action.css");
  writeFileSync(
    recoverableCssPath,
    [
      "/* Theme API Version: 1 */",
      '[data-critical-kind="action"] { display: none !important; }'
    ].join("\n"),
    "utf8"
  );
  await theme.importFromPath(recoverableCssPath, "override");
  await windowManager.applyCustomCss(await theme.activeCss());
  windowManager.sendThemeStatus(theme.status);
  const recoverableTheme = (await window.webContents.executeJavaScript(
    `(async () => {
      const deadline = Date.now() + 8_000;
      while (Date.now() < deadline) {
        const host = document.querySelector("#drawguess-theme-safety-host");
        const shadow = host?.shadowRoot;
        const launcher = shadow?.querySelector(".launcher");
        const fallback = [...(shadow?.querySelectorAll(".fallback button") ?? [])]
          .find((button) => button.textContent?.includes("备用操作"));
        const status = await window.drawGuessDesktop.theme.status();
        if (status.enabled && fallback && launcher) {
          const bounds = launcher.getBoundingClientRect();
          const hit = shadow.elementFromPoint(
            bounds.left + bounds.width / 2,
            bounds.top + bounds.height / 2
          );
          return {
            status,
            hostOutsideThemeRoot:
              !document.querySelector('[data-ui="theme-root"]')?.contains(host),
            shadowRootAvailable: Boolean(shadow),
            launcherVisible:
              bounds.width >= 4 &&
              bounds.height >= 4 &&
              getComputedStyle(launcher).display !== "none",
            launcherClickable:
              getComputedStyle(launcher).pointerEvents !== "none" &&
              (hit === launcher || launcher.contains(hit)),
            fallbackVisible: true,
            fallbackLabel: fallback.textContent?.trim() ?? null
          };
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      return {
        status: await window.drawGuessDesktop.theme.status(),
        hostOutsideThemeRoot: false,
        shadowRootAvailable: false,
        launcherVisible: false,
        launcherClickable: false,
        fallbackVisible: false,
        fallbackLabel: null
      };
    })()`,
    true
  )) as {
    status?: { enabled?: unknown; safeMode?: unknown };
    hostOutsideThemeRoot?: unknown;
    shadowRootAvailable?: unknown;
    launcherVisible?: unknown;
    launcherClickable?: unknown;
    fallbackVisible?: unknown;
    fallbackLabel?: unknown;
  };

  const destructiveCssPath = path.join(themeSource, "destructive-theme.css");
  writeFileSync(
    destructiveCssPath,
    [
      "/* Theme API Version: 1 */",
      "* {",
      "  display: none !important;",
      "  opacity: 0 !important;",
      "  pointer-events: none !important;",
      "}"
    ].join("\n"),
    "utf8"
  );
  await theme.importFromPath(destructiveCssPath, "replace");
  await windowManager.applyCustomCss(await theme.activeCss());
  windowManager.sendThemeStatus(theme.status);
  const destructiveTheme = (await window.webContents.executeJavaScript(
    `(async () => {
      const deadline = Date.now() + 8_000;
      let suspendedStatus = null;
      let shadow = null;
      let keepDisabled = null;
      while (Date.now() < deadline) {
        const status = await window.drawGuessDesktop.theme.status();
        const host = document.querySelector("#drawguess-theme-safety-host");
        shadow = host?.shadowRoot ?? null;
        keepDisabled = [...(shadow?.querySelectorAll("button") ?? [])]
          .find((button) => button.textContent?.includes("保持禁用")) ?? null;
        const defaultLayerRestored = Boolean(
          document.querySelector(
            'style[data-style-layer="default-desktop-template"]'
          )
        );
        if (
          status.safeMode &&
          !status.enabled &&
          keepDisabled &&
          defaultLayerRestored &&
          shadow?.textContent?.includes("主题已被自动暂停")
        ) {
          suspendedStatus = status;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      const host = document.querySelector("#drawguess-theme-safety-host");
      shadow = host?.shadowRoot ?? shadow;
      keepDisabled ??= [...(shadow?.querySelectorAll("button") ?? [])]
        .find((button) => button.textContent?.includes("保持禁用")) ?? null;
      const root = document.querySelector('[data-ui="theme-root"]');
      const rootStyle = root ? getComputedStyle(root) : null;
      const beforeRestore = {
        status: suspendedStatus ?? await window.drawGuessDesktop.theme.status(),
        warningVisible:
          shadow?.textContent?.includes("主题已被自动暂停") === true,
        recoveryActionVisible: Boolean(keepDisabled),
        defaultLayerRestored: Boolean(
          document.querySelector(
            'style[data-style-layer="default-desktop-template"]'
          )
        ),
        rootVisible:
          Boolean(root) &&
          rootStyle?.display !== "none" &&
          Number.parseFloat(rootStyle?.opacity || "1") > 0.05
      };
      keepDisabled?.click();
      let restoredStatus = await window.drawGuessDesktop.theme.status();
      const restoreDeadline = Date.now() + 5_000;
      while (
        Date.now() < restoreDeadline &&
        (restoredStatus.enabled || restoredStatus.safeMode)
      ) {
        await new Promise((resolve) => setTimeout(resolve, 50));
        restoredStatus = await window.drawGuessDesktop.theme.status();
      }
      const bootstrap = await window.drawGuessDesktop.bootstrap();
      return {
        ...beforeRestore,
        restoreClicked: Boolean(keepDisabled),
        restoredStatus,
        customCssPersistentlyDisabled:
          bootstrap.settings.customCssEnabled === false,
        serverInstanceId: bootstrap.server.serverInstanceId
      };
    })()`,
    true
  )) as {
    status?: { enabled?: unknown; safeMode?: unknown };
    warningVisible?: unknown;
    recoveryActionVisible?: unknown;
    defaultLayerRestored?: unknown;
    rootVisible?: unknown;
    restoreClicked?: unknown;
    restoredStatus?: { enabled?: unknown; safeMode?: unknown };
    customCssPersistentlyDisabled?: unknown;
    serverInstanceId?: unknown;
  };
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
          connectionInfo?.protocolVersion === PROTOCOL_VERSION &&
          connectionInfo.serverInstanceId === server.serverInstanceId &&
          embedded.browserStatus === 200 &&
          embedded.browserEntryPresent &&
          embedded.desktopRoomStatus === 201 &&
          embedded.desktopSessionIssued &&
          !embedded.desktopCookieIssued &&
          networkUi.addressIsText === true &&
          networkUi.hasPort === true &&
          networkUi.hasSecurity === true &&
          networkUi.hasBindModes === true &&
          networkUi.toolbarIntegratedWithHomeActions === true &&
          networkUi.toolbarAtTop === true &&
          networkUi.toolbarInsideViewport === true &&
          networkUi.noExternalInviteBridge === true &&
          captureUi.panelOpened === true &&
          captureUi.enabledReadable === true &&
          captureUi.disabledReadable === true &&
          themeRuntime.assetLoaded &&
          themeRuntime.marker === "packaged-theme-ready" &&
          templateRuntime.byteLength > 50_000 &&
          templateRuntime.hasVersionHeader &&
          templateRuntime.hasReplaceHeader &&
          templateRuntime.hasWebHooks &&
          templateRuntime.hasDesktopHooks &&
          templateRuntime.excludesSafetyHosts &&
          recoverableTheme.status?.enabled === true &&
          recoverableTheme.status?.safeMode === false &&
          recoverableTheme.hostOutsideThemeRoot === true &&
          recoverableTheme.shadowRootAvailable === true &&
          recoverableTheme.launcherVisible === true &&
          recoverableTheme.launcherClickable === true &&
          recoverableTheme.fallbackVisible === true &&
          destructiveTheme.status?.enabled === false &&
          destructiveTheme.status?.safeMode === true &&
          destructiveTheme.warningVisible === true &&
          destructiveTheme.recoveryActionVisible === true &&
          destructiveTheme.defaultLayerRestored === true &&
          destructiveTheme.rootVisible === true &&
          destructiveTheme.restoreClicked === true &&
          destructiveTheme.restoredStatus?.enabled === false &&
          destructiveTheme.restoredStatus?.safeMode === false &&
          destructiveTheme.customCssPersistentlyDisabled === true &&
          destructiveTheme.serverInstanceId ===
            autoLocalCreate.server.serverInstanceId &&
          typeof autoLocalCreate.roomCode === "string" &&
          autoLocalCreate.target.host === "127.0.0.1" &&
          autoLocalCreate.target.port === 32_100 &&
          autoLocalCreate.target.security === "http" &&
          autoLocalCreate.server.state === "running" &&
          autoLocalCreate.server.actualPort === 32_100 &&
          autoLocalCreate.server.serverInstanceId !== server.serverInstanceId &&
          autoLocalCreate.roomCodeUi.visible === true &&
          autoLocalCreate.roomCodeUi.displayedCode === autoLocalCreate.roomCode &&
          autoLocalCreate.roomCodeUi.hasCopyButton === true &&
          autoLocalCreate.roomCodeUi.compactInTopbar === true &&
          autoLocalCreate.roomCodeUi.toolbarIntegratedInTopbar === true &&
          autoLocalCreate.roomCodeUi.largeInviteBannerAbsent === true &&
          autoLocalCreate.roomCodeUi.lobbyConnectionModuleAbsent === true &&
          autoLocalCreate.toastUi.visible === true &&
          autoLocalCreate.toastUi.explainsMinimumPlayers === true &&
          autoLocalCreate.toastUi.separatedFromToolbar === true &&
          roomClosureConfirmationUi.dialogVisible === true &&
          roomClosureConfirmationUi.reasonVisible === true &&
          roomClosureConfirmationUi.confirmationActionVisible === true &&
          roomClosureConfirmationUi.heldRoomUntilConfirmation === true &&
          roomClosureConfirmationUi.homeAfterConfirmation === true &&
          roomClosureConfirmationUi.roomCodeHiddenAfterConfirmation === true &&
          autoLocalCreate.defaultMinimizeToTray === false &&
          typeof autoLocalCreate.selfNickname === "string" &&
          /#\d{4}$/u.test(autoLocalCreate.selfNickname) &&
          hostRoomRuntime.connectionPanelUi.visible === true &&
          hostRoomRuntime.connectionPanelUi.wideLayout === true &&
          hostRoomRuntime.connectionPanelUi.twoReadableColumns === true &&
          typeof hostRoomRuntime.connectionPanelUi.descriptionFontSize === "number" &&
          hostRoomRuntime.connectionPanelUi.descriptionFontSize >= 13 &&
          typeof hostRoomRuntime.connectionPanelUi.inputFontSize === "number" &&
          hostRoomRuntime.connectionPanelUi.inputFontSize >= 14 &&
          hostRoomRuntime.connectionPanelUi.noBottomFloatingToolbar === true &&
          hostRoomRuntime.passwordControlUi.visible === true &&
          hostRoomRuntime.passwordControlUi.hasTwoPasswordInputs === true &&
          hostRoomRuntime.passwordControlUi.hasCloseRoomAction === true &&
          typeof hostRoomRuntime.rejectedJoinMessage === "string" &&
          hostRoomRuntime.rejectedJoinMessage.includes("房间密码错误") &&
          hostRoomRuntime.rejectedJoinMessage.includes("房主可能刚刚修改过密码") &&
          typeof hostRoomRuntime.joinFailureDiagnostic === "string" &&
          hostRoomRuntime.joinFailureDiagnostic.includes('"code":"UNAUTHORIZED"') &&
          hostRoomRuntime.joinFailureDiagnosticUi.visible === true &&
          hostRoomRuntime.joinFailureDiagnosticUi.explainsPasswordFailure === true &&
          rotatedPassword.joinStatus === 200 &&
          rotatedPassword.taggedNicknames.length === 2 &&
          rotatedPassword.taggedNicknames.every((nickname) =>
            /#\d{4}$/u.test(nickname)
          ) &&
          rotatedPassword.uniqueNicknames &&
          inGameThemeSwitch.appliedWithoutReload === true &&
          inGameThemeSwitch.marker === "active" &&
          inGameThemeSwitch.roomCode === autoLocalCreate.roomCode &&
          inGameThemeSwitch.connectionState === "connected" &&
          inGameThemeSwitch.serverInstanceId ===
            autoLocalCreate.server.serverInstanceId &&
          inGameThemeSwitch.defaultLayerPresent === true &&
          closedRoom.closeActionVisible === true &&
          closedRoom.homeVisible === true &&
          closedRoom.roomCodeHidden === true &&
          closedRoom.serverStillRunning === true &&
          closedRoom.joinStatus === 404 &&
          JSON.stringify(autoLocalCreate.persistedTarget) ===
            JSON.stringify(autoLocalCreate.target),
        protocolVersion: PROTOCOL_VERSION,
        renderer,
        server,
        health,
        connectionInfo,
        embedded,
        networkUi,
        captureUi,
        autoLocalCreate,
        roomClosureConfirmationUi,
        hostRoomRuntime,
        rotatedPassword,
        inGameThemeSwitch,
        closedRoom,
        theme: {
          status: theme.status,
          runtime: themeRuntime,
          assetUrl: themeAssetUrl ?? null,
          templateRuntime,
          recoverableTheme,
          destructiveTheme
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
  const logger = new RedactingLogger(path.join(app.getPath("userData"), "logs"));
  const settings = new SettingsService(app.getPath("userData"), encryptionProvider());
  await settings.initialize();
  const theme = new ThemeService(
    app.getPath("userData"),
    settings,
    logger,
    path.join(app.getAppPath(), "assets", "drawguess-theme-template.css")
  );
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
      }),
      publicEndpoint: () => settings.settings.publicEndpoint?.target ?? null
    }
  );
  const connectionPreflight = new ConnectionPreflightService(settings, logger);
  const gameClient = new GameClientService(settings, logger, connectionPreflight);
  const localRooms = new LocalRoomCoordinator(embeddedServer, settings, gameClient);
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
        windowManager.sendThemeStatus(theme.status);
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
    localRooms,
    connectionPreflight,
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
    await gameClient.leaveRoom().catch((error: unknown) => {
      logger.warn("退出程序时未能通知房间服务器", {
        message: error instanceof Error ? error.message : "未知错误"
      });
    });
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
