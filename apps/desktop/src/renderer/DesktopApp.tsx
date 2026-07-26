import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";

import { DesktopClientMessageSchema } from "@draw-guess/protocol";
import type { PublicRoomSnapshot } from "@draw-guess/shared-types";
import { App as GameApp, type DesktopGameTransport } from "@draw-guess/web/App";

import type {
  Bootstrap,
  CapturePermissionStatus,
  DesktopSettings,
  DiagnosticEntry,
  EmbeddedServerStatus,
  SettingsPatch,
  ThemeStatus
} from "../shared/ipc.js";
import {
  connectionHostKind,
  normalizeConnectionTarget,
  parseConnectionTargetInput,
  type ConnectionTarget,
  type TransportSecurity
} from "../shared/server-url.js";
import { CaptureStudio, type CaptureSummary } from "./CaptureStudio.js";
import {
  ConnectionTargetEditor,
  draftFromTarget,
  targetFromDraft,
  type ConnectionTargetDraft
} from "./ConnectionTargetEditor.js";
import {
  CaptureStatusCard,
  DesktopControlCenterNav,
  DesktopDock,
  canManageConnectionPanel,
  visibleDesktopPanel,
  type DesktopPanel
} from "./DesktopDock.js";
import { desktopContentServices } from "./desktop-content-store.js";
import { DefaultDesktopThemeStyle } from "./theme/DesktopThemeStyle.js";
import { ThemeSafetyHost } from "./theme/ThemeSafetyHost.js";
import { ThemePreview } from "./theme/ThemePreview.js";

const EMPTY_CAPTURE: CaptureSummary = {
  ready: false,
  active: false,
  sourceName: null,
  error: null
};

