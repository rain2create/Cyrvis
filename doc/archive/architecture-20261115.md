> **归档（2026-11-21）**：本文记录当时的设计或计划，已不代表当前实现。当前状态见 [../project-status-20261121.md](../project-status-20261121.md) 与 [../architecture.md](../architecture.md)。归档文档内的相对链接按原 `doc/` 根目录解释。

# CYRVIS 当前架构

> 最后更新：2026-11-15
> 本文是**当前实现**的整体架构；语音细节以 [voice-architecture.md](../voice-architecture.md) 为准。
> 2026-11-14 的 v1 设计已归档到 [archive/architecture-v1.md](./architecture-v1.md)。

## 1. 一句话定义

**CYRVIS = UI-TARS GUI Agent（执行手） + Controller（任务脑） + Voice Agent（对话脑） + Gaze（规划中）。**

Voice Agent 不直接驱动鼠标键盘，也不直接调用 GUI Agent；所有任务经过 Controller。

## 2. 运行时拓扑

```
┌─────────────────────────────┐        ┌──────────────────────────────┐
│ 主窗口 Renderer             │        │ 隐藏采集窗口 Renderer        │
│ - 语音条 / 工作台 UI        │        │ - 仅 getUserMedia            │
│ - WAV 分段播放 TTS          │        │ - 不播放声音                 │
│ - 不采集麦克风              │        │ - PCM → 本地 WebSocket       │
└──────────────┬──────────────┘        └──────────────┬───────────────┘
               │ IPC                                  │ ws://127.0.0.1:<port>
               ▼                                      ▼
┌───────────────────────────────────────────────────────────────────────┐
│ Electron Main                                                          │
│  VoiceService                                                          │
│   ├─ CaptureService：隐藏窗口 + 本地 HTTP/WS + PCM 回调                 │
│   ├─ 打断检测：播报中能量阈值 1000 / 150ms / 600ms 预录                 │
│   ├─ QwenOmniProvider：Realtime ASR/TTS、Function Calling、本地 VAD     │
│   ├─ VoiceBrain：意图路由、唤醒、确定性控制、主动播报                   │
│   ├─ DynamicContextStore：用户状态、资源目录、能力绑定、工具面排序       │
│   ├─ ProactivityPolicy：任务事件 → 主动播报                             │
│   └─ CyrvisController → ElectronGUIAdapter → UI-TARS GUIAgent           │
└───────────────────────────────────────────────────────────────────────┘
```

关键点：**采集与播放分进程**。同进程边播边采时，Chrome/Windows 的 AEC 会把麦克风采样归零，
语音打断无法工作；拆分后播放期间采集窗口仍能收到用户语音。

## 3. 模块职责

| 模块                | 位置                                       | 职责                                              |
| ------------------- | ------------------------------------------ | ------------------------------------------------- |
| VoiceService        | `main/cyrvis/voice-service.ts`             | 单例、IPC、采集启动/热插拔、打断检测、双模式      |
| CaptureService      | `main/cyrvis/capture-service.ts`           | 隐藏采集窗口、本地 HTTP/WS、物理麦选择            |
| QwenOmniProvider    | `main/cyrvis/voice/qwen-omni.ts`           | Qwen Realtime WebSocket、ASR/TTS/工具、取消、VAD  |
| VoiceBrain          | `main/cyrvis/voice-brain.ts`               | 意图路由、唤醒、工具校验、确定性控制、主动播报    |
| DynamicContextStore | `main/cyrvis/context/`                     | 用户上下文、动态资源、能力绑定、相关性排序        |
| CyrvisController    | `main/cyrvis/controller.ts`                | 单任务状态机、暂停/恢复/取消、stall、事件总线     |
| ElectronGUIAdapter  | `main/cyrvis/gui-adapter.ts`               | 包装 `runAgent` / `GUIAgentManager`，映射任务事件 |
| ProactivityPolicy   | `main/cyrvis/proactivity.ts`               | 优先级、冷却、静音门控、主动话术                  |
| Renderer            | `components/CyrvisVoice/`、`pages/widget/` | 主窗口语音播放、右侧常驻语音面板                  |

右侧 `widget` 是纯 UI 消费方：只订阅 `cyrvis:voice:state`、转写、回复和
`ControllerEvent`，并通过 IPC 请求唤醒、打断、暂停或取消。它不直接采集
麦克风、不播放音频、不调用模型，因此不会形成第二套语音链路。

启动形态与上游 Desktop 页面不同：主窗口以 `/local` 在后台加载，默认
Computer 模式但不显示；用户只看到右侧 440×620 常驻面板，点击面板中的
Home 按钮后才显示主窗口。主窗口承担 Computer 对话、历史记录和设置入口。
面板置顶层级通过 `widgetOverlayMode` 设置同步。

## 4. 核心链路

### 4.1 语音任务

```
用户语音
  → CaptureService PCM（16k/20ms）
  → QwenOmniProvider.sendAudio
  → 本地 VAD 提交（800ms 静音）
  → Qwen ASR / Function Calling
  → VoiceBrain：意图门控 + 工具校验
  → Controller.startTask → GUIAgent.run
  → 事件 task_started / step_update / task_done
  → ProactivityPolicy → Provider.speak
  → 主窗口 WAV 播放
```

### 4.2 语音打断（耳机 / 外放）

```
播报中采集 PCM
  → 能量 > 1000 持续 150ms
  → 外放模式额外用实际播放 PCM 做参考信号相关性检测
  → provider.bargeIn()（response.cancel + 丢弃残留音频 + 开麦）
  → 广播 response-stopped → 主窗口停播
  → 回灌最近 600ms PCM → 转写“停/取消”
  → VoiceBrain 确定性控制 → Controller 暂停/取消
```

