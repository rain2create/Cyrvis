# CyrvisUI

CYRVIS 工作台/页面级 UI 的说明入口。当前主要界面已经拆分到：

| 组件 | 职责 |
|---|---|
| `../CyrvisVoice/` | 语音采集、播放、打断、历史、浮层 |
| `../CyrvisGaze/` | 眼动校准、注视可视化、AI 看屏控制 |
| `../CyrvisRuntime/` | 编排任务、自主建议、能力合成面板 |
| `../CyrvisCompanion/` | 桌面伴侣外观与气泡 |
| `../Conversation/` | 对话消息与 GazeTurn 卡片 |
| `pages/widget/` | 右侧常驻语音面板 |

约束：

- 只消费 `VoiceUiState` / `ControllerEvent` / Runtime snapshot；不直接调用模型；
- 不自行采集麦克风或注册第二套播放链路；
- 大依赖按需加载，不阻塞语音主链路；
- GUI 执行时主窗口可能隐藏，任务状态同步到伴侣/任务面板。

详见 [doc/architecture.md](../../../../../../../doc/architecture.md)。
