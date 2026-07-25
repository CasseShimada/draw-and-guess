function isPrivateIpv4(hostname: string): boolean {
  const parts = hostname.split(".").map((part) => Number(part));
  if (
    parts.length !== 4 ||
    parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)
  ) {
    return false;
  }
  const [first, second] = parts;
  return (
    first === 10 ||
    first === 127 ||
    (first === 169 && second === 254) ||
    (first === 172 && second !== undefined && second >= 16 && second <= 31) ||
    (first === 192 && second === 168)
  );
}

export function isLocalNetworkHostname(hostnameInput: string): boolean {
  const hostname = hostnameInput.toLowerCase().replace(/^\[|\]$/g, "");
  return (
    hostname === "localhost" ||
    hostname === "::1" ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local") ||
    isPrivateIpv4(hostname)
  );
}

export function normalizeServerUrl(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value.trim());
  } catch {
    throw new Error("服务器地址格式不正确");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("服务器地址必须使用 HTTP 或 HTTPS");
  }
  if (parsed.username || parsed.password) {
    throw new Error("服务器地址不能包含用户名或密码");
  }
  if (parsed.search || parsed.hash) {
    throw new Error("服务器地址不能包含查询参数或片段");
  }
  if (parsed.pathname !== "/" && parsed.pathname !== "") {
    throw new Error("服务器当前必须部署在站点根路径");
  }
  if (parsed.protocol === "http:" && !isLocalNetworkHostname(parsed.hostname)) {
    throw new Error("公网服务器必须使用 HTTPS");
  }
  parsed.pathname = "/";
  return parsed.origin;
}

export function websocketUrl(serverUrl: string): string {
  const parsed = new URL(normalizeServerUrl(serverUrl));
  parsed.protocol = parsed.protocol === "https:" ? "wss:" : "ws:";
  parsed.pathname = "/ws";
  return parsed.toString();
}

export function desktopInvitationText(
  serverUrl: string,
  roomCodeInput: string
): string {
  const origin = normalizeServerUrl(serverUrl);
  const roomCode = roomCodeInput.trim().toUpperCase();
  if (!/^[A-Z0-9]{6}$/.test(roomCode)) {
    throw new Error("房间码格式不正确");
  }
  const parameters = new URLSearchParams({
    server: origin,
    room: roomCode
  });
  return [
    `桌面应用：drawguess://join?${parameters.toString()}`,
    `浏览器兼容入口：${origin}/?room=${roomCode}`
  ].join("\n");
}
