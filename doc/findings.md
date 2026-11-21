# CYRVIS 调研发现

## 2026-11-21 里程碑复盘

- 外放自打断的根因是“人声 + 扬声器回声”的声学混合，不是单一阈值；最终靠主麦克风 AEC、播放参考互相关、
  文本回声过滤和 KWS/声纹共同处理。旧隐藏采集窗口（`echoCancellation:false`）不是当前 omni 路径。
- 眼动 PR 有两条线：#11 适配当前 main/调度层/语音队列；#12 基于旧控制器，眼动核心相同但冲突更多。
  当前合 #11，不整体合 #12。
- 旅游数据的核心原则：真实查询、失败明说、不伪造；OTA 只支持单程，往返会退化为 Google。
- 合并 PR 时必须保留 main 的 pending-intent/确认回声/stop guard/编码进度守卫；
  PR 自带的“直接执行/无确认”语义不能默认接受。
- 测试结果要区分代码失败与环境失败：默认 `vitest` 会加载 e2e/Playwright、electron-log、macOS 原生模块
  和 renderer 别名，CYRVIS 回归应使用 `vitest.cyrvis.config.ts`，SDK 单独跑。

## 基座代码事实
| 位置 | 事实 |
|---|---|
| `apps/ui-tars/src/main/services/runAgent.ts` | 根据 settings 选择 Operator，构造 `GUIAgent`，`model` 来自 `vlmBaseUrl/vlmApiKey/vlmModelName` |
| `apps/ui-tars/src/main/ipcRoutes/agent.ts` | `GUIAgentManager` 持有单例；`stopRun` 执行 `abortController.abort()` + `guiAgent.stop()` |
| `packages/ui-tars/sdk/src/GUIAgent.ts` | 循环顶部检查 `signal.aborted` / `isStopped`；取消不会回滚已执行的点击，也不会打断正在执行的单步动作 |
| `apps/ui-tars/src/main/agent/operator.ts` | Windows `type` 走剪贴板粘贴；截图仅主显示器 |
| `apps/ui-tars/src/main/store/setting.ts` | 配置存 electron-store `ui_tars.setting`，也可用环境变量 `VLM_*` 初始化 |
| `apps/ui-tars/src/main/store/types.ts` | VLM Provider 仅 4 个枚举：HF UI-TARS-1.0/1.5、火山 Doubao-1.5-UI-TARS、Doubao-thinking-vision-pro |

