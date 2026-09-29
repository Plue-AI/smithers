---
title: "Durable actions"
description: "What makes a client call a journaled flow step: plan nodes, implementation layers, the irreversible tier, and the IntegrationFailure schema."
sidebar:
  order: 3
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/agent/integrations/docs/concepts/durable-actions.md"
---

A client is an ordinary Effect service. An action is what makes one of its
calls a step of a durable flow: a plan can name it, the journal can record
its result, and a restart replays the recorded result instead of posting a
second comment. For the underlying vocabulary of flows, actions, and plans,
see [flows, actions, and plans](https://smithers.sh/docs/concepts/flows-actions-plans/) and
[the flow API](https://flow.smithers.sh/reference/api/).

## Declaration, call, layer

Each provider declares its actions with `Action.make`: its tag, its payload
schema, its success schema, and `Core.ActionFailure.IntegrationFailure` as
its error schema.

| Action                           | Tag                                    |
| -------------------------------- | -------------------------------------- |
| `GitHub.Actions.CommentOnIssue`  | `integrations/github/comment-on-issue` |
| `GitHub.Actions.AddLabels`       | `integrations/github/add-labels`       |
| `GitHub.Actions.UpsertComment`   | `integrations/github/upsert-comment`   |
| `GitHub.Actions.CheckRun`        | `integrations/github/check-run`        |
| `GitHub.Actions.LinkPullRequest` | `integrations/github/link-pr`          |
| `Linear.Actions.CreateIssue`     | `integrations/linear/create-issue`     |
| `Linear.Actions.UpdateIssue`     | `integrations/linear/update-issue`     |
| `Linear.Actions.CommentOnIssue`  | `integrations/linear/comment-on-issue` |
| `Telegram.Actions.SendMessage`   | `integrations/telegram/send-message`   |

A flow body calls `CommentOnIssue.call(payload)`, which records a plan node
and runs nothing. The node demands a requirement that only the matching
implementation layer answers, so a composition that forgot the layer fails to
compile rather than at run time. `GitHub.Actions.layer`,
`Linear.Actions.layer`, and `Telegram.Actions.layer` implement the action
over the provider's client in context; the client is supplied separately,
through its own `layer`.

## The irreversible tier

Every action is `tier: "irreversible"`. The remote side has acted by
the time the call returns: the comment is visible, the issue notifies its
team, the message may already have been read. Deleting the evidence
afterwards is a different call with a different outcome, so the engine never
retries an unkeyed one on its own.

Neither does the client underneath, and the line it draws is worth knowing:

- A rate limit is retried for every method. A refused request was not
  performed, so repeating it is safe.
- A 5xx or a dropped connection on a write (a POST, PATCH, PUT, DELETE, or a
  GraphQL mutation) is not repeated. The provider may have committed it and
  lost the answer, so the failure reports `outcomeUnknown` rather than
  posting the comment twice. A caller that knows its endpoint is idempotent
  opts in with `retryUnsafeWrites` on `GitHubClient.request`.

## Keyed write-back

The GitHub write-back actions and Linear's `UpdateIssue` and `CommentOnIssue`
read before they write, which makes a repeat safe. They declare an
`idempotencyKey` and a retry policy, so the engine repeats one after a lost
answer or a process that died mid-step:

- `AddLabels` adds only the labels the issue lacks.
- `UpsertComment` finds its comment by a hidden `<!-- smithers:key=... -->`
  first line and edits it; a flow passes its run id to keep one progress
  comment per run.
- `CheckRun` finds its run by `external_id` and updates it. Writing check
  runs needs a GitHub App installation token.
- `LinkPullRequest` adds `Closes #N` to the pull request's description unless
  it already closes the issue.
- `UpdateIssue` sets fields, so a repeat leaves the same issue.
- `CommentOnIssue` posts under a UUID derived from the step's key and looks
  for that comment first.

GitHub does not enforce the comment marker or `external_id` as unique, so a
write still in flight when the repeat reads can land after it and leave two.
The retry backoff narrows that window; it does not close it.

`Telegram.Actions.SendMessage` is the one action that is not atomic. Text
over Telegram's 4096-character limit becomes several `sendMessage` calls
inside the step, and a failure partway through leaves the earlier chunks
visible in the chat. The failure names their ids, so an operator deciding
whether to resend can see what the reader already has.

## The journaled failure

`IntegrationError` is a class, and a class cannot cross the journal. A
durable action has to write its failure down and read it back after a
restart, so the action boundary uses a schema instead:
`Core.ActionFailure.IntegrationFailure`. Its fields are the ones an operator
reads after a restart:

| Field                 | Meaning                                                                     |
| --------------------- | --------------------------------------------------------------------------- |
| `reason`              | The machine-readable classification, from the `IntegrationError` list.      |
| `message`             | Provider text already safe to persist, capped at 512 characters.            |
| `retryable`           | Whether another attempt could clear it.                                     |
| `outcomeUnknown`      | The write may already have been applied. Absent when it definitely was not. |
| `deliveredMessageIds` | What a partially completed Telegram send already put in the chat.           |

`outcomeUnknown` is the difference between "this did not happen" and "nobody
knows", and an operator deciding whether to run the step again needs it, so
it crosses the journal rather than living only on the client error.

The conversion into the schema is total. `fromIntegrationError` reports any
failure that is not a well-formed `IntegrationError` (a forged name, a reason
this build cannot encode, a value that cannot even be stringified) as a
non-retryable `delivery-failed` rather than throwing inside
`Effect.mapError`, where a throw would become a defect. The persisted text is
the error's `summary` rather than its `message`, so one provider's failures
do not carry a documentation URL the others' do not. `toIntegrationError`
converts back to the class, for a caller that wants `isRetryable` or the
control-plane mappings.

Telegram is the exception in the middle. The Bot API client fails with its
own `TelegramApiError`, which carries the API's `error_code` while the
client's retry schedule is still operating. `Telegram.TelegramClient.toIntegrationError`
maps it onto the shared vocabulary at the action boundary: an exhausted 429
journals `retryable: true`, a chat that does not exist journals
`decode-failed`, and a blocked bot journals `permission-denied`. The durable
action applies that mapping, so every journaled failure keeps the package's
one promise: a machine-readable reason.

## Write your own action

An application that needs an endpoint these three do not cover writes its own
`Action.make` over the same client. That is the intended extension point, not
a gap: the client is the reusable part, and the action is a thin declaration
plus a `toLayer` implementation. The [API reference](/reference/api/) lists the
client methods available to build on.
