import { useMemo, useState } from "react";

import type { DesktopSettings } from "../shared/ipc.js";
import {
  ConnectionPortConflictError,
  ConnectionSecurityConflictError,
  connectionHostKind,
  defaultSecurityForHost,
  normalizeConnectionTarget,
  parseConnectionAddress,
  parseConnectionTargetInput,
  type ConnectionTarget,
  type TransportSecurity
} from "../shared/server-url.js";

export interface ConnectionTargetDraft {
  address: string;
  port: number;
  security: TransportSecurity;
  confirmInsecureHttp: boolean;
}

export function draftFromTarget(target: ConnectionTarget): ConnectionTargetDraft {
  return {
    address: target.host,
    port: target.port,
    security: target.security,
    confirmInsecureHttp: false
  };
}

export function targetFromDraft(draft: ConnectionTargetDraft): ConnectionTarget {
  const normalized = parseConnectionTargetInput({
    address: draft.address,
    port: draft.port,
    security: draft.security
  });
  return {
    host: normalized.host,
    port: normalized.port,
    security: normalized.security
  };
}

export function ConnectionTargetEditor({
  draft,
  recentConnections,
  onChange,
  onDeleteRecent
}: {
  draft: ConnectionTargetDraft;
  recentConnections: DesktopSettings["recentConnections"];
  onChange: (draft: ConnectionTargetDraft) => void;
  onDeleteRecent: (target: ConnectionTarget) => Promise<void>;
}) {
  const [diagnostic, setDiagnostic] = useState<Awaited<
    ReturnType<typeof window.drawGuessDesktop.connection.test>
  > | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [conflict, setConflict] = useState<{
    addressPort: number;
    fieldPort: number;
    host: string;
    security: TransportSecurity | null;
  } | null>(null);
  const [securityTouched, setSecurityTouched] = useState(false);

  const target = useMemo(() => {
    try {
      return targetFromDraft(draft);
    } catch {
      return null;
    }
  }, [draft]);
  const hostKind = target ? connectionHostKind(target.host) : null;

  const inspectAddress = (): void => {
    setLocalError(null);
    try {
      const parsed = parseConnectionAddress(draft.address);
      if (parsed.port !== null && parsed.port !== draft.port) {
        setConflict({
          addressPort: parsed.port,
          fieldPort: draft.port,
          host: parsed.host,
          security: parsed.security
        });
        return;
      }
      setConflict(null);
      const nextSecurity =
        parsed.security ??
        (securityTouched ? draft.security : defaultSecurityForHost(parsed.host));
      onChange({
        ...draft,
        address: parsed.host,
        port: parsed.port ?? draft.port,
        security: nextSecurity,
        confirmInsecureHttp:
          nextSecurity === draft.security ? draft.confirmInsecureHttp : false
      });
    } catch (error) {
      setLocalError(error instanceof Error ? error.message : "服务器地址格式不正确");
    }
  };

  const testConnection = async (): Promise<void> => {
    setBusy(true);
    setDiagnostic(null);
    setLocalError(null);
    try {
      if (conflict) {
        throw new ConnectionPortConflictError(conflict.addressPort, conflict.fieldPort);
      }
      const nextTarget = targetFromDraft(draft);
      let confirmInsecureHttp = draft.confirmInsecureHttp;
      if (
        nextTarget.security === "http" &&
        connectionHostKind(nextTarget.host) === "public" &&
        !confirmInsecureHttp
      ) {
        confirmInsecureHttp = window.confirm(
          "这是公网 HTTP/WS 明文连接。房间密码、聊天、图片和会话可能被链路上的第三方读取或篡改。\n\n只在你信任该入口并理解风险时继续。"
        );
        if (!confirmInsecureHttp) {
          setLocalError("未确认公网 HTTP/WS 风险，未发起连接");
          return;
        }
        onChange({ ...draft, confirmInsecureHttp: true });
      }
      setDiagnostic(
        await window.drawGuessDesktop.connection.test({
          target: nextTarget,
          confirmInsecureHttp
        })
      );
    } catch (error) {
      if (error instanceof ConnectionSecurityConflictError) {
        setLocalError(error.message);
      } else {
        setLocalError(error instanceof Error ? error.message : "连接预检失败");
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <fieldset className="connection-target-editor">
      <legend>服务器连接目标</legend>
      <label>
        服务器地址或 IP
        <input
          autoComplete="off"
          inputMode="url"
          onBlur={inspectAddress}
          onChange={(event) => {
            setConflict(null);
            setDiagnostic(null);
            onChange({
              ...draft,
              address: event.target.value,
              confirmInsecureHttp: false
            });
          }}
          placeholder="192.168.1.20 或 example.com"
          required
          type="text"
          value={draft.address}
        />
      </label>
      <label>
        端口
        <input
          max={65_535}
          min={1}
          onChange={(event) => {
            setConflict(null);
            setDiagnostic(null);
            onChange({
              ...draft,
              port: Number(event.target.value),
              confirmInsecureHttp: false
            });
          }}
          required
          type="number"
          value={draft.port}
        />
      </label>
      <label>
        连接安全性
        <select
          onChange={(event) => {
            setSecurityTouched(true);
            setDiagnostic(null);
            onChange({
              ...draft,
              security: event.target.value as TransportSecurity,
              confirmInsecureHttp: false
            });
          }}
          value={draft.security}
        >
          <option value="https">HTTPS / WSS（公网推荐）</option>
          <option value="http">HTTP / WS（局域网或明确的明文转发）</option>
        </select>
      </label>

      {conflict && (
        <div className="connection-conflict" role="alert">
          <p>
            地址中的端口 {conflict.addressPort} 与端口框中的 {conflict.fieldPort}
            不一致，请明确选择。
          </p>
          <button
            onClick={() => {
              onChange({
                ...draft,
                address: conflict.host,
                port: conflict.addressPort,
                security: conflict.security ?? draft.security,
                confirmInsecureHttp: false
              });
              setConflict(null);
            }}
            type="button"
          >
            使用地址中的 {conflict.addressPort}
          </button>
          <button
            onClick={() => {
              onChange({
                ...draft,
                address: conflict.host,
                security: conflict.security ?? draft.security,
                confirmInsecureHttp: false
              });
              setConflict(null);
            }}
            type="button"
          >
            保留端口框的 {conflict.fieldPort}
          </button>
        </div>
      )}

      {hostKind === "private" || hostKind === "local-name" ? (
        <small>HTTP/WS 只适用于你信任的局域网；它不是加密连接。</small>
      ) : hostKind === "link-local" ? (
        <small>169.254.*.* 通常只适合临时直连，不是普通家庭局域网的推荐地址。</small>
      ) : hostKind === "public" && draft.security === "http" ? (
        <small className="inline-warning">
          公网 HTTP/WS 未加密，首次连接必须明确确认风险。
        </small>
      ) : (
        <small>公网地址默认使用 HTTPS/WSS，TLS 失败不会自动降级。</small>
      )}

      <button
        className="secondary-button"
        disabled={busy || Boolean(conflict)}
        onClick={() => void testConnection()}
        type="button"
      >
        {busy ? "正在测试…" : "测试连接"}
      </button>

      {diagnostic && (
        <div
          className={
            diagnostic.ok ? "connection-result is-success" : "connection-result"
          }
          role="status"
        >
          <strong>{diagnostic.message}</strong>
          {diagnostic.ok && (
            <span>
              应用 {diagnostic.info.appVersion} · 协议 v
              {diagnostic.info.protocolVersion} · {diagnostic.latencyMs} ms · 实例{" "}
              {diagnostic.info.serverInstanceId.slice(0, 10)}…
            </span>
          )}
          {!diagnostic.ok &&
            diagnostic.code === "tls-failed" &&
            hostKind === "public" && (
              <button
                onClick={() => {
                  onChange({
                    ...draft,
                    security: "http",
                    confirmInsecureHttp: false
                  });
                  setDiagnostic(null);
                }}
                type="button"
              >
                改用未加密 HTTP/WS（仍需确认风险）
              </button>
            )}
        </div>
      )}
      {localError && <p className="form-error">{localError}</p>}

      {recentConnections.length > 0 && (
        <div className="recent-connections">
          <strong>最近成功连接</strong>
          {recentConnections.map((recent) => {
            const normalized = normalizeConnectionTarget(recent.target);
            return (
              <div key={normalized.origin}>
                <button
                  onClick={() => {
                    setDiagnostic(null);
                    setConflict(null);
                    onChange(draftFromTarget(recent.target));
                  }}
                  type="button"
                >
                  {recent.label ?? normalized.origin}
                </button>
                <button
                  aria-label={`删除 ${normalized.origin}`}
                  onClick={() => void onDeleteRecent(recent.target)}
                  type="button"
                >
                  删除
                </button>
              </div>
            );
          })}
        </div>
      )}
    </fieldset>
  );
}
