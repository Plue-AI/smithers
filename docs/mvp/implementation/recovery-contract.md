# Repository setup recovery

Status: implemented locally; release-owner review and deployed canary pending. Base: reviewed main `89e1d432` (including CT057/CT065). This addresses missing local setup cards; it does not attribute the earlier browser storage incident to the app.

Opening a repository job must show its actual active policy and reconnect the caller’s existing setup work before starting another inspection. Recovery should require no new selection screen.

## MVP requirements

- Show the repository’s current enabled, paused, or scoped-trial registration from the backend. A lookup failure is unknown, never Off.
- Recover this account’s last admitted setup request, draft, exact workspace and available receipts. Reconnect the same pending request; do not start another paid inspection because the card is missing.
- Keep the applied repository policy separate from an unactivated draft. Do not replace edits made while recovery is pending.
- Do not manufacture eval/trial results, automatically reactivate paused work, or use another activator’s gateway.

Historical candidate browsing, recovery of never-submitted local edits, and cross-user execution orchestration are outside this change. Conflicting legacy attempts need not be selected automatically.

## Existing sources

| Source | What it proves | Limit |
| --- | --- | --- |
| Plue `GET /api/repos/{owner}/{repo}/repository-jobs` | Actual registration ID, activator, workspace, mode, revision, digest, source revision, reviewed configuration and enabled state | Repo-wide read access is not authority to execute through another activator’s workspace |
| Plue `GET /api/repos/{owner}/{repo}/repository-jobs/{job}/dispatches` | Actual admitted job dispatches and observed run IDs | Does not prove setup evals or trial success |
| Backend `GET /api/repository-setup/request?requestId=…&repo=…&job=…` | The caller’s exact durable setup receipt and completed result | Requires an already-known request ID; a read never starts work |
| Backend `repository_setup_requests` rows | Original submitted draft and operation, bound workspace, actual receipt/result | The latest row per user, repository and job is what `state` recovers |

Plue stores `mode: "enabled"` plus `enabled: false` for a paused registration. A `mode: "trial"` row is never general activation. `configuration.input` holds the reviewed draft; recovery must parse it with the shared schema and verify its candidate digest before using it as an editable draft.

