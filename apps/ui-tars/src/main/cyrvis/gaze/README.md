# cyrvis/gaze

眼动模块（2026-11-21 已合入 main，实验状态）。

职责：

- 校准、平滑、偏移补偿与注视对象识别；
- 冻结注视区域并截图，调用 Settings 中的视觉模型做只读识别；
- `chat.ts`：把截图、回答、语音排队/播放回执关联到同一条 GazeChatTurn；
- `proactive.ts`：持续注视计时、冷却、语音未连接时重试；
- `execution.ts`：把“打开/播放它”绑定到注视对象，首次点击必须落在洋红框内；
- `cursor.ts` / `object-tracker.ts`：桌面光标与对象吸附/锁定框；
- 截图和点击期间隐藏助手浮层，避免把语音气泡当成目标。

边界：

- 默认本地处理摄像头数据；只有显式看屏/主动提醒才发送区域截图；
- 视觉模型只读；桌面执行仍经过 `CyrvisController` / GUI Agent；
- 眼动精度未达生产级，失败时应重新锁定，不强行点击。

详见 [doc/gaze-integration.md](../../../../../../doc/gaze-integration.md) 与
[doc/architecture.md](../../../../../../doc/architecture.md)。
