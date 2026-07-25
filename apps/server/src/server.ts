import type { AddressInfo } from "node:net";

import type { FastifyInstance } from "fastify";

import { createApp, type CreateAppOptions } from "./app.js";
import { loadConfig, type ServerConfig } from "./config.js";
import type { GameService } from "./game-service.js";

export type { ReplayHostConfig } from "./services/ffmpeg-capability-service.js";

export type BuildServerOptions = CreateAppOptions;

export interface StartServerOptions extends Omit<CreateAppOptions, "config"> {
  config?: ServerConfig;
  host?: string;
  port?: number;
  findAvailablePort?: boolean;
  maxPortAttempts?: number;
}

export interface RunningServer {
  app: FastifyInstance;
  service: GameService;
  config: ServerConfig;
  host: string;
  port: number;
  requestedPort: number;
  usedFallbackPort: boolean;
  serverInstanceId: string;
  url: string;
  close(): Promise<void>;
}

export async function buildServer(
  options: BuildServerOptions = {}
): Promise<FastifyInstance> {
  return (await createApp(options)).app;
}

function errorCode(error: unknown): string | null {
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string"
  ) {
    return error.code;
  }
  return null;
}

export async function startServer(
  options: StartServerOptions = {}
): Promise<RunningServer> {
  const baseConfig = options.config ?? loadConfig();
  const host = options.host ?? baseConfig.host;
  const requestedPort = options.port ?? baseConfig.port;
  const findAvailablePort = options.findAvailablePort ?? false;
  const maxAttempts = findAvailablePort
    ? Math.max(1, options.maxPortAttempts ?? 10)
    : 1;
  let lastError: unknown;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const candidatePort = requestedPort === 0 ? 0 : requestedPort + attempt;
    if (candidatePort > 65_535) {
      break;
    }
    const config: ServerConfig = {
      ...baseConfig,
      host,
      port: candidatePort
    };
    const built = await createApp({
      ...options,
      config
    });
    const { app, service, serverInstanceId } = built;
    try {
      await app.listen({ host, port: candidatePort });
      const address = app.server.address() as AddressInfo | null;
      if (!address) {
        throw new Error("服务器没有返回监听地址");
      }
      const port = address.port;
      const displayHost = host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host;
      let closed = false;
      return {
        app,
        service,
        config: { ...built.config, host, port },
        host,
        port,
        requestedPort,
        usedFallbackPort: requestedPort !== 0 && port !== requestedPort,
        serverInstanceId,
        url: `http://${displayHost}:${String(port)}`,
        async close() {
          if (closed) {
            return;
          }
          closed = true;
          const forceClose = setTimeout(() => {
            app.server.closeAllConnections();
          }, 1_000);
          forceClose.unref();
          try {
            await app.close();
          } finally {
            clearTimeout(forceClose);
          }
        }
      };
    } catch (error) {
      lastError = error;
      await app.close().catch(() => undefined);
      if (errorCode(error) !== "EADDRINUSE" || attempt + 1 >= maxAttempts) {
        throw error;
      }
    }
  }

  throw lastError instanceof Error ? lastError : new Error("没有可用的服务器端口");
}
