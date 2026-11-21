# CYRVIS 语音架构（最终实现）

> **2026-11-21 当前实现说明（先读）**
>
> 默认 `CYRVIS_VOICE_ENGINE=omni` 时，麦克风由主 Renderer 的 `VoiceRuntime` 采集，
> `CYRVIS_RENDERER_CAPTURE` 默认开启；主麦克风始终请求 AEC，另开一路 raw mic 仅给本地 KWS，
> 避免 AEC 压掉“停一下”。打断链路为：快速能量判断 + 播放 PCM 参考互相关 + 文本回声过滤 +
> KWS/声纹兜底；注视播报期间使用 readout guard，明确停止词/按钮仍优先。
> 旧的隐藏采集窗口路径 `capture-service.ts` 仅作兼容和 cascade 场景使用。
>
> 下文第 1–5 节的“隐藏采集窗口 + echoCancellation:false”是 **2026-11-16 的历史方案**，
> 保留用于理解阈值/回声检测的来龙去脉；当前拓扑以本节和
> [architecture.md](./architecture.md) 为准。

> 状态：2026-11-16 实现参考信号回声检测与双模式语音打断。
> 目标：端到端实时语音对话 + 语音打断 + 语音控制 GUI Agent。
> 相关文档：[architecture.md](./architecture.md)（整体）、[roadmap.md](./roadmap.md)（后续）、
> [findings.md](./findings.md)（排障记录）、[archive/voice-implementation-v1.md](./archive/voice-implementation-v1.md)（历史清单）。

## 1. 结论先行

语音打断**不能在“同一个渲染进程里边播放边采集”**：在 Windows/Electron 下，Chrome 的 AEC 会把该渲染进程的麦克风采样归零（`avg=0`，轨道仍为 `live`）。
最终方案把**采集**和**播放**拆到两个渲染窗口：

- **隐藏采集窗口**：只 `getUserMedia`，不播放任何声音；
- **主窗口**：只负责 TTS 播放（WAV 分段）；
- **主进程**：接收采集 PCM，负责正常 ASR 转发、播放参考回声检测和播报期间的打断检测。

拆分后播放期间采集电平正常（用户人声 3000–16726），打断日志实测 `barge-in avg=4110/4910`。

## 2. 拓扑

```
┌─────────────────────────────┐        ┌──────────────────────────────┐
│ 主窗口 Renderer             │        │ 隐藏采集窗口 Renderer        │
│ - 语音条 UI                 │        │ - 仅 getUserMedia            │
│ - TTS 播放（WAV 分段）      │        │ - 不播放任何声音             │
│ - 不采集麦克风              │        │ - PCM → 本地 WebSocket       │
└──────────────┬──────────────┘        └──────────────┬───────────────┘
               │ IPC                                  │ ws://127.0.0.1:<port>/ws
               ▼                                      ▼
┌───────────────────────────────────────────────────────────────────────┐
│ Electron Main                                                          │
│  VoiceService                                                          │
│   ├─ CaptureService：HTTP/WS + 隐藏窗口，PCM 回调                       │
│   ├─ 打断检测：能量阈值 1000 / 持续 150ms / 600ms 预录                  │
│   ├─ QwenOmniProvider：ASR + TTS + Function Calling + 本地 VAD          │
│   ├─ VoiceBrain：意图路由、主动播报、确定性暂停/取消                    │
│   └─ CyrvisController → ElectronGUIAdapter → UI-TARS GUIAgent           │
└───────────────────────────────────────────────────────────────────────┘
```

## 3. 采集链路

