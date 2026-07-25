import { z } from "zod";

export const TransportSecuritySchema = z.enum(["http", "https"]);
export type TransportSecurity = z.infer<typeof TransportSecuritySchema>;

export interface ConnectionTarget {
  host: string;
  port: number;
  security: TransportSecurity;
}

export interface NormalizedConnectionTarget extends ConnectionTarget {
  origin: string;
  websocketOrigin: string;
}

export type ConnectionHostKind =
  "loopback" | "private" | "link-local" | "local-name" | "public";

const DNS_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;

function hasForbiddenAddressCharacters(value: string): boolean {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 0x20 || (codePoint >= 0x7f && codePoint <= 0x9f);
  });
}

function ipv4Parts(hostname: string): number[] | null {
  const textParts = hostname.split(".");
  if (
    textParts.length !== 4 ||
    textParts.some(
      (part) =>
        !/^(?:0|[1-9]\d{0,2})$/u.test(part) ||
        Number(part) > 255 ||
        (part.length > 1 && part.startsWith("0"))
    )
  ) {
    return null;
  }
  return textParts.map(Number);
}

export function isIpv4Hostname(hostname: string): boolean {
  return ipv4Parts(hostname) !== null;
}

export function isPrivateIpv4(hostname: string): boolean {
  const parts = ipv4Parts(hostname);
  if (!parts) {
    return false;
  }
  const [first, second] = parts;
  return (
    first === 10 ||
    (first === 172 && second !== undefined && second >= 16 && second <= 31) ||
    (first === 192 && second === 168)
  );
}

export function isLoopbackIpv4(hostname: string): boolean {
  return ipv4Parts(hostname)?.[0] === 127;
}

export function isLinkLocalIpv4(hostname: string): boolean {
  const parts = ipv4Parts(hostname);
  return parts?.[0] === 169 && parts[1] === 254;
}

export function normalizeConnectionHost(hostInput: string): string {
  if (
    hostInput.length < 1 ||
    hostInput.length > 253 ||
    hasForbiddenAddressCharacters(hostInput) ||
    hostInput !== hostInput.trim()
  ) {
    throw new Error("服务器地址包含空白或控制字符");
  }
  if (hostInput.includes("[") || hostInput.includes("]") || hostInput.includes(":")) {
    throw new Error("0.5.0 暂不支持 IPv6 服务器地址");
  }
  const lower = hostInput.toLowerCase();
  const ipv4 = ipv4Parts(lower);
  if (ipv4) {
    const normalizedIpv4 = ipv4.join(".");
    if (normalizedIpv4 === "0.0.0.0") {
      throw new Error("0.0.0.0 是监听诊断地址，不能作为玩家连接地址");
    }
    return normalizedIpv4;
  }
  if (/^[\d.]+$/u.test(lower)) {
    throw new Error("IPv4 地址格式不正确");
  }
  let normalized: string;
  try {
    normalized = new URL(`http://${lower}`).hostname.toLowerCase();
  } catch {
    throw new Error("服务器主机名格式不正确");
  }
  if (
    normalized.length < 1 ||
    normalized.length > 253 ||
    normalized.endsWith(".") ||
    normalized.split(".").some((label) => !DNS_LABEL.test(label))
  ) {
    throw new Error("服务器主机名格式不正确");
  }
  return normalized;
}

export function connectionHostKind(hostInput: string): ConnectionHostKind {
  const hostname = normalizeConnectionHost(hostInput);
  if (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    isLoopbackIpv4(hostname)
  ) {
    return "loopback";
  }
  if (isPrivateIpv4(hostname)) {
    return "private";
  }
  if (isLinkLocalIpv4(hostname)) {
    return "link-local";
  }
  if (hostname.endsWith(".local")) {
    return "local-name";
  }
  return "public";
}

export function isLocalNetworkHostname(hostnameInput: string): boolean {
  return connectionHostKind(hostnameInput) !== "public";
}

export function defaultSecurityForHost(host: string): TransportSecurity {
  return isLocalNetworkHostname(host) ? "http" : "https";
}

export const ConnectionTargetSchema = z
  .object({
    host: z.string().min(1).max(253),
    port: z.number().int().min(1).max(65_535),
    security: TransportSecuritySchema
  })
  .strict()
  .superRefine((target, context) => {
    try {
      if (normalizeConnectionHost(target.host) !== target.host) {
        context.addIssue({
          code: "custom",
          path: ["host"],
          message: "服务器地址必须使用规范化的小写主机名或 IPv4"
        });
      }
    } catch (error) {
      context.addIssue({
        code: "custom",
        path: ["host"],
        message: error instanceof Error ? error.message : "服务器地址格式不正确"
      });
    }
  });

export const NormalizedConnectionTargetSchema = ConnectionTargetSchema.extend({
  origin: z.string().url(),
  websocketOrigin: z.string().url()
}).strict();

export class ConnectionPortConflictError extends Error {
  constructor(
    readonly addressPort: number,
    readonly fieldPort: number
  ) {
    super(
      `地址中的端口 ${String(addressPort)} 与端口框中的 ${String(fieldPort)} 不一致`
    );
  }
}

export class ConnectionSecurityConflictError extends Error {
  constructor(
    readonly addressSecurity: TransportSecurity,
    readonly selectedSecurity: TransportSecurity
  ) {
    super(
      `地址使用 ${addressSecurity.toUpperCase()}，但连接安全性选择了 ${selectedSecurity.toUpperCase()}`
    );
  }
}

