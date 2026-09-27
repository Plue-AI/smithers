---
title: Read progress estimates
description: Use observed history to judge how long a request may take.
order: 12
section: Use the TUI
---

Every chat turn, worker, and flow run gets a time/token estimate when requested. A running item shows its remaining estimate, such as `~7m·250k`, or `late` after it passes the estimate. These are forecasts, not completion receipts.

```tui-script estimates
Use "estimates"
Type "What are the estimates for current work?"
Press Enter
Wait for answer "Estimates use the recorded history"
Press Ctrl+O
Capture "Inspect the ETA query and its recorded result."
```

The coordinator can call `tab.eta({})` for active workers and flow runs, including queued requests. Chat turns and flows use their own past runs. Delegated requests can ask Luna with similar past requests and prior estimation errors; without a model they use a median estimate.

Settled work writes observations and scores that calibrate later predictions. A model failure is logged and produces one toast. The evidence lives at `<session directory>/<cwd slug>/evals/estimates.jsonl`.

There may be little history for a new project. Review the actual worker status, checks, and answer before treating work as finished.