## 结论
1. 必须配置兼容 UI-TARS 动作协议的 VLM，普通聊天模型不能直接用。
2. Remote Operator 免费服务已于 2025-08-20 停止，试跑只能用 Local Computer/Browser Operator + 自备模型。
3. 取消机制是“停止后续步骤”，不能宣称回滚已执行操作；CYRVIS 的取消验收按此标准。
4. 单显示器限制与当前环境一致（2560×1440 单屏），适合先做受控 Demo。
5. 安装时 Puppeteer 会从 Google 下载约 170MB Chrome，国内极慢；已用 `PUPPETEER_SKIP_DOWNLOAD=1` 跳过。Browser Operator 使用系统 Chrome（`C:\Program Files\Google\Chrome\Application\chrome.exe`），不影响本地试跑。
6. 克隆走 `gh-proxy.com`，因此 `origin` 被写成代理 URL；只影响 push，不影响本地开发。
7. Electron 启动时 `installExtension` 报错来自 `electron-devtools-installer` 新版 API 不兼容，非阻塞。
8. 火山方舟模型 ID 有两套：普通按量 API 用日期版本 ID（如 `doubao-seed-2-1-lite-260915`）；Coding/Agent Plan 用点号 ID（如 `doubao-seed-2.1-lite`），两者不可混用。填 `doubao-seed-2-1-lite` 会报 404 `InvalidEndpointOrModel.NotFound`。
9. `checkModelAvailability` 只做一次 `chat.completions`（`return 1+1=?`），通过只证明接口可用，不证明模型能输出 UI-TARS 动作格式。
10. GUI 任务执行时主窗口会隐藏（`beforeAgentRun`），同时显示 400×400 widget 和屏幕水波纹；结束后恢复。widget 与预测标记都设置了 `setContentProtection(true)`，不会进入 VLM 截图；水波纹是 `false`，但只在屏幕边缘。
11. 语音 UI 应放在 widget 窗口，避免新开大窗口污染截图；widget 当前 `focusable:false`，需要加 `backgroundThrottling:false` 并处理麦克风权限。
12. 豆包实时语音 3.0（Seeduplex）支持全双工、动态判停、Function Calling/MCP，但截至 2026-11-14 仍是**邀测**，未见公开 GA 公告；需豆包语音控制台开通，独立于 Ark 模型 Key。公开目录价（第三方估算）音频输入约 ¥80/M、输出约 ¥300/M，成本高。
13. Qwen3.8-Omni-Flash-Realtime 在阿里云百炼**北京地域可自助开通**：模型 `qwen3.8-omni-flash-realtime`，1M 免费 tokens（90 天），音频输入 ¥6/M、输出 ¥12/M，text/image/video 输入 ¥1.5/M、输出 ¥4.5/M；支持 Function Calling/MCP、`server_vad`/`semantic_vad`/`semantic_vad_ec`，WebSocket 需业务空间专属域名 `wss://{WorkspaceId}.cn-beijing.maas.aliyuncs.com/api-ws/v1/realtime?model=...`，鉴权 `Authorization: Bearer <API_KEY>`，输入 16kHz PCM、输出默认 24kHz PCM。
14. Qwen-Omni 的 `conversation.item.create` 文档只列出 Function Calling 结果/MCP 审批，未列出任意文本消息；主动播报可能需要 `session.update.instructions` + `response.create`，或单独 TTS 兜底，需实测。
15. Controller/ProactivityPolicy/ElectronGUIAdapter/VoiceBrain/Qwen Provider/音频桥/widget 语音条已实现于 `apps/ui-tars/src/main/cyrvis/` 与 renderer；50 个单元测试通过，node/web typecheck 通过。
16. Qwen realtime 用 `wss://dashscope.aliyuncs.com/api-ws/v1/realtime?model=...` + `sk-ws-...` Key 可直接连；不强制 Workspace ID。输入 16k PCM16，输出 24k PCM16；manual 模式 + 本地能量 VAD 比 server VAD 更可控。
17. 合成语音 “Hello CYRVIS” 被 Qwen ASR 识别为 “Hello, service.”；唤醒匹配已兼容 service/sirvis/cervis/sirius，以及中文“赛维斯/瑟维斯”。
18. Qwen 对 `start_gui_task` 的工具结果是“已启动”，会倾向直接说“I've opened...”；已加 Tool result 明确提示 + VoiceBrain 完成声明拦截。
19. 当前机器 Chromium 只枚举到 “ToDesk Virtual Audio” 输入设备，未枚举到 Realtek/Logitech 实体麦克风；真语音交互需用户插好麦克风并设为默认输入。
20. Doubao 1.5 prompt 增加“必须输出 Action、完成时输出 finished()”后，Seed 2.1 Lite 的 Notepad 任务可正常以 `finished()` 结束。
21. 播放错位的根因在渲染端调度：Qwen 推流快于实时，队列可能领先 >2s；旧逻辑把领先队列重置到 `currentTime`，多个 chunk 同时 start，听起来像不同 AI 说首/中/尾。正确做法是只在 underrun（`nextPlayTime < now`）时追平。
22. 半双工静音会从物理上阻止打断，因此 barge-in 必须在渲染端做本地能量检测：播报时音频不送 ASR，但仍计算能量；触发后先 `bargeIn` 再回灌预录缓冲，主进程顺序处理 IPC。
23. 打断后必须同时处理三件事，否则会“取消后又说话/又聋掉”：丢弃旧响应的 audio delta；canceled `response.done` 不设置 `micMuteUntil`；清空 Qwen 输入缓冲。
24. “喊几遍才理”的主要原因是端点判定过严：最短语音 600ms 会丢掉短促 “Hello”，阈值 300 对耳机麦偏高；已降到 300ms / 250，端点静音 1200ms→800ms，播放结束静音尾 800ms→150ms。合成音频实测平均能量仅 254-348，渲染端打断阈值因此从 1200 降到 350。环境底噪高时需再回调阈值。
25. 工具调用型响应没有音频，渲染端若只靠“最后一个 audio source 结束”开麦，会把麦克风关到 10s 看门狗；必须监听 `response.done`，在无播放源时立即开麦，否则 GUI 任务执行中用户说“停”会被吞。
26. 打断存在竞态：用户取消时服务端可能尚未发出 `response.created`，此时 `response.cancel` 无对象可取消；必须在 `response.created` 到达时识别 `cancelRequested` 并再次取消，否则迟到的响应会照常播报。
27. 播放中打断的自动化验证可通过 CDP 调 `bargeIn()` 并观察日志：正常路径应出现 `canceled response done`、`audio done { bytes: 0 }`，且取消后无新的 `first audio delta`；真实“说话打断”仍依赖耳机麦能量阈值（渲染端 350/300ms）。取消标志窗口必须小于端点静音时间（400ms < 800ms），否则会把打断后用户的新响应再次取消。
28. 真实打断失败的关键证据：`barge monitor` 在播报期间持续输出 `avg=0 peak=0`，而 `sources` 正常递减——麦克风数据在播放期间是**纯静音**，不是阈值问题。用户连续喊“停止”也无效，说明渲染端根本没拿到人声。
29. 已尝试的修复方向：关闭 `echoCancellation`/`noiseSuppression`（Chrome 双讲抑制可能压掉近端人声）；把采集与播放 AudioContext 统一为设备原生采样率（原先 16k 采集 + 24k 播放可能触发 USB 设备重配置）；不再使用 Windows 的 `default`/`communications` 别名，改为显式物理麦克风 deviceId。
30. 进一步排除：把 TTS 输出切到 Realtek 扬声器（`setSinkId`）后，播报期间仍是 `avg=0 peak=0`，`trackMuted=false`、`capture=running`。说明不是 USB 播放端点冲突，也不是浏览器 AEC/采样率；更像是耳机/驱动/Windows DSP 在系统层对麦克风做了半双工静音。该现象与 WebRTC 社区报告的“设备自带增强在播放时压低/静音麦克风”一致。
31. 决策：先用另一套麦克风（AirPods）验证是否为该 USB 耳机硬件问题。若 AirPods 全双工正常，则保留耳机作为输出、AirPods 作为输入，或直接使用 AirPods；若仍为 0，则 Windows 蓝牙 HFP 也有同样限制，需要独立麦克风或仅保留 `Ctrl+Alt+X` 打断。
32. AirPods/蓝牙实测：环境噪声底为 260-486，真实说话为 1700-4500；原 250 阈值把噪声当语音，产生空转写并触发 VoiceBrain 的“空转写取消回复”，形成连续自取消。已把主 VAD 阈值提到 600，并重新开启 `noiseSuppression`（保留 `echoCancellation:false`）。渲染端打断阈值相应调到 400。
33. 另一个关键缺陷：没有物理麦克风时，`getUserMedia` 会回退到 Windows 默认的 ToDesk Virtual Audio。该虚拟设备会收到系统播放声，导致空转写、8 秒长语音和自取消。已禁止虚拟设备回退，无物理麦克风时直接报错并停止语音。
34. 播放路径改为 `MediaStreamDestination` + `<audio>` 元素：Sokuji 在 Electron/Windows 的实测指出，`AudioContext.destination` 播放会被 Chrome AEC 当作参考信号，把麦克风压到约 -96dB；`<audio>`/MediaStream 播放只到约 -29dB，不会把麦克风归零。此方案需在真实 AirPods 上再验证。
35. 实测 `<audio>` 播放 **WebAudio MediaStream** 仍会把麦克风归零；但播放**普通 WAV 文件**（Audio 元素 + blob URL）时，主 VAD 能收到 5430 的能量——说明 AEC 参考只覆盖 WebAudio/MediaSource 路径，普通媒体文件不受影响。
36. 因此最终改为“PCM→MP3→独立 Blob 文件→`<audio>` 顺序播放”：每约 0.75s 一个 MP3 段，避免 WebAudio 与 MediaSource；段间可能有几十毫秒间隙。`lamejs` npm 入口在 Vite 下报 `MPEGMode is not defined`，必须用 `lame.all.js?raw` + `new Function` 取 `lamejs.Mp3Encoder`（CSP 已允许 unsafe-eval）。
37. 另加 Electron `autoplay-policy=no-user-gesture-required`：TTS 的 `<audio>` 在 IPC 回调里创建，不在用户手势栈内，否则 `play()` 会被拒绝。
38. 渲染页 CSP 缺少 `media-src`，`default-src 'self'` 会拦截 `blob:` 音频，表现为 `NotSupportedError: Failed to load because no supported source was found`。已在两个 CSP meta 中加入 `media-src 'self' blob:`。
39. 最终播放方案：PCM→**每 0.75s 一个 WAV Blob 文件**→`<audio>` 顺序播放。实测普通 WAV 文件播放期间麦克风仍能采到声音（440Hz 测试音期间 `__cyrvisMicAvg` 有非零值），而 WebAudio/MediaSource 播放期间为 0。代价是段间可能有几十毫秒间隙，需要真实听感确认。
40. **拆分采集/播放是最终解**：隐藏 BrowserWindow 只做 `getUserMedia` 采集，PCM 经本地 WebSocket 送主进程；主窗口只负责 TTS 播放。播放期间隐藏采集窗口仍能收到用户语音（barge-in avg 4110/4910），而同一渲染进程边播边采时始终为 0。结论：Chrome 的 AEC/采集归零是**按渲染进程/音频会话**的，不是系统全局。
41. 主进程打断检测：阈值 1000、持续 150ms；播报期间耳机漏音仅 0-10，用户人声 3000-16726，区分度足够。AirPods 断开/重连由 `devicechange` 自动重启隐藏采集窗口，日志确认 19:54:09 重新 ready。
42. 仍需注意：隐藏采集窗口使用独立本地 HTTP/WS 服务（127.0.0.1 随机端口），生产打包时需确保端口/权限可用；TTS 分段 0.75s 的听感需用户确认。
43. GUI Agent 不执行的根因（2026-11-15 20:27）：火山方舟/Doubao 返回 `403 The request failed because your account has an overdue balance`，即 Ark 账户欠费；与 CYRVIS 代码无关。语音链路走 Qwen/DashScope，仍正常。处理：充值 Ark 或更换可用的 VLM API Key/模型；无需改代码。
44. 采集 WebSocket 的 PCM 二进制块可能以 `{` 字节开头；之前用文本前缀判断控制消息，会误把 PCM 当 JSON 解析并丢弃。已改为使用 ws 的 `isBinary` 标志，控制消息走文本、PCM 走二进制。
45. VLM Key 存放位置：`%APPDATA%\ui-tars-desktop\ui_tars.setting.json` 的 `vlmApiKey`（electron-store `ui_tars.setting`），不是 `.env`。替换 Key 后直接调 Ark `/chat/completions` 验证。
46. **Ark 普通推理与 Plan 接口不是同一个 Base URL**：普通按量接口是 `https://ark.cn-beijing.volces.com/api/v3`；Coding/Agent Plan 的 OpenAI 兼容接口是 `https://ark.cn-beijing.volces.com/api/plan/v3`（Responses 为 `/api/plan`）。用户的新 Key 是 Plan Key：用 `/api/v3` 报 401 invalid，用 `/api/plan/v3` 对 `doubao-seed-2.1-lite` 和 `doubao-seed-2-1-lite-260915` 都返回 200。当前配置已改为 plan/v3 + `doubao-seed-2.1-lite`。
47. “创建桌面 txt”未执行的根因不是 GUI 模型，而是 **IntentGate 误拒**：模型在 21:18:19 已调用 `start_gui_task`，指令“在桌面新建一个txt文件，并将《沁园春·雪》全文写入其中”不含当时 TASK_VERBS 中的任何词（打开/搜索/给我/把…），`classifyIntent` 判为 ambiguous，VoiceBrain 直接回 `REJECTED`，Controller 根本没启动（日志无 `runAgent`）。已补充 创建/新建/写入/生成/编辑/复制/删除/重命名 等文件操作动词，并在 VoiceBrain 中增加兜底：若模型改写后的指令不含已知动词，但用户原话是 task，则允许启动。新增 2 个测试，57/57 通过。
48. **Action Batching 执行层已经原生支持**：`parseActionVlm` 会把同一 `Action:` 后以空行分隔的多个动作解析为 `parsedPredictions[]`，`GUIAgent` 在同一轮循环内依次执行这些动作，不再截图。缺的是模型提示词——`DOUBAO_1_5_15B`（Seed 2.1 Lite 走这条）原本没有多动作说明。已加入受限批量规则。
49. 无执行探针（同一张截图 + 新提示词，直接请求 Ark Plan 接口）：
    - “输入 batch test，然后按回车” → `type(content='batch test')\n\nhotkey(key='enter')`，parser 得到 2 条动作；
    - “Ctrl+Shift+P 打开命令面板 → 输入 → 回车” → 只返回 1 条 `hotkey`，因为提示词禁止在打开面板/需要观察中间状态的场景批量，符合预期。
