import { useRef, type PointerEvent as ReactPointerEvent } from "react";

import {
  MIN_NORMALIZED_CROP_SIZE,
  normalizeCrop,
  type NormalizedCrop
} from "@draw-guess/capture-core";

type DragMode = "move" | "nw" | "ne" | "sw" | "se";

interface DragState {
  mode: DragMode;
  pointerId: number;
  startX: number;
  startY: number;
  crop: NormalizedCrop;
}

export interface CropEditorProps {
  crop: NormalizedCrop;
  disabled?: boolean;
  onChange: (crop: NormalizedCrop) => void;
}

function resizeCrop(
  initial: NormalizedCrop,
  mode: Exclude<DragMode, "move">,
  dx: number,
  dy: number
): NormalizedCrop {
  let left = initial.x;
  let top = initial.y;
  let right = initial.x + initial.width;
  let bottom = initial.y + initial.height;

  if (mode.includes("w")) {
    left = Math.min(right - MIN_NORMALIZED_CROP_SIZE, Math.max(0, initial.x + dx));
  }
  if (mode.includes("e")) {
    right = Math.max(
      left + MIN_NORMALIZED_CROP_SIZE,
      Math.min(1, initial.x + initial.width + dx)
    );
  }
  if (mode.includes("n")) {
    top = Math.min(bottom - MIN_NORMALIZED_CROP_SIZE, Math.max(0, initial.y + dy));
  }
  if (mode.includes("s")) {
    bottom = Math.max(
      top + MIN_NORMALIZED_CROP_SIZE,
      Math.min(1, initial.y + initial.height + dy)
    );
  }
  return normalizeCrop({
    x: left,
    y: top,
    width: right - left,
    height: bottom - top
  });
}

export function moveCrop(
  initial: NormalizedCrop,
  dx: number,
  dy: number
): NormalizedCrop {
  return {
    ...initial,
    x: Math.min(1 - initial.width, Math.max(0, initial.x + dx)),
    y: Math.min(1 - initial.height, Math.max(0, initial.y + dy))
  };
}

export function CropEditor({ crop, disabled = false, onChange }: CropEditorProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<DragState | null>(null);

  const begin = (event: ReactPointerEvent<HTMLElement>, mode: DragMode) => {
    if (disabled || !rootRef.current) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    const bounds = rootRef.current.getBoundingClientRect();
    dragRef.current = {
      mode,
      pointerId: event.pointerId,
      startX: (event.clientX - bounds.left) / bounds.width,
      startY: (event.clientY - bounds.top) / bounds.height,
      crop
    };
  };

  const move = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    const root = rootRef.current;
    if (!drag || !root || drag.pointerId !== event.pointerId) {
      return;
    }
    const bounds = root.getBoundingClientRect();
    const dx = (event.clientX - bounds.left) / bounds.width - drag.startX;
    const dy = (event.clientY - bounds.top) / bounds.height - drag.startY;
    onChange(
      drag.mode === "move"
        ? moveCrop(drag.crop, dx, dy)
        : resizeCrop(drag.crop, drag.mode, dx, dy)
    );
  };

  const end = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (dragRef.current?.pointerId === event.pointerId) {
      dragRef.current = null;
    }
  };

  return (
    <div
      aria-label="裁切区域编辑器"
      className="crop-editor"
      onPointerMove={move}
      onPointerUp={end}
      onPointerCancel={end}
      ref={rootRef}
    >
      <div className="crop-editor__shade" />
      <div
        className="crop-editor__selection"
        onPointerDown={(event) => begin(event, "move")}
        style={{
          left: `${crop.x * 100}%`,
          top: `${crop.y * 100}%`,
          width: `${crop.width * 100}%`,
          height: `${crop.height * 100}%`
        }}
      >
        <span className="crop-editor__label">上传区域</span>
        {(["nw", "ne", "sw", "se"] as const).map((corner) => (
          <span
            aria-hidden="true"
            className={`crop-editor__handle crop-editor__handle--${corner}`}
            key={corner}
            onPointerDown={(event) => begin(event, corner)}
          />
        ))}
      </div>
    </div>
  );
}
