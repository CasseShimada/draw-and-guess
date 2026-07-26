import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./App.js";
import "./styles.css";
import { DefaultWebThemeStyle } from "./theme/ThemeStyleLayer.js";

const root = document.querySelector<HTMLDivElement>("#root");
if (!root) {
  throw new Error("找不到应用挂载节点");
}

createRoot(root).render(
  <StrictMode>
    <DefaultWebThemeStyle />
    <App />
  </StrictMode>
);
