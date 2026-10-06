---
title: "Flows reference"
summary: "Find, customize and run the factory's flows."
---

## Find a command

Type `/` in Chat to see commands and groups. Type more letters to filter them. `/help` opens the Commands card. `/flows` lists repository flows; `/flow todo` opens the TODO flow's steps and versions.

A button, slash command and agent action run the same typed flow. A flow called without required inputs opens a form for the missing fields.

## Change a flow

The overridable flows are `todo`, `learning`, `review` and repository flows. Built-in defaults need no repository commit. System flows, including stack operations, merge, members, settings, secrets, setup and sync, cannot be overridden.

Use `/flow.edit todo` with your requested change, or ask the app agent to propose it. The change becomes an ordinary TODO. Review its evidence and merge it as you would any other change.

A file flow lives at `flows/<name>/flow.ts`. Its default export uses the path's name as the first argument to `Flow.make` from `@smthrs/flow`:

```ts
import { Flow } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import { Schema } from "effect"

export default Flow.make("greet", {
  description: "Return a greeting",
  capabilities: [],
  effects: [],
  payload: Schema.Struct({ name: Schema.String }),
  success: Schema.String,
  body: Node.capture({}, ({ name }) => Node.succeed(`Hello, ${name}`))
})
```

Use `/flow.source todo` to open the source through its proposed TODO. The name, input, success and body belong to one flow declaration.

## Versions and pinning

| Version | Meaning |
| --- | --- |
| Proposed | An open TODO changes the flow. |
| Merged · syncing | The change is on `main`; the install is loading and checking it. |
| Active | The newest successfully loaded version. New attempts use it. |
| Merged · not active | Loading failed. Read the error and propose a fix; the previous Active version stays in use. |

An attempt pins the flow's source commit and digest when it enters Starting. The digest includes imported repository modules and the lockfile. Edits on its branch do not change the running version. Retry and Resume keep that pin. Retry with the current flow starts a new attempt using Active and retains the TODO's earlier evidence.

## Configuration

The install stores detected check commands, default wiki pages and model settings. Default flows work without `.smithers/` files. Repository configuration in `.smithers/*` on active `main` overrides install values field by field. Merge configuration changes before starting work that should use them.

## Learning proposals

After a merge, learning can propose an improvement with evidence from prior TODOs. Turn the proposal into a TODO, review and merge it. It applies after the new version becomes Active; learning cannot change the running factory directly.

## Run on a scratch branch

On a scratch branch, open the Flow card and choose **Plan** to inspect its working-copy version without running steps, or **Run** with a test input. The run is labeled draft version. It is separate from a TODO attempt. A draft run of `todo` stops before proposing onto the stack and writes nothing to GitHub.

See [Quickstart](quickstart.md#first-todo-to-merged) for your first change.
