export function ThemePreview() {
  return (
    <details className="theme-preview" data-ui="theme-preview">
      <summary>打开主题组件预览与稳定选择器</summary>
      <div className="theme-preview__grid">
        <section className="control-card" data-ui="panel">
          <h4>按钮与状态</h4>
          <div className="theme-actions" data-ui="button-group">
            <button className="primary-button" data-ui="primary-button" type="button">
              主按钮
            </button>
            <button
              className="secondary-button"
              data-ui="secondary-button"
              type="button"
            >
              次按钮
            </button>
            <button className="danger-button" data-ui="danger-button" type="button">
              危险按钮
            </button>
            <button
              disabled
              data-state="disabled"
              data-ui="primary-button"
              type="button"
            >
              禁用按钮
            </button>
          </div>
          <p className="inline-warning" data-state="warning" data-ui="notice">
            警告状态
          </p>
          <p className="inline-error" data-state="error" data-ui="notice">
            错误状态
          </p>
          <p className="resume-banner" data-state="success" data-ui="notice">
            成功状态
          </p>
        </section>

        <section className="control-card" data-ui="form-controls">
          <h4>表单控件</h4>
          <label>
            文本输入
            <input data-ui="text-input" defaultValue="示例文字" />
          </label>
          <label>
            数字输入
            <input data-ui="number-input" defaultValue={60} type="number" />
          </label>
          <label>
            下拉框
            <select data-ui="select-input" defaultValue="classic">
              <option value="classic">经典画猜</option>
              <option value="reference">参考图临摹</option>
            </select>
          </label>
          <label className="check-row">
            <input data-ui="checkbox" defaultChecked type="checkbox" />
            复选框
          </label>
        </section>

        <section className="panel" data-ui="player-list">
          <div className="panel-heading">
            <h4>玩家与聊天</h4>
            <span className="mode-chip" data-ui="mode-badge">
              经典画猜
            </span>
          </div>
          <article
            className="player-row"
            data-role="host"
            data-state="connected"
            data-ui="player-card"
          >
            <span className="avatar">房</span>
            <strong>房主#0001</strong>
            <em>在线</em>
          </article>
          <p className="chat-line chat-line--chat" data-ui="chat-message">
            <strong>玩家#0002</strong>
            <span>这是一条聊天气泡。</span>
          </p>
        </section>

        <section className="control-card" data-ui="game-components">
          <h4>游戏组件</h4>
          <strong className="timer" data-state="urgent" data-ui="timer">
            00:09
          </strong>
          <div className="crop-toolbar" data-ui="drawing-toolbar">
            <button type="button">撤销</button>
            <button type="button">完成</button>
          </div>
          <button className="like-toggle" data-ui="vote-button" type="button">
            喜欢这幅作品
          </button>
          <article className="result-card" data-ui="result-card">
            <strong>回合结果</strong>
            <span>+100 分</span>
          </article>
        </section>

        <section className="control-card" data-ui="dialog">
          <h4>普通弹窗</h4>
          <p>普通弹窗属于可主题化区域。</p>
          <button className="primary-button" type="button">
            确定
          </button>
        </section>

        <section className="control-card" data-ui="empty-state">
          <h4>加载与空状态</h4>
          <p data-state="loading" data-ui="loading-state">
            正在加载…
          </p>
          <p data-state="empty">暂无内容</p>
        </section>
      </div>
      <small>每个示例都展示可长期使用的 data-ui、data-state 或 data-role 接口。</small>
    </details>
  );
}
