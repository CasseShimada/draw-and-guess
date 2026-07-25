import type {
  DesktopSettings,
  EmbeddedServerStatus,
  SettingsPatch
} from "../shared/ipc.js";
import {
  formatConnectionInformation,
  lanConnectionInformation,
  publicConnectionInformation,
  type PlayerConnectionInformation
} from "../shared/connection-information.js";

function CopyField({ label, value }: { label: string; value: string }) {
  return (
    <div className="connection-info-field">
      <span>{label}</span>
      <code>{value}</code>
      <button
        aria-label={`复制${label}`}
        onClick={() => void navigator.clipboard.writeText(value)}
        type="button"
      >
        复制
      </button>
    </div>
  );
}

function InformationCard({
  information,
  title
}: {
  information: PlayerConnectionInformation;
  title: string;
}) {
  return (
    <article className="connection-information-card">
      <h3>{title}</h3>
      <CopyField label="连接方式" value={information.method} />
      <CopyField label="服务器地址 / IP" value={information.host} />
      <CopyField label="端口" value={String(information.port)} />
      <CopyField label="房间码" value={information.roomCode} />
      {information.networkInterface && (
        <CopyField label="网卡" value={information.networkInterface} />
      )}
      {information.localMapping && (
        <CopyField label="本地映射目标" value={information.localMapping} />
      )}
      <p>房间密码：请向房主另行获取</p>
      <button
        className="primary-button"
        onClick={() =>
          void navigator.clipboard.writeText(formatConnectionInformation(information))
        }
        type="button"
      >
        复制连接信息
      </button>
    </article>
  );
}

export function HostConnectionInformation({
  roomCode,
  settings,
  status,
  onSettings
}: {
  roomCode: string;
  settings: DesktopSettings;
  status: EmbeddedServerStatus;
  onSettings: (patch: SettingsPatch) => Promise<void>;
}) {
  const selectedAddress = status.lanAddresses.find(
    (address) => address.id === settings.preferredLanAddressId
  );
  const lan = lanConnectionInformation(
    status,
    settings.preferredLanAddressId,
    roomCode
  );
  const publicInformation = publicConnectionInformation(
    status,
    settings.publicEndpoint,
    roomCode
  );

  return (
    <section className="panel host-connection-information" data-ui="host-network-info">
      <div className="panel-heading">
        <div>
          <p className="eyebrow">Player connection information</p>
          <h2>玩家连接信息</h2>
        </div>
        <span className="step-pill">实际主机</span>
      </div>

      <div className="connection-listen-diagnostic">
        <strong>本机客户端</strong>
        <code>{status.loopbackOrigin ?? "服务未运行"}</code>
        <span>
          监听：{status.boundHost ?? "未监听"}
          {status.boundHost === "0.0.0.0"
            ? "（所有 IPv4 接口，仅诊断，不可分享）"
            : "（仅本机）"}
        </span>
      </div>

      {status.bindMode === "lan" ? (
        <>
          <label>
            选择要分享的网卡 / IPv4
            <select
              onChange={(event) =>
                void onSettings({
                  preferredLanAddressId: event.target.value || null
                })
              }
              value={selectedAddress?.id ?? ""}
            >
              <option value="">请选择实际连接玩家的网络</option>
              {status.lanAddresses.map((address) => (
                <option key={address.id} value={address.id}>
                  {address.interfaceName} · {address.cidr ?? address.address}
                  {address.kind === "link-local"
                    ? " · 链路本地（不推荐）"
                    : address.kind === "other"
                      ? " · 虚拟/VPN/公网（请确认）"
                      : " · 私有网络"}
                </option>
              ))}
            </select>
          </label>
          {status.lanAddresses.length === 0 && (
            <p className="inline-warning">
              服务已监听，但没有发现可分享的局域网 IPv4。
            </p>
          )}
          {settings.preferredLanAddressId && !selectedAddress && (
            <p className="inline-warning">
              上次选择的网络地址已消失，请重新选择要分享的网卡。
            </p>
          )}
          {selectedAddress?.kind === "link-local" && (
            <p className="inline-warning">
              169.254.*.* 通常不能用于普通家庭局域网，只在明确的点对点场景使用。
            </p>
          )}
          {lan && <InformationCard information={lan} title="局域网玩家" />}
        </>
      ) : (
        <p className="muted">
          当前为“仅本机”，其它设备无法接入。要分享，请在联机中心选择 “局域网 /
          可做端口转发”并明确重启服务。
        </p>
      )}

      {publicInformation && (
        <>
          {status.bindMode !== "lan" && (
            <p className="inline-warning">
              已保存公网展示信息，但推荐先以“局域网 / 可做端口转发”模式固定监听端口。
            </p>
          )}
          <InformationCard information={publicInformation} title="公网转发玩家" />
        </>
      )}
    </section>
  );
}
