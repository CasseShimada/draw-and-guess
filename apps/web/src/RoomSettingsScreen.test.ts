import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import type { PublicRoomSnapshot } from "@draw-guess/shared-types";
import { describe, expect, it, vi } from "vitest";

import { RoomSettingsScreen } from "./RoomSettingsScreen.js";
import {
  createRoomSettingsDraft,
  updateRoomSettingsDraft
} from "./room-settings-state.js";

function activeSnapshot(): PublicRoomSnapshot {
  return {
    roomCode: "ABC234",
    hostId: "host",
    selfPlayerId: "host",
    modeSessionId: "mode-session-active",
    players: [
      {
        id: "host",
        nickname: "房主#0001",
        isHost: true,
        connected: true,
        clientKind: "desktop",
        captureReady: true,
        avatarRevision: null,
        joinedAt: 1
      },
      {
        id: "guest",
        nickname: "玩家#0002",
        isHost: false,
        connected: true,
        clientKind: "browser",
        captureReady: false,
        avatarRevision: null,
        joinedAt: 2
      }
    ],
    chat: [],
    serverNow: 1,
    runControl: {
      status: "running",
      resumedAt: null,
      captureResumesAt: null
    },
    replayCapability: {
      available: true,
      ffmpegVersion: "ffmpeg",
      executableSource: "path",
      encoder: "libx264"
    },
    passableActors: [],
    game: {
      mode: "classic",
      phase: "DRAWING",
      settings: { drawingSeconds: 60, selectionSeconds: 15, rounds: 2 },
      wordPool: { revision: "a".repeat(64), packs: [], uniqueWordCount: 3 },
      scores: { host: 0, guest: 0 },
      currentDrawerId: "host",
      currentTurnId: 1,
      currentRound: 1,
      totalRounds: 2,
      turnNumber: 1,
      totalTurns: 4,
      phaseEndsAt: 10,
      correctGuesserIds: [],
      passedPlayerIds: [],
      turnResult: null,
      selfDrawing: null
    }
  };
}

describe("active-game room settings screen", () => {
  it("shows live-game warnings, room members, a dirty draft, and one atomic restart action", () => {
    const snapshot = activeSnapshot();
    const draft = updateRoomSettingsDraft(createRoomSettingsDraft(snapshot), {
      mode: "classic",
      settings: { drawingSeconds: 90, selectionSeconds: 20, rounds: 3 }
    });
    const html = renderToStaticMarkup(
      createElement(RoomSettingsScreen, {
        avatarUrls: new Map(),
        busy: false,
        draft,
        onChange: vi.fn(),
        onRestart: vi.fn(),
        onRestore: vi.fn(),
        onReturnToGame: vi.fn(),
        onSwitchMode: vi.fn(),
        phaseLabel: "绘画中",
        snapshot
      })
    );

    expect(html).toContain('data-ui="room-settings-screen"');
    expect(html).toContain("游戏仍在进行");
    expect(html).toContain("其他玩家仍在游戏中，计时器不会暂停");
    expect(html).toContain("ABC234");
    expect(html).toContain("房主#0001");
    expect(html).toContain("玩家#0002");
    expect(html).toContain("有未应用修改");
    expect(html).toContain("内容资源请在游戏大厅中修改");
    expect(html).toContain("返回游戏");
    expect(html).toContain("恢复当前设置");
    expect(html).toContain('data-ui="apply-and-restart"');
    expect(html).toContain("应用并重启游戏");
    expect(html).not.toContain("game:return-lobby");
  });
});
