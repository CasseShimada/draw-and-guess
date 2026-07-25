import { describe, expect, it } from "vitest";

import { BUILTIN_WORD_PACK } from "./builtin-word-pack.js";
import {
  answerMatches,
  buildWordPool,
  createWordDeck,
  drawWordOptions,
  markDeckAnswer,
  selectionFromPacks,
  type WordPoolUpload
} from "./word-pool.js";

function selectedBuiltin(): WordPoolUpload {
  return selectionFromPacks(
    new Map([
      [
        BUILTIN_WORD_PACK.id,
        new Set(BUILTIN_WORD_PACK.categories.map((category) => category.id))
      ]
    ]),
    [BUILTIN_WORD_PACK]
  );
}

describe("word pool normalization and deck", () => {
  it("builds enabled category selections and supports unambiguous aliases", () => {
    const pool = buildWordPool(selectedBuiltin());
    expect(pool.words.length).toBeGreaterThanOrEqual(30);
    const phone = pool.words.find((word) => word.text === "智能手机");
    expect(phone).toBeDefined();
    expect(answerMatches(phone!, "手 机！")).toBe(true);
    expect(pool.packs[0]?.selectedCategoryNames).toContain("科技");
  });

  it("deduplicates primaries and reports ambiguous aliases deterministically", () => {
    const upload = selectedBuiltin();
    const category = upload.packs[0]!.categories[0]!;
    category.words.push({
      id: "ffffffff-ffff-4fff-8fff-ffffffffffff",
      text: " 熊 猫！",
      aliases: ["国宝"],
      difficulty: "easy"
    });
    category.words.push({
      id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
      text: "小熊",
      aliases: ["熊猫"],
      difficulty: "easy"
    });
    const pool = buildWordPool(upload);
    expect(pool.words.filter((word) => word.normalizedText === "熊猫")).toHaveLength(1);
    expect(pool.conflicts.map((conflict) => conflict.kind)).toEqual(
      expect.arrayContaining(["duplicate-primary", "ambiguous-alias"])
    );
    expect(pool.words.find((word) => word.text === "小熊")?.aliases).toEqual([]);
  });

  it("draws three distinct candidates without reuse before exhaustion", () => {
    const words = buildWordPool(selectedBuiltin()).words.slice(0, 6);
    const deck = createWordDeck(words, () => 0);
    const first = drawWordOptions(deck, 3, () => 0);
    markDeckAnswer(deck, first[0]!);
    const second = drawWordOptions(deck, 3, () => 0);
    expect(new Set(first.map((word) => word.normalizedText)).size).toBe(3);
    expect(new Set(second.map((word) => word.normalizedText)).size).toBe(3);
    expect(second.map((word) => word.normalizedText)).not.toEqual(
      expect.arrayContaining(first.map((word) => word.normalizedText))
    );
    const third = drawWordOptions(deck, 3, () => 0);
    expect(third[0]?.normalizedText).not.toBe(first[0]?.normalizedText);
  });
});
