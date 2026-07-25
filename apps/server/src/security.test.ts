import { describe, expect, it } from "vitest";

import {
  SessionStore,
  hashPassword,
  sanitizeNickname,
  verifyPassword
} from "./security.js";

describe("password security", () => {
  it("stores a salted scrypt digest and verifies without plaintext", async () => {
    const first = await hashPassword("correct horse");
    const second = await hashPassword("correct horse");
    expect(first.hash).not.toBe("correct horse");
    expect(first).not.toEqual(second);
    await expect(verifyPassword("correct horse", first)).resolves.toBe(true);
    await expect(verifyPassword("wrong", first)).resolves.toBe(false);
  });

  it("removes control characters from nicknames", () => {
    expect(sanitizeNickname("  小\u0000明  ")).toBe("小明");
  });
});

describe("player sessions", () => {
  it("keeps desktop tokens hashed, typed, and short-lived", () => {
    const store = new SessionStore();
    const issued = store.issue("ABC234", "player", 1_000, "desktop", 1_000);
    expect(issued.session.digest).not.toContain(issued.token);
    expect(store.verify(issued.token, 1_999)).toMatchObject({
      playerId: "player",
      kind: "desktop"
    });
    expect(store.verify(issued.token, 2_000)).toBeNull();
  });
});
