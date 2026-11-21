# CYRVIS 项目状态与交接（2026-11-21）

> 本文是当前阶段的**总览与交接入口**。架构细节见 [architecture.md](./architecture.md)，
> 后续计划见 [roadmap.md](./roadmap.md)，历史文档见 [archive/](./archive/)。
> 当前 main：`c4c49a80`（PR #11 眼动合并后）。

## 1. 项目是什么

CYRVIS 是一个**语音优先的桌面 Agent**：用户说一句话，它负责听、看屏幕、操作应用、
写代码、查真实信息并汇报结果。它基于上游 UI-TARS Desktop 的 GUI Agent 运行时，
但不是 ByteDance 官方产品。

一句话链路：

```text
实时语音（Qwen Realtime）
  ↔ VoiceBrain（意图 / 槽位 / 确认 / 播报）
  ↔ 编排与工具层（任务调度 / Fast tools / 编码 / 旅游）
  ↔ CyrvisController
  ↔ UI-TARS GUI Agent
  ↔ 桌面应用与浏览器
```

## 2. 当前能演示什么

| 场景 | 状态 | 说明 |
|---|---|---|
| 实时语音对话 | ✅ | Omni 端到端；也可切 ASR→LLM→TTS 级联 |
| 外放/耳机打断 | ✅ | 快速能量打断、KWS/声纹、回声过滤；明确“停”优先 |
| 确定性桌面操作 | ✅ | 打开应用/网页/文件、窗口、剪贴板、系统信息等 |
| GUI 任务 | ✅ | 视觉模型看屏幕并点击/输入，任务状态可暂停/取消 |
| 编码任务 | ✅ | workspace 写代码、运行、diff、结果播报 |
| 旅游比价 | ✅ 单程 | Google Flights + 携程 + Trip.com，打开最低价页面 |
| 眼动看屏 | ✅ 实验 | 校准、截图识别、聊天回执、重播、主动提醒 |
| 眼动桌面执行 | ✅ 实验 | 绑定注视对象，首次点击限制在洋红框内 |
| 主动性与记忆 | 🟡 实验 | Autonomy、动态上下文、运行时记忆 |
| Linux | ❌ | 未验证 |

## 3. 当前架构（简版）

```text
Renderer（采集/播放/工作台/眼动/伴侣）
  ↕ IPC
Electron Main
  ├─ VoiceService（Qwen Omni / Cascade、AEC、KWS、回声、打断）
  ├─ VoiceBrain（意图、槽位、确认、工具路由、主动播报）
  ├─ OrchestrationRuntime（调度、自主性、能力合成、记忆）
  ├─ FastToolMatrix（Registry/Router/Broker/MCP/Workflow）
  ├─ Gaze（校准、识别、聊天、主动提醒、绑定执行）
  ├─ CodingAgent / Travel / Intake
  └─ CyrvisController → ElectronGUIAdapter → UI-TARS GUIAgent
```

完整模块表、状态机和目录见 [architecture.md](./architecture.md)。

## 4. 目录结构

### 4.1 仓库顶层

```text
apps/ui-tars/                 Electron 应用主体
packages/ui-tars/             上游 GUI Agent SDK / operator
apps/ui-tars/resources/cyrvis/  Python/Node worker（航班、OTA、focus）
scripts/cyrvis/               启动、KWS、声纹、benchmark 辅助
doc/                          CYRVIS 当前文档 + archive/ 历史归档
docs/                         上游 UI-TARS 文档（勿混用）
design/                       品牌、UI、伴侣素材
examples/ infra/ multimodal/  上游示例与基础设施
```

### 4.2 CYRVIS 主进程

```text
apps/ui-tars/src/main/cyrvis/
├── voice-service.ts        # 语音单例、IPC、设备、打断、回声
├── voice-brain.ts          # 意图、槽位、确认、主动播报、工具校验
├── controller.ts           # GUI 单任务状态机
├── gui-adapter.ts          # runAgent / GUIAgent 适配
├── coding-agent.ts         # 编码 worker
├── capture-service.ts      # 旧隐藏采集窗口（兼容路径）
├── speaker-barge.ts        # 能量/回声打断分析
├── speaker-echo.ts         # 文本/音频回声判断
├── keyword-gate.ts         # 本地 KWS + 声纹
├── voice/                  # Omni/Cascade/Provider/工具/确认分类
├── orchestration/          # 调度、自主性、能力合成、运行时记忆
├── tools/                  # Registry/Router/Broker/MCP/Workflow
├── context/                # 前台/窗口/文件/剪贴板/浏览器感知
├── gaze/                   # 校准、识别、聊天、执行、主动提醒
├── intake/                 # 通用槽位追问引擎
├── travel/                 # 旅游计划、真实航班、OTA
├── proactivity/            # 主动性入口文档
├── memory/                 # 记忆模块
└── system/                 # 系统状态
```

