import { describe, expect, it } from "vitest";

import { LatestFrameQueue } from "./latest-frame-queue.js";

describe("latest-only frame queue", () => {
  it("keeps the in-flight value and replaces every pending value with the latest", async () => {
    const delivered: number[] = [];
    let release: () => void = () => undefined;
    const queue = new LatestFrameQueue<number>(async (value) => {
      delivered.push(value);
      if (value === 1) {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      }
    });

    queue.enqueue(1);
    await Promise.resolve();
    queue.enqueue(2);
    queue.enqueue(3);
    queue.enqueue(4);
    release();
    await queue.whenIdle();
    expect(delivered).toEqual([1, 4]);
  });
});