Source: [backend route](../../../packages/backend/internal/compose/repository_setup.go), [durable requests](../../../packages/backend/internal/services/repository_setup.go) (the Worker DO store is retired, #2198). Backend: `~/plue/cmd/server/router.go:1320`, `internal/services/repository_jobs.go:79,221,284`, `db/queries/repository_jobs.sql`.

## Smallest new contract

The authenticated, no-store discovery read is `GET /api/repository-setup/state?repo=…&job=…`. It performs no provisioning, Plan, Run or automatic activation. It identifies the authenticated `owner` and returns independent facts:

1. **Registration:** authoritative absent, enabled, or paused policy; any scoped trial is a separate field. Include the actual registration identity, revision/digest, source revision and activator. Return only the public configuration fields needed by this UI.
2. **Owned setup:** the indexed admitted request and its submitted candidate, public receipt/result and exact workspace; or a definitive absence. A completed inspection’s suggested draft is reconstructed through the shared `editSetup` rule so its revision change matches normal completion.

Do not return private gateway credentials, Plan envelopes or client-editable claims of passing evidence. Partial failures must remain explicit: a successful registration read can show Enabled while setup recovery is unavailable. Failed registration lookup must not silently reuse a stale Off value.

### Deterministic pointer for new admissions

Use one pointer per `(authenticated account, canonical repo, job)` in the existing login DO. It contains a monotonically increasing admission sequence and the current request ID; the request record remains the data authority.

- A genuinely new admitted request advances the pointer once, under the existing object mutex. An idempotent retry of any old ID, polling, completion or failure never moves it backward or makes an old request current.
- Persist the request, pointer and admission queue state atomically before acknowledging admission or launching work. The storage adapter uses one native `put(entries)` for all three keys. Cloudflare makes that operation atomic; the memory and native SQLite adapters use equivalent batch semantics.
- A response for the pointed request updates that record, not the pointer. A completed inspection’s suggested candidate belongs to that same request; an older completion cannot replace a newer admission.
- Discovery follows that exact pointer, never the largest draft revision or latest response timestamp. This defines a deterministic last-admitted draft across this account’s browsers, without a candidate picker. Existing local edits still win in a browser that has them.

### Legacy recovery without arbitrary selection

The current backend registration is sufficient to restore truthful enabled/paused status and its reviewed draft, even when no old setup request can be discovered. Match its canonical repo/job, registration ID, revision, digest and immutable source revision. Only bind the workspace for execution when its recorded activator matches the authenticated account under existing backend checks. Other readers may see the real policy without adopting that authority.

The legacy queue is a hint, not a complete list: observation expires after 24 hours without claiming the host stopped. Before seeding a pointer from even one queued request, scan the bounded legacy record prefix for all unfinished requests matching this account/repo/job. Exactly one unambiguous unfinished request may seed the pointer only after the scan completes. A second expired nonterminal request, invalid record, unavailable storage or exhausted byte/item bound is unknown/conflict; launch nothing and use the existing retryable error path. No selector is added.

The same scan must establish absence before treating an unindexed job as new. Scan ceiling: 200 records or 4 MiB of decoded records, in pages of at most 50; exhausting either ceiling without proving completion is unknown, never empty. Prefix listing uses the existing DO storage adapter. This is a server recovery check, not a historical browsing interface.

A sole completed legacy record can be recovered after the full scan. With several completed records, only one apply receipt matching the owned registration ID, revision, digest, workspace and immutable source is selected. Other ambiguous histories remain unavailable; no eval/trial receipt is inferred from registration state.

## Client behavior

Persist a recovery intent and acknowledge immediately. Use the shared background toast while reading. The setup card stays editable; matching pending work retains its real Run access. Persist an observe-only transport marker for recovered requests. Discovery reads durable records and registration truth; it never calls the existing advancing GET path. The separate `GET /api/repository-setup/observe` route reads only an already-recorded run through `Projection.Snapshot` and `provision:false`, with no Plan, Approval.Submit, Run or registration mutation. Missing, expired, sleeping, unauthorized or unavailable gateways fail without waking or renewing a workspace. Missing run identity stays unknown. This marker survives browser restart, edits while work is pending and the existing Reconnect action. Old observation errors for known runs receive one bounded observation; another failure settles the toast. Automatic `runs.open` attachment is suppressed during recovery because that existing door may provision. The card retains its real Run/Job run buttons; opening one is an explicit user action.

The response owner must match the captured card owner, including a browser cookie replacement that has not reached the local identity row. Before and after persistence, fence recovery by account identity/epoch, explicit repo/job, request ID and the local candidate version captured at admission. An `adoptDraft` bit permits hydration only for a missing card’s untouched initial candidate. Its original revision/digest guard survives a failed read and Retry; later refreshes preserve local drafts. Never overwrite a changed local draft with a late response. Definitive server absence permits the existing first-inspection path. Errors and legacy conflicts remain retryable; they must not trigger a new inspection automatically.

A recovered active registration can truthfully show Enabled without recreating an old apply receipt. It does not supply passing eval/trial evidence for a changed candidate. Paused reactivation continues to require a newer reviewed revision; never replay the old apply request to resume it. A newer backend pause wins over an older unobserved or completed apply receipt. Recovered receipts cannot set activation state independently of the current backend registration.

## Required checks before release

1. A fresh browser shows an actual enabled or paused policy with zero inspection/Plan/Run launches. A scoped trial never appears generally enabled.
2. Lost local state with one owned pending request reconnects the same ID exactly once; duplicate opens, reload, and held persistence remain immediately acknowledged.
3. A late old response or idempotent old retry cannot rewind the admission pointer. Crash tests prove request/index admission is atomic.
4. Lookup failure, corrupt pointer or conflicting legacy work does not show Off or launch another inspection. Cover one queued request plus a second expired nonterminal record and exhausted item/byte limits. A definitive empty result does permit normal initialization.
5. Account/target changes and edits during a held read prevent stale adoption. Another activator’s registration is visible without borrowing its gateway.
6. Missing eval/trial receipts remain missing. Recovered paused settings require fresh reviewed evidence at a newer revision before activation. Exercise the actual execution seam with a paused/newer registration plus an older unobserved apply: discovery, automatic reconnection and reload send zero Plan/Approval.Submit/Run or registration mutation calls.

## Persistence and verification

The card schema adds optional recovery intent, `request.observeOnly` and `active.owned` metadata. These fields grant no host authority. Projector version **4→5** uses the existing atomic projector upgrade; `APP_SCHEMA_VERSION` is unchanged. The upgrade retains old setup cases and unfinished receipts, and a subsequent reopen retains the new observation metadata.

Focused checks cover atomic batch rejection and held commit, duplicate admission and old retries, full legacy item/byte ceilings, current source/flow/mode/configuration identity, paused policy versus old apply, read-only gateway lifecycle refusals, partial failures, account epochs before and after held persistence/body reads, explicit target stability, local edits, retry/reload and actual native SQLite journal/crash regressions. These are local tests with explicit backend fixtures. They do not claim a deployed recovery or model-quality pass. Final command results are recorded with the release candidate; the release owner still must verify missing-card recovery against an actual persisted registration/request, zero duplicate launches, and a real browser restart.

The platform batch guarantee is documented in [Cloudflare Durable Object storage](https://developers.cloudflare.com/durable-objects/api/legacy-kv-storage-api/). Implementation: [recovery read](../../../apps/server/src/repositorySetupRecovery.ts), [fixed observer](../../../apps/server/src/repositorySetupExecution.ts), [client controller](../../../apps/app/src/mainview/state/controller/repositorySetup.ts). Legacy conflicts use the existing retryable error path; this adds no candidate selector or navigation action.
