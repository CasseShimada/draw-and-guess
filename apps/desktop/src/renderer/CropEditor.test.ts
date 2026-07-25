import { describe, expect, it } from "vitest";

import { moveCrop } from "./CropEditor.js";

describe("crop editor movement", () => {
  it("keeps a normalized crop inside the source", () => {
    expect(moveCrop({ x: 0.2, y: 0.3, width: 0.5, height: 0.4 }, 1, -1)).toEqual({
      x: 0.5,
      y: 0,
      width: 0.5,
      height: 0.4
    });
  });
});
