import type { ClassicPhase, GameModeId } from "@draw-guess/shared-types";
import { normalizeAnswer } from "@draw-guess/content";

export const FINAL_PRESENTATION_GRACE_SECONDS = 10 as const;
export const FINAL_PRESENTATION_GRACE_MS = FINAL_PRESENTATION_GRACE_SECONDS * 1_000;
export const RESUME_CAPTURE_COUNTDOWN_MS = 3_000 as const;
export const REFERENCE_PREPARING_TIMEOUT_MS = 20_000 as const;
export const SYNCHRONIZED_COUNTDOWN_MS = 3_000 as const;
export const MIN_DRAWING_SECONDS = 1 as const;
export const MAX_DRAWING_SECONDS = 10_800 as const;
export const MIN_REFERENCE_VOTING_SECONDS = 10 as const;
export const MAX_REFERENCE_VOTING_SECONDS = 600 as const;
export const MIN_RELAY_GUESSING_SECONDS = 1 as const;
export const MAX_RELAY_GUESSING_SECONDS = 600 as const;

export const GAME_MODE_LABELS: Readonly<Record<GameModeId, string>> = {
  classic: "经典你画我猜",
  "reference-copy": "参考图临摹",
  "draw-relay": "绘画接龙"
};

const PHASE_TRANSITIONS: Readonly<Record<ClassicPhase, readonly ClassicPhase[]>> = {
  LOBBY: ["WORD_SELECTION"],
  WORD_SELECTION: ["DRAWING", "TURN_RESULT"],
  DRAWING: ["FINALIZING", "TURN_RESULT"],
  FINALIZING: ["TURN_RESULT"],
  TURN_RESULT: ["WORD_SELECTION", "GAME_RESULT"],
  GAME_RESULT: ["LOBBY"]
};

export function normalizeGuess(value: string): string {
  return normalizeAnswer(value);
}

export function calculateGuesserScore(remainingMs: number): number {
  const remainingWholeSeconds = Math.floor(Math.max(0, remainingMs) / 1000);
  return 100 + remainingWholeSeconds * 5;
}

export interface ResolveGuessInput {
  guess: string;
  answer: string;
  aliases?: readonly string[];
  guesserId: string;
  drawerId: string;
  correctGuesserIds: ReadonlySet<string>;
  remainingMs: number;
}

export type GuessResolution =
  | { status: "drawer"; guesserPoints: 0; drawerPoints: 0 }
  | { status: "duplicate"; guesserPoints: 0; drawerPoints: 0 }
  | { status: "incorrect"; guesserPoints: 0; drawerPoints: 0 }
  | { status: "correct"; guesserPoints: number; drawerPoints: 50 };

export function resolveGuess(input: ResolveGuessInput): GuessResolution {
  if (input.guesserId === input.drawerId) {
    return { status: "drawer", guesserPoints: 0, drawerPoints: 0 };
  }

  if (input.correctGuesserIds.has(input.guesserId)) {
    return { status: "duplicate", guesserPoints: 0, drawerPoints: 0 };
  }

  const normalizedGuess = normalizeGuess(input.guess);
  if (
    normalizedGuess !== normalizeGuess(input.answer) &&
    !(input.aliases ?? []).some((alias) => normalizedGuess === normalizeGuess(alias))
  ) {
    return { status: "incorrect", guesserPoints: 0, drawerPoints: 0 };
  }

  return {
    status: "correct",
    guesserPoints: calculateGuesserScore(input.remainingMs),
    drawerPoints: 50
  };
}

export function canTransition(from: ClassicPhase, to: ClassicPhase): boolean {
  return PHASE_TRANSITIONS[from].includes(to);
}

export function assertTransition(from: ClassicPhase, to: ClassicPhase): void {
  if (!canTransition(from, to)) {
    throw new Error(`非法游戏状态转换：${from} → ${to}`);
  }
}

export function formatDuration(totalSeconds: number): string {
  const safe = Math.max(0, Math.floor(totalSeconds));
  const hours = Math.floor(safe / 3_600);
  const minutes = Math.floor((safe % 3_600) / 60);
  const seconds = safe % 60;
  return [hours, minutes, seconds]
    .map((value) => String(value).padStart(2, "0"))
    .join(":");
}

export function shuffledCopy<Value>(
  values: readonly Value[],
  randomIndex: (maximum: number) => number
): Value[] {
  const result = [...values];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const swapIndex = randomIndex(index + 1);
    if (!Number.isInteger(swapIndex) || swapIndex < 0 || swapIndex > index) {
      throw new RangeError("随机索引超出 Fisher–Yates 范围");
    }
    [result[index], result[swapIndex]] = [result[swapIndex]!, result[index]!];
  }
  return result;
}

export interface DrawerCandidate {
  playerId: string;
  joinedAt: number;
  captureReady: boolean;
}

export interface DrawerTurn {
  playerId: string;
  round: number;
}

export function buildDrawerQueue(
  candidates: readonly DrawerCandidate[],
  rounds: number
): DrawerTurn[] {
  if (!Number.isInteger(rounds) || rounds < 1) {
    throw new Error("轮数必须是正整数");
  }

  const eligible = [...candidates]
    .filter((candidate) => candidate.captureReady)
    .sort(
      (left, right) =>
        left.joinedAt - right.joinedAt || left.playerId.localeCompare(right.playerId)
    );

  const queue: DrawerTurn[] = [];
  for (let round = 1; round <= rounds; round += 1) {
    for (const candidate of eligible) {
      queue.push({ playerId: candidate.playerId, round });
    }
  }

  return queue;
}
