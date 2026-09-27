---
title: Smithers in your terminal
description: Make a change, inspect every step, and pick up where you left off.
order: 0
section: Start
---

Smithers is a coding agent that runs your requests as flows. Ask for a change, keep chatting while it works, and inspect the steps behind the result.

## Try it

Fix a small bug in a private browser workspace. Run the agent, inspect a checkpoint, then branch to try a different approach.

<playground></playground>

The sandbox has two files and no access to your computer. Open **Settings** to use an OpenAI-compatible provider. Without a key, requests use the site's sponsored OpenRouter service when configured.

## Make your first change

Start with a failing check. Give Smithers the command that reproduces it and the result you expect.

```tui-script fix-add
Type "Fix math.js so node check.mjs passes."
Press Enter
Wait for answer "Fixed"
Capture "The agent edits math.js and verifies the result."
```

This recording runs the real terminal app against a scratch repository. Model responses come from a recorded session; file changes and checks execute again at build time. Other guides use deterministic model fixtures to exercise each control.

## Keep the useful parts

Follow three examples in order:

1. [Fix a failing check](./guides/fix-a-bug.md). Give the agent a result it can verify.
2. [Inspect and branch](./guides/time-travel.md). Read the steps, compare the files, and try another path.
3. [Keep working](./guides/background-work.md). Delegate work without blocking chat.

[Run Smithers locally](./installation.md) when you are ready to use your own repository.

## Explore the terminal

| Goal                                              | Guide                                          |
| ------------------------------------------------- | ---------------------------------------------- |
| Write, steer, or queue a prompt                   | [Chat](./guides/chat.md)                       |
| Find a file, command, session, or worker          | [Search](./guides/search.md)                   |
| Run a command and choose its context              | [Shell](./guides/shell.md)                     |
| Delegate, stop, resume, and inspect a worker tree | [Background work](./guides/background-work.md) |
| Review an edit and undo its captured changes      | [Diffs and undo](./guides/review-changes.md)   |
| Save, resume, fork, and compact a conversation    | [Sessions](./guides/sessions.md)               |
| Select a model and reasoning effort               | [Models](./guides/models.md)                   |
| Approve or refuse consequential calls             | [Approvals](./guides/approvals.md)             |
| Choose visible lanes and a theme                  | [Views and filters](./guides/appearance.md)    |
| Read estimated time and tokens                    | [Estimates](./guides/estimates.md)             |

## Automate recurring work

[Run durable flows](./automation/flows.md), [define custom agents](./automation/agents.md), [publish views and cards](./automation/views.md), [contribute shortcuts](./automation/extensions.md), and [monitor changes](./automation/monitors.md).

The [command](./reference/commands.md), [keyboard](./reference/keys.md), [CLI](./reference/cli.md), and [configuration](./reference/configuration.md) references cover the complete terminal interface. Use [troubleshooting](./reference/troubleshooting.md) to recover a failure and [executable documentation](./reference/recordings.md) to reproduce a recording.
