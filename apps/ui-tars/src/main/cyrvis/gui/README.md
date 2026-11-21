# cyrvis/gui

该目录保留为 GUI 加速/路由的历史入口说明；当前实现已经落到：

| 能力 | 当前实现 |
|---|---|
| 任务调度、队列、暂停/取消 | `../orchestration/` |
| 快速工具路由 | `../tools/router.ts`、`../tools/matrix.ts` |
| 简单任务直连 | `../tools/` 的基础工具与 `CapabilityBroker` |
| MCP | `../tools/mcp-server.ts`、Provider 系统 |
| GUI 执行 | `../gui-adapter.ts` → `../../services/runAgent.ts` → UI-TARS SDK |

约束仍然有效：

- 不直接在 `voice-brain.ts` 内部堆叠复杂 GUI 规划；
- 所有工具调用必须有超时、取消、权限和审计；
- 新能力先走工具/Provider 接口，再考虑 GUI 视觉循环。

详见 [doc/architecture.md](../../../../../../doc/architecture.md) 与
[doc/roadmap.md](../../../../../../doc/roadmap.md)。
