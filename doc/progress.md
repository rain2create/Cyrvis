# CYRVIS 进度

## 2026-11-21：里程碑收尾

- [x] 合并 PR #10：编排运行时、自主性、能力合成、伴侣/工作台 UI、桌面感知与文档工具。
- [x] 保留 main 语音行为：确定性确认、pending-intent、确认回声绕过、stop/barge 守卫、编码进度守卫、FIFO 主动播报。
- [x] 合并 PR #11：眼动聊天/播放回执、主动提醒、绑定注视执行、对象吸附修复；解决 2 处冲突。
- [x] 不合并 PR #12：眼动核心与 #11 相同，额外为外放回声校验/GUI 压缩；当前不引入。
- [x] 文档整理：新增当前 `architecture.md`、`project-status-20261121.md`、`roadmap.md`、`plan.md`；旧架构/路线图/计划归档到 `doc/archive/`；CYRVIS 专属眼动/感知文档从 `docs/` 迁回 `doc/`。
- [x] 验证：Node/Web typecheck 通过；CYRVIS 79 文件 536 用例通过；SDK 32 用例通过；默认全量 vitest 566 用例通过，7 个环境/别名加载失败。
- [x] 当前 main：`c4c49a80`；项目进入阶段收尾，下一步按 `plan.md` 做真实设备验收。

## 2026-11-19：语义工具与动态工具统一

- [x] 语音模型只暴露 `search_web`、`open_url`、`open_app`、`open_site` 这些语义入口；重复的动态搜索/网址/启动入口从语音工具列表隐藏，Registry/MCP 能力保留。
- [x] 语义入口经 capability broker 执行底层工具，统一可用性、权限、路径确认和使用审计；保留站内搜索、搜索引擎/站点过滤、静默打开、应用目标和 GUI 后续任务。
- [x] `capability.invoke` 按实际目标工具检查导航/知识意图，补齐旧入口的确定性防重复，并去重同一回合并发的导航调用；新请求可立即继续操作。
- [x] 复用原有浏览器前台化、macOS Safari 搜索和已知应用定位；应用启动失败会返回错误。
- [x] 验证：node/web typecheck 通过，CYRVIS 23 个测试文件、227 项测试通过（新增 19 项回归测试）。尚未做真人语音及真实桌面应用验收。

### 动态工具矩阵与动态感知

- [x] 通用动态感知：新增 `PerceptionProvider`、`PerceptionScheduler` 和 `IncrementalResourceStore`，支持运行时注册/注销、独立周期、并发保护、超时、指数退避和 TTL。
- [x] 浏览器动态资源：新增 Chrome/Edge DevTools `BrowserPerceptionProvider`，标签页按稳定 target ID 注册为动态资源，并绑定 `browser.activate_tab`、`browser.close_tab`。
- [x] 动态验证闭环：浏览器工具执行后立即刷新感知；关闭标签页后重新读取 target 列表，目标消失才判定验证成功。
- [x] 动态工具面：活动窗口关联 Provider 后，相关工具按资源相关性进入 ToolSurface；资源上下文会列出标签页标题、URL 和当前活动标记。
- [x] 验证：与上游最新导航/语音改动合并后，CYRVIS 测试 255 passed、5 skipped；Node/Web 类型检查、目标 ESLint 和生产构建通过；动态基准 P50 18.7ms、P95 31.0ms。
- [x] 动态工具上下文核心：新增 `UserContextStore`、`ForegroundMonitor`、`ResourceCatalog`、`BindingResolver`、`RelevanceEngine` 和 `DynamicContextStore`。
- [x] 用户状态：跟踪前台应用/窗口、焦点控件、选中文本、最近请求、最近工具动作、最近文件和网址、当前任务；临时状态带 TTL，凭据特征内容不保留。
- [x] 资源与绑定：应用、Steam、窗口、最近文件/网址进入统一资源目录；Provider 能力绑定到具体资源，活动资源相关工具获得更高排序。
- [x] 动态工具面：`ToolSurface` 根据上下文提升活动资源和未知应用 UI Automation 能力的激活及排序，仍限制最多 24 个模型可见工具。
- [x] 未知应用兜底：无 Provider 的活动应用会提升 `ui.inspect`、`ui.action`、截图和 OCR；可在有 `ui.*` 工具的平台上进入通用 UI 自动化路径。
- [x] Provider 延迟激活：manifest 新增 `activation.mode=foreground`，外部 Provider 在匹配应用进入前台前保持等待，前台变化后重新协调。
- [x] 上下文工具：新增 `context.snapshot` 和 `context.resources`，支持查询当前用户状态、动态资源和绑定。
- [x] Windows 原生前台事件：新增 `foreground-events.ps1`，通过 `EVENT_SYSTEM_FOREGROUND` 低延迟更新活动窗口；轮询保留为兜底。
- [x] 系统最近文件：全量扫描读取 Windows Recent 目标路径，过滤敏感文件名后进入动态资源目录。
- [x] Provider 试点：新增内置 VS Code Provider（打开文件/文件夹）和浏览器 DevTools Provider（标签页列表、打开、切换、关闭）。
- [x] 绑定执行闭环：新增 `executeBinding`，使用资源默认参数经过 ToolRegistry 执行，并支持路径、进程、窗口和工具自报验证。
- [x] 用户上下文界面：语音条显示活动应用，支持清除临时上下文；新增 IPC 和 preload 接口。
- [x] 上下文预算：新增 `CYRVIS_CONTEXT_MAX_CHARS`，限制模型上下文总长度。
- [x] 通知与计时器：新增 `system.notification`、`timer.create/cancel/list`。
- [x] 文档与压缩工具：新增 DOCX/XLSX/PPTX 文本提取、可选 `pdftotext` PDF 提取、ZIP 创建和解压。
- [x] 性能基准：381 个资源、2206 个绑定、81 个注册工具下，刷新 P50 19.1ms、P95 32.7ms。
- [x] 验证：完整 CYRVIS 测试 227 passed、5 skipped；Node/Web 类型检查与生产构建通过。
- [x] QQ 浏览器启动修复：Program Files 只读路径检查不再触发敏感确认，新增 QQ 浏览器别名和安装路径解析，`打开QQ浏览器` 直接走 `app.launch`。
- [x] 删除确认修复：支持“是的、对呀、好的、删了吧、直接执行、我已确认”等 pending 回复，自然确认不再交给模型重新搜索；删除后校验目标路径已消失。
- [x] 混合确认意图：确定性规则无法判断时，将回复、pending action memory 和最近上下文交给轻量 LLM，仅接受高置信度结构化 `confirm/cancel`，LLM 不直接执行工具。

