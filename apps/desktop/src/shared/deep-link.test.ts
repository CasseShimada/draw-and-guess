import { describe, expect, it } from "vitest";

import { parseInviteArguments } from "./deep-link.js";

describe("drawguess invite links", () => {
  it("accepts one validated server and room pair", () => {
    expect(
      parseInviteArguments([
        "--second-instance",
        "drawguess://join?server=https%3A%2F%2Fdraw.example&room=abc234"
      ])
    ).toEqual({
      serverUrl: "https://draw.example",
      roomCode: "ABC234"
    });
  });

  it("rejects secrets, unknown fields, duplicates, and insecure public servers", () => {
    for (const invite of [
      "drawguess://join?server=https%3A%2F%2Fdraw.example&room=ABC234&Password=x",
      "drawguess://join?server=https%3A%2F%2Fdraw.example&room=ABC234&extra=x",
      "drawguess://join?server=https%3A%2F%2Fdraw.example&server=https%3A%2F%2Fb.example&room=ABC234",
      "drawguess://join?server=http%3A%2F%2Fdraw.example&room=ABC234"
    ]) {
      expect(parseInviteArguments([invite])).toBeNull();
    }
  });
});
