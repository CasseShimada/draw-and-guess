import { createHash } from "node:crypto";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { deflateSync } from "node:zlib";

import { afterEach, describe, expect, it } from "vitest";

import {
  BUILTIN_WORD_PACK,
  copyWordPack,
  serializeWordPack,
  type LocalAvatar,
  type WordPackFile
} from "@draw-guess/content";

import {
  ContentStorageService,
  migrateAvatarMetadata
} from "./content-storage-service.js";

const temporaryDirectories: string[] = [];
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

function avatar(): LocalAvatar {
  const signature = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = new Uint8Array(13);
  const view = new DataView(ihdr.buffer);
  view.setUint32(0, 256);
  view.setUint32(4, 256);
  ihdr.set([8, 6, 0, 0, 0], 8);
  const scanlines = new Uint8Array((256 * 4 + 1) * 256);
  scanlines[4] = 64;
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

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

describe("Electron versioned content storage", () => {
  it("persists word packs and selections atomically across service restarts", async () => {
    const userData = await mkdtemp(path.join(tmpdir(), "draw-guess-content-"));
    temporaryDirectories.push(userData);
    const service = new ContentStorageService(userData);
    await service.initialize();
    const pack = copyWordPack(BUILTIN_WORD_PACK, new Date("2026-07-25T00:00:00.000Z"));
    await service.putWordPack(pack);
    const selection = {
      schemaVersion: 1 as const,
      packs: [
        {
          packId: pack.id,
          categoryIds: [pack.categories[0]!.id]
        }
      ]
    };
    await service.putWordSelection(selection);

    const restarted = new ContentStorageService(userData);
    await restarted.initialize();
    expect(await restarted.getWordPack(pack.id)).toEqual(pack);
    expect(await restarted.getWordSelection()).toEqual(selection);
    expect(await restarted.listWordPacks()).toEqual([
      expect.objectContaining({ id: pack.id, builtIn: false })
    ]);

    await expect(
      restarted.putWordPack({
        ...pack,
        activeScript: "alert(1)"
      } as unknown as WordPackFile)
    ).rejects.toThrow();
    expect(await restarted.getWordPack(pack.id)).toEqual(pack);

    const exportPath = path.join(userData, "backup.drawguess-words.json");
    await restarted.saveExport(
      exportPath,
      new TextEncoder().encode(serializeWordPack(pack))
    );
    const before = await readFile(exportPath, "utf8");
    await expect(
      restarted.saveExport(exportPath, Uint8Array.from([1, 2, 3]))
    ).rejects.toThrow();
    expect(await readFile(exportPath, "utf8")).toBe(before);
  });

  it("stores a validated avatar pair, migrates metadata, and cleans it on reset", async () => {
    const userData = await mkdtemp(path.join(tmpdir(), "draw-guess-profile-"));
    temporaryDirectories.push(userData);
    const service = new ContentStorageService(userData);
    await service.initialize();
    const normalized = avatar();
    const validAvatar: LocalAvatar = {
      ...normalized,
      source: {
        mimeType: "image/png",
        width: 256,
        height: 256,
        byteLength: normalized.bytes.byteLength,
        sha256: normalized.sha256,
        bytes: new Uint8Array(normalized.bytes)
      }
    };
    await service.putAvatar(validAvatar);
    expect(await service.getAvatar()).toEqual(validAvatar);
    expect(await readFile(path.join(userData, "profile", "avatar-source.png"))).toEqual(
      Buffer.from(validAvatar.source!.bytes)
    );

    const profileJson = JSON.parse(
      await readFile(path.join(userData, "profile", "profile.json"), "utf8")
    ) as Record<string, unknown>;
    expect(profileJson).toMatchObject({
      schemaVersion: 1,
      mimeType: "image/png",
      width: 256,
      height: 256
    });
    expect(profileJson).not.toHaveProperty("bytes");
    expect(profileJson.source).not.toHaveProperty("bytes");
    expect(migrateAvatarMetadata({ ...profileJson, schemaVersion: 0 })).toMatchObject({
      schemaVersion: 1,
      sha256: validAvatar.sha256
    });

    await expect(
      service.putAvatar({
        ...validAvatar,
        bytes: Uint8Array.from([1, 2, 3]),
        byteLength: 3
      })
    ).rejects.toThrow("PNG");
    expect(await service.getAvatar()).toEqual(validAvatar);

    await service.reset();
    expect(await service.getAvatar()).toBeNull();
    expect(await service.listWordPacks()).toEqual([]);
  });
});
