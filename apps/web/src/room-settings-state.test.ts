import type { PublicRoomSnapshot } from "@draw-guess/shared-types";
import { describe, expect, it } from "vitest";

import {
  canOpenRoomSettings,
  createRestartCommand,
  createRoomSettingsDraft,
  createSwitchModeCommand,
  reconcileRoomSettingsDraft,
  roomSettingsDirty,
  snapshotInvalidatesRoomSettings,
  updateRoomSettingsDraft
} from "./room-settings-state.js";

function snapshot(overrides: Partial<PublicRoomSnapshot> = {}): PublicRoomSnapshot {
  return {
    roomCode: "ABC234",
    hostId: "host",
    selfPlayerId: "host",
    modeSessionId: "mode-session-a",
    players: [],
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
      scores: { host: 100 },
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
    },
    ...overrides
  };
}

describe("local room settings state", () => {
  it("opens only for the host during a real game without creating a command", () => {
    const active = snapshot();
    expect(canOpenRoomSettings(active)).toBe(true);
    expect(canOpenRoomSettings(snapshot({ selfPlayerId: "guest" }))).toBe(false);
    expect(
      canOpenRoomSettings({
        ...active,
        game: { ...active.game, phase: "LOBBY" }
      })
    ).toBe(false);
    expect(createRoomSettingsDraft(active)).not.toHaveProperty("type");
  });

  it("keeps a dirty draft across same-session snapshots and drops stale sessions", () => {
    const active = snapshot();
    const dirty = updateRoomSettingsDraft(createRoomSettingsDraft(active), {
      mode: "classic",
      settings: { drawingSeconds: 90, selectionSeconds: 15, rounds: 3 }
    });
    expect(roomSettingsDirty(dirty)).toBe(true);
    expect(
      reconcileRoomSettingsDraft(
        dirty,
        snapshot({
          chat: [
            {
              id: "chat",
              kind: "chat",
              playerId: "host",
              nickname: "房主",
              text: "快照更新",
              createdAt: 2
            }
          ]
        })
      )
    ).toBe(dirty);
    expect(
      reconcileRoomSettingsDraft(dirty, snapshot({ modeSessionId: "mode-session-b" }))
    ).toBeNull();
    expect(
      snapshotInvalidatesRoomSettings(
        active,
        snapshot({ modeSessionId: "mode-session-b" })
      )
    ).toBe(true);
    expect(snapshotInvalidatesRoomSettings(active, snapshot({ hostId: "guest" }))).toBe(
      true
    );
  });

  it("builds an atomic same-mode restart and a distinct mode switch", () => {
    const active = snapshot();
    const draft = updateRoomSettingsDraft(createRoomSettingsDraft(active), {
      mode: "classic",
      settings: { drawingSeconds: 75, selectionSeconds: 20, rounds: 4 }
    });
    expect(createRestartCommand(active, draft)).toEqual({
      type: "game:restart",
      modeSessionId: "mode-session-a",
      value: {
        mode: "classic",
        settings: { drawingSeconds: 75, selectionSeconds: 20, rounds: 4 }
      }
    });
    expect(createSwitchModeCommand(active, "reference-copy")).toEqual({
      type: "room:switch-mode",
      modeSessionId: "mode-session-a",
      targetMode: "reference-copy"
    });
  });
});
