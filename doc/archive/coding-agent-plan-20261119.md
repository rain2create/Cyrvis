> **归档（2026-11-21）**：本文记录当时的设计或计划，已不代表当前实现。当前状态见 [../project-status-20261121.md](../project-status-20261121.md) 与 [../architecture.md](../architecture.md)。归档文档内的相对链接按原 `doc/` 根目录解释。

# Coding Agent 接入计划

> 2026-11-19。目标是在 CYRVIS 里接入一个“仓库级代码任务”执行器，同时把确定性文件/内容任务继续留在 Fast tools。

## 1. 目标

- 确定性任务（写文件、打开应用、窗口、剪贴板、搜索、系统信息）走 Fast tools，毫秒级完成。
- 代码任务（多文件修改、补丁、测试、调试）走 Coding Agent，输出 diff 和测试结果。
- GUI Agent 只负责没有 API/CLI、必须看屏幕操作的应用。
- 提供一个可演示的 coding demo，不影响现有语音/外放打断链路。

## 2. 非目标

- 不用 Coding Agent 替代记事本写数字、创建普通文本文件这类确定性任务。
- 不让 Coding Agent 直接控制鼠标键盘；它只操作 workspace 内的文件和命令。
- 不在第一阶段支持自动 commit、push、安装依赖或修改系统配置。

## 3. 现有可复用能力

| 能力 | 位置 | 复用方式 |
|---|---|---|
| Task lifecycle | `controller.ts` | 复用 start/pause/resume/cancel/status |
| GUI adapter | `gui-adapter.ts` | 作为 CodingAgentAdapter 的接口参考 |
| FastToolRouter | `tools/router.ts` | 继续处理确定性工具 |
| Capability broker | `tools/capability-broker.ts` | 统一权限、确认和审计 |
| TaskConversationCoordinator | `task-conversation.ts` | 复用任务播报与终态清理 |
| 语音工具面 | `voice/tools.ts` | 新增 coding 语义入口 |

## 4. 架构

```text
VoiceBrain / Controller
  ├─ FastToolRouter
  │    └─ fs / app / window / clipboard / system / web
  ├─ CodingAgentAdapter
  │    ├─ workspace policy
  │    ├─ coding CLI (Qwen Code / Claude Code / Codex)
  │    ├─ event parser (step / diff / test)
  │    └─ cancel / timeout
  └─ GUIAgentAdapter
       └─ visual-only desktop apps
```

建议把 `TaskSnapshot` 增加 `kind: 'gui' | 'coding'`，或者新增 `CodingTaskSnapshot`，避免语音层把 coding 任务当成 GUI 任务查询。

## 5. Coding backend 选择

| 方案 | 优点 | 风险 |
|---|---|---|
| Claude Code CLI | 已安装；文件读写、命令、diff、测试都成熟 | 需要 Anthropic-compatible endpoint；第三方 endpoint 兼容性要验证 |
| Codex CLI | 已安装；适合代码任务 | 需要 OpenAI-compatible endpoint；协议兼容性要验证 |
| Qwen Code CLI | 与 Qwen plan 最贴合 | 需要安装/配置；模型工具调用能力要验证 |
| 自建 tool loop | 完全可控 | 工作量最大，不建议第一阶段做 |

建议顺序：

1. 用 Qwen plan 的模型列表和一条最小工具调用请求做 probe；
2. 如果 Qwen plan 的 Anthropic-compatible 入口可用，优先包 `claude` CLI；
3. 否则试 `codex` CLI + OpenAI-compatible 入口；
4. 都不稳定时再接 Qwen Code CLI 或自建 loop。

### Phase 0 probe 结果（2026-11-19）

- `@qwen-code/qwen-code@0.28.0` 可以通过 `npx` 启动，读取/编辑文件正常。
- Token Plan 的 `/models` 列出了 `qwen3.8-max`，但 chat completions 实际只接受
  `deepseek-flash` 和 `deepseek-v4-pro`；传 `qwen3.8-max` 会返回 400。
- 已验证 `deepseek-flash` 可用，简单请求约 1.7s；`deepseek-v4-pro` 也可用。
- headless 模式下 `run_shell_command` 需要审批，`-p` 不能交互确认；文件编辑
  可以通过 `auto-edit` 完成。
- `@qwen-code/sdk` 提供 `canUseTool` 回调，可以在 CYRVIS 里把权限请求转成
  语音/UI 确认，不需要自己 PTY 包 CLI。

### 选定接法

```text
@qwen-code/sdk query()
  ├─ model: deepseek-flash
  ├─ cwd: demo workspace
  ├─ permissionMode: auto-edit
  └─ canUseTool: 读取自动允许；shell/危险操作交给 CYRVIS 确认
```

