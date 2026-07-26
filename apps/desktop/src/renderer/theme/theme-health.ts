export type CriticalUiKind = "action" | "content" | "input" | "canvas";

export interface CriticalUiMeasurement {
  id: string;
  label: string;
  kind: CriticalUiKind;
  display: string;
  visibility: string;
  opacity: number;
  pointerEvents: string;
  width: number;
  height: number;
  visibleWidth: number;
  visibleHeight: number;
  top: number;
  right: number;
  bottom: number;
  left: number;
  viewportWidth: number;
  viewportHeight: number;
}

export interface CriticalUiFailure {
  id: string;
  label: string;
  kind: CriticalUiKind;
  reason: string;
  recoverableWithAction: boolean;
  invoke?: () => void;
}

export interface ThemeHealthReport {
  healthy: boolean;
  requiresThemeSuspension: boolean;
  failures: CriticalUiFailure[];
}

const MIN_REGION_SIZE = 4;
const MIN_VISIBLE_OPACITY = 0.05;

export function evaluateCriticalMeasurement(
  measurement: CriticalUiMeasurement
): Omit<CriticalUiFailure, "invoke"> | null {
  let reason: string | null = null;
  if (measurement.display === "none") {
    reason = "被设置为 display:none";
  } else if (
    measurement.visibility === "hidden" ||
    measurement.visibility === "collapse"
  ) {
    reason = "被设置为不可见";
  } else if (measurement.opacity <= MIN_VISIBLE_OPACITY) {
    reason = "接近完全透明";
  } else if (
    (measurement.kind === "action" || measurement.kind === "input") &&
    measurement.pointerEvents === "none"
  ) {
    reason = "禁止了指针操作";
  } else if (
    measurement.width < MIN_REGION_SIZE ||
    measurement.height < MIN_REGION_SIZE
  ) {
    reason = "尺寸接近零";
  } else if (
    measurement.right <= 0 ||
    measurement.bottom <= 0 ||
    measurement.left >= measurement.viewportWidth ||
    measurement.top >= measurement.viewportHeight
  ) {
    reason = "完全位于视口外";
  } else if (
    measurement.visibleWidth < MIN_REGION_SIZE ||
    measurement.visibleHeight < MIN_REGION_SIZE
  ) {
    reason = "被父级裁剪到无法操作";
  }
  if (!reason) {
    return null;
  }
  return {
    id: measurement.id,
    label: measurement.label,
    kind: measurement.kind,
    reason,
    recoverableWithAction: measurement.kind === "action"
  };
}

function measurementFor(element: HTMLElement): CriticalUiMeasurement {
  const style = getComputedStyle(element);
  const rect = element.getBoundingClientRect();
  let effectiveOpacity = 1;
  let effectivePointerEvents = style.pointerEvents;
  let visibleLeft = rect.left;
  let visibleTop = rect.top;
  let visibleRight = rect.right;
  let visibleBottom = rect.bottom;
  let ancestor: HTMLElement | null = element;
  while (ancestor) {
    const ancestorStyle = getComputedStyle(ancestor);
    const opacity = Number.parseFloat(ancestorStyle.opacity || "1");
    effectiveOpacity *= Number.isFinite(opacity) ? opacity : 1;
    if (ancestorStyle.pointerEvents === "none") {
      effectivePointerEvents = "none";
    }
    if (ancestor !== element) {
      const ancestorRect = ancestor.getBoundingClientRect();
      if (["hidden", "clip"].includes(ancestorStyle.overflowX)) {
        visibleLeft = Math.max(visibleLeft, ancestorRect.left);
        visibleRight = Math.min(visibleRight, ancestorRect.right);
      }
      if (["hidden", "clip"].includes(ancestorStyle.overflowY)) {
        visibleTop = Math.max(visibleTop, ancestorRect.top);
        visibleBottom = Math.min(visibleBottom, ancestorRect.bottom);
      }
    }
    ancestor = ancestor.parentElement;
  }
  const kind = (element.dataset.criticalKind ?? "content") as CriticalUiKind;
  return {
    id: element.dataset.criticalUi ?? "unknown",
    label:
      element.dataset.criticalLabel?.trim() ||
      element.getAttribute("aria-label")?.trim() ||
      "当前必要控件",
    kind,
    display: style.display,
    visibility: style.visibility,
    opacity: effectiveOpacity,
    pointerEvents: effectivePointerEvents,
    width: rect.width,
    height: rect.height,
    visibleWidth: Math.max(0, visibleRight - visibleLeft),
    visibleHeight: Math.max(0, visibleBottom - visibleTop),
    top: rect.top,
    right: rect.right,
    bottom: rect.bottom,
    left: rect.left,
    viewportWidth: window.innerWidth,
    viewportHeight: window.innerHeight
  };
}

function actionInvoker(element: HTMLElement): (() => void) | undefined {
  if (
    (element instanceof HTMLButtonElement || element instanceof HTMLInputElement) &&
    !element.disabled
  ) {
    return () => element.click();
  }
  if (element instanceof HTMLAnchorElement) {
    return () => element.click();
  }
  return undefined;
}

export function inspectThemeHealth(root: HTMLElement): ThemeHealthReport {
  const candidates = [
    root,
    ...root.querySelectorAll<HTMLElement>("[data-critical-ui]")
  ];
  const failures: CriticalUiFailure[] = [];
  for (const element of candidates) {
    if (
      element !== root &&
      (element instanceof HTMLButtonElement ||
        element instanceof HTMLInputElement ||
        element instanceof HTMLSelectElement ||
        element instanceof HTMLTextAreaElement) &&
      element.disabled
    ) {
      continue;
    }
    const fallbackMeasurement =
      element === root
        ? {
            ...measurementFor(element),
            id: "theme-root",
            label: "整个主题页面",
            kind: "content" as const
          }
        : measurementFor(element);
    const failure = evaluateCriticalMeasurement(fallbackMeasurement);
    if (!failure) {
      continue;
    }
    const invoke =
      failure.recoverableWithAction && element !== root
        ? actionInvoker(element)
        : undefined;
    failures.push({
      ...failure,
      recoverableWithAction: Boolean(invoke),
      ...(invoke ? { invoke } : {})
    });
  }

  const viewportWidth = Math.max(window.innerWidth, 1);
  const viewportHeight = Math.max(window.innerHeight, 1);
  if (root.scrollWidth > viewportWidth * 5 || root.scrollHeight > viewportHeight * 8) {
    failures.push({
      id: "theme-root-overflow",
      label: "整个主题页面",
      kind: "content",
      reason: "产生了无法恢复的超大页面偏移",
      recoverableWithAction: false
    });
  }

  return {
    healthy: failures.length === 0,
    requiresThemeSuspension: failures.some((failure) => !failure.recoverableWithAction),
    failures
  };
}

export function themeHealthReason(report: ThemeHealthReport): string {
  const first = report.failures.find((failure) => !failure.recoverableWithAction);
  return first
    ? `自定义 CSS 使“${first.label}”${first.reason}，已自动暂停主题`
    : "自定义 CSS 隐藏了当前必要控件";
}