50. 端到端实测（记事本目标文件）日志：第 2 轮 `action batch { count: 2, types: ['type','hotkey'] }`，两条动作同一轮执行；总 `loopCnt=3`（逐条执行约需 4 轮）。但第 1 轮点击 `[630,980]` 落在窗口底部状态栏/任务栏，未真正聚焦文本区，后续批量输入打到了别的窗口，模型第 3 轮仍 `finished` 声称成功，测试文件为空。结论：批量执行本身有效，但会放大“错误焦点”的代价，且模型会误判完成。修正：批内动作间隔 200ms；提示词要求截图里已有文本光标才允许 click+type，`finished` 前必须确认最新截图结果。
51. 干净复测通过（2026-11-16 00:16）：记事本已打开、光标已在文档末尾、指令明确要求“不要点击”。模型第 1 轮直接返回 `type(content='batch test')` + `hotkey(key='enter')`，日志 `action batch { count: 2 }`；第 2 轮 `finished`，总 `loopCnt=2`（逐条执行需 3 轮）。截图显示文档内容为 `PRE batch test`，状态栏 `行 2, 列 1`，说明文字和回车都生效。文件本身未保存（标题带 `*`），因为任务只要求输入+回车，未要求保存。结论：焦点已就绪时批量可靠；之前的失败是点击定位/前台窗口问题。
52. ShowUI-2B 侧车在 5060 上可跑：BF16 占用 4.12GB，输入 1MP，2.3–3.4s/步。L4（本地搜索→新标签→详情）成功，5 轮/35.4s，对比 Seed 11 轮/104.5s；L1/L5 桌面任务失败，因为 ShowUI web 动作空间没有 `hotkey`/`Ctrl+S`/Alt+Tab，也不会跨应用规划，模型卡在 `SCROLL`。定位：ShowUI 适合浏览器内任务，不适合桌面快捷键/保存任务。
53. ShowUI 坐标异常：模型返回过 `[0.21, 45]`（y 超出 0–1）。侧车把 `1<v<=100` 当百分比归一化（45→0.45）、>100 当像素后，L4 通过；直接 clamp 会点到屏幕底部。另 App 约 5 步后出现 `Connection error`，疑似 uvicorn 默认 5s keep-alive 与轮询间隔不匹配，侧车已改 `timeout_keep_alive=120`，待复测。
54. “暂停/取消”双回复/截断的根因有三层：① `ProactivityPolicy` 对 `task_paused`/`task_cancelled` 主动说“已暂停/已停止”，与工具结果响应重复；② `VoiceBrain.onResponseDone` 在音频**生成完成**就把 `ttsSpeaking=false`，而渲染端还在播；③ 渲染端 `onResponseStarted` 无条件 `stopPlayback()`，第二个响应开始时会切断第一段。修复：控制事件抑制 5s、控制工具调用去重、Provider `playbackBusy` 队列（工具结果/主动播报等播放完再发）、`ttsSpeaking` 保持到 `playback-idle`、渲染端仅在上一段未播放时重置播放器。
55. 外放/耳机路由的根因：耳机模式只调用 `setSinkId('default')`，如果 Windows 默认输出是 Realtek 扬声器，就仍然外放；外放模式又硬编码查找 `'扬声器 (Realtek'`。当前机器枚举到的输出只有 `Default/Communications - 扬声器 (Realtek)`、`Realtek Digital Output`、`F24G30Q Pro (NVIDIA)`、`扬声器 (ToDesk Virtual Audio)`，**没有耳机输出**；如果用户戴的是只有麦克风的入耳式，App 无法把声音路由到不存在的耳机设备。修复：动态设备评分 + 语音条输出设备下拉框 + 模式/设备持久化；耳机模式显式选耳机，外放模式显式选扬声器。
56. 输出设备与语音模式必须解耦：选择扬声器时如果自动切到 speaker 模式，就会禁用语音打断，无法实现“外放 + 入耳麦 + 语音打断”。现在 `set-output` 只改播放设备，不改 `audioMode`；耳机/外放按钮只控制语音模式；输出下拉框独立选 Realtek/NVIDIA/ToDesk/系统默认。默认设备评分排除 `Digital Output`、ToDesk、耳机标签，避免选到 S/PDIF 或虚拟声卡。
57. 外放模式已改为语音打断：播放期间不送 ASR，但保留麦克风并做能量检测；阈值 2000 / 180ms（环境变量 `CYRVIS_SPEAKER_BARGE_THRESHOLD` 可调），触发后回灌 600ms 预录；播放结束仅 100ms 尾音保护。隐藏采集窗口无主窗口播放参考，AEC 无效，所以不再开 AEC；外放串音高时靠调高阈值或 `Ctrl+Alt+X`。需用入耳麦/带杆麦实测。
58. 两种模式自动路由（2026-11-16 14:08 实测）：耳机模式 = 蓝牙耳机麦 + 蓝牙耳机输出；外放模式 = 蓝牙耳机麦 + Realtek 主机扬声器。模式按钮调用 `set-mode`，主进程用 `scripts/cyrvis/audio/set-default-output.ps1`（PolicyConfig）切 Windows 默认端点（三个角色），同时渲染端 `applyAudioMode` 切 `<audio>.setSinkId`；采集重启但保持物理耳机麦。验证：耳机模式默认/输出 = `耳机 (cc ultimate) (Bluetooth)`；外放模式默认/输出 = `扬声器 (Realtek High Definition Audio)`。必须同时改 Windows 默认端点，单靠 `setSinkId(Realtek)` 会被 Windows 按应用路由覆盖。
59. “说不出话”根因（2026-11-16 13:52）：语音大脑处于 `sleep`，ASR 的“哈喽，塞维斯”没有匹配旧唤醒词（缺“哈喽”“塞维斯”“Zawis”等），所以 `handleTranscript` 取消响应；Qwen 仍生成 assistant 文本，但 `awake=false` 让 `onAudio` 丢弃音频，渲染端 `chunks=0`，表现为“有文字没声音”。已补唤醒词变体、睡眠时记录 `asleep; transcript ignored`；模式切换后 `awake=true` 才测语音。
60. 外放“我一直我在”自听循环（2026-11-16 14:12）：扬声器模式日志显示播放期间麦克风 avg 3933–13183，而阈值只有 2000；外放声被麦克风收回，barge-in 把助手自己的“我在”预录送进 ASR，模型回答“我在”，再次触发，形成自问自答。用户自身说话电平约 4200，和串音重叠，**固定阈值无法区分**。修复：① 自听转写过滤（“我在/我来/我/在听”等与上一句重合的短转写直接丢弃并 cancel response）；② 每次回复开头 600ms 测串音，平均 >1500（`CYRVIS_SPEAKER_ECHO_GUARD`）则本次回复禁用语音打断，让 TTS 完整播完，`Ctrl+Alt+X` 仍可用；环境变好（低音量/带杆麦）会自动恢复语音打断。真正稳定的外放语音打断仍需软件 AEC 或指向性麦克风。
61. Qwen realtime 免费额度耗尽（2026-11-16 14:24）：App 报 `Invalid WebSocket frame: invalid payload length 126`，但同一 Key 的独立 WebSocket 在 `session.update` 后返回 `{"code":"AllocationQuota.FreeTierOnly","message":"The free quota has been exhausted..."}`。根因是 Qwen 实时语音免费额度用完，不是 Key/网络/代码；App 端只看到服务端关闭导致的协议帧错误。处理：在阿里云百炼控制台关闭“仅使用免费额度”/开通付费，或换新的实时语音 Key；在此之前语音无法连接。
62. **Token Plan Key 不走公共 DashScope**（2026-11-16 20:12）：新 `sk-sp-…` Key 在 `dashscope.aliyuncs.com`/`dashscope-intl.aliyuncs.com` 均 401 `invalid_api_key`；Token Plan 有独立 host `token-plan.maas.qianwenaiapi.com`。`GET /compatible-mode/v1/models` 返回 23 个模型，其中实时音频只有 `qwen-audio-3.0-realtime-plus`（无 flash）。Realtime WebSocket 路径为 `wss://token-plan.maas.qianwenaiapi.com/api-ws/v1/realtime?model=qwen-audio-3.0-realtime-plus`；用 App 兼容的 `session.update`（`turn_detection:null`、16k/24k PCM、tools、voice `longanqian`）实测 `session.created` → `session.updated` 成功。`/compatible-mode/v1/realtime` 也能握手，但 App 使用的是 DashScope 协议，保留 `/api-ws/v1/realtime`。注意：同 host 的 `/v1/realtime`、`/ws/v1/realtime`、`/realtime` 均 404。
63. **外放模式“只回 Hello 就断”根因（2026-11-16 20:29）**：日志 `barge-in { avg: 11158, mode: 'speaker', threshold: 2000 }` 出现在助手刚开始说 “Hello” 后约 0.6s；ASR 随后转写出 “Hello.” 并被自听过滤，证明是**扬声器声音被麦克风收回**，不是用户打断。旧串音探测从 `response.created` 开始计时 600ms，但首段音频 delta 在约 800ms 后才到，探测窗口测到的是 48/3 的静音；真正播放时的 11158 串音直接触发 barge，取消回复；下一轮又因 `speakerBargeSuppressed` 在每次 `onResponseStarted` 被重置而重复。修复：① 探测从**第一段音频**开始，持续 1200ms；② 同时看平均和峰值（峰值 > 2×guard 也判定串音）；③ 一旦检测到串音或自听，60 秒内保持外放语音打断关闭，让回复完整播完，`Ctrl+Alt+X` 仍可用；④ 切模式时重置冷却。类型检查与 58/58 单测通过。
64. **Token Plan plus 的 30 秒输入缓冲上限（2026-11-16 20:33）**：空闲时本地 VAD 只 append、不 commit，Token Plan `qwen-audio-3.0-realtime-plus` 在 30 秒后返回 `input_audio_buffer exceeded maximum duration (30s)`，随后每个 append 都报错、会话失效且不自动重连，表现为“说着说着突然没声”。修复：① `QwenOmniProvider` 记录已 append 的音频时长，连续 15 秒且当前无语音时发送 `input_audio_buffer.clear`；② `input_audio_buffer.clear` 同步重置计数；③ 服务端 `error` 事件关闭旧连接并调度重连，避免错误刷屏和死会话。实测新版日志：3 次 `input buffer trim`、0 次 30 秒错误、0 次误 barge。
65. **外放冷却期完全禁用打断导致“打断不了”（2026-11-16 20:41）**：`speakerBargeSuppressed=true` 时 `handleCapturePcm` 直接 return，60 秒内任何语音都无法打断；用户朗读长诗时完全失控。改为**自适应门槛**：保留 500ms 麦克风能量窗口，用中位数估计当前串音底噪；实际门槛 = max(2000, 中位数×4, 冷却期 2500)。助手大声说话时门槛高，句子间安静时门槛降低，用户说“停”仍可触发 barge；`Ctrl+Alt+X` 和界面 Interrupt 按钮继续兜底。类型检查与 58/58 单测通过；真机复测受蓝牙耳机 `cc ultimate` 再次断开阻塞。
66. **模式按钮歧义导致“我调了外放其实在耳机”**（2026-11-16 21:00）：旧按钮显示的是**当前模式**，点一下切到另一个模式；用户看到“外放”再点，实际切成了耳机。日志：21:00:43 `audio mode { mode: 'headset' }`，21:01:01 `barge-in { avg: 3875, mode: 'headset' }` 实际打断成功。已把语音条改为“耳机 / 外放”两个并列按钮，点击即选中，不再切换。
67. **外放 + 入耳蓝牙麦的物理上限**：外放播放时麦克风串音实测 3933–13183，用户人声约 3000–4500；助手自己的声音比用户还大，**任何固定/自适应能量阈值都无法在助手大声说话时可靠区分两者**。自适应门槛只能利用句子间停顿（串音降到 0–200）让“停”生效；要“随时打断”必须引入 AEC（用 TTS 作参考）或换指向性/带杆麦克风。耳机模式已实测可稳定打断。
68. **外放打断的正确突破口不是 AEC，而是“原始麦 KWS + 声纹门控”**（2026-11-17）：真实双讲录音中，AEC3 纯回声 ERLE 很好，但双讲时把用户人声当回声压掉（2.0–3.0s ERLE 33.6dB，原始声纹 0.594 → AEC 0.114），KWS 在 AEC 输出上漏掉“停一下”。反过来，原始混合信号上 KWS 命中 3.1s/5.6s/6.9s 三次用户停词；对 KWS 命中窗口取最近 ~1s 做 ERes2Net，用户窗口 0.39–0.59，而 Huihui TTS “已暂停当前任务/要停止吗” 的同窗口只有 0.106/0.123。阈值 0.35 可同时做到“用户停词通过、助手自回声拒绝”。已用 `sherpa-onnx-node` 在 Electron 主进程内实现，不依赖 Python sidecar；`keyword-gate.test.ts` 覆盖用户双讲通过、TTS 自回声拒绝、耳机模式仍走声纹三种场景。AEC 保留给后续“新任务 ASR”，但必须先解决双讲近端抑制，不能直接串在 KWS 前。
69. **UI 显示“耳机”但输出实际是 Realtek 时，旧耳机能量路径会自打断**（2026-11-17 11:03 实测）：日志 `barge-in { avg: 3654, mode: 'headset' }` 出现在助手刚开始说 “Hello! How can I help you?” 后约 0.5s，当时语音模式是 headset、输出标签却是 Realtek；3654 与助手自身外放电平吻合，说明是扬声器串音触发了耳机的 1500/180ms 能量阈值。修复：主进程记录渲染端实际上报的输出标签，`isExternalOutputLabel()` 判定 Realtek/NVIDIA/扬声器/HDMI 为外放；只要实际是外放，即使 UI 仍是耳机模式，也走参考/声纹路径，不启用低阈值耳机能量打断。
70. **真机声纹比离线低一半**（2026-11-17 11:27）：KWS 已在外放中命中“别说了”，但声纹 0.2696 < 0.35 被拒。离线同句 0.409–0.562。主要差异是 Chromium 采集默认开 NS+AGC，且真机 1s 窗口回声占比更高。已关闭隐藏采集窗的 NS/AGC；多字阈值降到 0.20、单字“停”0.25、能量兜底 0.22；KWS 可用时禁用旧直接打断路径。
71. **外放纯能量 A/B 实锤自打断**（2026-11-17 11:55）：speaker 模式开启 energy-only 后，助手刚说 “Hello” 即在 avg 2693/4310/1956 连续触发 `barge-in { mode: 'energy-only' }`；回声比人声大，纯能量不可用。11:00 的真实组合是 headset 语音模式 + Realtek 输出（回声小）。默认已切回 KWS+声纹，`Ctrl+Alt+E` 保留对比。
72. **蓝牙断连根因指向“warm 流 stop 后重开”**（2026-11-17 23:40）：App 关闭时用 sounddevice 连续录 3 分钟，`cc ultimate` 稳定，WAV 178.35s/180s，无可视频繁断片；随后把隐藏采集窗从“getUserMedia warm → stop → enumerate → 再 getUserMedia(deviceId)”改为**只打开一次流并复用**，90 秒稳定性测试 `disconnect_count=0 / capture_error_count=0`；切外放模式触发采集重启后也保持 `capture ready`。蓝牙 HFP 对开流/关流/重开很敏感，这很可能是 15–30 秒断连的根因。
73. **“喊了好几次才停”的两次近失**（2026-11-17 23:49）：同一轮里 23:49:02 score=null（刚开播，`capturePreroll` 在 response start 被清空，1s 窗口不足 0.5s），23:49:06 score=0.0998（阈值 0.1，差 0.0002），23:49:10 score=0.2725 才通过。真机 TTS 回声失败样本是 0.035/0.0618/0.0754/0.0998 中的前三个，用户近失 0.0998。修正：增加不随回复清空的 `keywordPreroll` 连续 1s 缓冲；非停词语境能量兜底阈值 0.1→0.085，仍高于本轮 TTS 回声最大值 0.0754。
74. **“后面喊停都不行”发生在 5 分钟麦克风掉线期内**（2026-11-18 00:03）：23:58:11–00:03:19 连续 `capture error`，这期间任何 KWS/声纹都不可能工作；00:03:23 恢复后，00:04:06 单字“停”、00:04:23/54“停一下”、00:04:37 能量兜底都成功。不是算法在恢复后失效，而是输入中断。
75. **停后新指令变慢是抑制窗口过长**：旧版 barge 后 `muteMicFor(1500)` + `postBargeSilenceMs(2500)` + 3.5s 回复抑制，用户紧接着说新指令会被延迟/取消。改为 muted 800ms、ASR 静默 1000ms、抑制 3000ms，并在收到长度≥3 且非纯数字的新 transcript 时立即清除抑制；纯数字/短碎片（回声）仍被挡。
76. **“得大声喊才行”是 AGC 被关闭导致**（2026-11-18 00:08）：日志里只有 avg 6241/8144 的“停了”被 KWS 命中（score 0.1109），正常音量的“停”没有进 KWS/兜底。此前为了声纹通道关闭了 Chromium AGC，入耳麦正常说话电平太低。修正：保留 `noiseSuppression: false`（不改变声纹通道），重新打开 `autoGainControl: true`，让正常音量进入 KWS/能量阈值。
77. **“喊停时还在念诗”是 KWS 在 00:10:13 之前没命中**（2026-11-18 00:10）：00:09:50 的“停一下”强词直接停成功；随后念诗期间用户多次喊“停”，直到 00:10:13.390 才第一次 `detected '停'`（score 0.2681，accepted），bargeToStop 2ms。此前不是停止动作慢，而是单字“停”没被 KWS 检出。修正：KWS threshold 0.1→0.05；当 TTS 当前文本不含“停/暂停/停止”时，弱词“停”也直接停，不再等声纹；只有 TTS 正在说停词时才走 0.25 声纹门控。
78. **长回复里相对声纹失效是播放参考的生命周期 bug**（2026-11-18 00:26）：`WebAudioStreamPlayer.pump()` 把待播 PCM 拼成一个整段 `AudioBuffer`，整段只上报一次 `startedAt`；`SpeakerEchoDetector.prune()` 按段开始时间淘汰，5s 后唯一参考段被删除，`relativeAvailable=false`，兜底路径整段不接受。进一步改成 1s 分块后还有第二层：渲染端会一次把几十秒的块排到未来，`addReference()` 若用最新（未来）块的 `startedAt` prune，会立刻删掉正在播放的近端参考。修复：播放端 1s 分块、每块单独 `onSegmentStart`；检测器用最近一次 `analyze()` 的采集时钟 prune（保留未来段、只淘汰已播放超过 5s 的段），`analyze()` 跳过尚未开始的段。新增“长回复排队时保留近端参考”单测，speaker-barge 6/6、cyrvis 79/79 通过。
79. **相对声纹修复后的真机外放实测**（2026-11-18 00:29–00:30）：应用重启后用户切到外放（Realtek）。`relativeAvailable` 在播放约 0.7–1s 后为 true，长回复全程保持。助手念介绍/毛泽东生平时 3 次“任意说话”打断成功：00:29:02.470 margin +0.3268（user 0.2781 / tts -0.0487）、00:29:25.401 margin +0.0655（0.0592 / -0.0063）、00:30:11.758 margin +0.106（0.1973 / 0.0912，bargeToStop 2ms）。回声/背景声检查均被拒：00:29:00.741 margin -0.4463、00:29:24.5 -0.066、00:30:20.71 +0.0248（未达 0.05）。结论：长回复参考失效已修复；“任意说话”可在 TTS 停顿/用户声占优时生效。连续大声 TTS 期间，混合窗口仍由回声主导（margin 可低至 -0.49），此时快速路径是 KWS 停词（TTS 文本无停词时直接 barge），这是单麦外放的物理上限。
80. **连续 TTS 中的双讲打断也已出现**（2026-11-18 00:30:43）：`avg=5617`（TTS 正在播放）时 userScore 0.2047 / ttsScore 0.1431 / margin +0.0616，accepted，bargeToStop 1ms。说明用户声音压过回声时，相对声纹可在连续播报中直接打断，不必等到停顿；margin 0.05 的门槛目前没有产生误打断。