## 2026-11-18

- [x] 新增 `search-intent.ts`：识别显式/隐式搜索需求。示例：“我要去巴黎的机票” -> `去巴黎的机票`，“我想买一个降噪耳机” -> `买一个降噪耳机`，“今天天气怎么样” -> `今天天气`；本地任务（查电脑配置、写代码）不误判。
- [x] 语音唤醒扩展：高置信搜索意图可在不说 “Hello CYRVIS” 时自动唤醒；`VoiceBrain` 日志新增 `[cyrvis intent] {mode, query, target, silent, siteSearch}`。
- [x] GUI 误路由兜底：当模型把纯搜索请求交给 `start_gui_task` 时返回 `USE_SEARCH_WEB`，要求改用 `search_web(query=...)`；真正需要点击/输入/预订的指令仍允许 GUI。
- [x] 统一意图分类 `classifyVoiceIntent`：navigate / search / answer / compare / task / chat / ambiguous；支持 `silent`（“我自己看/别念”）和 `siteSearch`（“打开B站搜一下猫”）。
- [x] 内部知识优先：稳定知识（人物介绍、历史、概念、通用教程、软件怎么用）走 `answer`，直接回答不搜索；只有实时/最新信息、具体地点商家、明确搜索或要求来源时才 `search_web`。`search_web` 收到 answer 模式返回 `ANSWER_FROM_KNOWLEDGE`。
- [x] 站点导航：新增 `site-registry.ts`（B站/淘宝/京东/YouTube/知乎/微博/小红书/抖音/百度/Google/Bing/GitHub）和 `open_site` 工具；纯导航只开页面，不读摘要；站内搜索直接打开站点搜索页。
- [x] 导航误路由兜底：`search_web`/`start_gui_task` 收到“打开B站”时返回 `USE_OPEN_SITE`/`USE_OPEN_APP`；含点击/输入的指令仍允许 GUI。
- [x] 页面前台化：`openSearch`/`openUrl` 打开 Windows 浏览器后调用 `scripts/cyrvis/focus-browser.ps1`，还原最小化窗口并置前；实测 Edge 最小化时 `ok:true`。
- [x] 麦克风回退：默认输入是 ToDesk 虚拟麦时自动切换到物理麦克风（优先 cc ultimate/耳机/蓝牙），找不到物理麦时明确报错；新增 `mic capture ready`/`audio device changed` 日志。
- [x] 平台化搜索：Windows 用 Bing 结果页，macOS 用 `open -a Safari`（失败回退默认浏览器）；`defaultSearchEngine()` 在 macOS 默认 Google，其余平台默认 Bing。
- [x] 提示词强化：明确“外部信息需求”优先 `search_web`，导航用 `open_site`，并给出“我要…/我想…”示例；本机应用/文件/点击/预订仍走 `open_app`/`start_gui_task`。
- [x] 多站比价骨架：新增 `travel-search.ts`（携程/去哪儿/飞猪 URL 适配器、城市码、报价/错误类型、确定性最低价/最快/综合推荐）与 `doc/travel-search.md`；抓取 `search()` 暂为 TODO，未暴露语音工具。
- [x] 验证：`npm run typecheck`（node+web）通过；CYRVIS 测试 146/146 通过（新增 search-intent、site-registry、voice-brain 导航用例）。

## 2026-11-16

