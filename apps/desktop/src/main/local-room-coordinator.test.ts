import { describe, expect, it, vi } from "vitest";

import type { EmbeddedServerStatus } from "../shared/ipc.js";
import {
  LocalRoomCoordinator,
  type LocalRoomClient,
  type LocalRoomServer,
  type LocalRoomSettings
} from "./local-room-coordinator.js";

function stoppedStatus(): EmbeddedServerStatus {
  return {
    state: "stopped",
    bindMode: "loopback-only",
    boundHost: null,
    requestedPort: null,
    actualPort: null,
    serverInstanceId: null,
    loopbackOrigin: null,
    lanAddresses: [],
    executablePath: null,
    error: null
  };
}

function runningStatus(
  port: number,
  bindMode: EmbeddedServerStatus["bindMode"] = "loopback-only"
): EmbeddedServerStatus {
  return {
    state: "running",
    bindMode,
    boundHost: bindMode === "lan" ? "0.0.0.0" : "127.0.0.1",
    requestedPort: port,
    actualPort: port,
    serverInstanceId: "i".repeat(43),
    loopbackOrigin: `http://127.0.0.1:${String(port)}`,
    lanAddresses: [],
    executablePath: "draw-guess",
    error: null
  };
}

function roomResponse(): Awaited<ReturnType<LocalRoomClient["createRoom"]>> {
  return {
    snapshot: {
      roomCode: "ABC234"
    }
  } as Awaited<ReturnType<LocalRoomClient["createRoom"]>>;
}

describe("local room coordinator", () => {
  it("starts the configured local listener before creating a room", async () => {
    let currentStatus = stoppedStatus();
    const start = vi.fn<LocalRoomServer["start"]>(async (port, bindMode, restart) => {
      expect(restart).toBe(false);
      currentStatus = runningStatus(port, bindMode);
      return currentStatus;
    });
    const server: LocalRoomServer = {
      get status() {
        return structuredClone(currentStatus);
      },
      start
    };
    const settings: LocalRoomSettings = {
      settings: { hostPort: 43_210, hostBindMode: "lan" }
    };
    const createRoom = vi.fn<LocalRoomClient["createRoom"]>(async () => roomResponse());
    const coordinator = new LocalRoomCoordinator(server, settings, { createRoom });

    const result = await coordinator.createRoom("房主", "password");

    expect(start).toHaveBeenCalledWith(43_210, "lan", false);
    expect(createRoom).toHaveBeenCalledWith(
      { host: "127.0.0.1", port: 43_210, security: "http" },
      "房主",
      "password",
      false
    );
    expect(result).toMatchObject({
      target: { host: "127.0.0.1", port: 43_210, security: "http" },
      server: { state: "running", actualPort: 43_210 }
    });
  });

  it("uses the authoritative running port without restarting", async () => {
    const currentStatus = runningStatus(45_678, "lan");
    const start = vi.fn<LocalRoomServer["start"]>();
    const createRoom = vi.fn<LocalRoomClient["createRoom"]>(async () => roomResponse());
    const coordinator = new LocalRoomCoordinator(
      {
        status: currentStatus,
        start
      },
      {
        settings: { hostPort: 30_000, hostBindMode: "loopback-only" }
      },
      { createRoom }
    );

    await coordinator.createRoom("房主", "password");

    expect(start).not.toHaveBeenCalled();
    expect(createRoom).toHaveBeenCalledWith(
      { host: "127.0.0.1", port: 45_678, security: "http" },
      "房主",
      "password",
      false
    );
  });

  it("reports a local listener failure instead of a remote connection diagnosis", async () => {
    const failedStatus: EmbeddedServerStatus = {
      ...stoppedStatus(),
      state: "error",
      boundHost: "127.0.0.1",
      requestedPort: 32_100,
      error: "无法启动房间服务：端口 32100 已被占用，请选择其它端口"
    };
    const start = vi.fn<LocalRoomServer["start"]>(async () => failedStatus);
    const createRoom = vi.fn<LocalRoomClient["createRoom"]>(async () => roomResponse());
    const coordinator = new LocalRoomCoordinator(
      {
        status: stoppedStatus(),
        start
      },
      {
        settings: { hostPort: 32_100, hostBindMode: "loopback-only" }
      },
      { createRoom }
    );

    await expect(coordinator.createRoom("房主", "password")).rejects.toThrow(
      "无法启动本机房间服务：端口 32100 已被占用"
    );
    expect(createRoom).not.toHaveBeenCalled();
  });
});
