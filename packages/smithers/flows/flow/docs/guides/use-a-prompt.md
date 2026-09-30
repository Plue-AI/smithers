---
title: "Prompt-backed flows"
description: "Declare a typed prompt with Flow.make and attach its host implementation to the ordinary action it lowers to."
---

Declare exactly one of `body` or `prompt` with the same tagged constructor:

```ts
import { Flow } from "@smthrs/flow"
import * as Schema from "effect/Schema"

export const Draft = Flow.make("draft", {
  description: "Drafts a response.",
  payload: { message: Schema.String },
  success: Schema.String,
  prompt: ({ message }) => `Respond to: ${message}`
})
```

`Draft` is an ordinary flow. Its body calls `Draft.action`, an ordinary action
named `draft/prompt`. Constructing the declaration and building its graph never
render the prompt or call a model. The host renders `Draft.prompt(payload)`
inside the implementation it attaches with `Draft.action.toLayer(...)`.

The prompt receives the decoded payload. Missing or incorrectly typed props
are TypeScript errors. A host may render an imported typed MDX component from
that callback; see [MDX prompts](/pkg/registry/guides/mdx-prompts).

`model` may name a seat or an ordered nonempty fallback list. When omitted,
the host supplies its resolved seat. `effort`, `flows`, `system`, and `chat`
retain host metadata. They do not start a model or widen authority. Declare
`capabilities` and `effects` for the same ceiling a body-backed flow uses.

Supply the model implementation's failure schema as `error`. For the existing
agent host, use `AgentAction.AgentFailure` from `@smthrs/agent/AgentAction`.
A prompt action defaults to the irreversible tier and has no content cache key.
Register `Interpreter.layer(Draft)` and the action implementation under the
host's ordinary runtime and `Action.layerImplementations`.
