import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  PROTOCOL_VERSION,
  encodeUploadFrame,
  type ClientJsonMessage,
  type ServerJsonMessage
} from "@draw-guess/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { GameService, type RoomAccess } from "./game-service.js";
import {
  FfmpegCapabilityService,
  type ProcessRunResult,
  type ProcessRunner,
  type ReplayHostConfig
} from "./services/ffmpeg-capability-service.js";
import { ReplayService } from "./services/replay-service.js";
import type { GameSocket, Room } from "./types.js";

const JPEG_A = Uint8Array.from([0xff, 0xd8, 0x11, 0xff, 0xd9]);
const JPEG_B = Uint8Array.from([0xff, 0xd8, 0x22, 0xff, 0xd9]);
const JPEG_C = Uint8Array.from([0xff, 0xd8, 0x33, 0xff, 0xd9]);
const temporaryDirectories: string[] = [];

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

class RelayProcessRunner implements ProcessRunner {
  readonly calls: Array<{ executable: string; args: readonly string[] }> = [];

  async run(executable: string, args: readonly string[]): Promise<ProcessRunResult> {
    this.calls.push({ executable, args: [...args] });
    if (args.includes("-version")) {
      return {
        exitCode: 0,
        stdout: "ffmpeg version relay-fake-1",
        stderr: "",
        timedOut: false
      };
    }
    if (args.includes("-encoders")) {
      return {
        exitCode: 0,
        stdout: " V..... libx264 H.264",
        stderr: "",
        timedOut: false
      };
    }
    const output = args.at(-1);
    if (!output) {
      throw new Error("fake encoder output missing");
    }
    await writeFile(output, Buffer.from("relay-fake-mp4"));
    return { exitCode: 0, stdout: "", stderr: "", timedOut: false };
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

function relayState(room: Room) {
  if (room.modeRuntime.mode !== "draw-relay") {
    throw new Error("expected draw-relay mode");
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

async function replayFixture(): Promise<{
  config: ReplayHostConfig;
  runner: RelayProcessRunner;
  replay: ReplayService;
}> {
  const root = await mkdtemp(path.join(tmpdir(), "draw-relay-mode-"));
  temporaryDirectories.push(root);
  const config: ReplayHostConfig = {
    configuredExecutable: path.join(root, "ffmpeg fake.exe"),
    outputDirectory: path.join(root, "output"),
    temporaryDirectory: path.join(root, "temporary"),
    minimumFreeBytes: 0,
    maxJobBytes: 64 * 1024 * 1024,
    maxTotalTemporaryBytes: 128 * 1024 * 1024
  };
  const runner = new RelayProcessRunner();
  const replay = new ReplayService(config, new FfmpegCapabilityService(config, runner));
  return { config, runner, replay };
}

describe("draw-relay mode", () => {
  let now = 1_000;
  let service: GameService | null = null;

  beforeEach(() => {
    vi.useFakeTimers();
    now = 1_000;
  });

  afterEach(async () => {
    await service?.shutdown();
    service = null;
    vi.useRealTimers();
    await Promise.all(
      temporaryDirectories
        .splice(0)
        .map((directory) => rm(directory, { recursive: true, force: true }))
    );
  });

  it("keeps each task private, preserves immutable input on Pass, and saves a host-only replay", async () => {
    const fixture = await replayFixture();
    service = new GameService({
      roomIdleTtlMs: 60_000,
      reconnectGraceMs: 100,
      desktopSessionTtlMs: 60_000,
      turnResultMs: 100,
      now: () => now,
      randomIndex: () => 0,
      replayService: fixture.replay
    });
    await service.initialize();
    const hostJoin = await service.createRoom("甲", "secret", "desktop");
    const roomCode = hostJoin.snapshot.roomCode;
    const secondJoin = await service.joinRoom(roomCode, "乙", "secret", "desktop");
    const thirdJoin = await service.joinRoom(roomCode, "丙", "secret", "desktop");
    const host = service.resumeSession(hostJoin.sessionToken, "desktop");
    const second = service.resumeSession(secondJoin.sessionToken, "desktop");
    const third = service.resumeSession(thirdJoin.sessionToken, "desktop");
    const hostSocket = new FakeSocket();
    const secondSocket = new FakeSocket();
    const thirdSocket = new FakeSocket();
    const players = [
      { access: host, socket: hostSocket },
      { access: second, socket: secondSocket },
      { access: third, socket: thirdSocket }
    ];
    const byId = new Map(players.map((player) => [player.access.player.id, player]));
    for (const player of players) {
      service.connectPlayer(player.access, player.socket, "desktop");
      await send(service, player.access, player.socket, {
        protocolVersion: PROTOCOL_VERSION,
        type: "capture:ready",
        ready: true
      });
    }

    await send(service, host, hostSocket, {
      protocolVersion: PROTOCOL_VERSION,
      type: "room:switch-mode",
      modeSessionId: host.room.modeSessionId,
      targetMode: "draw-relay",
      commandId: "relay-switch"
    });
    for (const [index, player] of players.entries()) {
      await send(service, player.access, player.socket, {
        protocolVersion: PROTOCOL_VERSION,
        type: "relay:recording-consent",
        modeSessionId: host.room.modeSessionId,
        confirmed: true,
        commandId: `relay-consent-${String(index)}`
      });
    }
    await send(service, host, hostSocket, {
      protocolVersion: PROTOCOL_VERSION,
      type: "mode:settings",
      value: {
        mode: "draw-relay",
        settings: { drawingSeconds: 1, guessingSeconds: 1 }
      }
    });
    await send(service, host, hostSocket, {
      protocolVersion: PROTOCOL_VERSION,
      type: "game:start",
      commandId: "relay-start"
    });

    const state = relayState(host.room);
    expect(state.phase).toBe("PREPARING");
    expect(state.participantOrder).toHaveLength(3);
    expect(state.history).toHaveLength(0);
    const firstPlayer = byId.get(state.activeStep!.playerId)!;
    const firstTask = service.relayPrivateTask(roomCode, firstPlayer.access.player.id);
    expect(firstTask).toMatchObject({ kind: "word" });
    if (firstTask.kind !== "word") {
      throw new Error("expected starting-word task");
    }
    for (const player of players.filter((candidate) => candidate !== firstPlayer)) {
      expect(() =>
        service!.relayPrivateTask(roomCode, player.access.player.id)
      ).toThrowError(expect.objectContaining({ code: "FORBIDDEN" }));
      expect(
        JSON.stringify(service.snapshot(host.room, player.access.player.id))
      ).not.toContain(firstTask.word);
    }

    await send(service, firstPlayer.access, firstPlayer.socket, {
      protocolVersion: PROTOCOL_VERSION,
      type: "relay:task-ready",
      modeSessionId: host.room.modeSessionId,
      actorStepId: firstTask.actorStepId,
      revision: null,
      commandId: "first-task-ready"
    });
    expect(state.phase).toBe("COUNTDOWN");
    now += 3_000;
    await vi.advanceTimersByTimeAsync(3_000);
    expect(state.phase).toBe("DRAWING");
    const firstCapture = latestMessage(
      firstPlayer.socket,
      "capture:start",
      (message) => message.stage === "drawing"
    );
    const otherBinaryCounts = new Map(
      players
        .filter((candidate) => candidate !== firstPlayer)
        .map((candidate) => [
          candidate.access.player.id,
          candidate.socket.sent.filter((item) => typeof item !== "string").length
        ])
    );
    expect(
      service.handleDesktopFrame(
        firstPlayer.access,
        firstPlayer.socket,
        encodeUploadFrame(firstCapture.captureSessionId, JPEG_A)
      )
    ).toEqual({ accepted: true, sequence: 1 });
    for (const player of players.filter((candidate) => candidate !== firstPlayer)) {
      expect(
        player.socket.sent.filter((item) => typeof item !== "string")
      ).toHaveLength(otherBinaryCounts.get(player.access.player.id)!);
    }

    await send(service, firstPlayer.access, firstPlayer.socket, {
      protocolVersion: PROTOCOL_VERSION,
      type: "drawing:finish",
      modeSessionId: host.room.modeSessionId,
      actorStepId: firstTask.actorStepId,
      commandId: "first-finish"
    });
    expect(state.phase).toBe("FINALIZING");
    const firstFinalCapture = latestMessage(
      firstPlayer.socket,
      "capture:start",
      (message) => message.stage === "finalizing"
    );
    expect(
      service.handleDesktopFrame(
        firstPlayer.access,
        firstPlayer.socket,
        encodeUploadFrame(firstFinalCapture.captureSessionId, JPEG_B)
      )
    ).toEqual({ accepted: true, sequence: 2 });
    await send(service, firstPlayer.access, firstPlayer.socket, {
      protocolVersion: PROTOCOL_VERSION,
      type: "turn:pass",
      modeSessionId: host.room.modeSessionId,
      actorStepId: firstTask.actorStepId,
      targetPlayerId: firstPlayer.access.player.id,
      commandId: "first-finalization-pass"
    });

    expect(state.phase).toBe("GUESSING");
    const guessingPlayer = byId.get(state.activeStep!.playerId)!;
    const drawingTask = service.relayPrivateTask(
      roomCode,
      guessingPlayer.access.player.id
    );
    if (drawingTask.kind !== "drawing" || !drawingTask.revision) {
      throw new Error("expected frozen drawing task");
    }
    expect(
      service.relayActiveArtifact(
        roomCode,
        guessingPlayer.access.player.id,
        drawingTask.artifactId,
        drawingTask.revision
      ).revision
    ).toBe(drawingTask.revision);
    const unauthorized = players.find((candidate) => candidate !== guessingPlayer)!;
    expect(() =>
      service!.relayActiveArtifact(
        roomCode,
        unauthorized.access.player.id,
        drawingTask.artifactId,
        drawingTask.revision!
      )
    ).toThrowError(expect.objectContaining({ code: "NOT_FOUND" }));

    await send(service, guessingPlayer.access, guessingPlayer.socket, {
      protocolVersion: PROTOCOL_VERSION,
      type: "relay:task-ready",
      modeSessionId: host.room.modeSessionId,
      actorStepId: drawingTask.actorStepId,
      revision: drawingTask.revision,
      commandId: "guess-task-ready"
    });
    const privateGuess = "蓝猫; $(calc) <b>";
    await send(service, guessingPlayer.access, guessingPlayer.socket, {
      protocolVersion: PROTOCOL_VERSION,
      type: "relay:submit-guess",
      modeSessionId: host.room.modeSessionId,
      actorStepId: drawingTask.actorStepId,
      guess: privateGuess,
      commandId: "middle-private-guess"
    });
    expect(state.phase).toBe("PREPARING");
    const privateDrawingPrompt = service.relayPrivateTask(
      roomCode,
      guessingPlayer.access.player.id
    );
    expect(privateDrawingPrompt).toMatchObject({
      kind: "word",
      word: privateGuess
    });
    for (const player of players.filter((candidate) => candidate !== guessingPlayer)) {
      expect(
        JSON.stringify(service.snapshot(host.room, player.access.player.id))
      ).not.toContain(privateGuess);
    }

    await send(service, guessingPlayer.access, guessingPlayer.socket, {
      protocolVersion: PROTOCOL_VERSION,
      type: "relay:task-ready",
      modeSessionId: host.room.modeSessionId,
      actorStepId: privateDrawingPrompt.actorStepId,
      revision: null,
      commandId: "middle-draw-ready"
    });
    now += 3_000;
    await vi.advanceTimersByTimeAsync(3_000);
    expect(state.phase).toBe("DRAWING");
    const middleCapture = latestMessage(
      guessingPlayer.socket,
      "capture:start",
      (message) =>
        message.stage === "drawing" &&
        message.actorStepId === privateDrawingPrompt.actorStepId
    );
    expect(
      service.handleDesktopFrame(
        guessingPlayer.access,
        guessingPlayer.socket,
        encodeUploadFrame(middleCapture.captureSessionId, JPEG_C)
      )
    ).toEqual({ accepted: true, sequence: 1 });
    await send(service, guessingPlayer.access, guessingPlayer.socket, {
      protocolVersion: PROTOCOL_VERSION,
      type: "turn:pass",
      modeSessionId: host.room.modeSessionId,
      actorStepId: privateDrawingPrompt.actorStepId,
      targetPlayerId: guessingPlayer.access.player.id,
      commandId: "middle-drawing-pass"
    });
    expect(
      service.handleDesktopFrame(
        guessingPlayer.access,
        guessingPlayer.socket,
        encodeUploadFrame(middleCapture.captureSessionId, JPEG_C)
      )
    ).toEqual({ accepted: false, reason: "UPLOAD_NOT_AUTHORIZED" });

    const finalPlayer = byId.get(state.activeStep!.playerId)!;
    const finalTask = service.relayPrivateTask(roomCode, finalPlayer.access.player.id);
    if (finalTask.kind !== "drawing") {
      throw new Error("expected final drawing input");
    }
    expect(finalTask.artifactId).toBe(drawingTask.artifactId);
    expect(finalTask.revision).toBe(drawingTask.revision);
    await send(service, finalPlayer.access, finalPlayer.socket, {
      protocolVersion: PROTOCOL_VERSION,
      type: "relay:task-ready",
      modeSessionId: host.room.modeSessionId,
      actorStepId: finalTask.actorStepId,
      revision: finalTask.revision,
      commandId: "final-task-ready"
    });
    await send(service, finalPlayer.access, finalPlayer.socket, {
      protocolVersion: PROTOCOL_VERSION,
      type: "relay:submit-guess",
      modeSessionId: host.room.modeSessionId,
      actorStepId: finalTask.actorStepId,
      guess: "终点答案",
      commandId: "final-guess"
    });

    expect(state.phase).toBe("RESULT");
    expect(state.history.map((entry) => entry.kind)).toEqual([
      "draw",
      "guess",
      "draw",
      "guess"
    ]);
    expect(state.history[2]).toMatchObject({
      kind: "draw",
      status: "passed",
      artifact: null
    });
    const resultSnapshot = service.snapshot(host.room, host.player.id);
    if (resultSnapshot.game.mode !== "draw-relay" || !resultSnapshot.game.result) {
      throw new Error("expected relay result");
    }
    expect(resultSnapshot.game).toMatchObject({
      totalSteps: 4,
      result: {
        startingWord: firstTask.word,
        finalGuess: "终点答案",
        finalGuessReason: "completed"
      }
    });
    expect(JSON.stringify(resultSnapshot.game.result)).toContain(privateGuess);
    expect(host.room.runControl.status).toBe("idle");

    const replayJobId = state.replayJobId;
    expect(replayJobId).not.toBeNull();
    await vi.waitFor(
      () => {
        expect(fixture.replay.status(replayJobId).status).toBe("saved");
      },
      { timeout: 10_000, interval: 20 }
    );
    const saved = fixture.replay.savedFile(replayJobId!);
    expect(saved).not.toBeNull();
    expect((await stat(saved!.path)).size).toBeGreaterThan(0);
    expect(JSON.stringify(resultSnapshot)).not.toContain(saved!.path);
    const encodeCall = fixture.runner.calls.find(
      (call) => !call.args.includes("-version") && !call.args.includes("-encoders")
    );
    expect(encodeCall?.args.join("\n")).not.toContain(privateGuess);
  }, 20_000);

  it("keeps classic available when the actual host has no FFmpeg capability", async () => {
    service = new GameService({
      roomIdleTtlMs: 60_000,
      reconnectGraceMs: 100,
      desktopSessionTtlMs: 60_000,
      turnResultMs: 100,
      now: () => now
    });
    const hostJoin = await service.createRoom("房主", "secret", "desktop");
    const host = service.resumeSession(hostJoin.sessionToken, "desktop");
    const hostSocket = new FakeSocket();
    service.connectPlayer(host, hostSocket, "desktop");
    const modeSessionId = host.room.modeSessionId;
    await expect(
      send(service, host, hostSocket, {
        protocolVersion: PROTOCOL_VERSION,
        type: "room:switch-mode",
        modeSessionId,
        targetMode: "draw-relay",
        commandId: "relay-unavailable"
      })
    ).rejects.toMatchObject({ code: "CAPABILITY_UNAVAILABLE" });
    expect(host.room.modeRuntime.mode).toBe("classic");
    expect(host.room.modeSessionId).toBe(modeSessionId);
  });
});
