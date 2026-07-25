import { readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

const desktopRoot = path.resolve(import.meta.dirname, "../..");
const repositoryRoot = path.resolve(desktopRoot, "../..");

describe("field-based connection entry", () => {
  it("does not register or process external invitation protocols", async () => {
    const sources = await Promise.all(
      [
        path.join(desktopRoot, "forge.config.ts"),
        path.join(desktopRoot, "src/main/main.ts"),
        path.join(desktopRoot, "src/preload/preload.ts"),
        path.join(desktopRoot, "src/shared/ipc.ts"),
        path.join(repositoryRoot, "apps/web/src/App.tsx")
      ].map((file) => readFile(file, "utf8"))
    );
    const runtime = sources.join("\n");
    expect(runtime).not.toContain(["drawguess", "://"].join(""));
    expect(runtime).not.toContain("setAsDefaultProtocolClient");
    expect(runtime).not.toContain(["parse", "Invite", "Arguments"].join(""));
    expect(runtime).not.toContain(["Invite", "Schema"].join(""));
    expect(runtime).not.toContain(["invite", "Received"].join(""));
    expect(runtime).not.toContain(["?room", "="].join(""));
  });

  it("retains the unrelated read-only drawguess-app resource protocol", async () => {
    const source = await readFile(
      path.join(desktopRoot, "src/main/window-manager.ts"),
      "utf8"
    );
    expect(source).toContain('LOCAL_APP_PROTOCOL = "drawguess-app"');
  });
});
