import { describe, expect, it } from "vitest";

import {
  assertTransition,
  buildDrawerQueue,
  calculateGuesserScore,
  canTransition,
  FINAL_PRESENTATION_GRACE_MS,
  FINAL_PRESENTATION_GRACE_SECONDS,
  formatDuration,
  normalizeGuess,
  resolveGuess
} from "./index.js";

describe("normalizeGuess", () => {
  it("normalizes Unicode, whitespace, case, and Chinese/English punctuation", () => {
    expect(normalizeGuess("  Ｃａｔ， C-A T！ ")).toBe("catcat");
    expect(normalizeGuess("你　好，世界！")).toBe("你好世界");
  });
});

describe("scoring", () => {
  it("uses remaining whole seconds", () => {
    expect(calculateGuesserScore(59_999)).toBe(395);
    expect(calculateGuesserScore(-1)).toBe(100);
  });

  it("awards only the first correct guess and excludes the drawer", () => {
    const base = {
      guess: "小 猫！",
      answer: "小猫",
      drawerId: "drawer",
      remainingMs: 10_900
    };

    expect(
      resolveGuess({
        ...base,
        guesserId: "guesser",
        correctGuesserIds: new Set()
      })
    ).toEqual({ status: "correct", guesserPoints: 150, drawerPoints: 50 });

    expect(
      resolveGuess({
        ...base,
        guesserId: "guesser",
        correctGuesserIds: new Set(["guesser"])
      }).status
    ).toBe("duplicate");

    expect(
      resolveGuess({
        ...base,
        guesserId: "drawer",
        correctGuesserIds: new Set()
      }).status
    ).toBe("drawer");
  });
});

describe("state transitions", () => {
  it("accepts legal transitions and rejects illegal ones", () => {
    expect(canTransition("LOBBY", "WORD_SELECTION")).toBe(true);
    expect(canTransition("DRAWING", "GAME_RESULT")).toBe(false);
    expect(() => assertTransition("DRAWING", "GAME_RESULT")).toThrow(
      "非法游戏状态转换"
    );
  });
});

describe("drawer queue", () => {
  it("includes only capture-ready desktop players once per round in join order", () => {
    expect(
      buildDrawerQueue(
        [
          { playerId: "b", joinedAt: 2, captureReady: true },
          { playerId: "a", joinedAt: 1, captureReady: true },
          { playerId: "c", joinedAt: 0, captureReady: false }
        ],
        2
      )
    ).toEqual([
      { playerId: "a", round: 1 },
      { playerId: "b", round: 1 },
      { playerId: "a", round: 2 },
      { playerId: "b", round: 2 }
    ]);
  });
});

describe("shared drawing timing", () => {
  it("keeps final presentation fixed and formats all durations as HH:MM:SS", () => {
    expect(FINAL_PRESENTATION_GRACE_SECONDS).toBe(10);
    expect(FINAL_PRESENTATION_GRACE_MS).toBe(10_000);
    expect(formatDuration(0)).toBe("00:00:00");
    expect(formatDuration(1)).toBe("00:00:01");
    expect(formatDuration(97)).toBe("00:01:37");
    expect(formatDuration(10_800)).toBe("03:00:00");
  });
});
