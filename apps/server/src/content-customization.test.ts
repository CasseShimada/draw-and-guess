import {
  WordPackFileSchema,
  selectionFromPacks,
  type WordPackFile,
  type WordPoolUpload
} from "@draw-guess/content";
import {
  ErrorCode,
  PROTOCOL_VERSION,
  type ClientJsonMessage,
  type ServerJsonMessage
} from "@draw-guess/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { GameService, type RoomAccess } from "./game-service.js";
import type { GameSocket, Room } from "./types.js";

class FakeSocket implements GameSocket {
  readyState = 1;
  bufferedAmount = 0;
  readonly sent: Array<string | Uint8Array> = [];

  send(data: string | Uint8Array): void {
    this.sent.push(data);
  }

  close(): void {
    this.readyState = 3;
  }
}

function messages(socket: FakeSocket): ServerJsonMessage[] {
  return socket.sent
    .filter((item): item is string => typeof item === "string")
    .map((item) => JSON.parse(item) as ServerJsonMessage);
}

function latestMessage<T extends ServerJsonMessage["type"]>(
  socket: FakeSocket,
  type: T
): Extract<ServerJsonMessage, { type: T }> {
  const found = messages(socket)
    .reverse()
    .find(
      (message): message is Extract<ServerJsonMessage, { type: T }> =>
        message.type === type
    );
  if (!found) {
    throw new Error(`missing ${type}`);
  }
  return found;
}

function classicState(room: Room) {
  if (room.modeRuntime.mode !== "classic") {
    throw new Error("expected classic mode");
  }
  return room.modeRuntime.state;
}

async function send(
  service: GameService,
  access: RoomAccess,
  socket: FakeSocket,
  message: ClientJsonMessage
): Promise<void> {
  await service.handleClientMessage(access, socket, message);
}

function uploadWithWords(
  name: string,
  words: Array<{ text: string; aliases?: string[] }>
): WordPoolUpload {
  const now = "2026-07-25T00:00:00.000Z";
  const pack = WordPackFileSchema.parse({
    format: "draw-guess-word-pack",
    schemaVersion: 1,
    id: crypto.randomUUID(),
    name,
    language: "zh-CN",
    revision: 1,
    categories: [
      {
        id: crypto.randomUUID(),
        name: "私密分类",
        enabled: true,
        words: words.map((word) => ({
          id: crypto.randomUUID(),
          text: word.text,
          ...(word.aliases ? { aliases: word.aliases } : {}),
          difficulty: "normal" as const,
          enabled: true
        }))
      }
    ],
    createdAt: now,
    updatedAt: now
  }) satisfies WordPackFile;
  return selectionFromPacks(new Map([[pack.id, new Set([pack.categories[0]!.id])]]), [
    pack
  ]);
}

