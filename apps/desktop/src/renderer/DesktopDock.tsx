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
  onOpen,
  serverState
}: {
  activePanel: DesktopPanel;
  captureActive: boolean;
  captureReady: boolean;
  connectionManagementAvailable: boolean;
  onOpen: () => void;
  serverState: EmbeddedServerStatus["state"];
}) {
  return (
    <div className="desktop-toolbar" data-ui="desktop-toolbar">
      <button
        aria-expanded={activePanel !== null}
        aria-label="打开桌面控制中心"
        className={activePanel ? "active" : ""}
        data-ui="desktop-control-center-trigger"
        onClick={onOpen}
        type="button"
      >
        <span className="desktop-toolbar__status" aria-hidden="true">
          {connectionManagementAvailable && (
            <span className={`dock-dot dock-dot--${serverState}`} />
          )}
          <span
            className={`dock-dot ${
              captureActive ? "dock-dot--live" : captureReady ? "dock-dot--running" : ""
            }`}
          />
        </span>
        控制中心
      </button>
    </div>
  );
}

export function DesktopControlCenterNav({
  activePanel,
  captureActive,
  captureReady,
  connectionManagementAvailable,
  onSelect,
  serverState
}: {
  activePanel: Exclude<DesktopPanel, null>;
  captureActive: boolean;
  captureReady: boolean;
  connectionManagementAvailable: boolean;
  onSelect: (panel: Exclude<DesktopPanel, null>) => void;
  serverState: EmbeddedServerStatus["state"];
}) {
  return (
    <nav
      aria-label="桌面控制中心分区"
      className="desktop-control-center__nav"
      data-ui="desktop-control-center-nav"
    >
      <div className="desktop-control-center__brand">
        <span aria-hidden="true">画</span>
        <div>
          <strong>控制中心</strong>
          <small>DESKTOP TOOLS</small>
        </div>
      </div>
      <div className="desktop-control-center__tabs" role="tablist">
        {connectionManagementAvailable && (
          <button
            aria-selected={activePanel === "connection"}
            className={activePanel === "connection" ? "active" : ""}
            data-ui="connection-management"
            onClick={() => onSelect("connection")}
            role="tab"
            type="button"
          >
            <span aria-hidden="true" className={`dock-dot dock-dot--${serverState}`} />
            <span>
              <strong>联机</strong>
              <small>服务与连接地址</small>
            </span>
          </button>
        )}
        <button
          aria-selected={activePanel === "capture"}
          className={activePanel === "capture" ? "active" : ""}
          onClick={() => onSelect("capture")}
          role="tab"
          type="button"
        >
          <span
            aria-hidden="true"
            className={`dock-dot ${
              captureActive ? "dock-dot--live" : captureReady ? "dock-dot--running" : ""
            }`}
          />
          <span>
            <strong>采集</strong>
            <small>{captureActive ? "正在共享" : "来源与裁切"}</small>
          </span>
        </button>
        <button
          aria-selected={activePanel === "settings"}
          className={activePanel === "settings" ? "active" : ""}
          onClick={() => onSelect("settings")}
          role="tab"
          type="button"
        >
          <span aria-hidden="true" className="control-center-icon">
            ◇
          </span>
          <span>
            <strong>偏好设置</strong>
            <small>体验、主题与回放</small>
          </span>
        </button>
        <button
          aria-selected={activePanel === "diagnostics"}
          className={activePanel === "diagnostics" ? "active" : ""}
          onClick={() => onSelect("diagnostics")}
          role="tab"
          type="button"
        >
          <span aria-hidden="true" className="control-center-icon">
            ···
          </span>
          <span>
            <strong>诊断</strong>
            <small>状态检查与日志</small>
          </span>
        </button>
      </div>
      <p className="desktop-control-center__note">
        关闭控制中心后，游戏界面会恢复为专注视图。
      </p>
    </nav>
  );
}

export function CaptureStatusCard({
  active,
  error,
  onOpen,
  ready,
  sourceName
}: {
  active: boolean;
  error: string | null;
  onOpen: () => void;
  ready: boolean;
  sourceName: string | null;
}) {
  return (
    <section className="panel desktop-capture-card" data-ui="capture-status-card">
      <div className="panel-heading">
        <div>
          <p className="eyebrow">Capture status</p>
          <h2>{ready ? "画布采集已准备" : "画布采集未准备"}</h2>
        </div>
        <span className={`step-pill ${active ? "step-pill--live" : ""}`}>
          {active ? "正在共享" : ready ? "可以绘画" : "仅可猜词"}
        </span>
      </div>
      <div className="desktop-capture-card__body">
        <p>
          {error ??
            (sourceName
              ? `来源：${sourceName}`
              : "选择外部绘图窗口并确认裁切后，才会进入画手队列。")}
        </p>
        <button
          className="secondary-button"
          data-action="open-capture-control-center"
          onClick={onOpen}
          type="button"
        >
          {ready ? "检查采集" : "设置采集"}
        </button>
      </div>
    </section>
  );
}
