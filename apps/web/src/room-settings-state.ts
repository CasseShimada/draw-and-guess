import type {
  GameModeId,
  GameModeSettings,
  PublicRoomSnapshot
} from "@draw-guess/shared-types";

export type RoomScreen = "game" | "room-settings";
export type PartialReplayChoice = "encode-and-save" | "discard";

export interface RoomSettingsDraft {
  modeSessionId: string;
  baseline: GameModeSettings;
  value: GameModeSettings;
}

function settingsFromSnapshot(snapshot: PublicRoomSnapshot): GameModeSettings {
  switch (snapshot.game.mode) {
    case "classic":
      return { mode: "classic", settings: { ...snapshot.game.settings } };
    case "reference-copy":
      return {
        mode: "reference-copy",
        settings: { ...snapshot.game.settings }
      };
    case "draw-relay":
      return { mode: "draw-relay", settings: { ...snapshot.game.settings } };
  }
}

function cloneSettings(value: GameModeSettings): GameModeSettings {
  switch (value.mode) {
    case "classic":
      return { mode: "classic", settings: { ...value.settings } };
    case "reference-copy":
      return { mode: "reference-copy", settings: { ...value.settings } };
    case "draw-relay":
      return { mode: "draw-relay", settings: { ...value.settings } };
  }
}

export function createRoomSettingsDraft(
  snapshot: PublicRoomSnapshot
): RoomSettingsDraft {
  const baseline = settingsFromSnapshot(snapshot);
  return {
    modeSessionId: snapshot.modeSessionId,
    baseline,
    value: cloneSettings(baseline)
  };
}

export function updateRoomSettingsDraft(
  draft: RoomSettingsDraft,
  value: GameModeSettings
): RoomSettingsDraft {
  if (draft.value.mode !== value.mode) {
    throw new Error("房间设置草稿不能跨模式更新");
  }
  return { ...draft, value: cloneSettings(value) };
}

export function reconcileRoomSettingsDraft(
  draft: RoomSettingsDraft | null,
  snapshot: PublicRoomSnapshot
): RoomSettingsDraft | null {
  if (
    !draft ||
    draft.modeSessionId !== snapshot.modeSessionId ||
    draft.value.mode !== snapshot.game.mode
  ) {
    return null;
  }
  return draft;
}

export function snapshotInvalidatesRoomSettings(
  previous: PublicRoomSnapshot | null,
  next: PublicRoomSnapshot
): boolean {
  return (
    (previous !== null && previous.modeSessionId !== next.modeSessionId) ||
    next.hostId !== next.selfPlayerId
  );
}

export function roomSettingsDirty(draft: RoomSettingsDraft): boolean {
  return JSON.stringify(draft.baseline) !== JSON.stringify(draft.value);
}

export function canOpenRoomSettings(snapshot: PublicRoomSnapshot): boolean {
  return snapshot.hostId === snapshot.selfPlayerId && snapshot.game.phase !== "LOBBY";
}

export function createRestartCommand(
  snapshot: PublicRoomSnapshot,
  draft: RoomSettingsDraft,
  partialReplay?: PartialReplayChoice
) {
  if (
    draft.modeSessionId !== snapshot.modeSessionId ||
    draft.value.mode !== snapshot.game.mode
  ) {
    throw new Error("房间设置草稿已经失效");
  }
  return {
    type: "game:restart" as const,
    modeSessionId: snapshot.modeSessionId,
    value: cloneSettings(draft.value),
    ...(partialReplay ? { partialReplay } : {})
  };
}

export function createSwitchModeCommand(
  snapshot: PublicRoomSnapshot,
  targetMode: GameModeId,
  partialReplay?: PartialReplayChoice
) {
  return {
    type: "room:switch-mode" as const,
    modeSessionId: snapshot.modeSessionId,
    targetMode,
    ...(partialReplay ? { partialReplay } : {})
  };
}

export function needsPartialReplayChoice(snapshot: PublicRoomSnapshot): boolean {
  return (
    snapshot.game.mode === "draw-relay" &&
    snapshot.game.phase !== "LOBBY" &&
    snapshot.game.phase !== "RESULT"
  );
}
