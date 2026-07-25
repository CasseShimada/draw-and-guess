import { useEffect, useMemo, useState, type FormEvent } from "react";

import { DesktopClientMessageSchema } from "@draw-guess/protocol";
import type { PublicRoomSnapshot } from "@draw-guess/shared-types";
import { App as GameApp, type DesktopGameTransport } from "@draw-guess/web/App";

import type {
  Bootstrap,
  CapturePermissionStatus,
  DesktopSettings,
  DiagnosticEntry,
  EmbeddedServerStatus,
  Invite,
  SettingsPatch,
  ThemeStatus
} from "../shared/ipc.js";
import { desktopInvitationText } from "../shared/server-url.js";
import { CaptureStudio, type CaptureSummary } from "./CaptureStudio.js";
import { desktopContentServices } from "./desktop-content-store.js";

type Panel = "connection" | "capture" | "settings" | "diagnostics" | null;

const EMPTY_CAPTURE: CaptureSummary = {
  ready: false,
  active: false,
  sourceName: null,
  error: null
};

function serverStateLabel(status: EmbeddedServerStatus): string {
  switch (status.state) {
    case "running":
      return status.allowLan ? "局域网服务运行中" : "本机服务运行中";
    case "starting":
      return "服务启动中";
    case "stopping":
      return "服务停止中";
    case "error":
      return "服务异常";
    default:
      return "内置服务未启动";
  }
}

