---
title: "@smthrs/integrations"
description: "GitHub, Linear, Telegram, Slack, Google Calendar, Gmail, and X adapters for Smithers: verified ingress, typed provider clients, and durable actions a flow can call."
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/agent/integrations/docs/README.md"
---

Smithers is a durable control plane for long-running agents: work runs as a
flow whose every step is journaled, so a crash resumes where it stopped
instead of starting over. `@smthrs/integrations` connects a Smithers
application to GitHub, Linear, Telegram, and Slack, and carries tested
library code for Google Calendar, Gmail, and (read-only) X. Each provider gets
a typed client, a door that verifies or authenticates a delivery before
anything else runs, one normalized event shape, and durable actions a flow
calls to comment, file an issue, or send a message.

## What it solves

Connecting an automated system to a provider means writing the same delicate
code once per provider: constant-time signature verification over the exact
delivered bytes, rate-limit retries that know which failures are safe to
repeat, redelivery detection, and a write path that does not post the comment
twice when a process restarts halfway through. Each of those has a failure
mode you find in production: a forged webhook that starts a run, a duplicated
issue, a comment reposted on every retry.

This package writes them once and gives all three providers the same
vocabulary. A delivery that does not verify never reaches a decoder. A write
whose answer was lost reports `outcomeUnknown` instead of being repeated. A
provider redelivery is dropped on the idempotency key you derive with the
provider's own helper. Every failure carries a machine-readable `reason` you
can branch on.

What an event _means_ stays yours. Which flow a pull request starts, and
which run an issue comment signals, is application logic. The adapters stop
at verification, normalization, and transport.

## Availability

`@smthrs/integrations` is not on the npm registry yet. The
[quickstart](/quickstart/) installs it from source and builds a working
flow on top of it.

## Import paths

Import the whole surface or one provider at a time. The aggregate entry point
and the per-provider subpaths export the same names:

```ts
import { Core, GitHub, Gmail, GoogleCalendar, Linear, Slack, Telegram, X } from "@smthrs/integrations"
// or only what you use:
import * as Core from "@smthrs/integrations/core"
import * as GitHub from "@smthrs/integrations/github"
import * as Gmail from "@smthrs/integrations/gmail"
import * as GoogleCalendar from "@smthrs/integrations/googlecalendar"
import * as Linear from "@smthrs/integrations/linear"
import * as Slack from "@smthrs/integrations/slack"
import * as Telegram from "@smthrs/integrations/telegram"
import * as X from "@smthrs/integrations/x"
```

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

Replace `OWNER` and `REPO` with your repository's coordinates.

That call already retries a rate limit, keeps the token out of every header
but `Authorization`, and refuses to repeat the POST if the connection drops,
because GitHub may have created the comment and lost the answer. To make the
same comment a step a crash cannot duplicate, call
`GitHub.Actions.CommentOnIssue` inside a flow instead: the engine journals
the result, and a restart replays it rather than posting again. The
[quickstart](/quickstart/) builds that flow end to end.

The other direction is a webhook door. Build a channel and register it with
the control plane's channel coordinator:

```ts
import * as Channels from "@smthrs/control/Channels"
import { Core, Linear } from "@smthrs/integrations"
import { Effect, Redacted } from "effect"

const channel = Linear.Webhook.channel({
  credential: Redacted.make({ id: "linear-webhook", name: "linear-webhook" }),
  secret: Core.Channel.constantSecret(Redacted.make(webhookSecret)),
  route: Core.Channel.startFlow("triage")
})

const register = Effect.flatMap(Channels.Channels, (channels) => channels.register(channel))
```

Replace `webhookSecret` with the secret Linear signs deliveries with, read
from your environment or secret store. `Channels.ingest` then runs one fixed
order on every delivery: verify the raw bytes, decode, map, dispatch. The
[Linear guide](/guides/linear/) shows the HTTP handler that feeds it.
GitHub webhooks enter through the Smithers backend instead; this package has
no GitHub webhook channel.

## Where this sits

