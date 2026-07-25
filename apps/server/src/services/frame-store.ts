import { createHash } from "node:crypto";

import type { EncodedImageMimeType } from "@draw-guess/protocol";

export interface AcceptedFrame {
  playerId: string;
  captureSessionId: number;
  sequence: number;
  mimeType: EncodedImageMimeType;
  bytes: Uint8Array;
  capturedAt: number;
  revision: string;
}

export class LatestFrameStore {
  readonly #latestByKey = new Map<string, AcceptedFrame>();
  readonly #sequenceByKey = new Map<string, number>();
  readonly #maxTotalBytes: number;
  #totalBytes = 0;

  constructor(maxTotalBytes: number) {
    if (!Number.isInteger(maxTotalBytes) || maxTotalBytes < 1) {
      throw new RangeError("frame store 内存上限必须是正整数");
    }
    this.#maxTotalBytes = maxTotalBytes;
  }

  get totalBytes(): number {
    return this.#totalBytes;
  }

  get size(): number {
    return this.#latestByKey.size;
  }

  get(key: string): AcceptedFrame | null {
    return this.#latestByKey.get(key) ?? null;
  }

  accept(
    key: string,
    input: Omit<AcceptedFrame, "sequence" | "revision" | "bytes"> & {
      bytes: Uint8Array;
    }
  ): AcceptedFrame | null {
    const bytes = new Uint8Array(input.bytes);
    const previous = this.#latestByKey.get(key);
    const nextTotal =
      this.#totalBytes - (previous?.bytes.byteLength ?? 0) + bytes.byteLength;
    if (nextTotal > this.#maxTotalBytes) {
      return null;
    }
    let sequence = ((this.#sequenceByKey.get(key) ?? 0) + 1) >>> 0;
    if (sequence === 0) {
      sequence = 1;
    }
    const frame: AcceptedFrame = {
      ...input,
      bytes,
      sequence,
      revision: createHash("sha256").update(bytes).digest("hex")
    };
    this.#latestByKey.set(key, frame);
    this.#sequenceByKey.set(key, sequence);
    this.#totalBytes = nextTotal;
    return frame;
  }

  delete(key: string): void {
    const previous = this.#latestByKey.get(key);
    if (previous) {
      this.#totalBytes -= previous.bytes.byteLength;
    }
    this.#latestByKey.delete(key);
    this.#sequenceByKey.delete(key);
  }

  clear(): void {
    this.#latestByKey.clear();
    this.#sequenceByKey.clear();
    this.#totalBytes = 0;
  }
}
