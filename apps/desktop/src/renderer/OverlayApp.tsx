import { useEffect, useState } from "react";

import type { SharingState } from "../shared/ipc.js";

const INACTIVE: SharingState = {
  active: false,
  sourceName: null,
  captureSessionId: null,
  endsAt: null
};

export function OverlayApp() {
  const [sharing, setSharing] = useState(INACTIVE);
  const [now, setNow] = useState(Date.now());

  useEffect(() => window.drawGuessDesktop.sharing.onState(setSharing), []);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(timer);
  }, []);
  const remaining =
    sharing.endsAt === null
      ? null
      : Math.max(0, Math.ceil((sharing.endsAt - now) / 1_000));
  return (
    <main className="sharing-overlay" data-ui="sharing-safety">
      <span className="sharing-overlay__pulse" />
      <span>
        <strong>{sharing.active ? "正在共享" : "共享已停止"}</strong>
        <small>
          {remaining === null ? "等待回合时间" : `剩余 ${String(remaining)} 秒`}
        </small>
      </span>
      <button
        disabled={!sharing.active}
        onClick={() => void window.drawGuessDesktop.sharing.stop()}
        type="button"
      >
        立即停止
      </button>
    </main>
  );
}