This package is the outward-facing half of the Smithers agent stack.
[`@smthrs/agent`](https://agent.smithers.sh/reference/api/) is the agent itself: a loop that reaches every
capability it has by calling a flow through a durable boundary.
`@smthrs/integrations` supplies the provider side of that picture, the door
an outside event arrives through and the journaled step that acts back on the
provider.

Neither package imports the other, and that is deliberate. An application
that only receives webhooks needs no agent, and an agent that never touches
GitHub needs no adapter. The two meet in the flow: a channel `route` starts a
flow or signals a waiting run, and an agent step calls
`GitHub.Actions.CommentOnIssue` the way it calls any other action.

Underneath both is the [control plane](https://control.smithers.sh/reference/api/), which owns runs,
credentials, and the channel registry. Above them is the
[`smthrs` command line](https://cli.smithers.sh/reference/api/), the executable that plans, approves, runs,
and inspects the flows these adapters feed and act through. Start there if
you have not run a Smithers flow before.

## What is in the box

Each provider ships the same four parts:

- **A client.** Authentication, rate limits, pagination, and credential
  hygiene against the provider's API. The clients are ordinary Effect
  services you can also call directly with `make`.
- **A channel.** A `@smthrs/control` `Channel` that verifies an inbound
  webhook's signature and decodes the delivery into one normalized event.
  Telegram, which has no webhook signature to verify, ships a `getUpdates`
  long-poll source instead.
- **Schemas.** The payload fields worth typing, with everything else passing
  through untouched, so a delivery is never rejected for carrying a field
  this package has not heard of.
- **One durable action.** The step a flow calls, journaled so a restart
  replays the recorded result instead of acting twice.

| Action                           | Tag                                    | Does                                                           |
| -------------------------------- | -------------------------------------- | -------------------------------------------------------------- |
| `GitHub.Actions.CommentOnIssue`  | `integrations/github/comment-on-issue` | Comments on an issue or pull request.                          |
| `GitHub.Actions.AddLabels`       | `integrations/github/add-labels`       | Adds the labels an issue lacks.                                |
| `GitHub.Actions.UpsertComment`   | `integrations/github/upsert-comment`   | Creates or edits one sticky comment per key.                   |
| `GitHub.Actions.CheckRun`        | `integrations/github/check-run`        | Creates or updates a check run by external id.                 |
| `GitHub.Actions.LinkPullRequest` | `integrations/github/link-pr`          | Adds `Closes #N` to a pull request's description.              |
| `Linear.Actions.CreateIssue`     | `integrations/linear/create-issue`     | Files an issue, resolving team, state, and label names to ids. |
| `Linear.Actions.UpdateIssue`     | `integrations/linear/update-issue`     | Sets an issue's fields, resolving names to ids.                |
| `Linear.Actions.CommentOnIssue`  | `integrations/linear/comment-on-issue` | Comments once per step, under a step-derived id.               |
| `Telegram.Actions.SendMessage`   | `integrations/telegram/send-message`   | Sends a message, chunked, with a plain-text fallback.          |
| `Slack.Actions.PostMessage`      | `integrations/slack/post-message`      | Posts to a channel or thread, optionally as a role persona.    |

Slack also ships `UpdateMessage` and `Reconcile`; Google Calendar and Gmail
ship their own actions, listed in the [API reference](/reference/api/).

These actions are not the closed set. They are declarations over the clients,
and an endpoint they do not cover is your own `Action.make` over the same
client. See [durable actions](/concepts/durable-actions/).

The shared, provider-agnostic pieces (signature verification, the channel
binding, the normalized event, cursor persistence, the error vocabulary, and
the OAuth helpers) live in the `Core` namespace.

## Credentials

Explicit configuration always wins. What it omits falls back to the
environment:

| Variable                                               | Used by                                      |
| ------------------------------------------------------ | -------------------------------------------- |
| `SMITHERS_GITHUB_TOKEN`, then `GITHUB_TOKEN`           | `GitHub.GitHubClient`                        |
| `SMITHERS_GITHUB_API_BASE_URL`                         | GitHub Enterprise or a fixture server        |
| `SMITHERS_LINEAR_API_KEY`                              | `Linear.LinearClient`                        |
| `SMITHERS_LINEAR_WEBHOOK_SECRET`                       | `Linear.Webhook`                             |
| `SMITHERS_LINEAR_API_BASE_URL`                         | A fixture server                             |
| `SMITHERS_TELEGRAM_BOT_TOKEN`                          | `Telegram.TelegramClient`, `Telegram.Source` |
| `SMITHERS_SLACK_BOT_TOKEN`                             | `Slack.SlackClient`, `Slack.Connections`     |
| `SMITHERS_SLACK_APP_TOKEN`                             | `Slack.SocketSource`                         |
| `SMITHERS_SLACK_SIGNING_SECRET`                        | `Slack.Webhook`                              |
| `SMITHERS_SLACK_TEAM_IDS`, `_USER_IDS`, `_CHANNEL_IDS` | `Slack.Config.policy`                        |
| `SMITHERS_GOOGLE_*`                                    | `GoogleCalendar.Config.resolve`              |

Every client, and the Telegram source, takes an `env` argument that replaces
the ambient environment rather than layering over it, so a caller that
supplies its own credentials cannot have an ambient `GITHUB_TOKEN` decide
which account a call runs as.

## Where to go next

- [Quickstart](/quickstart/): from install to a durable GitHub comment, in
  a flow, against the live API.
- Guides per adapter: [GitHub](/guides/github/), [Linear](/guides/linear/),
  [Telegram](/guides/telegram/), [Slack](/guides/slack/),
  [Google Calendar](/guides/google-calendar/), [Gmail](/guides/gmail/),
  [X](/guides/x/).
- Concepts: [how adapters sit on the control plane](/concepts/control-plane/),
  [events, signals, and cursors](/concepts/events-and-signals/), and
  [durable actions](/concepts/durable-actions/).
- [API reference](/reference/api/): every public export, with signatures and errors.
- [Testing](/testing/): how to test code that uses these adapters, with no
  mocking library and no live credentials.
- [Troubleshooting](/troubleshooting/): the failure modes the package
  raises, and what to do about each.