describe("room word pools and per-mode preferences", () => {
  let now = 1_000;
  let service: GameService;

  beforeEach(() => {
    vi.useFakeTimers();
    now = 1_000;
    service = new GameService({
      roomIdleTtlMs: 60_000,
      reconnectGraceMs: 100,
      desktopSessionTtlMs: 60_000,
      turnResultMs: 100,
      now: () => now
    });
  });

  afterEach(async () => {
    await service.shutdown();
    vi.useRealTimers();
  });

  it("lets only the lobby host configure a frozen private pool and accepts aliases", async () => {
    const created = await service.createRoom("房主", "secret", "desktop");
    const roomCode = created.snapshot.roomCode;
    const joined = await service.joinRoom(roomCode, "玩家", "secret", "browser");
    const host = service.resumeSession(created.sessionToken, "desktop");
    const guest = service.resumeSession(joined.sessionToken, "browser");
    const hostSocket = new FakeSocket();
    const guestSocket = new FakeSocket();
    service.connectPlayer(host, hostSocket, "desktop");
    service.connectPlayer(guest, guestSocket, "browser");
    service.setCaptureReady(roomCode, host.player.id, hostSocket, true);
    await send(service, host, hostSocket, {
      protocolVersion: PROTOCOL_VERSION,
      type: "mode:settings",
      value: {
        mode: "classic",
        settings: {
          drawingSeconds: 60,
          selectionSeconds: 15,
          rounds: 1
        }
      }
    });

    const upload = uploadWithWords("测试私有包", [
      { text: "秘密词甲", aliases: ["暗号甲"] },
      { text: "秘密词乙" },
      { text: "秘密词丙" }
    ]);
    expect(() =>
      service.updateWordPool(roomCode, guest.player.id, upload)
    ).toThrowError(
      expect.objectContaining({
        code: ErrorCode.FORBIDDEN
      })
    );

    const summary = service.updateWordPool(roomCode, host.player.id, upload);
    expect(summary).toMatchObject({
      uniqueWordCount: 3,
      packs: [
        {
          name: "测试私有包",
          selectedCategoryNames: ["私密分类"],
          enabledWordCount: 3
        }
      ]
    });
    const publicJson = JSON.stringify(service.snapshot(host.room, guest.player.id));
    expect(publicJson).not.toContain("秘密词甲");
    expect(publicJson).not.toContain("暗号甲");
    expect(publicJson).not.toContain("aliases");

    const state = classicState(host.room);
    const configuredRevision = state.configuredWordPool.revision;
    await send(service, host, hostSocket, {
      protocolVersion: PROTOCOL_VERSION,
      type: "game:start",
      commandId: "start-private-pool"
    });
    expect(state.gameWordPool?.revision).toBe(configuredRevision);
    expect(new Set(state.currentOptions.map((option) => option.label))).toEqual(
      new Set(["秘密词甲", "秘密词乙", "秘密词丙"])
    );
    upload.packs[0]!.categories[0]!.words[0]!.text = "外部突变";
    expect(state.gameWordPool?.built.words.map((word) => word.text)).not.toContain(
      "外部突变"
    );
    expect(() =>
      service.updateWordPool(
        roomCode,
        host.player.id,
        uploadWithWords("中途替换", [
          { text: "一号" },
          { text: "二号" },
          { text: "三号" }
        ])
      )
    ).toThrowError(
      expect.objectContaining({
        code: ErrorCode.INVALID_STATE
      })
    );

    const aliasOption = [...state.currentOptionWords].find(
      ([, word]) => word.text === "秘密词甲"
    );
    expect(aliasOption).toBeDefined();
    const privateOptions = latestMessage(hostSocket, "classic:word-options");
    await send(service, host, hostSocket, {
      protocolVersion: PROTOCOL_VERSION,
      type: "classic:word-select",
      modeSessionId: host.room.modeSessionId,
      actorStepId: privateOptions.actorStepId,
      optionId: aliasOption![0],
      commandId: "choose-alias-word"
    });
    await send(service, guest, guestSocket, {
      protocolVersion: PROTOCOL_VERSION,
      type: "chat:submit",
      text: " 暗号 甲！ "
    });
    expect(state.phase).toBe("FINALIZING");
    expect(state.scores.get(guest.player.id)).toBeGreaterThan(0);
    await send(service, host, hostSocket, {
      protocolVersion: PROTOCOL_VERSION,
      type: "turn:pass",
      modeSessionId: host.room.modeSessionId,
      actorStepId: state.actorStepId!,
      targetPlayerId: host.player.id,
      commandId: "freeze-alias-turn"
    });

    now += 100;
    await vi.advanceTimersByTimeAsync(100);
    expect(state.phase).toBe("GAME_RESULT");
    await send(service, host, hostSocket, {
      protocolVersion: PROTOCOL_VERSION,
      type: "game:return-lobby",
      commandId: "return-after-alias"
    });
    now += 501;
    const nextSummary = service.updateWordPool(
      roomCode,
      host.player.id,
      uploadWithWords("下一局", [{ text: "春天" }, { text: "夏天" }, { text: "秋天" }])
    );
    expect(nextSummary.packs[0]?.name).toBe("下一局");
    expect(state.gameWordPool).toBeNull();
  });

  it("rate-limits repeated lobby updates and rejects a too-small pool at start", async () => {
    const created = await service.createRoom("房主", "secret", "desktop");
    const roomCode = created.snapshot.roomCode;
    const joined = await service.joinRoom(roomCode, "玩家", "secret", "browser");
    const host = service.resumeSession(created.sessionToken, "desktop");
    const hostSocket = new FakeSocket();
    service.connectPlayer(host, hostSocket, "desktop");
    service.connectPlayer(
      service.resumeSession(joined.sessionToken, "browser"),
      new FakeSocket(),
      "browser"
    );
    service.setCaptureReady(roomCode, host.player.id, hostSocket, true);
    const small = uploadWithWords("过小词池", [{ text: "只有一" }, { text: "只有二" }]);
    service.updateWordPool(roomCode, host.player.id, small);
    expect(() => service.updateWordPool(roomCode, host.player.id, small)).toThrowError(
      expect.objectContaining({
        code: ErrorCode.RATE_LIMITED
      })
    );
    await expect(
      send(service, host, hostSocket, {
        protocolVersion: PROTOCOL_VERSION,
        type: "game:start",
        commandId: "start-too-small"
      })
    ).rejects.toThrow("至少需要 3 个");
    expect(host.room.runControl.status).toBe("idle");
  });

  it("isolates and restores settings and word pools by mode", async () => {
    const created = await service.createRoom("房主", "secret", "desktop");
    const roomCode = created.snapshot.roomCode;
    const host = service.resumeSession(created.sessionToken, "desktop");
    const hostSocket = new FakeSocket();
    service.connectPlayer(host, hostSocket, "desktop");
    await send(service, host, hostSocket, {
      protocolVersion: PROTOCOL_VERSION,
      type: "mode:settings",
      value: {
        mode: "classic",
        settings: {
          drawingSeconds: 91,
          selectionSeconds: 17,
          rounds: 3
        }
      }
    });
    const classicPool = uploadWithWords("经典专用", [
      { text: "一" },
      { text: "二" },
      { text: "三" }
    ]);
    const classicSummary = service.updateWordPool(
      roomCode,
      host.player.id,
      classicPool
    );

    const firstModeSession = host.room.modeSessionId;
    await send(service, host, hostSocket, {
      protocolVersion: PROTOCOL_VERSION,
      type: "room:switch-mode",
      modeSessionId: firstModeSession,
      targetMode: "reference-copy",
      commandId: "to-reference-one"
    });
    await expect(
      send(service, host, hostSocket, {
        protocolVersion: PROTOCOL_VERSION,
        type: "mode:settings",
        value: {
          mode: "classic",
          settings: {
            drawingSeconds: 60,
            selectionSeconds: 15,
            rounds: 1
          }
        }
      })
    ).rejects.toMatchObject({ code: ErrorCode.INVALID_STATE });
    await send(service, host, hostSocket, {
      protocolVersion: PROTOCOL_VERSION,
      type: "mode:settings",
      value: {
        mode: "reference-copy",
        settings: {
          durationSeconds: 97,
          votingSeconds: 120
        }
      }
    });
    const referenceSnapshot = service.snapshot(host.room, host.player.id);
    expect(referenceSnapshot.game).toMatchObject({
      mode: "reference-copy",
      settings: { durationSeconds: 97, votingSeconds: 120 }
    });
    expect("currentDrawerId" in referenceSnapshot.game).toBe(false);

    await send(service, host, hostSocket, {
      protocolVersion: PROTOCOL_VERSION,
      type: "room:switch-mode",
      modeSessionId: host.room.modeSessionId,
      targetMode: "classic",
      commandId: "back-to-classic"
    });
    const restored = classicState(host.room);
    expect(restored.settings).toEqual({
      drawingSeconds: 91,
      selectionSeconds: 17,
      rounds: 3
    });
    expect(restored.configuredWordPool.summary).toEqual(classicSummary);

    await send(service, host, hostSocket, {
      protocolVersion: PROTOCOL_VERSION,
      type: "room:switch-mode",
      modeSessionId: host.room.modeSessionId,
      targetMode: "reference-copy",
      commandId: "to-reference-two"
    });
    if (host.room.modeRuntime.mode !== "reference-copy") {
      throw new Error("expected reference-copy mode");
    }
    expect(host.room.modeRuntime.state.settings).toEqual({
      durationSeconds: 97,
      votingSeconds: 120
    });
    expect(host.room.modeRuntime.state.reference).toBeNull();
  });
});
