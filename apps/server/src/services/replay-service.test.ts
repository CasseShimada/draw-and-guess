import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { AcceptedFrame } from "./frame-store.js";
import {
  FfmpegCapabilityService,
  type ProcessRunResult,
  type ProcessRunner,
  type ReplayHostConfig
} from "./ffmpeg-capability-service.js";
import { ReplayService } from "./replay-service.js";

const JPEG_A = Uint8Array.from([0xff, 0xd8, 0x11, 0xff, 0xd9]);
const JPEG_B = Uint8Array.from([0xff, 0xd8, 0x22, 0xff, 0xd9]);
const temporaryDirectories: string[] = [];

interface RunnerCall {
  executable: string;
  args: readonly string[];
  options: { timeoutMs: number; maxOutputBytes: number };
}

class FakeProcessRunner implements ProcessRunner {
  readonly calls: RunnerCall[] = [];
  version = "ffmpeg version 7.1.2-test Copyright fake";
  encoders = " V..... libx264 H.264\n V.S... mpeg4 MPEG-4";
  throwOnVersion = false;
  timeOutVersion = false;
  encodeFailures = 0;

  async run(
    executable: string,
    args: readonly string[],
    options: { timeoutMs: number; maxOutputBytes: number }
  ): Promise<ProcessRunResult> {
    this.calls.push({ executable, args: [...args], options: { ...options } });
    if (args.includes("-version")) {
      if (this.throwOnVersion) {
        throw new Error("ENOENT");
      }
      return {
        exitCode: this.timeOutVersion ? null : 0,
        stdout: this.version,
        stderr: "",
        timedOut: this.timeOutVersion
      };
    }
    if (args.includes("-encoders")) {
      return {
        exitCode: 0,
        stdout: this.encoders,
        stderr: "",
        timedOut: false
      };
    }
    if (this.encodeFailures > 0) {
      this.encodeFailures -= 1;
      const output = args.at(-1);
      if (output) {
        await writeFile(output, "partial-failure");
      }
      return {
        exitCode: 1,
        stdout: "",
        stderr: "fake encode failure",
        timedOut: false
      };
    }
    const output = args.at(-1);
    if (!output) {
      throw new Error("missing fake output");
    }
    await writeFile(output, Buffer.from("fake-mp4-output"));
    return { exitCode: 0, stdout: "", stderr: "", timedOut: false };
  }
}

async function fixture(overrides: Partial<ReplayHostConfig> = {}): Promise<{
  root: string;
  outputDirectory: string;
  temporaryDirectory: string;
  config: ReplayHostConfig;
}> {
  const root = await mkdtemp(path.join(tmpdir(), "draw-guess-replay-"));
  temporaryDirectories.push(root);
  const outputDirectory = path.join(root, "output");
  const temporaryDirectory = path.join(root, "temporary");
  return {
    root,
    outputDirectory,
    temporaryDirectory,
    config: {
      configuredExecutable: path.join(root, "FFmpeg custom name.exe"),
      outputDirectory,
      temporaryDirectory,
      minimumFreeBytes: 0,
      maxJobBytes: 1_000,
      maxTotalTemporaryBytes: 1_500,
      ...overrides
    }
  };
}

