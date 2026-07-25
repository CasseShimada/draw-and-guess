import {
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type PointerEvent as ReactPointerEvent
} from "react";

import {
  CONTENT_LIMITS,
  LocalAvatarSchema,
  validateAvatarInputPng,
  validateNormalizedAvatarPng,
  type LocalAvatar,
  type LocalContentServices
} from "@draw-guess/content";

export interface AvatarCropPlacement {
  width: number;
  height: number;
  x: number;
  y: number;
}

export function avatarCropPlacement(
  sourceWidth: number,
  sourceHeight: number,
  zoom: number,
  offsetX: number,
  offsetY: number,
  outputSize: number = CONTENT_LIMITS.avatarDimension
): AvatarCropPlacement {
  const scale =
    Math.max(outputSize / sourceWidth, outputSize / sourceHeight) * Math.max(1, zoom);
  const width = sourceWidth * scale;
  const height = sourceHeight * scale;
  const horizontalTravel = Math.max(0, (width - outputSize) / 2);
  const verticalTravel = Math.max(0, (height - outputSize) / 2);
  return {
    width,
    height,
    x: (outputSize - width) / 2 + Math.max(-1, Math.min(1, offsetX)) * horizontalTravel,
    y: (outputSize - height) / 2 + Math.max(-1, Math.min(1, offsetY)) * verticalTravel
  };
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  const digest = await crypto.subtle.digest("SHA-256", buffer);
  return [...new Uint8Array(digest)]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
}

async function canvasPng(canvas: HTMLCanvasElement): Promise<Uint8Array> {
  const blob = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (value) => (value ? resolve(value) : reject(new Error("无法生成 PNG 头像"))),
      "image/png"
    );
  });
  const bytes = new Uint8Array(await blob.arrayBuffer());
  validateNormalizedAvatarPng(bytes);
  return bytes;
}

