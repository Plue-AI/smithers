---
title: Write, steer, and queue
description: Keep a conversation moving while a turn works.
order: 2
section: Use the TUI
---

Send a prompt with **Enter**. While a turn runs, **Enter** steers that turn before its next cell; **Alt+Enter** queues a separate follow-up. Use **Alt+Up** to bring queued messages back into the editor.

## Compose a prompt

Use **Shift+Enter** or **Ctrl+J** for a newline. **Up/Down** browse your last 100 distinct prompts and restore your draft when you return to the newest entry. **Ctrl+C** clears the editor. **Ctrl+U** deletes to the start of the line; **Ctrl+W** deletes a word.

```tui-script composer
Use "basic"
Type "Explain math.js"
Press Ctrl+J
Type "Keep it brief."
Capture "Write a multiline prompt."
Press Enter
Wait for answer "Ready."
Press ArrowUp
Capture "Recover a previous prompt with Up."
Press Ctrl+C
```

**Ctrl+K** opens search; it replaces the usual delete-to-end-of-line binding. To edit a longer prompt, **Ctrl+G** opens `$VISUAL`, then `$EDITOR`, or `nano`. Save and close the editor to bring the text back.

```tui-script external-editor
Use "basic"
Type "Review the addition function."
Press Ctrl+G
Wait for "Review math.js and its checks."
Capture "Save the prompt in an external editor, then return to the composer."
```

## Queue and recover

```tui-script queue
Use "slow"
Type "Explain math.js"
Press Enter
Type "Then review the checks."
Press Alt+Enter
Wait for "Follow-up:"
Capture "Queue a follow-up while the first request runs."
Press Alt+ArrowUp
Capture "Return queued work to the editor before it starts."
Press Escape
Capture "Stop the current turn and keep the draft."
```

Queued prompts retain their order. Steering changes the current turn; a queued follow-up starts after it. **Esc** stops the current turn and returns unsent queued messages to the editor. It does not stop independent background workers; use their [worker controls](./background-work.md).

## Read and copy

**Ctrl+O** expands cell code, flow output, diffs, and the key list. **PageUp/PageDown** scroll a page; **Shift+Up/Shift+Down** scroll one line. Drag over text to copy the selection. `/copy` copies the most recent answer.

```tui-script copy-answer
Use "basic"
Type "Explain math.js"
Press Enter
Wait for answer "Ready."
Type "/copy"
Press Enter
Wait for "Copied the last answer"
Capture "Copy the last answer."
```

Clipboard support uses `pbcopy` on macOS, `clip` on Windows, or `wl-copy`, `xclip`, or `xsel` on Linux. A missing clipboard command produces a visible failure.
