import { spawn } from "node:child_process";
import { mkdtemp, readFile, readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { PROTOCOL_VERSION } from "@draw-guess/protocol";

const desktopRoot = path.resolve(import.meta.dirname, "..");
const outRoot = path.join(desktopRoot, "out");
const packageName = (await readdir(outRoot)).find((entry) =>
  entry.endsWith(`-${process.platform}-${process.arch}`)
);
if (!packageName) {
  throw new Error("没有找到当前平台的已打包应用目录");
}
const packageRoot = path.join(outRoot, packageName);
const executable =
  process.platform === "win32"
    ? path.join(packageRoot, "draw-guess.exe")
    : process.platform === "darwin"
      ? path.join(packageRoot, "画猜现场.app", "Contents", "MacOS", "draw-guess")
      : path.join(packageRoot, "draw-guess");
const smokeRoot = await mkdtemp(path.join(os.tmpdir(), "draw-guess-smoke-"));
const resultPath = path.join(smokeRoot, "result.json");
const launchArgs =
  process.platform === "linux" && process.env.CI ? ["--no-sandbox"] : [];
let childOutput = "";
const appendChildOutput = (chunk) => {
  childOutput = `${childOutput}${chunk.toString("utf8")}`.slice(-16_384);
};
const child = spawn(executable, launchArgs, {
  env: {
    ...process.env,
    DRAW_GUESS_USER_DATA: path.join(smokeRoot, "user-data"),
    DRAW_GUESS_SMOKE_RESULT: resultPath
  },
  stdio: ["ignore", "pipe", "pipe"],
  windowsHide: true
});
child.stdout.on("data", appendChildOutput);
child.stderr.on("data", appendChildOutput);

const exitCode = await new Promise((resolve, reject) => {
  const timeout = setTimeout(() => {
    child.kill("SIGKILL");
    reject(new Error("打包应用冒烟测试超时"));
  }, 45_000);
  child.once("error", (error) => {
    clearTimeout(timeout);
    reject(error);
  });
  child.once("exit", (code) => {
    clearTimeout(timeout);
    resolve(code);
  });
});
let result;
try {
  result = JSON.parse(await readFile(resultPath, "utf8"));
} catch (error) {
  const diagnostic = childOutput.trim() || "应用未输出诊断";
  throw new Error(
    `打包应用在写入冒烟结果前退出（exit=${String(exitCode)}）：${diagnostic}`,
    { cause: error }
  );
}
if (
  exitCode !== 0 ||
  result.ok !== true ||
  result.protocolVersion !== PROTOCOL_VERSION
) {
  throw new Error(`打包应用冒烟测试失败：${JSON.stringify(result)}`);
}
process.stdout.write(
  `${JSON.stringify({ ...result, executable, smokeRoot }, null, 2)}\n`
);
