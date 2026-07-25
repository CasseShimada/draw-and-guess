import { randomBytes } from "node:crypto";
import { networkInterfaces } from "node:os";

import {
  startServer,
  type ReplayHostConfig,
  type RunningServer
} from "@draw-guess/server";
import type { ReplayHostCapability } from "@draw-guess/shared-types";

import {
  EmbeddedServerStatusSchema,
  type EmbeddedServerStatus
} from "../shared/ipc.js";
import {
  isLinkLocalIpv4,
  isPrivateIpv4,
  normalizeConnectionTarget,
  type ConnectionTarget
} from "../shared/server-url.js";
import type { RedactingLogger } from "./redacting-logger.js";

type StatusListener = (status: EmbeddedServerStatus) => void;
type HostBindMode = EmbeddedServerStatus["bindMode"];

export interface EmbeddedServerServiceOptions {
  replayConfig?: () => ReplayHostConfig;
  publicEndpoint?: () => ConnectionTarget | null;
}

function initialStatus(bindMode: HostBindMode = "loopback-only"): EmbeddedServerStatus {
  return {
    state: "stopped",
    bindMode,
    boundHost: null,
    requestedPort: null,
    actualPort: null,
    serverInstanceId: null,
    loopbackOrigin: null,
    lanAddresses: [],
    executablePath: process.execPath,
    error: null
  };
}

function addressId(interfaceName: string, address: string): string {
  return `${interfaceName}:${address}`;
}

export function enumerateLanAddresses(): EmbeddedServerStatus["lanAddresses"] {
  const addresses: EmbeddedServerStatus["lanAddresses"] = [];
  for (const [interfaceName, entries] of Object.entries(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (
        entry.family !== "IPv4" ||
        entry.internal ||
        entry.address === "0.0.0.0" ||
        entry.address.startsWith("127.")
      ) {
        continue;
      }
      const kind = isPrivateIpv4(entry.address)
        ? "private"
        : isLinkLocalIpv4(entry.address)
          ? "link-local"
          : "other";
      addresses.push({
        id: addressId(interfaceName, entry.address),
        interfaceName,
        address: entry.address,
        netmask: entry.netmask,
        cidr: entry.cidr ?? null,
        kind,
        recommended: kind === "private"
      });
    }
  }
  const rank = { private: 0, other: 1, "link-local": 2 } as const;
  return addresses.sort(
    (left, right) =>
      rank[left.kind] - rank[right.kind] ||
      left.interfaceName.localeCompare(right.interfaceName) ||
      left.address.localeCompare(right.address)
  );
}

function errorCode(error: unknown): string | null {
  return typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string"
    ? error.code
    : null;
}

