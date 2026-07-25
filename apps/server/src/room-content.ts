import { createHash } from "node:crypto";

import {
  BUILTIN_WORD_PACK,
  WordPoolUploadSchema,
  buildWordPool,
  selectionFromPacks,
  type BuiltWordPool,
  type WordPoolUpload
} from "@draw-guess/content";
import type { PublicWordPoolSummary } from "@draw-guess/shared-types";

export interface RoomWordPool {
  upload: WordPoolUpload;
  built: BuiltWordPool;
  revision: string;
  summary: PublicWordPoolSummary;
}

export function roomWordPoolRevision(upload: WordPoolUpload): string {
  return createHash("sha256")
    .update(JSON.stringify(WordPoolUploadSchema.parse(upload)))
    .digest("hex");
}

export function createRoomWordPool(uploadInput: WordPoolUpload): RoomWordPool {
  const upload = WordPoolUploadSchema.parse(structuredClone(uploadInput));
  const built = buildWordPool(upload);
  const revision = roomWordPoolRevision(upload);
  return {
    upload,
    built,
    revision,
    summary: {
      revision,
      packs: built.packs.map((pack) => ({
        name: pack.name,
        selectedCategoryNames: [...pack.selectedCategoryNames],
        enabledWordCount: pack.enabledWordCount
      })),
      uniqueWordCount: built.words.length
    }
  };
}

export function createDefaultRoomWordPool(): RoomWordPool {
  return createRoomWordPool(
    selectionFromPacks(
      new Map([
        [
          BUILTIN_WORD_PACK.id,
          new Set(BUILTIN_WORD_PACK.categories.map((category) => category.id))
        ]
      ]),
      [BUILTIN_WORD_PACK]
    )
  );
}
