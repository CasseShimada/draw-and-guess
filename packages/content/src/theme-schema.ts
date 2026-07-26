import { z } from "zod";

export const THEME_API_VERSION = 1;

export const ThemeApplyModeSchema = z.enum(["replace", "override"]);

export type ThemeApplyMode = z.infer<typeof ThemeApplyModeSchema>;
