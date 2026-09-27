---
title: Use the browser sandbox
description: Try the production agent and branch from exact file checkpoints.
order: 18
section: Use the TUI
---

The [first-page playground](../README.md#try-it) runs the production agent in QuickJS with a small virtual project. It can list, read, and write sandbox files and run the addition checks. It has no shell, network flow, or access to files on your computer.

## Run and inspect

```browser-script browser-checkpoints
Click "Run"
Wait for "done"
Capture "The agent fixes the virtual file and records its calls."
Fill "Checkpoint" with "0"
Capture "Files and transcript return to the selected checkpoint together."
Click "Branch"
Capture "Create an independent branch while preserving the original result."
```

Move **Checkpoint** to inspect the transcript and files at that point. **Branch** starts a new attempt from that snapshot and retains the original branch. The branch selector returns to any existing branch's latest state.

Completed model responses are saved before their cells execute. Each completed flow result, file snapshot, and visible event commit atomically. Reload reconstructs the saved run; **Resume** continues an interrupted run without repeating already committed results. **Stop** interrupts the current execution. One tab may write the sandbox at a time.

## Configure a provider

```browser-script browser-settings
Click "Settings"
Fill "Base URL" with "https://provider.example/v1"
Fill "Model" with "provider/model"
Capture "Configure an OpenAI-compatible endpoint and model."
Click "Close settings"
```

**Settings** accepts a base URL, model, and API key. The provider must allow browser CORS. HTTPS and localhost HTTP endpoints are supported. Credentials stay in tab memory and are sent only to the chosen provider; re-enter them after a reload to resume that provider's run.

Leave the fields empty for the site's sponsored OpenRouter endpoint. It works only when the server has a configured key and remaining budget. The server chooses the lowest estimated cost from eligible current text models, favoring free entries, and applies per-visitor and daily limits. Unavailable access produces a visible refusal so you can retry or select your own provider.

## Scope of time travel

The sandbox retains exact virtual files and recorded agent state. It cannot undo model billing or external effects. A provider request interrupted before its response was committed may be billed again on explicit resume.

History is limited to 4 MB and files to 16 × 8 KB. Clearing/evicting browser site data removes the sandbox. The checks file is read-only. Native TUI conversation forks and file undo have different boundaries; see [inspect and branch](./time-travel.md).
