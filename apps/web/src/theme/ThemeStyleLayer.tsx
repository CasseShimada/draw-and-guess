import defaultTemplateCss from "./default-template.css?inline";

export const DEFAULT_WEB_TEMPLATE_CSS = defaultTemplateCss;

export function DefaultWebThemeStyle({ enabled = true }: { enabled?: boolean }) {
  return enabled ? (
    <style data-style-layer="default-web-template">{DEFAULT_WEB_TEMPLATE_CSS}</style>
  ) : null;
}
