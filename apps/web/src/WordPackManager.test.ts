import { describe, expect, it } from "vitest";

import { BUILTIN_WORD_PACK, copyWordPack, type WordEntry } from "@draw-guess/content";

import {
  createBatchWordEntries,
  findNormalizedWordConflicts
} from "./WordPackManager.js";

describe("word-pack editor pure helpers", () => {
  it("batch-adds one word per line with NFKC deduplication", () => {
    const existing: WordEntry[] = [
      {
        id: "11111111-1111-4111-8111-111111111111",
        text: "熊猫",
        aliases: ["国宝"],
        difficulty: "easy",
        enabled: true
      }
    ];
    let id = 1;
    const additions = createBatchWordEntries(
      " 熊 猫！\n热气球\n熱氣球\n热气球\n……\n",
      existing,
      () => `00000000-0000-4000-8000-${String(id++).padStart(12, "0")}`
    );
    expect(additions.map((word) => word.text)).toEqual(["热气球", "熱氣球"]);
    expect(additions.every((word) => word.enabled)).toBe(true);
    expect(additions.every((word) => word.difficulty === "normal")).toBe(true);
  });

  it("reports exact duplicate primaries and cross-entry alias collisions", () => {
    const pack = copyWordPack(BUILTIN_WORD_PACK, new Date("2026-07-25T00:00:00.000Z"));
    const category = pack.categories[0]!;
    const original = category.words[0]!;
    category.words.push({
      id: crypto.randomUUID(),
      text: original.text,
      enabled: true
    });
    category.words.push({
      id: crypto.randomUUID(),
      text: "另一词",
      aliases: [original.text],
      enabled: true
    });
    const conflicts = findNormalizedWordConflicts(pack);
    expect(conflicts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          labels: expect.arrayContaining([original.text, "另一词"])
        })
      ])
    );
  });

  it("rejects an overlong batch line before mutating the editor", () => {
    expect(() =>
      createBatchWordEntries(
        "超".repeat(41),
        [],
        () => "00000000-0000-4000-8000-000000000001"
      )
    ).toThrow("第 1 行");
  });
});
