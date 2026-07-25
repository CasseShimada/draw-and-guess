import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";

import { ConnectionInfoSchema } from "@draw-guess/protocol";
import { afterEach, describe, expect, it } from "vitest";

import {
  EmbeddedServerService,
  enumerateLanAddresses
} from "./embedded-server-service.js";
import { RedactingLogger } from "./redacting-logger.js";

const directories: string[] = [];

async function availablePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve, reject) => {
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => resolve());
  });
  const address = probe.address();
  if (!address || typeof address === "string") {
    throw new Error("failed to allocate test port");
  }
  await new Promise<void>((resolve, reject) =>
    probe.close((error) => (error ? reject(error) : resolve()))
  );
  return address.port;
}

async function testService(): Promise<EmbeddedServerService> {
  const directory = await mkdtemp(path.join(tmpdir(), "draw-guess-server-"));
  directories.push(directory);
  return new EmbeddedServerService(
    path.join(directory, "missing-web"),
    new RedactingLogger(directory)
  );
}

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

describe("embedded server service", () => {
  it("authoritatively binds loopback and closes idempotently", async () => {
    const service = await testService();
    const port = await availablePort();
    const status = await service.start(port, "loopback-only");
    expect(status).toMatchObject({
      state: "running",
      bindMode: "loopback-only",
      boundHost: "127.0.0.1",
      requestedPort: port,
      actualPort: port,
      loopbackOrigin: `http://127.0.0.1:${String(port)}`
    });
    expect(status.serverInstanceId).toHaveLength(43);
    expect(status.lanAddresses).toEqual([]);
    await service.stop();
    expect(service.status.state).toBe("stopped");
    await service.stop();
    expect(service.status.state).toBe("stopped");
  });

  it("fails on an occupied requested port instead of silently changing it", async () => {
    const blocker = createServer();
    await new Promise<void>((resolve, reject) => {
      blocker.once("error", reject);
      blocker.listen(0, "127.0.0.1", () => resolve());
    });
    const address = blocker.address();
    if (!address || typeof address === "string") {
      throw new Error("failed to allocate occupied test port");
    }
    const service = await testService();
    try {
      const status = await service.start(address.port, "loopback-only");
      expect(status.state).toBe("error");
      expect(status.requestedPort).toBe(address.port);
      expect(status.actualPort).toBeNull();
      expect(status.error).toContain("已被占用");
    } finally {
      await service.stop();
      await new Promise<void>((resolve, reject) =>
        blocker.close((error) => (error ? reject(error) : resolve()))
      );
    }
  });

  it("binds LAN mode to all IPv4 interfaces with named address metadata", async () => {
    const service = await testService();
    const port = await availablePort();
    try {
      const status = await service.start(port, "lan");
      expect(status).toMatchObject({
        state: "running",
        bindMode: "lan",
        boundHost: "0.0.0.0",
        requestedPort: port,
        actualPort: port
      });
      for (const address of status.lanAddresses) {
        expect(address.interfaceName).not.toBe("");
        expect(address.address).not.toBe("0.0.0.0");
        expect(address.address.startsWith("127.")).toBe(false);
        expect(address.netmask).not.toBe("");
      }
      const info = ConnectionInfoSchema.parse(
        await (
          await fetch(`http://127.0.0.1:${String(port)}/api/connection-info`)
        ).json()
      );
      expect(info.service).toBe("draw-guess");
    } finally {
      await service.stop();
    }
  });

  it("keeps running authority unchanged until an explicit restart is requested", async () => {
    const service = await testService();
    const firstPort = await availablePort();
    let secondPort = await availablePort();
    while (secondPort === firstPort) {
      secondPort = await availablePort();
    }
    try {
      const first = await service.start(firstPort, "loopback-only");
      expect(first).toMatchObject({
        state: "running",
        boundHost: "127.0.0.1",
        actualPort: firstPort
      });
      await expect(service.start(secondPort, "lan", false)).rejects.toThrow("明确确认");
      expect(service.status).toMatchObject({
        state: "running",
        boundHost: "127.0.0.1",
        actualPort: firstPort
      });
      const restarted = await service.start(secondPort, "lan", true);
      expect(restarted).toMatchObject({
        state: "running",
        boundHost: "0.0.0.0",
        actualPort: secondPort
      });
      expect(restarted.serverInstanceId).not.toBe(first.serverInstanceId);
    } finally {
      await service.stop();
    }
  });

  const physicalAddress = enumerateLanAddresses()[0]?.address;
  it.skipIf(!physicalAddress)(
    "reaches a LAN-bound socket through a non-loopback interface",
    async () => {
      const service = await testService();
      const port = await availablePort();
      try {
        const status = await service.start(port, "lan");
        expect(status.state).toBe("running");
        const response = await fetch(
          `http://${physicalAddress!}:${String(port)}/api/connection-info`,
          { signal: AbortSignal.timeout(2_000) }
        );
        expect(response.status).toBe(200);
        expect(ConnectionInfoSchema.parse(await response.json()).service).toBe(
          "draw-guess"
        );
      } finally {
        await service.stop();
      }
    }
  );
});
