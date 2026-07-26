import {
  PROTOCOL_VERSION,
  ROOM_REMOVED_CLOSE_CODE,
  decodeViewerFrame,
  encodeUploadFrame,
  type ClientJsonMessage,
  type ServerJsonMessage
} from "@draw-guess/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { GameError, GameService, type RoomAccess } from "./game-service.js";
import type { GameSocket, Room } from "./types.js";

const JPEG_A = Uint8Array.from([0xff, 0xd8, 0x01, 0xff, 0xd9]);
const JPEG_B = Uint8Array.from([0xff, 0xd8, 0x02, 0xff, 0xd9]);
const WEBP = Uint8Array.from([
  0x52, 0x49, 0x46, 0x46, 0x04, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50
]);

class FakeSocket implements GameSocket {
  readyState = 1;
  bufferedAmount = 0;
  readonly sent: Array<string | Uint8Array> = [];
  closedWith: { code?: number; reason?: string } | null = null;

  send(data: string | Uint8Array): void {
    this.sent.push(data);
  }

  close(code?: number, reason?: string): void {
    this.closedWith = { code, reason };
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
  type: T,
  predicate?: (message: Extract<ServerJsonMessage, { type: T }>) => boolean
): Extract<ServerJsonMessage, { type: T }> {
  const found = messages(socket)
    .reverse()
    .find(
      (message): message is Extract<ServerJsonMessage, { type: T }> =>
        message.type === type &&
        (!predicate || predicate(message as Extract<ServerJsonMessage, { type: T }>))
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

function makeService(now: () => number): GameService {
  return new GameService({
    roomIdleTtlMs: 1_000,
    reconnectGraceMs: 100,
    desktopSessionTtlMs: 10_000,
    turnResultMs: 100,
    hostControlKey: "local-host-key",
    now
  });
}

describe("game service protocol-v5 classic flow", () => {
  let currentTime = 1_000;
  let service: GameService;

  beforeEach(() => {
    vi.useFakeTimers();
    currentTime = 1_000;
    service = makeService(() => currentTime);
  });

  afterEach(async () => {
    await service.shutdown();
    vi.useRealTimers();
  });

  it("assigns stable unique numeric nickname tags and lets the embedded host rotate the room password", async () => {
    const hostJoin = await service.createRoom("同名玩家", "old-secret", "desktop");
    const roomCode = hostJoin.snapshot.roomCode;
    const guestJoin = await service.joinRoom(
      roomCode,
      "同名玩家",
      "old-secret",
      "desktop"
    );
    const initialNames = hostJoin.snapshot.players.map((player) => player.nickname);
    const joinedNames = guestJoin.snapshot.players.map((player) => player.nickname);

    expect(initialNames[0]).toMatch(/^同名玩家#\d{4}$/u);
    expect(joinedNames).toHaveLength(2);
    expect(new Set(joinedNames).size).toBe(2);
    expect(
      guestJoin.snapshot.players.find(
        (player) => player.id === hostJoin.snapshot.selfPlayerId
      )?.nickname
    ).toBe(initialNames[0]);

    await expect(
      service.changePasswordFromEmbeddedHost("not-the-host-key", roomCode, "new-secret")
    ).rejects.toThrow("此操作只允许实际内嵌服务器主机执行");

    await service.changePasswordFromEmbeddedHost(
      "local-host-key",
      roomCode,
      "new-secret"
    );
    await expect(
      service.joinRoom(roomCode, "旧密码玩家", "old-secret", "desktop")
    ).rejects.toThrow("房间密码错误");
    const newGuest = await service.joinRoom(
      roomCode,
      "新密码玩家",
      "new-secret",
      "desktop"
    );
    expect(
      newGuest.snapshot.players.find(
        (player) => player.id === newGuest.snapshot.selfPlayerId
      )?.nickname
    ).toMatch(/^新密码玩家#\d{4}$/u);
    expect(service.resumeSession(hostJoin.sessionToken, "desktop").player.id).toBe(
      hostJoin.snapshot.selfPlayerId
    );
  });

  it("lets only the embedded host close a room and gives every player a terminal reason", async () => {
    const hostJoin = await service.createRoom("房主", "secret", "desktop");
    const roomCode = hostJoin.snapshot.roomCode;
    const guestJoin = await service.joinRoom(roomCode, "玩家", "secret", "desktop");
    const host = service.resumeSession(hostJoin.sessionToken, "desktop");
    const guest = service.resumeSession(guestJoin.sessionToken, "desktop");
    const hostSocket = new FakeSocket();
    const guestSocket = new FakeSocket();
    service.connectPlayer(host, hostSocket, "desktop");
    service.connectPlayer(guest, guestSocket, "desktop");

    expect(() => service.closeRoomFromEmbeddedHost("remote-forgery", roomCode)).toThrow(
      "此操作只允许实际内嵌服务器主机执行"
    );
    expect(service.rooms.has(roomCode)).toBe(true);

    service.closeRoomFromEmbeddedHost("local-host-key", roomCode);

    expect(service.rooms.has(roomCode)).toBe(false);
    for (const socket of [hostSocket, guestSocket]) {
      expect(latestMessage(socket, "error")).toMatchObject({
        code: "NOT_FOUND",
        message: "房主已关闭房间"
      });
      expect(socket.closedWith).toEqual({
        code: ROOM_REMOVED_CLOSE_CODE,
        reason: "房主已关闭房间"
      });
    }
    await expect(
      service.joinRoom(roomCode, "迟到玩家", "secret", "desktop")
    ).rejects.toThrow("房间不存在");
  });

  it("keeps words private, relays accepted frames, finalizes for ten seconds, and scores", async () => {
    const hostJoin = await service.createRoom("画手", "secret", "desktop");
    const roomCode = hostJoin.snapshot.roomCode;
    const guestJoin = await service.joinRoom(roomCode, "猜词者", "secret");
    const host = service.resumeSession(hostJoin.sessionToken, "desktop");
    const guest = service.resumeSession(guestJoin.sessionToken, "browser");
    const hostSocket = new FakeSocket();
    const guestSocket = new FakeSocket();
    service.connectPlayer(host, hostSocket, "desktop");
    service.connectPlayer(guest, guestSocket, "browser");

    await expect(
      send(service, guest, guestSocket, {
        protocolVersion: PROTOCOL_VERSION,
        type: "capture:ready",
        ready: true
      })
    ).rejects.toBeInstanceOf(GameError);
    await send(service, host, hostSocket, {
      protocolVersion: PROTOCOL_VERSION,
      type: "capture:ready",
      ready: true
    });
    await send(service, host, hostSocket, {
      protocolVersion: PROTOCOL_VERSION,
      type: "game:start",
      commandId: "start-private-flow"
    });

    const options = latestMessage(hostSocket, "classic:word-options");
    expect(options.options).toHaveLength(3);
    expect(
      messages(guestSocket).some((message) => message.type === "classic:word-options")
    ).toBe(false);

    await send(service, host, hostSocket, {
      protocolVersion: PROTOCOL_VERSION,
      type: "classic:word-select",
      modeSessionId: host.room.modeSessionId,
      actorStepId: options.actorStepId,
      optionId: options.options[0]!.id,
      commandId: "select-private-word"
    });
    const selected = latestMessage(hostSocket, "classic:word-selected");
    const drawingCapture = latestMessage(
      hostSocket,
      "capture:start",
      (message) => message.stage === "drawing"
    );
    expect(JSON.stringify(messages(guestSocket))).not.toContain(selected.answer);

    expect(
      service.handleDesktopFrame(
        host,
        hostSocket,
        encodeUploadFrame(drawingCapture.captureSessionId, JPEG_A)
      )
    ).toEqual({ accepted: true, sequence: 1 });
    expect(
      service.handleDesktopFrame(
        host,
        hostSocket,
        encodeUploadFrame(drawingCapture.captureSessionId, JPEG_B)
      )
    ).toEqual({ accepted: false, reason: "FRAME_RATE_LIMITED" });

    currentTime += 800;
    expect(
      service.handleDesktopFrame(
        host,
        hostSocket,
        encodeUploadFrame(drawingCapture.captureSessionId, WEBP)
      )
    ).toEqual({ accepted: true, sequence: 2 });

    const reconnectSocket = new FakeSocket();
    service.disconnectPlayer(roomCode, guest.player.id, guestSocket);
    service.connectPlayer(guest, reconnectSocket, "browser");
    const replayedFrame = reconnectSocket.sent.find(
      (item): item is Uint8Array => typeof item !== "string"
    );
    expect(replayedFrame).toBeDefined();
    expect(decodeViewerFrame(replayedFrame!).sequence).toBe(2);

    await send(service, guest, reconnectSocket, {
      protocolVersion: PROTOCOL_VERSION,
      type: "chat:submit",
      text: selected.answer
    });
    const state = classicState(host.room);
    expect(state.phase).toBe("FINALIZING");
    expect(state.turnResult).toBeNull();
    const finalizationCapture = latestMessage(
      hostSocket,
      "capture:start",
      (message) => message.stage === "finalizing"
    );
    expect(finalizationCapture.captureSessionId).not.toBe(
      drawingCapture.captureSessionId
    );
    expect(
      service.handleDesktopFrame(
        host,
        hostSocket,
        encodeUploadFrame(drawingCapture.captureSessionId, JPEG_A)
      )
    ).toEqual({ accepted: false, reason: "UPLOAD_NOT_AUTHORIZED" });
    expect(
      service.handleDesktopFrame(
        host,
        hostSocket,
        encodeUploadFrame(finalizationCapture.captureSessionId, JPEG_B)
      )
    ).toEqual({ accepted: true, sequence: 3 });

    await send(service, host, hostSocket, {
      protocolVersion: PROTOCOL_VERSION,
      type: "turn:pass",
      modeSessionId: host.room.modeSessionId,
      actorStepId: state.actorStepId!,
      targetPlayerId: host.player.id,
      commandId: "freeze-final-frame"
    });
    expect(state.phase).toBe("TURN_RESULT");
    expect(state.turnResult?.reason).toBe("ALL_GUESSED");
    expect(state.turnResult?.answer).toBe(selected.answer);
    expect(state.scores.get(guest.player.id)).toBeGreaterThan(0);
    expect(state.scores.get(host.player.id)).toBe(50);
    expect(
      service.handleDesktopFrame(
        host,
        hostSocket,
        encodeUploadFrame(finalizationCapture.captureSessionId, JPEG_A)
      ).accepted
    ).toBe(false);
  });

  it("hands the immutable options and answer forward, preserves scores, and deduplicates Pass", async () => {
    const hostJoin = await service.createRoom("甲", "secret", "desktop");
    const roomCode = hostJoin.snapshot.roomCode;
    currentTime += 1;
    const secondJoin = await service.joinRoom(roomCode, "乙", "secret", "desktop");
    currentTime += 1;
    const thirdJoin = await service.joinRoom(roomCode, "丙", "secret", "desktop");
    const guesserJoin = await service.joinRoom(roomCode, "猜词者", "secret");
    const host = service.resumeSession(hostJoin.sessionToken, "desktop");
    const second = service.resumeSession(secondJoin.sessionToken, "desktop");
    const third = service.resumeSession(thirdJoin.sessionToken, "desktop");
    const guesser = service.resumeSession(guesserJoin.sessionToken, "browser");
    const hostSocket = new FakeSocket();
    const secondSocket = new FakeSocket();
    const thirdSocket = new FakeSocket();
    const guesserSocket = new FakeSocket();
    service.connectPlayer(host, hostSocket, "desktop");
    service.connectPlayer(second, secondSocket, "desktop");
    service.connectPlayer(third, thirdSocket, "desktop");
    service.connectPlayer(guesser, guesserSocket, "browser");
    for (const [access, socket] of [
      [host, hostSocket],
      [second, secondSocket],
      [third, thirdSocket]
    ] as const) {
      await send(service, access, socket, {
        protocolVersion: PROTOCOL_VERSION,
        type: "capture:ready",
        ready: true
      });
    }
    await send(service, host, hostSocket, {
      protocolVersion: PROTOCOL_VERSION,
      type: "game:start",
      commandId: "start-pass-flow"
    });

    const firstOptions = latestMessage(hostSocket, "classic:word-options");
    const selectionPass: ClientJsonMessage = {
      protocolVersion: PROTOCOL_VERSION,
      type: "turn:pass",
      modeSessionId: host.room.modeSessionId,
      actorStepId: firstOptions.actorStepId,
      targetPlayerId: host.player.id,
      commandId: "same-selection-pass"
    };
    await send(service, host, hostSocket, selectionPass);
    const state = classicState(host.room);
    expect(state.currentDrawerId).toBe(second.player.id);
    const forwardedOptions = latestMessage(secondSocket, "classic:word-options");
    expect(forwardedOptions.options).toEqual(firstOptions.options);
    const forwardedActor = state.actorStepId;
    await send(service, host, hostSocket, selectionPass);
    expect(state.currentDrawerId).toBe(second.player.id);
    expect(state.actorStepId).toBe(forwardedActor);

    await send(service, second, secondSocket, {
      protocolVersion: PROTOCOL_VERSION,
      type: "classic:word-select",
      modeSessionId: host.room.modeSessionId,
      actorStepId: forwardedOptions.actorStepId,
      optionId: forwardedOptions.options[0]!.id,
      commandId: "second-selects"
    });
    const answer = latestMessage(secondSocket, "classic:word-selected").answer;
    const secondCapture = latestMessage(
      secondSocket,
      "capture:start",
      (message) => message.stage === "drawing"
    );
    await send(service, guesser, guesserSocket, {
      protocolVersion: PROTOCOL_VERSION,
      type: "chat:submit",
      text: answer
    });
    const scoreAfterFirstGuess = state.scores.get(guesser.player.id);
    const drawingActor = state.actorStepId!;
    await send(service, second, secondSocket, {
      protocolVersion: PROTOCOL_VERSION,
      type: "turn:pass",
      modeSessionId: host.room.modeSessionId,
      actorStepId: drawingActor,
      targetPlayerId: second.player.id,
      commandId: "second-drawing-pass"
    });
    expect(state.currentDrawerId).toBe(third.player.id);
    expect(latestMessage(thirdSocket, "classic:word-selected").answer).toBe(answer);
    await expect(
      send(service, guesser, guesserSocket, {
        protocolVersion: PROTOCOL_VERSION,
        type: "chat:submit",
        text: answer
      })
    ).rejects.toMatchObject({ code: "INVALID_STATE" });
    expect(state.scores.get(guesser.player.id)).toBe(scoreAfterFirstGuess);
    expect(
      service.handleDesktopFrame(
        second,
        secondSocket,
        encodeUploadFrame(secondCapture.captureSessionId, JPEG_A)
      )
    ).toEqual({ accepted: false, reason: "UPLOAD_NOT_AUTHORIZED" });

    const lastPass: ClientJsonMessage = {
      protocolVersion: PROTOCOL_VERSION,
      type: "turn:pass",
      modeSessionId: host.room.modeSessionId,
      actorStepId: state.actorStepId!,
      targetPlayerId: third.player.id,
      commandId: "host-passes-third"
    };
    await send(service, host, hostSocket, lastPass);
    expect(state.phase).toBe("TURN_RESULT");
    expect(state.turnResult?.reason).toBe("ALL_PASSED");
    const result = structuredClone(state.turnResult);
    await send(service, host, hostSocket, lastPass);
    expect(state.turnResult).toEqual(result);
  });

  it("freezes a paused step, lets only the host Pass, and resumes with a new capture session", async () => {
    const hostJoin = await service.createRoom("主机", "secret", "desktop");
    const roomCode = hostJoin.snapshot.roomCode;
    currentTime += 1;
    const nextJoin = await service.joinRoom(roomCode, "下一位", "secret", "desktop");
    const viewerJoin = await service.joinRoom(roomCode, "观众", "secret");
    const host = service.resumeSession(hostJoin.sessionToken, "desktop");
    const next = service.resumeSession(nextJoin.sessionToken, "desktop");
    const viewer = service.resumeSession(viewerJoin.sessionToken, "browser");
    const hostSocket = new FakeSocket();
    const nextSocket = new FakeSocket();
    const viewerSocket = new FakeSocket();
    service.connectPlayer(host, hostSocket, "desktop");
    service.connectPlayer(next, nextSocket, "desktop");
    service.connectPlayer(viewer, viewerSocket, "browser");
    await send(service, host, hostSocket, {
      protocolVersion: PROTOCOL_VERSION,
      type: "capture:ready",
      ready: true
    });
    await send(service, next, nextSocket, {
      protocolVersion: PROTOCOL_VERSION,
      type: "capture:ready",
      ready: true
    });
    await send(service, host, hostSocket, {
      protocolVersion: PROTOCOL_VERSION,
      type: "game:start",
      commandId: "start-pause-flow"
    });
    const options = latestMessage(hostSocket, "classic:word-options");
    await send(service, host, hostSocket, {
      protocolVersion: PROTOCOL_VERSION,
      type: "classic:word-select",
      modeSessionId: host.room.modeSessionId,
      actorStepId: options.actorStepId,
      optionId: options.options[0]!.id,
      commandId: "select-before-pause"
    });
    const state = classicState(host.room);
    if (state.drawing?.status !== "drawing") {
      throw new Error("expected drawing before pause");
    }
    const oldCaptureSessionId = state.drawing.captureSessionId;
    expect(oldCaptureSessionId).toBeTypeOf("number");

    expect(() =>
      service.pauseFromEmbeddedHost("remote-forgery", roomCode)
    ).toThrowError(GameError);
    service.pauseFromEmbeddedHost("local-host-key", roomCode);
    service.pauseFromEmbeddedHost("local-host-key", roomCode);
    expect(host.room.runControl.status).toBe("paused");
    expect(
      service.handleDesktopFrame(
        host,
        hostSocket,
        encodeUploadFrame(oldCaptureSessionId, JPEG_A)
      )
    ).toEqual({ accepted: false, reason: "UPLOAD_NOT_AUTHORIZED" });
    await expect(
      send(service, host, hostSocket, {
        protocolVersion: PROTOCOL_VERSION,
        type: "capture:ready",
        ready: true
      })
    ).rejects.toMatchObject({ code: "INVALID_STATE" });
    await expect(
      send(service, viewer, viewerSocket, {
        protocolVersion: PROTOCOL_VERSION,
        type: "chat:submit",
        text: "暂停中"
      })
    ).rejects.toMatchObject({ code: "INVALID_STATE" });

    const pausedPass: ClientJsonMessage = {
      protocolVersion: PROTOCOL_VERSION,
      type: "turn:pass",
      modeSessionId: host.room.modeSessionId,
      actorStepId: state.actorStepId!,
      targetPlayerId: host.player.id,
      commandId: "host-pass-while-paused"
    };
    await send(service, host, hostSocket, pausedPass);
    expect(state.currentDrawerId).toBe(next.player.id);
    expect(host.room.runControl.status).toBe("paused");
    const pausedActor = state.actorStepId;
    await send(service, host, hostSocket, pausedPass);
    expect(state.actorStepId).toBe(pausedActor);

    currentTime += 10 * 60_000;
    service.resumeFromEmbeddedHost("local-host-key", roomCode);
    const resumedDeadline = state.phaseEndsAt!;
    expect(resumedDeadline - currentTime).toBe(63_000);
    expect(host.room.runControl).toMatchObject({
      status: "running",
      captureResumesAt: currentTime + 3_000
    });
    if (state.drawing?.status !== "drawing") {
      throw new Error("expected drawing after resume");
    }
    const resumedCaptureSessionId = state.drawing.captureSessionId;
    expect(resumedCaptureSessionId).not.toBe(oldCaptureSessionId);
    service.resumeFromEmbeddedHost("local-host-key", roomCode);
    expect(state.phaseEndsAt).toBe(resumedDeadline);

    currentTime += 2_999;
    await vi.advanceTimersByTimeAsync(2_999);
    expect(next.player.uploadGrant).toBeNull();
    currentTime += 1;
    await vi.advanceTimersByTimeAsync(1);
    const resumedCapture = latestMessage(
      nextSocket,
      "capture:start",
      (message) => message.stage === "drawing"
    );
    expect(resumedCapture.captureSessionId).toBe(resumedCaptureSessionId);
    expect(
      service.handleDesktopFrame(
        next,
        nextSocket,
        encodeUploadFrame(resumedCapture.captureSessionId, JPEG_A)
      )
    ).toEqual({ accepted: true, sequence: 1 });
  });

  it("keeps the finalization boundary at exactly ten seconds", async () => {
    const hostJoin = await service.createRoom("画手", "secret", "desktop");
    const roomCode = hostJoin.snapshot.roomCode;
    const guestJoin = await service.joinRoom(roomCode, "玩家", "secret");
    const host = service.resumeSession(hostJoin.sessionToken, "desktop");
    const guest = service.resumeSession(guestJoin.sessionToken, "browser");
    const hostSocket = new FakeSocket();
    service.connectPlayer(host, hostSocket, "desktop");
    service.connectPlayer(guest, new FakeSocket(), "browser");
    await send(service, host, hostSocket, {
      protocolVersion: PROTOCOL_VERSION,
      type: "capture:ready",
      ready: true
    });
    await send(service, host, hostSocket, {
      protocolVersion: PROTOCOL_VERSION,
      type: "game:start",
      commandId: "start-boundary"
    });
    const options = latestMessage(hostSocket, "classic:word-options");
    await send(service, host, hostSocket, {
      protocolVersion: PROTOCOL_VERSION,
      type: "classic:word-select",
      modeSessionId: host.room.modeSessionId,
      actorStepId: options.actorStepId,
      optionId: options.options[0]!.id,
      commandId: "select-boundary"
    });
    const state = classicState(host.room);
    await send(service, host, hostSocket, {
      protocolVersion: PROTOCOL_VERSION,
      type: "drawing:finish",
      modeSessionId: host.room.modeSessionId,
      actorStepId: state.actorStepId!,
      commandId: "finish-boundary"
    });
    expect(state.phase).toBe("FINALIZING");
    expect(state.drawing?.status).toBe("finalizing");
    if (state.drawing?.status !== "finalizing") {
      throw new Error("expected finalization");
    }
    expect(state.drawing.finalizationEndsAt - currentTime).toBe(10_000);

    currentTime += 9_999;
    await vi.advanceTimersByTimeAsync(9_999);
    expect(state.phase).toBe("FINALIZING");
    currentTime += 1;
    await vi.advanceTimersByTimeAsync(1);
    expect(state.phase).toBe("TURN_RESULT");
    expect(state.turnResult?.reason).toBe("TIME_UP");
  });

  it("ends after capture loss, transfers logical host, and cleans an empty room", async () => {
    const hostJoin = await service.createRoom("房主", "secret", "desktop");
    const roomCode = hostJoin.snapshot.roomCode;
    const guestJoin = await service.joinRoom(roomCode, "玩家", "secret");
    const host = service.resumeSession(hostJoin.sessionToken, "desktop");
    const guest = service.resumeSession(guestJoin.sessionToken, "browser");
    const hostSocket = new FakeSocket();
    const guestSocket = new FakeSocket();
    service.connectPlayer(host, hostSocket, "desktop");
    service.connectPlayer(guest, guestSocket, "browser");
    service.setCaptureReady(roomCode, host.player.id, hostSocket, true);
    await send(service, host, hostSocket, {
      protocolVersion: PROTOCOL_VERSION,
      type: "game:start",
      commandId: "start-loss"
    });
    const options = latestMessage(hostSocket, "classic:word-options");
    await send(service, host, hostSocket, {
      protocolVersion: PROTOCOL_VERSION,
      type: "classic:word-select",
      modeSessionId: host.room.modeSessionId,
      actorStepId: options.actorStepId,
      optionId: options.options[0]!.id,
      commandId: "select-loss"
    });

    service.setCaptureReady(
      roomCode,
      host.player.id,
      hostSocket,
      false,
      "source-ended"
    );
    currentTime += 100;
    await vi.advanceTimersByTimeAsync(100);
    expect(classicState(host.room).phase).toBe("TURN_RESULT");
    expect(classicState(host.room).turnResult?.reason).toBe("CAPTURE_UNAVAILABLE");

    service.disconnectPlayer(roomCode, host.player.id, hostSocket);
    currentTime += 100;
    await vi.advanceTimersByTimeAsync(100);
    expect(host.room.hostId).toBe(guest.player.id);

    guestSocket.close();
    currentTime = host.room.lastActivityAt + 1_001;
    expect(service.cleanupInactive()).toEqual([roomCode]);
    expect(service.rooms.has(roomCode)).toBe(false);
  });

  it("queues only the newest accepted frame for a slow viewer", async () => {
    const hostJoin = await service.createRoom("画手", "secret", "desktop");
    const roomCode = hostJoin.snapshot.roomCode;
    const guestJoin = await service.joinRoom(roomCode, "慢连接", "secret");
    const host = service.resumeSession(hostJoin.sessionToken, "desktop");
    const guest = service.resumeSession(guestJoin.sessionToken, "browser");
    const hostSocket = new FakeSocket();
    const guestSocket = new FakeSocket();
    service.connectPlayer(host, hostSocket, "desktop");
    service.connectPlayer(guest, guestSocket, "browser");
    service.setCaptureReady(roomCode, host.player.id, hostSocket, true);
    await send(service, host, hostSocket, {
      protocolVersion: PROTOCOL_VERSION,
      type: "game:start",
      commandId: "start-backpressure"
    });
    const options = latestMessage(hostSocket, "classic:word-options");
    await send(service, host, hostSocket, {
      protocolVersion: PROTOCOL_VERSION,
      type: "classic:word-select",
      modeSessionId: host.room.modeSessionId,
      actorStepId: options.actorStepId,
      optionId: options.options[0]!.id,
      commandId: "select-backpressure"
    });
    const capture = latestMessage(hostSocket, "capture:start");
    const initialBinaryCount = guestSocket.sent.filter(
      (item) => typeof item !== "string"
    ).length;
    guestSocket.bufferedAmount = 3_000_000;
    expect(
      service.handleDesktopFrame(
        host,
        hostSocket,
        encodeUploadFrame(capture.captureSessionId, JPEG_A)
      )
    ).toEqual({ accepted: true, sequence: 1 });
    currentTime += 800;
    expect(
      service.handleDesktopFrame(
        host,
        hostSocket,
        encodeUploadFrame(capture.captureSessionId, JPEG_B)
      )
    ).toEqual({ accepted: true, sequence: 2 });
    expect(guestSocket.sent.filter((item) => typeof item !== "string")).toHaveLength(
      initialBinaryCount
    );

    guestSocket.bufferedAmount = 0;
    await vi.advanceTimersByTimeAsync(800);
    const binary = guestSocket.sent.filter(
      (item): item is Uint8Array => typeof item !== "string"
    );
    expect(binary).toHaveLength(initialBinaryCount + 1);
    const delivered = decodeViewerFrame(binary.at(-1)!);
    expect(delivered.sequence).toBe(2);
    expect([...delivered.imageBytes]).toEqual([...JPEG_B]);
  });

  it("atomically restarts a paused Classic game and invalidates every old command, grant, and timer", async () => {
    const hostJoin = await service.createRoom("房主", "secret", "desktop");
    const roomCode = hostJoin.snapshot.roomCode;
    const firstGuestJoin = await service.joinRoom(
      roomCode,
      "得分玩家",
      "secret",
      "browser"
    );
    const secondGuestJoin = await service.joinRoom(
      roomCode,
      "旁观玩家",
      "secret",
      "browser"
    );
    const host = service.resumeSession(hostJoin.sessionToken, "desktop");
    const firstGuest = service.resumeSession(firstGuestJoin.sessionToken, "browser");
    const secondGuest = service.resumeSession(secondGuestJoin.sessionToken, "browser");
    const hostSocket = new FakeSocket();
    const firstGuestSocket = new FakeSocket();
    const secondGuestSocket = new FakeSocket();
    service.connectPlayer(host, hostSocket, "desktop");
    service.connectPlayer(firstGuest, firstGuestSocket, "browser");
    service.connectPlayer(secondGuest, secondGuestSocket, "browser");
    await send(service, host, hostSocket, {
      protocolVersion: PROTOCOL_VERSION,
      type: "capture:ready",
      ready: true
    });
    await send(service, host, hostSocket, {
      protocolVersion: PROTOCOL_VERSION,
      type: "mode:settings",
      value: {
        mode: "classic",
        settings: { drawingSeconds: 15, selectionSeconds: 60, rounds: 2 }
      }
    });
    await send(service, host, hostSocket, {
      protocolVersion: PROTOCOL_VERSION,
      type: "game:start",
      commandId: "restart-flow-start"
    });
    const options = latestMessage(hostSocket, "classic:word-options");
    await send(service, host, hostSocket, {
      protocolVersion: PROTOCOL_VERSION,
      type: "classic:word-select",
      modeSessionId: host.room.modeSessionId,
      actorStepId: options.actorStepId,
      optionId: options.options[0]!.id,
      commandId: "restart-flow-select"
    });
    const selected = latestMessage(hostSocket, "classic:word-selected");
    await send(service, firstGuest, firstGuestSocket, {
      protocolVersion: PROTOCOL_VERSION,
      type: "chat:submit",
      text: selected.answer
    });
    await send(service, secondGuest, secondGuestSocket, {
      protocolVersion: PROTOCOL_VERSION,
      type: "chat:submit",
      text: "保留这条聊天"
    });
    const before = classicState(host.room);
    expect(before.phase).toBe("DRAWING");
    expect(before.scores.get(firstGuest.player.id)).toBeGreaterThan(0);
    const oldModeSessionId = host.room.modeSessionId;
    const oldActorStepId = before.actorStepId!;
    const oldCapture = latestMessage(
      hostSocket,
      "capture:start",
      (message) => message.stage === "drawing"
    );
    const playerIds = [...host.room.players.keys()];
    const retainedChatIds = host.room.chat.map((entry) => entry.id);
    const configuredWordPoolRevision = before.configuredWordPool.summary.revision;

    await expect(
      send(service, secondGuest, secondGuestSocket, {
        protocolVersion: PROTOCOL_VERSION,
        type: "game:restart",
        modeSessionId: oldModeSessionId,
        value: {
          mode: "classic",
          settings: { drawingSeconds: 90, selectionSeconds: 60, rounds: 3 }
        },
        commandId: "guest-restart-forgery"
      })
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      send(service, host, hostSocket, {
        protocolVersion: PROTOCOL_VERSION,
        type: "mode:settings",
        value: {
          mode: "classic",
          settings: { drawingSeconds: 90, selectionSeconds: 60, rounds: 3 }
        }
      })
    ).rejects.toMatchObject({ code: "INVALID_STATE" });
    await expect(
      send(service, host, hostSocket, {
        protocolVersion: PROTOCOL_VERSION,
        type: "game:restart",
        modeSessionId: oldModeSessionId,
        value: {
          mode: "reference-copy",
          settings: { durationSeconds: 60, votingSeconds: 30 }
        },
        commandId: "mismatched-restart-settings"
      })
    ).rejects.toMatchObject({ code: "INVALID_STATE" });
    await expect(
      send(service, host, hostSocket, {
        protocolVersion: PROTOCOL_VERSION,
        type: "game:restart",
        modeSessionId: "stale-mode-session",
        value: {
          mode: "classic",
          settings: { drawingSeconds: 90, selectionSeconds: 60, rounds: 3 }
        },
        commandId: "stale-restart"
      })
    ).rejects.toMatchObject({ code: "INVALID_STATE" });

    service.pauseFromEmbeddedHost("local-host-key", roomCode);
    expect(host.room.runControl.status).toBe("paused");
    const restart: ClientJsonMessage = {
      protocolVersion: PROTOCOL_VERSION,
      type: "game:restart",
      modeSessionId: oldModeSessionId,
      value: {
        mode: "classic",
        settings: { drawingSeconds: 90, selectionSeconds: 60, rounds: 3 }
      },
      commandId: "atomic-classic-restart"
    };
    await send(service, host, hostSocket, restart);

    const restarted = classicState(host.room);
    const restartedModeSessionId = host.room.modeSessionId;
    expect(restartedModeSessionId).not.toBe(oldModeSessionId);
    expect(host.room.runControl.status).toBe("running");
    expect(restarted.phase).toBe("WORD_SELECTION");
    expect(restarted.settings).toEqual({
      drawingSeconds: 90,
      selectionSeconds: 60,
      rounds: 3
    });
    expect(restarted.configuredWordPool.summary.revision).toBe(
      configuredWordPoolRevision
    );
    expect([...host.room.players.keys()]).toEqual(playerIds);
    expect(host.room.hostId).toBe(host.player.id);
    expect(
      retainedChatIds.every((id) => host.room.chat.some((entry) => entry.id === id))
    ).toBe(true);
    expect(host.room.chat.at(-1)?.text).toBe("房主应用了新设置，游戏已重新开始");
    expect([...restarted.scores.values()]).toEqual([0, 0, 0]);
    expect(restarted.currentRound).toBe(1);
    expect(restarted.currentTurnId).toBe(1);
    expect(restarted.actorStepId).not.toBe(oldActorStepId);
    expect(
      service.handleDesktopFrame(
        host,
        hostSocket,
        encodeUploadFrame(oldCapture.captureSessionId, JPEG_A)
      )
    ).toEqual({ accepted: false, reason: "UPLOAD_NOT_AUTHORIZED" });
    await expect(
      send(service, host, hostSocket, {
        protocolVersion: PROTOCOL_VERSION,
        type: "drawing:finish",
        modeSessionId: oldModeSessionId,
        actorStepId: oldActorStepId,
        commandId: "old-actor-after-restart"
      })
    ).rejects.toMatchObject({ code: "INVALID_STATE" });

    await send(service, host, hostSocket, restart);
    expect(host.room.modeSessionId).toBe(restartedModeSessionId);
    expect(classicState(host.room).actorStepId).toBe(restarted.actorStepId);

    currentTime += 16_000;
    await vi.advanceTimersByTimeAsync(16_000);
    expect(classicState(host.room).phase).toBe("WORD_SELECTION");
    expect(host.room.modeScheduler.size).toBe(1);
  });

  it("keeps applied restart settings in a safe lobby when the new game cannot start", async () => {
    const hostJoin = await service.createRoom("房主", "secret", "desktop");
    const roomCode = hostJoin.snapshot.roomCode;
    const guestJoin = await service.joinRoom(roomCode, "玩家", "secret", "browser");
    const host = service.resumeSession(hostJoin.sessionToken, "desktop");
    const guest = service.resumeSession(guestJoin.sessionToken, "browser");
    const hostSocket = new FakeSocket();
    service.connectPlayer(host, hostSocket, "desktop");
    service.connectPlayer(guest, new FakeSocket(), "browser");
    service.setCaptureReady(roomCode, host.player.id, hostSocket, true);
    await send(service, host, hostSocket, {
      protocolVersion: PROTOCOL_VERSION,
      type: "game:start",
      commandId: "failed-restart-start"
    });
    const options = latestMessage(hostSocket, "classic:word-options");
    await send(service, host, hostSocket, {
      protocolVersion: PROTOCOL_VERSION,
      type: "classic:word-select",
      modeSessionId: host.room.modeSessionId,
      actorStepId: options.actorStepId,
      optionId: options.options[0]!.id,
      commandId: "failed-restart-select"
    });
    const oldModeSessionId = host.room.modeSessionId;
    const oldCapture = latestMessage(hostSocket, "capture:start");
    service.setCaptureReady(
      roomCode,
      host.player.id,
      hostSocket,
      false,
      "source-ended"
    );

    await expect(
      send(service, host, hostSocket, {
        protocolVersion: PROTOCOL_VERSION,
        type: "game:restart",
        modeSessionId: oldModeSessionId,
        value: {
          mode: "classic",
          settings: { drawingSeconds: 120, selectionSeconds: 30, rounds: 4 }
        },
        commandId: "restart-without-capture"
      })
    ).rejects.toThrow("至少需要一名已确认采集来源的桌面玩家");

    const state = classicState(host.room);
    expect(host.room.modeSessionId).not.toBe(oldModeSessionId);
    expect(host.room.runControl).toEqual({ status: "idle" });
    expect(host.room.modeScheduler.size).toBe(0);
    expect(state.phase).toBe("LOBBY");
    expect(state.settings).toEqual({
      drawingSeconds: 120,
      selectionSeconds: 30,
      rounds: 4
    });
    expect(host.room.players.size).toBe(2);
    expect(
      service.handleDesktopFrame(
        host,
        hostSocket,
        encodeUploadFrame(oldCapture.captureSessionId, JPEG_A)
      )
    ).toEqual({ accepted: false, reason: "UPLOAD_NOT_AUTHORIZED" });
    expect(host.room.chat.at(-1)?.text).toContain("新游戏未能启动");
  });

  it("invalidates grants on mode switch and rejects non-host switching", async () => {
    const hostJoin = await service.createRoom("房主", "secret", "desktop");
    const roomCode = hostJoin.snapshot.roomCode;
    const guestJoin = await service.joinRoom(roomCode, "玩家", "secret");
    const host = service.resumeSession(hostJoin.sessionToken, "desktop");
    const guest = service.resumeSession(guestJoin.sessionToken, "browser");
    const hostSocket = new FakeSocket();
    const guestSocket = new FakeSocket();
    service.connectPlayer(host, hostSocket, "desktop");
    service.connectPlayer(guest, guestSocket, "browser");
    service.setCaptureReady(roomCode, host.player.id, hostSocket, true);
    await send(service, host, hostSocket, {
      protocolVersion: PROTOCOL_VERSION,
      type: "game:start",
      commandId: "start-switch"
    });
    const options = latestMessage(hostSocket, "classic:word-options");
    await send(service, host, hostSocket, {
      protocolVersion: PROTOCOL_VERSION,
      type: "classic:word-select",
      modeSessionId: host.room.modeSessionId,
      actorStepId: options.actorStepId,
      optionId: options.options[0]!.id,
      commandId: "select-switch"
    });
    const oldModeSessionId = host.room.modeSessionId;
    const oldCapture = latestMessage(hostSocket, "capture:start");
    await send(service, host, hostSocket, {
      protocolVersion: PROTOCOL_VERSION,
      type: "room:switch-mode",
      modeSessionId: oldModeSessionId,
      targetMode: "reference-copy",
      commandId: "switch-reference"
    });
    expect(host.room.modeSessionId).not.toBe(oldModeSessionId);
    expect(host.room.modeRuntime.mode).toBe("reference-copy");
    expect(host.room.runControl.status).toBe("idle");
    expect(
      service.handleDesktopFrame(
        host,
        hostSocket,
        encodeUploadFrame(oldCapture.captureSessionId, JPEG_A)
      )
    ).toEqual({ accepted: false, reason: "UPLOAD_NOT_AUTHORIZED" });

    await expect(
      send(service, guest, guestSocket, {
        protocolVersion: PROTOCOL_VERSION,
        type: "room:switch-mode",
        modeSessionId: host.room.modeSessionId,
        targetMode: "classic",
        commandId: "guest-switch-forgery"
      })
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});
