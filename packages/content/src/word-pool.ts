import { z } from "zod";

import { CONTENT_LIMITS } from "./content-limits.js";
import { normalizeAnswer } from "./word-normalization.js";
import {
  WordEntrySchema,
  WordPackFileSchema,
  type WordPackFile
} from "./word-pack-schema.js";

const SelectedWordSchema = z
  .object({
    id: WordEntrySchema.shape.id,
    text: WordEntrySchema.shape.text,
    aliases: WordEntrySchema.shape.aliases,
    difficulty: WordEntrySchema.shape.difficulty
  })
  .strict()
  .superRefine((entry, context) => {
    const answers = [entry.text, ...(entry.aliases ?? [])].map(normalizeAnswer);
    if (new Set(answers).size !== answers.length) {
      context.addIssue({
        code: "custom",
        message: "主词与别名中存在规范化后的重复答案",
        path: ["aliases"]
      });
    }
  });

export const SelectedWordCategorySchema = z
  .object({
    id: z.uuid(),
    name: z.string().trim().min(1).max(CONTENT_LIMITS.categoryNameCharacters),
    words: z.array(SelectedWordSchema).max(CONTENT_LIMITS.selectedWords)
  })
  .strict();

export const SelectedWordPackSchema = z
  .object({
    id: z.uuid(),
    name: z.string().trim().min(1).max(CONTENT_LIMITS.wordPackNameCharacters),
    categories: z
      .array(SelectedWordCategorySchema)
      .max(CONTENT_LIMITS.categoriesPerPack)
  })
  .strict();

export const WordPoolUploadSchema = z
  .object({
    schemaVersion: z.literal(1),
    packs: z.array(SelectedWordPackSchema).max(CONTENT_LIMITS.selectedPacks)
  })
  .strict()
  .superRefine((upload, context) => {
    let categories = 0;
    let words = 0;
    for (const pack of upload.packs) {
      categories += pack.categories.length;
      words += pack.categories.reduce(
        (total, category) => total + category.words.length,
        0
      );
    }
    if (categories > CONTENT_LIMITS.selectedCategories) {
      context.addIssue({
        code: "custom",
        message: "选择的分类数量超限",
        path: ["packs"]
      });
    }
    if (words > CONTENT_LIMITS.selectedWords) {
      context.addIssue({
        code: "custom",
        message: "选择的词条数量超限",
        path: ["packs"]
      });
    }
  });

export type SelectedWordPack = z.infer<typeof SelectedWordPackSchema>;
export type WordPoolUpload = z.infer<typeof WordPoolUploadSchema>;

export interface NormalizedPoolWord {
  id: string;
  text: string;
  normalizedText: string;
  aliases: string[];
  normalizedAliases: string[];
  category: string;
  packName: string;
  difficulty: "easy" | "normal" | "hard";
}

export interface WordPoolConflict {
  normalizedAnswer: string;
  words: string[];
  kind: "duplicate-primary" | "ambiguous-alias";
}

export interface BuiltWordPool {
  words: NormalizedPoolWord[];
  conflicts: WordPoolConflict[];
  packs: Array<{
    id: string;
    name: string;
    selectedCategoryNames: string[];
    enabledWordCount: number;
  }>;
  difficulty: {
    easy: number;
    normal: number;
    hard: number;
  };
}

export function selectionFromPacks(
  selected: ReadonlyMap<string, ReadonlySet<string>>,
  packsInput: readonly WordPackFile[]
): WordPoolUpload {
  const packs = packsInput.map((pack) => WordPackFileSchema.parse(pack));
  return WordPoolUploadSchema.parse({
    schemaVersion: 1,
    packs: packs.flatMap((pack) => {
      const categoryIds = selected.get(pack.id);
      if (!categoryIds) {
        return [];
      }
      const categories = pack.categories.flatMap((category) => {
        if (!category.enabled || !categoryIds.has(category.id)) {
          return [];
        }
        const words = category.words
          .filter((word) => word.enabled)
          .map(({ enabled: _enabled, ...word }) => word);
        return words.length > 0
          ? [{ id: category.id, name: category.name, words }]
          : [];
      });
      return categories.length > 0
        ? [{ id: pack.id, name: pack.name, categories }]
        : [];
    })
  });
}

