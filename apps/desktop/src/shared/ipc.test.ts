import { describe, expect, it } from "vitest";

import {
  ConnectionTestArgsSchema,
  CreateRoomArgsSchema,
  GameEventSchema,
  SettingsPatchSchema,
  StartServerArgsSchema,
  UploadFrameArgsSchema,
  desktopIpcErrorMessage
} from "./ipc.js";

describe("desktop IPC schemas", () => {
  it("rejects unknown settings and unsafe server arguments", () => {
    expect(
      SettingsPatchSchema.safeParse({
        minimizeToTray: false,
        unexpectedPrivilege: true
      }).success
    ).toBe(false);
    expect(
      StartServerArgsSchema.safeParse({
        port: 0,
        bindMode: "lan",
        restart: false
      }).success
    ).toBe(false);
    expect(
      ConnectionTestArgsSchema.safeParse({
        target: {
          host: "example.com",
          port: 443,
          security: "https"
        },
        confirmInsecureHttp: false,
        arbitraryFetchUrl: "file:///etc/passwd"
      }).success
    ).toBe(false);
    expect(
      ConnectionTestArgsSchema.safeParse({
        target: {
          host: "example.com",
          port: 0,
          security: "https"
        },
        confirmInsecureHttp: false
      }).success
    ).toBe(true);
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

  it("keeps room creation local and rejects a renderer-selected target", () => {
    expect(
      CreateRoomArgsSchema.safeParse({
        nickname: "房主",
        password: "password"
      }).success
    ).toBe(true);
    expect(
      CreateRoomArgsSchema.safeParse({
        nickname: "房主",
        password: "password",
        target: {
          host: "example.com",
          port: 443,
          security: "https"
        }
      }).success
    ).toBe(false);
  });

  it("removes Electron's remote-method wrapper from user-facing errors", () => {
    expect(
      desktopIpcErrorMessage(
        new Error(
          "Error invoking remote method 'game:create-room': Error: 无法启动本机房间服务：端口 32100 已被占用"
        )
      )
    ).toBe("无法启动本机房间服务：端口 32100 已被占用");
    expect(desktopIpcErrorMessage(new Error("普通错误"))).toBe("普通错误");
    expect(desktopIpcErrorMessage(null)).toBe("桌面操作失败");
  });
});
