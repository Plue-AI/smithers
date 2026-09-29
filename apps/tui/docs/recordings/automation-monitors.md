# Recordings: automation-monitors

Scripts only. The recorder executes these in the real TUI; smithers.sh tutorials show the GIFs.

```tui-script monitor
Use "monitor"
Type "Monitor the addition check output."
Press Enter
Wait for answer "Monitor request settled."
Wait for monitor "checks" status "active"
Wait 1000 ms
Capture "Create a real monitor with local fixture responses at the model boundary."
Type "!printf '3 checks passed\\n' > check-status.txt"
Press Enter
Wait for "Addition checks passed."
Capture "A changed observation produces a persisted monitor update."
Type "Stop the checks monitor."
Press Enter
Wait for answer "Stopped the checks monitor."
Wait for monitor "checks" status "stopped"
Capture "Stop the monitor and retain its recorded updates."
```

```tui-script monitor-refusal
Use "monitor-refusal"
Type "Monitor the addition check output."
Press Enter
Wait for answer "Monitor request settled."
Wait for monitor "checks" status "active"
Type "!printf '3 checks passed\\n' > check-status.txt"
Press Enter
Wait for monitor "checks" status "failed"
Press Ctrl+O
Capture "Inspect a monitor creation refusal when judging is unavailable."
```
