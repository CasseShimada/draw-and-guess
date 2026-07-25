export interface NormalizedCrop {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PixelCrop {
  x: number;
  y: number;
  width: number;
  height: number;
}

export const FULL_SOURCE_CROP: NormalizedCrop = {
  x: 0,
  y: 0,
  width: 1,
  height: 1
};

export const MIN_NORMALIZED_CROP_SIZE = 0.02;

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function finiteOr(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback;
}

export function normalizeCrop(
  input: NormalizedCrop,
  minimumSize = MIN_NORMALIZED_CROP_SIZE
): NormalizedCrop {
  const safeMinimum = clamp(finiteOr(minimumSize, MIN_NORMALIZED_CROP_SIZE), 0.001, 1);
  const x = clamp(finiteOr(input.x, 0), 0, 1 - safeMinimum);
  const y = clamp(finiteOr(input.y, 0), 0, 1 - safeMinimum);
  const width = clamp(finiteOr(input.width, 1), safeMinimum, 1 - x);
  const height = clamp(finiteOr(input.height, 1), safeMinimum, 1 - y);
  return { x, y, width, height };
}

export function isValidNormalizedCrop(
  crop: NormalizedCrop,
  minimumSize = MIN_NORMALIZED_CROP_SIZE
): boolean {
  return (
    Object.values(crop).every(Number.isFinite) &&
    crop.x >= 0 &&
    crop.y >= 0 &&
    crop.width >= minimumSize &&
    crop.height >= minimumSize &&
    crop.x + crop.width <= 1 &&
    crop.y + crop.height <= 1
  );
}

export function cropToSourcePixels(
  cropInput: NormalizedCrop,
  sourceWidth: number,
  sourceHeight: number
): PixelCrop {
  if (
    !Number.isFinite(sourceWidth) ||
    !Number.isFinite(sourceHeight) ||
    sourceWidth < 1 ||
    sourceHeight < 1
  ) {
    throw new RangeError("来源尺寸必须是正数");
  }
  const crop = normalizeCrop(cropInput);
  const x = Math.round(crop.x * sourceWidth);
  const y = Math.round(crop.y * sourceHeight);
  const right = Math.min(sourceWidth, Math.round((crop.x + crop.width) * sourceWidth));
  const bottom = Math.min(
    sourceHeight,
    Math.round((crop.y + crop.height) * sourceHeight)
  );
  return {
    x,
    y,
    width: Math.max(1, right - x),
    height: Math.max(1, bottom - y)
  };
}

export function centeredAspectCrop(
  sourceWidth: number,
  sourceHeight: number,
  targetAspect = 16 / 9
): NormalizedCrop {
  if (
    sourceWidth <= 0 ||
    sourceHeight <= 0 ||
    !Number.isFinite(targetAspect) ||
    targetAspect <= 0
  ) {
    return { ...FULL_SOURCE_CROP };
  }
  const sourceAspect = sourceWidth / sourceHeight;
  if (sourceAspect > targetAspect) {
    const width = targetAspect / sourceAspect;
    return { x: (1 - width) / 2, y: 0, width, height: 1 };
  }
  const height = sourceAspect / targetAspect;
  return { x: 0, y: (1 - height) / 2, width: 1, height };
}

export function fitWithinLongEdge(
  width: number,
  height: number,
  maxLongEdge: number
): { width: number; height: number } {
  if (width < 1 || height < 1 || maxLongEdge < 1) {
    throw new RangeError("尺寸必须是正数");
  }
  const scale = Math.min(1, maxLongEdge / Math.max(width, height));
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale))
  };
}
