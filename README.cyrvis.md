# CYRVIS

**Voice-first desktop agent built on UI-TARS.**

CYRVIS 在 UI-TARS Desktop 之上增加语音大脑与控制器，让用户通过自然语音与桌面 GUI Agent 协作。目标形态：

```
Voice Agent (Qwen Realtime) ↔ VoiceBrain ↔ Orchestration / Fast Tools ↔ CyrvisController
                                      ↑                                      ↓
                         Gaze / Proactivity / Memory              ElectronGUIAdapter ↔ UI-TARS GUIAgent
```

## 当前能力

- **端到端实时语音**：Qwen3.8-Omni-Flash-Realtime，WebSocket，非 ASR→LLM→TTS 级联；
- **语音大脑**：区分聊天与 GUI 任务，只有明确任务才调用 `start_gui_task`；
- **语音打断**：播报中直接说“停 / 停一下 / 别说了 / 赛维斯停止”即可打断；外放模式用本地 KWS + 声纹门控过滤助手自身回声；
- **动态工具矩阵与上下文感知**：系统资源、原生前台事件、最近文件和用户任务会动态生成能力绑定，按相关度调整模型可见工具；内置 VS Code/浏览器 Provider 试点、Provider 延迟激活、未知应用 UI Automation 兜底、上下文预算和本地提醒；
- **双输出模式**：耳机（耳机麦 + 耳机扬声器）/ 外放（耳机麦 + 主机扬声器）；`Ctrl+Alt+X` 始终可用；
- **GUI 任务**：Controller 单任务状态机、暂停/恢复/取消、stall 监测；
- **编码任务**：workspace 内写代码、运行、diff 与结果播报，不进入 GUI 视觉循环；
- **旅游比价**：单程 Google Flights + 携程 + Trip.com，真实报价并打开最低价页面；
- **眼动（实验）**：校准、看图回答、聊天回执、主动提醒、绑定注视对象后执行点击；
- **编排与主动性（实验）**：任务队列、自主建议、能力合成、动态上下文与运行时记忆；
- **可靠性细节**：物理麦克风校验、虚拟麦禁用、断连自动恢复、单实例、关闭到托盘。

> 语音实现（采集/播放分进程、打断阈值、双模式）见
> [doc/voice-architecture.md](./doc/voice-architecture.md)。

## 快速开始

```bash
# 1. 安装
PUPPETEER_SKIP_DOWNLOAD=1 pnpm install

# 2. 配置语音 Key（不要提交）
cp apps/ui-tars/.env.example apps/ui-tars/.env
# 编辑 apps/ui-tars/.env，填入 QWEN_API_KEY

# 3. 启动
pnpm run dev:ui-tars
# Windows 也可运行 scripts/cyrvis/start-dev.cmd
```

首次启动：

1. 允许麦克风权限；
2. 在设置页配置 GUI VLM（火山方舟 Doubao / UI-TARS 等）；
3. 确认 Windows 默认输入是物理麦克风（应用会拒绝 ToDesk 虚拟麦）。

### 本地停词与声纹（外放打断）

外放时的“停”不依赖云端 ASR，使用本地 sherpa-onnx：

```text
models/kws/sherpa-onnx-kws-zipformer-wenetspeech-3.3M-2024-01-01/
models/voiceprint/3dspeaker_eres2net_base.onnx
models/voiceprint/user_embedding.f32
```

- KWS 模型：`scripts/cyrvis/kws/README.md`；
- 声纹录入：运行 `scripts/cyrvis/voiceprint-server/record_voiceprint.py`，再启动 sidecar 并 `POST /enroll`；enrollment 会同时写 `.npy` 和 Node 使用的 `.f32`；
- 默认路径从 `apps/ui-tars` 向上查找 `models/`；可用 `.env` 中的 `CYRVIS_KWS_MODEL_DIR`、`CYRVIS_VOICEPRINT_MODEL`、`CYRVIS_VOICEPRINT_EMBEDDING` 覆盖；
- 阈值默认 `0.35`（混合音频），用 `CYRVIS_KWS_VOICEPRINT_THRESHOLD` 调整；
- 依赖 `sherpa-onnx-node@2.0.1`，已加入 `apps/ui-tars/package.json`。

VLM 接口类型容易混淆：

