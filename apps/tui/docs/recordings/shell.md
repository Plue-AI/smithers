# Recordings: shell

Scripts only. The recorder executes these in the real TUI; smithers.sh tutorials show the GIFs.

```tui-script shell-context
Use "basic"
Type "!node check.mjs"
Press Enter
Wait for "add is wrong"
Capture "Run a failing check and keep its output for the next turn."
Type "!!pwd"
Press Enter
Wait 500 ms
Capture "Run a local command without adding its output to context."
```

```tui-script cancel-shell
Use "basic"
Type "!sleep 30"
Press Enter
Wait 400 ms
Capture "A shell command is running."
Press Escape
Wait 400 ms
Capture "Cancel the command and return to chat."
```
