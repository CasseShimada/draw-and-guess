import { describe, expect, it } from "vitest";

import { BUILTIN_WORD_PACK } from "./builtin-word-pack.js";
import {
  WordPackFileSchema,
  copyWordPack,
  parseWordPackBytes,
  resolveImportedWordPack,
  serializeWordPack
} from "./word-pack-schema.js";
import { normalizeAnswer } from "./word-normalization.js";

describe("word pack schema and serialization", () => {
  it("migrates every previous built-in word into a categorized read-only source", () => {
    const labels = BUILTIN_WORD_PACK.categories.flatMap((category) =>
      category.words.map((word) => word.text)
    );
    expect(labels).toEqual(
      expect.arrayContaining([
        "熊猫",
        "宇宙飞船",
        "生日蛋糕",
        "打喷嚏",
        "流星",
        "魔法帽"
      ])
    );
    expect(BUILTIN_WORD_PACK.categories.map((category) => category.name)).toEqual(
      expect.arrayContaining([
        "动物",
        "食物",
        "物品",
        "交通工具",
        "自然与天气",
        "动作",
        "体育",
        "人物与职业",
        "场所与建筑",
        "科技",
        "成语与短语",
        "影视、动画与游戏"
      ])
    );
  });

  it("round-trips stable UTF-8 output and rejects active or deceptive content", () => {
    const first = serializeWordPack(BUILTIN_WORD_PACK);
    const restored = parseWordPackBytes(new TextEncoder().encode(first));
    expect(restored).toEqual(BUILTIN_WORD_PACK);
    expect(serializeWordPack(restored)).toBe(first);

    expect(
      WordPackFileSchema.safeParse({
        ...BUILTIN_WORD_PACK,
        script: "<script>alert(1)</script>"
      }).success
    ).toBe(false);
    expect(
      WordPackFileSchema.safeParse({
        ...BUILTIN_WORD_PACK,
        categories: [
          {
            ...BUILTIN_WORD_PACK.categories[0],
            words: [
              {
                ...BUILTIN_WORD_PACK.categories[0]!.words[0],
                text: "\u202e熊猫"
              }
            ]
          }
        ]
      }).success
    ).toBe(false);
    expect(
      WordPackFileSchema.safeParse({
        ...BUILTIN_WORD_PACK,
        categories: [
          {
            ...BUILTIN_WORD_PACK.categories[0],
            words: [
              {
                ...BUILTIN_WORD_PACK.categories[0]!.words[0],
                text: "……！"
              }
            ]
          }
        ]
      }).success
    ).toBe(false);
  });

  it("copies IDs safely and handles all import collision decisions", () => {
    const copied = copyWordPack(BUILTIN_WORD_PACK, new Date("2026-01-01T00:00:00Z"));
    expect(copied.id).not.toBe(BUILTIN_WORD_PACK.id);
    expect(copied.categories[0]?.id).not.toBe(BUILTIN_WORD_PACK.categories[0]?.id);
    expect(copied.categories[0]?.words[0]?.id).not.toBe(
      BUILTIN_WORD_PACK.categories[0]?.words[0]?.id
    );

    const ids = new Set([BUILTIN_WORD_PACK.id]);
    expect(resolveImportedWordPack(BUILTIN_WORD_PACK, ids, "replace")).toEqual(
      BUILTIN_WORD_PACK
    );
    expect(resolveImportedWordPack(BUILTIN_WORD_PACK, ids, "cancel")).toBeNull();
    expect(resolveImportedWordPack(BUILTIN_WORD_PACK, ids, "keep-both")?.id).not.toBe(
      BUILTIN_WORD_PACK.id
    );
  });

  it("uses NFKC, case, whitespace, punctuation, and symbol normalization", () => {
    expect(normalizeAnswer("  Ｃａｔ， C-A T！ ")).toBe("catcat");
    expect(normalizeAnswer("你　好，世界！")).toBe("你好世界");
  });
});