export function AvatarEditor({
  services,
  avatar,
  onChange,
  label = "可选头像"
}: {
  services: LocalContentServices;
  avatar: LocalAvatar | null;
  onChange: (avatar: LocalAvatar | null) => void;
  label?: string;
}) {
  const [open, setOpen] = useState(false);
  const [sourceUrl, setSourceUrl] = useState<string | null>(null);
  const [sourceSize, setSourceSize] = useState({ width: 256, height: 256 });
  const [sourceBytes, setSourceBytes] = useState<Uint8Array | null>(null);
  const [zoom, setZoom] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const previewUrlRef = useRef<string | null>(null);
  const [avatarPreviewUrl, setAvatarPreviewUrl] = useState<string | null>(null);
  const dragRef = useRef<{
    pointerId: number;
    x: number;
    y: number;
    offsetX: number;
    offsetY: number;
  } | null>(null);

  const clearSource = () => {
    if (previewUrlRef.current) {
      URL.revokeObjectURL(previewUrlRef.current);
    }
    previewUrlRef.current = null;
    setSourceUrl(null);
    setSourceBytes(null);
  };

  useEffect(
    () => () => {
      if (previewUrlRef.current) {
        URL.revokeObjectURL(previewUrlRef.current);
        previewUrlRef.current = null;
      }
    },
    []
  );

  useEffect(() => {
    if (!avatar) {
      setAvatarPreviewUrl(null);
      return;
    }
    const buffer = new ArrayBuffer(avatar.bytes.byteLength);
    new Uint8Array(buffer).set(avatar.bytes);
    const url = URL.createObjectURL(
      new Blob([buffer], {
        type: "image/png"
      })
    );
    setAvatarPreviewUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [avatar]);

  const useBytes = async (bytes: Uint8Array) => {
    validateAvatarInputPng(bytes);
    const buffer = new ArrayBuffer(bytes.byteLength);
    new Uint8Array(buffer).set(bytes);
    const blob = new Blob([buffer], { type: "image/png" });
    const bitmap = await createImageBitmap(blob);
    try {
      if (
        bitmap.width > CONTENT_LIMITS.avatarInputMaxDimension ||
        bitmap.height > CONTENT_LIMITS.avatarInputMaxDimension ||
        bitmap.width * bitmap.height > CONTENT_LIMITS.avatarInputMaxPixels
      ) {
        throw new Error("头像解码后的尺寸或像素数超限");
      }
      clearSource();
      const url = URL.createObjectURL(blob);
      previewUrlRef.current = url;
      setSourceUrl(url);
      setSourceBytes(new Uint8Array(bytes));
      setSourceSize({ width: bitmap.width, height: bitmap.height });
      setZoom(1);
      setOffset({ x: 0, y: 0 });
      setError(null);
      setOpen(true);
    } finally {
      bitmap.close();
    }
  };

  const choose = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) {
      return;
    }
    if (file.type && file.type !== "image/png") {
      setError("只支持静态 PNG 头像，不支持 JPEG、SVG 或其它格式");
      return;
    }
    try {
      await useBytes(new Uint8Array(await file.arrayBuffer()));
    } catch (inputError) {
      setError(inputError instanceof Error ? inputError.message : "头像文件无效");
    }
  };

  const recrop = async () => {
    if (!avatar) {
      return;
    }
    try {
      await useBytes(avatar.source?.bytes ?? avatar.bytes);
    } catch (inputError) {
      setError(inputError instanceof Error ? inputError.message : "头像文件无效");
    }
  };

  const save = async () => {
    if (!sourceUrl || !sourceBytes) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const image = new Image();
      image.src = sourceUrl;
      await image.decode();
      const canvas = document.createElement("canvas");
      canvas.width = CONTENT_LIMITS.avatarDimension;
      canvas.height = CONTENT_LIMITS.avatarDimension;
      const context = canvas.getContext("2d", { alpha: true });
      if (!context) {
        throw new Error("浏览器无法创建头像 Canvas");
      }
      context.clearRect(0, 0, canvas.width, canvas.height);
      context.imageSmoothingEnabled = true;
      context.imageSmoothingQuality = "high";
      const placement = avatarCropPlacement(
        sourceSize.width,
        sourceSize.height,
        zoom,
        offset.x,
        offset.y
      );
      context.drawImage(
        image,
        placement.x,
        placement.y,
        placement.width,
        placement.height
      );
      const bytes = await canvasPng(canvas);
      context.clearRect(0, 0, canvas.width, canvas.height);
      canvas.width = 1;
      canvas.height = 1;
      const next = LocalAvatarSchema.parse({
        schemaVersion: 1,
        mimeType: "image/png",
        width: CONTENT_LIMITS.avatarDimension,
        height: CONTENT_LIMITS.avatarDimension,
        byteLength: bytes.byteLength,
        sha256: await sha256(bytes),
        updatedAt: new Date().toISOString(),
        bytes,
        source: {
          mimeType: "image/png",
          width: sourceSize.width,
          height: sourceSize.height,
          byteLength: sourceBytes.byteLength,
          sha256: await sha256(sourceBytes),
          bytes: new Uint8Array(sourceBytes)
        }
      });
      await services.avatar.put(next);
      onChange(next);
      clearSource();
      setOpen(false);
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "保存头像失败");
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    try {
      await services.avatar.remove();
      onChange(null);
      clearSource();
      setOpen(false);
      setError(null);
    } catch (removeError) {
      setError(removeError instanceof Error ? removeError.message : "删除头像失败");
    }
  };

  const previewPlacement = avatarCropPlacement(
    sourceSize.width,
    sourceSize.height,
    zoom,
    offset.x,
    offset.y,
    280
  );

  const startDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = {
      pointerId: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      offsetX: offset.x,
      offsetY: offset.y
    };
  };
  const moveDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) {
      return;
    }
    setOffset({
      x: Math.max(-1, Math.min(1, drag.offsetX + (event.clientX - drag.x) / 120)),
      y: Math.max(-1, Math.min(1, drag.offsetY + (event.clientY - drag.y) / 120))
    });
  };

  return (
    <section className="avatar-control" data-ui="avatar-control">
      <div className="avatar-control__preview checkerboard">
        {avatarPreviewUrl ? (
          <img alt="当前本地头像预览" src={avatarPreviewUrl} />
        ) : (
          <span aria-hidden="true">+</span>
        )}
      </div>
      <div>
        <strong>{label}</strong>
        <small>静态 PNG · 透明通道保留 · 仅本机长期保存</small>
        <div className="avatar-control__actions">
          <label className="mini-button">
            {avatar ? "更换" : "添加"}
            <input accept="image/png,.png" onChange={choose} type="file" />
          </label>
          {avatar && (
            <>
              <button onClick={() => void recrop()} type="button">
                重新裁切
              </button>
              <button onClick={() => void remove()} type="button">
                删除
              </button>
            </>
          )}
        </div>
      </div>
      {error && <p className="avatar-error">{error}</p>}

      {open && sourceUrl && (
        <div className="avatar-modal" role="dialog" aria-modal="true">
          <section>
            <header>
              <div>
                <p className="eyebrow">Avatar crop</p>
                <h2>裁切透明 PNG 头像</h2>
              </div>
              <button
                aria-label="关闭头像裁切"
                onClick={() => {
                  clearSource();
                  setOpen(false);
                }}
                type="button"
              >
                ×
              </button>
            </header>
            <div
              aria-label="拖动头像位置"
              className="avatar-crop checkerboard"
              onPointerCancel={() => {
                dragRef.current = null;
              }}
              onPointerDown={startDrag}
              onPointerMove={moveDrag}
              onPointerUp={() => {
                dragRef.current = null;
              }}
              role="application"
              tabIndex={0}
            >
              <img
                alt="待裁切头像"
                draggable={false}
                src={sourceUrl}
                style={{
                  width: previewPlacement.width,
                  height: previewPlacement.height,
                  left: previewPlacement.x,
                  top: previewPlacement.y
                }}
              />
            </div>
            <div className="avatar-sliders">
              <label>
                缩放
                <input
                  aria-label="头像缩放"
                  max={3}
                  min={1}
                  onChange={(event) => setZoom(Number(event.target.value))}
                  step={0.01}
                  type="range"
                  value={zoom}
                />
              </label>
              <label>
                水平位置
                <input
                  aria-label="头像水平位置"
                  max={1}
                  min={-1}
                  onChange={(event) =>
                    setOffset((current) => ({
                      ...current,
                      x: Number(event.target.value)
                    }))
                  }
                  step={0.01}
                  type="range"
                  value={offset.x}
                />
              </label>
              <label>
                垂直位置
                <input
                  aria-label="头像垂直位置"
                  max={1}
                  min={-1}
                  onChange={(event) =>
                    setOffset((current) => ({
                      ...current,
                      y: Number(event.target.value)
                    }))
                  }
                  step={0.01}
                  type="range"
                  value={offset.y}
                />
              </label>
            </div>
            {error && <p className="avatar-error">{error}</p>}
            <footer>
              <button
                className="secondary-button"
                onClick={() => {
                  clearSource();
                  setOpen(false);
                }}
                type="button"
              >
                取消
              </button>
              <button
                className="primary-button"
                disabled={busy}
                onClick={() => void save()}
                type="button"
              >
                {busy ? "正在生成…" : "确认 256 × 256 PNG"}
              </button>
            </footer>
          </section>
        </div>
      )}
    </section>
  );
}