- [x] GUI Agent Action Batching：`GUIAgent` 已支持同轮执行多个 `parsedPredictions`；给 `DOUBAO_1_5_15B` 提示词加入受限多动作规则（2–4 个、空行分隔、仅限可预测序列）。
- [x] 增加 `[GUIAgent] action batch {count, types}` 日志与批内 200ms 动作间隔。
- [x] 无执行探针验证：安全序列“输入后回车”返回 2 条动作；打开命令面板的序列仍只返回 1 条。
- [x] 端到端验证：日志确认单轮执行 `type` + `hotkey(enter)`，总循环 3 次（逐条约 4 次）；但目标窗口焦点错误，文本未落盘，模型误报完成。
- [x] 收紧提示词：click+type 仅在截图中已见文本光标时允许；`finished` 前必须核对最新截图。
- [x] parser 26/26 测试通过；新增 SDK 单测“一次响应 2 个动作只截 1 次图”，GUIAgent 5/5 通过；App main typecheck 通过；SDK 已重新构建。
- [x] 干净复测通过：记事本已聚焦、光标在末尾、不点击；模型一轮返回 `type` + `hotkey(enter)`，总 `loopCnt=2`，截图确认 `PRE batch test`、光标到第 2 行第 1 列。任务未要求保存，文件标题仍带 `*`。
- [x] 制定 GUI 加速实验方案 `doc/archive/gui-acceleration-plan-20261116.md`：第一批只跑 4 个任务——L1 记事本（批量友好）、L4 本地搜索→新标签→详情（状态依赖）、L5 跨应用读码→保存（跨窗口）、R1 携程上海→巴黎机票（真实长任务）。L2/L3/L6/L7/R2/R3 进候选池。按分组汇报，避免只用 batch-friendly 任务。MCP/直连本轮不做。
- [ ] 可选下一步：把 `loopIntervalInMs` 1000→300 做对比；或增加“输入后保存文件”的任务验证带对话框的批量边界。
- [x] 开始 ShowUI-2B 接入：模型下载到 `D:\Desktop\project\CYRVIS\models\ShowUI-2B`，Python 环境 `D:\Desktop\project\CYRVIS\showui-env`；侧车 `scripts/cyrvis/showui-server/app.py`、`run-showui.ps1`、映射 README 已写。
- [x] Benchmark harness 初版：`scripts/cyrvis/bench/`（本地站点 server、L1/L4/L5/R1 setup、CDP run-task、README）。
- [x] 基线 B0（Seed 2.1 Lite，每任务 1 次）：L1 成功 6 轮/48.6s/0 批量；L4 成功 11 轮/104.5s/1 次批量（type+Enter）；L5 成功 4 轮/29.4s/0 批量；R1 携程超时失败 27 轮/300s/20.5 万 tokens（卡在目的地下拉/日期选择）。结果记录在 `doc/archive/benchmark-results.md`。
- [x] CUDA PyTorch 2.11.0+cu128 在 RTX 5060 上验证可用（`torch.cuda.is_available()=True`）；ShowUI-2B 下载完成（约 4.2GB）。
- [x] ShowUI-2B 侧车跑通：BF16 占用 4.12GB，2.3–3.4s/步，1MP 输入；L4 网页任务成功 5 轮/35.4s（Seed 11 轮/104.5s）；L1/L5 桌面任务失败，原因是动作空间没有 `hotkey`/`Ctrl+S`/跨应用能力，模型卡在 `SCROLL`。
- [x] 修复侧车坐标异常：`1<v<=100` 按百分比归一化（45→0.45），>100 按像素；修复后 L4 通过。侧车 keep-alive 改为 120s，待复测连接错误。
- [ ] 恢复 App 的 Ark 配置并重启；ShowUI 侧车保留为可选的网页任务后端。下一步评估“按任务类型路由”（浏览器→ShowUI，桌面→Seed）或给侧车加快捷键桥接。
- [x] 修复“暂停/取消”双回复与截断：控制事件不再触发主动播报；工具结果/主动播报在 `playbackBusy` 时排队，等渲染端真正播完再发；`ttsSpeaking` 保持到 `playback-idle`；渲染端不再在新响应开始时无条件 `stopPlayback()`；确定性控制与工具调用去重。57/57 测试通过。
- [x] 修复外放/耳机路由：去掉硬编码 `扬声器 (Realtek`；耳机模式显式选耳机设备，不再只用 `default`；外放模式动态找扬声器（优先模拟/HDMI，排除 Digital Output/ToDesk/耳机）；语音条新增输出设备下拉框；模式和设备持久化。当前机器只枚举到 Realtek 扬声器/NVIDIA/ToDesk，没有耳机输出（需把耳机作为输出设备连接）；默认已从错误的 Realtek Digital Output 改为 `扬声器 (Realtek High Definition Audio)`。
- [x] 解耦“输出设备”和“语音模式”：选择扬声器不再自动切语音模式；输出由下拉框独立控制。
- [x] 外放模式改为**语音打断**：播放期间保留麦克风能量检测，阈值 2000 / 180ms（`CYRVIS_SPEAKER_BARGE_THRESHOLD` 可覆盖），600ms 预录回灌，播放后仅 100ms 尾音保护；`Ctrl+Alt+X` 继续兜底。外放不再半双工丢麦。57/57 测试通过，node/web typecheck 通过。
- [ ] 真机复测外放打断：需要入耳麦连接；观察 `[cyrvis capture] level { playing: true, avg/peak }` 与 `barge-in { mode: 'speaker', threshold: 2000 }`；若外放串音误触发，调高阈值。
- [x] 两种模式自动化：**耳机模式** = 蓝牙耳机麦 + 蓝牙耳机输出；**外放模式** = 蓝牙耳机麦 + 主机 Realtek 扬声器。模式按钮现在自动切 Windows 默认端点（`scripts/cyrvis/audio/set-default-output.ps1`，PolicyConfig）、切 App `<audio>.setSinkId`、重启采集但保持耳机麦。实测双向：耳机→默认/输出 Bluetooth，外放→默认/输出 Realtek。
- [x] 修复“说不出话”根因：13:52 语音处于 sleep，ASR 把“哈喽，塞维斯”转成文本但旧唤醒词不匹配（缺“哈喽/塞维斯/Zawis”），回复文本生成了但 `awake=false` 导致音频被丢弃。已补唤醒词变体、睡眠时输出 `asleep; transcript ignored` 日志；当前 `awake=true`。
- [x] 修复外放“我一直我在”自听循环：日志显示外放时麦克风串音 3933–13183，远高于阈值 2000；barge-in 把助手自己的“我在”送进 ASR，模型自问自答。已加自听转写过滤（“我在/我来/我”等直接丢弃）、每次回复 600ms 串音探测（>1500 自动禁用本次语音打断，`Ctrl+Alt+X` 仍可用），并补单测；58/58 通过。
- [x] **Qwen 语音切到 Token Plan**：新 `sk-sp-…` Key 在公共 DashScope 返回 401；Token Plan host 为 `token-plan.maas.qianwenaiapi.com`，模型列表含 `qwen-audio-3.0-realtime-plus`（无 flash）。Realtime WS `wss://token-plan.maas.qianwenaiapi.com/api-ws/v1/realtime?model=qwen-audio-3.0-realtime-plus` 用 App 兼容 `session.update` 实测 `session.updated` 成功；`.env` 已设 `QWEN_MODEL/QWEN_VOICE/QWEN_REALTIME_URL`，App 重启后日志 `qwen session ready`、`qwen connected`、`wake`。
- [x] 蓝牙耳机 `cc ultimate` 已重新连接，采集 `ready`；App 当前外放模式（耳机麦 + Realtek 扬声器）。
- [x] 修复外放“只回 Hello 就断”：旧串音探测从 `response.created` 起算 600ms，但首段音频约 800ms 后才到，测到的是静音；播放后串音 11158 误触发 barge，取消回复。现改为**首段音频开始测 1200ms**，同时看平均/峰值；检测到串音或自听则 60 秒内关闭外放语音打断。实测：`high speaker leakage { avg: 1060, max: 4488 }` 后无 `barge-in`，回复完整播完；日志 0 次误 barge。
- [x] 修复 Token Plan plus 的 **30 秒输入缓冲上限**：空闲噪声持续 append 但不 commit，服务端报 `Input audio buffer exceeded maximum duration (30s)` 并刷屏。已加每 15 秒空闲 `input_audio_buffer.clear`，服务端 `error` 时关闭旧连接并重连。实测 3 次 trim、0 次 30 秒错误。
- [ ] 测试音频 `hello-cyrvis.wav` 实际内容是 “Hello service, open Notepad and type hello”，复测时误触发了一个记事本任务（已结束）；后续自动化测试改用纯唤醒词 WAV。
- [x] 修复冷却期“完全打断不了”：原来 `speakerBargeSuppressed` 直接 return 60 秒；改为自适应门槛（500ms 能量窗口中位数×3，冷却期最低 2500）。外放朗读时句子间说“停”仍可打断，`Ctrl+Alt+X`/界面 Interrupt 继续兜底。
- [ ] **蓝牙耳机再次断开**：20:45:24 采集 ready，约 20:45:30 后 `cc ultimate` 从 Windows 消失，采集重试 3 次后停止；需重新连接耳机后复测“朗读中说话打断”。
- [x] 21:00 复测发现模式按钮歧义：旧按钮显示当前模式，点一下切到另一个；用户实际在耳机模式（日志 `mode: 'headset'`），21:01:01 的 `barge-in avg=3875` 证明耳机模式语音打断有效。已改为“耳机 / 外放”两个并列按钮；已通过 IPC 切到外放并确认采集 ready。
- [x] 明确外放物理上限：串音 3933–13183 > 用户人声 3000–4500，助手大声说话时纯阈值无法可靠区分；自适应门槛只能利用句子停顿打断。要“随时打断”需 AEC 或指向性/带杆麦克风。
- [ ] 重启 App 后让用户复测：暂停/取消语音是否只播一遍且完整；选择外放/耳机设备后是否路由正确；外放模式下“语音打断”是否仍按半双工策略工作。

