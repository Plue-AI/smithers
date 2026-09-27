---
title: Fix a failing check
description: Turn a reproducible failure into a verified change.
order: 2
section: Start
---

A check gives the agent a clear stopping point. This example starts with an addition function that subtracts.

```js
export const add = (a, b) => a - b
```

The check calls `add(2, 3)` and expects `5`. Ask for the outcome:

```text
Fix math.js so node check.mjs passes.
```

```tui-script fix-add
Type "Fix math.js so node check.mjs passes."
Press Enter
Wait for answer "Fixed"
Capture "The agent edits math.js and verifies the result."
```

## Read the evidence

Open **Summary** with **Ctrl+S**. Expand the edit to see the diff. Expand the command to see the check's output.

The useful result is the changed file together with a passing check. If the check fails, give the agent the failure and keep the same session.

## Apply it to your project

Name the behavior, the relevant files, and the command that verifies it. Keep the first request narrow enough to review in one diff.

Next: [inspect and branch](./time-travel.md).
