import {
  createHash,
  randomBytes,
  randomInt,
  scrypt as scryptCallback,
  timingSafeEqual
} from "node:crypto";
import { promisify } from "node:util";

const scrypt = promisify(scryptCallback);
const SCRYPT_KEY_BYTES = 64;

export interface PasswordDigest {
  salt: string;
  hash: string;
}

export async function hashPassword(password: string): Promise<PasswordDigest> {
  const salt = randomBytes(16);
  const derived = (await scrypt(password, salt, SCRYPT_KEY_BYTES)) as Buffer;
  return {
    salt: salt.toString("base64url"),
    hash: derived.toString("base64url")
  };
}

export async function verifyPassword(
  password: string,
  digest: PasswordDigest
): Promise<boolean> {
  const expected = Buffer.from(digest.hash, "base64url");
  const actual = (await scrypt(
    password,
    Buffer.from(digest.salt, "base64url"),
    expected.byteLength
  )) as Buffer;
  return actual.byteLength === expected.byteLength && timingSafeEqual(actual, expected);
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

export function tokenDigest(token: string): string {
  return createHash("sha256").update(token).digest("base64url");
}

const ROOM_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export function randomRoomCode(length = 6): string {
  let value = "";
  for (let index = 0; index < length; index += 1) {
    value += ROOM_ALPHABET[randomInt(ROOM_ALPHABET.length)];
  }
  return value;
}

export function randomId(bytes = 16): string {
  return randomBytes(bytes).toString("base64url");
}

export function sanitizeNickname(value: string): string {
  return [...value.normalize("NFKC")]
    .filter((character) => {
      const code = character.charCodeAt(0);
      return !((code >= 0 && code <= 31) || (code >= 127 && code <= 159));
    })
    .join("")
    .trim()
    .slice(0, 24);
}

export interface PlayerSession {
  digest: string;
  roomCode: string;
  playerId: string;
  expiresAt: number;
  kind: "browser" | "desktop";
}

export class SessionStore {
  readonly #sessions = new Map<string, PlayerSession>();
  readonly #browserTtlMs: number;

  constructor(browserTtlMs = 7 * 24 * 60 * 60 * 1000) {
    this.#browserTtlMs = browserTtlMs;
  }

  issue(
    roomCode: string,
    playerId: string,
    now: number,
    kind: PlayerSession["kind"] = "browser",
    ttlMs = this.#browserTtlMs
  ): { token: string; session: PlayerSession } {
    const token = randomToken();
    const session: PlayerSession = {
      digest: tokenDigest(token),
      roomCode,
      playerId,
      expiresAt: now + ttlMs,
      kind
    };
    this.#sessions.set(session.digest, session);
    return { token, session };
  }

  verify(token: string, now: number): PlayerSession | null {
    const digest = tokenDigest(token);
    const session = this.#sessions.get(digest);
    if (!session || session.expiresAt <= now) {
      this.#sessions.delete(digest);
      return null;
    }
    return session;
  }

  removeRoom(roomCode: string): void {
    for (const [digest, session] of this.#sessions) {
      if (session.roomCode === roomCode) {
        this.#sessions.delete(digest);
      }
    }
  }

  cleanup(now: number): void {
    for (const [digest, session] of this.#sessions) {
      if (session.expiresAt <= now) {
        this.#sessions.delete(digest);
      }
    }
  }
}
