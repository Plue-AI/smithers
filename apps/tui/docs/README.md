# TUI documentation

## Record a model run

```bash
SMITHERS_TUI_APPROVE=all SMITHERS_TUI_RECORD=run.jsonl bun apps/tui/src/ask.ts "Fix the failing check."
SMITHERS_TUI_REPLAY=run.jsonl bun run tui /path/to/scratch-project
```

`SMITHERS_TUI_REPLAY_SPEED` divides recorded delays. `SMITHERS_TUI_REPLAY_HOLD_MS` holds each reply before its first delta, useful for cancellation and queue examples. Replayed cells still have real effects: use a disposable project.

The native unit suite is `bun test ./test` from `apps/tui`. The PTY suite is `bun test ./e2e` and requires tmux. See [testing](testing.md) for prerequisites and coverage.