## 2026-11-15

- [x] 仓库整理：CYRVIS 文档迁入 `doc/`，新增 `README.cyrvis.md`、`doc/README.md`、`doc/roadmap.md`、`doc/development.md`；原始产品愿景归档到 `doc/archive/product-vision-v1.md`。
- [x] 首次提交 `641da6d8` 已推送到 GitHub `main`（SSH）；GitHub 仓库改名 `CYRVIS` 待网页操作/重定向。
- [x] 清理：`mp3-player.ts` → `wav-player.ts`；删除未使用的 lamejs/lame-encoder/raw 类型与依赖；移除本地绝对路径；新增 `.env.example`、`scripts/cyrvis/start-dev.cmd`；`.gitignore` 补齐 secrets/logs/artifacts。
- [x] 修复“多个 AI 同时说话/首中尾错位”：渲染端播放队列只允许在 underrun 时追平，禁止把领先 >2s 的队列重置到当前时间；用户确认“现在连贯”。
- [x] 实现自然打断（barge-in）：助手播报时渲染端仍监听麦克风，连续 250ms 能量超过阈值即停止播放、取消 Qwen 响应、回灌最近 600ms 缓冲语音，用户无需按键。
- [x] 打断链路加固：取消后的 `response.audio.delta` 丢弃；canceled 的 `response.done` 不再重新静音麦克风；新增 `response-stopped` 广播。
- [x] 兜底打断：语音条在播报时显示 Interrupt 按钮；全局快捷键 `Ctrl+Alt+X`（主窗口隐藏时也生效）。
- [x] 改善“要喊几遍才理我”：本地 VAD 阈值 300→250，最短语音 600ms→300ms，端点静音 1200ms→800ms，播放结束后麦克风恢复等待 800ms→150ms。
- [x] 打断检测阈值与主 VAD 对齐：渲染端 1200→350（持续 300ms），避免耳机麦音量偏低时打断失效；取消标志窗口 1000ms→400ms，避免误杀打断后用户的新响应。
- [x] 修复工具调用后麦克风被关 10s：新增 `response-done` 广播，无音频的 tool-call 响应结束时立即开麦，用户可在 GUI 执行中说“停”。
- [x] 增加 “Thinking…” 状态：语音提交后立即显示，避免用户在等待首 token 时误以为没听到而重复说话。
- [x] 打断竞态加固：若 `response.created` 在取消之后才到，立即再次 `response.cancel`，不再播放迟到的响应。
- [x] `pnpm typecheck` 通过；CYRVIS 单测 55/55 通过。
- [x] 无人工语音的打断验证：播放中调用 barge-in，日志出现 `barge-in` → `canceled response done`，旧响应无后续音频；`Ctrl+Alt+X` 全局快捷键注册并触发成功。
- [ ] 真实麦克风验证：播报中直接说话打断、短促 “Hello” 一次唤醒。
- [x] 诊断出真实打断失败根因：播报时 `barge monitor avg=0 peak=0`，麦克风流在播放期间为纯静音，与阈值无关。
- [x] 修复尝试：关闭 AEC/NS、统一采集/播放采样率为设备原生、改用显式物理麦克风 endpoint（不再用 default/communications 别名）。
- [x] 输出切到 Realtek 扬声器后仍为 `avg=0`，排除输出端点冲突；判定为 USB 耳机/驱动层半双工静音。
- [x] 用户改用 AirPods；期间发现 AirPods 断开后应用回退到 ToDesk Virtual Audio，导致空白转写和自取消。
- [x] 已禁止虚拟麦克风回退：无物理麦克风直接报错；设备重新连接时自动切回物理麦克风。
- [x] AirPods 噪声底 260-486、人声 1700-4500：主 VAD 阈值 250→600，重新开启 noiseSuppression；渲染端打断阈值 400。
- [x] TTS 播放改为 `MediaStreamDestination` + `<audio>`；实测仍会归零，改为**普通 MP3 Blob 文件分段播放**（PCM→lamejs MP3→每 0.75s 一个 `<audio>`），绕开 WebAudio/MediaSource 的 AEC 参考。
- [x] 修复 lamejs 在 Vite 下的 `MPEGMode is not defined`：改用 `lame.all.js?raw` + `new Function`。
- [x] 增加 Electron `autoplay-policy=no-user-gesture-required`，保证 IPC 回调里创建的 `<audio>` 能播放。
- [x] 修复 CSP 缺少 `media-src blob:` 导致的 `NotSupportedError`；blob 音频可播放。
- [x] 最终改为 WAV Blob 分段播放；实测普通 WAV 播放期间麦克风可采到测试音，不再被归零。
- [x] 真实用户验证：TTS 分段播放是否有明显卡顿；播报中喊“停”能否触发打断。
- [x] 拆分采集/播放架构成功：隐藏采集窗口（只开麦）+ 主窗口播放；AirPods 重新连接后自动恢复采集。
- [x] 语音打断实测成功：`[cyrvis capture] barge-in { avg: 4110 }`、`{ avg: 4910 }`，转写“停呀。”，播放立即停止。
- [x] 播报期间采集电平 0-10（耳机不漏音），用户说话 3000-16726；阈值 1000/150ms 不会误触发。
- [x] 用户确认分段 WAV 播放无明显卡顿。
- [x] 产出 `doc/voice-architecture.md`，记录最终采集/播放/打断架构、阈值、文件与实测记录。
- [x] 临时输出切到 Realtek 扬声器（调试函数），供外放演示；用户要求后再恢复默认。
- [x] 双模式完成：语音条新增“耳机/外放”切换按钮；耳机模式保留语音打断，外放模式半双工 + 800ms 尾音保护。
- [x] 外放 AEC 实测失败：隐藏采集窗口开 AEC 后播放期间仍收到自外放（`barge-in avg=8640`），无主窗口播放参考；外放模式因此不启用语音打断。
- [ ] 若后续必须“外放 + 语音打断”，需要系统级 loopback 参考/软件 AEC，或独立指向性麦克风。
- [x] 记录“外放 + 语音打断”后续方案：换带杆游戏耳机麦克风，测串音/人声电平后决定阈值；必要时做 TTS 参考的软件 AEC。用户决定先搁置。
- [x] GUI Agent 不执行的根因：Ark/Doubao 返回 **403 overdue balance（账户欠费）**，不是代码问题；语音模型 Qwen 走 DashScope，仍可用。
- [ ] 用户提供新 VLM Key 后已写入 electron-store；Ark 实测返回 **401 AuthenticationError: API key format is incorrect**（新 Key 长度 45，旧 Key 46，疑似少一位/粘贴不完整），等待用户重新提供完整 Key 后再测。
- [x] 定位为 **Plan 接口 Base URL 问题**：新 Key 是 Plan Key，`/api/v3` 报 401，改用 `https://ark.cn-beijing.volces.com/api/plan/v3` 后对 `doubao-seed-2.1-lite` 返回 200。
- [x] 配置已更新：`vlmBaseUrl=https://ark.cn-beijing.volces.com/api/plan/v3`、`vlmModelName=doubao-seed-2.1-lite`；应用已重启，待验证 GUI 任务。
- [x] 修复“桌面创建 txt 未执行”：IntentGate 缺少 创建/新建/写入 等动词，VoiceBrain 把工具调用判为会话并 REJECTED；已补动词 + 用户原话 task 兜底，新增测试，57/57 通过。
- [ ] 任务暂停/取消的延迟：ASR 转写后 GUI 在飞请求最多需 2–3s 才 abort，后续可评估“打断即先暂停”。

