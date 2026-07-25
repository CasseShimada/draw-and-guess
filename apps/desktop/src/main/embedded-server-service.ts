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
import type { RedactingLogger } from "./redacting-logger.js";

type StatusListener = (status: EmbeddedServerStatus) => void;

export interface EmbeddedServerServiceOptions {
  replayConfig?: () => ReplayHostConfig;
}

function initialStatus(): EmbeddedServerStatus {
  return {
    state: "stopped",
    requestedPort: null,
    actualPort: null,
    allowLan: false,
    localUrls: [],
    lanUrls: [],
    usedFallbackPort: false,
    error: null
  };
}

function localNetworkAddresses(): string[] {
  const addresses = new Set<string>();
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (
        entry.family === "IPv4" &&
        !entry.internal &&
        entry.address !== "0.0.0.0" &&
        !entry.address.startsWith("169.254.")
      ) {
        addresses.add(entry.address);
      }
    }
  }
  return [...addresses].sort();
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

  async start(port: number, allowLan: boolean): Promise<EmbeddedServerStatus> {
    if (this.#operation) {
      return this.#operation;
    }
    this.#operation = this.#start(port, allowLan).finally(() => {
      this.#operation = null;
    });
    return this.#operation;
  }

  async stop(): Promise<EmbeddedServerStatus> {
    if (this.#operation) {
      await this.#operation.catch(() => undefined);
    }
    if (!this.#running) {
      this.#setStatus(initialStatus());
      return this.status;
    }
    this.#setStatus({ ...this.#status, state: "stopping", error: null });
    const running = this.#running;
    this.#running = null;
    await running.close();
    this.#logger.info("内置服务器已停止", { port: running.port });
    this.#setStatus(initialStatus());
    return this.status;
  }

  pause(roomCode: string): void {
    const running = this.#requireRunning();
    running.service.pauseFromEmbeddedHost(this.#hostControlKey, roomCode);
  }

  resume(roomCode: string): void {
    const running = this.#requireRunning();
    running.service.resumeFromEmbeddedHost(this.#hostControlKey, roomCode);
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

  async #start(port: number, allowLan: boolean): Promise<EmbeddedServerStatus> {
    if (this.#running) {
      const previous = this.#running;
      this.#running = null;
      await previous.close();
    }
    this.#setStatus({
      ...initialStatus(),
      state: "starting",
      requestedPort: port,
      allowLan
    });
    try {
      const running = await startServer({
        host: allowLan ? "0.0.0.0" : "127.0.0.1",
        port,
        findAvailablePort: true,
        maxPortAttempts: 20,
        webRoot: this.#webRoot,
        hostControlKey: this.#hostControlKey,
        replayConfig: this.#options.replayConfig?.()
      });
      this.#running = running;
      const localUrl = `http://127.0.0.1:${String(running.port)}`;
      const lanUrls = allowLan
        ? localNetworkAddresses().map(
            (address) => `http://${address}:${String(running.port)}`
          )
        : [];
      this.#setStatus({
        state: "running",
        requestedPort: port,
        actualPort: running.port,
        allowLan,
        localUrls: [localUrl],
        lanUrls,
        usedFallbackPort: running.usedFallbackPort,
        error: null
      });
      this.#logger.info("内置服务器已启动", {
        requestedPort: port,
        actualPort: running.port,
        allowLan,
        usedFallbackPort: running.usedFallbackPort
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "内置服务器启动失败";
      this.#logger.error("内置服务器启动失败", { message, port, allowLan });
      this.#setStatus({
        ...initialStatus(),
        state: "error",
        requestedPort: port,
        allowLan,
        error: `无法启动房间服务：${message}`
      });
    }
    return this.status;
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
