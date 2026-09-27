# Recordings: search

Scripts only. The recorder executes these in the real TUI; smithers.sh tutorials show the GIFs.

```tui-script file-mention
Use "basic"
Type "Review @math"
Wait for "math.js"
Capture "Fuzzy-match a project file."
Press Tab
Capture "Insert the selected file reference."
```

```tui-script text-search
Use "basic"
Press Ctrl+K
Type "text:add"
Wait for "math.js:1"
Capture "Search file contents with text:."
Press Enter
Capture "Insert a path and line number into the prompt."
```

```tui-script commands-menu
Use "basic"
Type "/"
Capture "Browse slash commands."
Type "thinking"
Press Tab
Type "high"
Press Enter
Wait for "Thinking level: high"
Capture "Complete a command and its argument."
```
