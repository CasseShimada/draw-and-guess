# 游戏模式架构

状态：`0.5.1` 当前实施文档，游戏协议版本仍为 `4`。本次网络入口升级未改变三种
玩法的消息结构或规则。

## Registry 与房间边界

房间只保存真正共享的数据：房间码、密码、玩家、逻辑房主、聊天、头像、连接、
实际主机运行控制和单调递增的会话序号。玩法状态使用判别联合：

```ts
type RoomModeRuntime =
  | { mode: "classic"; state: ClassicModeState }
  | { mode: "reference-copy"; state: ReferenceCopyModeState }
  | { mode: "draw-relay"; state: DrawRelayModeState };
```

三个静态注册的 controller 分别拥有设置、状态转换、私密数据和公开快照生成逻辑。
`GameService` 只处理房间、玩家、会话、连接、聊天、头像、命令信封和公共服务编排。
新增模式必须先注册 controller；未知模式在协议边界和服务启动时拒绝。

公开快照同样按 `game.mode` 判别。经典快照不携带临摹资产，临摹快照不携带答案和
词池，接龙在结果前不携带起始词、猜词、未授权画面 revision、manifest 或本地路径。
需要私密输入的玩家通过绑定 viewer、mode session、actor step 和 revision 的认证
接口取得任务。

## 公共绘制生命周期

所有绘制步骤共享以下生命周期：

```text
drawing
  ├─ 权威主计时到期
  └─ 画手主动完成
          ↓
finalizing（固定 10 秒）
          ↓
finalized
```

主绘制结束时先撤销旧 grant，并为收尾创建新的 `captureSessionId`。当前最后一张
accepted frame 成为 baseline；收尾期间的新 accepted frame 覆盖 baseline。10 秒
到期后才冻结作品并通知模式 controller 推进。收尾 Pass 会立即采用点击前服务器
已接受的画面；主绘制 Pass 仍按各模式自己的交接或退出语义处理。

上传者会收到服务器实际接受的相同编码 bytes、sequence 和 revision。经典模式还会
把当前帧发给观看者；临摹与接龙只回送上传者，避免作品或私密链路提前泄漏。普通
JSON 从不携带图片 Base64。

## Scheduler、暂停与恢复

每个房间有一个可追踪的 `ModeScheduler`。timer 使用稳定 key，回调执行前检查房间、
模式、mode session、actor step 和 phase。切换模式、返回大厅、销毁房间和 shutdown
都会幂等取消全部 timer。

暂停不是玩法 phase。只有启动内嵌服务的 Electron main 持有不可远程伪造的本地主机
控制能力：

```text
running → paused → running
```

暂停原子保存所有 timer 的剩余毫秒、撤销 capture grant，并发送停止上传事件。旧
frame 随 session 失效。恢复后把 deadline 按暂停墙钟时间平移；需要采集的 phase 先
执行统一三秒恢复倒计时，再换发新的 capture session。远程玩家和后来转移得到的逻辑
房主都不能调用暂停或恢复。

逻辑房主仍可在任意 phase 切换模式。切换提交点在服务器，顺序为：

1. 冻结当前玩法并撤销全部 grant；
2. 取消 timer、frame drain、self-preview 与通知；
3. 对正在进行的接龙按房主明确选择保存或丢弃不完整回放；
4. 幂等 `dispose()` 旧 controller；
5. 递增 mode session，创建目标模式 lobby；
6. 只广播目标模式的新快照。

玩家、密码、头像、聊天、会话和逻辑房主保留；答案、私密猜词、参考图、作品、
ballot、ready、帧和旧授权全部失效。

## Pass coordinator

所有页面发送同一个 `turn:pass` 命令信封，公共协调器验证 mode session、
actor step、target、command ID、本人/房主权限与暂停规则，再交给当前 controller
归约。

- 经典：选词时交接完全相同的候选；绘制时交接同一答案与已结算猜词集合。
- 临摹主绘制：只撤回本人的参赛提交；盲选：保留已有点赞并结束本人的 ballot。
- 接龙主流程：把当前玩家收到的不可变输入原样交给下一人，绝不交接本轮私密猜词
  或未完成画；收尾：立即采用当前 accepted frame。

连续 Pass 只沿冻结顺序单向移动，每人每个逻辑步骤至多一次；最后一人 Pass 和全员
Pass 都进入明确结果，不能回绕。暂停期间普通玩家 Pass 拒绝，逻辑房主可代当前
actor Pass；若产生下一计时步骤，它保持冻结，直到实际主机恢复。

## 模式状态图

```text
classic
LOBBY → WORD_SELECTION → DRAWING → FINALIZING → TURN_RESULT
  ↑                                                │
  └──────────── GAME_RESULT ← 下一回合/整局判断 ──┘

reference-copy
LOBBY → PREPARING → COUNTDOWN → DRAWING ⇄ FINALIZING
  ↑                                      ↓
  └──────────── GALLERY ← BLIND_VOTING ──┘

draw-relay
LOBBY → PREPARING → COUNTDOWN → DRAWING → FINALIZING
                                  ↑             ↓
                                  └─ GUESSING ←─┘
                                               ↓
                                             RESULT
```

临摹玩家可独立处于 drawing/finalizing/finalized/passed 子状态。接龙的公开 phase
只说明进度；私密输入和历史在 `RESULT` 前留在 controller 内部。

## 资产与清理

- 经典和临摹每名画手只保留最新 accepted frame，全部仅在房间内存。
- 参考图只在临摹房间内存，静态 PNG/JPEG/WebP 经双端校验和规范化。
- 临摹 ballot item 使用 voter-scoped 随机 ID；作者映射只存在服务端私有状态，
  到 `GALLERY` 才公开。
- 接龙 live slot 仍然 latest-only；只有 replay recorder 可以把已接受帧写入实际
  主机受配额保护的临时 job。
- 最终 MP4 只留在主机本地，不提供 HTTP 下载，不通过局域网或 SakuraFrp 分发。

清理顺序固定为：撤销 grant、停止上传、取消 timer、停止 drain、失效 self-preview
和通知、释放帧、释放模式资产、dispose controller、广播新状态。

## 0.3 → 0.4 迁移计划

1. 协议和共享类型升级为 v4 判别联合，保留四/八字节图片包头。
2. 引入 scheduler、grant、frame store、drawing finalization 和 Pass coordinator。
3. 把经典状态迁入 controller，以 characterization tests 锁定选词、计分和轮次。
4. 接入临摹资产、同步开始、并行绘制、匿名多选点赞与并列获胜。
5. 接入接龙私密任务、单向 Pass、FFmpeg capability 和受限回放 job。
6. Web 端按 mode registry 渲染，Electron main 增加本地主机控制、固定通知和回放
   文件 GUI。
7. 完成 fake clock/process runner 集成测试、打包内容检查与当前平台实机验证。
