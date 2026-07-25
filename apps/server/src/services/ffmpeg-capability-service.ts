import { spawn } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { access, mkdir, statfs } from "node:fs/promises";

import type { ReplayHostCapability } from "@draw-guess/shared-types";

export interface ProcessRunResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export interface ProcessRunner {
  run(
    executable: string,
    args: readonly string[],
    options: { timeoutMs: number; maxOutputBytes: number }
  ): Promise<ProcessRunResult>;
}

export class NodeProcessRunner implements ProcessRunner {
  run(
    executable: string,
    args: readonly string[],
    options: { timeoutMs: number; maxOutputBytes: number }
  ): Promise<ProcessRunResult> {
    return new Promise((resolve, reject) => {
      const child = spawn(executable, [...args], {
        shell: false,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"]
      });
      let stdout: Buffer<ArrayBufferLike> = Buffer.alloc(0);
      let stderr: Buffer<ArrayBufferLike> = Buffer.alloc(0);
      let timedOut = false;
      const append = (
        current: Buffer<ArrayBufferLike>,
        chunk: Buffer<ArrayBufferLike>
      ): Buffer<ArrayBufferLike> => {
        if (current.byteLength >= options.maxOutputBytes) {
          return current;
        }
        return Buffer.concat([
          current,
          chunk.subarray(0, options.maxOutputBytes - current.byteLength)
        ]);
      };
      child.stdout.on("data", (chunk: Buffer) => {
        stdout = append(stdout, chunk);
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderr = append(stderr, chunk);
      });
      const timeout = setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
      }, options.timeoutMs);
      timeout.unref();
      child.once("error", (error) => {
        clearTimeout(timeout);
        reject(error);
      });
      child.once("close", (exitCode) => {
        clearTimeout(timeout);
        resolve({
          exitCode,
          stdout: stdout.toString("utf8"),
          stderr: stderr.toString("utf8"),
          timedOut
        });
      });
    });
  }
}

export interface ReplayHostConfig {
  configuredExecutable?: string | null;
  outputDirectory?: string | null;
  temporaryDirectory?: string | null;
  maxJobBytes?: number;
  maxTotalTemporaryBytes?: number;
  minimumFreeBytes?: number;
}

interface AvailableProbe {
  capability: Extract<ReplayHostCapability, { available: true }>;
  executable: string;
}

