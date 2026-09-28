# @smthrs/sync

## Unreleased

### Security

- **Breaking.** `BranchShare` and `WorkspaceShare` keyrings refuse a signing
  secret shorter than 32 bytes of UTF-8 with `invalid_request`. One observed
  capability let an attacker search a short secret offline and forge
  capabilities.
- `BranchPresence` binds a live participant to the `capabilityId` that
  announced it. Another capability's announce or leave for that participant is
  refused with `unauthorized` until the lease lapses.
- `BranchCommands.submit` stamps the verified `capabilityId` on the durable
  command payload, and `BranchProjection` carries it on every message, command,
  and field, so a command is attributed to the capability that sent it rather
  than to the `participantId` the client claimed.
- **Breaking.** `TestSync.layerWorkspaceAuth` is renamed
  `TestSync.layerTrustAllAsOwner` so a composition that trusts every
  connection as the owner says so where it is wired.

## [1.0.0-rc.0] - 2026-09-01

### Added

- Added workspace authentication: the `SyncAuth` RPC middleware and its
  header-verifying implementation, the `WorkspaceShare` capability authority
  over a `Redacted` keyring with `kid` rotation, and the per-request
  `SyncPrincipal` whose default is anonymous.
- Added compaction recovery: `SyncProtocol.Resync`, the `compacted` error code
  and `SyncError.resync`, and the client-side resync that moves a run's cursor
  to the checkpoint and restarts instead of dying.
- Added `SubscribeOptions.onResync`, the seam a consumer restores checkpoint
  state through. It runs before the cursor moves and must succeed, so a
  follower that cannot fill the hole fails rather than skipping it silently.
- Added `SubscribeOptions.apply`, which advances a cursor only after the
  consumer has applied the entry, so `RunCursor` can mean what its schema says.
- Added the bounded workspace fan-out: `SyncServer.Options.concurrency` and
  `tailIntervalMs`, plus `RunCatalog.makePolling` for the durable run set a
  workspace follower learns from.
- Added request limits `SyncProtocol.maxReadLimit` and `maxSubscribeCredit`,
  the branch ledger bound `BranchCommands.defaultLedgerCapacity`, and the
  roster bound `BranchPresence.defaultMaxParticipants`.
- Added golden wire vectors: the encoded form of every frame variant, a read
  response, a command receipt, the capability header, and both authorities'
  signatures are frozen as literals, so a renamed field or a changed signing
  encoding fails a test rather than a deployed follower.

### Changed

- **Breaking.** `SyncError.cause` is a bounded string rather than
  `Schema.Unknown`. It is the declared error schema of every RPC, so it now
  carries a rendering instead of the host object that failed; a journal
  failure crosses as its stable journal code and never as the driver's own
  message.
- **Breaking.** `BranchShare.makeHmac` and `layerHmac` take a `Redacted`
  keyring rather than a single secret, `ShareClaims` carries the signing `kid`,
  and the branch scheme signs a scheme label, now `v2`, so a branch signature
  can no longer be replayed as a workspace signature under a shared secret and
  the branch secret rotates the way the workspace secret already did: the
  retired key stays in the keyring until its links expire. `BranchShare`
  gained `layerConfig`, which reads `SMITHERS_SYNC_BRANCH_SECRET` and
  `SMITHERS_SYNC_BRANCH_KEY_ID`. Outstanding branch capabilities do not verify
  under this release.
- **Breaking.** The client's service tag is `SyncClient.SyncClient`, keyed
  `@smthrs/sync/SyncClient`, matching every other service module.
  `SyncClient.Sync` stays as a deprecated alias of the same tag for one
  release.
- **Breaking.** `SubscribeOptions.apply` and `onResync` fail with the
  consumer's own error types, and `subscribe` returns
  `Stream<Entry, SyncError | SyncGapError | EApply | EResync>`. A consumer's
  transaction failure no longer has to borrow a wire code such as `unknown` or
  `compacted`, so it can no longer be mistaken for a transport or protocol
  failure or pass `SyncError.is`.
