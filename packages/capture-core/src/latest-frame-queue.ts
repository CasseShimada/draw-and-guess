export class LatestFrameQueue<Value> {
  readonly #sink: (value: Value) => Promise<void>;
  #pending: Value | null = null;
  #running = false;
  #closed = false;
  #idleWaiters = new Set<() => void>();

  constructor(sink: (value: Value) => Promise<void> | void) {
    this.#sink = async (value) => {
      await sink(value);
    };
  }

  get running(): boolean {
    return this.#running;
  }

  get hasPending(): boolean {
    return this.#pending !== null;
  }

  enqueue(value: Value): boolean {
    if (this.#closed) {
      return false;
    }
    this.#pending = value;
    void this.#drain();
    return true;
  }

  clear(): void {
    this.#pending = null;
    this.#resolveIdleIfNeeded();
  }

  close(): void {
    this.#closed = true;
    this.clear();
  }

  async whenIdle(): Promise<void> {
    if (!this.#running && this.#pending === null) {
      return;
    }
    await new Promise<void>((resolve) => {
      this.#idleWaiters.add(resolve);
    });
  }

  async #drain(): Promise<void> {
    if (this.#running || this.#closed) {
      return;
    }
    this.#running = true;
    try {
      while (!this.#closed && this.#pending !== null) {
        const next = this.#pending;
        this.#pending = null;
        await this.#sink(next);
      }
    } finally {
      this.#running = false;
      this.#resolveIdleIfNeeded();
      if (!this.#closed && this.#pending !== null) {
        void this.#drain();
      }
    }
  }

  #resolveIdleIfNeeded(): void {
    if (this.#running || this.#pending !== null) {
      return;
    }
    for (const resolve of this.#idleWaiters) {
      resolve();
    }
    this.#idleWaiters.clear();
  }
}
