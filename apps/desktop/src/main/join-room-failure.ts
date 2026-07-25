import { z } from "zod";

import type { ConnectionTestResult } from "../shared/ipc.js";
import { DesktopRequestError } from "./desktop-request-error.js";

export type JoinRoomFailurePhase =
  | "preflight"
  | "target-configuration"
  | "join-request"
  | "response-validation"
  | "session-setup";

export interface JoinRoomFailureDescription {
  phase: JoinRoomFailurePhase;
  phaseLabel: string;
  code: string;
  reason: string;
  suggestion: string;
}

const PHASE_LABELS: Record<JoinRoomFailurePhase, string> = {
  preflight: "连接预检",
  "target-configuration": "切换服务器",
  "join-request": "验证房间",
  "response-validation": "校验服务器响应",
  "session-setup": "建立实时连接"
};

const PREFLIGHT_SUGGESTIONS: Record<
  Exclude<ConnectionTestResult["code"], "success">,
  string
> = {
  "invalid-input": "检查服务器地址、端口和 HTTP/HTTPS 选项",
  "dns-failed": "检查主机名拼写、DNS 和当前网络",
  "connection-refused":
    "让房主确认房间服务正在运行、端口填写一致；跨设备连接时主机必须监听 0.0.0.0",
  timeout: "检查 IP、双方防火墙、访客网络/AP 隔离，以及公网端口转发",
  "tls-failed": "让房主修复 HTTPS 证书或改用可信入口；客户端不会跳过证书验证",
  "wrong-service": "确认该端口指向画猜现场服务，而不是路由器后台或其它网页",
  "protocol-mismatch": "让房主和玩家升级到同一版本",
  "insecure-confirmation": "确认入口可信后勾选公网 HTTP 风险确认，或改用 HTTPS"
};

export class ConnectionPreflightError extends Error {
  constructor(readonly result: Extract<ConnectionTestResult, { ok: false }>) {
    super(result.message);
  }
}

function joinFailure(
  phase: JoinRoomFailurePhase,
  code: string,
  reason: string,
  suggestion: string
): JoinRoomFailureDescription {
  return { phase, phaseLabel: PHASE_LABELS[phase], code, reason, suggestion };
}

export function describeJoinRoomFailure(
  error: unknown,
  phase: JoinRoomFailurePhase
): JoinRoomFailureDescription {
  if (error instanceof ConnectionPreflightError) {
    return joinFailure(
      "preflight",
      error.result.code,
      error.result.message,
      PREFLIGHT_SUGGESTIONS[error.result.code]
    );
  }
  if (error instanceof DesktopRequestError) {
    if (error.status === 401 || error.code === "UNAUTHORIZED") {
      const reason =
        error.message === "服务器请求失败"
          ? "房间密码错误，或房主已经修改了密码"
          : error.message;
      return joinFailure(
        "join-request",
        error.code ?? "UNAUTHORIZED",
        reason,
        "向房主确认当前房间密码；房主可能刚刚修改过密码"
      );
    }
    if (error.status === 404 || error.code === "NOT_FOUND") {
      return joinFailure(
        "join-request",
        error.code ?? "room-not-found",
        error.message,
        "检查六位房间码，并确认房主的房间服务仍在运行"
      );
    }
    if (error.status === 409 || error.code === "INVALID_STATE") {
      return joinFailure(
        "join-request",
        error.code ?? "room-state",
        error.message,
        "根据提示让房主回到大厅，或确认房间当前是否允许加入"
      );
    }
    if (error.status === 403 || error.code === "FORBIDDEN") {
      return joinFailure(
        "join-request",
        error.code ?? "forbidden",
        error.message,
        "确认连接的是兼容服务器，且代理没有改写桌面客户端请求"
      );
    }
    if (error.status === 429 || error.code === "RATE_LIMITED") {
      return joinFailure(
        "join-request",
        error.code ?? "rate-limited",
        error.message,
        "稍等片刻后再试，避免连续提交"
      );
    }
    if (error.status >= 500) {
      return joinFailure(
        "join-request",
        error.code ?? "server-error",
        error.message,
        "让房主查看服务器状态和诊断日志，然后重试"
      );
    }
    return joinFailure(
      "join-request",
      error.code ?? `http-${String(error.status)}`,
      error.message,
      "核对房间码、密码和客户端版本后重试"
    );
  }
  if (error instanceof z.ZodError) {
    return joinFailure(
      "response-validation",
      "invalid-server-response",
      "服务器响应缺少有效会话或房间信息",
      "让房主和玩家升级到同一版本，并确认端口没有被代理到其它服务"
    );
  }
  const message = error instanceof Error ? error.message : "发生未知错误";
  if (message.includes("连接目标已更改")) {
    return joinFailure(
      "target-configuration",
      "target-changed",
      message,
      "保持当前服务器地址不变，再重新加入"
    );
  }
  if (
    error instanceof TypeError ||
    (error instanceof DOMException &&
      (error.name === "AbortError" || error.name === "TimeoutError"))
  ) {
    return joinFailure(
      phase,
      "network-request-failed",
      "预检后向服务器提交加入请求时网络中断或超时",
      "确认房主服务仍在运行，并检查防火墙、Wi-Fi 和端口转发"
    );
  }
  return joinFailure(
    phase,
    "unexpected-error",
    message,
    "打开诊断页面查看该次失败记录，并根据阶段检查服务器设置"
  );
}

export function joinRoomFailureMessage(
  description: JoinRoomFailureDescription
): string {
  return `加入房间失败（${description.phaseLabel}）：${description.reason}。建议：${description.suggestion}。`;
}