function Onboarding({
  bootstrap,
  onComplete
}: {
  bootstrap: Bootstrap;
  onComplete: (startLocal: boolean) => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const finish = async (startLocal: boolean) => {
    setBusy(true);
    try {
      await onComplete(startLocal);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="onboarding-backdrop" data-ui="protected-safety">
      <section className="onboarding-card">
        <div className="brand brand--large">
          <span className="brand__mark" aria-hidden="true">
            画
          </span>
          <span>
            <strong>画猜现场</strong>
            <small>DESKTOP · {bootstrap.appVersion}</small>
          </span>
        </div>
        <p className="eyebrow">首次启动 · 三件事就能开场</p>
        <h1>画仍在你的绘图软件里，联机与采集都在这里。</h1>
        <div className="onboarding-steps">
          <article>
            <span>01</span>
            <strong>开房或连接</strong>
            <p>本机/局域网可直接启动内置服务；公网房间连接现有 HTTPS 服务。</p>
          </article>
          <article>
            <span>02</span>
            <strong>选择外部窗口</strong>
            <p>预览并裁切真正的画布。确认前不会上传，自己的窗口默认禁用。</p>
          </article>
          <article>
            <span>03</span>
            <strong>轮到你时上传</strong>
            <p>最多每秒一帧，只保留最新画面。托盘或快捷键可立即停止。</p>
          </article>
        </div>
        <div className="onboarding-note">
          <strong>{bootstrap.permission.message}</strong>
          <span>
            {bootstrap.secureStorageAvailable
              ? "系统安全存储可用，会话凭据会加密保存。"
              : "系统安全存储不可用，会话仅保留到本次应用退出。"}
          </span>
        </div>
        <div className="onboarding-actions">
          <button
            className="secondary-button"
            disabled={busy}
            onClick={() => void finish(false)}
            type="button"
          >
            连接远程服务器
          </button>
          <button
            className="primary-button"
            disabled={busy}
            onClick={() => void finish(true)}
            type="button"
          >
            {busy ? "正在准备…" : "启动本机服务"}
          </button>
        </div>
      </section>
    </div>
  );
}

function ConnectionPanel({
  open,
  settings,
  status,
  onClose,
  onSettings,
  onStart,
  onStop
}: {
  open: boolean;
  settings: DesktopSettings;
  status: EmbeddedServerStatus;
  onClose: () => void;
  onSettings: (patch: SettingsPatch) => Promise<void>;
  onStart: (port: number, allowLan: boolean) => Promise<void>;
  onStop: () => Promise<void>;
}) {
  const [serverUrl, setServerUrl] = useState(settings.serverUrl);
  const [port, setPort] = useState(settings.hostPort);
  const [allowLan, setAllowLan] = useState(settings.allowLan);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    setServerUrl(settings.serverUrl);
    setPort(settings.hostPort);
    setAllowLan(settings.allowLan);
  }, [settings.allowLan, settings.hostPort, settings.serverUrl]);

  const run = async (operation: () => Promise<void>) => {
    setBusy(true);
    setMessage(null);
    try {
      await operation();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "操作失败");
    } finally {
      setBusy(false);
    }
  };

  const applyRemote = (event: FormEvent) => {
    event.preventDefault();
    void run(async () => {
      await onSettings({ serverUrl });
      setMessage("服务器地址已切换，游戏客户端会重新连接。");
    });
  };

  const addresses = [...status.localUrls, ...status.lanUrls];
  return (
    <section
      aria-hidden={!open}
      className={`desktop-panel ${open ? "desktop-panel--open" : ""}`}
      data-ui="protected-safety"
    >
      <header className="desktop-panel__heading">
        <div>
          <p className="eyebrow">Connection center</p>
          <h2>联机与房主服务</h2>
        </div>
        <button aria-label="关闭联机面板" onClick={onClose} type="button">
          ×
        </button>
      </header>
      <div className="desktop-panel__content connection-grid">
        <section className="control-card">
          <span className={`service-state service-state--${status.state}`}>
            {serverStateLabel(status)}
          </span>
          <h3>本机 / 局域网房间</h3>
          <p>默认仅本机可访问。只有明确开启局域网后，服务才监听家庭或工作室网络。</p>
          <label>
            端口
            <input
              max={65535}
              min={1}
              onChange={(event) => setPort(Number(event.target.value))}
              type="number"
              value={port}
            />
          </label>
          <label className="check-row">
            <input
              checked={allowLan}
              onChange={(event) => setAllowLan(event.target.checked)}
              type="checkbox"
            />
            允许同一局域网的玩家加入
          </label>
          {status.state === "running" ? (
            <button
              className="secondary-button"
              disabled={busy}
              onClick={() => void run(onStop)}
              type="button"
            >
              停止内置服务
            </button>
          ) : (
            <button
              className="primary-button"
              disabled={busy}
              onClick={() => void run(() => onStart(port, allowLan))}
              type="button"
            >
              启动房间服务
            </button>
          )}
          {status.usedFallbackPort && (
            <p className="inline-warning">
              {status.requestedPort} 已占用，已安全切换到 {status.actualPort}。
            </p>
          )}
          {status.error && <p className="inline-error">{status.error}</p>}
          {addresses.length > 0 && (
            <div className="address-list">
              {addresses.map((address) => (
                <button
                  key={address}
                  onClick={() => void navigator.clipboard.writeText(address)}
                  title="复制地址"
                  type="button"
                >
                  <span>{address.includes("127.0.0.1") ? "本机" : "局域网"}</span>
                  <code>{address}</code>
                </button>
              ))}
            </div>
          )}
        </section>

        <form className="control-card" onSubmit={applyRemote}>
          <span className="service-state">REMOTE</span>
          <h3>远程公网服务器</h3>
          <p>
            连接已部署且可访问的中心服务器。公网地址必须使用 HTTPS/WSS；
            应用不会自动穿透 NAT、修改防火墙或开启端口映射。
          </p>
          <label>
            服务器根地址
            <input
              onChange={(event) => setServerUrl(event.target.value)}
              placeholder="https://draw.example.com"
              required
              type="url"
              value={serverUrl}
            />
          </label>
          <button className="primary-button" disabled={busy} type="submit">
            使用此服务器
          </button>
          <small>本机、私有 IPv4 与 .local 地址允许 HTTP；公开网络强制 HTTPS。</small>
        </form>
        {message && <p className="panel-message">{message}</p>}
      </div>
    </section>
  );
}

