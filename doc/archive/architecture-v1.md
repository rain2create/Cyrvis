# CYRVIS 整体开发框架（归档 v1 设计）

> **归档说明（2026-11-15）**：这是 2026-11-14 的 v1 整体设计，部分接口/目录已被实现取代。
> 当前架构见 [../architecture.md](../architecture.md)；语音实现见 [../voice-architecture.md](../voice-architecture.md)；
> 后续重点见 [../roadmap.md](../roadmap.md)。本文保留设计推演与取舍背景。

> 版本：v1.0  
> 日期：2026-11-14  
> 目标：先交付语音内嵌 Demo，后续接眼动；GUI 执行基座保持 UI-TARS Desktop 不变。

## 1. 一句话定义

**CYRVIS = UI-TARS GUI Agent（执行手） + CYRVIS Controller（任务脑） + Voice Agent（对话脑） + Gaze（后续）。**

核心原则：**Voice Agent 不直接驱动鼠标键盘，也不直接调用 GUI Agent；所有任务必须经过 Controller。**

## 2. 系统分层与进程边界

| 层 | 运行位置 | 职责 | 明确不做 |
|---|---|---|---|
| 主窗口 UI | Electron Renderer | 文本对话、设置、任务历史 | 不持有模型 API Key |
| Widget 悬浮窗 | Electron Renderer | 执行状态、语音状态、暂停/停止、确认 | 不进入 VLM 截图（已 `setContentProtection(true)`） |
| Voice Agent | Renderer 音频 + Main 连接 | 听、说、意图、对话、主动播报 | 不直接操作 GUI |
| Voice Provider | 外部 WebSocket / 本地服务 | ASR、端到端语音、TTS | 不决定任务状态 |
| Controller | Electron Main | 任务状态机、单任务互斥、校验、取消、主动策略 | 不重写 GUI 规划 |
| GUI Adapter | Electron Main | 包装 `runAgent` / `GUIAgentManager` | 不暴露给 Renderer |
| UI-TARS SDK | Electron Main | 截图、VLM 调用、动作执行 | 保持原样，最小侵入 |
| 模型服务 | 外部 API | GUI VLM（Seed 2.1 Lite）、语音模型 | 不保存业务状态 |

```text
┌────────────────────────────────────────────────────────────┐
│ Electron Renderer                                          │
│  主窗口 UI           Widget 语音/状态 UI                    │
│  文本输入、设置       麦克风、播放、波形、停止、确认          │
└───────────────┬──────────────────────────────┬─────────────┘
                │ IPC                          │ IPC
┌───────────────▼──────────────────────────────▼─────────────┐
│ Electron Main                                              │
│  Voice Agent（对话脑）                                      │
│    ├─ Voice Provider 适配（端到端 / 级联）                   │
│    ├─ 意图编译（严格 JSON）                                  │
│    └─ 主动策略 ProactivityPolicy                             │
│  CYRVIS Controller（任务脑）                                 │
│    ├─ 任务状态机 / 单任务互斥 / task_id                      │
│    ├─ 指令校验 / 安全确认 / 取消                             │
│    └─ 事件总线                                              │
│  GUI Adapter → UI-TARS GUIAgent（执行手）                    │
└───────────────┬────────────────────────────────────────────┘
                │ 截图 / 键鼠
         Windows 桌面 / 浏览器
```

## 3. 核心原则

1. **单一任务权威**：同一时间只允许一个 GUI 任务；所有任务有 `task_id`。
2. **Voice 不直连 GUI**：Voice Agent 只能调用 Controller 暴露的工具。
3. **传指令不传原话**：Controller 收到的是规范化 `instruction`，不是 ASR 原始转写。
4. **Controller 是事实来源**：`Done / Failed / Cancelled` 只能由 Controller 事件产生，Voice Agent 不得自行宣布成功。
5. **GUI 基座不改**：复用 `GUIAgent.run()`、`onData`、`AbortSignal` 和 `NutJSElectronOperator`。
6. **UI 不污染截图**：执行时主窗口隐藏；语音 UI 放在已内容保护的 widget。
7. **主动但不越权**：主动播报、追问、建议可以做；主动执行高风险动作不可以。

## 4. 关键链路

### 4.1 语音下发任务

```text
用户语音
  → Voice Agent：意图识别 + 槽位提取
  → tool_call: start_gui_task({ instruction, confidence })
  → Controller：校验、创建 task_id、检查是否已有任务
  → GUIAgent.run(instruction)
  → Controller：task_started 事件
  → Voice Agent：立即确认“好，我来打开 Chrome 搜索……”
```

### 4.2 执行状态反馈（含主动交互）

```text
GUIAgent.onData(status, predictionParsed, conversations)
  → Controller：抽取步骤摘要（不把整张截图/全文丢给语音）
  → 事件：step_update / needs_confirmation / task_done / task_failed
  → ProactivityPolicy：判断是否该说、何时说
  → Voice Agent：TTS 播报
```

