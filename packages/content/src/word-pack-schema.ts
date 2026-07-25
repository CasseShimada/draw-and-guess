import { z } from "zod";

import { CONTENT_LIMITS } from "./content-limits.js";
import {
  hasForbiddenTextCharacters,
  isUsableWordText,
  normalizeAnswer,
  unicodeLength
} from "./word-normalization.js";

function boundedText(
  label: string,
  maximum: number,
  options: { allowEmpty?: boolean } = {}
) {
  return z
    .string()
    .trim()
    .refine((value) => options.allowEmpty || unicodeLength(value) >= 1, {
      message: `${label}不能为空`
    })
    .refine((value) => unicodeLength(value) <= maximum, {
      message: `${label}最多 ${String(maximum)} 个字符`
    })
    .refine((value) => !hasForbiddenTextCharacters(value), {
      message: `${label}包含控制字符或不可见字符`
    });
}

const WordTextSchema = boundedText("词语", CONTENT_LIMITS.wordCharacters).refine(
  isUsableWordText,
  "词语不能是空白或纯标点"
);

export const WordEntrySchema = z
  .object({
    id: z.uuid(),
    text: WordTextSchema,
    aliases: z.array(WordTextSchema).max(CONTENT_LIMITS.aliasesPerWord).optional(),
    difficulty: z.enum(["easy", "normal", "hard"]).optional(),
    enabled: z.boolean()
  })
  .strict()
  .superRefine((entry, context) => {
    const answers = [entry.text, ...(entry.aliases ?? [])].map(normalizeAnswer);
    const unique = new Set(answers);
    if (unique.size !== answers.length) {
      context.addIssue({
        code: "custom",
        message: "主词与别名中存在规范化后的重复答案",
        path: ["aliases"]
      });
    }
  });

export const WordCategorySchema = z
  .object({
    id: z.uuid(),
    name: boundedText("分类名", CONTENT_LIMITS.categoryNameCharacters),
    enabled: z.boolean(),
    words: z.array(WordEntrySchema).max(CONTENT_LIMITS.wordsPerPack)
  })
  .strict();

export const WordPackFileSchema = z
  .object({
    format: z.literal("draw-guess-word-pack"),
    schemaVersion: z.literal(1),
    id: z.uuid(),
    name: boundedText("词库包名", CONTENT_LIMITS.wordPackNameCharacters),
    description: boundedText("描述", CONTENT_LIMITS.wordPackDescriptionCharacters, {
      allowEmpty: true
    }).optional(),
    language: boundedText("语言", CONTENT_LIMITS.wordPackLanguageCharacters),
    author: boundedText("作者", CONTENT_LIMITS.wordPackAuthorCharacters).optional(),
    revision: z.number().int().min(1),
    categories: z.array(WordCategorySchema).max(CONTENT_LIMITS.categoriesPerPack),
    createdAt: z.string().datetime({ offset: true }),
    updatedAt: z.string().datetime({ offset: true })
  })
  .strict()
  .superRefine((pack, context) => {
    const categoryIds = new Set<string>();
    const wordIds = new Set<string>();
    let wordCount = 0;
    for (const [categoryIndex, category] of pack.categories.entries()) {
      if (categoryIds.has(category.id)) {
        context.addIssue({
          code: "custom",
          message: "分类 ID 不能重复",
          path: ["categories", categoryIndex, "id"]
        });
      }
      categoryIds.add(category.id);
      wordCount += category.words.length;
      for (const [wordIndex, word] of category.words.entries()) {
        if (wordIds.has(word.id)) {
          context.addIssue({
            code: "custom",
            message: "词条 ID 不能重复",
            path: ["categories", categoryIndex, "words", wordIndex, "id"]
          });
        }
        wordIds.add(word.id);
      }
    }
    if (wordCount > CONTENT_LIMITS.wordsPerPack) {
      context.addIssue({
        code: "too_big",
        origin: "array",
        maximum: CONTENT_LIMITS.wordsPerPack,
        inclusive: true,
        message: `每个词库包最多 ${String(CONTENT_LIMITS.wordsPerPack)} 个词条`,
        path: ["categories"]
      });
    }
  });

export type WordEntry = z.infer<typeof WordEntrySchema>;
export type WordCategory = z.infer<typeof WordCategorySchema>;
export type WordPackFile = z.infer<typeof WordPackFileSchema>;

export const WordPackSummarySchema = z
  .object({
    id: z.uuid(),
    name: z.string(),
    language: z.string(),
    revision: z.number().int().min(1),
    builtIn: z.boolean(),
    categoryCount: z.number().int().nonnegative(),
    wordCount: z.number().int().nonnegative(),
    enabledWordCount: z.number().int().nonnegative(),
    categories: z.array(
      z
        .object({
          id: z.uuid(),
          name: z.string(),
          enabled: z.boolean(),
          wordCount: z.number().int().nonnegative(),
          enabledWordCount: z.number().int().nonnegative()
        })
        .strict()
    )
  })
  .strict();

