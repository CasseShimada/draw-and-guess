import { cropToSourcePixels, fitWithinLongEdge, type NormalizedCrop } from "./crop.js";

export interface EncodingOptions {
  maxLongEdge: number;
  preferredMimeType: "image/webp" | "image/jpeg";
  jpegFallbackQuality: number;
  webpQuality: number;
  targetFrameBytes: number;
  hardMaxFrameBytes: number;
}

export const DEFAULT_ENCODING_OPTIONS: EncodingOptions = {
  maxLongEdge: 1280,
  preferredMimeType: "image/webp",
  jpegFallbackQuality: 0.7,
  webpQuality: 0.65,
  targetFrameBytes: 300 * 1024,
  hardMaxFrameBytes: 2 * 1024 * 1024
};

export interface EncodingAttempt {
  mimeType: "image/webp" | "image/jpeg";
  quality: number;
  scale: number;
}

export interface EncodedFrame {
  bytes: Uint8Array;
  mimeType: "image/webp" | "image/jpeg";
  width: number;
  height: number;
  quality: number;
}

interface CanvasTarget {
  canvas: HTMLCanvasElement | OffscreenCanvas;
  context: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
}

export type CanvasFactory = (width: number, height: number) => CanvasTarget;

export function buildEncodingAttempts(
  options: EncodingOptions = DEFAULT_ENCODING_OPTIONS
): EncodingAttempt[] {
  const mimeTypes: Array<EncodingAttempt["mimeType"]> =
    options.preferredMimeType === "image/webp"
      ? ["image/webp", "image/jpeg"]
      : ["image/jpeg"];
  const scales = [1, 0.85, 0.7, 0.55, 0.4];
  const attempts: EncodingAttempt[] = [];
  for (const scale of scales) {
    for (const mimeType of mimeTypes) {
      const baseQuality =
        mimeType === "image/webp" ? options.webpQuality : options.jpegFallbackQuality;
      for (const qualityMultiplier of [1, 0.82, 0.66]) {
        attempts.push({
          mimeType,
          quality: Math.max(0.2, baseQuality * qualityMultiplier),
          scale
        });
      }
    }
  }
  return attempts;
}

function defaultCanvasFactory(width: number, height: number): CanvasTarget {
  if (typeof OffscreenCanvas !== "undefined") {
    const canvas = new OffscreenCanvas(width, height);
    const context = canvas.getContext("2d", { alpha: false });
    if (!context) {
      throw new Error("无法创建离屏 Canvas");
    }
    return { canvas, context };
  }
  if (typeof document === "undefined") {
    throw new Error("当前环境没有可用 Canvas");
  }
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d", { alpha: false });
  if (!context) {
    throw new Error("无法创建 Canvas");
  }
  return { canvas, context };
}

async function canvasToBlob(
  canvas: HTMLCanvasElement | OffscreenCanvas,
  mimeType: EncodingAttempt["mimeType"],
  quality: number
): Promise<Blob | null> {
  if (typeof OffscreenCanvas !== "undefined" && canvas instanceof OffscreenCanvas) {
    try {
      return await canvas.convertToBlob({ type: mimeType, quality });
    } catch {
      return null;
    }
  }
  return new Promise((resolve) => {
    (canvas as HTMLCanvasElement).toBlob(resolve, mimeType, quality);
  });
}

export async function encodeAdaptiveFrame(
  source: CanvasImageSource,
  sourceWidth: number,
  sourceHeight: number,
  crop: NormalizedCrop,
  options: EncodingOptions = DEFAULT_ENCODING_OPTIONS,
  canvasFactory: CanvasFactory = defaultCanvasFactory
): Promise<EncodedFrame | null> {
  const sourceCrop = cropToSourcePixels(crop, sourceWidth, sourceHeight);
  const baseSize = fitWithinLongEdge(
    sourceCrop.width,
    sourceCrop.height,
    options.maxLongEdge
  );
  let smallest: EncodedFrame | null = null;

  for (const attempt of buildEncodingAttempts(options)) {
    const width = Math.max(1, Math.round(baseSize.width * attempt.scale));
    const height = Math.max(1, Math.round(baseSize.height * attempt.scale));
    const { canvas, context } = canvasFactory(width, height);
    if ("width" in canvas) {
      canvas.width = width;
      canvas.height = height;
    }
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = "high";
    context.drawImage(
      source,
      sourceCrop.x,
      sourceCrop.y,
      sourceCrop.width,
      sourceCrop.height,
      0,
      0,
      width,
      height
    );
    const blob = await canvasToBlob(canvas, attempt.mimeType, attempt.quality);
    context.clearRect(0, 0, width, height);
    canvas.width = 1;
    canvas.height = 1;
    if (!blob || blob.type !== attempt.mimeType) {
      continue;
    }
    const bytes = new Uint8Array(await blob.arrayBuffer());
    if (bytes.byteLength > options.hardMaxFrameBytes) {
      continue;
    }
    const encoded: EncodedFrame = {
      bytes,
      mimeType: attempt.mimeType,
      width,
      height,
      quality: attempt.quality
    };
    if (!smallest || bytes.byteLength < smallest.bytes.byteLength) {
      smallest = encoded;
    }
    if (bytes.byteLength <= options.targetFrameBytes) {
      return encoded;
    }
  }
  return smallest;
}

export function hashFrameBytes(bytes: Uint8Array): string {
  let first = 0x811c9dc5;
  let second = 0x9e3779b9;
  for (const byte of bytes) {
    first = Math.imul(first ^ byte, 0x01000193);
    second = Math.imul(second ^ byte, 0x85ebca6b);
  }
  return `${(first >>> 0).toString(16).padStart(8, "0")}${(second >>> 0)
    .toString(16)
    .padStart(8, "0")}`;
}
