import { describe, expect, it } from "vitest";

import {
  DEFAULT_ENCODING_OPTIONS,
  buildEncodingAttempts,
  hashFrameBytes
} from "./encoder.js";

describe("encoding policy", () => {
  it("reduces quality before resolution and includes a JPEG fallback", () => {
    const attempts = buildEncodingAttempts(DEFAULT_ENCODING_OPTIONS);
    expect(attempts[0]).toMatchObject({ mimeType: "image/webp", scale: 1 });
    expect(attempts[1]!.quality).toBeLessThan(attempts[0]!.quality);
    expect(
      attempts.some((attempt) => attempt.mimeType === "image/jpeg" && attempt.scale < 1)
    ).toBe(true);
  });

  it("creates a deterministic lightweight unchanged-frame hash", () => {
    expect(hashFrameBytes(Uint8Array.from([1, 2, 3]))).toBe(
      hashFrameBytes(Uint8Array.from([1, 2, 3]))
    );
    expect(hashFrameBytes(Uint8Array.from([1, 2, 3]))).not.toBe(
      hashFrameBytes(Uint8Array.from([1, 2, 4]))
    );
  });
});
