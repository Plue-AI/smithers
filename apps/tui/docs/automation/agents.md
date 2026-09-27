---
title: Create custom agents
description: Give recurring work a prompt, model, and capability envelope.
order: 14
section: Automate
---

A custom agent is a Markdown flow at `flows/<name>/flow.mdx` or `flows/<name>/SKILL.md`. Its body is the worker's instructions. Its frontmatter controls how it runs.

```yaml
---
description: Review the addition function without editing it.
model: sol
effort: high
capabilities: ["fs:read:**"]
flows: [read, glob, grep]
disable-model-invocation: false
---
Read math.js and its checks. Report correctness problems with file references.
```

## Start a named agent

```tui-script custom-agent
Use "agents"
Type "/agent"
Press Enter
Wait for "review"
Capture "Choose a repository-defined agent."
Press Enter
Type "Review the addition function."
Press Enter
Wait for answer "Review complete"
Type "/tabs"
Press Enter
Capture "Inspect its worker transcript and result."
```

`/agent` opens the picker. `/agent review` prepares the composer; `/agent review Review math.js` requests a worker directly. The request persists before the body is read, so a slow load does not block chat.

The model is chosen in order: explicit request, file `model:`, then worker default. Aliases include `sol`, `astra`, `luna`, `opus`, `fable`, and `qwen`; a `provider:modelId` is also accepted. `effort` uses the runtime's reasoning schema. Use `model: [sol, opus]` for an ordered primary and fallback list. An explicit request model overrides that list.

`capabilities` is the worker's envelope; omit it for the host default. `flows` narrows its standard filesystem/shell flows. `disable-model-invocation: true` permits a person to start the agent while refusing coordinator requests.

Retry reads the file again, keeps the agent/model identity, and records the definition digest. The coordinator sees up to 20 model-invocable agents and can select one through `agent.delegate({id,title,prompt,agent})`.

## Read a refusal

| Code             | Cause                                                     |
| ---------------- | --------------------------------------------------------- |
| `unknown_agent`  | No discovered flow has that name.                         |
| `not_an_agent`   | It is a TypeScript flow; use `/flow`.                     |
| `not_invocable`  | A model tried to start a person-only agent.               |
| `unreadable`     | The prompt body could not be read; retry after fixing it. |
| `unknown_seat`   | `model:` does not identify a known provider or alias.     |
| `unknown_effort` | `effort:` is outside the supported schema.                |

The source checkout includes `apps/tui/examples/custom-agent` as a starting project.