function SettingsPanel({
  open,
  bootstrap,
  settings,
  permission,
  theme,
  onClose,
  onSettings,
  onRefreshPermission,
  onReset,
  onThemeChange
}: {
  open: boolean;
  bootstrap: Bootstrap;
  settings: DesktopSettings;
  permission: CapturePermissionStatus;
  theme: ThemeStatus;
  onClose: () => void;
  onSettings: (patch: SettingsPatch) => Promise<void>;
  onRefreshPermission: () => Promise<void>;
  onReset: () => Promise<void>;
  onThemeChange: (theme: ThemeStatus) => void;
}) {
  const [shortcut, setShortcut] = useState(settings.stopSharingShortcut);
  const [message, setMessage] = useState<string | null>(null);
  const [themeBusy, setThemeBusy] = useState(false);
  useEffect(
    () => setShortcut(settings.stopSharingShortcut),
    [settings.stopSharingShortcut]
  );
  const update = async (patch: SettingsPatch) => {
    setMessage(null);
    try {
      await onSettings(patch);
      setMessage("设置已保存");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "设置保存失败");
    }
  };
  const updateTheme = async (
    operation: () => Promise<ThemeStatus>,
    successMessage: string
  ) => {
    setThemeBusy(true);
    setMessage(null);
    try {
      onThemeChange(await operation());
      setMessage(successMessage);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "自定义 CSS 操作失败");
    } finally {
      setThemeBusy(false);
    }
  };
  const chooseReplayPath = async (kind: "ffmpeg" | "output"): Promise<void> => {
    setMessage(null);
    try {
      const selected =
        kind === "ffmpeg"
          ? await window.drawGuessDesktop.settings.chooseFfmpegExecutable()
          : await window.drawGuessDesktop.settings.chooseReplayOutputDirectory();
      if (!selected) {
        return;
      }
      await onSettings(
        kind === "ffmpeg"
          ? { ffmpegExecutable: selected }
          : { replayOutputDirectory: selected }
      );
      const capability = await window.drawGuessDesktop.replay.revalidate();
      setMessage(
        capability.available
          ? `FFmpeg ${capability.ffmpegVersion} 已通过能力检查`
          : capability.message
      );
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "回放设置保存或能力检查失败");
    }
  };
  const updateReplayLimits = async (patch: SettingsPatch): Promise<void> => {
    setMessage(null);
    try {
      await onSettings(patch);
      const capability = await window.drawGuessDesktop.replay.revalidate();
      setMessage(
        capability.available ? "回放配额已保存并重新验证" : capability.message
      );
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "回放配额保存失败");
    }
  };
  return (
    <section
      aria-hidden={!open}
      className={`desktop-panel ${open ? "desktop-panel--open" : ""}`}
      data-ui="theme-recovery"
    >
      <header className="desktop-panel__heading">
        <div>
          <p className="eyebrow">Preferences</p>
          <h2>安全与体验设置</h2>
        </div>
        <button aria-label="关闭设置" onClick={onClose} type="button">
          ×
        </button>
      </header>
      <div className="desktop-panel__content settings-desktop-grid">
        <section className="control-card">
          <h3>采集质量</h3>
          <label>
            网络质量档位
            <select
              onChange={(event) =>
                void update({
                  qualityPreset: event.target.value as DesktopSettings["qualityPreset"]
                })
              }
              value={settings.qualityPreset}
            >
              <option value="data-saver">节省流量 · 960p</option>
              <option value="balanced">均衡 · 1280p</option>
              <option value="high">高清 · 1600p</option>
            </select>
          </label>
          <label>
            立即停止共享快捷键
            <input
              maxLength={64}
              onChange={(event) => setShortcut(event.target.value)}
              value={shortcut}
            />
          </label>
          <button
            className="secondary-button"
            onClick={() => void update({ stopSharingShortcut: shortcut })}
            type="button"
          >
            保存快捷键
          </button>
          <p className="muted">
            当前默认：{settings.stopSharingShortcut}。托盘菜单也始终可以立即停止。
          </p>
        </section>

        <section className="control-card">
          <h3>应用生命周期</h3>
          <label className="check-row">
            <input
              checked={settings.minimizeToTray}
              onChange={(event) =>
                void update({ minimizeToTray: event.target.checked })
              }
              type="checkbox"
            />
            关闭主窗口时最小化到托盘
          </label>
          <label className="check-row">
            <input
              checked={settings.launchAtLogin}
              onChange={(event) => void update({ launchAtLogin: event.target.checked })}
              type="checkbox"
            />
            登录系统后启动（默认关闭）
          </label>
          <label className="check-row">
            <input
              checked={
                bootstrap.systemNotificationSupported && settings.notificationsEnabled
              }
              disabled={!bootstrap.systemNotificationSupported}
              onChange={(event) =>
                void update({ notificationsEnabled: event.target.checked })
              }
              type="checkbox"
            />
            允许展示绘画收尾系统通知
          </label>
          <p className="muted">
            {bootstrap.systemNotificationSupported
              ? settings.notificationsEnabled
                ? "系统通知已启用；应用在后台时由主进程显示固定安全文案。"
                : "系统通知默认关闭；勾选后只显示固定的收尾提醒。"
              : "当前系统不支持 Electron 原生通知，网页内收尾提醒仍会显示。"}
          </p>
          <button
            className="secondary-button"
            onClick={() => void window.drawGuessDesktop.app.hideToTray()}
            type="button"
          >
            现在隐藏到托盘
          </button>
          <p className="muted">
            应用崩溃或重新启动后始终处于未共享状态，不会自动恢复屏幕采集。
          </p>
        </section>

        <section className="control-card replay-settings-card">
          <h3>接龙回放</h3>
          <p>
            FFmpeg 只由内置服务器在本机直接执行；路径不会发送给房间玩家。
            更改后会重新探测版本、编码器、目录权限与可用空间。
          </p>
          <label>
            FFmpeg 可执行文件
            <code>{settings.ffmpegExecutable ?? "使用系统 PATH 中的 ffmpeg"}</code>
          </label>
          <div className="theme-actions">
            <button
              className="secondary-button"
              onClick={() => void chooseReplayPath("ffmpeg")}
              type="button"
            >
              选择 FFmpeg…
            </button>
            {settings.ffmpegExecutable && (
              <button
                className="secondary-button"
                onClick={() =>
                  void (async () => {
                    await update({ ffmpegExecutable: null });
                    try {
                      const capability =
                        await window.drawGuessDesktop.replay.revalidate();
                      setMessage(
                        capability.available
                          ? "已改用系统 PATH 中的 FFmpeg"
                          : capability.message
                      );
                    } catch (error) {
                      setMessage(
                        error instanceof Error ? error.message : "能力检查失败"
                      );
                    }
                  })()
                }
                type="button"
              >
                改用 PATH
              </button>
            )}
          </div>
          <label>
            回放保存目录
            <code>
              {settings.replayOutputDirectory ?? "系统“视频/Draw Guess Replays”"}
            </code>
          </label>
          <div className="theme-actions">
            <button
              className="secondary-button"
              onClick={() => void chooseReplayPath("output")}
              type="button"
            >
              选择保存目录…
            </button>
            {settings.replayOutputDirectory && (
              <button
                className="secondary-button"
                onClick={() =>
                  void (async () => {
                    await update({ replayOutputDirectory: null });
                    try {
                      const capability =
                        await window.drawGuessDesktop.replay.revalidate();
                      setMessage(
                        capability.available
                          ? "已恢复系统默认视频目录"
                          : capability.message
                      );
                    } catch (error) {
                      setMessage(
                        error instanceof Error ? error.message : "能力检查失败"
                      );
                    }
                  })()
                }
                type="button"
              >
                恢复默认
              </button>
            )}
          </div>
          <div className="replay-limit-grid">
            <label>
              单局临时配额
              <select
                onChange={(event) =>
                  void updateReplayLimits({
                    replayMaxJobGiB: Number(event.target.value)
                  })
                }
                value={settings.replayMaxJobGiB}
              >
                {[1, 2, 3, 4].map((value) => (
                  <option key={value} value={value}>
                    {value} GiB
                  </option>
                ))}
              </select>
            </label>
            <label>
              总临时目录配额
              <select
                onChange={(event) =>
                  void updateReplayLimits({
                    replayMaxTemporaryGiB: Number(event.target.value)
                  })
                }
                value={settings.replayMaxTemporaryGiB}
              >
                {[1, 2, 3, 4, 6, 8, 10].map((value) => (
                  <option
                    disabled={value < settings.replayMaxJobGiB}
                    key={value}
                    value={value}
                  >
                    {value} GiB
                  </option>
                ))}
              </select>
            </label>
            <label>
              必须保留空间
              <select
                onChange={(event) =>
                  void updateReplayLimits({
                    replayMinimumFreeGiB: Number(event.target.value)
                  })
                }
                value={settings.replayMinimumFreeGiB}
              >
                <option value={1}>1 GiB</option>
                <option value={2}>2 GiB</option>
              </select>
            </label>
          </div>
          <button
            className="primary-button"
            onClick={() =>
              void window.drawGuessDesktop.replay
                .revalidate()
                .then((capability) =>
                  setMessage(
                    capability.available
                      ? `FFmpeg ${capability.ffmpegVersion} · ${capability.encoder} 可用`
                      : capability.message
                  )
                )
                .catch((error: unknown) =>
                  setMessage(error instanceof Error ? error.message : "能力检查失败")
                )
            }
            type="button"
          >
            重新检查回放能力
          </button>
        </section>

        <section className="control-card">
          <h3>屏幕权限</h3>
          <span className={`permission permission--${permission.status}`}>
            {permission.status}
          </span>
          <p>{permission.message}</p>
          {permission.restartRequired && (
            <p className="inline-warning">修改系统权限后，请完全退出并重新打开应用。</p>
          )}
          <button
            className="secondary-button"
            onClick={() => void onRefreshPermission()}
            type="button"
          >
            重新检查权限
          </button>
        </section>

        <section className="control-card theme-control-card">
          <div className="theme-control-card__heading">
            <div>
              <h3>本地自定义 CSS</h3>
              <p>只改变这台桌面客户端，不会上传或影响房间内其他玩家。</p>
            </div>
            <span
              className={`service-state ${
                theme.enabled ? "service-state--running" : ""
              }`}
            >
              {theme.safeMode
                ? "安全模式"
                : theme.enabled
                  ? "已启用"
                  : theme.installed
                    ? "已禁用"
                    : "默认主题"}
            </span>
          </div>
          {theme.installed ? (
            <dl className="theme-details">
              <div>
                <dt>文件</dt>
                <dd>{theme.fileName}</dd>
              </div>
              <div>
                <dt>内容</dt>
                <dd>
                  {(theme.cssBytes / 1024).toFixed(1)} KiB · {theme.assetCount} 个素材
                </dd>
              </div>
            </dl>
          ) : (
            <p>
              导入最大 512 KiB 的 CSS；本地图片和字体必须用相对路径引用并通过安全校验。
            </p>
          )}
          {theme.error && <p className="inline-error">{theme.error}</p>}
          <div className="theme-actions">
            <button
              className="primary-button"
              disabled={themeBusy}
              onClick={() =>
                void updateTheme(
                  () => window.drawGuessDesktop.theme.import(),
                  theme.installed
                    ? "自定义 CSS 已安全替换并启用"
                    : "自定义 CSS 已导入并启用"
                )
              }
              type="button"
            >
              {theme.installed ? "替换 CSS…" : "导入 CSS…"}
            </button>
            {theme.installed && !theme.enabled && (
              <button
                className="secondary-button"
                disabled={themeBusy}
                onClick={() =>
                  void updateTheme(
                    () => window.drawGuessDesktop.theme.enable(),
                    "自定义 CSS 已启用"
                  )
                }
                type="button"
              >
                启用
              </button>
            )}
            {theme.enabled && (
              <button
                className="secondary-button"
                disabled={themeBusy}
                onClick={() =>
                  void updateTheme(
                    () => window.drawGuessDesktop.theme.disable(),
                    "已恢复默认外观；本地主题仍保留"
                  )
                }
                type="button"
              >
                禁用并恢复默认
              </button>
            )}
            {theme.installed && (
              <button
                className="danger-button"
                disabled={themeBusy}
                onClick={() => {
                  if (window.confirm("删除这台设备上的自定义 CSS 和已复制素材？")) {
                    void updateTheme(
                      () => window.drawGuessDesktop.theme.delete(),
                      "本地主题已删除"
                    );
                  }
                }}
                type="button"
              >
                删除本地主题
              </button>
            )}
          </div>
          <small>
            若主题导致界面异常，可从系统托盘选择“禁用自定义 CSS（安全恢复）”，
            或使用安全启动参数。共享停止悬浮窗和本设置面板不受主题影响。
          </small>
        </section>

        <section className="control-card danger-card">
          <h3>本地数据</h3>
          <p>
            会清除本机设置、裁切预设、加密会话、头像、用户词库与本地主题，并断开
            当前连接。服务器本身不保存截图历史。
          </p>
          <button
            onClick={() => {
              if (
                window.confirm(
                  "确定清除本地会话、头像、用户词库、自定义 CSS 与全部设置？此操作无法撤销。"
                )
              ) {
                void onReset();
              }
            }}
            type="button"
          >
            清除全部本地数据
          </button>
          <small>
            Electron {bootstrap.appVersion} · {bootstrap.platform} ·
            {bootstrap.packaged ? " 安装包" : " 开发模式"}
          </small>
        </section>
        {message && <p className="panel-message">{message}</p>}
      </div>
    </section>
  );
}

