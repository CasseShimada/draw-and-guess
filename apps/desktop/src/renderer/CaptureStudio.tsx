import { useCallback, useEffect, useRef, useState } from "react";

import {
  CaptureLoop,
  DEFAULT_ENCODING_OPTIONS,
  DesktopMediaProvider,
  FULL_SOURCE_CROP,
  centeredAspectCrop,
  encodeAdaptiveFrame,
  hashFrameBytes,
  normalizeCrop,
  type CaptureSource,
  type CaptureStreamHandle,
  type EncodingOptions,
  type NormalizedCrop
} from "@draw-guess/capture-core";
import { PROTOCOL_VERSION } from "@draw-guess/protocol";
import type { PublicRoomSnapshot } from "@draw-guess/shared-types";

import type { DesktopSettings } from "../shared/ipc.js";
import { CropEditor } from "./CropEditor.js";

export interface CaptureSummary {
  ready: boolean;
  active: boolean;
  sourceName: string | null;
  error: string | null;
}

export interface CaptureStudioProps {
  open: boolean;
  settings: DesktopSettings;
  snapshot: PublicRoomSnapshot | null;
  onClose: () => void;
  onSettingsChange: (settings: DesktopSettings) => void;
  onSummary: (summary: CaptureSummary) => void;
}

function sourceFingerprint(source: CaptureSource): string {
  const identity = new TextEncoder().encode(`${source.type}\u0000${source.name}`);
  return `capture-${hashFrameBytes(identity)}`;
}

function encodingOptions(preset: DesktopSettings["qualityPreset"]): EncodingOptions {
  if (preset === "data-saver") {
    return {
      ...DEFAULT_ENCODING_OPTIONS,
      maxLongEdge: 960,
      webpQuality: 0.55,
      jpegFallbackQuality: 0.6,
      targetFrameBytes: 160 * 1024
    };
  }
  if (preset === "high") {
    return {
      ...DEFAULT_ENCODING_OPTIONS,
      maxLongEdge: 1600,
      webpQuality: 0.75,
      jpegFallbackQuality: 0.78,
      targetFrameBytes: 450 * 1024
    };
  }
  return DEFAULT_ENCODING_OPTIONS;
}

