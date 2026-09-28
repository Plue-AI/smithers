# Recordings: chat

Scripts only. The recorder executes these in the real TUI; smithers.sh tutorials show the GIFs.

```tui-script composer
Use "basic"
Type "Explain math.js"
Press Ctrl+J
Type "Keep it brief."
Capture "Write a multiline message."
Press Enter
Wait for answer "Ready."
Press ArrowUp
Capture "Recover a previous prompt with Up."
Press Ctrl+C
```

```tui-script external-editor
Use "basic"
Type "Review the addition function."
Press Ctrl+G
Wait for "Review math.js and its checks."
Capture "Save the prompt in an external editor, then return to the composer."
```

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