- **Breaking.** `SyncProtocol.Progress` is
  `{ delivered: WorkspaceCursor, applied: WorkspaceCursor }`. The
  `DeliveredProgress` and `AppliedProgress` tagged wrappers are removed: they
  never sat in a union, so their tags discriminated nothing. `Service.cursors`
  is removed; read `progress.delivered` instead.
- **Breaking.** `BranchCommands.submission` returns
  `Effect<CommandSubmission, SyncError>`. It decodes the fields it fills in, so
  a command name the schema forbids is the same typed refusal `submit` returns
  one call later rather than a throw at the caller.
- `BranchShare.mint` and `WorkspaceShare.mint` decode their request before
  signing it. An empty `branchId` or `capabilityId` and a `ttlMs` of `0` or
  `NaN` are refused with `invalid_request`; `ttlMs: 0` used to mint an
  already-expired capability, and the others died where the declared type
  promises a `SyncError`. `Branch.CreateBranch` decodes the id its `BranchIds`
  port yields instead of branding it, so a host id source returning `""`
  refuses rather than crashing the handler.
- Both authorities verify through one pipeline, `shareSigner.verifyClaims`, so
  the signature check, the expiry boundary, and the read-only refusal cannot
  drift apart between them. `ShareHardening` asserts each against both.
- **Breaking.** A subscription's `credit` must be between 1 and
  `maxSubscribeCredit`, and a read's `limit` at most `maxReadLimit`. A cursor
  set that names one run twice is refused with `invalid_request`.
- **Breaking.** `BranchRpcs`'s submit, announce, leave, and roster payloads are
  the service schemas rather than copies of them, so `displayName: ""` is a
  typed wire refusal instead of a defect raised inside the presence service.
- **Breaking.** The branch request schemas `SubmitRequest`, `Announcement`,
  `RosterRequest`, and `LeaveRequest` live in `BranchProtocol` beside every
  other branch wire shape, so `BranchRpcs` no longer imports the command ledger
  or the presence registry. `BranchCommands.SubmitRequest`, the three
  `BranchPresence` request schemas, and the `BranchRpcs` aliases
  `SubmitPayload`, `AnnouncePayload`, `LeavePayload`, and `RosterPayload` are
  removed. `BranchProtocol.CommandIdentity` is removed: the ledger reads a
  command's id from the payload admission already decoded.
- **Breaking.** `makeLiveWith`, `layerWith`, and `BranchPresence.layer` fail
  with `invalid_request` when an option is not a positive safe integer.
  `BranchPresence.Service` gained `leaseMs`.
- A workspace subscription woken by an entry committed in this process reads
  only the runs that entry named, rather than re-listing the catalog and
  reading one page per covered run. The catalog-wide round still runs at open,
  on an announcement, and once per `tailIntervalMs`, so removals, generation
  changes, and other processes' writes are reconciled as before. The bounds
  documentation now separates what a follower holds open, which the bounds
  cap, from its per-run positions and per-round work, which scale with the
  runs it covers.
- A branch admitted after a workspace subscription opened ends the stream at
  that branch's own expiry: the expiry interrupt re-arms when reconciliation
  lowers the deadline, and a page checks the deadline before it emits, so a
  journal read that spans the expiry serves nothing past it and a stalled read
  cannot hold the subscription open.
- An open subscription ends with `unauthorized` when the capability that
  authorized it expires. Authorization was one-shot at open, so a share-link
  holder could read past its own expiry by staying connected. That now covers a
  branch a workspace subscription discovers AFTER it opened: reconciliation
  carries the admitting capability's expiry into the subscription's deadline
  rather than reducing the admission to a yes.
- Catch-up paging defers its cursor snapshot, so every page past the first asks
  from where the previous one ended instead of repeating the previous request.
- Catch-up pages are validated the way live frames already were: scope,
  per-run ordering, progress past the requested cursor, and cursor uniqueness,
  refused as `protocol_violation` before any cursor moves.
