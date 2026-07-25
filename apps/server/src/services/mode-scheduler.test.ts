import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ModeScheduler } from "./mode-scheduler.js";

describe("mode scheduler", () => {
  let now = 1_000;

  beforeEach(() => {
    vi.useFakeTimers();
    now = 1_000;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("preserves exact remaining milliseconds across a long pause and resume delay", async () => {
    const fired: string[] = [];
    const scheduler = new ModeScheduler({ now: () => now });
    scheduler.scheduleAt("existing", 11_000, () => fired.push("existing"));
    now = 2_000;
    expect(scheduler.pauseAll(now)).toEqual([
      { key: "existing", deadline: 11_000, remainingMs: 9_000 }
    ]);
    scheduler.scheduleAt("created-while-paused", 7_000, () =>
      fired.push("created-while-paused")
    );
    expect(scheduler.snapshot(now)).toEqual([
      {
        key: "created-while-paused",
        deadline: 7_000,
        remainingMs: 5_000
      },
      { key: "existing", deadline: 11_000, remainingMs: 9_000 }
    ]);

    now += 10 * 60_000;
    expect(scheduler.resumeAll(now, 3_000)).toEqual([
      {
        key: "created-while-paused",
        deadline: now + 8_000,
        remainingMs: 8_000
      },
      { key: "existing", deadline: now + 12_000, remainingMs: 12_000 }
    ]);
    await vi.advanceTimersByTimeAsync(7_999);
    expect(fired).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(fired).toEqual(["created-while-paused"]);
    await vi.advanceTimersByTimeAsync(3_999);
    expect(fired).toEqual(["created-while-paused"]);
    await vi.advanceTimersByTimeAsync(1);
    expect(fired).toEqual(["created-while-paused", "existing"]);
    expect(scheduler.size).toBe(0);
  });

  it("replaces keyed timers and makes cancelAll idempotent", async () => {
    const fired: string[] = [];
    const scheduler = new ModeScheduler({ now: () => now });
    scheduler.scheduleAfter("phase", 100, () => fired.push("stale"));
    scheduler.scheduleAfter("phase", 200, () => fired.push("latest"));
    await vi.advanceTimersByTimeAsync(100);
    expect(fired).toEqual([]);
    scheduler.cancelAll();
    scheduler.cancelAll();
    await vi.advanceTimersByTimeAsync(200);
    expect(fired).toEqual([]);
    expect(scheduler.paused).toBe(false);
  });
});
