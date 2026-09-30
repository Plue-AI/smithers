# Shared application edge cutover — activated by direct switch

`src/edge.ts` serves assets and forwards `/api` unchanged to
`SMITHERS_BACKEND_ORIGIN`. Authentication, provider credentials, chat,
recommendations and product jobs belong to the shared Smithers backend. There
is no fallback or dual write. `wrangler.jsonc` is the edge, and the hosted
documents declare the session application target.

On 2026-09-29 the owner (Will) ruled that there are no users and that the
cutover is a direct switch through the normal deploy path: no rehearsal, fence,
export/import or staged cutover (smithersai/plue#531). The first edge deploy
replaces the live legacy version, admitted by the committed owner record
`../cutover/activation.json` (`../DEPLOY.md` "Cutover interlock"). The record
also states the import disposition and retroactively records the 2026-09-27
no-user backend bootstrap (plue `0453975821e593aa5718ad7658629d7ed6a034c2`).

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

| Store | Source keys / authority | Handling if an export is ever needed |
| --- | --- | --- |
| AccountModelVault | `model-vault:v1`, login, immutable provider origins, encrypted entries, receipts | Encrypted export; verified identity mapping; import through canonical owner-model store and codec; compare provider pins/receipts/defaults |
| TurnCancelRegistry | `state`; `turn-journal:v1:head`; `turn-journal:v1:batch:<sequence>`; seven-day expiry alarm | Drain producers; export all remaining heads/batches/tombstones; validate hash chains and owner scope; import eligible history and erasures before changing access |
| GatewaySessionRegistry | `gateway:<repo>NUL<workspace>` (a box-less `gateway:<repo>` row is ignored); `repository-setup:request:<id>`; `repository-setup:current:<repo>:<job>`; `repository-setup:pending` | Retired (#2198): the legacy Worker already serves the retired class, so no gateway activity or setup work runs here. Rows are kept for rollback, not imported; a setup request admitted before retirement answers 404 on the backend and the app offers Retry |
| IdentityDurableObject | `account:<id>`, `loginid:<login>`, `ghtoken:id:<id>`, `cloudtoken:id:<id>`, allow/deny and repository state | Export sealed; join verified numeric GitHub id to canonical OAuth account; preserve supported account settings and GitHub token state; legacy session cookies/PATs are not canonical sessions |
| AccountDurableObject + BILLING KV + metering queue | balances, grants, reservations, settlement identities; exact inventory pending | Drain queue, reconcile reservations and ledger, prove no missing or duplicate usage; no payment writes or balance resets during preparation |
| Recommendation/client-error logs | recommendation ring sequence and rows; `reports` | Sealed archive and agreed canonical retention/import; do not silently discard |
| TurnRateLimiter | transient `window` state | Snapshot alongside source; expire only under documented retention after active request drain |

## Import disposition: retained, not migrated

Nothing in the tables above was exported, imported, drained or deleted. The
legacy Durable Object state stays under its unchanged namespace identities: the
six classes in `retainedDurableObjects.ts` keep the storage, return 410 and do
no alarm work. No `deleted_classes` migration exists. The retained secrets stay
bound (`keep_bindings`). The sibling identity, billing and chat Workers are
retired below.

If an export is ever needed, the sealed-inventory and paged-export tooling in
`../scripts/cutover/` reads the retained namespaces
([bounded export protocol](../scripts/cutover/PAGED-EXPORT.md),
`sealed-state-inventory.md`). That is a later, separately decided operation,
not part of the activation.

## Sibling Worker retirement (#3124)

Disposition, decided 2026-09-30 under the owner's no-users ruling
(smithersai/plue#531): the identity, billing and chat Workers' stored data is
**not migrated and is deleted with the Workers**. The shared backend is the
only authority for accounts, sessions, GitHub tokens, balances and chat turns;
none of it reads legacy state.

| Worker | Hostnames | Stored data | Disposition |
| --- | --- | --- | --- |
| `smithers-cloud-identity` | `identity.smithers.sh`, `smithers-cloud-identity.willcory10.workers.dev` | `IdentityDurableObject`: 1 object (accounts, allowlist, stored GitHub and cloud tokens) | deleted with the Worker; no token is carried forward |
| `smithers-cloud-billing` | `billing.smithers.sh` | `AccountDurableObject`: 22 objects; `BILLING` KV: 3 keys | deleted with the Worker; no balance or grant is carried forward |
| `smithers-cloud-chat` | `chat.smithers.sh` | `ChatHistory`, `PushSubscriptions`; the metering queue | deleted with the Worker |
| `smithers-cloud-chat-canary` | `smithers-cloud-chat-canary.willcory10.workers.dev` | `ChatHistory`, `PushSubscriptions`: 0 objects each | deleted with the Worker |

Counts are the 2026-09-24 observation above. The operator records content-free
object counts immediately before deletion, then deletes each Worker with its
Durable Object namespaces, removes any remaining route or DNS record for its
hostnames, and deletes the retired `IDENTITY_SERVICE_TOKEN` repository secret.
The exact commands and their receipts are on #3124.

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

## Acceptance receipts after activation

- Exact backend `/api/bootstrap` build and required capabilities via the
  eventual edge origin; direct and forwarded canonical failures agree.
- Real **session-auth** web-Plue browser, separately from application tokens:
  start GitHub OAuth on the deployed origin, return on that same origin,
  accept state cookie, set session+CSRF, `/api/user` signed in, CSRF-protected
  mutation succeeds, sign-out clears it, reload stays signed out. The apex is
  the callback origin: the backend's `auth.github.redirectURL` is
  `https://smithers.sh/api/auth/github/callback`, registered on the GitHub App,
  in the same release that activates this edge (#2103). An apex start must stay
  on the apex; a hop to canary or the API host fails acceptance. Interactive
  starts on any other origin redirect to the apex before setting host-only
  state cookies. The callback consumes a state-bound local `return_to` and
  lands on the requested repository; the API public URL remains separate.
- Selected GitHub account and real setup-URL return, installed-repository
  selection, repository setup and generic schedule actions reach canonical
  routes. Canonical session identity is the same identity used for imports.
- Real chat accepted-before-finish, reconnect/replay/cancel/erase, model
  enrollment/default/test/stream and recommendation outcome; no legacy
  provider/model substitution. Websocket and streaming transport receipts.
- No-start reads, immediate setup acknowledgment, durable running/completion
  toast, reload, duplicate launch and failure receipts with unresolved work.
- Opus and Astra final review of the integrated candidate, and all six actual
  mode receipts required by the campaign. These are not satisfied by unit
  tests or an application-token browser matrix alone.

Matrix launch configuration: `SMITHERS_MODE_MATRIX_PLUE_URL=https://api.jjhub.tech`
and `SMITHERS_MODE_MATRIX_PLUE_WEB_URL=https://smithers.sh`. The web launcher checks
the app document build stamp and both bootstrap revisions; Git fixtures use the API
endpoint. Native and local modes use the API endpoint directly.
