import { z } from "zod";

export function normalizeNicknameInput(value: string): string {
  return [...value.normalize("NFKC")]
    .filter((character) => {
      const code = character.charCodeAt(0);
      return !((code >= 0 && code <= 31) || (code >= 127 && code <= 159));
    })
    .join("")
    .trim();
}

export const NicknameInputSchema = z
  .string()
  .transform(normalizeNicknameInput)
  .refine((value) => [...value].length <= 24, "昵称不能超过 24 个字符");

export const RememberedNicknameSchema = NicknameInputSchema.refine(
  (value) => value.length > 0,
  "记住的昵称不能为空"
);
