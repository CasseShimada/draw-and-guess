import { PROTOCOL_VERSION, type ServerJsonMessage } from "@draw-guess/protocol";
import { describe, expect, it } from "vitest";

import {
  FINALIZATION_NOTIFICATION,
  FixedNotificationService,
  type FixedNotificationAdapter,
  type NativeNotificationHandle
} from "./fixed-notification-service.js";

class FakeAdapter implements FixedNotificationAdapter {
  enabledValue = true;
  supportedValue = true;
  focusedValue = false;
  focusCount = 0;
  closeCount = 0;
  readonly shown: Array<{
    title: string;
    body: string;
    onClick: () => void;
    onClose: () => void;
  }> = [];

  enabled(): boolean {
    return this.enabledValue;
  }

  supported(): boolean {
    return this.supportedValue;
  }

  focused(): boolean {
    return this.focusedValue;
  }

  focusWindow(): void {
    this.focusCount += 1;
  }

  show(input: {
    title: string;
    body: string;
    onClick: () => void;
    onClose: () => void;
  }): NativeNotificationHandle {
    this.shown.push(input);
    return {
      close: () => {
        this.closeCount += 1;
        input.onClose();
      }
    };
  }
}

function finalization(
  modeSessionId = "mode-session-a",
  eventId = "event-a"
): ServerJsonMessage {
  return {
    protocolVersion: PROTOCOL_VERSION,
    type: "drawing:finalization-started",
    modeSessionId,
    actorStepId: "actor-step-a",
    eventId,
    endsAt: 11_000
  };
}

describe("fixed desktop notifications", () => {
  it("shows only fixed content once and focuses the game on click", () => {
    const adapter = new FakeAdapter();
    const service = new FixedNotificationService(adapter);
    service.observeModeSession("mode-session-a");
    service.handle(finalization());
    service.handle(finalization());

    expect(adapter.shown).toHaveLength(1);
    expect(adapter.shown[0]).toMatchObject(FINALIZATION_NOTIFICATION);
    adapter.shown[0]?.onClick();
    expect(adapter.focusCount).toBe(1);
  });

  it("requires opt-in, platform support, and a background window", () => {
    for (const change of [
      (adapter: FakeAdapter) => {
        adapter.enabledValue = false;
      },
      (adapter: FakeAdapter) => {
        adapter.supportedValue = false;
      },
      (adapter: FakeAdapter) => {
        adapter.focusedValue = true;
      }
    ]) {
      const adapter = new FakeAdapter();
      change(adapter);
      const service = new FixedNotificationService(adapter);
      service.handle(finalization());
      expect(adapter.shown).toHaveLength(0);
    }
  });

  it("rejects stale sessions and closes active notifications on mode change", () => {
    const adapter = new FakeAdapter();
    const service = new FixedNotificationService(adapter);
    service.observeModeSession("mode-session-a");
    service.handle(finalization());
    service.observeModeSession("mode-session-b");
    service.handle(finalization("mode-session-a", "late-event"));
    service.handle(finalization("mode-session-b", "event-b"));

    expect(adapter.closeCount).toBe(1);
    expect(adapter.shown).toHaveLength(2);
    service.dispose();
    expect(adapter.closeCount).toBe(2);
  });
});