## 2026-11-14

- [x] 阅读 `CYRVIS_Technical_Architecture.md`，确认项目目标与范围。
- [x] 克隆 fork 到 `CYRVIS/UI-TARS-desktop`（commit `3ac2cb8`）。
- [x] 安装 pnpm 9.10.0（Node v24.15.0，npm registry 已指向 npmmirror）。
- [x] `pnpm install` 完成（跳过 Puppeteer 自带 Chrome 下载，浏览器 Operator 使用系统 Chrome）。
- [x] `pnpm run dev:ui-tars` 启动成功，窗口标题 `UI-TARS Desktop`，renderer HTTP 200。
- [ ] 配置 GUI VLM，跑通 3 个固定任务。
  - 2026-11-14：用户尝试 Seed 2.1 Lite，模型名填 `doubao-seed-2-1-lite`，报 404；已定位为缺少日期版本后缀/未开通或需用 `ep-` 接入点。
  - 2026-11-14：用户反馈 `doubao-seed-2-1-lite-260915` 速度不错，确定先用它做实验。
- [x] 产出整体框架 `doc/architecture.md`。
- [x] 产出语音实现清单 `doc/archive/voice-implementation-v1.md`（历史；当前见 `doc/voice-architecture.md`）。
- [x] 产出早期语音方案 `doc/archive/voice-plan-v1.md`（历史，保留背景）。
- [x] Controller / ProactivityPolicy / ElectronGUIAdapter 实现完成，16 个单元测试通过，node typecheck 通过。
- [x] Qwen3.8-Omni-Flash-Realtime 端到端接通：通用 DashScope 端点即可用，无需 Workspace ID；ASR、TTS、Function Calling 均验证通过。
- [x] Controller/VoiceBrain/IntentGate/Proactivity/Qwen Provider/音频桥/widget 语音条完成，50 个单测通过，typecheck 通过。
- [x] 端到端测试（test mode + 合成 WAV）：唤醒词 → ASR → start_gui_task → GUI Agent → task_done → 主动播报“完成了”，全链路跑通。
- [x] 发现并修复 GUI Agent 不输出 `finished()` 的问题：Doubao 1.5 prompt 增加“必须输出 Action，完成时输出 finished()”；任务可正常结束。
- [x] 增加完成声明拦截：GUI 执行中语音模型若说“已打开/已完成”，会取消 TTS 并改说“正在执行，请稍等”。
- [ ] 真麦克风：Chromium 只看到 ToDesk Virtual Audio，未见 Realtek/Logitech 实体麦克风；需用户插好并在 Windows 声音设置选为默认输入。
- [ ] 主动播报节流已调到 15s；后续按真实体验再调。
- [ ] 语音 Key 已在本地 `.env`（gitignored）；演示后建议轮换。
- [ ] 记录成功配置与失败原因，形成 Go/No-Go 结论。

## 已知非阻塞问题

- 启动日志有 `TypeError: installExtension is not a function`（`electron-devtools-installer` 兼容问题），仅影响 DevTools 扩展安装，应用正常。
- `origin` 当前指向 `gh-proxy.com` 代理地址，`git push` 前需要改回真实 GitHub 或配置可用代理。

## 环境快照

| 项          | 值                           |
| ----------- | ---------------------------- |
| OS          | Windows 11 Pro 10.0.26200    |
| GPU         | NVIDIA RTX 5060              |
| 显示器      | 单屏 2560×1440               |
| Node        | v24.15.0                     |
| pnpm        | 9.10.0                       |
| 浏览器      | Chrome、Edge 已安装          |
| GitHub 直连 | 不通，使用 gh-proxy.com 克隆 |

## PR #1 合并（本地集成分支）

