import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/preload/preload.ts", "src/preload/overlay-preload.ts"],
  format: ["cjs"],
  platform: "node",
  target: "node22",
  outDir: "dist/preload",
  outExtension: () => ({ js: ".cjs" }),
  external: ["electron"],
  sourcemap: false,
  clean: true
});
