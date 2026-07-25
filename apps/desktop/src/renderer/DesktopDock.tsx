import type { EmbeddedServerStatus } from "../shared/ipc.js";

export type DesktopPanel = "connection" | "capture" | "settings" | "diagnostics" | null;

export function canManageConnectionPanel(
  inRoom: boolean,
  isActualHost: boolean
): boolean {
  return !inRoom || isActualHost;
}

export function visibleDesktopPanel(
  panel: DesktopPanel,
  connectionManagementAvailable: boolean
): DesktopPanel {
  return panel === "connection" && !connectionManagementAvailable ? null : panel;
}

export function DesktopDock({
  activePanel,
  captureActive,
  captureReady,
  connectionManagementAvailable,
  onToggle,
  serverState
}: {
  activePanel: DesktopPanel;
  captureActive: boolean;
  captureReady: boolean;
  connectionManagementAvailable: boolean;
  onToggle: (panel: Exclude<DesktopPanel, null>) => void;
  serverState: EmbeddedServerStatus["state"];
}) {
  return (
    <nav aria-label="桌面应用控制" className="desktop-dock" data-ui="protected-safety">
      {connectionManagementAvailable && (
        <button
          className={activePanel === "connection" ? "active" : ""}
          data-ui="connection-management"
          onClick={() => onToggle("connection")}
          type="button"
        >
          <span aria-hidden="true" className={`dock-dot dock-dot--${serverState}`} />
          联机
        </button>
      )}
      <button
        className={activePanel === "capture" ? "active" : ""}
        onClick={() => onToggle("capture")}
        type="button"
      >
        <span
          aria-hidden="true"
          className={`dock-dot ${
            captureActive ? "dock-dot--live" : captureReady ? "dock-dot--running" : ""
          }`}
        />
        采集
      </button>
      <button
        className={activePanel === "settings" ? "active" : ""}
        onClick={() => onToggle("settings")}
        type="button"
      >
        设置
      </button>
      <button
        className={activePanel === "diagnostics" ? "active" : ""}
        onClick={() => onToggle("diagnostics")}
        type="button"
      >
        诊断
      </button>
    </nav>
  );
}
