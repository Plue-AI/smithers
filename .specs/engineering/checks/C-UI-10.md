# C-UI-10 `/debug-api` calls only documented operations with the viewer's own permissions

Folded into T-APP-21's tests (minimal-code synthesis, 2026-10-03).


## Delegated command door (2026-10-09)

`debug-api` declares `smthrs debug api` and an authorization-only
`GET /api/commands/debug-api` door. The app agent and compiled CLI use that
same descriptor. The install's existing member boundary and `services.Authorize`
resolve the live credential scope and role before `never`. The door returns
204 to a person's browser session and grants no execution or reusable authority;
no selected operation, parameters or body are transmitted to it.

`TestDebugAPIDelegatedDispatchBoundariesPostgres` uses a claimed real turn,
`InstallAPI.Begin`, the composed install router, production bootstrap, app
controller and compiled guest CLI. Eligible Member credentials refuse with
`never`; insufficient write scope refuses with `permission`; losing the Member
role invalidates the delegated credential earlier with `unauthenticated`.
Restoring the role returns to `never`. The selected API never receives a request,
and PostgreSQL contains no TODO, workflow-run or approval effects.

The lane's explicit small-dependency directive supplies this missing catalog
bridge beyond T-APP-21's original no-new-route exclusion. No endpoint permission
or execution guard changes; all decisions use the existing shared authorizer.

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
