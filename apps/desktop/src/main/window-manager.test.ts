import { describe, expect, it } from "vitest";

import { SECURE_WEB_PREFERENCES } from "./window-manager.js";

describe("BrowserWindow security baseline", () => {
  it("keeps every privileged renderer isolated and sandboxed", () => {
    expect(SECURE_WEB_PREFERENCES).toEqual({
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false
    });
  });
});