export interface ParsedConnectionAddress {
  host: string;
  port: number | null;
  security: TransportSecurity | null;
}

function validatedPort(value: number): number {
  if (!Number.isInteger(value) || value < 1 || value > 65_535) {
    throw new Error("端口必须是 1 到 65535 之间的整数");
  }
  return value;
}

export function parseConnectionAddress(addressInput: string): ParsedConnectionAddress {
  if (
    addressInput.length < 1 ||
    addressInput !== addressInput.trim() ||
    hasForbiddenAddressCharacters(addressInput)
  ) {
    throw new Error("服务器地址不能包含首尾空白、换行或控制字符");
  }
  const schemeMatch = /^([a-z][a-z0-9+.-]*):\/\//iu.exec(addressInput);
  if (schemeMatch) {
    let parsed: URL;
    try {
      parsed = new URL(addressInput);
    } catch {
      throw new Error("服务器地址格式不正确");
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error("服务器地址只支持 HTTP 或 HTTPS");
    }
    if (parsed.username || parsed.password) {
      throw new Error("服务器地址不能包含用户名或密码");
    }
    if (parsed.search || parsed.hash) {
      throw new Error("服务器地址不能包含 query 或 fragment");
    }
    if (parsed.pathname !== "/" && parsed.pathname !== "") {
      throw new Error("服务器当前只支持站点根路径");
    }
    const security = parsed.protocol.slice(0, -1) as TransportSecurity;
    return {
      host: normalizeConnectionHost(parsed.hostname),
      port: parsed.port ? validatedPort(Number(parsed.port)) : null,
      security
    };
  }
  if (
    /^[a-z][a-z0-9+.-]*:/iu.test(addressInput) &&
    !/^[^:]+:\d+$/u.test(addressInput)
  ) {
    throw new Error("服务器地址只支持 HTTP 或 HTTPS");
  }
  if (
    addressInput.includes("/") ||
    addressInput.includes("?") ||
    addressInput.includes("#") ||
    addressInput.includes("@")
  ) {
    throw new Error("服务器地址不能包含路径、凭据、query 或 fragment");
  }
  const colonCount = [...addressInput].filter((character) => character === ":").length;
  if (colonCount > 1) {
    throw new Error("0.5.0 暂不支持 IPv6 服务器地址");
  }
  if (colonCount === 1) {
    const separator = addressInput.lastIndexOf(":");
    const host = addressInput.slice(0, separator);
    const rawPort = addressInput.slice(separator + 1);
    if (!/^\d+$/u.test(rawPort)) {
      throw new Error("地址中的端口必须是整数");
    }
    return {
      host: normalizeConnectionHost(host),
      port: validatedPort(Number(rawPort)),
      security: null
    };
  }
  return {
    host: normalizeConnectionHost(addressInput),
    port: null,
    security: null
  };
}

export function normalizeConnectionTarget(
  targetInput: ConnectionTarget
): NormalizedConnectionTarget {
  const host = normalizeConnectionHost(targetInput.host);
  const port = validatedPort(targetInput.port);
  const security = TransportSecuritySchema.parse(targetInput.security);
  const defaultPort = security === "https" ? 443 : 80;
  const authority = port === defaultPort ? host : `${host}:${String(port)}`;
  const origin = `${security}://${authority}`;
  const websocketOrigin = `${security === "https" ? "wss" : "ws"}://${authority}`;
  return NormalizedConnectionTargetSchema.parse({
    host,
    port,
    security,
    origin,
    websocketOrigin
  });
}

export function parseConnectionTargetInput(input: {
  address: string;
  port?: number;
  security?: TransportSecurity;
}): NormalizedConnectionTarget {
  const parsed = parseConnectionAddress(input.address);
  const fieldPort = input.port === undefined ? null : validatedPort(Number(input.port));
  if (parsed.port !== null && fieldPort !== null && parsed.port !== fieldPort) {
    throw new ConnectionPortConflictError(parsed.port, fieldPort);
  }
  if (
    parsed.security !== null &&
    input.security !== undefined &&
    parsed.security !== input.security
  ) {
    throw new ConnectionSecurityConflictError(parsed.security, input.security);
  }
  const security =
    parsed.security ?? input.security ?? defaultSecurityForHost(parsed.host);
  const port = parsed.port ?? fieldPort ?? (security === "https" ? 443 : 80);
  return normalizeConnectionTarget({ host: parsed.host, port, security });
}

export function connectionTargetFromOrigin(value: string): NormalizedConnectionTarget {
  const parsed = parseConnectionAddress(value);
  if (!parsed.security) {
    throw new Error("服务器 origin 必须明确包含 HTTP 或 HTTPS");
  }
  return normalizeConnectionTarget({
    host: parsed.host,
    port: parsed.port ?? (parsed.security === "https" ? 443 : 80),
    security: parsed.security
  });
}

export function normalizeServerUrl(value: string): string {
  return connectionTargetFromOrigin(value).origin;
}

export function websocketUrl(targetInput: ConnectionTarget | string): string {
  const target =
    typeof targetInput === "string"
      ? connectionTargetFromOrigin(targetInput)
      : normalizeConnectionTarget(targetInput);
  return `${target.websocketOrigin}/ws`;
}
