# CYRVIS 当前架构

> 最后更新：2026-11-21（PR #11 眼动合并后）
> 本文描述**当前实现**；历史版本见 [archive/architecture-20261115.md](./archive/architecture-20261115.md)。
> 语音专题见 [voice-architecture.md](./voice-architecture.md)（注意其顶部新旧实现说明）。

## 1. 一句话定义

**CYRVIS = 实时语音对话层 + 任务/工具编排层 + UI-TARS GUI 执行层 + 眼动/主动性输入层。**

语音模型不直接点鼠标；所有桌面动作经过 `VoiceBrain` 的意图路由和 `CyrvisController`/编排运行时的任务状态机。

## 2. 运行时拓扑

```text
┌──────────────────────────────────────────────────────────────────────┐
│ Renderer                                                             │
│  VoiceRuntime / useVoiceAudio                                        │
│   ├─ 主窗口麦克风采集（默认 AEC 开启，16 kHz PCM）                    │
│   ├─ 播放队列、播放回执、打断音频参考                                  │
│   └─ 工作台 / 对话 / 眼动 / 伴侣 / Runtime 面板                        │
│                                                                      │
│  CyrvisVoice  CyrvisGaze  CyrvisRuntime  CyrvisCompanion  CyrvisUI   │
└──────────────────────────────┬───────────────────────────────────────┘
                               │ IPC / preload
┌──────────────────────────────▼───────────────────────────────────────┐
│ Electron Main                                                        │
│  VoiceService（单例、IPC、设备/输出模式、回声与打断）                  │
│   ├─ QwenOmniProvider / CascadeVoiceProvider                           │
│   ├─ VoiceBrain：意图、槽位、确认、主动播报、工具路由                  │
│   ├─ OrchestrationRuntime：调度、自主性、能力合成、运行时记忆           │
│   ├─ FastToolMatrix：Registry + Router + Broker + MCP + Provider       │
│   ├─ Gaze：校准/对象/识别/聊天/主动提醒/桌面执行                        │
│   ├─ CodingAgentService：workspace 内代码任务                          │
│   ├─ Travel：Intake + 真实航班比价 + OTA 打开                          │
│   └─ CyrvisController → ElectronGUIAdapter → UI-TARS GUIAgent          │
└──────────────────────────────────────────────────────────────────────┘
```

关键分层：

| 层 | 职责 | 不负责 |
|---|---|---|
| 语音层 | 实时对话、ASR/TTS、打断、回声过滤 | 不直接执行桌面动作 |
| 大脑层 | 意图识别、槽位追问、确认、路由、播报策略 | 不直接驱动鼠标键盘 |
| 编排层 | 任务队列、优先级、暂停/取消、自主建议、能力合成 | 不伪造执行结果 |
| 工具层 | 原子工具、权限、路径策略、审计、MCP | 不做复杂 GUI 规划 |
| GUI 层 | 截图、VLM 决策、点击/输入、结果回执 | 不自行宣布任务完成 |

## 3. 核心模块

| 模块 | 位置 | 当前职责 |
|---|---|---|
| VoiceService | `main/cyrvis/voice-service.ts` | 语音单例、IPC、采集/播放模式、KWS/声纹、能量打断、回声门控 |
| VoiceBrain | `main/cyrvis/voice-brain.ts` | 唤醒、意图、槽位、确认状态机、工具调用校验、主动播报 |
| QwenOmniProvider | `main/cyrvis/voice/qwen-omni.ts` | Realtime WebSocket、工具调用、主动播报队列、精确朗读、播放回执 |
| CascadeVoiceProvider | `main/cyrvis/voice/cascade-provider.ts` | ASR → LLM → TTS 级联路径 |
| Pending intent | `main/cyrvis/voice/pending-intent-classifier.ts` | 对危险操作的语义确认分类 |
| OrchestrationRuntime | `main/cyrvis/orchestration/` | 统一任务调度、autonomy、能力合成、运行时记忆/轨迹 |
| FastToolMatrix | `main/cyrvis/tools/` | 工具注册、路由、确认、路径/权限、MCP、Workflow |
| CodingAgent | `main/cyrvis/coding-agent.ts` | 在 demo workspace 内写代码、运行、返回 diff/结果 |
| Travel | `main/cyrvis/travel/` | 目的地/日期槽位、Google/Ctrip/Trip 比价、打开结果页 |
| Gaze | `main/cyrvis/gaze/` | 校准、注视对象、截图识别、聊天回执、主动提醒、绑定点击 |
| Dynamic context | `main/cyrvis/context/` | 前台/窗口/剪贴板/文件/浏览器标签感知、资源与工具排序 |
| Renderer voice | `renderer/src/components/CyrvisVoice/` | 采集、播放器、历史、打断 UI、播放回执 |
| Renderer gaze | `renderer/src/components/CyrvisGaze/` | 校准与注视可视化 |
| Renderer runtime | `renderer/src/components/CyrvisRuntime/` | 编排任务、自主建议、能力合成面板 |
| Companion | `renderer/src/components/CyrvisCompanion/` | 桌面伴侣外观、气泡、窗口生命周期 |

## 4. 主要链路

### 4.1 语音对话与任务

```text
麦克风 PCM（Renderer，AEC）
  → VoiceService
  → Qwen Realtime（ASR / Function Calling）
  → VoiceBrain 意图与工具校验
  → 本地快速工具 / 编排任务 / CodingAgent / Controller
  → 事件与播报队列
  → Renderer 播放 + 播放回执
```

要点：

