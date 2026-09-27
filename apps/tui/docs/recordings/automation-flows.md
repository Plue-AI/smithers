# Recordings: automation-flows

Scripts only. The recorder executes these in the real TUI; smithers.sh tutorials show the GIFs.

```tui-script run-flow
Use "flows"
Type "/flows"
Press Enter
Wait for "echo"
Capture "Browse the repository's flows."
Press Escape
Type "/flow echo text=hello"
Press Enter
Wait for "echo · done"
Type "/smithers"
Press Enter
Capture "Inspect a real completed durable flow run."
```

```tui-script flow-form
Use "flows"
Type "/flow echo"
Press Enter
Wait for "Text"
Capture "Missing required input opens a schema-driven form."
Type "hello from the form"
Press Enter
Wait for "echo · done"
Press Ctrl+]
Press Ctrl+]
Wait for "hello from the form"
Capture "Submit the payload and wait for the actual run result."
```

```tui-script flow-approval
Use "flow-approval"
Type "/flow consequential"
Press Enter
Wait for "y allow"
Capture "Review the flow's declared write permission before it runs."
Press y
Wait for "proc:spawn:consequential"
Wait 500 ms
Capture "Review the process permission."
Press y
Wait for "net:post:https://example.test"
Wait 500 ms
Capture "Review the network permission."
Press y
Wait for "consequential · done"
Press Ctrl+]
Press Ctrl+]
Wait for "Authorized"
Capture "Inspect the completed run after approval."
```