| 项       | 实现                                                                                                            |
| -------- | --------------------------------------------------------------------------------------------------------------- |
| 容器     | `BrowserWindow({show:false, backgroundThrottling:false})`                                                       |
| 页面     | 主进程内置 HTTP 服务 `http://127.0.0.1:<随机端口>/capture`                                                      |
| 设备选择 | 先 `getUserMedia({audio:true})` 触发权限 → 枚举 → 选显式物理设备；**禁止** default/communications/ToDesk 虚拟麦 |
| 约束     | `echoCancellation:false`、`noiseSuppression:true`、`autoGainControl:true`、单声道                               |
| 重采样   | 设备原生采样率 → 16 kHz（线性插值）                                                                             |
| 分块     | 320 samples（20ms）Int16 → WebSocket 二进制                                                                     |
| 热插拔   | 主窗口监听 `devicechange`，800ms 防抖后调用 `cyrvis:voice:restart-capture`                                      |
| 断连     | 采集 track `ended` → 上报 `capture-error`，语音条显示错误                                                       |

关键文件：`apps/ui-tars/src/main/cyrvis/capture-service.ts`

## 4. 播放链路

| 项   | 实现                                                                |
| ---- | ------------------------------------------------------------------- |
| 输入 | Qwen `response.audio.delta`（PCM16 / 24 kHz / 单声道）              |
| 分段 | 每 0.75s（18000 samples）一个独立 **WAV Blob**                      |
| 播放 | 隐藏 `<audio>` 元素顺序播放，`ended` 后播下一段                     |
| 输出 | 默认设备；可临时切到 Realtek 扬声器（见第 9 节）                    |
| 空闲 | 最后一段 `ended` → `notifyPlaybackIdle()` → 主进程开麦/结束打断窗口 |

为什么不用 Web Audio / MediaSource：两者都会触发 Chrome AEC 把采集归零；普通 WAV 文件（blob URL）不会。

关键文件：`apps/ui-tars/src/renderer/src/components/CyrvisVoice/wav-player.ts`（原 mp3-player，已重命名为 WAV 分段播放器）。

## 5. 打断链路

1. 主进程在 `onResponseStarted` 将 `assistantPlaybackActive = true`。
2. 采集 PCM 持续进入 `handleCapturePcm`：
   - 计算每 20ms 块的平均能量；
   - 维护最近 30 块（约 600ms）预录缓冲；
   - 始终用主窗口实际播放的 WAV PCM 作为参考信号，在最长 500ms 延迟内做互相关；
   - 强相关片段判定为自身回声，直接丢弃；
   - 弱相关且能量持续超过阈值的片段判定为用户声音，触发打断；
   - 介于两者之间的混合信号短暂暂停 TTS，等待 220ms 尾音衰减后继续确认；
   - 播报中：能量 > **1000** 且持续 **150ms** 才进入打断判断；
   - 非播报：PCM 正常送 Provider（本地 VAD/ASR）。
3. 触发后：
   - `provider.bargeIn()`：`response.cancel` + 丢弃旧响应残留音频 + 清空输入缓冲 + 开麦；
   - 广播 `cyrvis:voice:response-stopped` → 主窗口停播；
   - 回灌预录 PCM 给 Provider，用户说的“停”不会被截掉；
   - `VoiceBrain` 收到转写后执行确定性控制。
4. 兜底：全局快捷键 `Ctrl+Alt+X` / 语音条 **Interrupt** 按钮。

关键阈值：

| 参数             | 值     | 说明                                   |
| ---------------- | ------ | -------------------------------------- |
| 主 VAD 阈值      | 900    | AirPods 噪声底 700–900，人声 1700–4500 |
| 主 VAD 最短语音  | 300 ms | 过滤 20–160ms 噪声尖峰                 |
| 端点静音         | 800 ms | 兼顾自然停顿与响应速度                 |
| 打断能量阈值     | 1000   | 播报期间进入打断判断的最低能量         |
| 打断持续         | 150 ms | 短促“停”也能触发                       |
| 回声参考最大延迟 | 500 ms | 覆盖设备、系统和房间直达到达差         |
| 回声强相关阈值   | 0.72   | 达到后按自身回声丢弃                   |
| 回声混合信号阈值 | 0.18   | 以上且低于强相关阈值时进入暂停确认     |
| 暂停确认尾音衰减 | 220 ms | 暂停 TTS 后等待扬声器尾音下降          |
| 暂停确认持续语音 | 140 ms | 尾音衰减后继续检测到用户语音则确认     |
| 暂停确认总超时   | 700 ms | 未检测到持续语音则恢复播放             |
| 确认后恢复抑制   | 550 ms | 避免恢复播放后立即重复触发             |
| 预录缓冲         | 600 ms | 保留句首                               |
| 取消标志窗口     | 400 ms | 防止误杀打断后的新响应                 |
| TTS 分段         | 750 ms | 听感已验证无明显卡顿                   |

