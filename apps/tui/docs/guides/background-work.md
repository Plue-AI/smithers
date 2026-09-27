---
title: Delegate and recover
description: Keep chatting while workers handle bounded requests.
order: 5
section: Use the TUI
---

Ask for work with a clear result and a small file scope. The coordinator records the request and returns to chat; workers execute in separate tabs.

```text
Fix the failing search tests. Keep changes inside src/search.ts and its tests.
```

## Follow a worker

```tui-script background-worker
Use "workers"
Type "Review the addition function in the background."
Press Enter
Wait for answer "Requested the review."
Capture "The request returns while the worker runs."
Type "/tabs"
Press Enter
Wait for "Review addition"
Capture "Open the worker's own status and transcript."
Wait for answer "Review complete"
Capture "Read the completed review."
```

Use `/tabs`, **Ctrl+]**, or **Ctrl+K** with `tab:` to open a worker. **s** steers it from the composer; **Esc** returns. **c** opens its lane in chat. **x** stops it. Selecting a worker row does not pause its execution.

| State     | Meaning                                               |
| --------- | ----------------------------------------------------- |
| Requested | The request is saved; execution is not yet confirmed. |
| Queued    | Waiting for one of the worker pool's slots.           |
| Running   | Executing the request.                                |
| Waiting   | Waiting for child workers; its pool slot is released. |
| Parked    | Waiting for provider capacity or a reset time.        |
| Done      | Execution completed; inspect the result and checks.   |
| Failed    | A recorded failure needs review or retry.             |
| Cancelled | The worker was stopped.                               |

The pool defaults to six workers. `SMITHERS_TUI_WORKERS` changes the limit; additional requests queue FIFO with their captured chat context. Workers share the working directory. Give independent requests different files.

## Recover a worker

```tui-script worker-controls
Use "workers"
Type "Review the addition function in the background."
Press Enter
Wait for answer "Requested the review."
Type "/tabs"
Press Enter
Press s
Type "Check negative inputs too."
Capture "Steer one worker from its composer."
Press Enter
Press Escape
Press x
Wait 400 ms
Capture "Stop the worker without leaving the session."
Press r
Wait for answer "Review complete"
Capture "Resume the saved request and inspect its result."
```

**r** or `/retry id` resumes a failed, stopped, or parked worker with its prior steps and original model. `/stop id` stops a worker or flow run. Without an ID, these commands open the worker search. In a failed worker tab, **m** chooses a model and **w** waits for its reset.

A provider quota or rate limit parks the worker until reset/retry-after. Workers may try configured non-Cerebras fallback seats. Eight consecutive parks without an answer end in a visible usage-limit failure. **Ctrl+O** reveals the raw error.

Session reload reconstructs requests and transcripts and relaunches unfinished work. The progress toast lasts through request and execution, and settles only on the actual terminal result. Repeating a delegation ID does not create a second worker.

## Delegate a tree

```tui-script worker-tree
Use "trees"
Type "Delegate a lead review and a child addition check."
Press Enter
Wait for answer "Requested the review tree."
Wait 500 ms
Type "/tabs"
Press Enter
Capture "Follow nested child reviews while chat remains available."
Wait for worker "lead" status "done"
Press Tab
Press Tab
Press Tab
Press Tab
Wait for "Tree: Lead review"
Capture "Inspect the worker tree after its children settle."
```

Workers can delegate through depth three; depth four is refused with `AgentDepthExceeded`. `agent.wait({ids})` releases the waiting worker's seat, so a full pool can still finish its children. A `tree:<rootId>` tab appears when a worker gains children.

Chat receives all unsettled workers and up to five recent completed answers, each bounded to 1,500 characters. `/filter` hides or shows worker lanes. For named repository workers, see [custom agents](../automation/agents.md).
