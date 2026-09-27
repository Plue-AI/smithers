# Recordings: appearance

Scripts only. The recorder executes these in the real TUI; smithers.sh tutorials show the GIFs.

```tui-script transcript-filter
Use "basic"
Type "Explain math.js"
Press Enter
Wait for answer "Ready."
Type "/filter"
Press Enter
Capture "Choose which lanes and row kinds appear in chat."
Press Escape
Type "/grep Ready"
Press Enter
Capture "Keep only rows matching text."
Type "/grep"
Press Enter
Capture "Clear the text filter."
```

```tui-script themes
Use "basic"
Type "/theme"
Press Enter
Wait for "green"
Capture "Choose a terminal accent."
Press ArrowDown
Press ArrowDown
Press Enter
Capture "Apply the theme without leaving the session."
```
