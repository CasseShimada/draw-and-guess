import {
  PROTOCOL_VERSION,
  encodeUploadFrame,
  type ClientJsonMessage,
  type ServerJsonMessage
} from "@draw-guess/protocol";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { GameService, type RoomAccess } from "./game-service.js";
import type { GameSocket, Room } from "./types.js";

const JPEG_A = Uint8Array.from([0xff, 0xd8, 0x11, 0xff, 0xd9]);
const JPEG_B = Uint8Array.from([0xff, 0xd8, 0x22, 0xff, 0xd9]);
const JPEG_C = Uint8Array.from([0xff, 0xd8, 0x33, 0xff, 0xd9]);

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

function referenceState(room: Room) {
  if (room.modeRuntime.mode !== "reference-copy") {
    throw new Error("expected reference-copy mode");
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

async function transparentReference(): Promise<Uint8Array> {
  return new Uint8Array(
    await sharp({
      create: {
        width: 12,
        height: 8,
        channels: 4,
        background: { r: 40, g: 90, b: 150, alpha: 0.4 }
      }
    })
      .png()
      .toBuffer()
  );
}

describe("reference-copy mode", () => {
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
      now: () => now,
      randomIndex: () => 0
    });
  });

  afterEach(async () => {
    await service.shutdown();
    vi.useRealTimers();
  });

  it("preloads, draws privately, finalizes independently, votes anonymously, and reveals ties", async () => {
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
    service.connectPlayer(host, hostSocket, "desktop");
    service.connectPlayer(second, secondSocket, "desktop");
    service.connectPlayer(third, thirdSocket, "desktop");
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
      type: "room:switch-mode",
      modeSessionId: host.room.modeSessionId,
      targetMode: "reference-copy",
      commandId: "reference-switch"
    });
    await send(service, host, hostSocket, {
      protocolVersion: PROTOCOL_VERSION,
      type: "mode:settings",
      value: {
        mode: "reference-copy",
        settings: { durationSeconds: 1, votingSeconds: 120 }
      }
    });
    const reference = await service.setReference(
      roomCode,
      host.player.id,
      await transparentReference(),
      "image/png"
    );
    const guestLobbyState = service.snapshot(host.room, second.player.id).game;
    expect(guestLobbyState).toMatchObject({
      mode: "reference-copy",
      phase: "LOBBY",
      reference: { isSet: true, revision: null }
    });
    expect(() =>
      service.referenceAsset(roomCode, second.player.id, reference.revision)
    ).toThrowError(expect.objectContaining({ code: "FORBIDDEN" }));

    await send(service, host, hostSocket, {
      protocolVersion: PROTOCOL_VERSION,
      type: "game:start",
      commandId: "reference-start"
    });
    const state = referenceState(host.room);
    expect(state.phase).toBe("PREPARING");
    expect(
      service.referenceAsset(roomCode, second.player.id, reference.revision).revision
    ).toBe(reference.revision);

    for (const [index, access, socket] of [
      [0, host, hostSocket],
      [1, second, secondSocket],
      [2, third, thirdSocket]
    ] as const) {
      await send(service, access, socket, {
        protocolVersion: PROTOCOL_VERSION,
        type: "reference:ready",
        modeSessionId: host.room.modeSessionId,
        referenceRevision: reference.revision,
        commandId: `reference-ready-${String(index)}`
      });
    }
    expect(state.phase).toBe("COUNTDOWN");
    expect(state.startsAt).toBe(now + 3_000);
    expect(state.endsAt).toBe(now + 4_000);
    now += 2_999;
    await vi.advanceTimersByTimeAsync(2_999);
    expect(state.phase).toBe("COUNTDOWN");
    now += 1;
    await vi.advanceTimersByTimeAsync(1);
    expect(state.phase).toBe("DRAWING");

    const hostCapture = latestMessage(
      hostSocket,
      "capture:start",
      (message) => message.stage === "drawing"
    );
    const secondCapture = latestMessage(
      secondSocket,
      "capture:start",
      (message) => message.stage === "drawing"
    );
    const thirdCapture = latestMessage(
      thirdSocket,
      "capture:start",
      (message) => message.stage === "drawing"
    );
    expect(
      new Set([
        hostCapture.captureSessionId,
        secondCapture.captureSessionId,
        thirdCapture.captureSessionId
      ]).size
    ).toBe(3);
    const secondBinaryBefore = secondSocket.sent.filter(
      (item) => typeof item !== "string"
    ).length;
    expect(
      service.handleDesktopFrame(
        host,
        hostSocket,
        encodeUploadFrame(hostCapture.captureSessionId, JPEG_A)
      )
    ).toEqual({ accepted: true, sequence: 1 });
    expect(secondSocket.sent.filter((item) => typeof item !== "string")).toHaveLength(
      secondBinaryBefore
    );
    expect(
      service.handleDesktopFrame(
        second,
        secondSocket,
        encodeUploadFrame(secondCapture.captureSessionId, JPEG_B)
      )
    ).toEqual({ accepted: true, sequence: 1 });
    expect(
      service.handleDesktopFrame(
        third,
        thirdSocket,
        encodeUploadFrame(thirdCapture.captureSessionId, JPEG_C)
      )
    ).toEqual({ accepted: true, sequence: 1 });
    const hostView = service.snapshot(host.room, host.player.id);
    const secondView = service.snapshot(host.room, second.player.id);
    if (
      hostView.game.mode !== "reference-copy" ||
      secondView.game.mode !== "reference-copy"
    ) {
      throw new Error("expected reference viewer snapshots");
    }
    expect(hostView.game.selfDrawing).toMatchObject({
      acceptedSequence: 1
    });
    expect(secondView.game.selfDrawing).toMatchObject({
      acceptedSequence: 1
    });
    if (
      hostView.game.selfDrawing?.status !== "drawing" ||
      secondView.game.selfDrawing?.status !== "drawing"
    ) {
      throw new Error("expected private drawing lifecycle");
    }
    expect(hostView.game.selfDrawing.acceptedRevision).not.toBe(
      secondView.game.selfDrawing.acceptedRevision
    );

    await send(service, host, hostSocket, {
      protocolVersion: PROTOCOL_VERSION,
      type: "drawing:finish",
      modeSessionId: host.room.modeSessionId,
      actorStepId: hostCapture.actorStepId,
      commandId: "host-finish-drawing"
    });
    const hostFinalCapture = latestMessage(
      hostSocket,
      "capture:start",
      (message) => message.stage === "finalizing"
    );
    expect(hostFinalCapture.captureSessionId).not.toBe(hostCapture.captureSessionId);
    expect(
      service.handleDesktopFrame(
        host,
        hostSocket,
        encodeUploadFrame(hostCapture.captureSessionId, JPEG_B)
      )
    ).toEqual({ accepted: false, reason: "UPLOAD_NOT_AUTHORIZED" });
    expect(
      service.handleDesktopFrame(
        host,
        hostSocket,
        encodeUploadFrame(hostFinalCapture.captureSessionId, JPEG_A)
      )
    ).toEqual({ accepted: true, sequence: 2 });
    await send(service, host, hostSocket, {
      protocolVersion: PROTOCOL_VERSION,
      type: "turn:pass",
      modeSessionId: host.room.modeSessionId,
      actorStepId: hostFinalCapture.actorStepId,
      targetPlayerId: host.player.id,
      commandId: "host-freeze-self"
    });

    await send(service, second, secondSocket, {
      protocolVersion: PROTOCOL_VERSION,
      type: "drawing:finish",
      modeSessionId: host.room.modeSessionId,
      actorStepId: secondCapture.actorStepId,
      commandId: "second-finish-drawing"
    });
    const secondFinalCapture = latestMessage(
      secondSocket,
      "capture:start",
      (message) => message.stage === "finalizing"
    );
    await send(service, host, hostSocket, {
      protocolVersion: PROTOCOL_VERSION,
      type: "turn:pass",
      modeSessionId: host.room.modeSessionId,
      actorStepId: secondFinalCapture.actorStepId,
      targetPlayerId: second.player.id,
      commandId: "host-freezes-second"
    });
    expect(state.phase).toBe("DRAWING");

    now += 1_000;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(state.phase).toBe("FINALIZING");
    expect(state.participants.get(third.player.id)?.drawing?.status).toBe("finalizing");
    now += 9_999;
    await vi.advanceTimersByTimeAsync(9_999);
    expect(state.phase).toBe("FINALIZING");
    now += 1;
    await vi.advanceTimersByTimeAsync(1);
    expect(state.phase).toBe("BLIND_VOTING");
    expect(state.submissions.size).toBe(3);

    const hostBallotView = service.snapshot(host.room, host.player.id);
    const secondBallotView = service.snapshot(host.room, second.player.id);
    if (
      hostBallotView.game.mode !== "reference-copy" ||
      secondBallotView.game.mode !== "reference-copy" ||
      !hostBallotView.game.selfBallot ||
      !secondBallotView.game.selfBallot
    ) {
      throw new Error("expected viewer-scoped ballots");
    }
    const hostBallot = hostBallotView.game.selfBallot;
    const secondBallot = secondBallotView.game.selfBallot;
    expect(hostBallot.items).toHaveLength(3);
    expect(secondBallot.items).toHaveLength(3);
    expect(hostBallotView.game.gallery).toBeNull();
    expect(JSON.stringify(hostBallot)).not.toContain("author");
    expect(() =>
      service.referenceBallotAsset(
        roomCode,
        second.player.id,
        hostBallot.ballotId,
        hostBallot.items[0]!.ballotItemId
      )
    ).toThrowError(expect.objectContaining({ code: "FORBIDDEN" }));
    expect(
      service.referenceBallotAsset(
        roomCode,
        host.player.id,
        hostBallot.ballotId,
        hostBallot.items[0]!.ballotItemId
      ).bytes.byteLength
    ).toBeGreaterThan(0);

    const voterCases = [
      [host, hostSocket],
      [second, secondSocket],
      [third, thirdSocket]
    ] as const;
    for (const [voterIndex, [access, socket]] of voterCases.entries()) {
      const snapshot = service.snapshot(host.room, access.player.id);
      if (snapshot.game.mode !== "reference-copy" || !snapshot.game.selfBallot) {
        throw new Error("missing ballot");
      }
      const ballot = snapshot.game.selfBallot;
      for (const [itemIndex, item] of ballot.items.entries()) {
        await send(service, access, socket, {
          protocolVersion: PROTOCOL_VERSION,
          type: "reference:set-like",
          modeSessionId: host.room.modeSessionId,
          ballotId: ballot.ballotId,
          ballotItemId: item.ballotItemId,
          liked: true,
          commandId: `like-${String(voterIndex)}-${String(itemIndex)}`
        });
      }
      if (voterIndex === 0) {
        await send(service, access, socket, {
          protocolVersion: PROTOCOL_VERSION,
          type: "reference:set-like",
          modeSessionId: host.room.modeSessionId,
          ballotId: ballot.ballotId,
          ballotItemId: ballot.items[0]!.ballotItemId,
          liked: true,
          commandId: "idempotent-set-like"
        });
        expect(
          referenceState(host.room).ballots.get(access.player.id)?.likedSubmissionIds
            .size
        ).toBe(3);
      }
      if (voterIndex === 1) {
        await send(service, access, socket, {
          protocolVersion: PROTOCOL_VERSION,
          type: "turn:pass",
          modeSessionId: host.room.modeSessionId,
          actorStepId: ballot.actorStepId,
          targetPlayerId: access.player.id,
          commandId: "second-passes-ballot"
        });
      } else {
        await send(service, access, socket, {
          protocolVersion: PROTOCOL_VERSION,
          type: "reference:finish-ballot",
          modeSessionId: host.room.modeSessionId,
          ballotId: ballot.ballotId,
          commandId: `finish-ballot-${String(voterIndex)}`
        });
      }
    }

    expect(state.phase).toBe("GALLERY");
    const gallerySnapshot = service.snapshot(host.room, host.player.id);
    if (
      gallerySnapshot.game.mode !== "reference-copy" ||
      !gallerySnapshot.game.gallery
    ) {
      throw new Error("expected gallery");
    }
    expect(gallerySnapshot.game.gallery.entries).toHaveLength(3);
    expect(
      gallerySnapshot.game.gallery.entries.every(
        (entry) => entry.likes === 3 && entry.winner
      )
    ).toBe(true);
    expect(
      new Set(gallerySnapshot.game.gallery.entries.map((entry) => entry.authorId))
    ).toEqual(new Set([host.player.id, second.player.id, third.player.id]));
    const firstResult = gallerySnapshot.game.gallery.entries[0]!;
    expect(
      service.referenceGalleryAsset(
        roomCode,
        host.player.id,
        gallerySnapshot.game.gallery.resultId,
        firstResult.resultItemId
      ).bytes.byteLength
    ).toBeGreaterThan(0);

    await send(service, host, hostSocket, {
      protocolVersion: PROTOCOL_VERSION,
      type: "game:return-lobby",
      commandId: "reference-return"
    });
    expect(state.phase).toBe("LOBBY");
    expect(state.submissions.size).toBe(0);
    expect(state.ballots.size).toBe(0);
    expect(state.frameStore.size).toBe(0);
    expect(state.reference?.revision).toBe(reference.revision);

    await send(service, host, hostSocket, {
      protocolVersion: PROTOCOL_VERSION,
      type: "room:switch-mode",
      modeSessionId: host.room.modeSessionId,
      targetMode: "classic",
      commandId: "leave-reference"
    });
    await send(service, host, hostSocket, {
      protocolVersion: PROTOCOL_VERSION,
      type: "room:switch-mode",
      modeSessionId: host.room.modeSessionId,
      targetMode: "reference-copy",
      commandId: "return-reference"
    });
    expect(referenceState(host.room).reference).toBeNull();
  });

  it("aborts preparation after twenty seconds without consuming the reference", async () => {
    const hostJoin = await service.createRoom("甲", "secret", "desktop");
    const roomCode = hostJoin.snapshot.roomCode;
    const guestJoin = await service.joinRoom(roomCode, "乙", "secret", "desktop");
    const host = service.resumeSession(hostJoin.sessionToken, "desktop");
    const guest = service.resumeSession(guestJoin.sessionToken, "desktop");
    const hostSocket = new FakeSocket();
    const guestSocket = new FakeSocket();
    service.connectPlayer(host, hostSocket, "desktop");
    service.connectPlayer(guest, guestSocket, "desktop");
    service.setCaptureReady(roomCode, host.player.id, hostSocket, true);
    service.setCaptureReady(roomCode, guest.player.id, guestSocket, true);
    await send(service, host, hostSocket, {
      protocolVersion: PROTOCOL_VERSION,
      type: "room:switch-mode",
      modeSessionId: host.room.modeSessionId,
      targetMode: "reference-copy",
      commandId: "switch-timeout"
    });
    const reference = await service.setReference(
      roomCode,
      host.player.id,
      await transparentReference(),
      "image/png"
    );
    await send(service, host, hostSocket, {
      protocolVersion: PROTOCOL_VERSION,
      type: "game:start",
      commandId: "start-timeout"
    });
    await send(service, host, hostSocket, {
      protocolVersion: PROTOCOL_VERSION,
      type: "reference:ready",
      modeSessionId: host.room.modeSessionId,
      referenceRevision: reference.revision,
      commandId: "only-host-ready"
    });
    now += 19_999;
    await vi.advanceTimersByTimeAsync(19_999);
    expect(referenceState(host.room).phase).toBe("PREPARING");
    now += 1;
    await vi.advanceTimersByTimeAsync(1);
    const state = referenceState(host.room);
    expect(state.phase).toBe("LOBBY");
    expect(state.participants.size).toBe(0);
    expect(state.reference?.revision).toBe(reference.revision);
    expect(host.room.runControl.status).toBe("idle");
    expect(host.room.chat.at(-1)?.text).toContain("乙");
  });

  it("rate-limits reference normalization per host and room", async () => {
    const hostJoin = await service.createRoom("甲", "secret", "desktop");
    const host = service.resumeSession(hostJoin.sessionToken, "desktop");
    const hostSocket = new FakeSocket();
    service.connectPlayer(host, hostSocket, "desktop");
    await send(service, host, hostSocket, {
      protocolVersion: PROTOCOL_VERSION,
      type: "room:switch-mode",
      modeSessionId: host.room.modeSessionId,
      targetMode: "reference-copy",
      commandId: "switch-rate-limit"
    });
    const bytes = await transparentReference();
    for (let attempt = 0; attempt < 10; attempt += 1) {
      await expect(
        service.setReference(host.room.roomCode, host.player.id, bytes, "image/png")
      ).resolves.toMatchObject({ mimeType: "image/png" });
    }
    await expect(
      service.setReference(host.room.roomCode, host.player.id, bytes, "image/png")
    ).rejects.toMatchObject({ code: "RATE_LIMITED", statusCode: 429 });

    now += 60_000;
    await expect(
      service.setReference(host.room.roomCode, host.player.id, bytes, "image/png")
    ).resolves.toMatchObject({ mimeType: "image/png" });
  });
});
