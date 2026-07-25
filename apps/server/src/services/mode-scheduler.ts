export interface ScheduledTimer {
  key: string;
  deadline: number;
  remainingMs: number;
}

interface TimerEntry {
  key: string;
  deadline: number;
  callback: () => void;
  timer: NodeJS.Timeout | null;
  remainingMs: number | null;
}

export interface ModeSchedulerOptions {
  now?: () => number;
  setTimer?: (callback: () => void, delayMs: number) => NodeJS.Timeout;
  clearTimer?: (timer: NodeJS.Timeout) => void;
}

export class ModeScheduler {
  readonly #entries = new Map<string, TimerEntry>();
  readonly #now: () => number;
  readonly #setTimer: (callback: () => void, delayMs: number) => NodeJS.Timeout;
  readonly #clearTimer: (timer: NodeJS.Timeout) => void;
  #paused = false;
  #pausedAt: number | null = null;

  constructor(options: ModeSchedulerOptions = {}) {
    this.#now = options.now ?? Date.now;
    this.#setTimer =
      options.setTimer ??
      ((callback, delayMs) => {
        const timer = setTimeout(callback, Math.max(0, delayMs));
        timer.unref();
        return timer;
      });
    this.#clearTimer = options.clearTimer ?? clearTimeout;
  }

  get paused(): boolean {
    return this.#paused;
  }

  get size(): number {
    return this.#entries.size;
  }

  has(key: string): boolean {
    return this.#entries.has(key);
  }

  scheduleAt(key: string, deadline: number, callback: () => void): void {
    if (!key || !Number.isFinite(deadline)) {
      throw new TypeError("timer key 与 deadline 必须有效");
    }
    this.cancel(key);
    const entry: TimerEntry = {
      key,
      deadline,
      callback,
      timer: null,
      remainingMs: this.#paused
        ? Math.max(0, deadline - (this.#pausedAt ?? this.#now()))
        : null
    };
    this.#entries.set(key, entry);
    if (!this.#paused) {
      this.#arm(entry, Math.max(0, deadline - this.#now()));
    }
  }

  scheduleAfter(key: string, delayMs: number, callback: () => void): void {
    this.scheduleAt(key, this.#now() + Math.max(0, delayMs), callback);
  }

  cancel(key: string): void {
    const entry = this.#entries.get(key);
    if (!entry) {
      return;
    }
    if (entry.timer) {
      this.#clearTimer(entry.timer);
    }
    this.#entries.delete(key);
  }

  cancelAll(): void {
    for (const entry of this.#entries.values()) {
      if (entry.timer) {
        this.#clearTimer(entry.timer);
      }
    }
    this.#entries.clear();
    this.#paused = false;
    this.#pausedAt = null;
  }

  pauseAll(at = this.#now()): ScheduledTimer[] {
    if (this.#paused) {
      return this.snapshot(at);
    }
    this.#paused = true;
    this.#pausedAt = at;
    for (const entry of this.#entries.values()) {
      if (entry.timer) {
        this.#clearTimer(entry.timer);
        entry.timer = null;
      }
      entry.remainingMs = Math.max(0, entry.deadline - at);
    }
    return this.snapshot(at);
  }

  resumeAll(from = this.#now(), startDelayMs = 0): ScheduledTimer[] {
    if (!this.#paused) {
      return this.snapshot(from);
    }
    this.#paused = false;
    this.#pausedAt = null;
    const delay = Math.max(0, startDelayMs);
    for (const entry of this.#entries.values()) {
      const remaining = entry.remainingMs ?? Math.max(0, entry.deadline - from);
      entry.deadline = from + delay + remaining;
      entry.remainingMs = null;
      this.#arm(entry, delay + remaining);
    }
    return this.snapshot(from);
  }

  snapshot(at = this.#now()): ScheduledTimer[] {
    return [...this.#entries.values()]
      .map((entry) => ({
        key: entry.key,
        deadline: entry.deadline,
        remainingMs: entry.remainingMs ?? Math.max(0, entry.deadline - at)
      }))
      .sort((left, right) => left.key.localeCompare(right.key));
  }

  shiftDeadlines(deltaMs: number): void {
    if (!Number.isFinite(deltaMs) || deltaMs === 0) {
      return;
    }
    for (const entry of this.#entries.values()) {
      entry.deadline += deltaMs;
      if (entry.timer && !this.#paused) {
        this.#clearTimer(entry.timer);
        entry.timer = null;
        this.#arm(entry, Math.max(0, entry.deadline - this.#now()));
      }
    }
  }

  #arm(entry: TimerEntry, delayMs: number): void {
    entry.timer = this.#setTimer(
      () => {
        const current = this.#entries.get(entry.key);
        if (current !== entry || this.#paused) {
          return;
        }
        this.#entries.delete(entry.key);
        entry.timer = null;
        entry.callback();
      },
      Math.max(0, delayMs)
    );
  }
}
