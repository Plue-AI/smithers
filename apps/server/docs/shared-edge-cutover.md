# Shared application edge cutover — prepared, not activated

The live Worker still owns product state. The candidate entry `src/edge.ts`
serves assets and forwards `/api` unchanged to `SMITHERS_BACKEND_ORIGIN`.
Authentication, provider credentials, chat, recommendations and product jobs
belong to the shared Smithers backend. There is no fallback or dual write.
Its configuration is `wrangler.edge.jsonc`; `wrangler.jsonc` stays on the
legacy `src/index.ts` and the hosted documents declare no application target
until the gates below pass (`src/deployGeneration.test.ts` holds this). The
activation steps are in `shared-edge-deploy.md`.

## Evidence and retained state

Read-only observations at 2026-09-24 16:05–16:22 UTC:

- Canary `/api/bootstrap` returned Worker build `094c4a7e4ca8b4fcfcc84064e01c3e1f283a4cdd`,
  capabilities `agent`, `identity`, `cloud`, `cloud.terminal`, `recommend`, and
  `authFlow: native-handoff`. Direct `https://api.jjhub.tech/api/bootstrap`
  returned 404. These are different active authorities.
- Cloudflare settings selected identity, billing and chat Workers plus the
  Go API. All six retained web DO identities matched the recorded namespace
  identities. The actual model-vault encryption secret was present; its value
  was not read or printed.
- `bun apps/server/scripts/cutover/inventory.ts` lists object counts and KV
  key counts only. It does not inspect stored documents, transcripts, owners,
  balances or credential values. `hasStoredData` is not a credential or row count.

| Service / class | Objects | Objects with stored data |
| --- | ---: | ---: |
| identity / IdentityDurableObject | 1 | 1 |
| billing / AccountDurableObject | 22 | 22 |
| chat-canary / ChatHistory | 0 | 0 |
| chat-canary / PushSubscriptions | 0 | 0 |
| web / TurnCancelRegistry | 780 | 780 |
| web / GatewaySessionRegistry | 2 | 2 |
| web / TurnRateLimiter | 298 | 296 |
| web / ClientErrorLog | 1 | 1 |
| web / RecommendLog | 1 | 1 |
| web / AccountModelVault | 1 | 1 |

Billing also had three KV keys. The live chat Worker has a metering queue and
billing service credential. None of those rows or queue entries has been
exported, changed, drained or reconciled by this candidate.