export type WordPackSummary = z.infer<typeof WordPackSummarySchema>;

export function summarizeWordPack(
  packInput: WordPackFile,
  builtIn = false
): WordPackSummary {
  const pack = WordPackFileSchema.parse(packInput);
  const categories = pack.categories.map((category) => ({
    id: category.id,
    name: category.name,
    enabled: category.enabled,
    wordCount: category.words.length,
    enabledWordCount: category.words.filter((word) => word.enabled).length
  }));
  return WordPackSummarySchema.parse({
    id: pack.id,
    name: pack.name,
    language: pack.language,
    revision: pack.revision,
    builtIn,
    categoryCount: pack.categories.length,
    wordCount: categories.reduce((total, category) => total + category.wordCount, 0),
    enabledWordCount: categories.reduce(
      (total, category) => total + (category.enabled ? category.enabledWordCount : 0),
      0
    ),
    categories
  });
}

function canonicalEntry(entry: WordEntry): WordEntry {
  return {
    id: entry.id,
    text: entry.text,
    ...(entry.aliases?.length ? { aliases: [...entry.aliases] } : {}),
    ...(entry.difficulty ? { difficulty: entry.difficulty } : {}),
    enabled: entry.enabled
  };
}

export function canonicalizeWordPack(packInput: WordPackFile): WordPackFile {
  const pack = WordPackFileSchema.parse(packInput);
  return {
    format: "draw-guess-word-pack",
    schemaVersion: 1,
    id: pack.id,
    name: pack.name,
    ...(pack.description !== undefined ? { description: pack.description } : {}),
    language: pack.language,
    ...(pack.author !== undefined ? { author: pack.author } : {}),
    revision: pack.revision,
    categories: pack.categories.map((category) => ({
      id: category.id,
      name: category.name,
      enabled: category.enabled,
      words: category.words.map(canonicalEntry)
    })),
    createdAt: pack.createdAt,
    updatedAt: pack.updatedAt
  };
}

export function serializeWordPack(packInput: WordPackFile): string {
  const serialized = `${JSON.stringify(canonicalizeWordPack(packInput), null, 2)}\n`;
  if (
    new TextEncoder().encode(serialized).byteLength > CONTENT_LIMITS.wordPackFileBytes
  ) {
    throw new Error("词库包导出后超过 2 MiB");
  }
  return serialized;
}

export function parseWordPackBytes(bytes: Uint8Array): WordPackFile {
  if (bytes.byteLength === 0 || bytes.byteLength > CONTENT_LIMITS.wordPackFileBytes) {
    throw new Error("词库包文件必须在 1 字节到 2 MiB 之间");
  }
  let value: unknown;
  try {
    value = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes)
    ) as unknown;
  } catch {
    throw new Error("词库包必须是有效的 UTF-8 JSON");
  }
  return WordPackFileSchema.parse(value);
}

export function createEmptyWordPack(name = "新词库包", now = new Date()): WordPackFile {
  const timestamp = now.toISOString();
  return WordPackFileSchema.parse({
    format: "draw-guess-word-pack",
    schemaVersion: 1,
    id: crypto.randomUUID(),
    name,
    language: "zh-CN",
    revision: 1,
    categories: [],
    createdAt: timestamp,
    updatedAt: timestamp
  });
}

export function copyWordPack(packInput: WordPackFile, now = new Date()): WordPackFile {
  const pack = WordPackFileSchema.parse(packInput);
  const timestamp = now.toISOString();
  return WordPackFileSchema.parse({
    ...structuredClone(pack),
    id: crypto.randomUUID(),
    name: `${pack.name} 副本`,
    revision: 1,
    createdAt: timestamp,
    updatedAt: timestamp,
    categories: pack.categories.map((category) => ({
      ...category,
      id: crypto.randomUUID(),
      words: category.words.map((word) => ({
        ...word,
        id: crypto.randomUUID()
      }))
    }))
  });
}

export type ImportConflictDecision = "replace" | "keep-both" | "cancel";

export function resolveImportedWordPack(
  importedInput: WordPackFile,
  existingIds: ReadonlySet<string>,
  decision: ImportConflictDecision,
  now = new Date()
): WordPackFile | null {
  const imported = canonicalizeWordPack(importedInput);
  if (!existingIds.has(imported.id)) {
    return imported;
  }
  if (decision === "cancel") {
    return null;
  }
  if (decision === "replace") {
    return imported;
  }
  return WordPackFileSchema.parse({
    ...imported,
    id: crypto.randomUUID(),
    name: `${imported.name}（导入副本）`,
    updatedAt: now.toISOString()
  });
}