### 4.3 Renderer

```text
apps/ui-tars/src/renderer/src/components/
├── CyrvisVoice/            # 采集、播放器、历史、打断 UI
├── CyrvisGaze/             # 眼动校准与可视化
├── CyrvisRuntime/          # 编排/自主性面板
├── CyrvisCompanion/        # 桌面伴侣
├── CyrvisUI/               # 工作台页面
└── Conversation/           # 对话与 GazeTurn 卡片
```

## 5. 运行与配置

### 5.1 最小启动

```powershell
cd D:\Desktop\project\CYRVIS\UI-TARS-desktop
pnpm install
pnpm run dev:ui-tars
```

首次启动：

1. 授权麦克风、屏幕录制、辅助功能/无障碍；
2. 在设置页配置 VLM；
3. 选择物理麦克风与输出设备。

### 5.2 需要的 Key（只列变量名）

| 变量 | 必填 | 用途 |
|---|---|---|
| `QWEN_API_KEY` | ✅ | 实时语音、对话兜底、编码 Agent |
| `QWEN_WORKSPACE_ID` | 条件 | 实时端点要求 workspace 时 |
| `CONVERSATION_API_KEY` | 选填 | 不填复用 `QWEN_API_KEY` |
| `VLM_API_KEY` | GUI 任务 | 视觉模型 Key（火山方舟/豆包等） |
| `VLM_PROVIDER` | GUI 任务 | 例如 `VolcEngine Ark for Doubao-Seed-2.1-turbo` |
| `VLM_BASE_URL` | GUI 任务 | 普通按量 `/api/v3`；Agent Plan `/api/plan/v3` |
| `VLM_MODEL_NAME` | GUI 任务 | 例如 `doubao-seed-2.1-lite` |
| `CYRVIS_QWEN_DOC_API_KEY` | 选填 | 云端 PPT |
| `VOICE_STT_API_KEY` / `VOICE_QWEN_TTS_API_KEY` | 选填 | 仅 cascade/云端 TTS |

配置位置：`apps/ui-tars/.env` 或应用设置页（`%APPDATA%\ui-tars-desktop\ui_tars.setting.json`）。
**不要把 Key、Cookie、日志、私人截图提交到仓库。**

### 5.3 旅游 Demo 额外准备

```powershell
python -m pip install --user fast-flights typing_extensions
python -c "import fast_flights"
```

携程/Trip.com 需要手动登录一次，使用持久化 Chrome profile：

```text
%LOCALAPPDATA%\CYRVIS\ota-profile
```

- 必须可见 Chrome，不能用无头；
- 携程需要 `_bfa` / `FVP` 会话 Cookie；
- 查询时不要关闭弹出的 Chrome；
- OTA 查询 60 秒缓存，同一航线不要并发。

## 6. 关键实现与边界

| 链路 | 关键点 |
|---|---|
| 语音采集 | 默认 Renderer 采集，AEC 始终开启；旧的隐藏采集窗口仅兼容 |
| 打断 | 能量 + 参考音频互相关 + 文本回声过滤 + KWS/声纹；明确停止词最高优先 |
| 确认 | 危险工具进入 Router pending 状态；`PendingIntentClassifier` 处理模糊确认 |
| 播报 | 主动播报 FIFO 队列；每条可带 `readoutId` 和 `exact` 精确朗读 |
| 编码 | 不进入 GUI 视觉循环；只操作 demo workspace；结果必须来自真实执行 |
| 旅游 | 不生成假价格；Google/OTA 失败要说明原因；OTA 只支持单程 |
| 眼动 | 截图冻结、GazeChat 关联、播放回执、首次点击约束；精度未达生产级 |
| 编排 | 任务调度/自主性/能力合成与快速工具共用运行时；默认只建议，不自动执行高风险动作 |

