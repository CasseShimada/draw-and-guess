import { hashFrameBytes, type EncodedFrame } from "./encoder.js";
import { LatestFrameQueue } from "./latest-frame-queue.js";

export interface CaptureLoopUpload {
  captureSessionId: number;
  frame: EncodedFrame;
}

export interface CaptureLoopOptions {
  minimumIntervalMs?: number;
  capture: () => Promise<EncodedFrame | null>;
  upload: (value: CaptureLoopUpload) => Promise<void> | void;
  onError?: (message: string) => void;
}

export class CaptureLoop {
  readonly #options: CaptureLoopOptions;
  readonly #uploads: LatestFrameQueue<CaptureLoopUpload>;
  #activeCaptureSessionId: number | null = null;
  #epoch = 0;
  #busy = false;
  #lastFrameHash = "";
  #timer: ReturnType<typeof setInterval> | null = null;

  constructor(options: CaptureLoopOptions) {
    this.#options = options;
    this.#uploads = new LatestFrameQueue(async (value) => {
      try {
        await options.upload(value);
      } catch (error) {
        options.onError?.(error instanceof Error ? error.message : "图片上传失败");
      }
    });
  }

  get activeCaptureSessionId(): number | null {
    return this.#activeCaptureSessionId;
  }

  get busy(): boolean {
    return this.#busy;
  }

  start(captureSessionId: number, requestedIntervalMs: number): void {
    if (
      !Number.isInteger(captureSessionId) ||
      captureSessionId < 0 ||
      captureSessionId > 0xffffffff
    ) {
      throw new RangeError("captureSessionId 必须是 UInt32");
    }
    this.stop();
    this.#epoch += 1;
    this.#activeCaptureSessionId = captureSessionId;
    this.#lastFrameHash = "";
    const intervalMs = Math.max(
      this.#options.minimumIntervalMs ?? 1_000,
      requestedIntervalMs
    );
    void this.captureOnce();
    this.#timer = setInterval(() => {
      void this.captureOnce();
    }, intervalMs);
  }

  stop(captureSessionId?: number): void {
    if (
      captureSessionId !== undefined &&
      this.#activeCaptureSessionId !== null &&
      captureSessionId !== this.#activeCaptureSessionId
    ) {
      return;
    }
    this.#epoch += 1;
    this.#activeCaptureSessionId = null;
    this.#lastFrameHash = "";
    if (this.#timer) {
      clearInterval(this.#timer);
      this.#timer = null;
    }
    this.#uploads.clear();
  }

  dispose(): void {
    this.stop();
    this.#uploads.close();
  }

  async captureOnce(): Promise<void> {
    const captureSessionId = this.#activeCaptureSessionId;
    if (captureSessionId === null || this.#busy) {
      return;
    }
    this.#busy = true;
    const epoch = this.#epoch;
    try {
      const frame = await this.#options.capture();
      if (
        !frame ||
        this.#activeCaptureSessionId !== captureSessionId ||
        this.#epoch !== epoch
      ) {
        return;
      }
      const hash = hashFrameBytes(frame.bytes);
      if (hash === this.#lastFrameHash) {
        return;
      }
      if (this.#uploads.enqueue({ captureSessionId, frame })) {
        this.#lastFrameHash = hash;
      }
    } catch (error) {
      this.#options.onError?.(
        error instanceof Error ? error.message : "图片采集或编码失败"
      );
    } finally {
      this.#busy = false;
    }
  }

  async whenUploadsIdle(): Promise<void> {
    await this.#uploads.whenIdle();
  }
}

export function boundedBackoff(attempt: number, baseMs = 500, maxMs = 10_000): number {
  return Math.min(maxMs, baseMs * 2 ** Math.min(Math.max(0, attempt), 6));
}