function serverStateLabel(status: EmbeddedServerStatus): string {
  switch (status.state) {
    case "running":
      return status.bindMode === "lan" ? "局域网服务运行中" : "本机服务运行中";
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
    <div className="onboarding-backdrop" data-ui="onboarding">
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
  onStop,
  onRefreshNetworks,
  roomCode,
  onChangeRoomPassword,
  onCloseRoom,
  platform
}: {
  open: boolean;
  settings: DesktopSettings;
  status: EmbeddedServerStatus;
  onClose: () => void;
  onSettings: (patch: SettingsPatch) => Promise<void>;
  onStart: (
    port: number,
    bindMode: DesktopSettings["hostBindMode"],
    restart: boolean
  ) => Promise<void>;
  onStop: () => Promise<void>;
  onRefreshNetworks: () => Promise<void>;
  roomCode: string | null;
  onChangeRoomPassword: (roomCode: string, password: string) => Promise<void>;
  onCloseRoom: (roomCode: string) => Promise<void>;
  platform: Bootstrap["platform"];
}) {
  const [port, setPort] = useState(settings.hostPort);
  const [bindMode, setBindMode] = useState(settings.hostBindMode);
  const [publicHost, setPublicHost] = useState(
    settings.publicEndpoint?.target.host ?? ""
  );
  const [publicPort, setPublicPort] = useState(
    settings.publicEndpoint?.target.port ?? 443
  );
  const [publicSecurity, setPublicSecurity] = useState<TransportSecurity>(
    settings.publicEndpoint?.target.security ?? "https"
  );
  const [publicLabel, setPublicLabel] = useState(settings.publicEndpoint?.label ?? "");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [newRoomPassword, setNewRoomPassword] = useState("");
  const [confirmRoomPassword, setConfirmRoomPassword] = useState("");

  useEffect(() => {
    setPort(settings.hostPort);
    setBindMode(settings.hostBindMode);
    setPublicHost(settings.publicEndpoint?.target.host ?? "");
    setPublicPort(settings.publicEndpoint?.target.port ?? 443);
    setPublicSecurity(settings.publicEndpoint?.target.security ?? "https");
    setPublicLabel(settings.publicEndpoint?.label ?? "");
  }, [settings.hostBindMode, settings.hostPort, settings.publicEndpoint]);

  useEffect(() => {
    setNewRoomPassword("");
    setConfirmRoomPassword("");
  }, [roomCode]);

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

  const savePublicEndpoint = (event: FormEvent) => {
    event.preventDefault();
    void run(async () => {
      if (!publicHost) {
        await onSettings({ publicEndpoint: null });
        setMessage("已清除公网分享信息；游戏服务没有重启。");
        return;
      }
      const normalized = parseConnectionTargetInput({
        address: publicHost,
        port: publicPort,
        security: publicSecurity
      });
      if (connectionHostKind(normalized.host) !== "public") {
        throw new Error("公网分享信息必须填写 SakuraFrp 提供的公网主机名或公网 IP");
      }
      await onSettings({
        publicEndpoint: {
          target: {
            host: normalized.host,
            port: normalized.port,
            security: normalized.security
          },
          label: publicLabel.trim() || null
        }
      });
      setPublicHost(normalized.host);
      setPublicPort(normalized.port);
      setPublicSecurity(normalized.security);
      setMessage("公网分享信息已保存；本地监听服务无需重启。");
    });
  };

  const changeRoomPassword = (event: FormEvent) => {
    event.preventDefault();
    void run(async () => {
      if (!roomCode) {
        throw new Error("当前没有由本机托管的房间");
      }
      if (newRoomPassword !== confirmRoomPassword) {
        throw new Error("两次输入的新密码不一致");
      }
      await onChangeRoomPassword(roomCode, newRoomPassword);
      setNewRoomPassword("");
      setConfirmRoomPassword("");
      setMessage("房间密码已更新；已在房间内的玩家不会被断开。");
    });
  };

  const runningDraftChanged =
    status.state === "running" &&
    (status.requestedPort !== port || status.bindMode !== bindMode);
  return (
    <section
      aria-hidden={!open}
      className={`desktop-panel connection-panel ${open ? "desktop-panel--open" : ""}`}
      data-ui="connection-panel"
      hidden={!open}
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
        <section className="control-card connection-card connection-card--local">
          <span className={`service-state service-state--${status.state}`}>
            {serverStateLabel(status)}
          </span>
          <h3>本机 / 局域网房间</h3>
          <p>
            启动前选择固定端口和真实绑定模式。运行状态只以主进程返回的监听信息为准。
          </p>
          <label>
            固定 TCP 端口
            <input
              max={65535}
              min={1}
              onChange={(event) => setPort(Number(event.target.value))}
              type="number"
              value={port}
            />
          </label>
          <label>
            绑定模式
            <select
              onChange={(event) =>
                setBindMode(event.target.value as DesktopSettings["hostBindMode"])
              }
              value={bindMode}
            >
              <option value="loopback-only">仅本机 · 127.0.0.1</option>
              <option value="lan">局域网 / 可做端口转发 · 0.0.0.0</option>
            </select>
          </label>
          {status.state === "running" && runningDraftChanged ? (
            <button
              className="danger-button"
              disabled={busy}
              onClick={() => {
                if (
                  window.confirm(
                    "重启房间服务会结束当前房间并断开全部玩家。确定应用新的端口或绑定模式吗？"
                  )
                ) {
                  void run(() => onStart(port, bindMode, true));
                }
              }}
              type="button"
            >
              重启服务以应用更改
            </button>
          ) : status.state === "running" ? (
            <button
              className="secondary-button"
              disabled={busy}
              onClick={() => {
                if (
                  window.confirm(
                    "停止房间服务会结束当前房间并断开全部玩家。确定停止吗？"
                  )
                ) {
                  void run(onStop);
                }
              }}
              type="button"
            >
              停止内置服务
            </button>
          ) : (
            <button
              className="primary-button"
              disabled={busy}
              onClick={() => void run(() => onStart(port, bindMode, false))}
              type="button"
            >
              启动房间服务
            </button>
          )}
          {status.error && <p className="inline-error">{status.error}</p>}
          {status.state === "running" && (
            <dl className="network-authority-status">
              <div>
                <dt>实际监听</dt>
                <dd>
                  {status.boundHost}:{status.actualPort}
                </dd>
              </div>
              <div>
                <dt>本机入口</dt>
                <dd>{status.loopbackOrigin}</dd>
              </div>
              <div>
                <dt>服务实例</dt>
                <dd>{status.serverInstanceId?.slice(0, 12)}…</dd>
              </div>
            </dl>
          )}
          {status.bindMode === "lan" && (
            <div className="lan-interface-list">
              <div>
                <strong>检测到的 IPv4 网卡</strong>
                <button onClick={() => void run(onRefreshNetworks)} type="button">
                  重新枚举
                </button>
              </div>
              {status.lanAddresses.length === 0 ? (
                <p>服务已监听，但没有发现可分享的局域网 IPv4。</p>
              ) : (
                status.lanAddresses.map((address) => (
                  <div key={address.id}>
                    <strong>{address.interfaceName}</strong>
                    <code>{address.cidr ?? address.address}</code>
                    <span>
                      {address.kind === "private"
                        ? "私有网络 · 推荐"
                        : address.kind === "link-local"
                          ? "链路本地 · 通常不推荐"
                          : "虚拟 / VPN / 其它 · 请确认"}
                    </span>
                  </div>
                ))
              )}
            </div>
          )}
          {status.bindMode === "lan" && (
            <div className="firewall-help">
              <strong>
                {platform === "win32"
                  ? "Windows Defender 防火墙仍可能阻止其它设备"
                  : "系统防火墙和网络策略仍可能阻止其它设备"}
              </strong>
              <p>
                {platform === "win32"
                  ? "首次询问时建议只允许“专用网络”。应用不会静默提权或创建全局规则。"
                  : platform === "darwin"
                    ? "请在 macOS“网络/防火墙”设置中允许本应用接收入站连接；应用无法绕过企业策略。"
                    : "请在发行版防火墙中允许当前 TCP 端口；访客 Wi-Fi 或企业策略仍可能隔离设备。"}
              </p>
              <code>
                {status.executablePath ?? "应用可执行文件"} · TCP{" "}
                {status.actualPort ?? port} · {status.boundHost ?? "尚未监听"}
              </code>
              {platform === "win32" && (
                <button
                  className="secondary-button"
                  onClick={() =>
                    void window.drawGuessDesktop.app.openFirewallSettings()
                  }
                  type="button"
                >
                  打开防火墙设置 / 查看帮助
                </button>
              )}
            </div>
          )}
        </section>

        <form
          className="control-card connection-card connection-card--public"
          onSubmit={savePublicEndpoint}
        >
          <span className="service-state">可选 · 端口转发</span>
          <h3>公网分享信息（可选）</h3>
          <p>
            SakuraFrp 或其它隧道把一个公网入口转发到本机同一个游戏端口。
            应用只保存展示信息，不下载、登录或管理隧道客户端。
          </p>
          <label>
            外部主机名或 IP
            <input
              onChange={(event) => setPublicHost(event.target.value)}
              placeholder="example.sakurafrp.example"
              type="text"
              value={publicHost}
            />
          </label>
          <label>
            外部端口
            <input
              max={65_535}
              min={1}
              onChange={(event) => setPublicPort(Number(event.target.value))}
              type="number"
              value={publicPort}
            />
          </label>
          <label>
            外部安全性
            <select
              onChange={(event) =>
                setPublicSecurity(event.target.value as TransportSecurity)
              }
              value={publicSecurity}
            >
              <option value="https">HTTPS / WSS</option>
              <option value="http">HTTP / WS（原始 TCP，未加密）</option>
            </select>
          </label>
          <label>
            显示名称（可选）
            <input
              maxLength={80}
              onChange={(event) => setPublicLabel(event.target.value)}
              placeholder="例如：SakuraFrp 上海节点"
              value={publicLabel}
            />
          </label>
          {publicSecurity === "http" && (
            <p className="inline-warning">
              原始公网 HTTP/WS 没有传输加密；玩家首次连接会被要求明确确认风险。
            </p>
          )}
          <p className="muted">
            本地映射目标：
            <code>127.0.0.1:{status.actualPort ?? settings.hostPort}</code>
            。外部端口与本地端口可以不同。
          </p>
          <div className="theme-actions">
            <button className="primary-button" disabled={busy} type="submit">
              保存公网分享信息
            </button>
            {settings.publicEndpoint && (
              <button
                className="secondary-button"
                disabled={busy}
                onClick={() => {
                  setPublicHost("");
                  void run(async () => {
                    await onSettings({ publicEndpoint: null });
                    setMessage("已清除公网分享信息。");
                  });
                }}
                type="button"
              >
                清除
              </button>
            )}
          </div>
          <small>不保存 SakuraFrp token、隧道 ID、路由器凭据、房间密码或会话。</small>
        </form>
        {roomCode && (
          <form
            className="control-card connection-card room-password-card"
            data-ui="actual-host-room-password"
            onSubmit={changeRoomPassword}
          >
            <span className="service-state service-state--running">
              房间 {roomCode}
            </span>
            <h3>修改当前房间密码</h3>
            <p>
              这里只能设置新密码，不会显示旧密码。修改后，新加入的玩家必须使用新密码；
              已连接玩家保持在线。
            </p>
            <label>
              新密码
              <input
                autoComplete="new-password"
                maxLength={128}
                minLength={4}
                onChange={(event) => setNewRoomPassword(event.target.value)}
                placeholder="4–128 个字符"
                required
                type="password"
                value={newRoomPassword}
              />
            </label>
            <label>
              再输入一次
              <input
                autoComplete="new-password"
                maxLength={128}
                minLength={4}
                onChange={(event) => setConfirmRoomPassword(event.target.value)}
                required
                type="password"
                value={confirmRoomPassword}
              />
            </label>
            <button className="primary-button" disabled={busy} type="submit">
              {busy ? "正在更新…" : "更新房间密码"}
            </button>
            <small>密码仅在主机内存中以摘要保存，不会写入桌面设置或诊断日志。</small>
            <div className="room-close-zone">
              <div>
                <strong>结束当前房间</strong>
                <p>全部玩家会收到关闭原因并返回主界面；内置服务保持运行。</p>
              </div>
              <button
                className="danger-button"
                data-ui="actual-host-close-room"
                disabled={busy}
                onClick={() => {
                  if (
                    window.confirm(
                      `确定关闭房间 ${roomCode} 吗？全部玩家都会断开并返回主界面。`
                    )
                  ) {
                    void run(() => onCloseRoom(roomCode));
                  }
                }}
                type="button"
              >
                {busy ? "正在关闭…" : "关闭房间并返回主界面"}
              </button>
            </div>
          </form>
        )}
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
      try {
        onThemeChange(await window.drawGuessDesktop.theme.status());
      } catch {
        // The original, user-facing operation error remains authoritative.
      }
    } finally {
      setThemeBusy(false);
    }
  };
  const runThemeUtility = async (
    operation: () => Promise<boolean | void>,
    successMessage: string
  ) => {
    setThemeBusy(true);
    setMessage(null);
    try {
      const completed = await operation();
      if (completed !== false) {
        setMessage(successMessage);
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "主题文件操作失败");
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
      data-ui="settings-panel"
      hidden={!open}
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
            关闭主窗口时保持在托盘运行（默认关闭）
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
                  ? theme.applyMode === "replace"
                    ? "完整替换"
                    : "覆盖模式"
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
              <div>
                <dt>应用模式</dt>
                <dd>{theme.applyMode === "replace" ? "完整替换" : "默认模板后覆盖"}</dd>
              </div>
              <div>
                <dt>主题接口</dt>
                <dd>
                  {theme.themeApiVersion} / 当前 {theme.supportedThemeApiVersion}
                </dd>
              </div>
              <div>
                <dt>可编辑源文件</dt>
                <dd>{theme.sourcePath}</dd>
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
              data-action="create-theme-from-template"
              data-ui="primary-button"
              disabled={themeBusy}
              onClick={() => {
                if (
                  !theme.installed ||
                  window.confirm("用默认模板替换当前本地主题工作目录？")
                ) {
                  void updateTheme(
                    () => window.drawGuessDesktop.theme.createFromDefault(),
                    "已从默认模板创建完整替换主题"
                  );
                }
              }}
              type="button"
            >
              从默认模板创建
            </button>
            <button
              className="secondary-button"
              data-action="import-replace-theme"
              data-ui="secondary-button"
              disabled={themeBusy}
              onClick={() =>
                void updateTheme(
                  () => window.drawGuessDesktop.theme.import("replace"),
                  "完整替换主题已原子导入并启用"
                )
              }
              type="button"
            >
              导入完整主题…
            </button>
            <button
              className="secondary-button"
              data-action="import-override-theme"
              data-ui="secondary-button"
              disabled={themeBusy}
              onClick={() =>
                void updateTheme(
                  () => window.drawGuessDesktop.theme.import("override"),
                  "覆盖 CSS 已在默认模板之后启用"
                )
              }
              type="button"
            >
              导入覆盖 CSS…
            </button>
            <button
              className="secondary-button"
              data-action="export-default-template"
              data-ui="secondary-button"
              disabled={themeBusy}
              onClick={() =>
                void runThemeUtility(
                  () => window.drawGuessDesktop.theme.exportDefault(),
                  "默认模板已导出"
                )
              }
              type="button"
            >
              导出默认模板…
            </button>
            <button
              className="secondary-button"
              data-action="open-theme-folder"
              data-ui="secondary-button"
              disabled={themeBusy}
              onClick={() =>
                void runThemeUtility(
                  () => window.drawGuessDesktop.theme.openFolder(),
                  "已打开主题工作目录"
                )
              }
              type="button"
            >
              打开主题文件夹
            </button>
            {theme.installed && (
              <button
                className="secondary-button"
                data-action="reload-theme"
                data-ui="secondary-button"
                disabled={themeBusy}
                onClick={() =>
                  void updateTheme(
                    () => window.drawGuessDesktop.theme.reload(),
                    "source.css 已重新编译并原子载入"
                  )
                }
                type="button"
              >
                重新载入 CSS
              </button>
            )}
            {theme.installed && !theme.enabled && (
              <button
                className="secondary-button"
                data-action="enable-theme"
                data-ui="secondary-button"
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
                data-action="restore-default-theme"
                data-ui="secondary-button"
                disabled={themeBusy}
                onClick={() =>
                  void updateTheme(
                    () => window.drawGuessDesktop.theme.disable(),
                    "已恢复默认外观；本地主题仍保留"
                  )
                }
                type="button"
              >
                恢复默认主题
              </button>
            )}
            {theme.installed && (
              <button
                className="danger-button"
                data-action="delete-theme"
                data-ui="danger-button"
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
            直接编辑工作目录中的 source.css 后点击“重新载入 CSS”。失败时 compiled.css
            与当前可用主题保持不变。主题异常时出现的 Shadow DOM 修复入口和独立共享
            停止入口永远不受主题影响。
          </small>
          <ThemePreview />
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
  const latestJoinFailure = [...entries]
    .reverse()
    .find((entry) => entry.message.startsWith("加入房间失败"));
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
      data-ui="diagnostics-panel"
      hidden={!open}
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
        {latestJoinFailure && (
          <article className="diagnostics-highlight" data-ui="join-failure-diagnostic">
            <div>
              <strong>最近一次加入失败</strong>
              <time>{latestJoinFailure.timestamp}</time>
            </div>
            <p>{latestJoinFailure.message}</p>
          </article>
        )}
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
  const [themeRoot, setThemeRoot] = useState<HTMLDivElement | null>(null);
  const [panel, setPanel] = useState<DesktopPanel>(null);
  const [gameViewEpoch, setGameViewEpoch] = useState(0);
  const [homeEntryMode, setHomeEntryMode] = useState<"create" | "join">("create");
  const [joinTarget, setJoinTarget] = useState<ConnectionTargetDraft>(
    draftFromTarget({ host: "127.0.0.1", port: 3000, security: "http" })
  );
  const [fatalError, setFatalError] = useState<string | null>(null);
  const joinTargetRef = useRef(joinTarget);
  joinTargetRef.current = joinTarget;

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
          setJoinTarget(draftFromTarget(result.settings.currentClientTarget));
        }
      })
      .catch((error: unknown) => {
        setFatalError(error instanceof Error ? error.message : "桌面应用初始化失败");
      });
    const unsubscribeServer = window.drawGuessDesktop.server.onStatus(setServerStatus);
    const unsubscribeTheme = window.drawGuessDesktop.theme.onStatus(setTheme);
    return () => {
      disposed = true;
      unsubscribeServer();
      unsubscribeTheme();
    };
  }, []);

  const transport = useMemo<DesktopGameTransport | null>(() => {
    if (!settings) {
      return null;
    }
    const target = settings.currentClientTarget;
    return {
      resume: () => window.drawGuessDesktop.game.resume(target),
      createRoom: async (nickname, password) => {
        const response = await window.drawGuessDesktop.game.createRoom({
          nickname,
          password
        });
        setServerStatus(response.server);
        setSettings((current) =>
          current
            ? {
                ...current,
                currentClientTarget: response.target
              }
            : current
        );
        return { snapshot: response.snapshot };
      },
      joinRoom: async (roomCode, nickname, password) => {
        const draft = joinTargetRef.current;
        const joinConnectionTarget = targetFromDraft(draft);
        let confirmInsecureHttp = draft.confirmInsecureHttp;
        if (
          joinConnectionTarget.security === "http" &&
          connectionHostKind(joinConnectionTarget.host) === "public" &&
          !confirmInsecureHttp
        ) {
          confirmInsecureHttp = window.confirm(
            "这是公网 HTTP/WS 明文连接。房间密码、聊天、图片和会话可能被链路上的第三方读取或篡改。\n\n只在你信任该入口并理解风险时继续。"
          );
          if (!confirmInsecureHttp) {
            throw new Error("未确认公网 HTTP/WS 风险，未连接服务器");
          }
          const confirmedDraft = { ...draft, confirmInsecureHttp: true };
          joinTargetRef.current = confirmedDraft;
          setJoinTarget(confirmedDraft);
        }
        const result = await window.drawGuessDesktop.game.joinRoom({
          target: joinConnectionTarget,
          confirmInsecureHttp,
          roomCode,
          nickname,
          password
        });
        const refreshed = await window.drawGuessDesktop.bootstrap();
        setSettings(refreshed.settings);
        return result;
      },
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
      leaveRoom: () => window.drawGuessDesktop.game.leaveRoom(),
      onEvent: (listener) =>
        window.drawGuessDesktop.game.onEvent((event) => listener(event))
    };
  }, [
    settings?.currentClientTarget.host,
    settings?.currentClientTarget.port,
    settings?.currentClientTarget.security
  ]);

  const hostControls = useMemo(() => {
    if (
      !settings ||
      !serverStatus ||
      serverStatus.state !== "running" ||
      !serverStatus.loopbackOrigin ||
      normalizeConnectionTarget(settings.currentClientTarget).origin !==
        serverStatus.loopbackOrigin
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
  const connectionManagementAvailable = canManageConnectionPanel(
    snapshot !== null,
    hostControls !== undefined
  );
  const visiblePanel = visibleDesktopPanel(panel, connectionManagementAvailable);

  useEffect(() => {
    if (!connectionManagementAvailable) {
      setPanel((current) => (current === "connection" ? null : current));
    }
  }, [connectionManagementAvailable]);

  const updateSettings = async (patch: SettingsPatch) => {
    const next = await window.drawGuessDesktop.settings.update(patch);
    setSettings(next);
  };

  const startServer = async (
    port: number,
    bindMode: DesktopSettings["hostBindMode"],
    restart: boolean
  ) => {
    const status = await window.drawGuessDesktop.server.start({
      port,
      bindMode,
      restart
    });
    setServerStatus(status);
    const refreshed = await window.drawGuessDesktop.bootstrap();
    setBootstrap(refreshed);
    setSettings(refreshed.settings);
    setPermission(refreshed.permission);
    setTheme(refreshed.theme);
    if (restart) {
      setSnapshot(null);
      setPanel(null);
      setGameViewEpoch((current) => current + 1);
    }
  };

  const stopServer = async () => {
    setServerStatus(await window.drawGuessDesktop.server.stop());
    setSnapshot(null);
    setPanel(null);
    setGameViewEpoch((current) => current + 1);
  };

  const closeRoom = async (roomCode: string) => {
    await window.drawGuessDesktop.server.closeRoom(roomCode);
    setHomeEntryMode("create");
    setSnapshot(null);
    setPanel(null);
    setGameViewEpoch((current) => current + 1);
  };

  const finishOnboarding = async (startLocal: boolean) => {
    if (!settings) {
      return;
    }
    if (startLocal) {
      setHomeEntryMode("create");
      await startServer(settings.hostPort, "loopback-only", false);
    } else {
      setHomeEntryMode("join");
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
    setGameViewEpoch((current) => current + 1);
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

  return (
    <div className="desktop-root">
      <DefaultDesktopThemeStyle
        enabled={!(theme.enabled && theme.applyMode === "replace")}
      />
      <div
        className="theme-root"
        data-connection={snapshot ? "connected" : "offline"}
        data-mode={snapshot?.game.mode}
        data-phase={snapshot?.game.phase.toLowerCase()}
        data-platform="desktop"
        data-screen={visiblePanel ?? (snapshot ? "game" : "home")}
        data-theme-mode={theme.enabled ? theme.applyMode : "default"}
        data-ui="theme-root"
        ref={setThemeRoot}
      >
        <GameApp
          contentServices={desktopContentServices}
          embeddedThemeRoot
          hostControls={hostControls}
          initialEntryMode={homeEntryMode}
          joinConnectionControl={
            <ConnectionTargetEditor
              draft={joinTarget}
              onChange={setJoinTarget}
              onDeleteRecent={async (target: ConnectionTarget) => {
                const origin = normalizeConnectionTarget(target).origin;
                await updateSettings({
                  recentConnections: settings.recentConnections.filter(
                    (recent) =>
                      normalizeConnectionTarget(recent.target).origin !== origin
                  )
                });
              }}
              recentConnections={settings.recentConnections}
            />
          }
          key={`${normalizeConnectionTarget(settings.currentClientTarget).origin}:${String(
            gameViewEpoch
          )}`}
          lobbyAddon={
            <CaptureStatusCard
              active={capture.active}
              error={capture.error}
              onOpen={() => setPanel("capture")}
              ready={capture.ready}
              sourceName={capture.sourceName}
            />
          }
          notificationsEnabled={settings.notificationsEnabled}
          onSnapshot={setSnapshot}
          topbarAddon={
            <DesktopDock
              activePanel={visiblePanel}
              captureActive={capture.active}
              captureReady={capture.ready}
              connectionManagementAvailable={connectionManagementAvailable}
              onOpen={() =>
                setPanel(
                  (current) =>
                    current ??
                    (connectionManagementAvailable ? "connection" : "capture")
                )
              }
              serverState={serverStatus.state}
            />
          }
          themePlatform="desktop"
          themeScreenOverride={visiblePanel ?? undefined}
          transport={transport}
        />

        {visiblePanel && (
          <button
            aria-label="关闭桌面控制中心"
            className="desktop-panel-backdrop"
            data-action="close-desktop-control-center"
            data-ui="desktop-panel-backdrop"
            onClick={() => setPanel(null)}
            type="button"
          />
        )}
        <section
          aria-hidden={visiblePanel === null}
          aria-label="桌面控制中心"
          aria-modal={visiblePanel === null ? undefined : true}
          className={`desktop-control-center ${
            visiblePanel ? "desktop-control-center--open" : ""
          }`}
          data-ui="desktop-control-center"
          hidden={visiblePanel === null}
          role={visiblePanel === null ? undefined : "dialog"}
        >
          {visiblePanel && (
            <DesktopControlCenterNav
              activePanel={visiblePanel}
              captureActive={capture.active}
              captureReady={capture.ready}
              connectionManagementAvailable={connectionManagementAvailable}
              onSelect={setPanel}
              serverState={serverStatus.state}
            />
          )}
          <div className="desktop-control-center__content">
            {connectionManagementAvailable && (
              <ConnectionPanel
                onClose={() => setPanel(null)}
                onSettings={updateSettings}
                onStart={startServer}
                onStop={stopServer}
                onRefreshNetworks={async () => {
                  setServerStatus(
                    await window.drawGuessDesktop.server.refreshNetworks()
                  );
                }}
                onChangeRoomPassword={(roomCode, password) =>
                  window.drawGuessDesktop.server.changeRoomPassword(roomCode, password)
                }
                onCloseRoom={closeRoom}
                open={visiblePanel === "connection"}
                roomCode={hostControls && snapshot ? snapshot.roomCode : null}
                settings={settings}
                status={serverStatus}
                platform={bootstrap.platform}
              />
            )}
            <CaptureStudio
              onClose={() => setPanel(null)}
              onSettingsChange={setSettings}
              onSummary={setCapture}
              open={visiblePanel === "capture"}
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
              open={visiblePanel === "settings"}
              permission={permission}
              settings={settings}
              theme={theme}
            />
            <DiagnosticsPanel
              onClose={() => setPanel(null)}
              open={visiblePanel === "diagnostics"}
            />
          </div>
        </section>

        {!settings.onboardingComplete && (
          <Onboarding bootstrap={bootstrap} onComplete={finishOnboarding} />
        )}
      </div>
      <ThemeSafetyHost
        captureActive={capture.active}
        onDisable={async () => {
          setTheme(await window.drawGuessDesktop.theme.disable());
        }}
        onOpenSettings={() => setPanel("settings")}
        onReload={async () => {
          setTheme(await window.drawGuessDesktop.theme.reload());
        }}
        onRetry={async () => {
          setTheme(await window.drawGuessDesktop.theme.enable());
        }}
        onStopSharing={async () => {
          await window.drawGuessDesktop.sharing.stop();
        }}
        onSuspend={async (reason) => {
          setTheme(await window.drawGuessDesktop.theme.suspend(reason));
        }}
        theme={theme}
        themeRoot={themeRoot}
      />
    </div>
  );
}