## 7. 踩过的坑与解决办法

| # | 现象 | 根因 | 解决 |
|---|---|---|---|
| 1 | 外放时助手被自己的声音打断 | 麦克风收到“人声 + 扬声器回声”，能量阈值误判 | 主麦克风始终开 AEC；快速能量打断 + 播放参考互相关 + 文本回声过滤；KWS/声纹兜底 |
| 2 | 隐藏采集窗口方案在 Windows 下麦克风归零 | Chrome AEC 把同进程采集采样归零 | 改为 Renderer 主窗口采集 + AEC；旧 CaptureService 仅兼容 |
| 3 | 说“停”后 GUI/编码还在跑 | 模型工具调用已排队，停止只停了播报 | 确定性 stop 路径 + stop tool guard + `markUserStop` 清理任务 |
| 4 | 代码任务被当成 GUI 任务 | 模型把“创建 Python 脚本”理解为记事本操作 | 提示词强制 `start_coding_task`；编码请求优先于 GUI；编码进行中阻止重复文件/GUI 调用 |
| 5 | 编码完成但没有播报 | 任务完成事件早于唤醒/播报队列；首条播报被取消 | `notifyCodingProgress` 守卫 + 完成时唤醒并播报；主动播报队列 pump |
| 6 | 第一条任务播报被跳过 | `pendingSpeak` 单槽被后续消息覆盖 | 改为 FIFO 队列；每条带 `exact` 和 `readoutId` |
| 7 | 旅游推荐后说“买机票”却生成假价格 | 早期用模拟数据 | 改为真实 Google Flights（`fast-flights`），失败明确说明，不静默回退 |
| 8 | 必须说“单程”才比价 | 天数槽位被设为必填 | 天数改为可选、默认 0（单程）；解析“去三亚的机票” |
| 9 | “23号”被追问哪个月 | 日期解析只支持完整日期 | 裸日期按当前/下月推断；只有说月份时才追问具体日 |
| 10 | 携程/Trip 返回空或被风控 | 无头浏览器被反爬；登录态缺失 | 可见 Chrome + 持久化 profile + 手动登录；携程首页先取 `_bfa/FVP` |
| 11 | 携程 `needUserLogin=true` | 登录态过期 | 重新登录同一个 profile；不要换浏览器配置 |
| 12 | 往返机票 OTA 没结果 | Worker 只实现单程 | 当前明确限制；往返只用 Google；后续可补 Worker |
| 13 | Google Flights 解析崩溃 | `fast-flights` 遇到无价格行 | 自定义解析跳过无价行；只保留有效报价 |
| 14 | 携程赢家页面停在列表 | 只打开搜索页不够 | focus worker 点“订票→预订”，等待 `itinerary/checkout` |
| 15 | PR #10 合并会削弱语音 | 删了 pending-intent、echo bypass、弱化编码守卫 | 保留 main 语音逻辑；只采用 PR10 的 UI/编排；`pendingSpeak` 队列改为带 exact |
| 16 | PR #12 无法直接合 | 基于旧控制器，冲突 6 个语音文件 | 改合 #11（眼动核心相同，且适配 main）；#12 的两项额外修复暂不合 |
| 17 | 全量 `vitest` 有加载失败 | e2e/Playwright、electron-log、macOS 原生模块、renderer 别名 | 使用 `vitest.cyrvis.config.ts`；SDK 测试单独跑；不要把环境失败当代码失败 |
| 18 | macOS `/var` 与 `/private/var` 路径误判 | 符号链接未 canonicalize | PathPolicy 对根和目标同时 canonicalize；Windows 专属测试跳过 |
| 19 | 设置页 Key 与 `.env` 不一致 | 设置页保存值优先 | 先看设置页，再看 `.env`；不要在两处填不同 Key |
| 20 | 主动眼动重复建历史会话 | 页面切换/休眠重置会话 | GazeChat + gaze session 映射；只有 New chat 才重置历史 |

## 8. 已知限制与待解决

