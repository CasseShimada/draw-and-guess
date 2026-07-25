import { describe, expect, it } from "vitest";
import { z } from "zod";

import { DesktopRequestError } from "./desktop-request-error.js";
import {
  describeJoinRoomFailure,
  joinRoomFailureMessage
} from "./join-room-failure.js";

describe("join-room failure descriptions", () => {
  it.each([
    [401, "UNAUTHORIZED", "房间密码错误", "房主可能刚刚修改过密码"],
    [404, "NOT_FOUND", "房间不存在", "检查六位房间码"],
    [409, "INVALID_STATE", "游戏已经开始", "回到大厅"],
    [403, "FORBIDDEN", "桌面请求被拒绝", "代理没有改写"],
    [429, "RATE_LIMITED", "请求太频繁", "稍等片刻"],
    [500, "INTERNAL_ERROR", "服务器处理失败", "诊断日志"]
  ])(
    "maps HTTP %i / %s to a specific suggestion",
    (status, code, reason, suggestion) => {
      const description = describeJoinRoomFailure(
        new DesktopRequestError(status, reason, code),
        "join-request"
      );
      expect(description).toMatchObject({
        phase: "join-request",
        phaseLabel: "验证房间",
        code,
        reason
      });
      expect(description.suggestion).toContain(suggestion);
      expect(joinRoomFailureMessage(description)).toContain("建议：");
    }
  );

  it("identifies an incompatible response separately from a network failure", () => {
    const schemaError = z.object({ snapshot: z.string() }).safeParse({});
    if (schemaError.success) {
      throw new Error("expected schema failure");
    }
    expect(
      describeJoinRoomFailure(schemaError.error, "response-validation")
    ).toMatchObject({
      phase: "response-validation",
      code: "invalid-server-response"
    });
    expect(
      describeJoinRoomFailure(new TypeError("fetch failed"), "join-request")
    ).toMatchObject({
      phase: "join-request",
      code: "network-request-failed"
    });
  });

  it("keeps a password-specific explanation when a 401 body cannot be decoded", () => {
    expect(
      describeJoinRoomFailure(
        new DesktopRequestError(401, "服务器请求失败"),
        "join-request"
      )
    ).toMatchObject({
      code: "UNAUTHORIZED",
      reason: "房间密码错误，或房主已经修改了密码"
    });
  });
});