SDK 自带 CLI，不需要全局安装 `qwen`。密钥通过 `env` 传入，不写入 settings。

### SDK probe 结果

在 `D:\temp\cyrvis-coding-sdk-probe` 已跑通：

- `@qwen-code/sdk@0.1.35` + `deepseek-flash`；
- 项目 `.qwen/settings.json` 使用 `modelProviders.openai`、`wireApi: "chat-completions"`；
- `permissionMode: "auto-edit"`，`run_shell_command` 触发 `canUseTool`；
- `canUseTool` 只允许 `node math.test.js`，其余命令拒绝；
- 模型修改了 `math.js`，测试实际执行并返回 `test passed`。

注意：`authType: "openai"` 会让 SDK 走默认 OpenAI 配置并返回 404；不要传该选项，
让项目 `modelProviders` 决定 endpoint。

### 已接入（2026-11-19）

- `apps/ui-tars/src/main/cyrvis/coding-agent.ts`：`CodingAgentService`，SDK `query()`、
  abort、状态、diff、workspace 校验、`canUseTool` 权限钩子。
- 语音工具：`start_coding_task` / `get_coding_status` / `cancel_coding_task`。
- workspace 默认 `D:\Desktop\project\CYRVIS-demo`，可用
  `CYRVIS_CODING_WORKSPACE` 覆盖。
- 当前权限策略：workspace 内读/编辑自动允许；测试命令白名单自动允许；
  其他 shell 直接拒绝。语音确认桥接留到下一阶段。
- 集成验证：真实 SDK 任务在 10.3s 内创建了 `agent-probe.txt`，内容正确。

密钥只从环境变量读取，不写入仓库、不打印到日志。

## 6. 语音工具面

新增语义工具：

| 工具 | 参数 | 作用 |
|---|---|---|
| `start_coding_task` | `instruction`, `workspace` | 在指定 workspace 启动 coding task |
| `get_coding_status` | 无 | 返回任务状态、当前步骤、最后摘要 |
| `cancel_coding_task` | 可选 `task_id` | 取消 coding task |
| `pause_coding_task` / `resume_coding_task` | 无 | 暂停/恢复（如果后端支持） |

路由规则：

- 出现明确代码/仓库意图：`代码`、`项目`、`仓库`、`测试`、`bug`、`接口`、`git`、`文件路径 + 修改` → coding agent。
- 只是创建/写普通文本 → `create_text_file` fast tool。
- 只是打开应用/网页 → `open_app` / `open_site` / `search_web`。
- 需要看页面、点视频、操作无 API 应用 → GUI agent。

## 7. Workspace 与安全

第一阶段只允许一个显式 workspace，例如：

```text
D:\Desktop\project\CYRVIS-demo
```

约束：

- 禁止读写 workspace 之外的路径；
- 禁止读取 `.env`、密钥、浏览器配置等敏感文件；
- 命令使用 allowlist；`git push`、安装依赖、删除目录、系统命令默认拒绝；
- 每次任务限制最大轮数、最大时长和最大输出；
- 取消时杀掉整个子进程树；
- 输出 `git diff --stat` 和测试结果，不自动 commit；
- 所有写文件和命令执行记录到现有 audit。

## 8. 任务生命周期与 UI

```text
starting -> executing -> done
                    ├-> paused -> executing
                    ├-> cancelled
                    └-> failed
```

语音层复用 `TaskConversationCoordinator`：

- 开始：一句简短确认；
- 进度：每 10 秒最多一次，不逐步解说；
- 结束：只播终态，清理旧的 progress 播报；
- 停止：cancel 时先终止 CLI，再发终态事件。

主窗口建议增加一个简短的 coding task 面板：状态、当前步骤、diff 摘要、测试结果。第一阶段可以只写日志。

## 9. 实施阶段

### Phase 0：兼容性 probe（0.5 天）

- 在临时 git 仓库里用 Qwen plan / Claude Code / Codex 各跑一条“新增文件 + 跑测试”任务；
- 记录：模型、endpoint、是否支持工具调用、平均耗时、取消是否生效；
- 不接入 CYRVIS。

验收：至少一个后端能在 2 分钟内完成一个小 patch，并且可以取消。

### Phase 1：CodingAgentAdapter（1–2 天）

- 实现子进程封装、事件解析、超时、取消；
- 复用 controller 的 start/pause/cancel/status；
- 在临时 workspace 里跑通“创建 hello.py + pytest”；
- 输出 diff 和命令日志。

验收：能从代码调用 start/cancel，进程树可清理，workspace 外写入被拒绝。

### Phase 2：语音工具与路由（1 天）

- 新增 `start_coding_task` 等工具；
- 增加代码意图路由；
- 停止/暂停统一处理 GUI 与 coding；
- 接入 TaskConversationCoordinator。

