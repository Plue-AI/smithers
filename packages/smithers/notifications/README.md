# @smthrs/notifications

Release candidate scope, host requirements and compatibility review are defined in the [library support policy](https://github.com/smithersai/smithers/blob/main/RELEASE_SUPPORT.md).

This package declares `effect` as an exact
`4.0.0-rc.115` peer dependency. Keep the application on that version so
all Smithers packages share one Effect runtime.

**Documentation:** https://notifications.smithers.sh

Durable notification queue, admission policy, and journal projection for flows. It models human and system notifications, derives queue state from journal events, and drains eligible work at harness boundaries.

Not on npm yet; see [Installation](https://smithers.sh/docs/installation/).

Node.js 26.4.0 or later. `@smthrs/journal` holds the durable records, and the
example below imports it directly, so declare it in your own package too.

## Public API

The root entry point exports these namespaces; each is also importable from `@smthrs/notifications/<Module>`.

| Module              | Description                                                                               |
| ------------------- | ----------------------------------------------------------------------------------------- |
| `Alerts`            | Turns run conditions that outlive a delay into coalesced, at-least-once alerts.           |
| `Notification`      | Defines notification schemas, admission classes, and coalescing keys.                     |
| `NotificationEvent` | Defines journal notification events and decodes them from journal entries.                |
| `NotificationQueue` | Defines the durable admit/drain/pending service and its journal-backed layer.             |
| `NotificationState` | Implements the pure notification admission and promotion state machine.                   |
| `Projection`        | Derives notification state from journal entries.                                          |
| `SteerPayload`      | Defines the steering vocabulary a control plane and a harness exchange through a payload. |

Every export of every module, with its signature and the meaning of each
parameter, is on
[the API reference](https://notifications.smithers.sh/reference/api/). This file
deliberately does not repeat it.

## What a caller has to know

- A caller MUST read `AdmissionReceipt.decision`. `rejected-full` means the run
  already holds `NotificationState.defaultCapacity` pending notifications, so
  the queue retained nothing and wrote no journal entry. The id stays
  admissible, and the caller admits it again once a boundary has drained.
  `admit` does not fail on a full queue. `NotificationQueue.layerWith` raises
  or lowers the bound for one composition.
- `targetLineageId` is the address of whatever will read the notification: the
  run, or one branch of it that closes turns of its own. The queue treats it as
  an opaque string and only compares it for equality, so pass the run id when a
  run has one reader and the branch's id when it has several.
- The unit of drain is the triple `(runId, targetLineageId, boundary)`. Two
  addresses closing a turn under the same boundary name are two drains, recorded
  separately. `DrainInput.cutoffSeq` holds a steer admitted mid-turn until the
  next boundary.
- `NotificationError.code` is the stable half to branch on:
  `notification_unavailable`, `notification_id_reused`, and
  `notification_invalid`. Storage failures arrive as `Journal.JournalError`.
- `admit` decodes and snapshots its argument, so nothing the caller mutates
  afterwards changes what was journaled.
- An alert sink must be idempotent on `Alerts.alertId`, which the webhook sink
  sends in the body and as an `Idempotency-Key` header. That sink bounds every
  request with `Alerts.defaultWebhookTimeout`, and `Alerts.AlertError` reports
  `sink_rejected`, `sink_unreachable`, or `sink_timeout` and never carries the
  request or its credentials.
- A layer folds each run's journal once and then pages only what has been
  committed since, keeping the 64 most recently read runs.

```ts
import * as TestJournal from "@smthrs/journal/test/TestJournal"
import { NotificationQueue } from "@smthrs/notifications"
import { Effect } from "effect"

const program = Effect.gen(function*() {
  const queue = yield* NotificationQueue.NotificationQueue
  return yield* queue.drain({
    runId: "run-1",
    targetLineageId: "run-1/root",
    boundary: "turn-1",
    wouldIdle: true
  })
}).pipe(
  Effect.provide(NotificationQueue.layer),
  // A real SQLite journal over an in-memory database. Swap in `SqlJournal.layer`
  // over a file for a deployment.
  Effect.provide(TestJournal.layer()),
  Effect.scoped
)
```

`NotificationQueue.layerNoop()` provides the same seam with every method failing as
`notification_unavailable`, for a composition that means to serve nothing.
`@smthrs/notifications/package.json` is also exported; `internal/*` and nested `*/index` subpaths are blocked.

A replayed drain fails with `notification_unavailable` if a committed notification or its payload can no longer be read. It never reports a successful partial delivery.
