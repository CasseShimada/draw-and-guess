import { createHash } from "node:crypto";

import { inspectPng } from "@draw-guess/content";
import sharp from "sharp";

export const REFERENCE_IMAGE_LIMITS = {
  inputBytes: 20 * 1024 * 1024,
  normalizedBytes: 5 * 1024 * 1024,
  maxDimension: 4_096,
  maxPixels: 16_777_216,
  normalizedLongEdge: 2_048
} as const;

export type ReferenceImageMimeType = "image/png" | "image/jpeg" | "image/webp";

export interface ReferenceAsset {
  bytes: Uint8Array;
  revision: string;
  mimeType: ReferenceImageMimeType;
  width: number;
  height: number;
  byteLength: number;
}

function detectedMime(bytes: Uint8Array): ReferenceImageMimeType | null {
  if (
    bytes.byteLength >= 8 &&
    [137, 80, 78, 71, 13, 10, 26, 10].every((value, index) => bytes[index] === value)
  ) {
    return "image/png";
  }
  if (
    bytes.byteLength >= 4 &&
    bytes[0] === 0xff &&
    bytes[1] === 0xd8 &&
    bytes[bytes.byteLength - 2] === 0xff &&
    bytes[bytes.byteLength - 1] === 0xd9
  ) {
    return "image/jpeg";
  }
  if (
    bytes.byteLength >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    const declared =
      new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(
        4,
        true
      ) + 8;
    return declared === bytes.byteLength ? "image/webp" : null;
  }
  return null;
}

export async function normalizeReferenceAsset(
  bytesInput: Uint8Array,
  declaredMimeType: string
): Promise<ReferenceAsset> {
  const bytes = new Uint8Array(bytesInput);
  if (bytes.byteLength === 0 || bytes.byteLength > REFERENCE_IMAGE_LIMITS.inputBytes) {
    throw new Error("参考图必须在 1 字节到 20 MiB 之间");
  }
  const mimeType = detectedMime(bytes);
  if (!mimeType || mimeType !== declaredMimeType) {
    throw new Error("参考图 MIME 与实际静态图片格式不一致");
  }
  if (mimeType === "image/png" && inspectPng(bytes).animated) {
    throw new Error("不支持 APNG 或其它动画参考图");
  }

  const image = sharp(bytes, {
    animated: true,
    failOn: "warning",
    limitInputPixels: REFERENCE_IMAGE_LIMITS.maxPixels
  });
  const metadata = await image.metadata();
  const width = metadata.width ?? 0;
  const height = metadata.height ?? 0;
  if (metadata.pages !== undefined && metadata.pages > 1) {
    throw new Error("只支持静态 PNG、JPEG 或 WebP");
  }
  if (
    width < 1 ||
    height < 1 ||
    width > REFERENCE_IMAGE_LIMITS.maxDimension ||
    height > REFERENCE_IMAGE_LIMITS.maxDimension ||
    width * height > REFERENCE_IMAGE_LIMITS.maxPixels
  ) {
    throw new Error("参考图尺寸或解码像素数超限");
  }

  let pipeline = image.rotate().resize({
    width: REFERENCE_IMAGE_LIMITS.normalizedLongEdge,
    height: REFERENCE_IMAGE_LIMITS.normalizedLongEdge,
    fit: "inside",
    withoutEnlargement: true
  });
  if (mimeType === "image/png") {
    pipeline = pipeline.png({ compressionLevel: 9, adaptiveFiltering: true });
  } else if (mimeType === "image/jpeg") {
    pipeline = pipeline.jpeg({ quality: 90, chromaSubsampling: "4:4:4" });
  } else {
    pipeline = pipeline.webp({ quality: 90, alphaQuality: 100, effort: 4 });
  }
  const output = await pipeline.toBuffer({ resolveWithObject: true });
  if (
    output.data.byteLength === 0 ||
    output.data.byteLength > REFERENCE_IMAGE_LIMITS.normalizedBytes
  ) {
    throw new Error("规范化参考图超过 5 MiB，请降低图片尺寸或复杂度");
  }
  const outputWidth = output.info.width;
  const outputHeight = output.info.height;
  if (
    outputWidth < 1 ||
    outputHeight < 1 ||
    outputWidth * outputHeight > REFERENCE_IMAGE_LIMITS.maxPixels
  ) {
    throw new Error("规范化参考图尺寸无效");
  }
  const normalized = new Uint8Array(output.data);
  return {
    bytes: normalized,
    revision: createHash("sha256").update(normalized).digest("hex"),
    mimeType,
    width: outputWidth,
    height: outputHeight,
    byteLength: normalized.byteLength
  };
}
