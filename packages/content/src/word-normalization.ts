const FORBIDDEN_TEXT_PATTERN = /[\p{Cc}\p{Cf}\p{Cs}]/u;
const WHITESPACE_PUNCTUATION_SYMBOL_PATTERN = /[\s\p{P}\p{S}]+/gu;

export function unicodeLength(value: string): number {
  return [...value].length;
}

export function normalizeAnswer(value: string): string {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase("zh-CN")
    .replace(WHITESPACE_PUNCTUATION_SYMBOL_PATTERN, "");
}

export function hasForbiddenTextCharacters(value: string): boolean {
  return FORBIDDEN_TEXT_PATTERN.test(value);
}

export function isUsableWordText(value: string): boolean {
  const trimmed = value.trim();
  return (
    trimmed.length > 0 &&
    !hasForbiddenTextCharacters(trimmed) &&
    normalizeAnswer(trimmed).length > 0
  );
}

export function sanitizeExportFilename(value: string): string {
  const normalized = value
    .normalize("NFKC")
    .replace(/[<>:"/\\|?*\p{Cc}\p{Cf}]/gu, "-")
    .replace(/[.\s]+$/u, "")
    .trim()
    .slice(0, 80);
  return normalized || "word-pack";
}
