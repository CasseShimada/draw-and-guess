import { describe, expect, it } from "vitest";

import {
  centeredAspectCrop,
  cropToSourcePixels,
  isValidNormalizedCrop,
  normalizeCrop
} from "./crop.js";

describe("normalized crop", () => {
  it("clamps bounds and enforces a minimum size", () => {
    const crop = normalizeCrop({ x: -1, y: 0.99, width: 2, height: 0 });
    expect(crop).toEqual({ x: 0, y: 0.98, width: 1, height: 0.02 });
    expect(isValidNormalizedCrop(crop)).toBe(true);
  });

  it("maps the same normalized region across DPI and resolution changes", () => {
    const crop = { x: 0.1, y: 0.2, width: 0.5, height: 0.4 };
    expect(cropToSourcePixels(crop, 1_000, 500)).toEqual({
      x: 100,
      y: 100,
      width: 500,
      height: 200
    });
    expect(cropToSourcePixels(crop, 2_000, 1_000)).toEqual({
      x: 200,
      y: 200,
      width: 1_000,
      height: 400
    });
  });

  it("centers a 16:9 crop inside wider and taller sources", () => {
    expect(centeredAspectCrop(1_920, 1_080)).toEqual({
      x: 0,
      y: 0,
      width: 1,
      height: 1
    });
    expect(centeredAspectCrop(1_000, 1_000)).toMatchObject({
      x: 0,
      width: 1
    });
  });
});
