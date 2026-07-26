export function RoomClosureDialog({
  message,
  onConfirm
}: {
  message: string;
  onConfirm: () => void;
}) {
  return (
    <div className="room-closure-backdrop">
      <section
        aria-describedby="room-closure-message"
        aria-labelledby="room-closure-title"
        aria-modal="true"
        className="room-closure-dialog"
        data-ui="room-closure-dialog"
        role="alertdialog"
      >
        <p className="eyebrow">Room closed</p>
        <h2 id="room-closure-title">房间已结束</h2>
        <p id="room-closure-message">{message}</p>
        <button
          autoFocus
          className="primary-button"
          data-action="confirm-room-closure"
          data-critical-kind="action"
          data-critical-label="确认房间已结束并返回主界面"
          data-critical-ui="confirm-room-closure"
          data-ui="confirm-room-closure"
          onClick={onConfirm}
          type="button"
        >
          确定并返回主界面
        </button>
      </section>
    </div>
  );
}