外放模式下，普通 ASR 输入在播放期间保持关闭，但麦克风仍持续用于打断检测。
主进程将麦克风 PCM 与主窗口实际播放的 WAV 参考 PCM 做延迟互相关：明显回声直接
丢弃，明确用户声音触发打断，混合信号则短暂暂停播放继续确认。播放结束后保留
1400ms 尾音窗口，并用文本相似度过滤作为最后兜底。详见
[voice-architecture.md](../voice-architecture.md)。

### 4.3 取消/暂停

- 语音转写命中“停/取消/暂停”时，VoiceBrain 直接调用 Controller，不依赖模型工具调用；
- Controller 调 adapter.cancel/pause；GUI 侧 `AbortController.abort()` + `guiAgent.stop()`；
- 取消只停止后续动作，不回滚已执行的点击。

### 4.4 状态反馈

GUIAdapter 回调 → Controller 事件 → ProactivityPolicy → TTS。
完成/失败/取消只由 Controller 事件产生；Voice Agent 不得自行宣布成功。

## 5. 状态

### 5.1 任务（`TaskStatus`）

`idle → starting → executing → paused / cancelling → done / failed / cancelled`

单任务互斥；同一时间只允许一个 GUI 任务，所有任务有 `taskId`。

### 5.2 语音 UI

| 状态             | 含义                 |
| ---------------- | -------------------- |
| Sleeping / Ready | 未唤醒 / 可说话      |
| Listening        | 正在采集用户语音     |
| Thinking         | 已提交，等待首 token |
| Speaking         | TTS 播放中（可打断） |
| Executing        | GUI 任务执行中       |

## 6. 接口契约（以源码为准）

| 接口              | 文件                | 要点                                                                                                    |
| ----------------- | ------------------- | ------------------------------------------------------------------------------------------------------- |
| `VoiceProvider`   | `voice/provider.ts` | `connect/sendAudio/sendToolResult/cancelResponse/speak/close` + callbacks                               |
| `VoiceToolCall`   | `types.ts`          | `start_gui_task`、`cancel/pause/resume_gui_task`、`get_gui_status`、`confirm_action`                    |
| `ControllerEvent` | `types.ts`          | `task_started/executing/step_update/stalled/needs_user/paused/resumed/cancelling/done/failed/cancelled` |
| `GUIAdapter`      | `types.ts`          | `start(instruction, callbacks)/cancel/pause/resume`；taskId 由 Controller 持有                          |
| `TaskSnapshot`    | `types.ts`          | UI 展示任务状态、步骤、摘要、错误                                                                       |

## 7. 目录

```
apps/ui-tars/src/main/cyrvis/
├── controller.ts
├── gui-adapter.ts
├── voice-brain.ts
├── capture-service.ts
├── voice-service.ts
├── context/       # 用户状态、资源、绑定、前台监控、相关性
├── proactivity.ts
├── types.ts
├── voice/
│   ├── provider.ts
│   ├── qwen-omni.ts
│   └── tools.ts
├── gui/          # 规划：Task Router / MCP / 加速
├── gaze/         # 规划
├── proactivity/  # 规划：触发器/策略/反馈
└── memory.ts     # 最近对话、长期记忆、Activity 持久化

apps/ui-tars/src/renderer/src/components/
└── CyrvisVoice/  # 语音条、WAV 播放器、悬浮窗状态 Hook

apps/ui-tars/src/renderer/src/pages/
└── widget/       # 右侧常驻语音面板
```

## 8. 关键设计决策

| 决策                      | 原因                                                  |
| ------------------------- | ----------------------------------------------------- |
| Controller 是任务唯一权威 | 防止 Voice 误报完成/多任务并发                        |
| 采集/播放分进程           | 同进程 AEC 会归零麦克风，语音打断失效                 |
| TTS 用 WAV 分段文件       | WebAudio/MediaSource 播放同样触发 AEC；普通文件不触发 |
| 语音工具严格校验          | 防止“你好”等闲聊进入 GUI Agent                        |
| 确定性暂停/取消           | 模型可能只说“已暂停”但不调用工具                      |
| 单实例 + 关闭到托盘       | 防止多实例重复语音/音频                               |
| 物理麦校验                | ToDesk 虚拟麦会收到系统回环，产生空转写               |

## 9. 与 v1 设计的主要差异

| v1 设计                                            | 当前实现                                         |
| -------------------------------------------------- | ------------------------------------------------ |
| Voice 在 Renderer 采集/播放                        | 隐藏采集窗口采集；主窗口播放                     |
| `events.ts` / `voice/realtime/` / `voice/cascade/` | `types.ts` / `voice/qwen-omni.ts`（单 Provider） |
| `VoiceWidget.tsx` / `useVoiceState.ts`             | `CyrvisVoiceBar.tsx` / `useVoiceAudio.ts`        |
| GUIAdapter 返回 taskId                             | Controller 生成 taskId，adapter 只执行           |
| 语音 Provider 可插拔多实现                         | 当前 Qwen 实现，接口保留可插拔                   |
| 眼动列为 P0/P1                                     | 尚未进入实现，见 roadmap                         |

## 10. 后续

GUI 加速/MCP/简单任务直连、UI 升级、眼动、主动性的模块边界与分支见
[roadmap.md](./roadmap-20261115.md)。开发环境与故障排查见 [development.md](../development.md)。
