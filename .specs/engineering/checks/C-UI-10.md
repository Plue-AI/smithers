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
That check qualifies TODO and `/api/flows` canary execution; it does not yet
qualify a Debug API Send of `POST /api/repos/{owner}/{repo}/invoke`.
