---
title: "GitHub"
description: "Configure the GitHub adapter: credentials, REST calls, and the comment action."
sidebar:
  order: 1
---

How to wire the GitHub adapter into a host application. Each section is a
recipe; the [API reference](../api.md) has the full signatures.

## Configure credentials

The client reads its token from explicit configuration first, then
`SMITHERS_GITHUB_TOKEN`, then `GITHUB_TOKEN`. The REST endpoint reads
`SMITHERS_GITHUB_API_BASE_URL` for GitHub Enterprise.

```bash
export SMITHERS_GITHUB_TOKEN=TOKEN
```

Replace `TOKEN` with a personal access or installation token.

Passing an `env` record as the second argument to `make`, `layer`, or
`resolve` replaces the ambient environment rather than layering over it, so
code that carries its own credentials cannot have an ambient `GITHUB_TOKEN`
decide which account a call runs as.

## Call the REST API

Build the client with `GitHub.GitHubClient.make` for direct use, or
`GitHub.GitHubClient.layer` when a flow composition needs it in context.

```ts
import { GitHub } from "@smthrs/integrations"
import { Effect, Schema } from "effect"

const client = GitHub.GitHubClient.make({})

const Viewer = Schema.Struct({ login: Schema.String })

const program = Effect.gen(function*() {
  const viewer = yield* client.request("GET", "/user", undefined, { schema: Viewer })
  return viewer.login
})
```

The response type comes from the schema. Without one, `request` returns the
parsed JSON as `unknown`, because the client checked nothing and so promises
nothing.

`request` retries a rate limit for every method, waiting the server's
`Retry-After` or `x-ratelimit-reset` capped at one minute. A 5xx or a dropped
connection is retried only for a read. On a write it reports
`outcomeUnknown: true` in the failure's `details`, because GitHub may have
applied the write and lost the answer. If you know your endpoint is
idempotent, opt into repeating writes per call:

```ts
yield * client.request("POST", path, body, { retryUnsafeWrites: true })
```

To walk a list endpoint, use `paginate`, which follows `Link: rel="next"`
inside a page budget and tells you when the budget ran out:

```ts
const page = yield * client.paginate("/repos/OWNER/REPO/issues", { perPage: 100, maxPages: 10 })
if (page.truncated) {
  // `page.items` is a prefix, not the whole resource. Narrow the query or
  // raise maxPages (at most 1000) before reconciling against it.
}
```

Replace `OWNER` and `REPO` with the repository coordinates.

## Build repository paths safely

Never interpolate an owner or repository string into a request path yourself.
`encodeURIComponent("..")` is `".."`, and the URL parser removes dot segments
afterwards, so an unvalidated string walks the token-bearing request to a
different GitHub endpoint on the same origin. `repositoryPath` validates each
segment against GitHub's naming rules and only then encodes it:

```ts
const repository = yield * GitHub.Repository.requireRepositoryPath(owner, repo)
yield * client.request("GET", `/repos/${repository}`)
```

The throwing form, `GitHub.Repository.repositoryPath`, raises an
`IntegrationError` with reason `invalid-config`; the `require*` forms put the
same failure in the Effect channel.

## Webhooks

GitHub webhooks enter through the Smithers backend (`POST /webhooks/github`),
which decides whether an event may start work. This package has no GitHub
webhook channel.

## Comment on an issue from a flow

`GitHub.Actions.CommentOnIssue` posts a comment as a durable step. The
payload's `owner`, `repo`, and `issueNumber` are validated by the payload
schema itself, so a payload built from a webhook body or a model's output
fails to decode rather than reaching the API with a hostile path.

```ts
import { GitHub } from "@smthrs/integrations"

const body = (input: typeof GitHub.Actions.CommentOnIssuePayload.Type) =>
  GitHub.Actions.CommentOnIssue.call({ ...input, body: "Triaged." })
```

The [quickstart](../quickstart.md) shows the complete wiring: the flow, the
implementation layer, and the client layer. The action fails with
`Core.ActionFailure.IntegrationFailure`; when `outcomeUnknown` is set, the
comment may already exist, so check the issue before posting again.

## Add another endpoint

The three actions are declarations over the client, not a closed set. Write
your own `Action.make` over `GitHubClient` for any other endpoint; the client
carries the rate-limit, pagination, and credential behavior, and the action
makes it journaled. [Durable actions](../concepts/durable-actions.md) shows
the shape.
