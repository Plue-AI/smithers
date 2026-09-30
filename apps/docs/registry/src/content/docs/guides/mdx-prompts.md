---
title: "MDX prompts"
description: "Import a prompt with concrete typed props and load it through the verified flow module boundary."
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/agent/registry/docs/guides/mdx-prompts.md"
---

A prompt is imported content. The executable declaration stays in `flow.ts`:

```ts
import { Flow } from "@smthrs/flow"
import * as Schema from "effect/Schema"
import Instructions from "./prompt.mdx"

export default Flow.make("draft", {
  description: "Drafts a response.",
  payload: { message: Schema.String },
  success: Schema.String,
  prompt: (payload) => Instructions(payload)
})
```

Write `prompt.mdx` with ordinary MDX expressions:

```mdx
# Respond

Write a response to **{props.message}**.
```

Enable `compilerOptions.allowArbitraryExtensions` in `tsconfig.json`.
Give that import its concrete props in `prompt.d.mdx.ts`:

```ts
import type { Component } from "@smthrs/registry/Prompt"

declare const Instructions: Component<{ readonly message: string }>
export default Instructions
```

Missing or incorrectly typed props fail TypeScript checking. Expressions and
imported components compile with the MDX compiler and render through a text JSX
runtime. Headings, lists, links, emphasis, and fenced code produce Markdown text.
Escape literal braces and angle brackets according to MDX syntax.

Discovery measures the prompt and its relative component imports without
running expressions. Execution loads the captured bytes. Editing either the
prompt or a component after discovery refuses execution until the registry
refreshes; the new closure changes the flow's execution digest.

A prompt-backed flow still needs its host action implementation. The create-app
host supplies it from the resolved `AGENT.ts`. Other module hosts export a named
`layer` implementing the declaration's ordinary `flow.action`, as described in
[Prompt-backed flows](https://flow.smithers.sh/guides/use-a-prompt/). MDX adds no execution loop.
