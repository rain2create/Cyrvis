# cyrvis/proactivity

主动性相关说明入口。当前核心实现在上级 `../proactivity.ts` 与
`../follow-up-service.ts`，编排/自主性在 `../orchestration/autonomy-engine.ts`。

职责：

- 任务事件（开始/完成/失败/取消）的主动播报、优先级、冷却与免打扰；
- 启动/激活后的问候与上次任务概况；沉默 10 秒的闲置追问默认关闭；
- 与眼动主动提醒协调，避免任务播报和注视播报互相打断；
- 旅行攻略的分层追问由 `intake/` 与 `travel/` 承担，不在本目录重复实现。

边界：

- 主动播报必须走 `VoiceBrain` / `provider.speak`，不能绕过语音队列；
- 高风险动作只建议，不自动执行；
- 隐私相关感知（剪贴板/文件/截图）必须可关闭。

详见 [doc/architecture.md](../../../../../../doc/architecture.md) 与
[doc/roadmap.md](../../../../../../doc/roadmap.md)。
