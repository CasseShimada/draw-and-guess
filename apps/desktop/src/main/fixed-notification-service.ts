import type { ServerJsonMessage } from "@draw-guess/protocol";

export const FINALIZATION_NOTIFICATION = {
  title: "画猜现场",
  body: "绘画进入 10 秒展示收尾，请保持最终画面稳定。"
} as const;

export interface NativeNotificationHandle {
  close(): void;
}

export interface FixedNotificationAdapter {
  enabled(): boolean;
  supported(): boolean;
  focused(): boolean;
  focusWindow(): void;
  show(input: {
    title: string;
    body: string;
    onClick: () => void;
    onClose: () => void;
  }): NativeNotificationHandle;
}

const MAX_SEEN_EVENT_KEYS = 2_048;

export class FixedNotificationService {
  readonly #adapter: FixedNotificationAdapter;
  readonly #seen = new Set<string>();
  readonly #active = new Set<NativeNotificationHandle>();
  #modeSessionId: string | null = null;

  constructor(adapter: FixedNotificationAdapter) {
    this.#adapter = adapter;
  }

  get supported(): boolean {
    return this.#adapter.supported();
  }

  observeModeSession(modeSessionId: string): void {
    if (this.#modeSessionId === modeSessionId) {
      return;
    }
    this.#modeSessionId = modeSessionId;
    this.#seen.clear();
    this.#closeActive();
  }

  handle(message: ServerJsonMessage): void {
    if (message.type === "room:snapshot") {
      this.observeModeSession(message.snapshot.modeSessionId);
      return;
    }
    if (message.type !== "drawing:finalization-started") {
      return;
    }
    if (this.#modeSessionId !== null && message.modeSessionId !== this.#modeSessionId) {
      return;
    }
    const eventKey = `${message.modeSessionId}:${message.actorStepId}:${message.eventId}`;
    if (this.#seen.has(eventKey)) {
      return;
    }
    this.#seen.add(eventKey);
    while (this.#seen.size > MAX_SEEN_EVENT_KEYS) {
      const oldest = this.#seen.values().next().value;
      if (!oldest) {
        break;
      }
      this.#seen.delete(oldest);
    }
    if (
      !this.#adapter.enabled() ||
      !this.#adapter.supported() ||
      this.#adapter.focused()
    ) {
      return;
    }

    let handle: NativeNotificationHandle | null = null;
    handle = this.#adapter.show({
      ...FINALIZATION_NOTIFICATION,
      onClick: () => this.#adapter.focusWindow(),
      onClose: () => {
        if (handle) {
          this.#active.delete(handle);
        }
      }
    });
    this.#active.add(handle);
  }

  dispose(): void {
    this.#seen.clear();
    this.#modeSessionId = null;
    this.#closeActive();
  }

  #closeActive(): void {
    for (const notification of this.#active) {
      notification.close();
    }
    this.#active.clear();
  }
}
