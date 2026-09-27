---
title: "Quickstart"
description: "From install to a first API call and a durable GitHub comment posted by a flow."
sidebar:
  order: 1
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/agent/integrations/docs/quickstart.md"
---

This tutorial takes you from an empty directory to two working results: an
authenticated call to the GitHub API through `GitHubClient`, and a comment on
an issue posted as a durable flow step, journaled so a restart replays the
recorded result instead of posting twice.

You need Node 26.4 or later and a GitHub token with issues write access to a
repository you own. A classic token with `repo` scope on a test repository
works.

## 1. Install

Not on npm yet; see [Installation](https://smithers.sh/docs/installation/#use-the-libraries).

## 2. Configure the credential

Export the token. `SMITHERS_GITHUB_TOKEN` is the variable the client reads
first; `GITHUB_TOKEN` is the fallback.

```bash
export SMITHERS_GITHUB_TOKEN=TOKEN
```

Replace `TOKEN` with your GitHub token.

## 3. Call the GitHub API

Build a client with `GitHub.GitHubClient.make` and ask for the authenticated
viewer. `make` is a plain constructor, so the first call needs no layers.

```ts
import { GitHub } from "@smthrs/integrations"
import { Effect, Schema } from "effect"

const client = GitHub.GitHubClient.make({})

const Viewer = Schema.Struct({ login: Schema.String })

const viewer = await Effect.runPromise(client.request("GET", "/user", undefined, { schema: Viewer }))
console.log(viewer.login)
```

Run it (Node 26.4 runs TypeScript directly):

```bash
node viewer.ts
```

The program prints your GitHub login. Behind that one call the client pinned
the request URL to the configured API origin, put the token in the
`Authorization` header and nowhere else, and stood ready to retry a rate
limit. A failure rejects with an `IntegrationError` whose `reason` is
machine-readable; [troubleshooting](/troubleshooting/) reads them.

## 4. Post a comment as a durable flow step

A client call is an Effect. An action is the same call made a step of a
durable flow: `CommentOnIssue.call(payload)` records a plan node, the engine
journals the result, and a restart replays the journal instead of posting a
second comment.

```ts
import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import { FlowEngine } from "@smthrs/engine"
import { Action, Flow, Interpreter } from "@smthrs/flow"
import { Core, GitHub } from "@smthrs/integrations"
import { Effect, Layer } from "effect"

const CommentFlow = Flow.make("comment-flow", {
  payload: GitHub.Actions.CommentOnIssuePayload,
  success: GitHub.Actions.Comment,
  error: Core.ActionFailure.IntegrationFailure,
  body: (input) => GitHub.Actions.CommentOnIssue.call(input)
})

const layer = Layer.mergeAll(GitHub.Actions.layer, Interpreter.layer(CommentFlow)).pipe(
  Layer.provideMerge(Action.layerImplementations),
  Layer.provideMerge(
    Layer.mergeAll(
      FlowEngine.layerMemory,
      GitHub.GitHubClient.layer({}),
      NodeCrypto.layer
    )
  )
)

const program = CommentFlow.execute(
  { owner: "OWNER", repo: "REPO", issueNumber: 1, body: "Hello from Smithers." },
  { executionId: "run-comment-flow" }
).pipe(Effect.provide(layer), Effect.scoped)

const comment = await Effect.runPromise(program)
console.log(comment.url)
```

Replace `OWNER` and `REPO` with the owner and name of your test repository.

Three things in the wiring are load-bearing:

- `GitHub.Actions.layer` implements the action over the `GitHubClient` in
  context. A composition that calls the action but forgets the layer fails to
  compile, because the plan node demands the requirement the layer provides.
- `GitHub.GitHubClient.layer({})` builds the client from the environment you
  exported in step 2. Passing an `env` record as the second argument instead
  replaces the ambient environment outright.
- `FlowEngine.layerMemory` runs the flow without durability, which is what a
  first run wants. Production flows use a durable engine; see
  [the engine API](https://engine.smithers.sh/reference/api/).

Run it:

```bash
node comment.ts
```

The program prints the new comment's API URL, and the comment is visible on
the issue. The action is `tier: "irreversible"`: the engine never retries it
on its own, and the client does not repeat a write whose answer was lost. It
reports `outcomeUnknown` instead. [Durable actions](/concepts/durable-actions/)
explains the contract.

## Next steps

- [GitHub guide](/guides/github/): receive webhooks, reconcile declared
  hooks, and paginate.
- [Linear guide](/guides/linear/) and [Telegram guide](/guides/telegram/):
  the other two adapters.
- [How adapters sit on the control plane](/concepts/control-plane/): the
  webhook half of the package this tutorial skipped.
