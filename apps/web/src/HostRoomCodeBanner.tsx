export function HostRoomCodeBanner({
  roomCode,
  onCopy
}: {
  roomCode: string;
  onCopy: () => void;
}) {
  return (
    <section
      aria-labelledby="host-room-code-title"
      className="host-room-code-banner"
      data-ui="host-room-code"
    >
      <div>
        <p className="eyebrow">Invite players</p>
        <div className="host-room-code-banner__code">
          <h2 id="host-room-code-title">六位房间码</h2>
          <code aria-label={`房间码 ${roomCode}`}>{roomCode}</code>
        </div>
        <p>玩家加入时需要输入此房间码和房间密码。</p>
      </div>
      <button
        aria-label={`复制房间码 ${roomCode}`}
        className="primary-button"
        data-ui="copy-room-code"
        onClick={onCopy}
        type="button"
      >
        复制房间码
      </button>
    </section>
  );
}