| 优先级 | 问题 | 影响 | 建议 |
|---|---|---|---|
| P0 | 真实设备未完成最终验收 | 语音外放、眼动精度、OTA 登录都可能因设备/网络变化 | 按 [plan.md](./plan.md) 的 6 项验收逐条跑 |
| P0 | OTA 往返不支持 | “待几天” Demo 只剩 Google | 补 Worker 往返查询，或 Demo 固定单程话术 |
| P1 | OTA 依赖 DOM/登录态 | 携程/Trip 改版或登录过期会失败 | 增加登录检测、结构告警、失败截图/日志 |
| P1 | Trip 赢家只打开航班页 | 不如携程直接到结算页 | 补 Trip 预订流程 |
| P1 | Doubao Seed 紧凑 GUI 提示词对所有本地任务生效 | 复杂 GUI 任务可能退化 | 评估仅对注视绑定任务启用 |
| P1 | 注视播报 45 秒 readout guard | 普通说话不会打断播报 | 确认产品预期；保留明确停止词优先 |
| P1 | 眼动校准精度 | 真实摄像头/屏幕组合差异大 | 真人复测；失败时重新锁定，不强行点击 |
| P2 | PR #12 的两项修复未合 | 外放回声校验、GUI 图像压缩暂缺 | 需要时单独移植，不整体合 #12 |
| P2 | 主动性/记忆隐私边界 | 剪贴板/文件/眼动截图涉及敏感数据 | 默认关闭或明确开关、脱敏、审计 |
| P2 | GUI 性能基准暂停 | 没有新的延迟/成功率基线 | 恢复固定任务集后再优化 |
| P2 | CI 测试矩阵不统一 | 默认 vitest 含环境失败 | 在 CI 明确使用 Cyrvis + SDK 两套配置 |
| P2 | 文档历史较多 | 容易读到旧方案 | 以本文件 + architecture.md 为准；旧文档已归档 |

## 9. 合并与分支记录

| 时间 | 内容 |
|---|---|
| 2026-11-19 | 眼动/语音整合分支完成，后续进入 PR |
| 2026-11-20 | PR #10：编排运行时、自主性、能力合成、伴侣/工作台 UI |
| 2026-11-21 | 合并 PR #10（`7511335d`），保留 main 语音行为 |
| 2026-11-21 | 合并 PR #11（`c4c49a80`），眼动聊天/播报/执行 + 对象吸附 |
| 2026-11-21 | PR #12 未合并：眼动核心与 #11 相同，额外为回声校验/GUI 压缩 |

## 10. 验证命令

```powershell
# 类型检查
cd apps/ui-tars
npx tsc --noEmit -p tsconfig.node.json --composite false
npx tsc --noEmit -p tsconfig.web.json --composite false

# CYRVIS 主回归（推荐）
npx vitest run --config vitest.cyrvis.config.ts

# GUI SDK 回归
cd ../../packages/ui-tars/sdk
npx vitest run tests/Model.test.ts tests/GUIAgent.test.ts tests/utils.test.ts
```

本里程碑结果：

| 检查 | 结果 |
|---|---|
| typecheck:node | ✅ 0 错误 |
| typecheck:web | ✅ 0 错误 |
| CYRVIS 回归 | ✅ 79 文件 / 536 用例 |
| SDK 回归 | ✅ 32 用例 |
| 默认全量 vitest | 566 用例通过；7 个文件因 e2e/Electron/别名环境加载失败 |

## 11. 文档与归档策略

- **当前权威**：本文件、[architecture.md](./architecture.md)、[voice-architecture.md](./voice-architecture.md)
  顶部“当前实现”说明、[gaze-integration.md](./gaze-integration.md)、[fast-tool-matrix.md](./fast-tool-matrix.md)。
- **过程记录**：[progress.md](./progress.md)、[findings.md](./findings.md) 继续按时间追加。
- **历史归档**：`doc/archive/`。旧的 architecture/roadmap/plan/编码计划/GUI 加速计划已归档，
  没有删除；保留是为了复盘设计取舍和踩坑证据。
- **上游文档**：`docs/` 属于 UI-TARS 上游；CYRVIS 专属眼动/感知文档已迁回 `doc/`。

## 12. 下一步

1. 按 [plan.md](./plan.md) 完成真实设备验收；
2. 验收通过后，按 [roadmap.md](./roadmap.md) 决定 P1（OTA 往返、GUI 提示词范围、Trip 结算）；
3. 需要恢复 GUI 优化时，再单独移植 PR #12 的两项修复；
4. 任何新 PR 先合当前 main，再跑 CYRVIS 回归和真实语音验收。
