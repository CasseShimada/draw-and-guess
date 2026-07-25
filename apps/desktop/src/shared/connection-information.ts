import type { DesktopSettings, EmbeddedServerStatus } from "./ipc.js";
import { normalizeConnectionTarget } from "./server-url.js";

export interface PlayerConnectionInformation {
  scope: "lan" | "public";
  method: string;
  host: string;
  port: number;
  roomCode: string;
  networkInterface: string | null;
  localMapping: string | null;
}

function normalizedRoomCode(roomCodeInput: string): string {
  const roomCode = roomCodeInput.trim().toUpperCase();
  if (!/^[A-Z0-9]{6}$/u.test(roomCode)) {
    throw new Error("房间码格式不正确");
  }
  return roomCode;
}

export function lanConnectionInformation(
  status: EmbeddedServerStatus,
  preferredLanAddressId: string | null,
  roomCodeInput: string
): PlayerConnectionInformation | null {
  if (
    status.state !== "running" ||
    status.bindMode !== "lan" ||
    status.actualPort === null ||
    preferredLanAddressId === null
  ) {
    return null;
  }
  const address = status.lanAddresses.find(
    (candidate) => candidate.id === preferredLanAddressId
  );
  if (!address) {
    return null;
  }
  return {
    scope: "lan",
    method: "局域网 HTTP/WS",
    host: address.address,
    port: status.actualPort,
    roomCode: normalizedRoomCode(roomCodeInput),
    networkInterface: `${address.interfaceName}（${address.cidr ?? `${address.address}/${address.netmask}`}）`,
    localMapping: null
  };
}

export function publicConnectionInformation(
  status: EmbeddedServerStatus,
  endpoint: DesktopSettings["publicEndpoint"],
  roomCodeInput: string
): PlayerConnectionInformation | null {
  if (status.state !== "running" || status.actualPort === null || endpoint === null) {
    return null;
  }
  const target = normalizeConnectionTarget(endpoint.target);
  return {
    scope: "public",
    method: target.security === "https" ? "公网 HTTPS/WSS" : "公网 HTTP/WS（未加密）",
    host: target.host,
    port: target.port,
    roomCode: normalizedRoomCode(roomCodeInput),
    networkInterface: null,
    localMapping: `127.0.0.1:${String(status.actualPort)}`
  };
}

export function formatConnectionInformation(
  information: PlayerConnectionInformation
): string {
  const lines = [
    "画猜现场连接信息",
    `服务器地址 / IP：${information.host}`,
    `端口：${String(information.port)}`,
    `房间码：${information.roomCode}`,
    `连接方式：${information.method}`,
    "房间密码：请向房主另行获取"
  ];
  if (information.networkInterface) {
    lines.push(`网卡：${information.networkInterface}`);
  }
  if (information.localMapping) {
    lines.push(`本地映射目标：${information.localMapping}`);
  }
  return lines.join("\n");
}