| Store | Source keys / authority | Required handling |
| --- | --- | --- |
| AccountModelVault | `model-vault:v1`, login, immutable provider origins, encrypted entries, receipts | Encrypted export; verified identity mapping; import through canonical owner-model store and codec; compare provider pins/receipts/defaults |
| TurnCancelRegistry | `state`; `turn-journal:v1:head`; `turn-journal:v1:batch:<sequence>`; seven-day expiry alarm | Drain producers; export all remaining heads/batches/tombstones; validate hash chains and owner scope; import eligible history and erasures before changing access |
| GatewaySessionRegistry | `gateway:<repo>NUL<workspace>` (a box-less `gateway:<repo>` row is ignored); `repository-setup:request:<id>`; `repository-setup:current:<repo>:<job>`; `repository-setup:pending` | Retired (#2198): the legacy Worker already serves the retired class, so no gateway activity or setup work runs here. Rows are kept for rollback, not imported; a setup request admitted before retirement answers 404 on the backend and the app offers Retry |
| IdentityDurableObject | `account:<id>`, `loginid:<login>`, `ghtoken:id:<id>`, `cloudtoken:id:<id>`, allow/deny and repository state | Export sealed; join verified numeric GitHub id to canonical OAuth account; preserve supported account settings and GitHub token state; legacy session cookies/PATs are not canonical sessions |
| AccountDurableObject + BILLING KV + metering queue | balances, grants, reservations, settlement identities; exact inventory pending | Drain queue, reconcile reservations and ledger, prove no missing or duplicate usage; no payment writes or balance resets during preparation |
| Recommendation/client-error logs | recommendation ring sequence and rows; `reports` | Sealed archive and agreed canonical retention/import; do not silently discard |
| TurnRateLimiter | transient `window` state | Snapshot alongside source; expire only under documented retention after active request drain |

The candidate's six exported classes in `retainedDurableObjects.ts` preserve
namespace identities, return 410, and perform no alarm work. That is appropriate
only **after** state migration and drain. Deploying them beforehand would make
history inaccessible and stop setup work. Existing live classes and alarms
remain untouched while this candidate is unlanded. No DO deletion migration is
included.

## One-time export and import protocol

This is the reviewable maintenance design, not a claim that a migration ran.
Cloudflare's public object-list API supplies object IDs and `hasStoredData`,
not object storage values. Actual row inventory requires a temporary maintenance
version of each owning Worker; it cannot be obtained by the counts script.

1. Record immutable source Worker versions, namespace/class/binding identities,
   canonical backend revision and migration version. Generate an export
   recipient key in the operator's secret store; only its public key reaches
   maintenance Workers. Keep the old model-vault key bound for recovery.
2. Prepare a temporary authenticated maintenance export that enumerates every
   known object by ID through its original namespace. Read paginated storage
   under the object's input gate. Export the original keys, values, object ID,
   alarm timestamp, namespace identity and source version into per-object
   authenticated encrypted envelopes. Encrypt in the owning isolate before
   any bytes leave it; no raw body, transcript or credential logs. Bind the
   envelope to migration ID, namespace, object ID, page number and hash of the
   previous page, and require an authenticated final page. Verify every page
   and the final manifest with the [bounded export protocol](../scripts/cutover/PAGED-EXPORT.md).
   Write files with mode 0600 outside
   the repository. Existing vault ciphertext remains ciphertext inside the
   encrypted archive.
3. Take a rehearsal snapshot while the old authority serves users. An initial
   cross-object copy is not a consistent cutover snapshot. Review redacted
   aggregate inventory: document types, row counts, active jobs, credential
   entry counts, tombstones, and mapped/unmapped ownership counts. Never print
   keys, login values, journals, payment rows or provider secrets.
4. Resolve identities using verified provider IDs. The identity source at
   `smithersai/ui@ace5abee0acd668a3545c72906fde7356f33b29c` records numeric GitHub
   IDs from authenticated `/user` in `account:<id>` and confirms the login
   binding in `loginid:<login>`. Require both records to agree, then join
   canonical `oauth_accounts(provider='github', provider_user_id=<id>)`.
   Missing/conflicting bindings block import; matching a username alone is
   insufficient. Never create an account for an anonymous transcript.
5. The canonical importer runs as a one-time maintenance command, with no
   public compatibility route. It consumes sealed envelopes in memory and
   commits only to canonical tables through their validated store contracts.
   Preserve source IDs and content hashes in a migration ledger so retry is
   idempotent and a changed duplicate fails. Roll back the object transaction
   on malformed payload, identity mismatch, hash gap or immutable provider-pin
   conflict. Test against a disposable database and verify round-trip reads
   with the canonical application client before importing production.
6. For credentials, decrypt the original AES-256-GCM only in the maintenance
   process, using AAD `JSON.stringify([1, login, name, origin])`, then encrypt
   with the canonical owner-model `SecretCodec` before database persistence.
   Plaintext never reaches disk/logs. Preserve provider origin pins and receipt
   identity; report only counts and match verdicts. Keep encrypted backup and
   source key until restore has been tested and retention is decided.
7. For history, validate the existing canonical turn protocol and full batch
   hash chain. Canonical storage uses `chat_turns`, `chat_turn_batches`, and
   `chat_turn_erasures`; tombstones cannot be resurrected. Account owner hashes
   may map through verified identities. Anonymous owner hashes derived from
   the journal capability cannot be relabelled as an account: retain sealed
   copies and require an explicit disposition or a supported canonical
   capability migration if actual unexpired anonymous rows exist. Do not add
   a permanent anonymous-history bridge.
8. Stop **new** legacy admissions in a coordinated maintenance window while
   preserving reads and letting accepted jobs settle. Drain chat producers
   and billing metering; reconcile reservations/usage exactly.
   Capture the final consistent export after drain. Do not synthesize terminal
   success, cancel jobs by deleting state, or enqueue imported accepted turns
   as new work. Import final records once, verify canonical reads/access and
   record source/export/import hash and count receipts.
9. Activate backend, client metadata and edge as one matching candidate only
   when all receipts pass. Retain source namespaces, encrypted backup and old
   deployment version. Rollback after canonical writes requires an explicit
   write/ledger reconciliation plan; routing users back blindly would fork
   state. Remove the temporary maintenance surface after verification. Secret
   and source-data retirement is a later, explicitly recorded action.

Actual stored ownership is still unknown. No human disposition question can be
precise until step 3 has classified real rows. No credential, transcript, balance
or history was removed while preparing this change.

## Client and backend contracts

| Product flow | Canonical contract / remaining gate |
| --- | --- |
| Browser identity | ApplicationClient `GET /api/user`, `GET /api/auth/github`, `POST /api/auth/logout`; hosted document selects session auth |
| Chat/model/recommendations | Existing canonical `/api/agent/turn*`, `/api/model/*`, `/api/recommend*`; live shared build must actually serve them |
| GitHub installation return | Client reads authenticated `/api/user/github-repos` pages and `/api/user/github-access/<owner>/<repo>?surface=issues`; callback installation ID filters verified inventory only |
| Generic schedules | Direct repository-jobs listing, `flow:<slug>/pause`, `flow:<slug>/approvals`; snake_case canonical DTOs and approval identity checks |
| Workflow RPC | Every call names a box (`workspaceId`); `internal/compose/browser_flow.go` allows Plan, Run, Cancel, Resume, Steer, Signal, List, Projection.Snapshot, Approval.Submit through `flowdispatch.Service`; existing read resolver must never start/rebind a host |
| Repository setup | Real required flow; not a stale client. Needs canonical durable admission/result projection and authorized coding catalog selection described below |
| `/api/jev` | Legacy Worker feature; locate any remaining selected-client consumer before claiming full contract coverage; not implemented by an edge shim |

## Repository setup and workflow RPC (#2198)

The backend owns both: `/api/repository-setup/*`
(`internal/compose/repository_setup.go`, durable admission through the shared
jobs/flowdispatch store) and `/api/workflow/{provision,rpc}` on the box's
coding host (`internal/compose/browser_flow.go`). The legacy Worker forwards
them as the signed-in user (`forwardToCloud` in `src/proxies.ts`) and holds no
setup or gateway state. Setup requests the Worker admitted before this were
not migrated; the backend has no record of them, so a reload's observation
answers 404 and the UI settles the request as failed with Retry, which asks
again under a new request id.

## Acceptance receipts required before activation

- Exact backend `/api/bootstrap` build and required capabilities via the
  eventual edge origin; direct and forwarded canonical failures agree.
- Real **session-auth** web-Plue browser, separately from application tokens:
  start GitHub OAuth on the deployed origin, return on that same origin,
  accept state cookie, set session+CSRF, `/api/user` signed in, CSRF-protected
  mutation succeeds, sign-out clears it, reload stays signed out. Test both
  canary and apex routing policy. Interactive starts redirect to the configured
  GitHub callback origin before setting host-only state cookies. The callback
  consumes a state-bound local `return_to`; the API public URL remains separate.
- Selected GitHub account and real setup-URL return, installed-repository
  selection, repository setup and generic schedule actions reach canonical
  routes. Canonical session identity is the same identity used for imports.
- Real chat accepted-before-finish, reconnect/replay/cancel/erase, model
  enrollment/default/test/stream and recommendation outcome; no legacy
  provider/model substitution. Websocket and streaming transport receipts.
- No-start reads, immediate setup acknowledgment, durable running/completion
  toast, reload, duplicate launch and failure receipts with unresolved work.
- Sealed export/import/restore receipts, all ownership gaps resolved, active
  setup/chat drained, billing queue/reservations/ledger reconciled.
- Opus and Astra final review of the integrated candidate, and all six actual
  mode receipts required by the campaign. These are not satisfied by unit
  tests or an application-token browser matrix alone.

Matrix launch configuration: `SMITHERS_MODE_MATRIX_PLUE_URL=https://api.jjhub.tech`
and `SMITHERS_MODE_MATRIX_PLUE_WEB_URL=https://smithers.sh`. The web launcher checks
the app document build stamp and both bootstrap revisions; Git fixtures use the API
endpoint. Native and local modes use the API endpoint directly.
