import { ConnectionInfoSchema, PROTOCOL_VERSION } from "@draw-guess/protocol";
import { z } from "zod";

import type { ConnectionTestResult } from "../shared/ipc.js";
import {
  connectionHostKind,
  normalizeConnectionTarget,
  type ConnectionTarget,
  type NormalizedConnectionTarget
} from "../shared/server-url.js";
import type { RedactingLogger } from "./redacting-logger.js";
import type { SettingsService } from "./settings-service.js";

const MAX_CONNECTION_INFO_BYTES = 16 * 1024;

const ProbeEnvelopeSchema = z
  .object({
    service: z.string().max(128),
    protocolVersion: z.number().int()
  })
  .passthrough();

type FailureCode = ConnectionTestResult["code"];
type FetchImplementation = typeof fetch;

function causeCodes(error: unknown): Set<string> {
  const codes = new Set<string>();
  let current = error;
  for (let depth = 0; depth < 6 && current; depth += 1) {
    if (
      typeof current === "object" &&
      current !== null &&
      "code" in current &&
      typeof current.code === "string"
    ) {
      codes.add(current.code);
    }
    current =
      typeof current === "object" && current !== null && "cause" in current
        ? current.cause
        : null;
  }
  return codes;
}

function errorText(error: unknown): string {
  const messages: string[] = [];
  let current = error;
  for (let depth = 0; depth < 6 && current; depth += 1) {
    if (
      typeof current === "object" &&
      current !== null &&
      "message" in current &&
      typeof current.message === "string"
    ) {
      messages.push(current.message);
    }
    current =
      typeof current === "object" && current !== null && "cause" in current
        ? current.cause
        : null;
  }
  return messages.join(" ").toLowerCase();
}

function classifyFetchFailure(error: unknown): {
  code: Exclude<FailureCode, "success" | "invalid-input" | "insecure-confirmation">;
  message: string;
} {
  const codes = causeCodes(error);
  const text = errorText(error);
  if (codes.has("ENOTFOUND") || codes.has("EAI_AGAIN")) {
    return {
      code: "dns-failed",
      message: "无法解析服务器地址，请检查主机名和 DNS 网络"
    };
  }
  if (codes.has("ECONNREFUSED")) {
    return {
      code: "connection-refused",
      message: "目标机器可达，但该端口没有服务监听"
    };
  }
  if (
    [...codes].some(
      (code) =>
        code.startsWith("CERT_") ||
        code.startsWith("ERR_TLS") ||
        code === "DEPTH_ZERO_SELF_SIGNED_CERT" ||
        code === "SELF_SIGNED_CERT_IN_CHAIN" ||
        code === "UNABLE_TO_VERIFY_LEAF_SIGNATURE" ||
        code === "UNABLE_TO_GET_ISSUER_CERT_LOCALLY"
    ) ||
    text.includes("certificate") ||
    text.includes("tls")
  ) {
    return {
      code: "tls-failed",
      message: "HTTPS 证书或 TLS 握手失败；应用不会忽略证书错误或自动降级到 HTTP"
    };
  }
  if (
    codes.has("UND_ERR_CONNECT_TIMEOUT") ||
    codes.has("ETIMEDOUT") ||
    (typeof error === "object" &&
      error !== null &&
      "name" in error &&
      (error.name === "AbortError" || error.name === "TimeoutError"))
  ) {
    return {
      code: "timeout",
      message: "请求超时；可能是防火墙、错误 IP、AP 隔离，或公网端口映射尚未生效"
    };
  }
  if (text.includes("redirect")) {
    return {
      code: "wrong-service",
      message: "该端口返回了重定向，不是可直接连接的画猜现场入口"
    };
  }
  return {
    code: "timeout",
    message: "无法在限定时间内连接服务器；请检查地址、端口、防火墙和端口转发"
  };
}

async function readBoundedJson(response: Response): Promise<unknown> {
  const declaredLength = Number(response.headers.get("content-length") ?? "0");
  if (Number.isFinite(declaredLength) && declaredLength > MAX_CONNECTION_INFO_BYTES) {
    throw new Error("CONNECTION_INFO_TOO_LARGE");
  }
  if (!response.body) {
    throw new Error("CONNECTION_INFO_EMPTY");
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) {
        break;
      }
      length += next.value.byteLength;
      if (length > MAX_CONNECTION_INFO_BYTES) {
        await reader.cancel();
        throw new Error("CONNECTION_INFO_TOO_LARGE");
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes)
    ) as unknown;
  } catch {
    throw new Error("CONNECTION_INFO_INVALID_JSON");
  }
}