- A workspace subscription reconciles its covered run set against
  `RunCatalog.list` every round, so a run the catalog gains becomes visible
  without an announcement and a run it stops naming is no longer queried.
- A workspace tail reads one bounded page per run per round, so a permanently
  busy run wakes the next round instead of holding its fan-out slot.
- A read shares its `limit` across the runs it covers before any run takes a
  second helping. Filling in run order let a producer that stayed one page
  ahead take every slot of every page, so `done` never became true and a
  bootstrapping follower never reached the runs behind it.
- The server deduplicates `RunCatalog.list` at the seam. A host catalog that
  named one run twice had it read twice from the same served position, so a
  read page carried its entries twice and a subscription opened two concurrent
  tails of it emitting identical frames.
- `BranchCommands` keys its ledger and permit per branch, and `BranchPresence`
  keys its roster per branch, so ids sharing a delimiter no longer collide and
  one branch's replay no longer stalls another's writes.
- `BranchCommands.replay` ends its walk on an empty page, matching the guard
  the workspace tail already carried.
- An admission conflict on a command whose receipt the bounded ledger has
  already evicted reads the branch's durable history for it, so it is reported
  as the duplicate it is instead of as a journal contradicting its own conflict
  report.
- `Branch.MintShare` refuses a parent capability that expired mid-request
  rather than minting a link that can never authorize.
- `BranchShare` and `WorkspaceShare` verify from a snapshot taken at entry, so
  claims cannot widen while Web Crypto is in flight.
- Share claims are refused with `invalid_request` when they do not survive
  UTF-8, and length prefixes count UTF-8 bytes rather than UTF-16 units.
- `encodedByteLength` is total: a value with no JSON text costs the bytes
  `null` occupies, and a value JSON refuses measures as infinite so it trips
  every ceiling rather than throwing.
- `branchOfRunId` returns `null` for the bare branch prefix instead of
  branding an empty string as a `BranchId`.
- `RunCatalog.layerStatic` answers `list` with a fresh array, matching the
  other implementations.
- `BranchShare.makeNoop` and `WorkspaceShare.makeNoop` fail `mint` instead of
  dying, matching their declared type and the rest of the package.
- `SyncError.is` validates the code, the message, and the `resync` invariant
  rather than trusting a bare tag, and answers rather than raising when a
  field it reads throws.
- `SubscribeOptions.credit` and `SyncClient.make`'s `bootstrapLimit` are
  refused locally with `invalid_request` when they exceed the wire maxima. A
  value only the wire schema rejected surfaced as a transport failure and the
  follow retried it under backoff forever.
- `SyncError.message` is bounded like `cause`, and a journal failure's rendered
  code is bounded too, so no host string can be the largest thing an error
  carries.
- A journal failure whose code this boundary also declares crosses as that
  code: `journal_closed` as `closed`, `queue_overflow` as `backpressure`, and
  `decode_failed` as itself, on the read path and the branch write path alike.
  Collapsing every code but `compacted` into `unknown` threw away a
  classification the wire already carried, so a follower could not tell a
  shut-down journal from an unexplained fault. A code with no counterpart here
  stays `unknown`, and the journal's own message stays refused.
- `apply` and `onResync` are handed values the committed position is
  snapshotted from, so a consumer callback can no longer choose the cursor it
  is being handed an entry for.
- `Branch.WatchRoster` compares rosters by an injective rendering and
  deduplicates its initial emission, so a change the old delimiter-joined key
  hid is emitted and an unchanged roster is not sent twice.
- `HeartbeatFrame` is documented as reserved: no server emits one, so a client
  must not wait for it.
- Documentation is package-owned and generated: `docs/pages/api/sync.md` and
  the protocol section of `docs/pages/concepts/sync.md` come from this
  package's JSDoc and `docs/`.

## [0.1.0] - 2026-08-05

### Added

- Added the workspace read-path sync protocol with its server, client, and
  run catalog.
- Added the shared branch protocol, presence, projection, commands, share, and
  RPCs, with authorization enforced on the server.
