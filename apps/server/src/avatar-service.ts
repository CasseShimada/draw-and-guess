import { createHash } from "node:crypto";
import { inflateSync } from "node:zlib";

import { CONTENT_LIMITS, validateNormalizedAvatarPng } from "@draw-guess/content";

export interface RoomAvatar {
  bytes: Uint8Array;
  revision: string;
  byteLength: number;
}

export function validateRoomAvatar(bytesInput: Uint8Array): RoomAvatar {
  const bytes = new Uint8Array(bytesInput);
  const info = validateNormalizedAvatarPng(bytes);
  const compressedLength = info.idatChunks.reduce(
    (total, chunk) => total + chunk.byteLength,
    0
  );
  const compressed = new Uint8Array(compressedLength);
  let offset = 0;
  for (const chunk of info.idatChunks) {
    compressed.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const rowBytes = info.width * 4 + 1;
  const expectedBytes = rowBytes * info.height;
  let decoded: Buffer;
  try {
    decoded = inflateSync(compressed, {
      maxOutputLength: expectedBytes
    });
  } catch {
    throw new Error("PNG 像素数据无法完整解码");
  }
  if (decoded.byteLength !== expectedBytes) {
    throw new Error("PNG 解码后的像素长度无效");
  }
  for (let row = 0; row < info.height; row += 1) {
    const filter = decoded[row * rowBytes];
    if (filter === undefined || filter > 4) {
      throw new Error("PNG 包含无效的扫描行过滤器");
    }
  }
  if (bytes.byteLength > CONTENT_LIMITS.avatarBytes) {
    throw new Error("头像超过 512 KiB");
  }
  return {
    bytes,
    revision: createHash("sha256").update(bytes).digest("hex"),
    byteLength: bytes.byteLength
  };
}
