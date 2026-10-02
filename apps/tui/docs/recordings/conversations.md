# Recordings: conversations

Scripts only. The recorder executes these in the real TUI; smithers.sh tutorials show the GIFs.

```tui-script session-details
Use "basic"
Type "Explain the addition function."
Press Enter
Wait for answer "Ready."
Type "/name Addition review"
Press Enter
Type "/conversation"
Press Enter
Wait for "exchanges"
Capture "Name the conversation and inspect its file, log, and token counts."
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
Wait for "New conversation started"
Type "/resume"
Press Enter
Wait for "Addition review"
Capture "Choose a named conversation from the resume picker."
Press Enter
Wait for answer "Ready."
Capture "Continue the original conversation."
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