- 普通按量：`https://ark.cn-beijing.volces.com/api/v3`
- Coding/Agent Plan：`https://ark.cn-beijing.volces.com/api/plan/v3`
- 用错会 401；账户欠费会 403。详见 [doc/development.md](./doc/development.md)。

## 文档

| 文档                                                                                   | 内容                                                 |
| -------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| [doc/project-status-20261121.md](./doc/project-status-20261121.md)                     | **里程碑总览与交接**：能力、目录、坑、待办、验证     |
| [doc/architecture.md](./doc/architecture.md)                                           | **当前架构**：分层、模块、核心链路、状态与契约       |
| [doc/README.md](./doc/README.md)                                                       | 文档索引与代码地图                                   |
| [doc/voice-architecture.md](./doc/voice-architecture.md)                               | 语音专题：当前说明 + 历史打断/回声细节               |
| [doc/gaze-integration.md](./doc/gaze-integration.md)                                   | 眼动校准、截图识别、聊天回执、主动提醒与绑定执行     |
| [doc/fast-tool-matrix.md](./doc/fast-tool-matrix.md)                                   | 前方工具矩阵、路由、安全与 MCP 接口                  |
| [doc/cyrvis-orchestration-runtime-20261120.md](./doc/cyrvis-orchestration-runtime-20261120.md) | 编排运行时、调度、自主性与能力合成                   |
| [doc/dynamic-tool-context.md](./doc/dynamic-tool-context.md)                           | 用户上下文、动态资源、能力绑定、排序与 Provider 激活 |
| [doc/flight-data.md](./doc/flight-data.md)                                             | 真实航班数据源、OTA 登录与单程限制                   |
| [doc/roadmap.md](./doc/roadmap.md)                                                     | 2026-11-21 之后的优先级                              |
| [doc/development.md](./doc/development.md)                                             | 环境、启动、测试、日志、故障                         |
| [doc/atomic-foundation-tools.md](./doc/atomic-foundation-tools.md)                     | 原子基础工具与组合边界                               |
| [doc/atomic-tooling-handoff.md](./doc/atomic-tooling-handoff.md)                       | 工具层交接、后续缺口与开发顺序                       |
| [doc/progress.md](./doc/progress.md)                                                   | 实时进度                                             |
| [doc/findings.md](./doc/findings.md)                                                   | 排障结论                                             |

## 目录

```
apps/ui-tars/src/main/cyrvis/       # Controller、VoiceBrain、Voice、Capture
apps/ui-tars/src/main/cyrvis/voice/  # Qwen Realtime Provider
apps/ui-tars/src/renderer/src/components/CyrvisVoice/
doc/                                 # CYRVIS 文档（docs/ 是上游 UI-TARS 文档）
scripts/cyrvis/                      # 启动脚本
```

当前已经落地：`orchestration/`（调度/自主性/能力合成）、`gaze/`（校准/识别/聊天/执行）、
`tools/`（Registry/Router/Broker/MCP/Workflow）、`travel/`（真实航班与 OTA）、
`intake/`（槽位追问）、`context/`（动态感知）。旧的 `gui/`、`proactivity/` 目录保留说明文档，
实现分别落在 `orchestration/` 与 `proactivity.ts`。

## 分支与协作

- 当前主开发分支：`main`；
- 旧功能分支（`feat/gui-accel`、`feat/mcp-tools`、`feat/ui`、`feat/gaze`、`feat/proactivity`、
  `feat/voice`）仅作历史参考，不再作为合并目标；
- 新 PR 必须先适配当前 `main`，并跑 CYRVIS 回归与真实语音验收；
- 模块边界与后续优先级见 [doc/architecture.md](./doc/architecture.md) 与 [doc/roadmap.md](./doc/roadmap.md)。

## 安全

- 严禁提交 `.env`、日志、electron-store、真实 API Key/Token；
- 日志可能包含模型配置，**不要提交 `*.log`**；
- 提交前按 [doc/development.md](./doc/development.md) 第 9 节检查。

## 上游与许可

基于 [UI-TARS Desktop](https://github.com/bytedance/UI-TARS-desktop)（Apache-2.0）。
本仓库保留上游 LICENSE 与版权声明；CYRVIS 新增代码同样遵循 Apache-2.0。
