import {
  DEFAULT_CLASSIC_SETTINGS,
  DEFAULT_DRAW_RELAY_SETTINGS,
  DEFAULT_REFERENCE_COPY_SETTINGS,
  type GameModeId
} from "@draw-guess/shared-types";

import { createDefaultRoomWordPool, createRoomWordPool } from "../room-content.js";
import type { RoomModePreferences, RoomModeRuntime } from "../types.js";
import type { ReplayService } from "../services/replay-service.js";
import {
  ClassicModeController,
  type ClassicModeOptions
} from "./classic/classic-mode.js";
import { DrawRelayModeController } from "./draw-relay/draw-relay-mode.js";
import type { GameModeController } from "./game-mode.js";
import { ReferenceCopyModeController } from "./reference-copy/reference-copy-mode.js";

export class GameModeRegistry {
  readonly classic: ClassicModeController;
  readonly referenceCopy = new ReferenceCopyModeController();
  readonly drawRelay: DrawRelayModeController;

  constructor(classicOptions: ClassicModeOptions, replay: ReplayService) {
    this.classic = new ClassicModeController(classicOptions);
    this.drawRelay = new DrawRelayModeController(replay);
  }

  controller(mode: GameModeId): GameModeController {
    switch (mode) {
      case "classic":
        return this.classic;
      case "reference-copy":
        return this.referenceCopy;
      case "draw-relay":
        return this.drawRelay;
    }
  }

  createDefaultPreferences(): RoomModePreferences {
    const defaultUpload = createDefaultRoomWordPool().upload;
    return {
      classic: {
        settings: { ...DEFAULT_CLASSIC_SETTINGS },
        wordPool: structuredClone(defaultUpload)
      },
      "reference-copy": {
        settings: { ...DEFAULT_REFERENCE_COPY_SETTINGS }
      },
      "draw-relay": {
        settings: { ...DEFAULT_DRAW_RELAY_SETTINGS },
        wordPool: structuredClone(defaultUpload)
      }
    };
  }

  rememberPreferences(
    runtime: RoomModeRuntime,
    preferences: RoomModePreferences
  ): void {
    switch (runtime.mode) {
      case "classic":
        preferences.classic = {
          settings: { ...runtime.state.settings },
          wordPool: structuredClone(runtime.state.configuredWordPool.upload)
        };
        return;
      case "reference-copy":
        preferences["reference-copy"] = {
          settings: { ...runtime.state.settings }
        };
        return;
      case "draw-relay":
        preferences["draw-relay"] = {
          settings: { ...runtime.state.settings },
          wordPool: structuredClone(runtime.state.configuredWordPool.upload)
        };
    }
  }

  createRuntime(mode: GameModeId, preferences?: RoomModePreferences): RoomModeRuntime {
    switch (mode) {
      case "classic": {
        const state = this.classic.createLobbyState();
        if (preferences) {
          state.settings = { ...preferences.classic.settings };
          state.configuredWordPool = createRoomWordPool(preferences.classic.wordPool);
        }
        return { mode, state };
      }
      case "reference-copy": {
        const state = this.referenceCopy.createLobbyState();
        if (preferences) {
          state.settings = { ...preferences["reference-copy"].settings };
        }
        return { mode, state };
      }
      case "draw-relay": {
        const state = this.drawRelay.createLobbyState();
        if (preferences) {
          state.settings = { ...preferences["draw-relay"].settings };
          state.configuredWordPool = createRoomWordPool(
            preferences["draw-relay"].wordPool
          );
        }
        return { mode, state };
      }
    }
  }
}
