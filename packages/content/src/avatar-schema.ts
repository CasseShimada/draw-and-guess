import { z } from "zod";

import { CONTENT_LIMITS } from "./content-limits.js";

const PNG_SIGNATURE = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]);
const BinarySchema = z.custom<Uint8Array>(
  (value) => value instanceof Uint8Array,
  "头像 bytes 必须是 Uint8Array"
);

export const LocalAvatarSourceSchema = z
  .object({
    mimeType: z.literal("image/png"),
    width: z.number().int().positive().max(CONTENT_LIMITS.avatarInputMaxDimension),
    height: z.number().int().positive().max(CONTENT_LIMITS.avatarInputMaxDimension),
    byteLength: z.number().int().positive().max(CONTENT_LIMITS.avatarInputBytes),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    bytes: BinarySchema
  })
  .strict()
  .superRefine((source, context) => {
    if (source.bytes.byteLength !== source.byteLength) {
      context.addIssue({
        code: "custom",
        message: "头像源文件字节长度与元数据不一致",
        path: ["byteLength"]
      });
    }
    if (source.width * source.height > CONTENT_LIMITS.avatarInputMaxPixels) {
      context.addIssue({
        code: "custom",
        message: "头像源文件像素数超限",
        path: ["width"]
      });
    }
  });

export const LocalAvatarSchema = z
  .object({
    schemaVersion: z.literal(1),
    mimeType: z.literal("image/png"),
    width: z.literal(CONTENT_LIMITS.avatarDimension),
    height: z.literal(CONTENT_LIMITS.avatarDimension),
    byteLength: z.number().int().positive().max(CONTENT_LIMITS.avatarBytes),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    updatedAt: z.string().datetime({ offset: true }),
    bytes: BinarySchema,
    source: LocalAvatarSourceSchema.optional()
  })
  .strict()
  .superRefine((avatar, context) => {
    if (avatar.bytes.byteLength !== avatar.byteLength) {
      context.addIssue({
        code: "custom",
        message: "头像字节长度与元数据不一致",
        path: ["byteLength"]
      });
    }
  });

export type LocalAvatar = z.infer<typeof LocalAvatarSchema>;

export interface PngInfo {
  width: number;
  height: number;
  bitDepth: number;
  colorType: number;
  interlace: number;
  hasAlpha: boolean;
  animated: boolean;
  idatChunks: Uint8Array[];
}

function readUint32(bytes: Uint8Array, offset: number): number {
  return new DataView(bytes.buffer, bytes.byteOffset + offset, 4).getUint32(0);
}

let crcTable: Uint32Array | null = null;

function table(): Uint32Array {
  if (crcTable) {
    return crcTable;
  }
  crcTable = new Uint32Array(256);
  for (let value = 0; value < 256; value += 1) {
    let crc = value;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc & 1) !== 0 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
    }
    crcTable[value] = crc >>> 0;
  }
  return crcTable;
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  const values = table();
  for (const byte of bytes) {
    crc = (values[(crc ^ byte) & 0xff] ?? 0) ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

export function inspectPng(bytes: Uint8Array): PngInfo {
  if (
    bytes.byteLength < 33 ||
    !PNG_SIGNATURE.every((value, index) => bytes[index] === value)
  ) {
    throw new Error("文件不是有效的 PNG");
  }
  let offset = PNG_SIGNATURE.length;
  let ihdr:
    | {
        width: number;
        height: number;
        bitDepth: number;
        colorType: number;
        interlace: number;
      }
    | undefined;
  let animated = false;
  let hasTransparencyChunk = false;
  let ended = false;
  const idatChunks: Uint8Array[] = [];
  while (offset + 12 <= bytes.byteLength) {
    const length = readUint32(bytes, offset);
    const chunkEnd = offset + 12 + length;
    if (length > bytes.byteLength || chunkEnd > bytes.byteLength) {
      throw new Error("PNG 数据块长度无效");
    }
    const typeBytes = bytes.subarray(offset + 4, offset + 8);
    const type = new TextDecoder("ascii", { fatal: true }).decode(typeBytes);
    const data = bytes.subarray(offset + 8, offset + 8 + length);
    const expectedCrc = readUint32(bytes, offset + 8 + length);
    const crcInput = new Uint8Array(4 + data.byteLength);
    crcInput.set(typeBytes);
    crcInput.set(data, 4);
    if (crc32(crcInput) !== expectedCrc) {
      throw new Error(`PNG ${type} 数据块校验失败`);
    }
    if (!ihdr) {
      if (type !== "IHDR" || length !== 13) {
        throw new Error("PNG 必须以 IHDR 数据块开始");
      }
      ihdr = {
        width: readUint32(data, 0),
        height: readUint32(data, 4),
        bitDepth: data[8] ?? -1,
        colorType: data[9] ?? -1,
        interlace: data[12] ?? -1
      };
      if (
        ihdr.width < 1 ||
        ihdr.height < 1 ||
        (data[10] ?? -1) !== 0 ||
        (data[11] ?? -1) !== 0 ||
        (ihdr.interlace !== 0 && ihdr.interlace !== 1)
      ) {
        throw new Error("PNG IHDR 参数无效");
      }
    } else if (type === "IHDR") {
      throw new Error("PNG 不能包含多个 IHDR 数据块");
    }
    if (type === "acTL") {
      animated = true;
    } else if (type === "tRNS") {
      hasTransparencyChunk = true;
    } else if (type === "IDAT") {
      idatChunks.push(data.slice());
    } else if (type === "IEND") {
      if (length !== 0 || chunkEnd !== bytes.byteLength) {
        throw new Error("PNG IEND 数据块无效");
      }
      ended = true;
      break;
    }
    offset = chunkEnd;
  }
  if (!ihdr || !ended || idatChunks.length === 0) {
    throw new Error("PNG 缺少必要数据块");
  }
  return {
    ...ihdr,
    hasAlpha: ihdr.colorType === 4 || ihdr.colorType === 6 || hasTransparencyChunk,
    animated,
    idatChunks
  };
}

export function validateAvatarInputPng(bytes: Uint8Array): PngInfo {
  if (bytes.byteLength === 0 || bytes.byteLength > CONTENT_LIMITS.avatarInputBytes) {
    throw new Error("PNG 头像源文件不能超过 10 MiB");
  }
  const info = inspectPng(bytes);
  if (info.animated) {
    throw new Error("不支持 APNG 或动画头像");
  }
  if (
    info.width > CONTENT_LIMITS.avatarInputMaxDimension ||
    info.height > CONTENT_LIMITS.avatarInputMaxDimension ||
    info.width * info.height > CONTENT_LIMITS.avatarInputMaxPixels
  ) {
    throw new Error("头像尺寸或解码像素数超限");
  }
  return info;
}

export function validateNormalizedAvatarPng(bytes: Uint8Array): PngInfo {
  if (bytes.byteLength === 0 || bytes.byteLength > CONTENT_LIMITS.avatarBytes) {
    throw new Error("规范化头像不能超过 512 KiB");
  }
  const info = inspectPng(bytes);
  if (info.animated) {
    throw new Error("规范化头像必须是静态 PNG");
  }
  if (
    info.width !== CONTENT_LIMITS.avatarDimension ||
    info.height !== CONTENT_LIMITS.avatarDimension ||
    info.bitDepth !== 8 ||
    info.colorType !== 6 ||
    info.interlace !== 0
  ) {
    throw new Error("头像必须是 256 × 256、8 位 RGBA 静态 PNG");
  }
  return info;
}