function DiagnosticsPanel({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [entries, setEntries] = useState<DiagnosticEntry[]>([]);
  const [message, setMessage] = useState<string | null>(null);
  const refresh = async () => {
    setEntries(await window.drawGuessDesktop.diagnostics.read());
  };
  useEffect(() => {
    if (open) {
      void refresh();
    }
  }, [open]);
  return (
    <section
      aria-hidden={!open}
      className={`desktop-panel ${open ? "desktop-panel--open" : ""}`}
      data-ui="protected-safety"
    >
      <header className="desktop-panel__heading">
        <div>
          <p className="eyebrow">Diagnostics</p>
          <h2>脱敏日志与诊断</h2>
        </div>
        <button aria-label="关闭诊断" onClick={onClose} type="button">
          ×
        </button>
      </header>
      <div className="desktop-panel__content diagnostics-view">
        <div className="diagnostics-actions">
          <button
            className="secondary-button"
            onClick={() => void refresh()}
            type="button"
          >
            刷新日志
          </button>
          <button
            className="primary-button"
            onClick={() => {
              void window.drawGuessDesktop.diagnostics
                .export()
                .then((result) =>
                  setMessage(
                    result.exported
                      ? `已导出到 ${result.path ?? "所选位置"}`
                      : "已取消导出"
                  )
                );
            }}
            type="button"
          >
            导出诊断
          </button>
        </div>
        <p>
          日志不记录房间密码、完整会话 token、题目或截图内容；导出前仍建议自行检查。
        </p>
        <div className="log-list">
          {entries.length === 0 ? (
            <p>暂无日志。</p>
          ) : (
            entries.map((entry, index) => (
              <article key={`${entry.timestamp}-${String(index)}`}>
                <time>{entry.timestamp}</time>
                <strong>{entry.level.toUpperCase()}</strong>
                <span>{entry.message}</span>
              </article>
            ))
          )}
        </div>
        {message && <p className="panel-message">{message}</p>}
      </div>
    </section>
  );
}

export function DesktopApp() {
  const [bootstrap, setBootstrap] = useState<Bootstrap | null>(null);
  const [settings, setSettings] = useState<DesktopSettings | null>(null);
  const [serverStatus, setServerStatus] = useState<EmbeddedServerStatus | null>(null);
  const [permission, setPermission] = useState<CapturePermissionStatus | null>(null);
  const [theme, setTheme] = useState<ThemeStatus | null>(null);
  const [snapshot, setSnapshot] = useState<PublicRoomSnapshot | null>(null);
  const [capture, setCapture] = useState<CaptureSummary>(EMPTY_CAPTURE);
  const [panel, setPanel] = useState<Panel>(null);
  const [invite, setInvite] = useState<Invite | null>(null);
  const [fatalError, setFatalError] = useState<string | null>(null);

  useEffect(() => {
    let disposed = false;
    void window.drawGuessDesktop
      .bootstrap()
      .then((result) => {
        if (!disposed) {
          setBootstrap(result);
          setSettings(result.settings);
          setServerStatus(result.server);
          setPermission(result.permission);
          setTheme(result.theme);
        }
      })
      .catch((error: unknown) => {
        setFatalError(error instanceof Error ? error.message : "桌面应用初始化失败");
      });
    const unsubscribeServer = window.drawGuessDesktop.server.onStatus(setServerStatus);
    const unsubscribeInvite = window.drawGuessDesktop.app.onInvite((nextInvite) => {
      void window.drawGuessDesktop.settings
        .update({ serverUrl: nextInvite.serverUrl })
        .then((nextSettings) => {
          setSettings(nextSettings);
          setInvite(nextInvite);
          setPanel(null);
        })
        .catch((error: unknown) =>
          setFatalError(error instanceof Error ? error.message : "邀请链接无效")
        );
    });
    return () => {
      disposed = true;
      unsubscribeServer();
      unsubscribeInvite();
    };
  }, []);

  const transport = useMemo<DesktopGameTransport | null>(() => {
    if (!settings) {
      return null;
    }
    const serverUrl = settings.serverUrl;
    return {
      resume: () => window.drawGuessDesktop.game.resume(serverUrl),
      createRoom: (nickname, password) =>
        window.drawGuessDesktop.game.createRoom({
          serverUrl,
          nickname,
          password
        }),
      joinRoom: (roomCode, nickname, password) =>
        window.drawGuessDesktop.game.joinRoom({
          serverUrl,
          roomCode,
          nickname,
          password
        }),
      send: async (message) => {
        await window.drawGuessDesktop.game.send(
          DesktopClientMessageSchema.parse(message)
        );
      },
      uploadWordPool: (roomCode, wordPool) =>
        window.drawGuessDesktop.game.uploadWordPool(roomCode, wordPool),
      uploadReference: (roomCode, mimeType, bytes) =>
        window.drawGuessDesktop.game.uploadReference(roomCode, mimeType, bytes),
      deleteReference: (roomCode) =>
        window.drawGuessDesktop.game.deleteReference(roomCode),
      getAsset: (roomCode, path) =>
        window.drawGuessDesktop.game.getAsset(roomCode, path),
      getRelayTask: (roomCode, actorStepId) =>
        window.drawGuessDesktop.game.getRelayTask(roomCode, actorStepId),
      uploadAvatar: (roomCode, bytes) =>
        window.drawGuessDesktop.game.uploadAvatar(roomCode, bytes),
      deleteAvatar: (roomCode) => window.drawGuessDesktop.game.deleteAvatar(roomCode),
      getAvatar: (roomCode, playerId, revision) =>
        window.drawGuessDesktop.game.getAvatar(roomCode, playerId, revision),
      onEvent: (listener) =>
        window.drawGuessDesktop.game.onEvent((event) => listener(event))
    };
  }, [settings?.serverUrl]);

  const hostControls = useMemo(() => {
    if (
      !settings ||
      !serverStatus ||
      serverStatus.state !== "running" ||
      !serverStatus.localUrls.includes(settings.serverUrl)
    ) {
      return undefined;
    }
    return {
      pause: (roomCode: string) => window.drawGuessDesktop.server.pause(roomCode),
      resume: (roomCode: string) => window.drawGuessDesktop.server.resume(roomCode),
      replay: {
        retry: (roomCode: string) => window.drawGuessDesktop.replay.retry(roomCode),
        saved: (roomCode: string) => window.drawGuessDesktop.replay.saved(roomCode),
        openFile: (roomCode: string) =>
          window.drawGuessDesktop.replay.openFile(roomCode),
        openFolder: (roomCode: string) =>
          window.drawGuessDesktop.replay.openFolder(roomCode)
      }
    };
  }, [serverStatus, settings]);

  const updateSettings = async (patch: SettingsPatch) => {
    const next = await window.drawGuessDesktop.settings.update(patch);
    setSettings(next);
  };

  const startServer = async (port: number, allowLan: boolean) => {
    const status = await window.drawGuessDesktop.server.start({
      port,
      allowLan
    });
    setServerStatus(status);
    const refreshed = await window.drawGuessDesktop.bootstrap();
    setBootstrap(refreshed);
    setSettings(refreshed.settings);
    setPermission(refreshed.permission);
    setTheme(refreshed.theme);
  };

  const stopServer = async () => {
    setServerStatus(await window.drawGuessDesktop.server.stop());
    setSnapshot(null);
  };

  const finishOnboarding = async (startLocal: boolean) => {
    if (!settings) {
      return;
    }
    if (startLocal) {
      await startServer(settings.hostPort, false);
    } else {
      setPanel("connection");
    }
    await updateSettings({ onboardingComplete: true });
  };

  const resetLocalData = async () => {
    await window.drawGuessDesktop.server.stop();
    const reset = await window.drawGuessDesktop.settings.clear();
    const refreshed = await window.drawGuessDesktop.bootstrap();
    setBootstrap(refreshed);
    setSettings(reset);
    setServerStatus(refreshed.server);
    setPermission(refreshed.permission);
    setTheme(refreshed.theme);
    setSnapshot(null);
    setPanel(null);
  };

  if (fatalError) {
    return (
      <main className="desktop-fatal">
        <span className="brand__mark">画</span>
        <h1>桌面应用无法初始化</h1>
        <p>{fatalError}</p>
        <button
          className="primary-button"
          onClick={() => window.location.reload()}
          type="button"
        >
          重试
        </button>
      </main>
    );
  }
  if (!bootstrap || !settings || !serverStatus || !permission || !theme || !transport) {
    return (
      <main className="loading-screen">
        <span className="brand__mark">画</span>
        <p>正在准备桌面现场…</p>
      </main>
    );
  }

  const captureCard = (
    <section className="panel desktop-capture-card">
      <div className="panel-heading">
        <div>
          <p className="eyebrow">Desktop capture</p>
          <h2>{capture.ready ? "采集已准备" : "准备外部画布"}</h2>
        </div>
        <span className={`step-pill ${capture.active ? "step-pill--live" : ""}`}>
          {capture.active ? "正在共享" : capture.ready ? "可成为画手" : "仅猜词"}
        </span>
      </div>
      <div className="desktop-capture-card__body">
        <p>
          {capture.error ??
            (capture.sourceName
              ? `已选择：${capture.sourceName}`
              : "选择外部绘图窗口，预览并裁切后确认。未确认时不会进入画手队列。")}
        </p>
        <button
          className="secondary-button"
          onClick={() => setPanel("capture")}
          type="button"
        >
          {capture.ready ? "检查采集与裁切" : "打开采集工作室"}
        </button>
      </div>
    </section>
  );

  return (
    <div className="desktop-root">
      <div className="theme-root" data-ui="theme-root">
        <GameApp
          contentServices={desktopContentServices}
          hostControls={hostControls}
          initialRoomCode={invite?.roomCode}
          invitationText={(roomCode) => {
            const invitationServer =
              serverStatus.state === "running"
                ? serverStatus.allowLan
                  ? (serverStatus.lanUrls[0] ??
                    serverStatus.localUrls[0] ??
                    settings.serverUrl)
                  : (serverStatus.localUrls[0] ?? settings.serverUrl)
                : settings.serverUrl;
            return desktopInvitationText(invitationServer, roomCode);
          }}
          key={`${settings.serverUrl}|${invite?.roomCode ?? ""}`}
          lobbyAddon={captureCard}
          notificationsEnabled={settings.notificationsEnabled}
          onSnapshot={setSnapshot}
          transport={transport}
        />
      </div>

      <nav
        aria-label="桌面应用控制"
        className="desktop-dock"
        data-ui="protected-safety"
      >
        <button
          className={panel === "connection" ? "active" : ""}
          onClick={() =>
            setPanel((current) => (current === "connection" ? null : "connection"))
          }
          type="button"
        >
          <span className={`dock-dot dock-dot--${serverStatus.state}`} />
          联机
        </button>
        <button
          className={panel === "capture" ? "active" : ""}
          onClick={() =>
            setPanel((current) => (current === "capture" ? null : "capture"))
          }
          type="button"
        >
          <span
            className={`dock-dot ${
              capture.active
                ? "dock-dot--live"
                : capture.ready
                  ? "dock-dot--running"
                  : ""
            }`}
          />
          采集
        </button>
        <button
          className={panel === "settings" ? "active" : ""}
          onClick={() =>
            setPanel((current) => (current === "settings" ? null : "settings"))
          }
          type="button"
        >
          设置
        </button>
        <button
          className={panel === "diagnostics" ? "active" : ""}
          onClick={() =>
            setPanel((current) => (current === "diagnostics" ? null : "diagnostics"))
          }
          type="button"
        >
          诊断
        </button>
      </nav>

      {panel && panel !== "capture" && (
        <button
          aria-label="关闭桌面控制面板"
          className="desktop-panel-backdrop"
          data-ui="protected-safety"
          onClick={() => setPanel(null)}
          type="button"
        />
      )}
      <ConnectionPanel
        onClose={() => setPanel(null)}
        onSettings={updateSettings}
        onStart={startServer}
        onStop={stopServer}
        open={panel === "connection"}
        settings={settings}
        status={serverStatus}
      />
      <CaptureStudio
        onClose={() => setPanel(null)}
        onSettingsChange={setSettings}
        onSummary={setCapture}
        open={panel === "capture"}
        settings={settings}
        snapshot={snapshot}
      />
      <SettingsPanel
        bootstrap={bootstrap}
        onClose={() => setPanel(null)}
        onRefreshPermission={async () => {
          setPermission(await window.drawGuessDesktop.capture.permission());
        }}
        onReset={resetLocalData}
        onSettings={updateSettings}
        onThemeChange={setTheme}
        open={panel === "settings"}
        permission={permission}
        settings={settings}
        theme={theme}
      />
      <DiagnosticsPanel onClose={() => setPanel(null)} open={panel === "diagnostics"} />

      {!settings.onboardingComplete && (
        <Onboarding bootstrap={bootstrap} onComplete={finishOnboarding} />
      )}
    </div>
  );
}
