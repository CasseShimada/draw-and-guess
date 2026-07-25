import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/main/main.ts"],
  format: ["cjs"],
  platform: "node",
  target: "node22",
  outDir: "dist/main",
  outExtension: () => ({ js: ".cjs" }),
  external: ["electron", "sharp"],
  noExternal: ["postcss", "postcss-selector-parser", "postcss-value-parser"],
  sourcemap: false,
  clean: true
});
