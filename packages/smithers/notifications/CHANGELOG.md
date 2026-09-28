# @smthrs/notifications

## [Unreleased]

### Breaking Changes

- `SteerPayload.decode` takes the notification instead of its payload and
  answers `undefined` for every `system-event`. A webhook or system-event
  producer whose payload carried a `body` string or a `kind` could otherwise be
  read as an operator message, seat, thinking, or tools steer.
- `NotificationEvent.fromEntry` reads an `Admitted` entry only under
  `admissionSourceId` of the notification it carries, and a `Promoted` entry
  only under a `/notifications/drain/` source. Another journal writer could
  otherwise forge a steer or mark pending steers delivered.
- `NotificationQueue.admit` refuses a notification larger than 1,048,576 UTF-16
  code units with `notification_invalid`, before copying or fingerprinting it.
- `Alerts.defaultDetectors` consult only `control.*` event types, and a
  `Detector.eventTypes` item ending in `.*` names a family. A
  `flows.alerts.delivered` entry suppresses a page only under the alerter's own
  source.

## [1.0.0-rc.0] - 2026-09-01

### Breaking Changes

- `NotificationQueue.admit` decodes its argument against
  `Notification.Notification` before it writes anything. A structurally invalid
  value used to be acknowledged at a real journal sequence and then skipped by
  every replay, which is acknowledged data loss. It now fails with
  `notification_invalid` and the dotted path of the field that failed.
- `NotificationQueue.NotificationError.code` gained
  `notification_id_reused` and `notification_invalid`, and the error carries
  `notificationId` and `path`. Reusing a stable id with different content used
  to be raised as a `Journal.JournalError` with `idempotency_conflict`,
  borrowing the storage layer's error type for a rule this package decides.
- A full queue no longer journals its refusal. `admit` returns
  `rejected-full` in the receipt alone, so the notification id stays admissible
  once a boundary drains. A recorded refusal matched on every later attempt and
  burned the id permanently, and no drain could ever free it.
- `NotificationState.defaultCapacity` replaces `Projection.defaultCapacity`.
  The bound is the queue's, not the read model's, and the queue no longer
  depends on the projection module for it.
- Admission and promotion records are written with `dedupe: "identity"`. Both
  used to compare payload bytes, so two processes that loaded at different fill
  levels failed the second writer over `decision`, a derived field neither
  caller supplied.
- `Alerts.AlertError` carries `code`, `status`, and `reason` instead of
  `cause`. The cause was the `HttpClientError`, which holds the request, which
  holds the credential a deployment handed `layerWebhook`.
- `Alerts.Rule.afterMs` is a whole, non-negative number of milliseconds, and
  `Alerts.layer` decodes the whole policy when the layer is built. `NaN` fired
  on the first tick and stamped a `firedAt` that JSON wrote as `null`; a
  negative delay fired with a `firedAt` earlier than the condition it described.

### Fixed

- A drain's journal identity is now the lineage and the boundary, each
  percent-encoded. It was keyed on the boundary alone while the duplicate read
  required both, so a second lineage draining the same boundary name on one run
  failed with `idempotency_conflict` and its notifications stayed pending.
- `admit` and `drain` return the decision the journal committed, read back
  after the write, rather than the value this process computed before it.
- `admit`, `drain`, `pending`, and `Alerts.tick` fold a run once and then page
  only the entries committed since. Every call used to re-page and re-decode
  the run's entire journal, twice in `admit` and `drain`, making the cost
  quadratic in journal length. Each layer keeps the 64 most recently read runs.
- `Alerts` records one journal entry per alert per outcome. Failures were
  written with no `sourceSeq`, so the journal allocated a new sequence on every
  attempt and a webhook that stayed down appended a row per tick forever.
- `Alerts.tick` reads the admission receipt. An alert the queue refused is
  reported in the new `Alerts.Tick.refused`, the sink is not called, and no
  delivery is recorded, so nobody is paged about an alert the run cannot read.
- `Alerts.conditions` tests a detector's field with `Object.hasOwn`. `in` walks
  `Object.prototype`, so a detector named `toString` or `constructor` read
  every record-shaped entry in the run as evidence and closed the condition on
  all of them, silently preventing the alert from ever firing.
- `Alerts.layerWebhook` bounds its request with `defaultWebhookTimeout`, ten
  seconds by default. An endpoint that accepted the connection and never
  answered stalled a run's whole alert runtime.
- `Alerts.coalescingKey` percent-encodes each component, so a run id or a
  condition name containing the separator can no longer forge another pair's
  key and suppress an unrelated page.
- `SteerPayload.encode` copies a `Tools` item's `toolNames`. The returned
  record shared the caller's array with an admission that serializes it later.

### Added

- `NotificationQueue.layerWith({ capacity })` serves the same layer at a bound
  the composition chooses. The capacity used to be a constant no deployment
  could raise.
- `NotificationQueue.DrainInput.cutoffSeq` carries the journal sequence that
  opened a turn. `NotificationState.promoteSteers` documented that a steer
  admitted after the cutoff is held for the next boundary, and the layer could
  never express it: the cutoff was the last sequence it had just read, so every
  pending steer always satisfied it.
- `NotificationEvent.AdmissionDecision` is the one declaration of the admission
  vocabulary, exported as both a schema and a type, and `NotificationState`
  re-exports it. The two used to be independent declarations that a fourth
  decision could silently desynchronize.
- `NotificationEvent.isAdmitted` and `NotificationEvent.isPromoted` give the
  untagged owned-event union one named discriminator, replacing three separate
  property-presence checks.
- `Alerts.FailureCode`, `Alerts.coalescingKey`, and
  `Alerts.defaultWebhookTimeout` are public.
- The webhook sink sends `alertId` in the body and as an `Idempotency-Key`
  header. The package requires the receiver to dedupe on that id, and the body
  did not carry it.
- Package-owned documentation under `docs/`, generated into
  `docs/pages/api/notifications.md` by the `docsPages` target, plus this
  changelog, which `package.json` already declared in `files`.

### Changed

- The durable event types stay spelled `flows/notifications/Admitted` and
  `flows/notifications/Promoted`, which is slashes and a PascalCase leaf where
  every other event type in the repository is dot-separated and lowercase. The
  values are already durable in every engine database and a rename would
  silently stop matching consumer projections, so both spellings are frozen by
  `test/WireFormat.test.ts` and the divergence is stated in their JSDoc.
- `SteerPayload.decode` still reads a record carrying a `body` string and no
  `kind` as a message, but the reason is now stated correctly: it is the shape
  a minimal caller writes, and the steer RPC accepts the same one. The previous
  rationale claimed the branch existed for payloads written before the
  vocabulary, which rc.0 cannot hold because it never loads a 0.x database.
- Retired the 45 internal `@slop` review markers that shipped in `src` and in
  the published `.d.ts`, writing the sentence each one stood in for.
