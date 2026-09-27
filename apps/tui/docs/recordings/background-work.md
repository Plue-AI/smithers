# Recordings: background-work

Scripts only. The recorder executes these in the real TUI; smithers.sh tutorials show the GIFs.

```tui-script background-worker
Use "workers"
Type "Review the addition function in the background."
Press Enter
Wait for answer "Requested the review."
Capture "The request returns while the worker runs."
Type "/tabs"
Press Enter
Wait for "Review addition"
Capture "Open the worker's own status and transcript."
Wait for answer "Review complete"
Capture "Read the completed review."
```

```tui-script worker-controls
Use "workers"
Type "Review the addition function in the background."
Press Enter
Wait for answer "Requested the review."
Type "/tabs"
Press Enter
Press s
Type "Check negative inputs too."
Capture "Steer one worker from its composer."
Press Enter
Press Escape
Press x
Wait 400 ms
Capture "Stop the worker without leaving the session."
Press r
Wait for answer "Review complete"
Capture "Resume the saved task and inspect its result."
```

```tui-script worker-tree
Use "trees"
Type "Delegate a lead review and a child addition check."
Press Enter
Wait for answer "Requested the review tree."
Wait 500 ms
Type "/tabs"
Press Enter
Capture "Follow nested child reviews while chat remains available."
Wait for worker "lead" status "done"
Press Tab
Press Tab
Press Tab
Press Tab
Wait for "Tree: Lead review"
Capture "Inspect the worker tree after its children settle."
```
