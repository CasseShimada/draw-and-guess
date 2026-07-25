import { describe, expect, it } from "vitest";

import {
  BrowserClientMessageSchema,
  DrawRelaySettingsSchema,
  GameModeSettingsSchema,
  PROTOCOL_VERSION,
  ReferenceCopySettingsSchema,
  decodeUploadFrame,
  decodeViewerFrame,
  encodeUploadFrame,
  encodeViewerFrame,
  isValidEncodedImage,
  isValidJpeg,
  isValidWebp,
  serializeServerMessage,
  ServerJsonMessageSchema,
  shouldAcceptViewerFrame
} from "./index.js";

const JPEG = Uint8Array.from([0xff, 0xd8, 0x11, 0x22, 0xff, 0xd9]);
const WEBP = Uint8Array.from([
  0x52, 0x49, 0x46, 0x46, 0x04, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50
]);

describe("binary frame protocol", () => {
  it("round-trips upload and viewer packets in big-endian form", () => {
    const upload = encodeUploadFrame(0x01020304, JPEG);
    expect([...upload.slice(0, 4)]).toEqual([1, 2, 3, 4]);
    expect(decodeUploadFrame(upload)).toEqual({
      captureSessionId: 0x01020304,
      imageBytes: JPEG,
      mimeType: "image/jpeg"
    });

    const viewer = encodeViewerFrame(7, 9, JPEG);
    expect(decodeViewerFrame(viewer)).toEqual({
      captureSessionId: 7,
      sequence: 9,
      imageBytes: JPEG,
      mimeType: "image/jpeg"
    });
  });

  it("checks JPEG and WebP magic plus packet lengths", () => {
    expect(isValidJpeg(JPEG)).toBe(true);
    expect(isValidJpeg(Uint8Array.from([0xff, 0xd8, 1, 2]))).toBe(false);
    expect(isValidWebp(WEBP)).toBe(true);
    expect(isValidEncodedImage(WEBP)).toBe(true);
    expect(() => decodeUploadFrame(new Uint8Array(4))).toThrow();
  });

  it("ignores stale, out-of-turn, and malformed viewer frames", () => {
    expect(shouldAcceptViewerFrame(encodeViewerFrame(3, 2, JPEG), 3, 1)?.sequence).toBe(
      2
    );
    expect(shouldAcceptViewerFrame(encodeViewerFrame(4, 2, JPEG), 3, 1)).toBeNull();
    expect(shouldAcceptViewerFrame(encodeViewerFrame(3, 1, JPEG), 3, 1)).toBeNull();
  });

  it("serializes and validates versioned server messages", () => {
    const serialized = serializeServerMessage({
      type: "pong",
      timestamp: 12,
      serverNow: 34
    });
    expect(ServerJsonMessageSchema.parse(JSON.parse(serialized))).toEqual({
      protocolVersion: PROTOCOL_VERSION,
      type: "pong",
      timestamp: 12,
      serverNow: 34
    });
  });
});

describe("protocol-v4 mode schemas", () => {
  it("accepts the exact reference and relay duration boundaries", () => {
    expect(
      ReferenceCopySettingsSchema.parse({
        durationSeconds: 1,
        votingSeconds: 10
      })
    ).toEqual({ durationSeconds: 1, votingSeconds: 10 });
    expect(
      ReferenceCopySettingsSchema.parse({
        durationSeconds: 10_800,
        votingSeconds: 600
      })
    ).toEqual({ durationSeconds: 10_800, votingSeconds: 600 });
    expect(
      DrawRelaySettingsSchema.parse({
        drawingSeconds: 1,
        guessingSeconds: 1
      })
    ).toEqual({ drawingSeconds: 1, guessingSeconds: 1 });
    expect(
      DrawRelaySettingsSchema.parse({
        drawingSeconds: 10_800,
        guessingSeconds: 600
      })
    ).toEqual({ drawingSeconds: 10_800, guessingSeconds: 600 });
  });

  it.each([
    { durationSeconds: 0, votingSeconds: 10 },
    { durationSeconds: -1, votingSeconds: 10 },
    { durationSeconds: 1.5, votingSeconds: 10 },
    { durationSeconds: Number.NaN, votingSeconds: 10 },
    { durationSeconds: Number.POSITIVE_INFINITY, votingSeconds: 10 },
    { durationSeconds: 10_801, votingSeconds: 10 },
    { durationSeconds: 1, votingSeconds: 9 },
    { durationSeconds: 1, votingSeconds: 601 }
  ])("rejects invalid reference settings %#", (value) => {
    expect(ReferenceCopySettingsSchema.safeParse(value).success).toBe(false);
  });

  it("uses a strict mode discriminant and has no configurable finalization time", () => {
    expect(
      GameModeSettingsSchema.safeParse({
        mode: "unknown",
        settings: {}
      }).success
    ).toBe(false);
    expect(
      GameModeSettingsSchema.safeParse({
        mode: "reference-copy",
        settings: {
          durationSeconds: 97,
          votingSeconds: 120,
          finalizationSeconds: 2
        }
      }).success
    ).toBe(false);
    expect(
      BrowserClientMessageSchema.safeParse({
        protocolVersion: PROTOCOL_VERSION,
        type: "room:pause",
        commandId: "forged"
      }).success
    ).toBe(false);
  });
});