export function CaptureStudio({
  open,
  settings,
  snapshot,
  onClose,
  onSettingsChange,
  onSummary
}: CaptureStudioProps) {
  const [sources, setSources] = useState<CaptureSource[]>([]);
  const [selectedSource, setSelectedSource] = useState<CaptureSource | null>(null);
  const [crop, setCrop] = useState<NormalizedCrop>(FULL_SOURCE_CROP);
  const [dimensions, setDimensions] = useState({ width: 16, height: 9 });
  const [loadingSources, setLoadingSources] = useState(false);
  const [startingSource, setStartingSource] = useState(false);
  const [ready, setReady] = useState(false);
  const [active, setActive] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<CaptureStreamHandle | null>(null);
  const sourceRef = useRef<CaptureSource | null>(null);
  const cropRef = useRef(crop);
  const readyRef = useRef(false);
  const activeRef = useRef(false);
  const snapshotRef = useRef(snapshot);
  const qualityRef = useRef(settings.qualityPreset);
  const sourceEndedRef = useRef<() => void>(() => undefined);
  const providerRef = useRef<DesktopMediaProvider | null>(null);
  const loopRef = useRef<CaptureLoop | null>(null);

  if (!providerRef.current) {
    providerRef.current = new DesktopMediaProvider(window.drawGuessDesktop.capture);
  }
  if (!loopRef.current) {
    loopRef.current = new CaptureLoop({
      minimumIntervalMs: 1_000,
      capture: async () => {
        const video = videoRef.current;
        if (
          !readyRef.current ||
          !video ||
          video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA ||
          video.videoWidth < 1 ||
          video.videoHeight < 1
        ) {
          return null;
        }
        return encodeAdaptiveFrame(
          video,
          video.videoWidth,
          video.videoHeight,
          cropRef.current,
          encodingOptions(qualityRef.current)
        );
      },
      upload: async ({ captureSessionId, frame }) => {
        const result = await window.drawGuessDesktop.game.uploadFrame(
          captureSessionId,
          frame.bytes
        );
        if (!result.accepted && result.reason !== "网络拥塞，已跳过旧帧") {
          setError(result.reason ?? "图片上传被服务器拒绝");
        }
      },
      onError: (message) => setError(message)
    });
  }

  useEffect(() => {
    cropRef.current = crop;
  }, [crop]);
  useEffect(() => {
    snapshotRef.current = snapshot;
  }, [snapshot]);
  useEffect(() => {
    qualityRef.current = settings.qualityPreset;
  }, [settings.qualityPreset]);
  useEffect(() => {
    onSummary({
      ready,
      active,
      sourceName: selectedSource?.name ?? null,
      error
    });
  }, [active, error, onSummary, ready, selectedSource?.name]);

  const sendReady = useCallback(async (nextReady: boolean, reason?: string) => {
    await window.drawGuessDesktop.game.send({
      protocolVersion: PROTOCOL_VERSION,
      type: "capture:ready",
      ready: nextReady,
      ...(reason ? { reason } : {})
    });
  }, []);

  const stopAll = useCallback(
    (notifyServer: boolean, reason = "source-unavailable") => {
      const wasReady = readyRef.current;
      loopRef.current?.stop();
      providerRef.current?.stop();
      streamRef.current = null;
      sourceRef.current = null;
      readyRef.current = false;
      activeRef.current = false;
      setSelectedSource(null);
      setReady(false);
      setActive(false);
      const video = videoRef.current;
      if (video) {
        video.pause();
        video.srcObject = null;
      }
      void window.drawGuessDesktop.sharing.setState({
        active: false,
        sourceName: null,
        captureSessionId: null,
        endsAt: null
      });
      if (notifyServer && wasReady) {
        void sendReady(false, reason).catch(() => undefined);
      }
    },
    [sendReady]
  );

  sourceEndedRef.current = () => {
    setError("采集来源已关闭或系统停止了共享，请重新选择来源");
    stopAll(true, "source-unavailable");
  };

  const refreshSources = useCallback(async () => {
    setLoadingSources(true);
    setError(null);
    try {
      const next = await providerRef.current!.listSources();
      setSources(next);
      if (next.length === 0) {
        setError("没有发现可采集的窗口或屏幕，请检查系统屏幕录制权限");
      }
    } catch (refreshError) {
      setError(
        refreshError instanceof Error ? refreshError.message : "无法读取采集来源"
      );
    } finally {
      setLoadingSources(false);
    }
  }, []);

  useEffect(() => {
    if (open && sources.length === 0 && !loadingSources) {
      void refreshSources();
    }
  }, [loadingSources, open, refreshSources, sources.length]);

  const chooseSource = async (source: CaptureSource) => {
    if (source.isOwnApp) {
      setError("为避免无限镜像，画猜现场自己的窗口不能作为来源");
      return;
    }
    setStartingSource(true);
    setError(null);
    setNotice(null);
    stopAll(true, "source-changed");
    try {
      const handle = await providerRef.current!.start(source, {
        onEnded: () => sourceEndedRef.current()
      });
      streamRef.current = handle;
      sourceRef.current = source;
      setSelectedSource(source);
      const savedCrop = settings.cropPresets[sourceFingerprint(source)];
      const nextCrop = normalizeCrop(savedCrop ?? FULL_SOURCE_CROP);
      cropRef.current = nextCrop;
      setCrop(nextCrop);
      const video = videoRef.current;
      if (!video) {
        throw new Error("实时预览组件尚未就绪");
      }
      video.srcObject = handle.stream;
      void video.play().catch(() => undefined);
      setNotice(
        source.type === "screen"
          ? "整屏采集可能包含题目、聊天和桌面通知。请缩小裁切区域，并在回合开始后隐藏主窗口。"
          : "拖动边框只保留绘图画布；确认前不会上传任何画面。"
      );
    } catch (startError) {
      stopAll(false);
      setError(startError instanceof Error ? startError.message : "无法开始来源预览");
    } finally {
      setStartingSource(false);
    }
  };

  const confirmSource = async () => {
    const source = sourceRef.current;
    const video = videoRef.current;
    if (
      !source ||
      !streamRef.current ||
      !video ||
      video.videoWidth < 1 ||
      video.videoHeight < 1
    ) {
      setError("预览尚未就绪，请稍候再确认");
      return;
    }
    setError(null);
    readyRef.current = true;
    setReady(true);
    const fingerprint = sourceFingerprint(source);
    try {
      const nextSettings = await window.drawGuessDesktop.settings.update({
        cropPresets: {
          ...settings.cropPresets,
          [fingerprint]: cropRef.current
        }
      });
      onSettingsChange(nextSettings);
      await sendReady(true);
      setNotice("采集已准备。只有轮到你画时，应用才会每秒上传最新一帧。");
    } catch (confirmError) {
      const message =
        confirmError instanceof Error ? confirmError.message : "采集状态暂时无法同步";
      if (snapshotRef.current) {
        readyRef.current = false;
        setReady(false);
        setError(message);
      } else {
        setNotice("预览已确认；进入房间并连接后会自动同步采集状态。");
      }
    }
  };

  useEffect(() => {
    const unsubscribeGame = window.drawGuessDesktop.game.onEvent((event) => {
      if (event.kind === "connection") {
        if (event.state === "connected" && readyRef.current) {
          void sendReady(true).catch((syncError: unknown) => {
            setError(
              syncError instanceof Error ? syncError.message : "无法同步采集状态"
            );
          });
        } else if (event.state === "reconnecting" || event.state === "offline") {
          loopRef.current?.stop();
          activeRef.current = false;
          setActive(false);
          void window.drawGuessDesktop.sharing.setState({
            active: false,
            sourceName: sourceRef.current?.name ?? null,
            captureSessionId: null,
            endsAt: null
          });
        }
        return;
      }
      if (event.kind !== "message") {
        return;
      }
      if (event.message.type === "capture:start") {
        if (!readyRef.current || !streamRef.current || !sourceRef.current) {
          void sendReady(false, "source-unavailable").catch(() => undefined);
          return;
        }
        loopRef.current?.start(
          event.message.captureSessionId,
          event.message.intervalMs
        );
        activeRef.current = true;
        setActive(true);
        const drawing = snapshotRef.current?.game.selfDrawing;
        const endsAt =
          drawing?.status === "drawing"
            ? drawing.drawingEndsAt
            : drawing?.status === "finalizing"
              ? drawing.finalizationEndsAt
              : null;
        void window.drawGuessDesktop.sharing.setState({
          active: true,
          sourceName: sourceRef.current.name,
          captureSessionId: event.message.captureSessionId,
          endsAt
        });
        return;
      }
      if (event.message.type === "capture:stop-upload") {
        loopRef.current?.stop(event.message.captureSessionId);
        activeRef.current = false;
        setActive(false);
        void window.drawGuessDesktop.sharing.setState({
          active: false,
          sourceName: sourceRef.current?.name ?? null,
          captureSessionId: null,
          endsAt: null
        });
        return;
      }
      if (event.message.type === "capture:stop") {
        stopAll(false);
      }
    });
    const unsubscribeStop = window.drawGuessDesktop.sharing.onStopRequested(() => {
      setNotice("已立即停止共享。重新选择并确认来源后才能再次成为画手。");
      stopAll(true, "user-stopped");
    });
    return () => {
      unsubscribeGame();
      unsubscribeStop();
    };
  }, [sendReady, stopAll]);

  useEffect(() => {
    const drawing = snapshot?.game.selfDrawing;
    if (
      activeRef.current &&
      drawing &&
      drawing.status !== "finalized" &&
      loopRef.current?.activeCaptureSessionId === drawing.captureSessionId
    ) {
      void window.drawGuessDesktop.sharing.setState({
        active: true,
        sourceName: sourceRef.current?.name ?? null,
        captureSessionId: drawing.captureSessionId,
        endsAt:
          drawing.status === "drawing"
            ? drawing.drawingEndsAt
            : drawing.finalizationEndsAt
      });
    }
  }, [snapshot]);

  useEffect(
    () => () => {
      loopRef.current?.dispose();
      providerRef.current?.stop();
      void window.drawGuessDesktop.sharing.setState({
        active: false,
        sourceName: null,
        captureSessionId: null,
        endsAt: null
      });
    },
    []
  );

  const resetCrop = () => {
    const source = sourceRef.current;
    const saved = source ? settings.cropPresets[sourceFingerprint(source)] : undefined;
    setCrop(normalizeCrop(saved ?? FULL_SOURCE_CROP));
  };

  return (
    <section
      aria-hidden={!open}
      aria-label="采集工作室"
      className={`desktop-panel capture-studio ${open ? "desktop-panel--open" : ""}`}
      data-ui="sharing-safety"
    >
      <header className="desktop-panel__heading">
        <div>
          <p className="eyebrow">Capture studio</p>
          <h2>外部画布采集</h2>
        </div>
        <button aria-label="关闭采集工作室" onClick={onClose} type="button">
          ×
        </button>
      </header>

      <div className="capture-studio__body">
        <aside className="source-browser">
          <div className="source-browser__heading">
            <strong>窗口与屏幕</strong>
            <button
              disabled={loadingSources}
              onClick={() => void refreshSources()}
              type="button"
            >
              {loadingSources ? "刷新中…" : "刷新"}
            </button>
          </div>
          <div className="source-list">
            {sources.map((source) => (
              <button
                className={`source-card ${
                  selectedSource?.id === source.id ? "source-card--selected" : ""
                }`}
                disabled={source.isOwnApp || startingSource}
                key={source.id}
                onClick={() => void chooseSource(source)}
                type="button"
              >
                <img alt="" src={source.thumbnailDataUrl} />
                <span>
                  {source.appIconDataUrl && <img alt="" src={source.appIconDataUrl} />}
                  <strong>{source.name}</strong>
                  <small>
                    {source.isOwnApp
                      ? "本应用 · 已禁用"
                      : source.type === "screen"
                        ? "整个屏幕 · 注意隐私"
                        : "应用窗口"}
                  </small>
                </span>
              </button>
            ))}
          </div>
        </aside>

        <div className="preview-workbench">
          <div className="preview-workbench__status">
            <span
              className={`sharing-badge ${
                active ? "sharing-badge--live" : ready ? "sharing-badge--ready" : ""
              }`}
            >
              {active ? "正在上传 · 1 FPS" : ready ? "采集已准备" : "尚未准备"}
            </span>
            <span>{selectedSource?.name ?? "先选择外部绘图窗口"}</span>
          </div>
          <div
            className="capture-preview"
            style={{
              aspectRatio: `${String(dimensions.width)} / ${String(dimensions.height)}`
            }}
          >
            <video
              autoPlay
              muted
              onLoadedMetadata={(event) => {
                const video = event.currentTarget;
                setDimensions({
                  width: video.videoWidth || 16,
                  height: video.videoHeight || 9
                });
              }}
              playsInline
              ref={videoRef}
            />
            {selectedSource ? (
              <CropEditor crop={crop} disabled={active} onChange={setCrop} />
            ) : (
              <div className="capture-preview__empty">
                <span>▣</span>
                <strong>这里会显示实时预览</strong>
                <p>本应用不提供画板；请选择 Photoshop、CSP、Krita 或其它窗口。</p>
              </div>
            )}
          </div>

          <div className="crop-toolbar">
            <button
              disabled={!selectedSource || active}
              onClick={resetCrop}
              type="button"
            >
              恢复预设
            </button>
            <button
              disabled={!selectedSource || active}
              onClick={() => setCrop({ ...FULL_SOURCE_CROP })}
              type="button"
            >
              适配窗口
            </button>
            <button
              disabled={!selectedSource || active}
              onClick={() =>
                setCrop(centeredAspectCrop(dimensions.width, dimensions.height))
              }
              type="button"
            >
              居中 16:9
            </button>
            <span>
              {Math.round(crop.width * 100)}% × {Math.round(crop.height * 100)}%
            </span>
          </div>

          {notice && <p className="capture-notice">{notice}</p>}
          {error && <p className="capture-error">{error}</p>}
          <div className="capture-actions">
            {(ready || selectedSource) && (
              <button
                className="secondary-button"
                onClick={() => stopAll(true, "user-stopped")}
                type="button"
              >
                立即停止并释放来源
              </button>
            )}
            <button
              className="primary-button"
              disabled={!selectedSource || ready || startingSource}
              onClick={() => void confirmSource()}
              type="button"
            >
              {ready ? "已确认，可以成为画手" : "确认裁切与来源"}
            </button>
          </div>
        </div>
      </div>
    </section>
  );
}
