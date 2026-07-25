import { deflateSync } from "node:zlib";

import { describe, expect, it } from "vitest";

import {
  inspectPng,
  validateAvatarInputPng,
  validateNormalizedAvatarPng
} from "./avatar-schema.js";

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

function rgbaPng(width: number, height: number, animated = false): Uint8Array {
  const signature = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = new Uint8Array(13);
  const view = new DataView(ihdr.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  ihdr.set([8, 6, 0, 0, 0], 8);
  const scanlines = new Uint8Array((width * 4 + 1) * height);
  const parts = [
    signature,
    chunk("IHDR", ihdr),
    ...(animated ? [chunk("acTL", Uint8Array.from([0, 0, 0, 1, 0, 0, 0, 0]))] : []),
    chunk("IDAT", deflateSync(scanlines)),
    chunk("IEND", new Uint8Array())
  ];
  const result = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

describe("avatar PNG validation", () => {
  it("accepts a static normalized RGBA PNG with transparent pixels", () => {
    const bytes = rgbaPng(256, 256);
    expect(validateNormalizedAvatarPng(bytes)).toMatchObject({
      width: 256,
      height: 256,
      colorType: 6,
      hasAlpha: true,
      animated: false
    });
  });

  it("rejects APNG, bad dimensions, bad CRC, and non-PNG inputs", () => {
    expect(() => validateAvatarInputPng(rgbaPng(256, 256, true))).toThrow("APNG");
    expect(() => validateNormalizedAvatarPng(rgbaPng(128, 128))).toThrow("256 × 256");
    const corrupt = rgbaPng(256, 256);
    corrupt[30] = (corrupt[30] ?? 0) ^ 1;
    expect(() => inspectPng(corrupt)).toThrow("校验失败");
    expect(() => inspectPng(Uint8Array.from([1, 2, 3]))).toThrow("PNG");
  });
});
