# CYRVIS GUI benchmark harness (first batch)

First batch: **L1, L4, L5, R1**; each run once. See
`doc/archive/gui-acceleration-plan-20261116.md` for the full design.

## Prerequisites

1. Fixture server:
   ```bash
   node scripts/cyrvis/bench/fixtures/server.js
   ```
2. App with CDP:
   ```bash
   pnpm --filter ui-tars-desktop debug
   ```
3. Desktop idle: do not move the mouse or switch windows while a task runs.

## Run one task

```powershell
powershell -File scripts/cyrvis/bench/setup.ps1 L1
node scripts/cyrvis/bench/run-task.js "在当前记事本文档末尾输入 batch test，然后按回车，并保存文件。"
```

Success oracles:

| Task | Oracle |
|---|---|
| L1 | `D:\temp\cyrvis-bench\l1-notepad.txt` equals `PRE batch test\n` |
| L4 | `http://127.0.0.1:8765/state` has `detailVisits` containing 3, and the run's `finished()` text contains `detailCode` |
| L5 | `D:\temp\cyrvis-bench\code-target.txt` contains `shortCode` from `/state` |
| R1 | final `finished()` text contains a price/flight number; environment failures (CAPTCHA/login) are recorded separately |

Useful commands:

```bash
curl http://127.0.0.1:8765/state
curl http://127.0.0.1:8765/reset
```

## Notes

- L4 links use `target="_blank"`, so the model must switch to the new tab.
- L5 starts with Chrome foreground; Notepad is open behind it with an empty
  `code-target.txt`. The model must switch apps and save.
- R1 is read-only: no login, booking, or passenger information.
- The app log is `D:\Desktop\project\CYRVIS\dev-ui-tars-bench.log`; parse
  `[GUIAgent] action batch`, `[GUIAgent] consumes`, and the final `loopCnt`.
