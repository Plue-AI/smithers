---
title: Inspect and branch
description: See exactly what the agent knew at a checkpoint and try another approach.
order: 6
section: Use the TUI
---

A finished answer hides the decisions that produced it. The timeline lets you inspect those decisions with the state that existed at the time.

## Inspect the terminal

Press **Ctrl+T**. Use the arrows to move through events, or **[** and **]** to jump between milestones. **Home** and **End** jump to the first and last event. Press **Esc** to return to live work.

```tui-script timeline
Type "Fix math.js so node check.mjs passes."
Press Enter
Wait for answer "Fixed"
Press Ctrl+T
Press Home
Capture "The timeline at the start of the run."
Press End
Capture "The completed run, with its later results."
```

An earlier event shows only the recorded prefix. Later outcomes stay out of that view.

## Branch in the browser

Run the [playground](../README.md#try-it), then select a checkpoint. The transcript and files move together. **Branch** copies that checkpoint into a new workspace. Submit a different prompt to explore another approach; the original branch remains available.

Committed model responses and flow results replay without another provider call. Files and flow results commit together before the next step. Reload the page to restore the saved run. If a provider call was interrupted before its response committed, retrying that call can make a new, billable request.

This guarantee covers the playground's virtual files and recorded agent state. Model billing and external systems cannot be rewound. The sandbox exposes no shell, network flow, or access to local files.

## Fork a terminal conversation

Use `/fork` to select a previous message. Smithers copies the earlier conversation and puts the selected message back in the editor. The original session stays resumable.

A terminal conversation fork does not restore your working tree. To undo a captured file edit, select its row in **Summary**, press **u**, and confirm. Undo refuses changed files, unsupported diffs, and shell edits that may include another worker's work.

Next: [keep working](./background-work.md).
