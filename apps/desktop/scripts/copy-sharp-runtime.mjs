import { createRequire } from "node:module";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

const require = createRequire(import.meta.url);
const desktopRoot = path.resolve(import.meta.dirname, "..");
const runtimeRoot = path.join(desktopRoot, "dist", "main", "node_modules");

function contained(parent, target) {
  const relative = path.relative(parent, target);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

async function packageRoot(packageName) {
  const candidates = [
    packageName,
    `${packageName}/package`,
    `${packageName}/package.json`
  ];
  let entry;
  for (const candidate of candidates) {
    try {
      entry = require.resolve(candidate);
      break;
    } catch {
      // Try the package's next supported export.
    }
  }
  if (!entry) {
    throw new Error(`无法解析 Sharp 运行时依赖：${packageName}`);
  }
  let directory = path.dirname(entry);
  while (true) {
    const manifestPath = path.join(directory, "package.json");
    try {
      const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
      if (manifest.name === packageName) {
        return { directory, manifest };
      }
    } catch {
      // Continue toward the filesystem root.
    }
    const parent = path.dirname(directory);
    if (parent === directory) {
      throw new Error(`无法定位 Sharp 运行时包根：${packageName}`);
    }
    directory = parent;
  }
}

function platformPackages() {
  const key = `${process.platform}-${process.arch}`;
  const packages = {
    "win32-x64": ["@img/sharp-win32-x64"],
    "win32-arm64": ["@img/sharp-win32-arm64"],
    "darwin-x64": ["@img/sharp-darwin-x64", "@img/sharp-libvips-darwin-x64"],
    "darwin-arm64": ["@img/sharp-darwin-arm64", "@img/sharp-libvips-darwin-arm64"],
    "linux-x64": ["@img/sharp-linux-x64", "@img/sharp-libvips-linux-x64"],
    "linux-arm64": ["@img/sharp-linux-arm64", "@img/sharp-libvips-linux-arm64"]
  }[key];
  if (!packages) {
    throw new Error(`不支持的 Sharp 桌面打包平台：${key}`);
  }
  return packages;
}

const packageNames = [
  "sharp",
  "@img/colour",
  "detect-libc",
  "semver",
  ...platformPackages()
];

if (!contained(desktopRoot, runtimeRoot)) {
  throw new Error("Sharp 运行时目标目录越界");
}
await rm(runtimeRoot, { recursive: true, force: true });
await mkdir(runtimeRoot, { recursive: true });

const copied = [];
for (const packageName of packageNames) {
  const source = await packageRoot(packageName);
  const destination = path.join(runtimeRoot, ...packageName.split("/"));
  if (!contained(runtimeRoot, destination)) {
    throw new Error(`Sharp 运行时包目标越界：${packageName}`);
  }
  await mkdir(path.dirname(destination), { recursive: true });
  const excludedTopLevel = new Set([
    "node_modules",
    "README.md",
    ...(packageName === "sharp" ? ["install", "src"] : [])
  ]);
  await cp(source.directory, destination, {
    recursive: true,
    dereference: true,
    filter: (candidate) => {
      const relative = path.relative(source.directory, candidate);
      const topLevel = relative.split(path.sep)[0];
      return relative === "" || !excludedTopLevel.has(topLevel);
    }
  });
  copied.push({ name: packageName, version: source.manifest.version });
}

await writeFile(
  path.join(desktopRoot, "dist", "main", "sharp-runtime.json"),
  `${JSON.stringify(
    {
      platform: process.platform,
      arch: process.arch,
      packages: copied
    },
    null,
    2
  )}\n`,
  "utf8"
);
