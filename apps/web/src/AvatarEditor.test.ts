import { describe, expect, it } from "vitest";

import { avatarCropPlacement } from "./AvatarEditor.js";

describe("avatar crop placement", () => {
  it("covers the square output while preserving source aspect ratio", () => {
    expect(avatarCropPlacement(800, 400, 1, 0, 0)).toEqual({
      width: 512,
      height: 256,
      x: -128,
      y: 0
    });
    expect(avatarCropPlacement(400, 800, 1, 0, 0)).toEqual({
      width: 256,
      height: 512,
      x: 0,
      y: -128
    });
  });

  it("clamps keyboard/range offsets and applies zoom deterministically", () => {
    expect(avatarCropPlacement(256, 256, 2, 5, -5)).toEqual({
      width: 512,
      height: 512,
      x: 0,
      y: -256
    });
  });
});
