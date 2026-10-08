# C-UI-10 `/debug-api` calls only documented operations with the viewer's own permissions

Folded into T-APP-21's tests (minimal-code synthesis, 2026-10-03).


## Remaining delegated-dispatch evidence (2026-10-08)

`TestDebugAPIDelegatedDispatchBoundariesPostgres` uses a claimed real turn,
`InstallAPI.Begin`/`MintForTurn`, the composed install router and PostgreSQL.
It proves local app-agent refusal and a compiled production guest CLI's
`COMMAND_NOT_FOUND`, with an authenticated `auth status` control and no HTTP
requests from the absent Debug API CLI door. These are boundary receipts,
not combined scope/role-before-`never` evidence.

The shipped `debug-api` catalog row has `cli: null` and `http: null`. The app's
unscoped agent invocation supplies no credentialed host authorization seam.
Removing the local `never` check from `Catalog.ts` affects served HTTP commands;
it does not supply this client-only command's missing door. Combined evidence
remains blocked on T-CAT-01's shared authorization contract. T-APP-21's frozen
scope excludes new backend routes and changes to endpoint permissions.

Positive branch-machine evidence still requires the approved Apple Silicon
install bundle and a real microVM. The existing T-FLW-01 reference check is
`go test -p 4 ./internal/compose -run '^TestCSEC02BundledInstallIsolation$' -count=1 -v`
from `packages/backend`, with `SMITHERS_CHECK_BUNDLE`,
`SMITHERS_REQUIRE_MICROVM_TESTS=1` and `SMITHERS_FLOW_ISOLATION_EVIDENCE_DIR` set.
That check now also drives the production app controller's Debug API
Send/Confirm for `POST /api/repos/{owner}/{repo}/invoke`, using its own install
owner session and a distinct repository `debug-canary`. It requires zero
requests before Confirm, one 201 queued receipt, an independently observed
non-root guest marker, the matching persisted host binding and a completed
run. The enclosing sampler, host markers and TCP listener cover this request.
It retains `debug-api-invoke.json` alongside the qualified bundle receipts.
The browser scenario runs this check when `SMITHERS_CHECK_BUNDLE` is supplied;
it remains pending without the reference environment. Authorship and Linux
compilation are not a passing reference-host receipt.