- 外放模式默认走“快速能量打断 + 回声过滤 + KWS/声纹”组合；`CYRVIS_SPEAKER_BARGE_FAST=0` 可回退到 VAD 门控。
- 明确停止词优先于模型；停止后排队中的工具调用会被 stop guard 拦截。
- 危险操作（删除、覆盖、关闭应用、越界路径等）进入确定性确认状态；确认后执行，取消则清空。
- 注视播报期间有 readout guard，避免扬声器能量自打断；明确“停”和按钮仍然有效。

### 4.2 确定性工具

```text
VoiceBrain / 模型工具调用
  → FastToolRouter.match
  → 需要确认？ → pending confirmation
  → ToolRegistry.prepare（路径策略、确认钩子）
  → 执行 / Scheduler
  → 结果 + 播报
```

工具层分为：基础原子工具、动态能力目录、Provider manifest、MCP facade、Workflow 引擎。完整设计见 [fast-tool-matrix.md](./fast-tool-matrix.md) 与 [tool-matrix-capability-map.md](./tool-matrix-capability-map.md)。

### 4.3 编码任务

```text
语音/文本
  → VoiceBrain 识别代码请求
  → CodingAgentService
  → 独立 worker（workspace 内）
  → 文件 diff / 命令输出 / 测试结果
  → 完成后主动播报
```

编码任务不进入 GUI 视觉循环；普通文本文件仍走 `create_text_file`/快速工具。

### 4.4 旅游比价

```text
“买机票”
  → Travel Intake（目的地/出发地/日期/天数，一次只问一个缺失项）
  → Google Flights（fast-flights）
  + Ctrip（持久化 Chrome，batchSearch）
  + Trip.com（持久化 Chrome DOM）
  → 统一报价归一化与排序
  → 播报最低价/推荐
  → 打开赢家页面；携程尝试推进到预订/结算页
```

限制：OTA Worker 目前只支持单程；说“待几天”会退化为只查 Google。详见 [flight-data.md](./flight-data.md)。

### 4.5 眼动

```text
校准/追踪
  → 注视区域冻结
  → 截图（隐藏助手浮层）
  → VLM 识别
  → GazeChat 记录（截图/回答/播报阶段）
  → 语音播报 + 播放回执
  → 用户说“打开它/播放它”
  → 绑定注视框 + 首次点击约束
  → CyrvisController → GUI Agent
```

眼动核心、UI、主动提醒和桌面执行见 [gaze-integration.md](./gaze-integration.md)。

### 4.6 编排与主动性

`OrchestrationRuntime` 提供统一任务队列、优先级/资源锁、暂停/取消/重试、自主建议、能力合成和运行时记忆。它与快速工具、CodingAgent、Workflow 共用调度器；UI 在 `CyrvisRuntime`。设计见 [cyrvis-orchestration-runtime-20261120.md](./cyrvis-orchestration-runtime-20261120.md)。

## 5. 状态与契约

| 状态 | 位置 | 说明 |
|---|---|---|
| 语音唤醒/休眠 | `VoiceBrain` | 唤醒词、超时休眠、停止后重新开放 |
| 任务状态 | `CyrvisController` / `orchestration/task-scheduler` | idle → running → paused/cancelling → done/failed/cancelled |
| 待确认操作 | `FastToolRouter` + `PendingIntentClassifier` | 过期、取消、确认后执行 |
| 注视播报 | `GazeChat` | capturing → recognizing → queued → generating → playing → spoken/failed |
| 主动提醒 | `gaze/proactive.ts` | 注视计时、冷却、语音未连接重试 |
| 播放 | `QwenOmniProvider` | 队列、精确朗读、播放回执、readout guard |

接口以源码为准：`voice/provider.ts`、`tools/types.ts`、`cyrvis/types.ts`、`shared/cyrvis.ts`。

## 6. 目录

```text
apps/ui-tars/src/main/cyrvis/
├── voice-service.ts        # 语音单例、IPC、打断/回声/设备
├── voice-brain.ts          # 意图、槽位、确认、主动播报、路由
├── controller.ts           # GUI 单任务状态机
├── gui-adapter.ts          # runAgent / GUIAgent 适配
├── coding-agent.ts         # 编码 worker
├── capture-service.ts      # 旧隐藏采集窗口（兼容路径）
├── speaker-barge.ts        # 能量/回声打断分析
├── keyword-gate.ts         # 本地 KWS + 声纹
├── voice/                  # Omni/Cascade/Provider/工具定义
├── orchestration/          # 调度、自主性、能力合成、运行时记忆
├── tools/                  # Registry/Router/Broker/MCP/Workflow
├── context/                # 动态上下文与感知
├── gaze/                   # 校准、识别、聊天、执行、主动提醒
├── intake/                 # 通用槽位追问引擎
├── travel/                 # 旅游计划、真实比价、OTA
├── proactivity/            # 主动性文档/入口
├── memory/                 # 记忆模块
└── system/                 # 系统状态

apps/ui-tars/src/renderer/src/components/
├── CyrvisVoice/            # 采集、播放、历史、打断 UI
├── CyrvisGaze/             # 眼动校准与可视化
├── CyrvisRuntime/          # 编排/自主性面板
├── CyrvisCompanion/        # 桌面伴侣
├── CyrvisUI/               # 工作台页面
└── Conversation/           # 对话与 GazeTurn 卡片

apps/ui-tars/resources/cyrvis/   # Python/Node workers（航班、OTA、focus）
packages/ui-tars/                # 上游 GUI Agent SDK/operator
scripts/cyrvis/                  # 启动、KWS、声纹、benchmark
doc/                             # CYRVIS 文档；docs/ 为上游文档
```
