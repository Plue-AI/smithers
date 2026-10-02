# @smthrs/integrations

GitHub adapters over the Smithers control plane. Shared channels, cursors,
source stores, and durable delivery receipts remain available for host integrations.

Release scope and compatibility are defined in the [library support policy](https://github.com/smithersai/smithers/blob/main/RELEASE_SUPPORT.md).

## GitHub

```ts
import { Core, GitHub } from "@smthrs/integrations"
import { Effect } from "effect"

const client = GitHub.GitHubClient.make({})
await Effect.runPromise(
  client.request("POST", "/repos/OWNER/REPO/issues/1/comments", { body: "Triaged." })
)
```

The client reads `SMITHERS_GITHUB_TOKEN`, then `GITHUB_TOKEN`. Explicit
configuration wins; a supplied environment replaces the ambient environment.
`SMITHERS_GITHUB_API_BASE_URL` selects GitHub Enterprise or a fixture server.

Use `GitHub.Actions.CommentOnIssue` inside a flow to journal its result.
`AddLabels`, `UpsertComment`, `CheckRun`, and `LinkPullRequest` provide keyed
write-back actions. Rate-limit refusals may retry; ambiguous writes report
`outcomeUnknown` and are not blindly repeated. GitHub webhooks enter through
the backend at `POST /webhooks/github`.

## Shared webhook ingress

`Core.Channel.make` binds verify, decode, map, and dispatch in that order.
Verification reads the exact delivered bytes. The receiver bounds body size
before `Channels.ingest`, and gives every delivery an `idempotencyKey` to
prevent duplicate work. See [the receiver guide](docs/guides/webhook-ingress.md).

## Tests

```sh
pnpm --filter @smthrs/integrations test
GITHUB_TOKEN=… pnpm --filter @smthrs/integrations exec vitest run test/GitHubLive.test.ts --coverage.enabled=false
```

The normal suite uses local HTTP fixtures and durable SQLite engines. The
live suite requires an explicit test repository and credentials.

## Documentation

[Quickstart](docs/quickstart.md) · [GitHub](docs/guides/github.md) ·
[API](docs/api.md) · [Durable actions](docs/concepts/durable-actions.md)
