import { deflateSync } from "node:zlib";

import sharp from "sharp";
import { describe, expect, it } from "vitest";

import { REFERENCE_IMAGE_LIMITS, normalizeReferenceAsset } from "./reference-assets.js";

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

function chunk(type: string, data: Uint8Array): Uint8Array {
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

function animatedPng(): Uint8Array {
  const signature = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = new Uint8Array(13);
  const view = new DataView(ihdr.buffer);
  view.setUint32(0, 2);
  view.setUint32(4, 2);
  ihdr.set([8, 6, 0, 0, 0], 8);
  const scanlines = new Uint8Array((2 * 4 + 1) * 2);
  const parts = [
    signature,
    chunk("IHDR", ihdr),
    chunk("acTL", Uint8Array.from([0, 0, 0, 1, 0, 0, 0, 0])),
    chunk("IDAT", deflateSync(scanlines)),
    chunk("IEND", new Uint8Array())
  ];
  const output = new Uint8Array(
    parts.reduce((total, part) => total + part.byteLength, 0)
  );
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.byteLength;
  }
  return output;
}

async function animatedWebp(): Promise<Uint8Array> {
  const width = 2;
  const pageHeight = 2;
  const height = pageHeight * 2;
  const pixels = Buffer.alloc(width * height * 4);
  for (let offset = 0; offset < pixels.length; offset += 4) {
    const firstPage = offset < width * pageHeight * 4;
    pixels[offset] = firstPage ? 255 : 0;
    pixels[offset + 1] = firstPage ? 0 : 255;
    pixels[offset + 3] = 255;
  }
  return new Uint8Array(
    await sharp(pixels, {
      raw: { width, height, channels: 4, pageHeight }
    })
      .webp({ loop: 0, delay: [100, 100] })
      .toBuffer()
  );
}

describe("reference asset normalization", () => {
  it("preserves transparent PNG and static WebP while stripping metadata", async () => {
    const png = await sharp({
      create: {
        width: 17,
        height: 11,
        channels: 4,
        background: { r: 10, g: 20, b: 30, alpha: 0.25 }
      }
    })
      .withMetadata({
        density: 144,
        exif: { IFD0: { ImageDescription: "private-source-name.png" } }
      })
      .png()
      .toBuffer();
    const normalizedPng = await normalizeReferenceAsset(
      new Uint8Array(png),
      "image/png"
    );
    expect(normalizedPng).toMatchObject({
      mimeType: "image/png",
      width: 17,
      height: 11,
      byteLength: normalizedPng.bytes.byteLength
    });
    expect(normalizedPng.revision).toMatch(/^[a-f0-9]{64}$/u);
    const pngMetadata = await sharp(normalizedPng.bytes).metadata();
    expect(pngMetadata.hasAlpha).toBe(true);
    expect(pngMetadata.exif).toBeUndefined();

    const webp = await sharp({
      create: {
        width: 13,
        height: 7,
        channels: 4,
        background: { r: 100, g: 20, b: 200, alpha: 0.5 }
      }
    })
      .webp()
      .toBuffer();
    const normalizedWebp = await normalizeReferenceAsset(
      new Uint8Array(webp),
      "image/webp"
    );
    expect(normalizedWebp).toMatchObject({
      mimeType: "image/webp",
      width: 13,
      height: 7
    });
    expect((await sharp(normalizedWebp.bytes).metadata()).hasAlpha).toBe(true);
  });

  it("applies JPEG EXIF orientation before reporting normalized dimensions", async () => {
    const jpeg = await sharp({
      create: {
        width: 9,
        height: 5,
        channels: 3,
        background: { r: 220, g: 120, b: 20 }
      }
    })
      .withMetadata({ orientation: 6 })
      .jpeg()
      .toBuffer();
    expect((await sharp(jpeg).metadata()).orientation).toBe(6);
    const normalized = await normalizeReferenceAsset(
      new Uint8Array(jpeg),
      "image/jpeg"
    );
    expect(normalized).toMatchObject({
      mimeType: "image/jpeg",
      width: 5,
      height: 9
    });
    expect((await sharp(normalized.bytes).metadata()).orientation).toBeUndefined();
  });

  it("rejects animation, MIME spoofing, active formats, corruption, and limits", async () => {
    await expect(normalizeReferenceAsset(animatedPng(), "image/png")).rejects.toThrow(
      "APNG"
    );
    await expect(
      normalizeReferenceAsset(await animatedWebp(), "image/webp")
    ).rejects.toThrow("静态");

    const png = new Uint8Array(
      await sharp({
        create: {
          width: 2,
          height: 2,
          channels: 4,
          background: { r: 0, g: 0, b: 0, alpha: 0 }
        }
      })
        .png()
        .toBuffer()
    );
    await expect(normalizeReferenceAsset(png, "image/jpeg")).rejects.toThrow("MIME");
    await expect(
      normalizeReferenceAsset(
        new TextEncoder().encode(
          '<svg xmlns="http://www.w3.org/2000/svg"><script/></svg>'
        ),
        "image/svg+xml"
      )
    ).rejects.toThrow("MIME");
    await expect(
      normalizeReferenceAsset(png.subarray(0, png.byteLength - 5), "image/png")
    ).rejects.toThrow();
    await expect(
      normalizeReferenceAsset(
        new Uint8Array(REFERENCE_IMAGE_LIMITS.inputBytes + 1),
        "image/png"
      )
    ).rejects.toThrow("20 MiB");

    const tooWide = new Uint8Array(
      await sharp({
        create: {
          width: REFERENCE_IMAGE_LIMITS.maxDimension + 1,
          height: 1,
          channels: 4,
          background: { r: 0, g: 0, b: 0, alpha: 0 }
        }
      })
        .png()
        .toBuffer()
    );
    await expect(normalizeReferenceAsset(tooWide, "image/png")).rejects.toThrow("超限");
  });
});
