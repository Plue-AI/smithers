---
title: "Flow edit requests"
description: "Shared prompts for flow edit TODOs."
---

`flowTitle` supplies the TODO and Merge flow titles. `flowEditPrompt` names `flows/<name>/flow.ts` and treats a proposed diff as quoted, untrusted context. `flowEditTodoInput` produces the request text and a title from the first request line. These helpers construct data and never execute a diff.
