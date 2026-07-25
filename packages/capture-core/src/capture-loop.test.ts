import { describe, expect, it } from "vitest";

import { CaptureLoop } from "./capture-loop.js";
import type { EncodedFrame } from "./encoder.js";

const FRAME: EncodedFrame = {
  bytes: Uint8Array.from([1, 2, 3]),
  mimeType: "image/webp",
  width: 10,
  height: 10,
  quality: 0.5
};

describe("capture loop", () => {
  it("uses a busy guard and drops an async result after stop", async () => {
    let resolveCapture: (value: EncodedFrame) => void = () => undefined;
    let calls = 0;
    const uploads: number[] = [];
    const loop = new CaptureLoop({
      minimumIntervalMs: 60_000,
      capture: () => {
        calls += 1;
        return new Promise((resolve) => {
          resolveCapture = resolve;
        });
      },
      upload: ({ captureSessionId }) => {
        uploads.push(captureSessionId);
      }
    });
    loop.start(7, 60_000);
    await loop.captureOnce();
    expect(calls).toBe(1);
    expect(loop.busy).toBe(true);
    loop.stop(7);
    resolveCapture(FRAME);
    await Promise.resolve();
    await loop.whenUploadsIdle();
    expect(uploads).toEqual([]);
    loop.dispose();
  });

  it("skips unchanged frames and clears the hash for a new turn", async () => {
    const uploads: number[] = [];
    const loop = new CaptureLoop({
      minimumIntervalMs: 60_000,
      capture: async () => FRAME,
      upload: ({ captureSessionId }) => {
        uploads.push(captureSessionId);
      }
    });
    loop.start(1, 60_000);
    await loop.captureOnce();
    await loop.captureOnce();
    await loop.whenUploadsIdle();
    expect(uploads).toEqual([1]);
    loop.start(2, 60_000);
    await loop.captureOnce();
    await loop.whenUploadsIdle();
    expect(uploads).toEqual([1, 2]);
    loop.dispose();
  });

  it("reports upload failures without stalling the latest-frame queue", async () => {
    const errors: string[] = [];
    const uploads: number[] = [];
    const loop = new CaptureLoop({
      minimumIntervalMs: 60_000,
      capture: async () => FRAME,
      upload: async ({ captureSessionId }) => {
        uploads.push(captureSessionId);
        throw new Error("network unavailable");
      },
      onError: (message) => errors.push(message)
    });

    loop.start(3, 60_000);
    await new Promise((resolve) => setTimeout(resolve, 0));
    await loop.whenUploadsIdle();

    expect(uploads).toEqual([3]);
    expect(errors).toEqual(["network unavailable"]);
    loop.dispose();
  });
});