function acceptedFrame(
  sequence: number,
  bytes: Uint8Array,
  capturedAt = sequence * 800
): AcceptedFrame {
  return {
    playerId: "player-a",
    captureSessionId: 9,
    sequence,
    mimeType: "image/jpeg",
    bytes,
    capturedAt,
    revision: String(sequence).padStart(64, "0")
  };
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

describe("FFmpeg capability probing", () => {
  it("prefers a configured executable, redacts its path, and selects libx264", async () => {
    const test = await fixture();
    const runner = new FakeProcessRunner();
    const capability = new FfmpegCapabilityService(test.config, runner);
    await expect(capability.probe()).resolves.toEqual({
      available: true,
      ffmpegVersion: "7.1.2-test",
      executableSource: "configured",
      encoder: "libx264"
    });
    expect(runner.calls.map((call) => call.executable)).toEqual([
      test.config.configuredExecutable,
      test.config.configuredExecutable
    ]);
    expect(JSON.stringify(capability.capability)).not.toContain(test.root);
  });

  it("falls back to PATH and allowlisted mpeg4, with typed failure reasons", async () => {
    const pathFixture = await fixture({ configuredExecutable: null });
    const mpeg4Runner = new FakeProcessRunner();
    mpeg4Runner.encoders = " V.S... mpeg4 MPEG-4";
    const pathCapability = new FfmpegCapabilityService(pathFixture.config, mpeg4Runner);
    await expect(pathCapability.probe()).resolves.toMatchObject({
      available: true,
      executableSource: "path",
      encoder: "mpeg4"
    });
    expect(mpeg4Runner.calls[0]?.executable).toBe("ffmpeg");

    const noEncoderRunner = new FakeProcessRunner();
    noEncoderRunner.encoders = " A..... aac AAC";
    await expect(
      new FfmpegCapabilityService(pathFixture.config, noEncoderRunner).probe()
    ).resolves.toMatchObject({
      available: false,
      reasonCode: "no-supported-encoder"
    });

    const missingRunner = new FakeProcessRunner();
    missingRunner.throwOnVersion = true;
    await expect(
      new FfmpegCapabilityService(pathFixture.config, missingRunner).probe()
    ).resolves.toMatchObject({
      available: false,
      reasonCode: "not-found"
    });

    const timeoutRunner = new FakeProcessRunner();
    timeoutRunner.timeOutVersion = true;
    await expect(
      new FfmpegCapabilityService(pathFixture.config, timeoutRunner).probe()
    ).resolves.toMatchObject({
      available: false,
      reasonCode: "probe-failed"
    });
  });

  it("rejects missing directories and insufficient reserved disk space", async () => {
    const runner = new FakeProcessRunner();
    await expect(
      new FfmpegCapabilityService({}, runner).probe()
    ).resolves.toMatchObject({
      available: false,
      reasonCode: "not-configured"
    });
    const test = await fixture({ minimumFreeBytes: Number.MAX_SAFE_INTEGER });
    await expect(
      new FfmpegCapabilityService(test.config, runner).probe()
    ).resolves.toMatchObject({
      available: false,
      reasonCode: "insufficient-space"
    });
    expect(runner.calls).toHaveLength(0);
  });
});

describe("replay recording and encoding", () => {
  it("reserves quotas, records a monotonic timeline, saves atomically, and recovers metadata", async () => {
    const test = await fixture();
    const runner = new FakeProcessRunner();
    const capability = new FfmpegCapabilityService(test.config, runner);
    const replay = new ReplayService(test.config, capability);
    await replay.initialize();
    const jobId = await replay.startJob(800);
    await expect(replay.startJob(800)).rejects.toThrow("临时配额");

    replay.addEvent(jobId, {
      kind: "starting-word",
      text: "起始词：<猫>; $(not-an-argument)"
    });
    expect(
      replay.recordFrame(
        jobId,
        "step-a",
        "player-a",
        acceptedFrame(1, JPEG_A),
        0,
        "drawing"
      )
    ).toBe(true);
    expect(
      replay.recordFrame(
        jobId,
        "step-a",
        "player-a",
        acceptedFrame(1, JPEG_A),
        10,
        "drawing"
      )
    ).toBe(false);
    expect(
      replay.recordFrame(
        jobId,
        "step-a",
        "player-a",
        acceptedFrame(2, JPEG_B),
        800,
        "finalizing"
      )
    ).toBe(true);
    replay.addEvent(jobId, { kind: "guess", text: "猜词：蓝猫" });
    replay.addEvent(jobId, {
      kind: "final-comparison",
      text: "起始词：猫 · 最终猜词：蓝猫"
    });

    const saved = await replay.finalize(jobId, true);
    expect(saved.byteLength).toBeGreaterThan(0);
    expect(path.dirname(saved.path)).toBe(path.resolve(test.outputDirectory));
    expect((await stat(saved.path)).isFile()).toBe(true);
    expect(replay.savedFile(jobId)).toEqual(saved);
    expect(replay.status(jobId)).toEqual({
      status: "saved",
      byteLength: saved.byteLength
    });

    const encodeCall = runner.calls.find(
      (call) => !call.args.includes("-version") && !call.args.includes("-encoders")
    );
    expect(encodeCall).toBeDefined();
    expect(encodeCall?.args).toEqual(
      expect.arrayContaining([
        "-nostdin",
        "-safe",
        "1",
        "-c:v",
        "libx264",
        "-an",
        "+faststart"
      ])
    );
    expect(encodeCall?.args.join("\n")).not.toContain("not-an-argument");
    expect(encodeCall?.args.at(-1)).toMatch(/\.partial\.mp4$/u);
    expect(encodeCall?.options.timeoutMs).toBe(30 * 60_000);

    const jobRoot = path.join(test.temporaryDirectory, jobId);
    expect(await readdir(jobRoot)).toEqual(["manifest.json"]);
    const manifest = JSON.parse(
      await readFile(path.join(jobRoot, "manifest.json"), "utf8")
    ) as {
      incomplete: boolean;
      state: string;
      droppedFrames: number;
      timeline: Array<{ kind: string }>;
    };
    expect(manifest).toMatchObject({
      incomplete: true,
      state: "saved",
      droppedFrames: 1
    });
    expect(manifest.timeline.map((item) => item.kind)).toEqual([
      "event",
      "segment",
      "event",
      "event"
    ]);
    expect(
      (await readdir(test.outputDirectory)).some((name) =>
        name.endsWith(".partial.mp4")
      )
    ).toBe(false);

    const restarted = new ReplayService(
      test.config,
      new FfmpegCapabilityService(test.config, runner)
    );
    await restarted.initialize();
    expect(restarted.savedFile(jobId)).toEqual(saved);
    await restarted.discard(jobId);
    expect((await stat(saved.path)).isFile()).toBe(true);
    await replay.shutdown();
    await restarted.shutdown();
  }, 30_000);

  it("retains a failed job, removes partial output, and retries successfully", async () => {
    const test = await fixture();
    const runner = new FakeProcessRunner();
    runner.encodeFailures = 1;
    const replay = new ReplayService(
      test.config,
      new FfmpegCapabilityService(test.config, runner)
    );
    await replay.initialize();
    const jobId = await replay.startJob(100);
    replay.addEvent(jobId, { kind: "pass", text: "本步骤 Pass" });
    await expect(replay.finalize(jobId)).rejects.toThrow("压制失败");
    expect(replay.status(jobId)).toMatchObject({
      status: "failed",
      canRetry: true
    });
    expect(
      (await readdir(test.outputDirectory)).some((name) =>
        name.endsWith(".partial.mp4")
      )
    ).toBe(false);

    const saved = await replay.retry(jobId);
    expect(saved.byteLength).toBeGreaterThan(0);
    expect(await readdir(path.join(test.temporaryDirectory, jobId))).toEqual([
      "manifest.json"
    ]);
    await replay.shutdown();
  });

  it("refuses a replay job directory replaced by a junction", async () => {
    const test = await fixture();
    const runner = new FakeProcessRunner();
    const replay = new ReplayService(
      test.config,
      new FfmpegCapabilityService(test.config, runner)
    );
    await replay.initialize();
    const jobId = await replay.startJob(100);
    const jobRoot = path.join(test.temporaryDirectory, jobId);
    const outside = path.join(test.root, "outside");
    await mkdir(outside);
    await writeFile(path.join(test.root, "outside-marker"), "safe");
    await rm(jobRoot, { recursive: true, force: true });
    await symlink(outside, jobRoot, "junction");
    replay.addEvent(jobId, { kind: "timeout", text: "本步骤超时" });
    await expect(replay.finalize(jobId)).rejects.toThrow("受保护目录");
    expect(await readFile(path.join(test.root, "outside-marker"), "utf8")).toBe("safe");
    expect(
      runner.calls.some(
        (call) => !call.args.includes("-version") && !call.args.includes("-encoders")
      )
    ).toBe(false);
    await replay.shutdown();
  });
});