export function buildWordPool(uploadInput: WordPoolUpload): BuiltWordPool {
  const upload = WordPoolUploadSchema.parse(uploadInput);
  const primary = new Map<string, NormalizedPoolWord>();
  const conflicts: WordPoolConflict[] = [];

  for (const pack of upload.packs) {
    for (const category of pack.categories) {
      for (const word of category.words) {
        const normalizedText = normalizeAnswer(word.text);
        const existing = primary.get(normalizedText);
        if (existing) {
          conflicts.push({
            normalizedAnswer: normalizedText,
            words: [existing.text, word.text],
            kind: "duplicate-primary"
          });
          continue;
        }
        primary.set(normalizedText, {
          id: word.id,
          text: word.text,
          normalizedText,
          aliases: [],
          normalizedAliases: [],
          category: category.name,
          packName: pack.name,
          difficulty: word.difficulty ?? "normal"
        });
      }
    }
  }

  const aliasOwners = new Map<
    string,
    Array<{ owner: NormalizedPoolWord; original: string }>
  >();
  for (const pack of upload.packs) {
    for (const category of pack.categories) {
      for (const source of category.words) {
        const owner = primary.get(normalizeAnswer(source.text));
        if (!owner || owner.id !== source.id) {
          continue;
        }
        for (const alias of source.aliases ?? []) {
          const normalized = normalizeAnswer(alias);
          if (normalized === owner.normalizedText) {
            continue;
          }
          const owners = aliasOwners.get(normalized) ?? [];
          owners.push({ owner, original: alias });
          aliasOwners.set(normalized, owners);
        }
      }
    }
  }

  for (const [normalizedAlias, owners] of aliasOwners) {
    const distinctOwners = new Map(
      owners.map((candidate) => [candidate.owner.normalizedText, candidate])
    );
    const primaryCollision = primary.get(normalizedAlias);
    if (primaryCollision || distinctOwners.size > 1) {
      conflicts.push({
        normalizedAnswer: normalizedAlias,
        words: [
          ...(primaryCollision ? [primaryCollision.text] : []),
          ...[...distinctOwners.values()].map((candidate) => candidate.owner.text)
        ],
        kind: "ambiguous-alias"
      });
      continue;
    }
    const candidate = owners[0];
    if (candidate) {
      candidate.owner.aliases.push(candidate.original);
      candidate.owner.normalizedAliases.push(normalizedAlias);
    }
  }

  const words = [...primary.values()];
  return {
    words,
    conflicts,
    packs: upload.packs.map((pack) => ({
      id: pack.id,
      name: pack.name,
      selectedCategoryNames: pack.categories.map((category) => category.name),
      enabledWordCount: pack.categories.reduce(
        (total, category) => total + category.words.length,
        0
      )
    })),
    difficulty: {
      easy: words.filter((word) => word.difficulty === "easy").length,
      normal: words.filter((word) => word.difficulty === "normal").length,
      hard: words.filter((word) => word.difficulty === "hard").length
    }
  };
}

export function answerMatches(word: NormalizedPoolWord, guess: string): boolean {
  const normalized = normalizeAnswer(guess);
  return (
    normalized === word.normalizedText || word.normalizedAliases.includes(normalized)
  );
}

function secureRandomIndex(maximum: number): number {
  if (!Number.isInteger(maximum) || maximum < 1) {
    throw new RangeError("随机上限必须是正整数");
  }
  const limit = Math.floor(0x1_0000_0000 / maximum) * maximum;
  const values = new Uint32Array(1);
  do {
    crypto.getRandomValues(values);
  } while ((values[0] ?? 0) >= limit);
  return (values[0] ?? 0) % maximum;
}

export type RandomIndex = (maximum: number) => number;

export interface WordDeck {
  readonly words: readonly NormalizedPoolWord[];
  remaining: NormalizedPoolWord[];
  lastAnswer: string | null;
  cycle: number;
}

function shuffled(
  words: readonly NormalizedPoolWord[],
  randomIndex: RandomIndex
): NormalizedPoolWord[] {
  const result = [...words];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const swapIndex = randomIndex(index + 1);
    [result[index], result[swapIndex]] = [result[swapIndex]!, result[index]!];
  }
  return result;
}

export function createWordDeck(
  words: readonly NormalizedPoolWord[],
  randomIndex: RandomIndex = secureRandomIndex
): WordDeck {
  if (words.length < CONTENT_LIMITS.minimumPlayableWords) {
    throw new Error("至少需要 3 个有效唯一词条");
  }
  return {
    words: [...words],
    remaining: shuffled(words, randomIndex),
    lastAnswer: null,
    cycle: 1
  };
}

function refillDeck(deck: WordDeck, randomIndex: RandomIndex): void {
  deck.remaining = shuffled(deck.words, randomIndex);
  if (
    deck.remaining.length > 1 &&
    deck.lastAnswer &&
    deck.remaining[0]?.normalizedText === deck.lastAnswer
  ) {
    const first = deck.remaining[0];
    const second = deck.remaining[1];
    if (first && second) {
      [deck.remaining[0], deck.remaining[1]] = [second, first];
    }
  }
  deck.cycle += 1;
}

export function drawWordOptions(
  deck: WordDeck,
  count = 3,
  randomIndex: RandomIndex = secureRandomIndex
): NormalizedPoolWord[] {
  const requested = Math.min(Math.max(1, count), deck.words.length);
  const selected: NormalizedPoolWord[] = [];
  const selectedKeys = new Set<string>();
  let guard = deck.words.length * 4;
  while (selected.length < requested && guard > 0) {
    guard -= 1;
    if (deck.remaining.length === 0) {
      refillDeck(deck, randomIndex);
    }
    const next = deck.remaining.shift();
    if (!next || selectedKeys.has(next.normalizedText)) {
      continue;
    }
    if (
      next.normalizedText === deck.lastAnswer &&
      deck.words.length > requested &&
      selected.length === 0
    ) {
      deck.remaining.push(next);
      continue;
    }
    selectedKeys.add(next.normalizedText);
    selected.push(next);
  }
  if (selected.length !== requested) {
    throw new Error("词库无法生成互不相同的候选词");
  }
  return selected;
}

export function markDeckAnswer(deck: WordDeck, word: NormalizedPoolWord): void {
  deck.lastAnswer = word.normalizedText;
}