主动触发示例：

| 触发 | 条件 | 语音 | 优先级 |
|---|---|---|---|
| 任务开始 | `task_started` | “好，我来处理” | P1 |
| 步骤停滞 | 5s 无新进度 | “这一步有点慢，我还在处理” | P2 |
| 需要确认 | 高风险/歧义 | “你是指 Chrome 窗口吗？” | P0 |
| 任务失败 | `task_failed` | “没成功，原因是……要我重试吗？” | P1 |
| 任务完成 | `task_done` | “完成了，还需要我做什么吗？” | P1 |
| 用户空闲 | 完成后 10s 无输入 | 可选建议，默认关闭 | P3 |

### 4.3 取消与打断

```text
用户说“停” / 点停止 / 按快捷键
  → Voice Agent：取消当前 TTS 播放
  → tool_call: cancel_gui_task
  → Controller：abortController.abort() + guiAgent.stop()
  → 事件：task_cancelled
  → Voice Agent：“已停止”
```

注意：取消是“停止后续动作”，不会回滚已经执行的点击；不能向用户承诺撤销副作用。

## 5. 状态机

### 5.1 任务状态

| 状态 | 进入条件 | 允许动作 | 退出 |
|---|---|---|---|
| `IDLE` | 初始/任务结束 | 接受新任务 | `STARTING` |
| `STARTING` | Controller 校验通过 | 启动 GUIAgent | `EXECUTING` / `FAILED` |
| `EXECUTING` | GUIAgent.run 已启动 | 查询、暂停、取消 | `PAUSED` / `DONE` / `FAILED` / `CANCELLING` |
| `PAUSED` | 用户暂停 | 恢复、取消 | `EXECUTING` / `CANCELLING` |
| `CANCELLING` | 用户取消 | 等待当前动作收束 | `CANCELLED` |
| `DONE` | `finished()` | 新任务 | `IDLE` |
| `FAILED` | 异常/最大步数 | 重试、新任务 | `IDLE` |
| `CANCELLED` | abort 生效 | 新任务 | `IDLE` |

### 5.2 对话状态

| 状态 | 含义 | 允许 |
|---|---|---|
| `IDLE` | 未在听/说 | 等待唤醒/按键 |
| `LISTENING` | 正在采集用户语音 | 打断 TTS、接收语音 |
| `THINKING` | 意图编译/工具调用 | 显示思考态 |
| `SPEAKING` | TTS 播放 | 用户可打断 |
| `WAITING_CONFIRMATION` | 等待用户确认 | 只接受 yes/no/取消 |
| `INTERRUPTED` | 被打断 | 清理音频队列，回到 LISTENING |

## 6. 接口契约

### 6.1 VoiceProvider

```ts
interface VoiceProvider {
  connect(config: VoiceProviderConfig): Promise<void>;
  sendAudio(pcm16: Int16Array): void;
  sendToolResult(callId: string, result: unknown): void;
  cancelResponse(): void;
  close(): void;

  on(event: 'speech_started', cb: () => void): void;
  on(event: 'transcript', cb: (text: string, final: boolean) => void): void;
  on(event: 'tool_call', cb: (call: VoiceToolCall) => void): void;
  on(event: 'audio', cb: (pcm16: Int16Array) => void): void;
  on(event: 'response_done', cb: () => void): void;
  on(event: 'error', cb: (error: Error) => void): void;
}
```

实现：
- `RealtimeVoiceProvider`：Seeduplex / Qwen-Omni / OpenAI Realtime，端到端。
- `CascadeVoiceProvider`：流式 ASR + 意图编译 + 流式 TTS，保底且可控。

### 6.2 Voice → Controller 工具

```ts
type VoiceToolCall =
  | { name: 'start_gui_task'; args: { instruction: string; confidence?: number } }
  | { name: 'cancel_gui_task'; args: { task_id?: string } }
  | { name: 'pause_gui_task'; args: {} }
  | { name: 'resume_gui_task'; args: {} }
  | { name: 'get_gui_status'; args: {} }
  | { name: 'confirm_action'; args: { task_id: string; approved: boolean } };
```

### 6.3 Controller → Voice 事件

```ts
type ControllerEvent =
  | { type: 'task_started'; taskId: string; instruction: string }
  | { type: 'step_update'; taskId: string; step: number; summary: string }
  | { type: 'needs_confirmation'; taskId: string; question: string; risk: 'high' }
  | { type: 'task_done'; taskId: string; resultSummary: string }
  | { type: 'task_failed'; taskId: string; error: string }
  | { type: 'task_cancelled'; taskId: string };
```

### 6.4 GUIAdapter

```ts
interface GUIAdapter {
  start(instruction: string): Promise<{ taskId: string }>;
  cancel(taskId: string): Promise<void>;
  pause(taskId: string): Promise<void>;
  resume(taskId: string): Promise<void>;
  getStatus(taskId: string): Promise<TaskStatus>;
  onEvent(cb: (event: ControllerEvent) => void): () => void;
}
```

