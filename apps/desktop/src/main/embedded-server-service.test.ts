import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { EmbeddedServerService } from "./embedded-server-service.js";
import { RedactingLogger } from "./redacting-logger.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

describe("embedded server service", () => {
  it("starts on an available port and closes idempotently", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "draw-guess-server-"));
    directories.push(directory);
    const service = new EmbeddedServerService(
      path.join(directory, "missing-web"),
      new RedactingLogger(directory)
    );
    const status = await service.start(31_000, false);
    expect(status.state).toBe("running");
    expect(status.localUrls[0]).toMatch(/^http:\/\/127\.0\.0\.1:/);
    await service.stop();
    expect(service.status.state).toBe("stopped");
    await service.stop();
    expect(service.status.state).toBe("stopped");
  });

  it("moves to a bounded fallback port when the requested port is occupied", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "draw-guess-server-"));
    directories.push(directory);
    const blocker = createServer();
    await new Promise<void>((resolve, reject) => {
      blocker.once("error", reject);
      blocker.listen(0, "127.0.0.1", () => resolve());
    });
    const address = blocker.address();
    if (!address || typeof address === "string") {
      throw new Error("failed to allocate occupied test port");
    }
    const service = new EmbeddedServerService(
      path.join(directory, "missing-web"),
      new RedactingLogger(directory)
    );
    try {
      const status = await service.start(address.port, false);
      expect(status.state).toBe("running");
      expect(status.requestedPort).toBe(address.port);
      expect(status.actualPort).not.toBe(address.port);
      expect(status.usedFallbackPort).toBe(true);
    } finally {
      await service.stop();
      await new Promise<void>((resolve, reject) =>
        blocker.close((error) => (error ? reject(error) : resolve()))
      );
    }
  });
});
