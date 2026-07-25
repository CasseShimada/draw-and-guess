import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";

const desktopRoot = path.resolve(import.meta.dirname, "..");
const makeRoot = path.join(desktopRoot, "out", "make");
const unsignedMarker = path.join(makeRoot, "UNSIGNED-BUILD.txt");
const { version } = JSON.parse(
  await readFile(path.join(desktopRoot, "package.json"), "utf8")
);

const signed =
  process.platform === "win32"
    ? Boolean(
        process.env.WINDOWS_CERTIFICATE_FILE && process.env.WINDOWS_CERTIFICATE_PASSWORD
      )
    : process.platform === "darwin"
      ? Boolean(process.env.APPLE_SIGN_IDENTITY)
      : false;

if (signed) {
  await rm(unsignedMarker, { force: true });
} else {
  await writeFile(
    unsignedMarker,
    [
      "UNSIGNED TEST BUILD",
      "",
      "This build was produced without a platform code-signing identity.",
      "Use it for testing only; official releases should be signed and notarized where applicable.",
      `Platform: ${process.platform}-${process.arch}`,
      ""
    ].join("\n"),
    "utf8"
  );
}

async function filesUnder(directory) {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      result.push(...(await filesUnder(target)));
    } else if (entry.isFile()) {
      result.push(target);
    }
  }
  return result;
}

async function sha256(file) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) {
    hash.update(chunk);
  }
  return hash.digest("hex");
}

const artifacts = (await filesUnder(makeRoot))
  .filter((artifact) => {
    const name = path.basename(artifact);
    return (
      name === "UNSIGNED-BUILD.txt" ||
      name === "DrawGuessSetup.exe" ||
      name === "RELEASES" ||
      name.includes(`-${version}`)
    );
  })
  .sort();
if (artifacts.length === 0) {
  throw new Error("没有找到 Forge 安装产物");
}
const lines = [];
for (const artifact of artifacts) {
  lines.push(
    `${await sha256(artifact)}  ${path.relative(makeRoot, artifact).replaceAll("\\", "/")}`
  );
}
await writeFile(
  path.join(desktopRoot, "out", "SHA256SUMS.txt"),
  `${lines.join("\n")}\n`,
  "utf8"
);
