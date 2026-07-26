import { describe, expect, it } from "vitest";

import { NicknameInputSchema, RememberedNicknameSchema } from "./nickname-schema.js";

describe("nickname input schemas", () => {
  it("accepts an empty room nickname while normalizing manual input", () => {
    expect(NicknameInputSchema.parse("   ")).toBe("");
    expect(NicknameInputSchema.parse("  小\u0000画家  ")).toBe("小画家");
    expect(NicknameInputSchema.parse("ＡＢＣ")).toBe("ABC");
  });

  it("stores only non-empty manual nicknames within the character limit", () => {
    expect(RememberedNicknameSchema.parse("  常用昵称  ")).toBe("常用昵称");
    expect(RememberedNicknameSchema.safeParse("").success).toBe(false);
    expect(RememberedNicknameSchema.safeParse("画".repeat(25)).success).toBe(false);
  });
});