## 7. 工程结构

```text
apps/ui-tars/src/main/cyrvis/
├── controller.ts          # 任务状态机、单任务互斥、校验、取消
├── events.ts              # ControllerEvent / VoiceToolCall 类型与事件总线
├── gui-adapter.ts         # 包装 runAgent / GUIAgentManager
├── proactivity.ts         # 主动策略：何时说、优先级、冷却
├── voice/
│   ├── provider.ts        # VoiceProvider 接口
│   ├── realtime/          # Seeduplex / Qwen-Omni / OpenAI 适配
│   ├── cascade/           # ASR + 意图编译 + TTS 保底
│   └── audio-bridge.ts    # main ↔ renderer 音频 IPC
└── voice-ipc.ts

apps/ui-tars/src/renderer/src/components/CyrvisVoice/
├── VoiceWidget.tsx        # widget 语音 UI
├── useVoiceAudio.ts       # 麦克风采集 / 播放 / VAD / 打断
└── useVoiceState.ts       # 对话状态展示
```

## 8. 三个目标的框架可行性

| 目标 | 框架机制 | 验收标准 | 可能失败的原因 | 降级方案 |
|---|---|---|---|---|
| 流畅交流 | 全双工/PTT、流式 TTS、即时确认、打断 | 说完→首音 p50 <1s；打断 <300ms | Provider 延迟高、回声、VAD 误判 | 先 PTT + 本地 TTS；耳机 + echoCancellation |
| 充当大脑 | 严格 tool schema + Controller 校验 + 任务上下文 | 20 句指令准确率 ≥90%；状态不虚报 | 语音模型 FC 不稳定、歧义指令 | 增加文本“指令编译器”，Voice 只负责听说 |
| 主观能动性 | 事件驱动 ProactivityPolicy + 模板/模型生成播报 | 至少 3 类主动行为可用；不刷屏、不打断用户 | 模型乱说、播报过多 | 模板化播报 + 冷却/优先级门控 |

结论：**框架可以支持三个目标，但“流畅”和“主观能动性”不能只靠语音模型本身，必须由 Controller 的事件和策略兜底。** 如果去掉 Controller 或让 Voice 直连 GUI，这三个目标都会变得不可控。

## 9. 非功能指标

| 指标 | 目标 |
|---|---|
| 首音延迟 | p50 < 1.0s，p95 < 1.5s |
| 打断停止 TTS | < 300ms |
| 取消停止后续动作 | < 500ms |
| 指令准确率 | 固定 20 句 ≥ 90% |
| 主动播报频率 | ≤ 1 次 / 5s，用户说话时不说 |
| 单任务并发 | 1 |
| 日志 | transcript、tool call、instruction、task event、costTokens |
| 安全 | 高风险动作必须确认；不在 Renderer 存 API Key |

## 10. 开发顺序

1. **Controller 骨架 + 文本模式**：先让 `start / status / cancel` 在无语音情况下跑通。
2. **音频链路**：麦克风、播放、权限、widget 状态。
3. **语音 Provider**：先接一条能用的 ASR/TTS 链路，再并行 Spike 端到端。
4. **意图与工具**：严格 JSON、校验、确认、歧义追问。
5. **主动策略**：确认、停滞、完成、失败四类先做。
6. **评测与演示**：固定语料、固定任务、录屏。

当前语音实现见 [voice-architecture.md](../voice-architecture.md)；历史任务清单见
[archive/voice-implementation-v1.md](./voice-implementation-v1.md)。

## 11. 风险与降级

| 风险 | 影响 | 降级 |
|---|---|---|
| 语音 Provider 开通/邀测不确定 | 明天无法端到端 | 先用流式级联或本地 ASR/TTS；Provider 接口不变 |
| 端到端 FC 不稳定 | 指令传错 | 加文本指令编译器；Controller 强校验 |
| 回声触发误打断 | 对话不断被打断 | 耳机 + echoCancellation + 本地 VAD 双阈值 |
| widget 进入截图 | GUI 模型看到语音 UI | 已 `setContentProtection(true)`；实测 `desktopCapturer`，必要时截图遮罩 |
| 语音模型虚报完成 | 用户被误导 | Controller 事件唯一事实；Voice 只能播报事件 |
| 主动播报过多 | 用户烦 | 优先级 + 冷却 + 默认保守；建议类默认关闭 |

## 12. 待决策

1. 明天 Demo 用 **PTT（按键说话）** 还是 **VAD 常听**？建议 PTT 保底，VAD 作为增强。
2. 语音 Provider：Seeduplex / Qwen-Omni / 本地级联，取决于今天能拿到的权限。
3. 主动交互默认级别：只播报任务关键事件，还是允许完成后的建议。
4. 是否允许修改 widget 与 `agentRoute` 代码（语音接入需要）。