## 6. 对话与任务链路

```
用户语音
  → CaptureService PCM
  → QwenOmniProvider.sendAudio
  → 本地 VAD 提交（800ms 静音）
  → Qwen ASR / Function Calling
  → VoiceBrain.handleTranscript
      ├─ 唤醒/常开监听
      ├─ IntentGate：chat / task / control / ambiguous
      ├─ 确定性控制：停/取消/暂停 → Controller
      └─ start_gui_task → Controller → ElectronGUIAdapter → GUIAgent
  → Controller 事件 → ProactivityPolicy → Provider.speak
  → TTS → 主窗口 WAV 分段播放
```

确定性控制优先于模型工具调用，避免“模型说暂停了但 GUI 还在跑”。

## 7. 关键文件

| 文件                                           | 职责                                                      |
| ---------------------------------------------- | --------------------------------------------------------- |
| `main/cyrvis/capture-service.ts`               | 隐藏采集窗口 + 本地 HTTP/WS + PCM 桥                      |
| `main/cyrvis/voice-service.ts`                 | 单例服务、IPC、采集启动/热插拔、打断检测、快捷键          |
| `main/cyrvis/voice/qwen-omni.ts`               | Qwen Realtime WebSocket、ASR/TTS/工具调用、本地 VAD、取消 |
| `main/cyrvis/voice-brain.ts`                   | 意图路由、唤醒、确定性控制、主动播报、完成声明拦截        |
| `main/cyrvis/controller.ts`                    | 单任务状态机、暂停/恢复/取消、事件总线                    |
| `main/cyrvis/gui-adapter.ts`                   | 包装现有 `runAgent`/`GUIAgent`，映射任务状态              |
| `main/cyrvis/speaker-barge.ts`                 | 播放参考 PCM 与麦克风 PCM 的回声相关性检测                |
| `renderer/.../CyrvisVoice/useVoiceAudio.ts`    | 语音条状态、播放器、外部采集状态                          |
| `renderer/.../CyrvisVoice/useFloatingVoice.ts` | 悬浮窗纯 UI 订阅：转写、回复、任务事件，不接管采集与播放  |
| `renderer/.../pages/widget/`                   | 右侧常驻语音面板：聊天、活动、打断、唤醒、暂停与取消      |
| `renderer/.../CyrvisVoice/wav-player.ts`       | WAV 分段播放器                                            |

## 8. 排查入口

| 现象             | 看什么                                                           |
| ---------------- | ---------------------------------------------------------------- |
| 没有语音输入     | `[cyrvis capture] ready/error`；设备是否被选为物理麦             |
| 播报中不能打断   | `[cyrvis speaker] echo analysis`、`interrupt confirmed` 是否出现 |
| 打断后没有新回复 | `transcript` 是否为空；`forceNextCommit` 是否生效                |
| TTS 无声         | `wav stream player created`、`wav player error`、`playback idle` |
| 任务停得慢       | `transcript` → `Request was aborted` / `user_stopped` 的时间差   |
| AirPods 断开     | `devicechange` → 自动 `restart-capture`；重新连上即可            |

## 9. 两种模式：耳机 / 外放

语音条右侧有 **耳机 / 外放** 两个并列按钮，点击即选中。两种模式都启用播放参考回声检测，不依赖浏览器 AEC 防止自听。

