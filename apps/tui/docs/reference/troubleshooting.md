---
title: Troubleshooting
description: Read failures, find logs, and recover without hiding unfinished work.
order: 25
section: Reference
---

Start with the failed row. **Ctrl+O** expands its error details; `/session` gives the session and log paths.

```tui-script provider-failure
Use "failure"
Type "Explain math.js"
Press Enter
Wait for "Example provider refused"
Capture "A provider refusal remains visible."
Press Ctrl+O
Capture "Expand the recorded failure before retrying."
```

| Symptom                                | Next action                                                                                                                                 |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| No model is available                  | Configure a supported provider key or account; reopen the TUI.                                                                              |
| Model is missing from the picker       | Check the provider's credentials. The picker lists detected access, not every public model.                                                 |
| Worker is parked                       | Read its reset time; wait, stop, or resume with an available model.                                                                         |
| Worker says failed                     | Read its row, expand the error, then **r** or `/retry id`; use **m** to change model.                                                       |
| Work says requested                    | Wait for a running or terminal receipt. The launch is not completion.                                                                       |
| `Stop running work first`              | Stop or finish active turns/workers/flows before changing sessions or undoing.                                                              |
| Undo says a file changed               | Review the newer edit. Undo deliberately refuses to overwrite it.                                                                           |
| Flow changed but still runs old code   | Restart the TUI; listing refresh and imported module execution are separate.                                                                |
| Flow discovery or host startup fails   | Inspect `tui.log`, dependency installation, runtime version, and the native workspace helper. Do not run two executors in the same project. |
| Input form disappeared                 | Open the flow tab and press **a**. Closing the form leaves the run parked.                                                                  |
| Keys type letters instead of approving | Empty the editor and wait for the row to display its approval shortcuts.                                                                    |
| Clipboard fails                        | Install a supported clipboard command; see [chat](../guides/chat.md#read-and-copy).                                                         |
| Monitor creation is refused            | Configure `AI_GATEWAY_API_KEY`; shell monitors also need command approval.                                                                  |
| Saved session is missing               | Check its working directory and session root. Earlier JSONL damage is preserved as `.damaged`.                                              |
| Browser run cannot resume              | Re-enter its provider settings; keys are not stored. Branch if the saved request no longer matches.                                         |
| Browser history is full                | Copy needed results before clearing site data; the sandbox limits history to 4 MB.                                                          |

## Record a reproducible report

Include the command, runtime version, steps, visible failure, and a redacted session excerpt. Sessions may contain source patches; check them before sharing. Use the [offline replay tools](./recordings.md) to reproduce model-driven UI without spending credits.
