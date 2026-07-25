import { z } from "zod";

const BooleanStringSchema = z
  .enum(["true", "false"])
  .default("false")
  .transform((value) => value === "true");

const EnvironmentSchema = z.object({
  HOST: z.string().default("127.0.0.1"),
  PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
  ALLOWED_ORIGINS: z.string().default("http://127.0.0.1:5173,http://localhost:5173"),
  TRUSTED_PROXY_ADDRESSES: z.string().default(""),
  COOKIE_SECURE: BooleanStringSchema,
  ROOM_IDLE_TTL_MS: z.coerce.number().int().min(60_000).default(1_800_000),
  RECONNECT_GRACE_MS: z.coerce.number().int().min(1_000).default(10_000),
  DESKTOP_SESSION_TTL_MS: z.coerce.number().int().min(60_000).default(43_200_000),
  TURN_RESULT_MS: z.coerce.number().int().min(250).default(5_000)
});

export interface ServerConfig {
  host: string;
  port: number;
  allowedOrigins: Set<string>;
  trustedProxyAddresses: Set<string>;
  cookieSecure: boolean;
  roomIdleTtlMs: number;
  reconnectGraceMs: number;
  desktopSessionTtlMs: number;
  turnResultMs: number;
}

export function loadConfig(environment: NodeJS.ProcessEnv = process.env): ServerConfig {
  const parsed = EnvironmentSchema.parse(environment);
  return {
    host: parsed.HOST,
    port: parsed.PORT,
    allowedOrigins: new Set(
      parsed.ALLOWED_ORIGINS.split(",")
        .map((origin) => origin.trim())
        .filter(Boolean)
    ),
    trustedProxyAddresses: new Set(
      parsed.TRUSTED_PROXY_ADDRESSES.split(",")
        .map((address) => address.trim())
        .filter(Boolean)
    ),
    cookieSecure: parsed.COOKIE_SECURE,
    roomIdleTtlMs: parsed.ROOM_IDLE_TTL_MS,
    reconnectGraceMs: parsed.RECONNECT_GRACE_MS,
    desktopSessionTtlMs: parsed.DESKTOP_SESSION_TTL_MS,
    turnResultMs: parsed.TURN_RESULT_MS
  };
}