export class FfmpegCapabilityService {
  readonly #runner: ProcessRunner;
  #config: ReplayHostConfig;
  #available: AvailableProbe | null = null;
  #capability: ReplayHostCapability = {
    available: false,
    reasonCode: "not-configured",
    message: "独立服务器未配置主机回放目录与 FFmpeg"
  };

  constructor(
    config: ReplayHostConfig = {},
    runner: ProcessRunner = new NodeProcessRunner()
  ) {
    this.#config = { ...config };
    this.#runner = runner;
  }

  get capability(): ReplayHostCapability {
    return structuredClone(this.#capability);
  }

  get executable(): string | null {
    return this.#available?.executable ?? null;
  }

  get config(): ReplayHostConfig {
    return { ...this.#config };
  }

  configure(config: ReplayHostConfig): void {
    this.#config = { ...config };
    this.#available = null;
    this.#capability = {
      available: false,
      reasonCode: "not-configured",
      message: "主机回放配置已更改，需要重新探测 FFmpeg"
    };
  }

  async probe(): Promise<ReplayHostCapability> {
    const outputDirectory = this.#config.outputDirectory;
    const temporaryDirectory = this.#config.temporaryDirectory;
    if (!outputDirectory || !temporaryDirectory) {
      return this.#setUnavailable(
        "not-configured",
        "未配置主机回放保存目录，绘画接龙暂不可用"
      );
    }
    try {
      await Promise.all([
        mkdir(outputDirectory, { recursive: true, mode: 0o700 }),
        mkdir(temporaryDirectory, { recursive: true, mode: 0o700 })
      ]);
      await Promise.all([
        access(outputDirectory, fsConstants.W_OK),
        access(temporaryDirectory, fsConstants.W_OK)
      ]);
    } catch {
      return this.#setUnavailable(
        "output-not-writable",
        "主机回放目录不可写，请在高级设置中重新选择"
      );
    }

    const minimumFreeBytes = this.#config.minimumFreeBytes ?? 2 * 1024 ** 3;
    try {
      const diskStats = await Promise.all(
        [...new Set([outputDirectory, temporaryDirectory])].map((directory) =>
          statfs(directory)
        )
      );
      if (diskStats.some((info) => info.bavail * info.bsize < minimumFreeBytes)) {
        const minimumFreeGiB = (minimumFreeBytes / 1024 ** 3).toLocaleString("zh-CN", {
          maximumFractionDigits: 2
        });
        return this.#setUnavailable(
          "insufficient-space",
          `主机磁盘可用空间不足，至少需要保留 ${minimumFreeGiB} GiB`
        );
      }
    } catch {
      return this.#setUnavailable(
        "output-not-writable",
        "无法确认主机回放目录的磁盘空间"
      );
    }

    const configured = this.#config.configuredExecutable?.trim();
    const executable = configured || "ffmpeg";
    let versionResult: ProcessRunResult;
    try {
      versionResult = await this.#runner.run(executable, ["-hide_banner", "-version"], {
        timeoutMs: 5_000,
        maxOutputBytes: 64 * 1024
      });
    } catch {
      return this.#setUnavailable(
        configured ? "not-executable" : "not-found",
        configured ? "所选 FFmpeg 无法执行，请重新选择" : "未在系统 PATH 中找到 FFmpeg"
      );
    }
    if (versionResult.timedOut || versionResult.exitCode !== 0) {
      return this.#setUnavailable("probe-failed", "FFmpeg 能力探测失败或超时");
    }
    const firstLine = `${versionResult.stdout}\n${versionResult.stderr}`
      .split(/\r?\n/u)
      .find((line) => line.toLowerCase().startsWith("ffmpeg version "));
    if (!firstLine) {
      return this.#setUnavailable("probe-failed", "FFmpeg 版本输出无法识别");
    }
    const safeVersion =
      firstLine.match(/^ffmpeg version\s+([^\s]+)/iu)?.[1]?.slice(0, 80) ?? "unknown";

    let encoders: ProcessRunResult;
    try {
      encoders = await this.#runner.run(executable, ["-hide_banner", "-encoders"], {
        timeoutMs: 5_000,
        maxOutputBytes: 2 * 1024 * 1024
      });
    } catch {
      return this.#setUnavailable("probe-failed", "无法读取 FFmpeg 编码器列表");
    }
    if (encoders.timedOut || encoders.exitCode !== 0) {
      return this.#setUnavailable("probe-failed", "FFmpeg 编码器探测失败");
    }
    const encoderOutput = `${encoders.stdout}\n${encoders.stderr}`;
    const encoder = /\blibx264\b/u.test(encoderOutput)
      ? "libx264"
      : /\bmpeg4\b/u.test(encoderOutput)
        ? "mpeg4"
        : null;
    if (!encoder) {
      return this.#setUnavailable(
        "no-supported-encoder",
        "FFmpeg 没有可用的 libx264 或 mpeg4 编码器"
      );
    }
    const capability: Extract<ReplayHostCapability, { available: true }> = {
      available: true,
      ffmpegVersion: safeVersion,
      executableSource: configured ? "configured" : "path",
      encoder
    };
    this.#available = { capability, executable };
    this.#capability = capability;
    return this.capability;
  }

  async revalidate(): Promise<ReplayHostCapability> {
    return this.probe();
  }

  async runEncoder(
    args: readonly string[],
    timeoutMs: number
  ): Promise<ProcessRunResult> {
    const executable = this.#available?.executable;
    if (!executable) {
      throw new Error("FFmpeg capability 当前不可用");
    }
    return this.#runner.run(executable, args, {
      timeoutMs,
      maxOutputBytes: 2 * 1024 * 1024
    });
  }

  #setUnavailable(
    reasonCode: Extract<ReplayHostCapability, { available: false }>["reasonCode"],
    message: string
  ): ReplayHostCapability {
    this.#available = null;
    this.#capability = { available: false, reasonCode, message };
    return this.capability;
  }
}
