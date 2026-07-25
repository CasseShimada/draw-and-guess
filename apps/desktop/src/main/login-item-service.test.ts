import { describe, expect, it } from "vitest";

import { linuxAutostartEntry, quoteDesktopEntryExec } from "./login-item-service.js";

describe("login item service", () => {
  it("quotes Linux desktop-entry executable paths without field-code injection", () => {
    expect(quoteDesktopEntryExec('/opt/Draw Guess/a%b"$`')).toBe(
      '"/opt/Draw Guess/a%%b\\"\\$\\`"'
    );
    const entry = linuxAutostartEntry("/opt/Draw Guess/draw-guess");
    expect(entry).toContain('Exec="/opt/Draw Guess/draw-guess" --launch-at-login');
    expect(entry).toContain("Terminal=false");
  });
});
