import { deflateSync } from "node:zlib";

import { describe, expect, it } from "vitest";

import {
  APPLICATION_VERSION,
  ConnectionInfoSchema,
  PROTOCOL_VERSION
} from "@draw-guess/protocol";

import { createApp } from "./app.js";
import type { ServerConfig } from "./config.js";

const TEST_CONFIG: ServerConfig = {
  host: "127.0.0.1",
  port: 3000,
  allowedOrigins: new Set(["http://localhost:5173"]),
  trustedProxyAddresses: new Set(),
  cookieSecure: false,
  roomIdleTtlMs: 60_000,
  reconnectGraceMs: 1_000,
  desktopSessionTtlMs: 60_000,
  turnResultMs: 250
};

function firstHeader(value: string | string[] | undefined): string {
  return Array.isArray(value) ? (value[0] ?? "") : (value ?? "");
}

let crcTable: Uint32Array | null = null;

function crc32(bytes: Uint8Array): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let value = 0; value < 256; value += 1) {
      let crc = value;
      for (let bit = 0; bit < 8; bit += 1) {
        crc = (crc & 1) !== 0 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
      }
      crcTable[value] = crc >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc = (crcTable[(crc ^ byte) & 0xff] ?? 0) ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const typeBytes = new TextEncoder().encode(type);
  const result = new Uint8Array(data.byteLength + 12);
  const view = new DataView(result.buffer);
  view.setUint32(0, data.byteLength);
  result.set(typeBytes, 4);
  result.set(data, 8);
  const crcInput = new Uint8Array(typeBytes.byteLength + data.byteLength);
  crcInput.set(typeBytes);
  crcInput.set(data, typeBytes.byteLength);
  view.setUint32(result.byteLength - 4, crc32(crcInput));
  return result;
}

function transparentAvatarPng(variant = 1): Uint8Array {
  const width = 256;
  const height = 256;
  const signature = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = new Uint8Array(13);
  const view = new DataView(ihdr.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  ihdr.set([8, 6, 0, 0, 0], 8);
  const scanlines = new Uint8Array((width * 4 + 1) * height);
  scanlines[1] = variant;
  scanlines[4] = 128;
  const parts = [
    signature,
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(scanlines)),
    pngChunk("IEND", new Uint8Array())
  ];
  const bytes = new Uint8Array(
    parts.reduce((total, part) => total + part.byteLength, 0)
  );
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.byteLength;
  }
  return bytes;
}

