import { describe, expect, it } from "vitest";

import {
  evaluateCriticalMeasurement,
  type CriticalUiMeasurement
} from "./theme-health.js";

function measurement(
  overrides: Partial<CriticalUiMeasurement> = {}
): CriticalUiMeasurement {
  return {
    id: "submit",
    label: "提交操作",
    kind: "action",
    display: "block",
    visibility: "visible",
    opacity: 1,
    pointerEvents: "auto",
    width: 120,
    height: 40,
    visibleWidth: 120,
    visibleHeight: 40,
    top: 20,
    right: 140,
    bottom: 60,
    left: 20,
    viewportWidth: 1280,
    viewportHeight: 720,
    ...overrides
  };
}

describe("theme critical UI health rules", () => {
  it("accepts an ordinary visible and interactive region", () => {
    expect(evaluateCriticalMeasurement(measurement())).toBeNull();
  });

  it.each([
    [{ display: "none" }, "display:none"],
    [{ visibility: "hidden" }, "不可见"],
    [{ opacity: 0 }, "透明"],
    [{ pointerEvents: "none" }, "指针"],
    [{ width: 0 }, "尺寸"],
    [{ visibleWidth: 0 }, "裁剪"],
    [{ left: -200, right: -10 }, "视口外"]
  ] as const)("detects destructive CSS %j", (overrides, reason) => {
    expect(evaluateCriticalMeasurement(measurement(overrides))).toMatchObject({
      id: "submit",
      reason: expect.stringContaining(reason),
      recoverableWithAction: true
    });
  });

  it("requires hard recovery for canvas, input, and content failures", () => {
    for (const kind of ["canvas", "input", "content"] as const) {
      expect(
        evaluateCriticalMeasurement(measurement({ kind, width: 0 }))
      ).toMatchObject({
        kind,
        recoverableWithAction: false
      });
    }
  });
});
