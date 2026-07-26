import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";

function formValue(values: FormData, name: string): string {
  const value = values.get(name);
  return typeof value === "string" ? value : "";
}

export function Home({
  busy,
  error,
  initialEntryMode,
  joinConnectionControl,
  topbarAddon,
  avatarControl,
  rememberedNickname,
  onCreate,
  onJoin,
  onManageWords
}: {
  busy: boolean;
  error: string | null;
  initialEntryMode: "create" | "join";
  joinConnectionControl?: ReactNode;
  topbarAddon?: ReactNode;
  avatarControl: ReactNode;
  rememberedNickname: string | null;
  onCreate: (nickname: string, password: string) => Promise<void>;
  onJoin: (roomCode: string, nickname: string, password: string) => Promise<void>;
  onManageWords: () => void;
}) {
  const [entryMode, setEntryMode] = useState<"create" | "join">(initialEntryMode);
  const [nickname, setNickname] = useState(rememberedNickname ?? "");
  const nicknameEditedRef = useRef(false);

  useEffect(() => setEntryMode(initialEntryMode), [initialEntryMode]);
  useEffect(() => {
    if (!nicknameEditedRef.current) {
      setNickname(rememberedNickname ?? "");
    }
  }, [rememberedNickname]);

  const submitCreate = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const values = new FormData(event.currentTarget);
    void onCreate(formValue(values, "nickname"), formValue(values, "password"));
  };
  const submitJoin = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const values = new FormData(event.currentTarget);
    void onJoin(
      formValue(values, "roomCode"),
      formValue(values, "nickname"),
      formValue(values, "password")
    );
  };

  return (
    <main className="home-shell" data-screen="home" data-ui="home-screen">
      <section className="home-intro" data-ui="home-intro">
        <div className="brand brand--large">
          <span className="brand__mark" aria-hidden="true">
            画
          </span>
          <span>
            <strong>画猜现场</strong>
            <small>DRAW &amp; GUESS LIVE</small>
          </span>
        </div>
        <div className="home-intro__copy">
          <p className="eyebrow">三种玩法 · 一间房 · 随时开画</p>
          <h1>
            认真画。
            <br />
            放心猜。
          </h1>
          <p>
            经典画猜、同步临摹与私密接龙共用一个房间。创建一场，或用朋友发来的房间码加入。
          </p>
        </div>
        <div className="signal-card" aria-label="产品特点">
          <span>
            <strong>01</strong> 三种模式
          </span>
          <span>
            <strong>02</strong> 即时联机
          </span>
          <span>
            <strong>03</strong> 私密题目
          </span>
        </div>
      </section>

      <section className="entry-card" data-ui="room-entry">
        <header className="entry-card__header">
          <div>
            <p className="eyebrow">Join the table</p>
            <h2>今晚怎么玩？</h2>
          </div>
          <div className="home-content-actions" aria-label="首页辅助功能">
            <button
              className="home-utility-button"
              data-action="manage-word-packs"
              onClick={onManageWords}
              type="button"
            >
              词库
            </button>
            {topbarAddon}
          </div>
        </header>

        <div
          className="entry-tabs"
          data-ui="entry-tabs"
          role="tablist"
          aria-label="进入方式"
        >
          <button
            aria-selected={entryMode === "create"}
            className={entryMode === "create" ? "active" : ""}
            onClick={() => setEntryMode("create")}
            role="tab"
            type="button"
          >
            创建房间
          </button>
          <button
            aria-selected={entryMode === "join"}
            className={entryMode === "join" ? "active" : ""}
            onClick={() => setEntryMode("join")}
            role="tab"
            type="button"
          >
            加入房间
          </button>
        </div>

        {entryMode === "create" ? (
          <form
            className="entry-form"
            data-ui="create-room-form"
            onSubmit={submitCreate}
          >
            <div>
              <p className="eyebrow">成为今晚的主持人</p>
              <h2>开一个新房间</h2>
              <p className="muted">房间与参考图只保存在服务器内存中。</p>
            </div>
            <label>
              你的昵称（可留空随机；将添加 #四位数字）
              <input
                autoComplete="nickname"
                data-critical-kind="input"
                data-critical-label="创建房间昵称"
                data-critical-ui="create-nickname-input"
                data-ui="text-input"
                name="nickname"
                maxLength={24}
                onChange={(event) => {
                  nicknameEditedRef.current = true;
                  setNickname(event.currentTarget.value);
                }}
                placeholder="留空将随机生成"
                value={nickname}
              />
            </label>
            {avatarControl}
            <label>
              房间密码
              <input
                data-critical-kind="input"
                data-critical-label="创建房间密码"
                data-critical-ui="create-password-input"
                data-ui="password-input"
                name="password"
                minLength={4}
                maxLength={128}
                placeholder="至少 4 位"
                type="password"
                required
              />
            </label>
            {error && (
              <p className="form-error" role="alert">
                {error}
              </p>
            )}
            <button
              className="primary-button"
              data-action="create-room"
              data-critical-kind="action"
              data-critical-label="创建并进入房间"
              data-critical-ui="create-room-action"
              data-ui="primary-button"
              disabled={busy}
              type="submit"
            >
              {busy ? "正在创建…" : "创建并进入"}
            </button>
          </form>
        ) : (
          <form className="entry-form" data-ui="join-room-form" onSubmit={submitJoin}>
            <div>
              <p className="eyebrow">朋友已经开场？</p>
              <h2>输入房间连接信息</h2>
            </div>
            {joinConnectionControl}
            <label>
              六位房间码
              <input
                autoCapitalize="characters"
                data-critical-kind="input"
                data-critical-label="六位房间码"
                data-critical-ui="room-code-input"
                data-ui="room-code-input"
                name="roomCode"
                maxLength={6}
                minLength={6}
                placeholder="ABC234"
                required
              />
            </label>
            <label>
              你的昵称（可留空随机；将添加 #四位数字）
              <input
                autoComplete="nickname"
                data-critical-kind="input"
                data-critical-label="加入房间昵称"
                data-critical-ui="join-nickname-input"
                data-ui="text-input"
                name="nickname"
                maxLength={24}
                onChange={(event) => {
                  nicknameEditedRef.current = true;
                  setNickname(event.currentTarget.value);
                }}
                placeholder="留空将随机生成"
                value={nickname}
              />
            </label>
            <label>
              房间密码
              <input
                data-critical-kind="input"
                data-critical-label="加入房间密码"
                data-critical-ui="join-password-input"
                data-ui="password-input"
                name="password"
                minLength={4}
                maxLength={128}
                type="password"
                required
              />
            </label>
            {avatarControl}
            {error && (
              <p className="form-error" data-ui="join-error" role="alert">
                {error}
              </p>
            )}
            <button
              className="primary-button"
              data-action="join-room"
              data-critical-kind="action"
              data-critical-label="加入房间"
              data-critical-ui="join-room-action"
              data-ui="primary-button"
              disabled={busy}
              type="submit"
            >
              {busy ? "正在加入…" : "加入房间"}
            </button>
          </form>
        )}
      </section>
    </main>
  );
}
