import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import "@draw-guess/web/styles.css";
import "./desktop.css";

import { DesktopApp } from "./DesktopApp.js";
import { OverlayApp } from "./OverlayApp.js";

const root = document.querySelector<HTMLDivElement>("#root");
if (!root) {
  throw new Error("找不到桌面应用挂载节点");
}

const overlay = new URLSearchParams(window.location.search).get("overlay") === "1";

createRoot(root).render(
  <StrictMode>{overlay ? <OverlayApp /> : <DesktopApp />}</StrictMode>
);
