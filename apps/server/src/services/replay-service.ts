import { randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import {
  access,
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  writeFile
} from "node:fs/promises";
import path from "node:path";

import type { PublicReplayStatus } from "@draw-guess/shared-types";
import sharp from "sharp";

import type { AcceptedFrame } from "./frame-store.js";
import {
  FfmpegCapabilityService,
  type ReplayHostConfig
} from "./ffmpeg-capability-service.js";

interface ReplayFrameRecord {
  file: string;
  sequence: number;
  activeAtMs: number;
  stage: "drawing" | "finalizing";
}

interface ReplaySegment {
  stepId: string;
  playerId: string;
  frames: ReplayFrameRecord[];
}

interface ReplayEvent {
  kind: "starting-word" | "guess" | "pass" | "timeout" | "final-comparison";
  text: string;
}

type ReplayTimelineItem =
  { kind: "event"; index: number } | { kind: "segment"; stepId: string };

interface ReplayManifest {
  schemaVersion: 1;
  jobId: string;
  createdAt: string;
  incomplete: boolean;
  state: "recording" | "encoding" | "failed" | "saved";
  segments: ReplaySegment[];
  events: ReplayEvent[];
  timeline: ReplayTimelineItem[];
  droppedFrames: number;
  outputFileName: string | null;
  error: string | null;
}

interface ReplayJob {
  root: string;
  manifest: ReplayManifest;
  bytes: number;
  frameBytes: number;
  reservedBytes: number;
  writeChain: Promise<void>;
  queuedWrites: number;
  localOutputPath: string | null;
}

export interface ReplaySavedFile {
  path: string;
  byteLength: number;
}

export class ReplayService {
  readonly capabilityService: FfmpegCapabilityService;
  readonly #jobs = new Map<string, ReplayJob>();
  #config: ReplayHostConfig;
  readonly #maxQueuedWrites = 4;

  constructor(
    config: ReplayHostConfig = {},
    capabilityService = new FfmpegCapabilityService(config)
  ) {
    this.#config = { ...config };
    this.capabilityService = capabilityService;
  }

  async initialize(): Promise<void> {
    await this.capabilityService.probe();
    await this.#scanRecoverableJobs();
  }

  configure(config: ReplayHostConfig): void {
    this.#config = { ...config };
    this.capabilityService.configure(config);
  }

  async startJob(estimatedBytes = 0): Promise<string> {
    const capability = await this.capabilityService.revalidate();
    if (!capability.available) {
      throw new Error(capability.message);
    }
    const temporaryRoot = this.#requiredDirectory("temporaryDirectory");
    const outputRoot = this.#requiredDirectory("outputDirectory");
    await Promise.all([
      mkdir(temporaryRoot, { recursive: true, mode: 0o700 }),
      mkdir(outputRoot, { recursive: true, mode: 0o700 }),
      access(temporaryRoot, fsConstants.W_OK),
      access(outputRoot, fsConstants.W_OK)
    ]);
    const maxJobBytes = this.#config.maxJobBytes ?? 4 * 1024 ** 3;
    const maxTotalBytes = this.#config.maxTotalTemporaryBytes ?? 10 * 1024 ** 3;
    const currentTemporaryBytes = [...this.#jobs.values()].reduce(
      (total, job) => total + Math.max(job.frameBytes, job.reservedBytes),
      0
    );
    if (
      !Number.isFinite(estimatedBytes) ||
      estimatedBytes < 0 ||
      estimatedBytes > maxJobBytes ||
      currentTemporaryBytes + estimatedBytes > maxTotalBytes
    ) {
      throw new Error("预计回放大小超过主机临时配额，请缩短绘画时间或清理未完成回放");
    }
    const jobId = randomUUID();
    const root = this.#contained(temporaryRoot, jobId);
    await mkdir(root, { recursive: false, mode: 0o700 });
    const manifest: ReplayManifest = {
      schemaVersion: 1,
      jobId,
      createdAt: new Date().toISOString(),
      incomplete: false,
      state: "recording",
      segments: [],
      events: [],
      timeline: [],
      droppedFrames: 0,
      outputFileName: null,
      error: null
    };
    const job: ReplayJob = {
      root,
      manifest,
      bytes: 0,
      frameBytes: 0,
      reservedBytes: estimatedBytes,
      writeChain: Promise.resolve(),
      queuedWrites: 0,
      localOutputPath: null
    };
    this.#jobs.set(jobId, job);
    await this.#writeManifest(job);
    return jobId;
  }

  addEvent(jobId: string, event: ReplayEvent): void {
    const job = this.#requireJob(jobId);
    job.manifest.events.push({ ...event });
    job.manifest.timeline.push({
      kind: "event",
      index: job.manifest.events.length - 1
    });
    this.#queueManifest(job);
  }

  recordFrame(
    jobId: string,
    stepId: string,
    playerId: string,
    frame: AcceptedFrame,
    activeAtMs: number,
    stage: "drawing" | "finalizing"
  ): boolean {
    const job = this.#requireJob(jobId);
    if (job.manifest.state !== "recording") {
      return false;
    }
    if (job.queuedWrites >= this.#maxQueuedWrites) {
      job.manifest.droppedFrames += 1;
      return false;
    }
    const maxJobBytes = this.#config.maxJobBytes ?? 4 * 1024 ** 3;
    const maxTotalBytes = this.#config.maxTotalTemporaryBytes ?? 10 * 1024 ** 3;
    let segment = job.manifest.segments.find(
      (candidate) => candidate.stepId === stepId
    );
    const lastSequence = segment?.frames.at(-1)?.sequence ?? 0;
    if (frame.sequence <= lastSequence) {
      job.manifest.droppedFrames += 1;
      return false;
    }
    const projectedJobBytes = job.frameBytes + frame.bytes.byteLength;
    const totalAllocatedBytes = [...this.#jobs.values()].reduce(
      (total, candidate) =>
        total +
        (candidate === job
          ? Math.max(candidate.reservedBytes, projectedJobBytes)
          : Math.max(candidate.reservedBytes, candidate.frameBytes)),
      0
    );
    if (projectedJobBytes > maxJobBytes || totalAllocatedBytes > maxTotalBytes) {
      job.manifest.droppedFrames += 1;
      return false;
    }
    if (!segment) {
      segment = { stepId, playerId, frames: [] };
      job.manifest.segments.push(segment);
      job.manifest.timeline.push({ kind: "segment", stepId });
    }
    const extension = frame.mimeType === "image/jpeg" ? "jpg" : "webp";
    const file = `frame-${String(job.manifest.segments.indexOf(segment)).padStart(
      3,
      "0"
    )}-${String(frame.sequence).padStart(10, "0")}.${extension}`;
    const target = this.#contained(job.root, file);
    segment.frames.push({
      file,
      sequence: frame.sequence,
      activeAtMs,
      stage
    });
    job.bytes += frame.bytes.byteLength;
    job.frameBytes += frame.bytes.byteLength;
    job.queuedWrites += 1;
    const bytes = new Uint8Array(frame.bytes);
    job.writeChain = job.writeChain
      .then(async () => {
        await this.#assertJobRoot(job);
        await writeFile(target, bytes, { mode: 0o600, flag: "wx" });
        await this.#writeManifest(job);
      })
      .finally(() => {
        job.queuedWrites -= 1;
      });
    return true;
  }

  status(jobId: string | null): PublicReplayStatus {
    if (!jobId) {
      return { status: "idle" };
    }
    const job = this.#jobs.get(jobId);
    if (!job) {
      return { status: "failed", message: "回放任务不存在", canRetry: false };
    }
    switch (job.manifest.state) {
      case "recording":
        return { status: "recording" };
      case "encoding":
        return { status: "encoding", progress: null };
      case "saved":
        return { status: "saved", byteLength: job.bytes };
      case "failed":
        return {
          status: "failed",
          message: job.manifest.error ?? "回放压制失败",
          canRetry: true
        };
    }
  }

  async finalize(jobId: string, incomplete = false): Promise<ReplaySavedFile> {
    const job = this.#requireJob(jobId);
    try {
      await job.writeChain;
      await this.#assertJobRoot(job);
      job.reservedBytes = job.frameBytes;
      job.manifest.incomplete = incomplete;
      job.manifest.state = "encoding";
      job.manifest.error = null;
      await this.#writeManifest(job);
      const result = await this.#encode(job);
      job.manifest.state = "saved";
      job.manifest.outputFileName = path.basename(result.path);
      job.localOutputPath = result.path;
      job.bytes = result.byteLength;
      await this.#writeManifest(job);
      await this.#cleanupJobFrames(job);
      return result;
    } catch (error) {
      job.manifest.state = "failed";
      job.manifest.error =
        error instanceof Error ? error.message.slice(0, 300) : "回放压制失败";
      await this.#writeManifest(job).catch(() => undefined);
      throw error;
    }
  }

  retry(jobId: string): Promise<ReplaySavedFile> {
    const job = this.#requireJob(jobId);
    if (job.manifest.state !== "failed") {
      throw new Error("只有失败的回放任务可以重试");
    }
    return this.finalize(jobId, job.manifest.incomplete);
  }

  savedFile(jobId: string): ReplaySavedFile | null {
    const job = this.#jobs.get(jobId);
    if (!job?.localOutputPath || job.manifest.state !== "saved") {
      return null;
    }
    return { path: job.localOutputPath, byteLength: job.bytes };
  }

  async discard(jobId: string): Promise<void> {
    const job = this.#jobs.get(jobId);
    if (!job) {
      return;
    }
    await job.writeChain.catch(() => undefined);
    const temporaryRoot = this.#requiredDirectory("temporaryDirectory");
    const root = this.#contained(temporaryRoot, path.basename(job.root));
    if (root !== job.root) {
      throw new Error("回放 job 路径不在受保护目录中");
    }
    await this.#assertJobRoot(job);
    await rm(root, { recursive: true, force: true });
    this.#jobs.delete(jobId);
  }

  async shutdown(): Promise<void> {
    await Promise.allSettled(
      [...this.#jobs.values()].map(async (job) => {
        await Promise.race([
          job.writeChain,
          new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, 2_000);
            timer.unref();
          })
        ]);
        await this.#writeManifest(job).catch(() => undefined);
      })
    );
  }

  async #encode(job: ReplayJob): Promise<ReplaySavedFile> {
    const capability = await this.capabilityService.revalidate();
    if (!capability.available) {
      throw new Error(capability.message);
    }
    const concatLines: string[] = [];
    let cardIndex = 0;
    const timeline =
      job.manifest.timeline.length > 0
        ? job.manifest.timeline
        : [
            ...job.manifest.events.map((_event, index): ReplayTimelineItem => ({
              kind: "event",
              index
            })),
            ...job.manifest.segments.map((segment): ReplayTimelineItem => ({
              kind: "segment",
              stepId: segment.stepId
            }))
          ];
    for (const item of timeline) {
      if (item.kind === "event") {
        const event = job.manifest.events[item.index];
        if (!event) {
          continue;
        }
        const card = `card-${String(cardIndex).padStart(4, "0")}.png`;
        cardIndex += 1;
        await this.#renderCard(
          this.#contained(job.root, card),
          event.text,
          job.manifest.incomplete
        );
        concatLines.push(`file '${card}'`, "duration 2");
      } else {
        const segment = job.manifest.segments.find(
          (candidate) => candidate.stepId === item.stepId
        );
        if (!segment) {
          continue;
        }
        const frames = [...segment.frames].sort(
          (left, right) => left.sequence - right.sequence
        );
        for (const [index, frame] of frames.entries()) {
          const next = frames[index + 1];
          const duration = Math.min(
            2,
            Math.max(
              0.04,
              ((next?.activeAtMs ?? frame.activeAtMs + 1_000) - frame.activeAtMs) /
                1_000
            )
          );
          concatLines.push(`file '${frame.file}'`, `duration ${duration.toFixed(3)}`);
        }
      }
    }
    if (concatLines.length === 0) {
      const card = "card-empty.png";
      await this.#renderCard(
        this.#contained(job.root, card),
        "本局没有可录制画面",
        job.manifest.incomplete
      );
      concatLines.push(`file '${card}'`, "duration 2");
    }
    const concatPath = this.#contained(job.root, "concat.txt");
    await writeFile(concatPath, `${concatLines.join("\n")}\n`, {
      encoding: "utf8",
      mode: 0o600
    });
    const outputRoot = this.#requiredDirectory("outputDirectory");
    const stamp = new Date()
      .toISOString()
      .replace(/[-:]/gu, "")
      .replace(/\.\d{3}Z$/u, "")
      .replace("T", "-");
    const shortId = job.manifest.jobId.slice(0, 8);
    const fileName = `draw-relay-${stamp}-${shortId}.mp4`;
    const finalPath = this.#contained(outputRoot, fileName);
    const partialPath = this.#contained(outputRoot, `${fileName}.partial.mp4`);
    await this.#assertOutputCandidate(outputRoot, finalPath);
    await this.#assertOutputCandidate(outputRoot, partialPath);
    const encoderArgs =
      capability.encoder === "libx264"
        ? ["-c:v", "libx264", "-preset", "medium", "-crf", "23"]
        : ["-c:v", "mpeg4", "-q:v", "4"];
    let completed = false;
    try {
      const result = await this.capabilityService.runEncoder(
        [
          "-hide_banner",
          "-nostdin",
          "-y",
          "-f",
          "concat",
          "-safe",
          "1",
          "-i",
          concatPath,
          "-vf",
          "scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2:color=0x15171a,fps=30,format=yuv420p",
          ...encoderArgs,
          "-an",
          "-movflags",
          "+faststart",
          partialPath
        ],
        30 * 60_000
      );
      if (result.timedOut || result.exitCode !== 0) {
        throw new Error("FFmpeg 压制失败，请检查磁盘空间后重试");
      }
      const partial = await lstat(partialPath);
      if (partial.isSymbolicLink() || !partial.isFile() || partial.size < 1) {
        throw new Error("FFmpeg 未生成安全有效的 MP4");
      }
      const [outputRootReal, partialReal] = await Promise.all([
        realpath(outputRoot),
        realpath(partialPath)
      ]);
      if (
        partialReal === outputRootReal ||
        !partialReal.startsWith(`${outputRootReal}${path.sep}`)
      ) {
        throw new Error("FFmpeg 输出越过受保护目录");
      }
      await rename(partialPath, finalPath);
      completed = true;
      return { path: finalPath, byteLength: partial.size };
    } finally {
      if (!completed) {
        await rm(partialPath, { force: true }).catch(() => undefined);
      }
    }
  }

  async #renderCard(target: string, text: string, incomplete: boolean): Promise<void> {
    const escaped = text
      .slice(0, 160)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;");
    const subtitle = incomplete ? "回放不完整 · 本局中途结束" : "画猜现场 · 绘画接龙";
    const svg = Buffer.from(
      `<svg width="1280" height="720" xmlns="http://www.w3.org/2000/svg">` +
        `<rect width="1280" height="720" fill="#15171a"/>` +
        `<text x="640" y="330" text-anchor="middle" fill="#fff" ` +
        `font-family="sans-serif" font-size="58">${escaped}</text>` +
        `<text x="640" y="405" text-anchor="middle" fill="#f4c84b" ` +
        `font-family="sans-serif" font-size="26">${subtitle}</text></svg>`
    );
    await sharp(svg).png().toFile(target);
  }

  async #cleanupJobFrames(job: ReplayJob): Promise<void> {
    await this.#assertJobRoot(job);
    const entries = await readdir(job.root);
    await Promise.all(
      entries
        .filter((entry) => entry !== "manifest.json")
        .map((entry) => rm(this.#contained(job.root, entry), { force: true }))
    );
    job.frameBytes = 0;
    job.reservedBytes = 0;
  }

  #queueManifest(job: ReplayJob): void {
    job.writeChain = job.writeChain.then(() => this.#writeManifest(job));
  }

  async #writeManifest(job: ReplayJob): Promise<void> {
    await this.#assertJobRoot(job);
    const target = this.#contained(job.root, "manifest.json");
    const temporary = this.#contained(job.root, "manifest.tmp");
    await writeFile(temporary, `${JSON.stringify(job.manifest, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600
    });
    await rm(target, { force: true });
    await rename(temporary, target);
  }

  async #scanRecoverableJobs(): Promise<void> {
    const root = this.#config.temporaryDirectory;
    if (!root) {
      return;
    }
    await mkdir(root, { recursive: true, mode: 0o700 }).catch(() => undefined);
    const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (!entry.isDirectory() || !/^[a-f0-9-]{36}$/iu.test(entry.name)) {
        continue;
      }
      const jobRoot = this.#contained(root, entry.name);
      try {
        const parsed = JSON.parse(
          await readFile(this.#contained(jobRoot, "manifest.json"), "utf8")
        ) as ReplayManifest;
        if (parsed.schemaVersion !== 1 || parsed.jobId !== entry.name) {
          continue;
        }
        const localOutputPath =
          parsed.state === "saved" && parsed.outputFileName
            ? this.#contained(
                this.#requiredDirectory("outputDirectory"),
                parsed.outputFileName
              )
            : null;
        const outputBytes = localOutputPath
          ? await stat(localOutputPath)
              .then((value) => (value.isFile() ? value.size : 0))
              .catch(() => 0)
          : 0;
        const frameBytes =
          parsed.state === "saved"
            ? 0
            : await Promise.all(
                (await readdir(jobRoot, { withFileTypes: true })).map(async (file) =>
                  file.isFile() && /^frame-.+\.(?:jpg|webp)$/u.test(file.name)
                    ? await stat(this.#contained(jobRoot, file.name))
                        .then((value) => value.size)
                        .catch(() => 0)
                    : 0
                )
              ).then((sizes) => sizes.reduce((total, size) => total + size, 0));
        this.#jobs.set(parsed.jobId, {
          root: jobRoot,
          manifest: {
            ...parsed,
            timeline: Array.isArray(parsed.timeline) ? parsed.timeline : [],
            state: parsed.state === "saved" ? "saved" : "failed",
            error:
              parsed.state === "saved"
                ? parsed.error
                : (parsed.error ?? "应用上次退出时回放尚未完成")
          },
          bytes: outputBytes,
          frameBytes,
          reservedBytes: frameBytes,
          writeChain: Promise.resolve(),
          queuedWrites: 0,
          localOutputPath
        });
      } catch {
        // Invalid directories are left untouched for manual inspection.
      }
    }
  }

  #requiredDirectory(key: "outputDirectory" | "temporaryDirectory"): string {
    const value = this.#config[key];
    if (!value) {
      throw new Error("主机回放目录未配置");
    }
    return path.resolve(value);
  }

  #contained(rootInput: string, child: string): string {
    const root = path.resolve(rootInput);
    const target = path.resolve(root, child);
    if (target === root || !target.startsWith(`${root}${path.sep}`)) {
      throw new Error("回放路径越过受保护目录");
    }
    return target;
  }

  async #assertJobRoot(job: ReplayJob): Promise<void> {
    const temporaryRoot = this.#requiredDirectory("temporaryDirectory");
    const [temporaryRootReal, rootInfo, jobRootReal] = await Promise.all([
      realpath(temporaryRoot),
      lstat(job.root),
      realpath(job.root)
    ]);
    if (
      rootInfo.isSymbolicLink() ||
      !rootInfo.isDirectory() ||
      jobRootReal === temporaryRootReal ||
      !jobRootReal.startsWith(`${temporaryRootReal}${path.sep}`)
    ) {
      throw new Error("回放 job 路径越过受保护目录");
    }
  }

  async #assertOutputCandidate(root: string, target: string): Promise<void> {
    const [rootReal, parentReal] = await Promise.all([
      realpath(root),
      realpath(path.dirname(target))
    ]);
    if (parentReal !== rootReal) {
      throw new Error("回放输出路径越过受保护目录");
    }
    try {
      await lstat(target);
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        return;
      }
      throw error;
    }
    throw new Error("回放输出目标已存在，拒绝覆盖");
  }

  #requireJob(jobId: string): ReplayJob {
    const job = this.#jobs.get(jobId);
    if (!job) {
      throw new Error("回放任务不存在");
    }
    return job;
  }
}
