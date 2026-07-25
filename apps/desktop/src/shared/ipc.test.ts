import { describe, expect, it } from "vitest";

import {
  GameEventSchema,
  SettingsPatchSchema,
  StartServerArgsSchema,
  UploadFrameArgsSchema
} from "./ipc.js";

describe("desktop IPC schemas", () => {
  it("rejects unknown settings and unsafe server arguments", () => {
    expect(
      SettingsPatchSchema.safeParse({
        minimizeToTray: false,
        unexpectedPrivilege: true
      }).success
    ).toBe(false);
    expect(StartServerArgsSchema.safeParse({ port: 0, allowLan: true }).success).toBe(
      false
    );
  });

  it("accepts only typed binary values and versioned game events", () => {
    expect(
      UploadFrameArgsSchema.safeParse({
        captureSessionId: 7,
        bytes: Uint8Array.from([1, 2, 3])
      }).success
    ).toBe(true);
    expect(
      UploadFrameArgsSchema.safeParse({
        captureSessionId: 7,
        bytes: [1, 2, 3]
      }).success
    ).toBe(false);
    expect(
      GameEventSchema.safeParse({
        kind: "message",
        message: {
          protocolVersion: 1,
          type: "capture:status",
          ready: true
        }
      }).success
    ).toBe(false);
  });
});