- [x] 备份本地修改：`backup/local-voice-fixes-20261116`，patch `D:/temp/cyrvis-local-voice-fixes.patch`。
- [x] 在 `merge/pr-1` 上合并组员 PR #1（reference-aware echo gating + 浮动语音工作区 + 记忆）；保留 Token Plan 端点、15 秒输入缓冲清理、断线重连、耳机/外放显式按钮。
- [x] 验证：node/web typecheck 通过；CYRVIS + shared 测试 75/75；wav-player/widgetOverlay/store 测试 9/9；`UI_TARS_APP_PRIVATE_KEY_BASE64=dummy pnpm --filter ui-tars-desktop build:dist` 通过。
- [ ] 真机外放打断复测：合并后启动 App，切到外放时蓝牙耳机 `cc ultimate` 从 Windows 消失（只剩 ToDesk 虚拟麦），采集重试 3 次后停止；需重新连接耳机后测试，通过后再 push main。
- [x] 修复合并后“耳机/外放都打断不了”：播放参考 PCM 之前是在 `audio.play()` 返回后按 `currentTime` 截取，实际只剩 206–4258 字节，主进程经常 `ref: 0` 并 fail-closed。改为**播放前发送完整 0.75s 参考**，只有暂停恢复才发送剩余段；实测参考恢复为 36000 字节。
- [x] 外放串音相关性实测 0.69–0.76，原 `likelyEcho >= 0.72` 让大量片段落入 ambiguous，反复暂停 700ms 做无效探针；阈值调整为 0.65。
- [x] 合成“停”音频从 Realtek 播放并注入麦克风：日志 `direct interrupt detected { avg: 7490, corr: 0.147 }` → `barge-in`，外放打断链路验证通过。
- [x] 修复 barge 后误重连：cancel 竞态的服务端 error 被当成致命错误，导致每次打断后 `sleep`/重连；现只对 `input buffer exceeded`/session 失效重连，其他 error 仅记录。
- [x] 重连后重新触发 `onReady` 并 `wake`，修复“耳机模式转写了但 asleep 忽略、无声音”。
- [ ] 蓝牙耳机在多次重启/切模式后又从 Windows 消失，当前采集无法启动；重新连接后再做一次真人“停”复测。
- [x] 减少蓝牙麦掉线：外放模式不再把 Windows 三个默认角色全部切到 Realtek；roles 0/1（普通/多媒体）切扬声器，role 2（通信）保留在 `cc ultimate` 耳机，避免 Windows 拆掉 HFP 麦克风。脚本实测外放 target=Realtek、role 0/1 hr=0；耳机存在时应额外输出 `role=2 (comm/headset)`。
- [x] 修复“喊停后停一下又继续”：日志显示 barge 成功后模型又生成“好的，已暂停当前任务”并播放。新增 bare stop 抑制：识别“停/停止/暂停/别说了”等短指令后取消当前响应，并在 2 秒内不再播放模型确认语；新增单测（19/19）。
- [x] 探针时序从 220ms decay + 140ms confirm 改为 80ms + 100ms，避免 200–300ms 的“停”被全部丢弃；外放探针现在能确认更短的口令。
- [x] 修复 barge 后长语音丢失：日志显示 22:34:38 barge 成功后只捕获 200ms 就 commit，随后 22:34:39–42 用户继续说的长段（avg 1859/7087/4143）因 `awaitingResponse` 半双工被丢弃，22:35:01 只转写出 “Ok.”。已加 post-barge 静音窗口 1600ms，给用户继续说完的机会，避免 800ms 就把短停顿当成本轮结束。
- [ ] 模型质量：Token Plan 只有 `qwen-audio-3.0-realtime-plus`；`qwen3.8-omni-flash-realtime` 在 Token Plan 返回 `Model not exist`。当前 ASR 误识别明显（Hello CYRVIS → Hello service，长段 → Ok.），要回到 qwen3.8 需要公共 DashScope 的付费/额度 Key。
- [x] ASR 模型对比（Token Plan，同一段 3.8s 测试音频）：`fun-asr` 与 `qwen3-asr-flash-realtime` 转写完全一致：“Hello service，请给我背诵一首长诗。”；说明 “Hello CYRVIS → Hello service” 是声学/发音问题，不是 ASR 模型选择问题。Token Plan 无 `qwen3.8-omni-flash-realtime`（返回 Model not exist），只有 `qwen-audio-3.0-realtime-plus`；要回到 qwen3.8 需要公共 DashScope 付费/额度 Key。
- [x] 长语音被 8 秒硬切：`trackLocalVad` 在连续说话 8s 时强制 commit，随后 `awaitingResponse` 丢掉后半段；改为 25s 安全阈值，正常由 800ms（barge 后 1600ms）静音端点决定。
- [x] 外放误打断：speaker 模式探针恢复 220ms decay / 140ms confirm，避免把扬声器混响尾音确认成人声；headset 模式仍用 80/100ms 以识别短“停”。
- [x] “停一下”未匹配：bare-stop 正则补充 `停一下/停一停/先停/先停一下`。
- [x] 任何确认的 barge 都调用 `markUserStop()`：取消当前响应并静音模型 2 秒，不再依赖 ASR 一定听清“停”；ASR 返回空/误识别也不会再生成“好的，请问…”的确认语。
- [x] ASR 返回空字符串时也调用 `markUserStop()`：耳机模式下“停”被识别为空时，模型不再生成“好的，请问您想让我做什么…”的新回复。
- [x] 外放“停一下又继续”的直接原因：探针在 ambiguous 时暂停播放 700ms，等不到持续人声就恢复，听起来就是停一下继续。默认关闭自动探针暂停（`CYRVIS_SPEAKER_PROBE=1` 可恢复），ambiguous 回声直接忽略；只有明确近端声音才打断。
- [x] 耳机模式恢复简单能量 barge（1000/150ms）：耳麦几乎无外放回声，不再走参考/探针流程，短“停”可直接打断。
- [x] 改为确定性 barge stop：确认打断后不再把预录/打断语音送 ASR，直接 `provider.bargeIn()` + `muteMicFor(900)` + `brain.handleBargeStop()`；后者暂停正在执行的 GUI 任务并抑制 2 秒回复。这样“停/停一下”不依赖 ASR 是否听清，也不会延迟几秒后生成新回复。
- [x] GUI Agent 从 ShowUI 切回 Ark：恢复 `%APPDATA%\ui-tars-desktop\ui_tars.setting.json` 的 `vlmBaseUrl=https://ark.cn-beijing.volces.com/api/plan/v3`、`vlmModelName=doubao-seed-2.1-lite`，保留新 `widgetOverlayMode`；Ark `/chat/completions` 实测 HTTP 200；App 内 `setting.getSetting()` 已确认加载该配置。ShowUI 侧车已停止。
- [x] GUI 任务“点击找不到”定位：语音转写和 `start_gui_task('打开浏览器并搜索携程')` 都正确；GUI 模型返回 `left_double(start_box='[88 378]')`（空格分隔），action-parser 只按逗号切分，解析成 `start_box:'[0.088]'`、`start_coords:[]`，实际没有可点击坐标，随后重复同一动作。已支持 `[x y]`/`[x1 y1 x2 y2]` 空格格式，新增解析测试；action-parser 40/40 通过并重新构建。
- [x] 修复 125% 缩放下点击偏移：parser 已把归一化框换算成 `start_coords`（含 scaleFactor），NutjsOperator 却又用 `start_box` + 物理分辨率重算，导致实际点击坐标被多除 1.25（`[291,675] → (233,540)`），Chrome 图标点空。Operator 现在优先使用 `start_coords` / `end_coords`，无坐标时才回退 parseBox；nut-js operator 已重新构建。
- [x] 找回“昨天下午 Seed 2.1 很顺”的行为：昨天没有 Action Batching 提示词；后来加入后，模型把“点 X 关闭文件管理器 + 双击 Chrome”批成同一轮，第二条动作执行时窗口还没关，直接点错。已从 Doubao prompt 移除 Action Batching 段落，并在 GUIAgent 执行层默认只执行第一条动作（`CYRVIS_ACTION_BATCHING=1` 才允许批量）。SDK 测试 6/6 通过，SDK 已重新构建。
- [x] 修正上一版坐标修复方向：parser 的 `start_coords` 已乘过 scaleFactor，NutJS 再优先使用它会把 `y=0.98` 变成 1764（屏幕高 1440），点到屏幕外；因此退回“以归一化 start_box 重新计算物理坐标”，不再使用 start_coords。任务栏 Edge 点击应落在 y≈1411。Action Batching 仍保持默认关闭。
- [x] 速度调整：删除 prompt 里“finished 前核对截图”两行（软约束、Seed 常忽略、对速度无帮助）；`loopIntervalInMs` 1000→500，减少每步固定等待。GUI 仍为 Seed 2.1 Lite、单动作单截图、归一化 start_box 坐标。
- [x] 语音延迟优化：本地 VAD 端点静音 800ms→500ms（少等约 0.3s）；耳机模式打断阈值 1000/150ms→1500/180ms，减少呼吸/耳机噪声触发的中途截断。Qwen 模型 TTFB 仍约 0.7–1.3s，Token Plan plus 无 qwen3.8 替代。
- [x] 播放链路改为 WebAudio 连续调度：不再每 0.75s 新建 `<audio>` WAV 段，改为同一 AudioContext 上按时间无缝排队 AudioBufferSourceNode，消除段间咔哒/间隙；首包缓冲 0.35s。支持 `AudioContext.setSinkId` 保持耳机/外放路由，并向主进程发送带真实播放时间的参考 PCM。
- [x] VAD 端点 500→400ms；再低会切分正常语句停顿，建议 400 为下限。
- [x] 声纹原型：本地 sherpa-onnx ERes2Net（38MB，D 盘），`voiceprint-server` 提供 `/enroll` `/verify`；用户录入 8s + 5s 自检 score 0.7446，TTS 原始音频对用户声纹仅 0.114/0.170，阈值 0.55 区分良好。
- [x] App 外放打断接入声纹：播放中候选能量达到阈值时，先 POST 最近 ~1s PCM 到 `127.0.0.1:8100/verify`；匹配用户才 `finishSpeakerBargeIn`，不匹配则继续播放；服务不可用时回退旧逻辑。
- [x] 声纹拒绝用户“停”的根因：播放中麦克风信号被助手回声主导，声纹分数只有 0.02–0.28；干净 TTS 对用户声纹 0.11–0.17，用户自检 0.74。已加单抽头回声减法：SpeakerEchoDetector 按最佳延迟/增益从麦克风 20ms 块中减去播放参考，voiceprint 改用残差缓冲。离线混合测试：混音 score 0.19–0.29（拒绝），减去回声后残差 score 0.72（通过）。
- [x] 真实双讲录音：`record_doubletalk.py` 改为单实例/超时/按墙钟录音，避免两个进程抢蓝牙麦卡死；录制 13.6s（TTS 1.2–9.4s，用户重复“停一下/别说了”）。
- [x] AEC 路线修正：真实双讲中 AEC3 默认把用户人声当回声（2.0–3.0s ERLE 33.6dB，原始声纹 0.594 → AEC 0.114），KWS 在 AEC 输出上少检/漏检；停词路径改为 **原始麦克风 + 本地 KWS + 声纹门控**，AEC 仅留作后续 ASR 实验。
- [x] 本地 KWS 接入：`sherpa-onnx-node@2.0.1` + 中文 zipformer 3.3M；`keyword-gate.ts` 在播放中每 20ms 送入原始 PCM，命中“停/停一下/停一停/别说了/不要说了/赛维斯停止”后取最近 ~1s 做 ERes2Net 声纹校验，阈值 0.35；通过才 `triggerBargeIn()`，拒绝则抑制旧能量路径 600ms。
- [x] 声纹自回声验证：Huihui TTS “好的，已暂停当前任务，要停止吗？” KWS 命中 2 次“停”，声纹 0.106/0.123 被拒绝；用户真实双讲命中窗口 0.39–0.59 被接受。新增 `keyword-gate.test.ts` 3 个真实音频测试，全部通过。
- [x] 采集恢复：Chromium 在蓝牙耳机休眠时只暴露 ToDesk 虚拟麦；采集选择允许 `default`/`communications` 别名（仍排除 ToDesk/虚拟/Line-in），隐藏窗格上报设备列表；失败重试从 3 次延长到 20 次，并监听 `devicechange`，耳机重新上电后可自动恢复。
- [x] 修复“UI 耳机 + 输出 Realtek”自打断：新增 `externalOutput` 状态，由渲染端 `set-output` 标签推断；实际外放时强制走 speaker/声纹路径，禁用 1500/180ms 耳机能量 barge。日志 `level` 现在同时打印 `externalOutput`，便于现场判断。
- [x] 真机外放 KWS 打断成功（11:34:26）：`detected '别说了'` → `voiceprint gate score 0.2931 / threshold 0.2 accepted:true` → `keyword barge-in`，命中到打断 24ms；旧阈值 0.35 会拒绝该分数。
- [x] 11:00 行为复刻与 A/B：新增运行时开关 `Ctrl+Alt+E`，在“纯能量 1500/180ms”和“KWS+声纹”之间切换；`CYRVIS_EXTERNAL_ENERGY_BARGE=1` 控制启动默认值。纯能量模式日志为 `barge-in { mode: 'energy-only' }`，KWS 模式为 `detected → voiceprint gate → keyword barge-in`。采集重试上限从 20 次提高到 1000 次（约 80 分钟），避免蓝牙耳机休眠期间重试耗尽。
- [x] 外放纯能量 A/B 完成：11:55 speaker 模式 energy-only 在助手 “Hello” 播放时连续自打断（avg 2693/4310/1956）；确认 11:00 的可用组合是 headset 模式 + Realtek 输出。默认 `CYRVIS_EXTERNAL_ENERGY_BARGE=0`，`Ctrl+Alt+E` 可现场切换对比。
- [x] 双级打断：强关键词（赛维斯停止/停一下/停一停/别说了/不要说了）直接停，弱关键词（停/停下/停住/停啊/停了）走声纹 0.25/0.10；新增强词 TTS 自回声测试。
- [x] 完整 barge trace：onset→detected→verified→barge→renderer stop，渲染端回传 queuedMs；日志 `[cyrvis barge trace]`。
- [x] 失败样本落盘：`CYRVIS_KWS_DUMP_FAILURES=1` 时写 `doc/kws-lab/failed-*.wav`，供离线 KWS 扫参。
- [x] 基线扫参完成：threshold 0.1 + trailing blanks 1 保留真实双讲 3 个停词（0.527/0.350/0.450）；0.2 丢弱“停”，blanks=2 延迟 0.3s 且丢弱“停”；TTS 强词自回声声纹仅 0.039/0.117。
- [x] 采集稳定性修复：隐藏采集窗改为单次 `getUserMedia` 并复用；仅当默认设备是 ToDesk 虚拟麦时才 stop 并重开物理设备。90 秒测试 0 断连、0 采集错误；外放模式切换后采集重启仍稳定。3 分钟 sounddevice 长录也稳定（178.35s/180s）。
- [x] 修复“喊好几次才停”的两个近失：新增连续 `keywordPreroll`（不随 response start 清空），解决冷启动 score=null；非停词语境能量兜底阈值 0.1→0.085（真机 TTS 回声本轮最高 0.0754，用户近失 0.0998）。
- [x] 停后新指令响应优化：barge 后 muted 1500→800ms，ASR 静默 2500→1000ms，回复抑制 3.5→3.0s；真实新指令（长度≥3、非纯数字）到达时立即清除抑制，回声数字不会。
- [x] 恢复 Chromium AGC（降噪仍关闭）：真机日志显示正常音量“停”到不了阈值，只有 avg 6241/8144 的大声“停了”才命中；AGC 用于提升入耳麦正常说话电平。
- [x] 提高单字“停”首次成功率：KWS threshold 0.1→0.05；`ttsContainsStop=false` 时弱词也直接打断（不再等声纹），`ttsContainsStop=true` 时才要求 0.25 声纹。真机 00:10:13 的“停”score 0.2681、bargeToStop 2ms，但此前多次尝试未被 KWS 检出。
- [x] 相对声纹外放打断：`SpeakerEchoDetector` 返回对齐 TTS 参考，主进程维护 1s referencePreroll；能量兜底 200ms/1200，margin>0.05 即打断；离线双讲用户 margin +0.2~+0.58，TTS 回声 -0.09~-0.13；新增 `prefers the enrolled user over the TTS reference` 测试。
- [x] 修复长回复相对声纹失效：`webaudio-player` 不再把整段队列塞进一个 AudioBuffer，改为 1s 分块独立 `startedAt`/`onSegmentStart`；`SpeakerEchoDetector` 改用采集时钟 prune，保留未来已排队参考、只淘汰播放超过 5s 的段，并跳过未开始的段；新增长回复排队单测。
- [x] 真机外放复测“任意说话”：修复后长回复 `relativeAvailable` 持续为 true；00:29:02 / 00:29:25 / 00:30:11 三次相对声纹（margin +0.33 / +0.066 / +0.106）成功打断，回声检查（-0.45 ~ +0.025）全部拒绝。连续大声 TTS 时仍以 KWS 停词为快速路径。
- [x] 前方快速工具矩阵：实现 32 个文件、应用、窗口、剪贴板、系统、Office、进程和网页工具；`VoiceBrain` 对确定性工具指令优先短路并阻止同一轮 GUI 调用；路径/敏感文件/覆盖/删除确认、MCP `tools/list`/`tools/call` 同源 facade、10 个工具矩阵测试和 5 个 VoiceBrain 本地执行测试均通过。
- [x] 本地工具注册给 Qwen：32 个工具转换为 `cyrvis_*` function schema，Omni 与 Cascade 均直接看到完整工具集；模型点名本地工具后由 VoiceBrain/Registry 校验执行，高风险工具保持语音确认，`start_gui_task` 改为复杂视觉任务兜底。
- [x] 修复确认循环与确认误判：模型高风险工具调用不再把 `CONFIRMATION_REQUIRED` 回灌给模型循环调用，而是取消当前响应并直接播报确认提示；“确认执行”等待确认控制词在自回声过滤前识别。新增原生 `office.create_presentation`，新文件不再走覆盖确认，并使用 PowerPoint COM 创建真实 `.pptx`。
- [x] 聊天与回复兜底：最终助手文本若没有真实音频或独立 TTS 输入，会在聊天框展示后自动补播；每个有效用户最终回合增加 6 秒回复看门狗，任务执行中回“我在处理”，普通请求回“正在理解”，避免用户被晾住。重复最终转写去重窗口从 6 秒缩短到 750ms。
- [x] 播报中命令迟钝修复：Renderer 打断阈值从 `0.05/3帧` 调整为 `0.04/2帧`，约 170ms 即可开始命令捕获；“打开浏览器搜索…”新增确定性 `web.search` 路由，模型误调用 `start_gui_task` 时也会自动改走本地搜索工具。
- [x] 系统感知与任务交互：新增 `SystemStateStore`，定时采集系统/硬件/磁盘/电池/网络/安装应用/Steam/服务/进程/窗口；当前机器实扫到 323 个应用、4 个 Steam 游戏、334 个服务、369 个进程和 8 个窗口。新增 9 个动态系统工具、10 秒运行态刷新和 10 分钟全量刷新；任务开始、关键进度、追问、暂停、完成、失败、取消和状态查询均强制进入聊天与语音。
- [x] 确认交互修复：显式“确认执行/取消”无条件绕过 VoiceService 与 VoiceBrain 的回声过滤，待确认有效期延长到 120 秒；pending 丢失时会重放最近一次本地工具或 GUI 任务。确认语音只说明可能涉及文件/隐私/系统状态，不再朗读真实路径、文件名或具体位置。
