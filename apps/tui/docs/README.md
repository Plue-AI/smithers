# TUI recordings

The files in `recordings/` hold the scripts behind every TUI GIF on [smithers.sh](https://smithers.sh/docs/tui/). A `tui-script` fence names a scenario and drives the actual TUI in a private PTY. Model responses are deterministic fixtures; cells, file changes, session writes, controls, and checks execute for real.

```tui-script recording-example
Use "basic"
Type "Explain math.js"
Press Enter
Wait for answer "Ready."
Capture "A Markdown script executes the terminal and captures its result."
```

## Script vocabulary

| Instruction                              | Effect                                                                |
| ---------------------------------------- | --------------------------------------------------------------------- |
| `Use "basic"`                            | Select a reviewed fixture; must be first.                             |
| `Type "text"`                            | Type text into the actual terminal.                                   |
| `Press Ctrl+S`                           | Send a named key; single-letter controls are also supported.          |
| `Wait for answer "Fixed"`                | Require a saved successful answer; source text cannot satisfy it.     |
| `Wait for worker "review" status "done"` | Require the latest saved worker status; `monitor` is also supported.  |
| `Wait for "text"`                        | Require visible terminal output before continuing.                    |
| `Wait 500 ms`                            | Wait for an animation or guarded interaction; bounded to ten seconds. |
| `Capture "caption"`                      | Save a frame and its text transcript.                                 |
| `Expect file "math.js" contains "a + b"` | Verify the real fixture file.                                         |
| `Restart`                                | Stop the process and reopen the same session with `-c`.               |

Browser examples use `browser-script` with `Click`, `Fill`, and `Capture` against the real playground. Provider responses are controlled at the HTTP boundary.

## Build and cache

```bash
pnpm exec smthrs build '//apps/tui-docs:recordings'
pnpm --filter @smithers/site run capture:learn tui
pnpm exec smthrs test '//apps/tui-docs:browserTests'
```

`:build` depends on `:recordings`, the Markdown, the renderer/runtime source closure, and the lockfile. The recorder hashes scenario inputs and tool versions, verifies cached artifact hashes, and publishes a receipt after assertions and encoding succeed. A changed caption or script invalidates its recording. GIFs, reduced-motion PNGs, transcripts, and receipts are build outputs.

Install the pinned Node, Bun 1.4 or later, Python 3, Git, FFmpeg, Chromium, and the native workspace helper for flow examples. `CHROME_BIN`, `FFMPEG`, `SMITHERS_DOCS_BUN`, and `SMITHERS_WORKSPACE_JJ_EXPORT_BINARY` select installed tools. A failed example fails the build.

## Record a model run

```bash
SMITHERS_TUI_APPROVE=all SMITHERS_TUI_RECORD=run.jsonl bun apps/tui/src/ask.ts "Fix the failing check."
SMITHERS_TUI_REPLAY=run.jsonl bun run tui /path/to/scratch-project
```

`SMITHERS_TUI_REPLAY_SPEED` divides recorded delays. `SMITHERS_TUI_REPLAY_HOLD_MS` holds each reply before its first delta, useful for cancellation and queue examples. Replayed cells still have real effects: use a disposable project.

The native unit suite is `bun test ./test` from `apps/tui`. The PTY suite is `bun test ./e2e` and requires tmux. See [testing](testing.md) for prerequisites and coverage. Documentation capture has its own Python PTY driver and does not require tmux.
