import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { PROTOCOL_VERSION, type ServerJsonMessage } from "@draw-guess/protocol";
import type { PublicRoomSnapshot } from "@draw-guess/shared-types";

import { Home, acceptsClassicSelectedWord, acceptsClassicWordOptions } from "./App.js";

function renderHome(initialEntryMode: "create" | "join", nickname: string | null) {
  return renderToStaticMarkup(
    createElement(Home, {
      avatarControl: createElement("div"),
      busy: false,
      error: null,
      initialEntryMode,
      rememberedNickname: nickname,
      onCreate: vi.fn(async () => undefined),
      onJoin: vi.fn(async () => undefined),
      onManageWords: vi.fn()
    })
  );
}

function nicknameInput(html: string): string {
  const input = html.match(/<input[^>]*name="nickname"[^>]*>/u)?.[0];
  if (!input) {
    throw new Error("nickname input was not rendered");
  }
  return input;
}

describe("room entry nickname field", () => {
  it.each(["create", "join"] as const)(
    "allows an empty nickname in the %s form",
    (entryMode) => {
      const html = renderHome(entryMode, null);
      expect(html).toContain("你的昵称（可留空随机；将添加 #四位数字）");
      expect(nicknameInput(html)).toContain('placeholder="留空将随机生成"');
      expect(nicknameInput(html)).not.toContain("required");
    }
  );

  it("prefills the remembered manual nickname", () => {
    expect(nicknameInput(renderHome("create", "常用画手"))).toContain(
      'value="常用画手"'
    );
  });
});

function classicSnapshot(
  phase: "WORD_SELECTION" | "DRAWING",
  actorStepId: string | null = null
): PublicRoomSnapshot {
  return {
    modeSessionId: "mode-session",
    selfPlayerId: "drawer",
    game: {
      mode: "classic",
      phase,
      currentDrawerId: "drawer",
      currentTurnId: 7,
      selfDrawing:
        actorStepId === null
          ? null
          : {
              status: "drawing",
              actorStepId,
              drawingEndsAt: 10_000,
              captureSessionId: 1,
              acceptedSequence: -1,
              acceptedRevision: null
            }
    }
  } as PublicRoomSnapshot;
}

describe("classic private message guards", () => {
  it("accepts candidate words only after the matching selection snapshot", () => {
    const message = {
      protocolVersion: PROTOCOL_VERSION,
      type: "classic:word-options",
      modeSessionId: "mode-session",
      actorStepId: "selection-step",
      turnId: 7,
      options: [],
      selectionEndsAt: 5_000
    } satisfies Extract<ServerJsonMessage, { type: "classic:word-options" }>;

    expect(acceptsClassicWordOptions(classicSnapshot("WORD_SELECTION"), message)).toBe(
      true
    );
    expect(
      acceptsClassicWordOptions(
        { ...classicSnapshot("WORD_SELECTION"), modeSessionId: "stale-session" },
        message
      )
    ).toBe(false);
  });

  it("validates the selected word against the new drawing step", () => {
    const message = {
      protocolVersion: PROTOCOL_VERSION,
      type: "classic:word-selected",
      modeSessionId: "mode-session",
      actorStepId: "drawing-step",
      answer: "长颈鹿"
    } satisfies Extract<ServerJsonMessage, { type: "classic:word-selected" }>;

    expect(
      acceptsClassicSelectedWord(classicSnapshot("DRAWING", "drawing-step"), message)
    ).toBe(true);
    expect(
      acceptsClassicSelectedWord(
        classicSnapshot("DRAWING", "previous-selection-step"),
        message
      )
    ).toBe(false);
  });
});
