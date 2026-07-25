import {
  appendFileSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync
} from "node:fs";
import path from "node:path";

import type { DiagnosticEntry } from "../shared/ipc.js";

const SECRET_KEY =
  /(authorization|cookie|password|passwd|token|answer|secret|pair.?code)/i;
const BEARER_PATTERN = /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi;
const QUERY_SECRET_PATTERN = /([?&](?:token|password|secret|answer)=)[^&\s]+/gi;

export function redactDiagnosticValue(value: unknown, key = ""): unknown {
  if (SECRET_KEY.test(key)) {
    return "[REDACTED]";
  }
  if (typeof value === "string") {
    return value
      .replace(BEARER_PATTERN, "Bearer [REDACTED]")
      .replace(QUERY_SECRET_PATTERN, "$1[REDACTED]");
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactDiagnosticValue(item));
  }
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([entryKey, entryValue]) => [
        entryKey,
        redactDiagnosticValue(entryValue, entryKey)
      ])
    );
  }
  return value;
}

export class RedactingLogger {
  readonly #directory: string;
  readonly #filePath: string;
  readonly #maxBytes: number;
  readonly #entries: DiagnosticEntry[] = [];

  constructor(directory: string, maxBytes = 1_000_000) {
    this.#directory = directory;
    this.#filePath = path.join(directory, "desktop.log");
    this.#maxBytes = maxBytes;
  }

  info(message: string, details?: unknown): void {
    this.#write("info", message, details);
  }

  warn(message: string, details?: unknown): void {
    this.#write("warn", message, details);
  }

  error(message: string, details?: unknown): void {
    this.#write("error", message, details);
  }

  entries(): DiagnosticEntry[] {
    return structuredClone(this.#entries);
  }

  text(): Promise<string> {
    try {
      return Promise.resolve(readFileSync(this.#filePath, "utf8"));
    } catch {
      return Promise.resolve("");
    }
  }

  flush(): Promise<void> {
    return Promise.resolve();
  }

  #write(level: DiagnosticEntry["level"], message: string, details?: unknown): void {
    const safeMessage = String(redactDiagnosticValue(message));
    const suffix =
      details === undefined ? "" : ` ${JSON.stringify(redactDiagnosticValue(details))}`;
    const entry: DiagnosticEntry = {
      timestamp: new Date().toISOString(),
      level,
      message: `${safeMessage}${suffix}`
    };
    this.#entries.push(entry);
    if (this.#entries.length > 200) {
      this.#entries.splice(0, this.#entries.length - 200);
    }
    try {
      mkdirSync(this.#directory, { recursive: true });
      this.#rotateIfNeeded();
      appendFileSync(
        this.#filePath,
        `${entry.timestamp} ${level.toUpperCase()} ${entry.message}\n`,
        "utf8"
      );
    } catch {
      // Diagnostics must never make the application unavailable.
    }
  }

  #rotateIfNeeded(): void {
    try {
      const info = statSync(this.#filePath);
      if (info.size < this.#maxBytes) {
        return;
      }
      const rotatedPath = `${this.#filePath}.1`;
      rmSync(rotatedPath, { force: true });
      renameSync(this.#filePath, rotatedPath);
    } catch {
      // A missing log file needs no rotation.
    }
  }
}