export class ConnectionPreflightService {
  readonly #settings: SettingsService;
  readonly #logger: RedactingLogger;
  readonly #fetch: FetchImplementation;
  readonly #timeoutMs: number;

  constructor(
    settings: SettingsService,
    logger: RedactingLogger,
    options: { fetch?: FetchImplementation; timeoutMs?: number } = {}
  ) {
    this.#settings = settings;
    this.#logger = logger;
    this.#fetch = options.fetch ?? fetch;
    this.#timeoutMs = options.timeoutMs ?? 4_000;
  }

  async test(
    targetInput: ConnectionTarget,
    confirmInsecureHttp = false
  ): Promise<ConnectionTestResult> {
    const startedAt = Date.now();
    let target: NormalizedConnectionTarget;
    try {
      target = normalizeConnectionTarget(targetInput);
    } catch (error) {
      return {
        ok: false,
        code: "invalid-input",
        message: error instanceof Error ? error.message : "地址或端口格式不正确",
        target: null,
        latencyMs: null
      };
    }
    if (
      target.security === "http" &&
      connectionHostKind(target.host) === "public" &&
      !this.#settings.insecureHttpConfirmed(target)
    ) {
      if (!confirmInsecureHttp) {
        return {
          ok: false,
          code: "insecure-confirmation",
          message:
            "公网 HTTP/WS 未加密：密码、聊天、图片和会话可能被链路上的第三方读取或篡改",
          target,
          latencyMs: null
        };
      }
      await this.#settings.confirmInsecureHttp(target);
    }

    let response: Response;
    try {
      response = await this.#fetch(`${target.origin}/api/connection-info`, {
        method: "GET",
        headers: {
          Accept: "application/json"
        },
        credentials: "omit",
        redirect: "error",
        signal: AbortSignal.timeout(this.#timeoutMs)
      });
    } catch (error) {
      const classified = classifyFetchFailure(error);
      this.#logger.warn("服务器连接预检失败", {
        origin: target.origin,
        code: classified.code,
        systemCodes: [...causeCodes(error)]
      });
      return {
        ok: false,
        ...classified,
        target,
        latencyMs: Date.now() - startedAt
      };
    }

    const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
    if (!response.ok || !contentType.startsWith("application/json")) {
      await response.body?.cancel().catch(() => undefined);
      return {
        ok: false,
        code: "wrong-service",
        message: "该端口没有返回画猜现场的连接信息",
        target,
        latencyMs: Date.now() - startedAt
      };
    }

    let raw: unknown;
    try {
      raw = await readBoundedJson(response);
    } catch {
      return {
        ok: false,
        code: "wrong-service",
        message: "该端口返回的连接信息格式或大小不正确",
        target,
        latencyMs: Date.now() - startedAt
      };
    }
    const envelope = ProbeEnvelopeSchema.safeParse(raw);
    if (!envelope.success || envelope.data.service !== "draw-guess") {
      return {
        ok: false,
        code: "wrong-service",
        message: "该端口不是画猜现场服务器",
        target,
        latencyMs: Date.now() - startedAt
      };
    }
    if (envelope.data.protocolVersion !== PROTOCOL_VERSION) {
      return {
        ok: false,
        code: "protocol-mismatch",
        message: `客户端协议 v${String(PROTOCOL_VERSION)} 与服务器协议 v${String(
          envelope.data.protocolVersion
        )} 不兼容`,
        target,
        latencyMs: Date.now() - startedAt
      };
    }
    const info = ConnectionInfoSchema.safeParse(raw);
    if (!info.success) {
      return {
        ok: false,
        code: "wrong-service",
        message: "服务器连接信息缺少必要字段或包含未知字段",
        target,
        latencyMs: Date.now() - startedAt
      };
    }
    return {
      ok: true,
      code: "success",
      message: "已找到兼容的画猜现场服务器",
      target,
      info: info.data,
      latencyMs: Date.now() - startedAt
    };
  }
}
