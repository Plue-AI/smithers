---
title: "Gmail"
description: "Read and write a person's mailbox: scope-checked client, header-injection-safe composition, a history-based change feed, and draft/send actions reconciled by key."
sidebar:
  order: 6
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/agent/integrations/docs/guides/gmail.md"
---

How to use the Gmail adapter. It is library code: no host in this repository
wires it yet. The [API reference](/reference/api/#gmail) has the full signatures.

## Configure a client

A Gmail connection is a person's own mailbox, so the bearer token never comes
from the environment. The host resolves it through its credential broker and
passes an `AccessTokenSource`:

```ts
import { Gmail } from "@smthrs/integrations"

const client = Gmail.GmailClient.make({ token, connection })
```

`connection` names the account and the scopes Google granted.
`Gmail.Capabilities` maps each operation to the scopes that allow it, and an
operation the grant does not cover fails `permission-denied` before any
request. `SMITHERS_GMAIL_API_BASE_URL` points the client at a fixture server.

## Draft and send

`Gmail.Actions.CreateDraft` and `SendMessage` compose an RFC 2822 message
with `Gmail.Mime.compose`, which refuses a CR or LF in any header. Both writes
stamp your key into the message. A write whose answer was lost fails
`outcomeUnknown` and is not repeated; run `FindByKey` before writing again.
A payload whose connection is not the client's is refused. Whether a send
needs approval first is host policy.

## Follow a mailbox

`Gmail.Sync.mailbox({ … })` builds a `Core.Sync` adapter that lists messages, then follows
`users.history.list` from the history id it started at. A history id Google
no longer holds starts a fresh listing marked `reset`. Trash, spam, and
messages that lost the watched label become tombstones. Gmail has no change
time, so records carry `updatedAtMs: null` and the history id orders every
copy: a deletion hides the stored message and a later restore brings it back.
`Gmail.Sync.search`
pages a query without a cursor.
