import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { PublicRoomSnapshot } from "@draw-guess/shared-types";

import {
  AppMoreMenu,
  AppTopBar,
  ContextActionBar,
  LobbyModeSelector
} from "./AppShell.js";

function snapshot(
  phase: "LOBBY" | "DRAWING" | "GAME_RESULT",
  selfPlayerId = "host"
): PublicRoomSnapshot {
  return {
    hostId: "host",
    modeSessionId: "mode-session",
    passableActors: [],
    players: [
      {
        id: "host",
        nickname: "房主"
      }
    ],
    replayCapability: {
      available: true,
      encoder: "libx264"
    },
    roomCode: "ABC234",
    runControl: {
      status: "running",
      captureResumesAt: null
    },
    selfPlayerId,
    game: {
      mode: "classic",
      phase
    }
  } as unknown as PublicRoomSnapshot;
}

describe("application information architecture", () => {
  it("keeps the global top bar to room and status summaries plus one menu", () => {
    const html = renderToStaticMarkup(
      createElement(AppTopBar, {
        connection: "connected",
        menu: createElement("span", { "data-test-menu": true }, "更多"),
        modeLabel: "经典你画我猜",
        onCopyRoomCode: vi.fn(),
        phaseLabel: "大厅",
        roomCode: "ABC234"
      })
    );

    expect(html).toContain('data-ui="topbar"');
    expect(html).toContain("ABC234");
    expect(html).toContain("大厅");
    expect(html).toContain("已连接");
    expect(html).not.toContain("词库管理");
    expect(html).not.toContain("暂停全场");
  });

  it("keeps utilities and the dangerous room action in the single more menu", () => {
    const html = renderToStaticMarkup(
      createElement(AppMoreMenu, {
        busy: false,
        onLeave: vi.fn(),
        onManageWords: vi.fn(),
        showWordManager: true
      })
    );

    expect(html).toContain('data-ui="app-more-menu"');
    expect(html).toContain("词库管理");
    expect(html).toContain('data-action="leave-room"');
    expect(html.indexOf("词库管理")).toBeLessThan(html.indexOf("退出房间"));
  });

  it("shows game actions only in their matching phase and role", () => {
    const lobby = renderToStaticMarkup(
      createElement(ContextActionBar, {
        isLogicalHost: true,
        onOpenSettings: vi.fn(),
        onPause: vi.fn(),
        send: vi.fn(),
        snapshot: snapshot("LOBBY")
      })
    );
    const result = renderToStaticMarkup(
      createElement(ContextActionBar, {
        isLogicalHost: true,
        onOpenSettings: vi.fn(),
        onPause: vi.fn(),
        send: vi.fn(),
        snapshot: snapshot("GAME_RESULT")
      })
    );
    const playerDrawing = renderToStaticMarkup(
      createElement(ContextActionBar, {
        isLogicalHost: false,
        onOpenSettings: vi.fn(),
        onPause: vi.fn(),
        send: vi.fn(),
        snapshot: snapshot("DRAWING", "player")
      })
    );

    expect(lobby).toBe("");
    expect(result).toContain('data-action="return-to-lobby"');
    expect(result).not.toContain('data-action="open-room-settings"');
    expect(playerDrawing).toBe("");
  });

  it("renders one lobby mode control for the logical host and a summary for players", () => {
    const host = renderToStaticMarkup(
      createElement(LobbyModeSelector, {
        onSwitchMode: vi.fn(),
        snapshot: snapshot("LOBBY")
      })
    );
    const player = renderToStaticMarkup(
      createElement(LobbyModeSelector, {
        onSwitchMode: vi.fn(),
        snapshot: snapshot("LOBBY", "player")
      })
    );

    expect(host).toContain('data-ui="mode-selection-cards"');
    expect(player).toContain('data-ui="lobby-mode-summary"');
    expect(player).not.toContain("<button");
  });
});
