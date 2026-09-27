# Recordings: conversations

Scripts only. The recorder executes these in the real TUI; smithers.sh tutorials show the GIFs.

```tui-script session-details
Use "basic"
Type "Explain the addition function."
Press Enter
Wait for answer "Ready."
Type "/name Addition review"
Press Enter
Type "/session"
Press Enter
Wait for "exchanges"
Capture "Name the session and inspect its file, log, and token counts."
```

```tui-script resume-session
Use "basic"
Type "Explain the addition function."
Press Enter
Wait for answer "Ready."
Type "/name Addition review"
Press Enter
Restart
Wait for answer "Ready."
Capture "Restart the real TUI with -c and restore the saved conversation."
Type "/new"
Press Enter
Wait for "New session started"
Type "/resume"
Press Enter
Wait for "Addition review"
Capture "Choose a named session from the resume picker."
Press Enter
Wait for answer "Ready."
Capture "Continue the original conversation."
```

```tui-script fork-session
Use "basic"
Type "Explain the addition function."
Press Enter
Wait for answer "Ready."
Type "/fork"
Press Enter
Wait for "Explain the addition"
Capture "Choose the message where the conversation should branch."
Press Enter
Capture "Start a new session with the selected message in the editor."
```

```tui-script compact-context
Use "basic"
Type "Explain the addition function."
Press Enter
Wait for answer "Ready."
Type "/compact"
Press Enter
Capture "Compact context, or report that nothing needs dropping."
```