| 模式 | 麦克风 | 扬声器输出 | 语音打断 |
|---|---|---|---|
| 耳机 | 蓝牙耳机麦克风 | 蓝牙耳机本身 | **可用**，主要依赖能量阈值 |
| 外放 | 蓝牙耳机麦克风 | 主机 Realtek/所选扬声器 | **可用**，依赖播放参考回声检测与暂停确认 |

切换模式时 App 自动做三件事：

1. 用 `scripts/cyrvis/audio/set-default-output.ps1` 切换 **Windows 默认播放端点**（耳机 → Bluetooth A2DP；外放 → Realtek 模拟扬声器）；
2. 把主窗口 `<audio>` 的 `setSinkId` 切到同一设备；
3. 重启隐藏采集窗口，但**不改变麦克风**，始终优先物理耳机麦克风。

之所以要同时改 Windows 默认端点：实测 Windows 会把 Electron 的整条音频会话留在蓝牙耳机上，单靠 `HTMLMediaElement.setSinkId(Realtek)` 有时不生效；默认端点切到 Realtek 后，试听/播报稳定走主机扬声器。

外放模式采用“普通 ASR 半双工、打断检测全双工”：

- 播报期间不把普通采集 PCM 直接送入 ASR；
- 但麦克风持续参与参考信号相关性检测，用户随时可以开始打断；
- 明确用户声音直接取消当前回复；
- 回声与用户声音混合时短暂暂停播放，用户继续说话则确认打断，否则恢复播放；
- 播放结束后保留 **1400ms** 尾音窗口，同时继续用参考相关性过滤残余回声；
- 对最终转写与助手刚说文本做相似度检查，命中时取消潜在响应并记为回声；
- 避免“它听到自己的外放 → 一直你好”的反馈循环。

高级控件：

- **输出设备下拉框**：手动覆盖模式预设；日常用模式按钮即可；
- **试听**：在当前选中的设备上播放 1 秒 440Hz 测试音，用于确认物理接口；
- 模式和设备分别持久化到 `localStorage`，重启后恢复。

AEC 实测结论：隐藏采集窗口开启 `echoCancellation:true` 后，播放期间仍收到自己的外放（`barge-in avg=8640`），因为该渲染进程没有主窗口播放的参考信号。因此浏览器 AEC 不能作为主要防线；当前实现由主进程持有实际播放参考 PCM，并配合能量门控、相关性判断、暂停确认探针和最终转写相似度兜底。若外放串音仍导致误判，`Ctrl+Alt+X` / Interrupt 始终可用。

### 任意输出设备（调试）

需要指定 Realtek/NVIDIA/其他设备时，仍可用主进程广播的调试接口：

```js
// 切换输出并临时进入对应模式
await window.electron.voice.setOutput('扬声器 (Realtek');
await window.electron.voice.setOutput('F24G30Q Pro');
// 恢复默认输出（耳机）
await window.__cyrvisResetOutput();
```

主进程收到 `cyrvis:voice:set-output` 后广播，每个语音 Hook 枚举 `audiooutput`、匹配 label、调用 `HTMLMediaElement.setSinkId`；播放器每段音频都会重新应用 sink。设置只对当前会话有效，刷新/重启恢复默认。

## 10. 实测记录

| 时间     | 事件             | 值/结果                                                          |
| -------- | ---------------- | ---------------------------------------------------------------- |
| 19:54:09 | 隐藏采集窗口就绪 | `label: 耳机 (cc ultimate) (Bluetooth)`                          |
| 19:54:22 | 播报中喊停       | `barge-in avg=4110`，立即 `playback idle`                        |
| 19:54:34 | 第二次打断       | `barge-in avg=4910`，转写“停呀。”                                |
| 19:56:54 | 取消任务语音     | 转写后 `cancel_gui_task`，任务在 19:58:32 以 `user_stopped` 结束 |
| 19:58:29 | 取消任务语音     | 转写“取消这个任务…”，GUI 请求在 19:58:32 被 abort                |
| 播放期间 | 耳机漏音         | 采集电平 0–10，不误触发                                          |
| 用户说话 | 采集电平         | 3000–16726                                                       |

