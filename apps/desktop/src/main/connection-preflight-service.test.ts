import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { PROTOCOL_VERSION } from "@draw-guess/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ConnectionPreflightService } from "./connection-preflight-service.js";
import { RedactingLogger } from "./redacting-logger.js";
import { SettingsService, type EncryptionProvider } from "./settings-service.js";

const directories: string[] = [];

const encryption: EncryptionProvider = {
  isAvailable: () => false,
  backend: () => "unavailable",
  encrypt: (value) => Buffer.from(value),
  decrypt: (value) => Buffer.from(value).toString("utf8")
};

async function dependencies(fetchImplementation: typeof fetch) {
  const directory = await mkdtemp(path.join(tmpdir(), "draw-guess-preflight-"));
  directories.push(directory);
  const settings = new SettingsService(directory, encryption);
  await settings.initialize();
  return {
    settings,
    service: new ConnectionPreflightService(settings, new RedactingLogger(directory), {
      fetch: fetchImplementation,
      timeoutMs: 50
    })
  };
}

function info(overrides: Record<string, unknown> = {}) {
  return {
    service: "draw-guess",
    appVersion: "0.5.0",
    protocolVersion: PROTOCOL_VERSION,
    serverInstanceId: "a".repeat(43),
    now: Date.now(),
    websocketPath: "/ws",
    capabilities: { browser: true, desktop: true },
    ...overrides
  };
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

describe("connection preflight", () => {
  it("returns invalid-input before performing network I/O", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    const { service } = await dependencies(fetchMock);
    expect(
      await service.test({
        host: "example.com",
        port: 0,
        security: "https"
      })
    ).toMatchObject({
      ok: false,
      code: "invalid-input",
      target: null
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("requests a bounded credential-free endpoint without following redirects", async () => {
    const fetchMock = vi.fn<typeof fetch>(async (_input, init) => {
      expect(init?.redirect).toBe("error");
      expect(init?.credentials).toBe("omit");
      expect(new Headers(init?.headers).has("authorization")).toBe(false);
      expect(new Headers(init?.headers).has("cookie")).toBe(false);
      return new Response(JSON.stringify(info()), {
        status: 200,
        headers: { "content-type": "application/json; charset=utf-8" }
      });
    });
    const { service } = await dependencies(fetchMock);
    const result = await service.test({
      host: "192.168.1.20",
      port: 3000,
      security: "http"
    });
    expect(result).toMatchObject({
      ok: true,
      code: "success",
      target: { origin: "http://192.168.1.20:3000" },
      info: { protocolVersion: PROTOCOL_VERSION }
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "http://192.168.1.20:3000/api/connection-info",
      expect.any(Object)
    );
  });

  it.each([
    [
      Object.assign(new TypeError("fetch failed"), {
        cause: { code: "ENOTFOUND" }
      }),
      "dns-failed"
    ],
    [
      Object.assign(new TypeError("fetch failed"), {
        cause: { code: "ECONNREFUSED" }
      }),
      "connection-refused"
    ],
    [
      Object.assign(new TypeError("fetch failed"), {
        cause: { code: "UND_ERR_CONNECT_TIMEOUT" }
      }),
      "timeout"
    ],
    [
      Object.assign(new TypeError("fetch failed"), {
        cause: { code: "CERT_HAS_EXPIRED" }
      }),
      "tls-failed"
    ]
  ])("classifies network failure %#", async (failure, expectedCode) => {
    const fetchMock = vi.fn<typeof fetch>(async () => {
      throw failure;
    });
    const { service } = await dependencies(fetchMock);
    const result = await service.test({
      host: "example.com",
      port: 443,
      security: "https"
    });
    expect(result).toMatchObject({ ok: false, code: expectedCode });
  });

  it("distinguishes wrong services, protocol mismatch, and oversized bodies", async () => {
    const responses = [
      new Response("<html>wrong</html>", {
        status: 200,
        headers: { "content-type": "text/html" }
      }),
      new Response(JSON.stringify(info({ protocolVersion: PROTOCOL_VERSION + 1 })), {
        status: 200,
        headers: { "content-type": "application/json" }
      }),
      new Response(JSON.stringify({ payload: "x".repeat(17 * 1024) }), {
        status: 200,
        headers: { "content-type": "application/json" }
      })
    ];
    const fetchMock = vi.fn<typeof fetch>(async () => responses.shift()!);
    const { service } = await dependencies(fetchMock);
    const target = { host: "example.com", port: 443, security: "https" as const };
    expect(await service.test(target)).toMatchObject({
      ok: false,
      code: "wrong-service"
    });
    expect(await service.test(target)).toMatchObject({
      ok: false,
      code: "protocol-mismatch"
    });
    expect(await service.test(target)).toMatchObject({
      ok: false,
      code: "wrong-service"
    });
  });

  it("requires endpoint-bound confirmation before public HTTP and never downgrades TLS", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => {
      throw Object.assign(new TypeError("certificate failed"), {
        cause: { code: "CERT_HAS_EXPIRED" }
      });
    });
    const { service, settings } = await dependencies(fetchMock);
    const publicHttp = {
      host: "public.example",
      port: 45_678,
      security: "http" as const
    };
    expect(await service.test(publicHttp)).toMatchObject({
      ok: false,
      code: "insecure-confirmation"
    });
    expect(fetchMock).not.toHaveBeenCalled();

    await service.test(publicHttp, true);
    expect(settings.insecureHttpConfirmed(publicHttp)).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const httpsTarget = {
      host: "public.example",
      port: 443,
      security: "https" as const
    };
    expect(await service.test(httpsTarget)).toMatchObject({
      ok: false,
      code: "tls-failed"
    });
    expect(fetchMock).toHaveBeenLastCalledWith(
      "https://public.example/api/connection-info",
      expect.any(Object)
    );
    expect(
      fetchMock.mock.calls.some(([url]) => String(url).startsWith("http://"))
    ).toBe(true);
    expect(
      fetchMock.mock.calls.filter(([url]) =>
        String(url).startsWith("https://public.example")
      )
    ).toHaveLength(1);
  });
});
