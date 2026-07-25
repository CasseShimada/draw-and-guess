import { createHash } from "node:crypto";
import { deflateSync } from "node:zlib";

import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  BUILTIN_WORD_PACK,
  copyWordPack,
  type LocalAvatar,
  type WordPackFile
} from "@draw-guess/content";

import { createBrowserContentServices } from "./content-store.js";

const DATABASE_NAME = "draw-guess-content";
let crcTable: Uint32Array | null = null;

function deleteDatabase(): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(DATABASE_NAME);
    request.addEventListener("success", () => resolve(), { once: true });
    request.addEventListener("blocked", () => reject(new Error("数据库仍被占用")), {
      once: true
    });
    request.addEventListener(
      "error",
      () => reject(request.error ?? new Error("删除测试数据库失败")),
      { once: true }
    );
  });
}

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

function chunk(type: string, data: Uint8Array): Uint8Array {
  const typeBytes = new TextEncoder().encode(type);
  const result = new Uint8Array(data.byteLength + 12);
  const view = new DataView(result.buffer);
  view.setUint32(0, data.byteLength);
  result.set(typeBytes, 4);
  result.set(data, 8);
  const crcInput = new Uint8Array(4 + data.byteLength);
  crcInput.set(typeBytes);
  crcInput.set(data, 4);
  view.setUint32(result.byteLength - 4, crc32(crcInput));
  return result;
}

function transparentAvatar(): LocalAvatar {
  const signature = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = new Uint8Array(13);
  const view = new DataView(ihdr.buffer);
  view.setUint32(0, 256);
  view.setUint32(4, 256);
  ihdr.set([8, 6, 0, 0, 0], 8);
  const scanlines = new Uint8Array((256 * 4 + 1) * 256);
  scanlines[4] = 96;
  const parts = [
    signature,
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(scanlines)),
    chunk("IEND", new Uint8Array())
  ];
  const bytes = new Uint8Array(
    parts.reduce((total, part) => total + part.byteLength, 0)
  );
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.byteLength;
  }
  return {
    schemaVersion: 1,
    mimeType: "image/png",
    width: 256,
    height: 256,
    byteLength: bytes.byteLength,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    updatedAt: "2026-07-25T00:00:00.000Z",
    bytes
  };
}

beforeEach(deleteDatabase);
afterEach(deleteDatabase);

describe("browser IndexedDB content adapters", () => {
  it("fulfills the word-pack and selection store contract without localStorage", async () => {
    const services = createBrowserContentServices();
    expect(await services.wordPacks.list()).toEqual([]);

    const pack = copyWordPack(BUILTIN_WORD_PACK, new Date("2026-07-25T00:00:00.000Z"));
    await services.wordPacks.put(pack);
    expect(await services.wordPacks.list()).toEqual([
      expect.objectContaining({
        id: pack.id,
        name: pack.name,
        builtIn: false
      })
    ]);
    const restored = await services.wordPacks.get(pack.id);
    expect(restored).toEqual(pack);

    const selection = {
      schemaVersion: 1 as const,
      packs: [
        {
          packId: pack.id,
          categoryIds: [pack.categories[0]!.id]
        }
      ]
    };
    await services.wordSelection.put(selection);
    expect(await services.wordSelection.get()).toEqual(selection);

    await expect(services.wordPacks.put(BUILTIN_WORD_PACK)).rejects.toThrow("只读");
    await expect(
      services.wordPacks.put({
        ...pack,
        executable: "<script />"
      } as unknown as WordPackFile)
    ).rejects.toThrow();

    await services.wordPacks.remove(pack.id);
    expect(await services.wordPacks.get(pack.id)).toBeNull();
  });

  it("persists and removes a validated transparent PNG avatar", async () => {
    const services = createBrowserContentServices();
    const avatar = transparentAvatar();
    await services.avatar.put(avatar);
    expect(await services.avatar.getActive()).toEqual(avatar);

    await expect(
      services.avatar.put({
        ...avatar,
        bytes: Uint8Array.from([1, 2, 3]),
        byteLength: 3
      })
    ).rejects.toThrow("PNG");
    expect(await services.avatar.getActive()).toEqual(avatar);

    await services.avatar.remove();
    expect(await services.avatar.getActive()).toBeNull();
  });
});
