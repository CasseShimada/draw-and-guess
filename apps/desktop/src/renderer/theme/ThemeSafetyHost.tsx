import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import type { ThemeStatus } from "../../shared/ipc.js";
import {
  inspectThemeHealth,
  themeHealthReason,
  type ThemeHealthReport
} from "./theme-health.js";

const HEALTHY_REPORT: ThemeHealthReport = {
  healthy: true,
  requiresThemeSuspension: false,
  failures: []
};

const SAFETY_CSS = `
  :host {
    all: initial;
    position: fixed;
    z-index: 2147483647;
    right: 12px;
    bottom: 12px;
    display: block;
    color: #171714;
    font: 13px/1.45 "Microsoft YaHei", "PingFang SC", system-ui, sans-serif;
    pointer-events: none;
  }
  *, *::before, *::after { box-sizing: border-box; }
  button { font: inherit; }
  .launcher, .panel { pointer-events: auto; }
  .launcher {
    min-width: 46px;
    min-height: 42px;
    padding: 8px 11px;
    border: 2px solid #171714;
    border-radius: 6px;
    background: #fff9eb;
    color: #171714;
    box-shadow: 3px 3px 0 #171714;
    cursor: pointer;
    font-weight: 900;
  }
  .launcher[data-alert="true"] { background: #ffd866; }
  .panel {
    width: min(390px, calc(100vw - 24px));
    max-height: min(620px, calc(100vh - 80px));
    margin-bottom: 10px;
    overflow: auto;
    border: 2px solid #171714;
    border-radius: 7px;
    background: #fffdf7;
    box-shadow: 5px 5px 0 #171714;
  }
  header {
    display: flex;
    padding: 12px;
    align-items: center;
    justify-content: space-between;
    border-bottom: 1px solid #171714;
    gap: 10px;
  }
  h2, p { margin: 0; }
  h2 { font-size: 16px; }
  header button {
    width: 32px;
    height: 32px;
    border: 1px solid #171714;
    background: white;
    cursor: pointer;
  }
  .body { display: grid; padding: 12px; gap: 10px; }
  .status, .warning, .error {
    padding: 9px;
    border: 1px solid #171714;
  }
  .status { background: #e1f1eb; }
  .warning { background: #fff0b8; }
  .error { background: #f9d7d0; color: #721f17; }
  .actions { display: grid; grid-template-columns: 1fr 1fr; gap: 7px; }
  .actions button, .fallback button {
    min-height: 38px;
    padding: 7px 9px;
    border: 1px solid #171714;
    background: white;
    color: #171714;
    cursor: pointer;
    font-weight: 800;
  }
  .actions .primary { background: #f15b47; color: white; }
  .actions .danger { border-color: #a52f24; color: #8a241c; }
  .fallback { display: grid; gap: 6px; }
  .fallback strong { font-size: 12px; }
  small { color: #5d5952; }
  button:focus-visible { outline: 3px solid #167d78; outline-offset: 2px; }
  @media (max-width: 420px) {
    :host { right: 6px; bottom: 6px; }
    .actions { grid-template-columns: 1fr; }
  }
`;

function useShadowHost() {
  const [container, setContainer] = useState<ShadowRoot | null>(null);
  useEffect(() => {
    const host = document.createElement("div");
    host.id = "drawguess-theme-safety-host";
    host.setAttribute("data-theme-safety-host", "true");
    const shadow = host.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.textContent = SAFETY_CSS;
    shadow.append(style);
    document.body.append(host);
    setContainer(shadow);
    return () => {
      setContainer(null);
      host.remove();
    };
  }, []);
  return container;
}

