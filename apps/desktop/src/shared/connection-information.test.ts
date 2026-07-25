import { describe, expect, it } from "vitest";

import {
  formatConnectionInformation,
  lanConnectionInformation,
  publicConnectionInformation
} from "./connection-information.js";
import type { DesktopSettings, EmbeddedServerStatus } from "./ipc.js";

const status: EmbeddedServerStatus = {
  state: "running",
  bindMode: "lan",
  boundHost: "0.0.0.0",
  requestedPort: 3000,
  actualPort: 3000,
  serverInstanceId: "s".repeat(43),
  loopbackOrigin: "http://127.0.0.1:3000",
  lanAddresses: [
    {
      id: "Wi-Fi:192.168.1.20",
      interfaceName: "Wi-Fi",
      address: "192.168.1.20",
      netmask: "255.255.255.0",
      cidr: "192.168.1.20/24",
      kind: "private",
      recommended: true
    }
  ],
  executablePath: "C:\\Program Files\\Draw Guess\\draw-guess.exe",
  error: null
};

describe("player connection information", () => {
  it("formats ordinary LAN fields without links, queries, credentials, or secrets", () => {
    const information = lanConnectionInformation(
      status,
      "Wi-Fi:192.168.1.20",
      "abc234"
    );
    expect(information).not.toBeNull();
    const text = formatConnectionInformation(information!);
    expect(text).toContain("服务器地址 / IP：192.168.1.20");
    expect(text).toContain("端口：3000");
    expect(text).toContain("房间码：ABC234");
    expect(text).toContain("连接方式：局域网 HTTP/WS");
    expect(text).toContain("房间密码：请向房主另行获取");
    expect(text).not.toMatch(/drawguess:\/\/|\?|token|secret|password=/iu);
  });

  it("keeps external and local ports visibly separate", () => {
    const endpoint: DesktopSettings["publicEndpoint"] = {
      target: {
        host: "public.example",
        port: 45_678,
        security: "http"
      },
      label: "Raw TCP"
    };
    const information = publicConnectionInformation(status, endpoint, "ABC234");
    expect(information).toMatchObject({
      host: "public.example",
      port: 45_678,
      method: "公网 HTTP/WS（未加密）",
      localMapping: "127.0.0.1:3000"
    });
    const text = formatConnectionInformation(information!);
    expect(text).toContain("端口：45678");
    expect(text).toContain("本地映射目标：127.0.0.1:3000");
  });

  it("never offers 0.0.0.0 or loopback as a LAN share address", () => {
    expect(
      lanConnectionInformation({ ...status, lanAddresses: [] }, "missing", "ABC234")
    ).toBeNull();
  });
});
