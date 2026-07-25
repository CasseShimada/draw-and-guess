import type { DesktopSettings, EmbeddedServerStatus } from "../shared/ipc.js";
import type { ConnectionTarget } from "../shared/server-url.js";
import type { EmbeddedServerService } from "./embedded-server-service.js";
import type { GameClientService } from "./game-client-service.js";

export interface LocalRoomServer {
  readonly status: EmbeddedServerStatus;
  start: EmbeddedServerService["start"];
}

export interface LocalRoomSettings {
  readonly settings: Pick<DesktopSettings, "hostPort" | "hostBindMode">;
}

export interface LocalRoomClient {
  createRoom: GameClientService["createRoom"];
}

export class LocalRoomCoordinator {
  readonly #server: LocalRoomServer;
  readonly #settings: LocalRoomSettings;
  readonly #client: LocalRoomClient;

  constructor(
    server: LocalRoomServer,
    settings: LocalRoomSettings,
    client: LocalRoomClient
  ) {
    this.#server = server;
    this.#settings = settings;
    this.#client = client;
  }

  async createRoom(nickname: string, password: string) {
    let status = this.#server.status;
    if (status.state !== "running" || status.actualPort === null) {
      const { hostPort, hostBindMode } = this.#settings.settings;
      status = await this.#server.start(hostPort, hostBindMode, false);
    }
    if (status.state !== "running" || status.actualPort === null) {
      const reason =
        status.error?.replace(/^无法启动房间服务：/u, "") ??
        "服务没有进入运行状态，请检查监听端口";
      throw new Error(`无法启动本机房间服务：${reason}`);
    }

    const target: ConnectionTarget = {
      host: "127.0.0.1",
      port: status.actualPort,
      security: "http"
    };
    const room = await this.#client.createRoom(target, nickname, password, false);
    return {
      ...room,
      target,
      server: status
    };
  }
}
