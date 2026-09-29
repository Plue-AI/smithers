---
title: "Workspace cleanup"
description: "Recover Harbor workspaces using persisted creation receipts."
---

## Ownership receipts

The adapter records each successful create response's workspace ID, repository,
and session in `PLUE_WORKSPACE_LEDGER` (default
`~/.local/state/smithers/harbor-workspaces.json`) before waiting for boot.
Agent and verifier environments use the same locked, atomically replaced ledger.
Keep it on durable host storage and use the same path when running cleanup.
Never expose this host file to the evaluated agent.

After Harbor stops, `python3 evals/harbor/requeue.py <job-dir>` deletes only recorded IDs for infrastructure attempts, then archives their
results. A cleanup failure leaves the attempt in place; retry the same command.
`python3 evals/harbor/requeue.py --reap-dead` deletes recorded IDs reported as
failed or suspended in `PLUE_REPO`. Workspace names never authorize deletion.
A failed delete retains its receipt for retry; a successful delete removes it.

A boot failure or cancellation after the create receipt remains recoverable.
If the server creates a workspace but the CLI never returns its ID, cleanup
cannot establish ownership. Failed create calls record the session with an
unknown workspace ID in `PLUE_LEAK_LOG`. Inspect that request manually; do not recover
by matching names. Older runs without receipts are also excluded from automatic
cleanup. These checks establish selection and CLI dispatch, not a hosted cleanup
or deployment result.