验收：语音说“在 demo 项目里新增一个 health 接口并跑测试”，能启动 coding task，并在完成/失败时播报。

### Phase 3：Demo 与 UI（1 天）

- 主窗口显示 coding task 状态和 diff 摘要；
- 准备 2 个稳定 demo：
  1. 新建 Python CLI + pytest；
  2. 在现有小项目里修一个失败测试。
- 不在 demo 中执行 push、安装依赖或改系统配置。

## 10. 测试矩阵

| 场景 | 预期 |
|---|---|
| 普通文本写入 | 走 `create_text_file`，不启动 coding agent |
| 打开已知应用 | 走 `app.launch`，不启动 GUI/coding |
| 单文件代码新增 | coding agent 完成，diff 正确 |
| 多文件修改 + 测试 | coding agent 完成，测试结果返回 |
| 用户说“停” | CLI 进程终止，不再执行旧动作 |
| 越界路径 | 拒绝并提示 |
| 读取 `.env` | 拒绝并记录 |
| coding agent 超时 | 失败并清理进程 |
| 任务完成后语音 | 只播终态，不播旧进度 |

## 11. 需要决定

1. 第一个 backend 选 Qwen Code、Claude Code 还是 Codex？
2. Demo workspace 固定在哪里？
3. 是否允许 coding agent 自动跑测试/命令，还是每次确认？
4. 是否允许修改现有项目，还是只允许 demo workspace？

## 12. 2026-11-19 实时进度与停止改造

### 目标

1. coding 执行过程中主动播报进度，而不是只在结束时说一句；
2. 把命令输出/工具结果同步到主窗口活动流和日志；
3. coding 完成后自动用 VS Code 打开 workspace；
4. “停 / 停一下 / 停止 / 取消 / 算了”对 GUI 和 coding 任务都立即生效；
5. 允许 coding worker 执行 workspace 内的 `python xxx.py`、`py xxx.py`。

### 实现

- `coding-worker.cjs`
  - 安全命令增加 `python3 xxx.py`、`python xxx.py`、`py xxx.py`；
  - 监听 SDK 的 `tool_use` / `tool_result`，上报“正在运行命令/写入文件/命令完成 + 输出片段”；
  - 对输出做 API key 脱敏，并限制长度。
- `coding-agent.ts`
  - 每个 worker status 更新 `lastMessage` 并触发 status listener；
  - 保留 result/close/timeout 日志与 120 秒 watchdog。
- `voice-brain.ts`
  - running 状态按 8 秒节流播报“编码进度：…”；
  - 完成摘要去掉代码块，避免语音朗读整段代码；
  - 新增 `isStopCommand` / `handleStopCommand`，在 partial/final transcript 阶段直接取消 GUI + coding；
  - “停一下”不再被当成普通对话或仅暂停。
- `voice-service.ts`
  - coding 进度写入 activity 流；
  - 完成时自动 `openApp('vscode', workspace)`，失败回退资源管理器。

### 验收

- 语音说“创建一个 Python 冒泡排序并运行”，应依次听到：任务启动 → 写入文件 → 运行命令 → 命令完成 → 最终结果；
- 执行期间说“停一下”，进程树应被终止，不再产生新的工具动作；
- 完成后 VS Code 打开 `D:\Desktop\project\CYRVIS-demo`；
- worker 独立探针验证 `python progress_probe.py` 输出排序结果，exit code 0。

### 2026-11-19 补充修复（语音不播报 / 打开具体文件）

- 空 transcript 只在**本地 VAD 刚检测到用户说话**（2.5s 内且持续 >=200ms）时当作“停”；否则忽略，避免 Qwen 服务端 VAD 噪声取消主动播报。
- 主动播报的 `session.update` 与 `response.create` 不再连发；等 `session.updated` 后再创建响应，避免用旧指令回答上一段用户音频。
- worker 的 `write_file/edit_file/replace` 事件携带 `filePath`/`changed`；CodingAgentService 维护 `changedFiles`。
- coding 完成后打开最后一个成功写入的文件，而不是只打开 workspace。
- worker 允许 `cd "<workspace>" && python xxx.py` 形式，并校验 cd 目标必须在 workspace 内；修复模型常用命令被误拒的问题。
- 主动播报改为临时 `conversation.item.create` 用户消息 + `response.create`，播报结束后删除临时 item。仅改 session.instructions 会被上一轮用户问题压过，导致“编码完成”变成“请告诉我 Service Demo 位置”。
- 语音进度只播报关键节点：文件写入完成、命令开始、命令结果、最终总结；读取/查找/glob/grep 等中间步骤不再播报。
- 最终播报格式：“编码任务完成。总结：……”，并保留用户要求的运行输出。
