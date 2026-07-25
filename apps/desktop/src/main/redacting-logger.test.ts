import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { RedactingLogger, redactDiagnosticValue } from "./redacting-logger.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

describe("diagnostic redaction", () => {
  it("removes structured and inline credentials without hiding useful state", () => {
    expect(
      redactDiagnosticValue({
        authorization: "Bearer abc.def",
        nested: { password: "secret", port: 3000 },
        message: "failed https://x.test/?token=abc&room=ABC234"
      })
    ).toEqual({
      authorization: "[REDACTED]",
      nested: { password: "[REDACTED]", port: 3000 },
      message: "failed https://x.test/?token=[REDACTED]&room=ABC234"
    });
  });

  it("rotates repeatedly while retaining only redacted diagnostic files", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "draw-guess-log-"));
    directories.push(directory);
    const logger = new RedactingLogger(directory, 1);

    logger.info("first", { token: "one" });
    logger.info("second", { token: "two" });
    logger.info("third", { token: "three" });

    const current = await readFile(path.join(directory, "desktop.log"), "utf8");
    const rotated = await readFile(path.join(directory, "desktop.log.1"), "utf8");
    expect(current).toContain("third");
    expect(rotated).toContain("second");
    expect(`${current}${rotated}`).not.toMatch(/\b(one|two|three)\b/);
  });
});
