import { DEFAULT_WEB_TEMPLATE_CSS } from "@draw-guess/web/theme";

import desktopTemplateCss from "./desktop-template.css?inline";

export const DEFAULT_DESKTOP_TEMPLATE_CSS = `${DEFAULT_WEB_TEMPLATE_CSS}

/* ===== Electron ordinary UI ===== */

${desktopTemplateCss}`;

export function DefaultDesktopThemeStyle({ enabled = true }: { enabled?: boolean }) {
  return enabled ? (
    <style data-style-layer="default-desktop-template">
      {DEFAULT_DESKTOP_TEMPLATE_CSS}
    </style>
  ) : null;
}
