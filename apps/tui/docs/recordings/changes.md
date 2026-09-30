# Recordings: changes

Scripts only. The recorder executes these in the real TUI; smithers.sh tutorials show the GIFs.

```tui-script review-diff
Use "edit"
Type "Fix the addition function."
Press Enter
Wait for answer "Fixed math.js."
Expect file "math.js" contains "a + b"
Press Ctrl+S
Press j
Press l
Capture "Expand a recorded edit in Summary."
Press d
Capture "Toggle the selected turn's diff."
Press v
Wait for "a + b"
Capture "Switch between split and unified diffs."
```

```tui-script undo-edit
Use "edit"
Type "Fix the addition function."
Press Enter
Wait for answer "Fixed math.js."
Press Ctrl+S
Press u
Wait for "[x] math.js"
Capture "Every file the turn changed, checked."
Press Enter
Wait 400 ms
Expect file "math.js" contains "a - b"
Capture "The original file is restored and the undo is recorded."
```
