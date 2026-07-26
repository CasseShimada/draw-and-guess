export function RoomCodeCopyButton({
  roomCode,
  onCopy
}: {
  roomCode: string;
  onCopy: () => void;
}) {
  return (
    <button
      aria-label={`复制房间码 ${roomCode}`}
      className="brand-room-code"
      data-action="copy-room-code"
      data-critical-kind="action"
      data-critical-label={`复制房间码 ${roomCode}`}
      data-critical-ui="copy-room-code"
      data-ui="room-code-copy"
      onClick={onCopy}
      title="点击复制房间码"
      type="button"
    >
      <small>房间码</small>
      <code>{roomCode}</code>
    </button>
  );
}