export function ThemeSafetyHost({
  captureActive,
  onDisable,
  onOpenSettings,
  onReload,
  onRetry,
  onStopSharing,
  onSuspend,
  theme,
  themeRoot
}: {
  captureActive: boolean;
  onDisable: () => Promise<void>;
  onOpenSettings: () => void;
  onReload: () => Promise<void>;
  onRetry: () => Promise<void>;
  onStopSharing: () => Promise<void>;
  onSuspend: (reason: string) => Promise<void>;
  theme: ThemeStatus;
  themeRoot: HTMLElement | null;
}) {
  const shadow = useShadowHost();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [operationError, setOperationError] = useState<string | null>(null);
  const [report, setReport] = useState(HEALTHY_REPORT);
  const suspendingRef = useRef(false);

  useEffect(() => {
    if (!theme.enabled || !themeRoot) {
      setReport(HEALTHY_REPORT);
      return;
    }
    let disposed = false;
    let timeout: number | null = null;
    let frameOne: number | null = null;
    let frameTwo: number | null = null;
    let interval: number | null = null;
    const inspect = () => {
      timeout = window.setTimeout(() => {
        frameOne = window.requestAnimationFrame(() => {
          frameTwo = window.requestAnimationFrame(() => {
            if (disposed) {
              return;
            }
            const next = inspectThemeHealth(themeRoot);
            setReport(next);
            if (next.requiresThemeSuspension && !suspendingRef.current) {
              suspendingRef.current = true;
              setOpen(true);
              void onSuspend(themeHealthReason(next)).finally(() => {
                suspendingRef.current = false;
              });
            }
          });
        });
      }, 140);
    };
    const schedule = () => {
      if (timeout !== null) {
        window.clearTimeout(timeout);
      }
      if (frameOne !== null) {
        window.cancelAnimationFrame(frameOne);
      }
      if (frameTwo !== null) {
        window.cancelAnimationFrame(frameTwo);
      }
      inspect();
    };
    const mutation = new MutationObserver(schedule);
    mutation.observe(themeRoot, {
      attributes: true,
      childList: true,
      subtree: true,
      attributeFilter: [
        "class",
        "style",
        "hidden",
        "disabled",
        "data-state",
        "data-screen",
        "data-mode",
        "data-phase",
        "data-role"
      ]
    });
    const resize = new ResizeObserver(schedule);
    resize.observe(themeRoot);
    for (const region of themeRoot.querySelectorAll<HTMLElement>(
      "[data-critical-ui]"
    )) {
      resize.observe(region);
    }
    window.addEventListener("resize", schedule);
    interval = window.setInterval(schedule, 1_000);
    schedule();
    return () => {
      disposed = true;
      mutation.disconnect();
      resize.disconnect();
      window.removeEventListener("resize", schedule);
      if (interval !== null) {
        window.clearInterval(interval);
      }
      if (timeout !== null) {
        window.clearTimeout(timeout);
      }
      if (frameOne !== null) {
        window.cancelAnimationFrame(frameOne);
      }
      if (frameTwo !== null) {
        window.cancelAnimationFrame(frameTwo);
      }
    };
  }, [onSuspend, theme.applyMode, theme.enabled, theme.importedAt, themeRoot]);

  useEffect(() => {
    if (theme.safeMode || theme.error || !report.healthy) {
      setOpen(true);
    }
  }, [report.healthy, theme.error, theme.safeMode]);

  if (!shadow) {
    return null;
  }

  const run = async (operation: () => Promise<void>) => {
    setBusy(true);
    setOperationError(null);
    try {
      await operation();
    } catch (error) {
      setOperationError(
        error instanceof Error ? error.message : "主题安全操作执行失败"
      );
    } finally {
      setBusy(false);
    }
  };
  const hasAlert = theme.safeMode || Boolean(theme.error) || !report.healthy;

  return createPortal(
    <>
      {open && (
        <section
          aria-label="主题安全恢复"
          aria-live="polite"
          className="panel"
          role="dialog"
        >
          <header>
            <h2>主题安全中心</h2>
            <button
              aria-label="折叠主题安全中心"
              onClick={() => setOpen(false)}
              type="button"
            >
              ×
            </button>
          </header>
          <div className="body">
            <p className="status">
              {theme.enabled
                ? `${theme.applyMode === "replace" ? "完整替换" : "覆盖"}主题正在运行`
                : theme.installed
                  ? "当前使用默认模板；自定义主题仍保留"
                  : "当前使用默认模板"}
            </p>
            {theme.safeMode && (
              <p className="warning">主题已被自动暂停，不会改变房间或游戏状态。</p>
            )}
            {theme.error && <p className="error">{theme.error}</p>}
            {operationError && <p className="error">{operationError}</p>}
            {report.failures.length > 0 && (
              <div className="fallback">
                <strong>检测到不可用控件</strong>
                {report.failures.slice(0, 6).map((failure) =>
                  failure.invoke ? (
                    <button key={failure.id} onClick={failure.invoke} type="button">
                      备用操作：{failure.label}
                    </button>
                  ) : (
                    <small key={failure.id}>
                      {failure.label}：{failure.reason}
                    </small>
                  )
                )}
              </div>
            )}
            <div className="actions">
              <button onClick={onOpenSettings} type="button">
                打开主题设置
              </button>
              {theme.installed && (
                <button
                  disabled={busy}
                  onClick={() => void run(onReload)}
                  type="button"
                >
                  重新载入 CSS
                </button>
              )}
              {(theme.enabled || theme.safeMode) && theme.installed && (
                <>
                  {theme.enabled && (
                    <button
                      disabled={busy}
                      onClick={() =>
                        void run(() =>
                          onSuspend("用户已从主题安全中心临时暂停自定义 CSS")
                        )
                      }
                      type="button"
                    >
                      临时禁用
                    </button>
                  )}
                  <button
                    className="danger"
                    disabled={busy}
                    onClick={() => void run(onDisable)}
                    type="button"
                  >
                    {theme.safeMode ? "保持禁用并恢复默认" : "恢复默认主题"}
                  </button>
                </>
              )}
              {theme.installed && !theme.enabled && (
                <button
                  className="primary"
                  disabled={busy}
                  onClick={() => void run(onRetry)}
                  type="button"
                >
                  再次尝试启用
                </button>
              )}
              {captureActive && (
                <button
                  className="danger"
                  disabled={busy}
                  onClick={() => void run(onStopSharing)}
                  type="button"
                >
                  立即停止屏幕共享
                </button>
              )}
            </div>
            <small>
              此面板位于 Shadow DOM 安全层中，本地主题无法隐藏、透明化或阻止点击。
            </small>
          </div>
        </section>
      )}
      {hasAlert && (
        <button
          aria-expanded={open}
          className="launcher"
          data-alert="true"
          onClick={() => setOpen((current) => !current)}
          type="button"
        >
          主题修复
        </button>
      )}
    </>,
    shadow
  );
}
