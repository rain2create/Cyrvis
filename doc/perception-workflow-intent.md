# CYRVIS 感知、工作流与意图融合 V1

> 实现日期：2026-11-20
>
> 目标：从“周期快照 + 单原子工具”升级为“近实时状态 + 可恢复工作流 + 多模态意图快照”。

## 1. 设计原则

CYRVIS 不以持续采集用户能看到的一切为目标，而是提供三档感知：

1. 低成本环境感知：前台窗口、进程、窗口标题、当前任务和资源状态。
2. 按需高精度观察：文件内容、UI Automation、截图、OCR、选中文本。
3. 注意力感知：眼动、语音和交互历史用于消歧，不单独授权执行。

执行侧遵循：

```text
明确指令
  -> 当前系统与用户意图上下文
  -> 本地原子工具或本地工作流
  -> GUI 兜底
  -> 独立验证
```

## 2. 已实现的 V1

### 2.1 近实时 Windows 运行态监视

- 新增常驻 `scripts/cyrvis/system-runtime-events.ps1`。
- 默认每 500ms 观察进程、可见窗口和前台窗口。
- 仅在进程、窗口或前台语义签名变化时输出，避免内存数值波动导致持续刷新。
- `SystemStateStore.applyRuntimeObservation()` 直接更新内存快照并通知动态上下文。
- 原生前台事件仍保留，并且会立即更新系统快照，不再最多等待 10 秒。
- 全量应用、Steam、磁盘、电池和服务扫描仍按 10 分钟执行。

配置：

```env
CYRVIS_RUNTIME_MONITOR=1
CYRVIS_RUNTIME_MONITOR_INTERVAL_MS=500
```

### 2.2 本地工作流引擎

新增六个工具：

| 工具               | 作用                     |
| ------------------ | ------------------------ |
| `workflow.start`   | 启动依赖 DAG 工作流      |
| `workflow.status`  | 查询最近或指定工作流     |
| `workflow.list`    | 列出活动或历史工作流     |
| `workflow.cancel`  | 取消最近或指定工作流     |
| `workflow.confirm` | 确认当前等待中的敏感步骤 |
| `workflow.resume`  | 恢复中断或暂停的工作流   |

工作流支持：

- 最多 32 个步骤，禁止递归调用 `workflow.*`。
- 依赖关系、循环检测和输出模板。
- 前置条件和后置条件，复用 `condition.check` / `condition.wait`。
- 显式重试和退避。
- 每个原子工具仍经过路径、权限和风险确认。
- 敏感步骤暂停，用户说出“确认”后从当前步骤继续。
- 状态持久化到 `cyrvis-workflows.json`。
- 应用重启后，原先运行中的工作流标记为暂停，等待用户显式恢复。
- 完成、失败、取消和等待确认时通过现有语音链路播报。

典型非 GUI 任务：

```text
下载文件
-> 检查文件存在
-> 解压
-> 提取文本
-> 写入报告
-> 再次验证并通知
```

### 2.3 用户活动与意图融合

新增 `IntentFusionStore` 和 `context.intent`：

- 输入：当前应用、窗口、焦点控件、选中文本、最近用户语音、近期对话、当前任务和最近眼动。
- 输出：活动类型、目标、候选意图、置信度、证据和有效期。
- 活动类型包括 `coding`、`editing`、`browsing`、`watching`、`reading`、`operating`、`idle`。
- 融合结果进入动态模型上下文，也可通过 `context.intent` 显式读取。
- 眼动只在 AI 看屏共享开启时进入意图上下文。
- 眼动和推断活动不能作为执行授权。

### 2.4 眼动能力 fail-open

- 原始眼动光标现在始终先按坐标显示。
- 对象扫描成功后再从坐标光标升级为候选框或锁定框。
- 对象扫描不支持、失败或没有候选时，保留原始眼动光标。
- Windows 不再因为对象吸附不可用而完全看不到眼动光标。

### 2.5 环境依赖降级

`office.create_presentation` 现在采用：

```text
百炼 qwen-doc-turbo（已配置 API Key）
  -> 本机 Microsoft PowerPoint
  -> 配置的通用远端文档 API
  -> 明确失败
```

`qwen-doc-turbo` 使用流式 Chat Completions 的 `skill: [{type:"ppt"}]`
协议，支持模板模式和创意模式。最终下载 URL 会经过 HTTPS、50 MB 上限和
PPTX ZIP 文件头校验后才写入目标路径。

远端 API 必须返回原生 `.pptx` 二进制，不允许用文本伪装 PowerPoint。

```env
CYRVIS_DOCUMENT_API_URL=https://example.com/v1/presentations
CYRVIS_DOCUMENT_API_KEY=
CYRVIS_QWEN_DOC_API_KEY=
CYRVIS_QWEN_DOC_WORKSPACE_ID=
CYRVIS_QWEN_DOC_MODEL=qwen-doc-turbo
```

仅允许 HTTPS，或本机回环 HTTP。远端文件限制为 50 MB，并先写临时文件再替换目标。

## 3. 新增工具与运行时

默认注册工具从 81 个增加到 88 个：

- 新增 6 个 `workflow.*`。
- 新增 1 个 `context.intent`。
- 模型默认工具面仍限制为 24 个。
- 工作流工具通过 `capability.search / describe / invoke` 按需发现，避免挤掉现有动态工具。

后续统一控制面又增加了 25 个计划、任务、自主、能力、轨迹和世界状态工具。
V2 还新增了 `capability.route`，因此当前完整运行态基线为 114 个工具，
基础矩阵为 89 个。

## 4. 安全边界

- 工作流不能递归启动工作流。
- 工作流不能绕过 `ToolRegistry`。
- 高风险原子步骤仍需逐项确认。
- 运行中取消会等待当前原子工具结束，不会假装已经中断底层调用。
- 中断恢复可能重试最后一个原子步骤，调用方必须保证参数可安全重试。
- 眼动只作为指向证据，不产生点击、发送、购买或删除授权。
- 远端文档只接收标题、副标题和文件名，不发送摄像头或屏幕内容。

## 5. 当前仍未完成

- 进程和窗口仍由常驻 PowerShell 每 500ms 做增量观察，不是完整 WinEvent/ETW 原生事件流。
- 当前已加入文件、剪贴板元数据、UIAutomation 焦点和选中文本 Provider；剪贴板内容默认不进入模型。
- 工作流独立步骤顺序执行，尚未实现同层并行、补偿事务和强幂等键。
- 工作流计划仍由模型生成，没有专门的计划编译器和计划预览界面。
- 活动分类目前是规则模型，尚未使用可评估的时序分类器。
- 意图融合尚未持久化用户行为时间线，也未进行长期习惯学习。
- Windows UI Automation 和对象吸附仍缺少专用原生 Provider。
- 远端降级目前只落地演示文稿，文档解析、扫描 PDF 和 OCR 仍主要依赖本地环境。
- 真实摄像头、麦克风、扬声器、PowerPoint 缺失机和远端文档服务仍需现场验收。

## 6. 验证

- 工作流 DAG、模板、确认和恢复测试。
- 意图融合时间窗口与排序测试。
- 系统运行态增量应用测试。
- 演示文稿远端降级测试。
- 眼动对象扫描失败时原始光标回退测试。
- 语音工作流状态查询和确认测试。
- CYRVIS 全量测试和生产构建。
