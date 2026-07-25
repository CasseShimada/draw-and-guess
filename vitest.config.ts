import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["{apps,packages}/**/*.test.ts"],
    environment: "node",
    coverage: {
      provider: "v8",
      reporter: ["text", "html"],
      reportsDirectory: "coverage"
    }
  },
  resolve: {
    alias: {
      "@draw-guess/content": new URL("./packages/content/src/index.ts", import.meta.url)
        .pathname,
      "@draw-guess/shared-types": new URL(
        "./packages/shared-types/src/index.ts",
        import.meta.url
      ).pathname,
      "@draw-guess/game-rules": new URL(
        "./packages/game-rules/src/index.ts",
        import.meta.url
      ).pathname,
      "@draw-guess/protocol": new URL(
        "./packages/protocol/src/index.ts",
        import.meta.url
      ).pathname,
      "@draw-guess/capture-core": new URL(
        "./packages/capture-core/src/index.ts",
        import.meta.url
      ).pathname,
      "@draw-guess/server": new URL("./apps/server/src/server.ts", import.meta.url)
        .pathname
    }
  }
});
