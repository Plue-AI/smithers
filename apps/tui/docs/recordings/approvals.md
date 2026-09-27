# Recordings: approvals

Scripts only. The recorder executes these in the real TUI; smithers.sh tutorials show the GIFs.

```tui-script approve-edit
Use "approval"
Type "Fix the addition function."
Press Enter
Wait for "y allow"
Wait 500 ms
Capture "The edit waits for approval."
Expect file "math.js" contains "a - b"
Press y
Wait 700 ms
Press y
Wait for answer "Edit request settled."
Expect file "math.js" contains "a + b"
Capture "Allow the call once and inspect its result."
```

```tui-script deny-edit
Use "approval"
Type "Fix the addition function."
Press Enter
Wait for "y allow"
Wait 500 ms
Press n
Wait 500 ms
Press Escape
Expect file "math.js" contains "a - b"
Press Ctrl+O
Capture "A denied call leaves the file unchanged."
```
