import { z } from "zod";

import type { LocalAvatar } from "./avatar-schema.js";
import type { WordPackFile, WordPackSummary } from "./word-pack-schema.js";

export interface WordPackStore {
  list(): Promise<WordPackSummary[]>;
  get(id: string): Promise<WordPackFile | null>;
  put(pack: WordPackFile): Promise<void>;
  remove(id: string): Promise<void>;
}

export interface AvatarStore {
  getActive(): Promise<LocalAvatar | null>;
  put(avatar: LocalAvatar): Promise<void>;
  remove(): Promise<void>;
}

export const WordPackSelectionSchema = z
  .object({
    schemaVersion: z.literal(1),
    packs: z.array(
      z
        .object({
          packId: z.uuid(),
          categoryIds: z.array(z.uuid())
        })
        .strict()
    )
  })
  .strict();

export type WordPackSelection = z.infer<typeof WordPackSelectionSchema>;

export interface WordPackSelectionStore {
  get(): Promise<WordPackSelection | null>;
  put(selection: WordPackSelection): Promise<void>;
}

export interface LocalContentServices {
  wordPacks: WordPackStore;
  avatar: AvatarStore;
  wordSelection: WordPackSelectionStore;
  wordFiles: {
    open(): Promise<Array<{ name: string; bytes: Uint8Array }>>;
    save(suggestedName: string, bytes: Uint8Array): Promise<boolean>;
  };
}
