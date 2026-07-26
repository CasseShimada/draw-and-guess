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