describe("HTTP room integration", () => {
  it("exposes fixed, non-cacheable connection metadata without room state", async () => {
    const { app } = await createApp({
      config: TEST_CONFIG,
      serveStatic: false,
      startCleanup: false,
      serverInstanceId: "s".repeat(43)
    });
    const response = await app.inject({
      method: "GET",
      url: "/api/connection-info"
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("application/json");
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(ConnectionInfoSchema.parse(response.json())).toEqual({
      service: "draw-guess",
      appVersion: APPLICATION_VERSION,
      protocolVersion: PROTOCOL_VERSION,
      serverInstanceId: "s".repeat(43),
      now: expect.any(Number),
      websocketPath: "/ws",
      capabilities: { browser: true, desktop: true }
    });
    expect(response.body).not.toMatch(
      /roomCode|password|player|ffmpeg|token|127\.0\.0\.1/iu
    );
    expect(
      (await app.inject({ method: "GET", url: "/api/connection-info" })).json<{
        serverInstanceId: string;
      }>().serverInstanceId
    ).toBe("s".repeat(43));
    await app.close();
  });

  it("sets Secure cookies only for an explicitly allowed HTTPS origin through a trusted proxy", async () => {
    const config: ServerConfig = {
      ...TEST_CONFIG,
      allowedOrigins: new Set(["https://public.example"]),
      trustedProxyAddresses: new Set(["127.0.0.1"])
    };
    const { app } = await createApp({
      config,
      serveStatic: false,
      startCleanup: false
    });
    const trusted = await app.inject({
      method: "POST",
      url: "/api/rooms",
      remoteAddress: "127.0.0.1",
      headers: {
        host: "127.0.0.1:3000",
        "x-forwarded-proto": "https",
        "x-forwarded-host": "public.example"
      },
      payload: { nickname: "代理房主", password: "secret" }
    });
    expect(trusted.statusCode).toBe(201);
    expect(trusted.headers["set-cookie"]).toContain("Secure");

    const untrusted = await app.inject({
      method: "POST",
      url: "/api/rooms",
      remoteAddress: "10.0.0.8",
      headers: {
        "x-forwarded-proto": "https",
        "x-forwarded-host": "public.example"
      },
      payload: { nickname: "远程伪造", password: "secret" }
    });
    expect(untrusted.statusCode).toBe(201);
    expect(untrusted.headers["set-cookie"]).not.toContain("Secure");
    await app.close();
  });

  it("creates, joins, resumes, and protects public snapshots with HttpOnly sessions", async () => {
    const { app, service } = await createApp({
      config: TEST_CONFIG,
      serveStatic: false,
      startCleanup: false
    });

    const created = await app.inject({
      method: "POST",
      url: "/api/rooms",
      payload: { nickname: "房主", password: "secret" }
    });
    expect(created.statusCode).toBe(201);
    expect(created.headers["set-cookie"]).toContain("HttpOnly");
    expect(created.headers["set-cookie"]).toContain("SameSite=Lax");
    const createdBody = created.json<{
      snapshot: { roomCode: string; selfPlayerId: string };
    }>();
    const roomCode = createdBody.snapshot.roomCode;
    const hostCookie = firstHeader(created.headers["set-cookie"]).split(";")[0]!;

    const wrong = await app.inject({
      method: "POST",
      url: `/api/rooms/${roomCode}/join`,
      payload: { roomCode, nickname: "玩家", password: "wrong" }
    });
    expect(wrong.statusCode).toBe(401);

    const joined = await app.inject({
      method: "POST",
      url: `/api/rooms/${roomCode}/join`,
      payload: { roomCode, nickname: "玩家", password: "secret" }
    });
    expect(joined.statusCode).toBe(200);
    const guestCookie = firstHeader(joined.headers["set-cookie"]).split(";")[0]!;

    const resumed = await app.inject({
      method: "GET",
      url: "/api/session",
      headers: { cookie: guestCookie }
    });
    expect(resumed.statusCode).toBe(200);
    expect(resumed.json().snapshot.players).toHaveLength(2);

    const noSession = await app.inject({
      method: "GET",
      url: `/api/rooms/${roomCode}`
    });
    expect(noSession.statusCode).toBe(401);

    const hostSnapshot = await app.inject({
      method: "GET",
      url: `/api/rooms/${roomCode}`,
      headers: { cookie: hostCookie }
    });
    expect(hostSnapshot.statusCode).toBe(200);
    expect(JSON.stringify(hostSnapshot.json())).not.toContain("secret");

    expect(service.rooms.size).toBe(1);
    await app.close();
    expect(service.rooms.size).toBe(0);
  });

  it("issues typed desktop bearer sessions only to non-browser main-process requests", async () => {
    const { app } = await createApp({
      config: TEST_CONFIG,
      serveStatic: false,
      startCleanup: false
    });

    const forgedBrowser = await app.inject({
      method: "POST",
      url: "/api/desktop/rooms",
      headers: {
        origin: "http://localhost:5173",
        "x-draw-guess-client": "desktop",
        "x-draw-guess-protocol": String(PROTOCOL_VERSION)
      },
      payload: { nickname: "伪造网页", password: "secret" }
    });
    expect(forgedBrowser.statusCode).toBe(403);

    const created = await app.inject({
      method: "POST",
      url: "/api/desktop/rooms",
      headers: {
        "x-draw-guess-client": "desktop",
        "x-draw-guess-protocol": String(PROTOCOL_VERSION)
      },
      payload: { nickname: "桌面玩家", password: "secret" }
    });
    expect(created.statusCode).toBe(201);
    const body = created.json<{
      sessionToken: string;
      expiresAt: number;
      snapshot: { roomCode: string };
    }>();
    expect(body.sessionToken.length).toBeGreaterThan(20);
    expect(body.expiresAt).toBeGreaterThan(Date.now());
    expect(created.headers["set-cookie"]).toBeUndefined();

    const resumed = await app.inject({
      method: "GET",
      url: "/api/desktop/session",
      headers: {
        authorization: `Bearer ${body.sessionToken}`,
        "x-draw-guess-client": "desktop",
        "x-draw-guess-protocol": String(PROTOCOL_VERSION)
      }
    });
    expect(resumed.statusCode).toBe(200);

    await app.close();
  });

  it("temporarily syncs authenticated transparent avatars by revision and ETag", async () => {
    const { app, service } = await createApp({
      config: TEST_CONFIG,
      serveStatic: false,
      startCleanup: false
    });
    const created = await app.inject({
      method: "POST",
      url: "/api/rooms",
      payload: { nickname: "房主", password: "secret" }
    });
    const createdBody = created.json<{
      snapshot: { roomCode: string; selfPlayerId: string };
    }>();
    const roomCode = createdBody.snapshot.roomCode;
    const hostId = createdBody.snapshot.selfPlayerId;
    const hostCookie = firstHeader(created.headers["set-cookie"]).split(";")[0]!;
    const joined = await app.inject({
      method: "POST",
      url: `/api/rooms/${roomCode}/join`,
      payload: { roomCode, nickname: "玩家", password: "secret" }
    });
    const guestCookie = firstHeader(joined.headers["set-cookie"]).split(";")[0]!;
    const firstPng = transparentAvatarPng(1);

    const wrongMime = await app.inject({
      method: "PUT",
      url: `/api/rooms/${roomCode}/me/avatar`,
      headers: {
        cookie: hostCookie,
        "content-type": "image/jpeg"
      },
      payload: Buffer.from(firstPng)
    });
    expect(wrongMime.statusCode).toBe(415);

    const uploaded = await app.inject({
      method: "PUT",
      url: `/api/rooms/${roomCode}/me/avatar`,
      headers: {
        cookie: hostCookie,
        "content-type": "image/png"
      },
      payload: Buffer.from(firstPng)
    });
    expect(uploaded.statusCode).toBe(200);
    const firstRevision = uploaded.json<{ revision: string }>().revision;
    expect(firstRevision).toMatch(/^[a-f0-9]{64}$/);

    const snapshot = await app.inject({
      method: "GET",
      url: `/api/rooms/${roomCode}`,
      headers: { cookie: guestCookie }
    });
    const snapshotBody = snapshot.json<{
      snapshot: {
        players: Array<{ id: string; avatarRevision: string | null }>;
      };
    }>();
    expect(
      snapshotBody.snapshot.players.find((player) => player.id === hostId)
        ?.avatarRevision
    ).toBe(firstRevision);
    expect(JSON.stringify(snapshotBody)).not.toContain(
      Buffer.from(firstPng).toString("base64")
    );
    expect(JSON.stringify(snapshotBody)).not.toContain('"bytes"');

    const avatarUrl = `/api/rooms/${roomCode}/players/${hostId}/avatar/${firstRevision}`;
    expect(
      (
        await app.inject({
          method: "GET",
          url: avatarUrl
        })
      ).statusCode
    ).toBe(401);
    const downloaded = await app.inject({
      method: "GET",
      url: avatarUrl,
      headers: { cookie: guestCookie }
    });
    expect(downloaded.statusCode).toBe(200);
    expect(downloaded.headers["content-type"]).toContain("image/png");
    expect(downloaded.headers["cache-control"]).toContain("private");
    expect(downloaded.headers.etag).toBe(`"${firstRevision}"`);
    expect(downloaded.rawPayload).toEqual(Buffer.from(firstPng));
    expect(
      (
        await app.inject({
          method: "GET",
          url: avatarUrl,
          headers: {
            cookie: guestCookie,
            "if-none-match": `"${firstRevision}"`
          }
        })
      ).statusCode
    ).toBe(304);

    const replaced = await app.inject({
      method: "PUT",
      url: `/api/rooms/${roomCode}/me/avatar`,
      headers: {
        cookie: hostCookie,
        "content-type": "image/png"
      },
      payload: Buffer.from(transparentAvatarPng(2))
    });
    const secondRevision = replaced.json<{ revision: string }>().revision;
    expect(secondRevision).not.toBe(firstRevision);
    expect(
      (
        await app.inject({
          method: "GET",
          url: avatarUrl,
          headers: { cookie: guestCookie }
        })
      ).statusCode
    ).toBe(404);

    expect(
      (
        await app.inject({
          method: "DELETE",
          url: `/api/rooms/${roomCode}/me/avatar`,
          headers: { cookie: hostCookie }
        })
      ).statusCode
    ).toBe(204);
    expect(service.rooms.get(roomCode)?.players.get(hostId)?.avatar).toBeNull();
    service.destroyRoom(roomCode);
    expect(service.rooms.has(roomCode)).toBe(false);
    await app.close();
  });

  it("limits each player's avatar changes to five per minute", async () => {
    const { app } = await createApp({
      config: TEST_CONFIG,
      serveStatic: false,
      startCleanup: false
    });
    const created = await app.inject({
      method: "POST",
      url: "/api/rooms",
      payload: { nickname: "房主", password: "secret" }
    });
    const roomCode = created.json<{ snapshot: { roomCode: string } }>().snapshot
      .roomCode;
    const hostCookie = firstHeader(created.headers["set-cookie"]).split(";")[0]!;
    const statuses: number[] = [];
    for (let index = 0; index < 6; index += 1) {
      const response = await app.inject({
        method: "PUT",
        url: `/api/rooms/${roomCode}/me/avatar`,
        headers: {
          cookie: hostCookie,
          "content-type": "image/png"
        },
        payload: Buffer.from(transparentAvatarPng(index + 1))
      });
      statuses.push(response.statusCode);
    }
    expect(statuses).toEqual([200, 200, 200, 200, 200, 429]);
    await app.close();
  });
});
