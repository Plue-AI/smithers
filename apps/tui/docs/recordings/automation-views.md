# Recordings: automation-views

Scripts only. The recorder executes these in the real TUI; smithers.sh tutorials show the GIFs.

```tui-script custom-view
Use "panels"
Type "Show the addition checks in a custom view."
Press Enter
Wait for answer "Published the checks view."
Press Ctrl+K
Type "Checks"
Press Enter
Wait for "Addition"
Press l
Capture "Expand the code behind a result."
Press j
Press l
Capture "Inspect a table in the same view."
Press j
Press l
Capture "Inspect a diff and its available row action."
Press a
Capture "Run the selected open action only after pressing a."
```

```tui-script live-card
Use "cards"
Type "Publish the addition checks as a card."
Press Enter
Wait for answer "Published the checks card."
Capture "Keep a live card, status item, and contributed key in chat."
Press Tab
Capture "Focus the newest card from an empty composer."
Press Enter
Wait for "Addition"
Capture "Open the card as a full view."
Press Escape
Press Alt+R
Capture "Open the same view with its contributed key."
```
