# CYRVIS 文档索引

CYRVIS 是在 UI-TARS Desktop 基础上构建的**语音优先桌面 Agent**：
Voice Agent（Qwen Realtime）↔ VoiceBrain ↔ 编排/工具层 ↔ Controller ↔ UI-TARS GUIAgent。

> 文档约定：CYRVIS 过程文档统一放 `doc/`；`docs/` 是上游 UI-TARS 文档，勿混用。
> 当前里程碑：**2026-11-21**，main `c4c49a80`。

## 先看这几份

| 文档 | 内容 |
|---|---|
| [project-status-20261121.md](./project-status-20261121.md) | **总览与交接**：能力、目录、坑与解决、待办、验证 |
| [architecture.md](./architecture.md) | **当前架构**：分层、模块、核心链路、状态与契约 |
| [roadmap.md](./roadmap.md) | 2026-11-21 之后的优先级：真实验收、OTA 往返、工程化 |
| [plan.md](./plan.md) | 本次里程碑收尾计划与恢复开发入口 |
| [voice-architecture.md](./voice-architecture.md) | 语音专题：顶部是 2026-11-21 当前实现说明，后半为历史细节 |
| [gaze-integration.md](./gaze-integration.md) | 眼动：校准、截图识别、聊天回执、主动提醒、绑定执行 |
| [fast-tool-matrix.md](./fast-tool-matrix.md) | 快速工具矩阵：Registry/Router/Broker/MCP/Workflow |
| [cyrvis-orchestration-runtime-20261120.md](./cyrvis-orchestration-runtime-20261120.md) | 编排运行时、调度、自主性、能力合成 |
| [flight-data.md](./flight-data.md) | 真实航班数据源、OTA 配置与限制 |

## 当前实现与专题

| 文档 | 内容 |
|---|---|
| [tool-matrix-capability-map.md](./tool-matrix-capability-map.md) | 工具分类、层级、边界和项目定位 |
| [dynamic-tool-context.md](./dynamic-tool-context.md) | 用户上下文、动态资源、能力绑定与排序 |
| [dynamic-perception.md](./dynamic-perception.md) | 感知 Provider、增量资源、刷新调度、浏览器标签页 |
| [perception-workflow-intent.md](./perception-workflow-intent.md) | 感知/工作流/意图融合设计 |
| [system-awareness.md](./system-awareness.md) | 系统状态、软件发现、Steam、动态能力 |
| [provider-manifests.md](./provider-manifests.md) | Provider manifest、签名、权限、MCP 生命周期 |
| [qwen-doc-ppt.md](./qwen-doc-ppt.md) | Qwen-Doc-Turbo PPT 生成协议与降级链 |
| [cyrvis-companion.md](./cyrvis-companion.md) | 桌面伴侣窗口、外观、语音与生命周期 |
| [development.md](./development.md) | 环境、启动、测试、日志、密钥与常见故障 |

## 过程记录

| 文档 | 用途 |
|---|---|
| [progress.md](./progress.md) | 按时间推进的完成项与待办（顶部含 2026-11-21 里程碑） |
| [findings.md](./findings.md) | 排障结论、模型/接口/音频事实（顶部含 2026-11-21 复盘） |
| [speaker-barge-findings.md](./speaker-barge-findings.md) | 外放打断问题梳理与实测 |
| [speaker-barge-solution.md](./speaker-barge-solution.md) | 外放打断方案评估与工程取舍 |
| [atomic-tooling-handoff.md](./atomic-tooling-handoff.md) | 工具层交接、职责边界与后续缺口 |
| [benchmark-results.md](./archive/benchmark-results.md) | GUI 加速 benchmark 结果（已归档） |

`progress.md` / `findings.md` 是**实时记录**：开发过程中直接追加，不要事后补录。

## 历史归档

历史文档不删除，统一放 [archive/](./archive/)；归档文件顶部有说明，内部相对链接按原
`doc/` 根目录解释。

| 文档 | 说明 |
|---|---|
| [architecture-20261115.md](./archive/architecture-20261115.md) | 2026-11-15 架构；已被当前 architecture.md 取代 |
| [roadmap-20261115.md](./archive/roadmap-20261115.md) | 2026-11-15 路线图；多数项已实现 |
| [plan-20261119.md](./archive/plan-20261119.md) | 2026-11-19 开发计划 |
| [coding-agent-plan-20261119.md](./archive/coding-agent-plan-20261119.md) | 编码 Agent 接入计划（已实现） |
| [gui-acceleration-plan-20261116.md](./archive/gui-acceleration-plan-20261116.md) | GUI 加速实验方案（暂停） |
| [benchmark-results.md](./archive/benchmark-results.md) | GUI 加速基线结果 |
| [architecture-v1.md](./archive/architecture-v1.md) | 2026-11-14 v1 设计 |
| [product-vision-v1.md](./archive/product-vision-v1.md) | 初始产品愿景与 14 天计划 |
| [voice-plan-v1.md](./archive/voice-plan-v1.md) | 早期语音方案对比 |
| [voice-implementation-v1.md](./archive/voice-implementation-v1.md) | 首版语音任务清单 |

## 代码地图

```text
apps/ui-tars/src/main/cyrvis/
  controller.ts                        # GUI 单任务状态机
  gui-adapter.ts                       # runAgent / GUIAgent 适配
  voice-brain.ts                       # 意图、槽位、确认、主动播报、路由
  voice-service.ts                     # 语音单例、IPC、设备、打断/回声
  coding-agent.ts                      # workspace 编码任务
  search-intent.ts                     # 统一意图分类（导航/搜索/比价/任务）
  site-registry.ts                     # 站点别名与站内搜索 URL
  desktop-actions.ts                   # 搜索/开 URL/开应用快速工具
  speaker-barge.ts / speaker-echo.ts   # 打断与回声分析
  keyword-gate.ts                      # 本地 KWS + 声纹
  voice/                               # Omni/Cascade/Provider/工具/确认分类
  orchestration/                       # 调度、自主性、能力合成、运行时记忆
  tools/                               # Registry/Router/Broker/MCP/Workflow
  context/                             # 前台/文件/剪贴板/浏览器感知
  gaze/                                # 校准、识别、聊天、执行、主动提醒
  intake/                              # 通用槽位追问
  travel/                              # 旅游计划、真实比价、OTA
  memory/                              # 记忆
  system/                              # 系统状态

apps/ui-tars/src/renderer/src/components/
  CyrvisVoice/                         # 采集、播放、历史、打断 UI
  CyrvisGaze/                          # 眼动校准与可视化
  CyrvisRuntime/                       # 编排/自主性面板
  CyrvisCompanion/                     # 桌面伴侣
  CyrvisUI/                            # 工作台
  Conversation/                        # 对话与 GazeTurn

apps/ui-tars/resources/cyrvis/         # Python/Node workers（航班、OTA、focus）
packages/ui-tars/                      # 上游 GUI Agent SDK/operator
scripts/cyrvis/                        # 启动、KWS、声纹、benchmark
```

## 文档规则

1. 不提交任何真实 Key、Token、Cookie、日志和个人路径。
2. 当前实现先更新 `architecture.md`，历史方案放 `archive/`，不要直接删除。
3. 关键排障结论写入 `findings.md`，带日志证据和时间。
4. 演示/阶段收尾前更新 `project-status-20261121.md` 或新建对应日期状态文档。
5. 新增 PR 必须先适配当前 `main`，并跑 `vitest.cyrvis.config.ts`。