export class EmbeddedServerService {
  readonly #webRoot: string;
  readonly #logger: RedactingLogger;
  readonly #options: EmbeddedServerServiceOptions;
  readonly #hostControlKey = randomBytes(32).toString("base64url");
  readonly #listeners = new Set<StatusListener>();
  #running: RunningServer | null = null;
  #status = initialStatus();
  #operation: Promise<EmbeddedServerStatus> | null = null;
  #configuredPublicOrigin: string | null = null;
  #networkRefreshTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    webRoot: string,
    logger: RedactingLogger,
    options: EmbeddedServerServiceOptions = {}
  ) {
    this.#webRoot = webRoot;
    this.#logger = logger;
    this.#options = options;
  }

  get status(): EmbeddedServerStatus {
    return structuredClone(this.#status);
  }

  onStatus(listener: StatusListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  async start(
    port: number,
    bindMode: HostBindMode,
    restart = false
  ): Promise<EmbeddedServerStatus> {
    if (this.#operation) {
      return this.#operation;
    }
    this.#operation = this.#start(port, bindMode, restart).finally(() => {
      this.#operation = null;
    });
    return this.#operation;
  }

  async stop(): Promise<EmbeddedServerStatus> {
    if (this.#operation) {
      await this.#operation.catch(() => undefined);
    }
    if (!this.#running) {
      this.#setStatus(initialStatus(this.#status.bindMode));
      return this.status;
    }
    this.#setStatus({ ...this.#status, state: "stopping", error: null });
    await this.#closeRunning();
    this.#setStatus(initialStatus(this.#status.bindMode));
    return this.status;
  }

  refreshNetworks(): EmbeddedServerStatus {
    this.#setStatus({
      ...this.#status,
      lanAddresses:
        this.#status.state === "running" && this.#status.bindMode === "lan"
          ? enumerateLanAddresses()
          : []
    });
    return this.status;
  }

  configurePublicEndpoint(target: ConnectionTarget | null): void {
    const nextOrigin = target ? normalizeConnectionTarget(target).origin : null;
    if (this.#running && this.#configuredPublicOrigin) {
      this.#running.config.allowedOrigins.delete(this.#configuredPublicOrigin);
    }
    this.#configuredPublicOrigin = nextOrigin;
    if (this.#running && nextOrigin) {
      this.#running.config.allowedOrigins.add(nextOrigin);
    }
  }

  pause(roomCode: string): void {
    const running = this.#requireRunning();
    running.service.pauseFromEmbeddedHost(this.#hostControlKey, roomCode);
  }

  resume(roomCode: string): void {
    const running = this.#requireRunning();
    running.service.resumeFromEmbeddedHost(this.#hostControlKey, roomCode);
  }

  async changeRoomPassword(roomCode: string, password: string): Promise<void> {
    const running = this.#requireRunning();
    await running.service.changePasswordFromEmbeddedHost(
      this.#hostControlKey,
      roomCode,
      password
    );
    this.#logger.info("房间密码已由实际主机更新", { roomCode });
  }

  async revalidateReplay(): Promise<ReplayHostCapability> {
    return this.#requireRunning().service.revalidateReplayFromEmbeddedHost(
      this.#hostControlKey,
      this.#options.replayConfig?.()
    );
  }

  async retryReplay(roomCode: string) {
    return this.#requireRunning().service.retryReplayFromEmbeddedHost(
      this.#hostControlKey,
      roomCode
    );
  }

  savedReplay(roomCode: string) {
    return this.#requireRunning().service.savedReplayFromEmbeddedHost(
      this.#hostControlKey,
      roomCode
    );
  }

  async #start(
    port: number,
    bindMode: HostBindMode,
    restart: boolean
  ): Promise<EmbeddedServerStatus> {
    if (this.#running) {
      if (this.#status.actualPort === port && this.#status.bindMode === bindMode) {
        return this.status;
      }
      if (!restart) {
        throw new Error("更改监听端口或模式需要明确确认并重启房间服务");
      }
      this.#setStatus({ ...this.#status, state: "stopping", error: null });
      await this.#closeRunning();
    }
    const boundHost = bindMode === "lan" ? "0.0.0.0" : "127.0.0.1";
    this.#setStatus({
      ...initialStatus(bindMode),
      state: "starting",
      boundHost,
      requestedPort: port,
      lanAddresses: bindMode === "lan" ? enumerateLanAddresses() : []
    });
    try {
      const configuredPublicTarget = this.#options.publicEndpoint?.() ?? null;
      this.#configuredPublicOrigin = configuredPublicTarget
        ? normalizeConnectionTarget(configuredPublicTarget).origin
        : null;
      const running = await startServer({
        host: boundHost,
        port,
        findAvailablePort: false,
        webRoot: this.#webRoot,
        hostControlKey: this.#hostControlKey,
        replayConfig: this.#options.replayConfig?.(),
        additionalAllowedOrigins: this.#configuredPublicOrigin
          ? [this.#configuredPublicOrigin]
          : [],
        trustedProxyAddresses: ["127.0.0.1", "::1"]
      });
      this.#running = running;
      const loopbackOrigin = `http://127.0.0.1:${String(running.port)}`;
      this.#setStatus({
        state: "running",
        bindMode,
        boundHost,
        requestedPort: port,
        actualPort: running.port,
        serverInstanceId: running.serverInstanceId,
        loopbackOrigin,
        lanAddresses: bindMode === "lan" ? enumerateLanAddresses() : [],
        executablePath: process.execPath,
        error: null
      });
      this.#startNetworkMonitor();
      this.#logger.info("内置服务器已启动", {
        requestedPort: port,
        actualPort: running.port,
        bindMode,
        boundHost,
        serverInstanceId: running.serverInstanceId
      });
    } catch (error) {
      const code = errorCode(error);
      const rawMessage = error instanceof Error ? error.message : "内置服务器启动失败";
      const message =
        code === "EADDRINUSE"
          ? `端口 ${String(port)} 已被占用，请关闭占用程序或选择其它端口`
          : rawMessage;
      this.#logger.error("内置服务器启动失败", {
        message: rawMessage,
        code,
        port,
        bindMode
      });
      this.#setStatus({
        ...initialStatus(bindMode),
        state: "error",
        boundHost,
        requestedPort: port,
        lanAddresses: bindMode === "lan" ? enumerateLanAddresses() : [],
        error: `无法启动房间服务：${message}`
      });
    }
    return this.status;
  }

  async #closeRunning(): Promise<void> {
    this.#stopNetworkMonitor();
    const running = this.#running;
    this.#running = null;
    if (!running) {
      return;
    }
    await running.close();
    this.#logger.info("内置服务器已停止", { port: running.port });
  }

  #startNetworkMonitor(): void {
    this.#stopNetworkMonitor();
    if (this.#status.bindMode !== "lan") {
      return;
    }
    this.#networkRefreshTimer = setInterval(() => {
      if (this.#status.state !== "running" || this.#status.bindMode !== "lan") {
        return;
      }
      const next = enumerateLanAddresses();
      if (JSON.stringify(next) !== JSON.stringify(this.#status.lanAddresses)) {
        this.#setStatus({ ...this.#status, lanAddresses: next });
      }
    }, 5_000);
    this.#networkRefreshTimer.unref();
  }

  #stopNetworkMonitor(): void {
    if (this.#networkRefreshTimer) {
      clearInterval(this.#networkRefreshTimer);
      this.#networkRefreshTimer = null;
    }
  }

  #setStatus(status: EmbeddedServerStatus): void {
    this.#status = EmbeddedServerStatusSchema.parse(status);
    for (const listener of this.#listeners) {
      listener(this.status);
    }
  }

  #requireRunning(): RunningServer {
    if (!this.#running) {
      throw new Error("内嵌服务器尚未运行");
    }
    return this.#running;
  }
}