## 11. 已知限制与后续

1. **任务停止延迟**：ASR 端点 + 转写约 1.5–2.5s；GUI 当前 VLM 请求需等 abort 生效，额外 1–3s。可考虑“播报中检测到打断即先暂停任务”，不必等转写。
2. **AirPods 自动断连**：Windows 蓝牙省电导致；已加 `devicechange` 自动重启采集，但仍建议 Demo 用 USB 耳机/有线麦。
3. **本地 WS 端口**：随机 127.0.0.1 端口；打包时需确认防火墙/端口策略。
4. **TTS 分段听感**：0.75s 已验证无明显卡顿；若换设备出现间隙，可增大到 1.5s。
5. **输出设备 UI**：已有“耳机/外放”按钮；更细的设备选择（显示器音箱等）仍可用调试函数。
6. **跨会话记忆**：`memory.ts` 持久化最近对话、显式长期事实和 Activity，并在启动时注入 Qwen Realtime `session.update.instructions`。
7. **原生采集 sidecar**：若后续需要完全绕开 Chromium，可用 Python/PortAudio 或 Node 原生模块替换隐藏窗口采集。

### 现场声学验证

当前代码已经支持外放模式语音打断，但真实效果仍依赖扬声器音量、麦克风位置和房间混响。需要在目标设备上验证：

1. **播放期间不说话**：日志应持续显示高相关性，不能暂停或取消回复。
2. **播放期间说完整问题**：应尽快暂停播放，并在确认后转写用户问题。
3. **播放期间只说“停”**：低相关用户声音应直接触发；混合信号允许短暂暂停确认。
4. **暂停后不说话**：应在 700ms 内恢复播放，不能把回复永久卡住。
5. **播放刚结束立即追问**：尾音过滤不能吞掉新的用户问题。

如果某些扬声器环境持续产生低相关混响，下一步应加入自适应 FIR/AEC，而不是继续提高能量阈值。`Ctrl+Alt+X` / Interrupt 始终保留为兜底。

测试记录模板：

| 项                 | 目标值                     |
| ------------------ | -------------------------- |
| 播放期间串音电平   | 越低越好                   |
| 用户说“停”时的电平 | 明显高于串音               |
| 建议阈值           | 串音与人声之间，持续 150ms |
| 失败回退           | 短时半双工 + Ctrl+Alt+X    |

## 12. 语音模型配置（2026-11-16）

Token Plan 的 `sk-sp-…` Key 不能走公共 DashScope，必须使用独立 host：

```env
QWEN_MODEL=qwen-audio-3.0-realtime-plus
QWEN_VOICE=longanqian
QWEN_REALTIME_URL=wss://token-plan.maas.qianwenaiapi.com/api-ws/v1/realtime?model=qwen-audio-3.0-realtime-plus
```

- 模型列表：`GET https://token-plan.maas.qianwenaiapi.com/compatible-mode/v1/models`。
- Token Plan 当前只提供 `qwen-audio-3.0-realtime-plus`，没有 flash。
- 实测 App 兼容会话（`turn_detection:null`、16k 输入/24k 输出 PCM、tools）返回 `session.updated`；文本转语音返回 5 个 `response.audio.delta`、96000 字节 PCM（约 2 秒）。
- 同 host 的 `/v1/realtime`、`/ws/v1/realtime`、`/realtime` 为 404；`/compatible-mode/v1/realtime` 可握手，但 App 使用 DashScope 协议，配置 `/api-ws/v1/realtime`。
- 日志出现 `qwen session ready` → `qwen connected` → `wake` 即表示语音链路已连上；采集仍要求 Windows 存在物理麦克风，`ToDesk Virtual Audio` 会被拒绝。
