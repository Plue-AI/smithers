# @smthrs/integrations

Release candidate scope, host requirements and compatibility review are defined in the [library support policy](https://github.com/smithersai/smithers/blob/main/RELEASE_SUPPORT.md).

**Documentation:** https://integrations.smithers.sh

GitHub, Linear, Telegram, Slack, Google Calendar, Gmail, and X adapters over
the Smithers control plane.

Smithers is a durable control plane for long-running agents: work runs as a
flow whose every step is journaled, so a crash resumes where it stopped
instead of starting over. This package is the outward-facing half of that.
Each provider gets a typed client, one durable action a flow calls to
comment, file an issue, or send a message, and, where the provider signs its
deliveries, a webhook door that verifies the signature before anything else
runs. GitHub webhooks enter through the Smithers backend instead.

What an event _means_ stays yours. Which flow a pull request starts, and which
run an issue comment signals, is application logic. The adapters stop at
verification, normalization, and transport.

## Install

`@smthrs/integrations` is not on the npm registry yet. Until it is, build it
from source and link it into your project; the
[quickstart](https://integrations.smithers.sh/quickstart/) walks through that
and the rest of the setup.

Import the whole surface or one provider at a time. The aggregate entry point
and the per-provider subpaths export the same names:

```ts
import { Core, GitHub, Gmail, GoogleCalendar, Linear, Slack, Telegram, X } from "@smthrs/integrations"
// or only what you use:
import * as GitHub from "@smthrs/integrations/github"
import * as Slack from "@smthrs/integrations/slack"
```

Slack is the provider a local Smithers host talks to its owner through:
Socket Mode intake that admits the owner's direct messages, threaded replies
under a role's name and icon, and Block Kit approval buttons. Google Calendar
and Gmail are tested library code with no host wiring yet, and X is
read-only.

The export map is the allowlist. A source module it does not name carries
no promise, and `./internal/*` stays null-mapped.

## The shortest real example

Comment on a GitHub issue. `make` is a plain constructor, so this needs no
layers, and the client reads its token from `SMITHERS_GITHUB_TOKEN` or
`GITHUB_TOKEN`:

```ts
import { GitHub } from "@smthrs/integrations"
import { Effect } from "effect"

const client = GitHub.GitHubClient.make({})

await Effect.runPromise(
  client.request("POST", "/repos/OWNER/REPO/issues/1/comments", { body: "Triaged." })
)
```

Replace `OWNER` and `REPO` with your repository's coordinates. That call
already retries a rate limit, keeps the token out of every header but
`Authorization`, and refuses to repeat the POST if the connection drops,
because GitHub may have created the comment and lost the answer. To make the
same comment a step a crash cannot duplicate, call
`GitHub.Actions.CommentOnIssue` inside a flow instead: the engine journals the
result, and a restart replays it rather than posting again.

## Webhook ingress

A webhook door is library code, not a server setting. A provider builds a
`@smthrs/control` `Channel`, the application registers it with `Channels`, and
`Channels.ingest` runs verify, decode, map, dispatch in that fixed order.

```ts
import * as Channels from "@smthrs/control/Channels"
import { Core, Linear } from "@smthrs/integrations"
import { Effect, Redacted } from "effect"

const webhookSecret = process.env.SMITHERS_LINEAR_WEBHOOK_SECRET?.trim()
if (!webhookSecret) throw new Error("SMITHERS_LINEAR_WEBHOOK_SECRET is required")

const channel = Linear.Webhook.channel({
  credential: Redacted.make({ id: "linear-webhook", name: "linear-webhook" }),
  secret: Core.Channel.constantSecret(Redacted.make(webhookSecret)),
  route: Core.Channel.startFlow("triage")
})

const register = Effect.flatMap(Channels.Channels, (channels) => channels.register(channel))
```

`Channels.ingest` drops a replayed `idempotencyKey`, which is what makes a
provider redelivery safe to accept. That key is yours to put on the
`RawInbound`: `Linear.Webhook.idempotencyKey` and
`Telegram.Source.idempotencyKey` derive it from the provider's own delivery
identity. An ingress that leaves the field unset has no redelivery protection.

The [Linear receiver example](https://integrations.smithers.sh/guides/linear/#receive-webhooks)
enforces a 1 MiB body limit while streaming, before calling `Channels.ingest`.

GitHub webhooks enter through the Smithers backend (`POST /webhooks/github`),
which decides whether an event may start work; this package has no GitHub
webhook channel.

Telegram, which has no webhook signature to verify, ships a `getUpdates`
long-poll source instead.

## Actions

Durable actions over the client of the same provider:

| Action                               | Tag                                        | Does                                                           |
| ------------------------------------ | ------------------------------------------ | -------------------------------------------------------------- |
| `GitHub.Actions.CommentOnIssue`      | `integrations/github/comment-on-issue`     | Comments on an issue or pull request.                          |
| `GitHub.Actions.AddLabels`           | `integrations/github/add-labels`           | Adds the labels an issue lacks.                                |
| `GitHub.Actions.UpsertComment`       | `integrations/github/upsert-comment`       | Creates or edits one sticky comment per key.                   |
| `GitHub.Actions.CheckRun`            | `integrations/github/check-run`            | Creates or updates a check run by external id.                 |
| `GitHub.Actions.LinkPullRequest`     | `integrations/github/link-pr`              | Adds `Closes #N` to a pull request's description.              |
| `Linear.Actions.CreateIssue`         | `integrations/linear/create-issue`         | Files an issue, resolving team, state, and label names to ids. |
| `Linear.Actions.UpdateIssue`         | `integrations/linear/update-issue`         | Sets an issue's fields, resolving names to ids.                |
| `Linear.Actions.CommentOnIssue`      | `integrations/linear/comment-on-issue`     | Comments once per step, under a step-derived id.               |
| `Telegram.Actions.SendMessage`       | `integrations/telegram/send-message`       | Sends a message, chunked, with a plain-text fallback.          |
| `Slack.Actions.PostMessage`          | `integrations/slack/post-message`          | Posts to a channel or thread, optionally as a role persona.    |
| `Slack.Actions.UpdateMessage`        | `integrations/slack/update-message`        | Replaces a message's text and blocks.                          |
| `Slack.Actions.Reconcile`            | `integrations/slack/reconcile-post`        | Finds a post by its key after an unknown outcome.              |
| `GoogleCalendar.Actions.UpsertEvent` | `integrations/googlecalendar/upsert-event` | Creates or confirms an event under a deterministic id.         |
| `Gmail.Actions.SendMessage`          | `integrations/gmail/send-message`          | Sends a composed message stamped with a reconcile key.         |

The Calendar and Gmail modules carry more (patch, cancel, free/busy, drafts,
find-by-key); the [API reference](https://integrations.smithers.sh/reference/api/)
lists them.

The GitHub, Linear, Telegram, Slack, and Gmail writes are `tier: "irreversible"`, because the remote side has acted by the
time the call returns. Neither the engine nor the client underneath repeats
one: a rate limit is retried for every method, since a refused request was not
performed, but a 5xx or a dropped connection on a write reports
`outcomeUnknown` instead of acting twice.

The GitHub write-back actions (`AddLabels`, `UpsertComment`, `CheckRun`,
`LinkPullRequest`) and Linear's `UpdateIssue` and `CommentOnIssue` read before
they write, so they declare an `idempotencyKey` and a retry policy. The engine
repeats one after a lost answer or a crash, and the repeat finds the earlier
attempt's label, comment, check run, reference or comment id instead of
writing it again.

`SendMessage` is the one that is not atomic: text over 4096 characters becomes
several `sendMessage` calls inside the step, and a failure partway through
leaves the earlier chunks in the chat and names them in the failure.

`.call(payload)` records a plan node; `Actions.layer` provides the
implementation, and needs the provider's client in context. The error type is
`Core.ActionFailure.IntegrationFailure`, the schema form of
`IntegrationError`, because a class cannot cross the journal.

Three actions is not the closed set. Writing another `Action.make` over the
same client is the intended way to reach an endpoint these three do not cover.

## Credentials

| Variable                                               | Used by                                      |
| ------------------------------------------------------ | -------------------------------------------- |
| `SMITHERS_GITHUB_TOKEN`, then `GITHUB_TOKEN`           | `GitHub.GitHubClient`                        |
| `SMITHERS_GITHUB_API_BASE_URL`                         | GitHub Enterprise or a fixture server        |
| `SMITHERS_LINEAR_API_KEY`                              | `Linear.LinearClient`                        |
| `SMITHERS_LINEAR_WEBHOOK_SECRET`                       | `Linear.Config.resolve`                      |
| `SMITHERS_LINEAR_API_BASE_URL`                         | A fixture server                             |
| `SMITHERS_TELEGRAM_BOT_TOKEN`                          | `Telegram.TelegramClient`, `Telegram.Source` |
| `SMITHERS_SLACK_BOT_TOKEN`                             | `Slack.SlackClient`, `Slack.Connections`     |
| `SMITHERS_SLACK_APP_TOKEN`                             | `Slack.SocketSource`                         |
| `SMITHERS_SLACK_SIGNING_SECRET`                        | `Slack.Config.resolve`                       |
| `SMITHERS_SLACK_TEAM_IDS`, `_USER_IDS`, `_CHANNEL_IDS` | `Slack.Config.policy`                        |
| `SMITHERS_GOOGLE_*`                                    | `GoogleCalendar.Config.resolve`              |

`Linear.Config.resolve` reads `SMITHERS_LINEAR_WEBHOOK_SECRET`. Webhook channels require an explicit
secret resolver. The host must pass the resolved non-empty secret through
`Core.Channel.constantSecret`, or use `Core.Channel.credentialSecret` with
its credential store. The example above reads the Linear variable directly.

Explicit configuration always wins. Every client, and `Telegram.Source`, takes
an `env` argument that _replaces_ the ambient environment rather than layering
over it, so a caller supplying its own credentials cannot have an ambient
`GITHUB_TOKEN` decide which account a call runs as.

## Tests

`pnpm --filter @smthrs/integrations test` runs the whole suite. The client and
webhook suites drive a real `node:http` fixture server over a real socket.

Three read-only suites talk to live APIs and skip when their credential is
absent:

```sh
GITHUB_TOKEN=… pnpm --filter @smthrs/integrations exec vitest run test/GitHubLive.test.ts --coverage.enabled=false
LINEAR_API_KEY=… pnpm --filter @smthrs/integrations exec vitest run test/LinearLive.test.ts --coverage.enabled=false
TELEGRAM_BOT_TOKEN=… pnpm --filter @smthrs/integrations exec vitest run test/TelegramLive.test.ts --coverage.enabled=false
```

Coverage is disabled for a single-file invocation because the package's
thresholds apply to the complete source tree; the full suite remains the
coverage gate.

## Documentation

https://integrations.smithers.sh carries the quickstart, a guide per adapter,
the concepts behind webhook ingress and durable actions, the full API
reference, a testing guide, and a troubleshooting page keyed by failure
reason.
