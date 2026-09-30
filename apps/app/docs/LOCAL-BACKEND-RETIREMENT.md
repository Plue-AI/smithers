# The local backend retired

The desktop app offers exactly the feature set the web app offers. It works
against plue (Smithers Cloud) and, without it, as a signed-out shell — but it
no longer runs anything on the reader's own machine beyond serving the SPA,
proxying to the seams, and keeping the chat turn journal.

Everything in `apps/app/src/bun` that implemented a capability the web does not
have is gone: build targets and their runs, the in-process language servers,
local terminals, local repositories, harness detection, the seatbelt sandbox,
and the detached session daemon. With them went the six `local.*` runtime capabilities, the
flows gated on them, and the UI surfaces those flows were the only door to.

## Why

Two feature sets meant two products. Every local-only door was a flow the web
catalog hid, a card the web could not render, a refusal the web had to word,
and a second implementation of something plue already does inside a workspace
VM. One feature set is one product.

## Where the old code is

The full local backend is readable at commit **`42b8abbc1cf6`**, and is gone as
of the deletion commit:

> **Before: `42b8abbc1cf6`** — the last state carrying the whole local backend.
> **After: `57a48653c7e8`** — this deletion.

Peer sessions landed on `main` between the two, so they are not parent and
child. Read the removed code with `jj file show -r 42b8abbc1cf6 <path>`, or
diff a single cluster with
`jj diff --from 42b8abbc1cf6 --to 57a48653c7e8 apps/app/src/bun`.

## What was removed and what replaced it on the web

| Cluster | Removed from `apps/app/src/bun` | Lines | What the web does instead |
| --- | --- | --- | --- |
| Target runs | `Targets.ts`, `TargetGraph.ts`, `TargetRunHistory.ts`, `Affected.ts`, `CiMatrix.ts`, `Node.ts`, `DeclarationBindings.ts`, `routes/repoTargets.ts`, `routes/targetGraph.ts` + tests | 5,987 + `Affected.ts`/`CiMatrix.ts` and their tests | Nothing. Targets were local-only; the web never had them. |
| Language servers | `lsp/` (`LspHost.ts`, `LspSession.ts`, `LanguageServers.ts`, `JsonRpc.ts`, `LspFixture.ts`), `routes/lsp.ts` + tests | 2,422 | plue's language server inside the workspace VM, relayed over the `/api/cloud-ws/repos/{o}/{r}/workspace/sessions/{id}/lsp` tunnel this origin already serves (`mainview/state/CloudLspClient.ts`). The `code.*` flows stayed; their door moved from `local.lsp` to `cloud.terminal`, the same tunnel the workspace terminal rides. |
| Local terminal | `Pty.ts`, `PtySpawn.ts`, `SessionMonitor.ts`, `routes/pty.ts` + tests | 2,173 | The workspace terminal relay into a plue VM (`/api/cloud-ws/repos/…/terminal`), which both hosts already tunnel. |
| Local repositories | `Repos.ts`, `RepoFiles.ts`, `LocalRepository.ts`, `RepositoryAuthority.ts`, `routes/tutorialRepository.ts`, `sanitizeRemoteUrl.ts` + tests | 1,283 | Cloud repositories as plue workspaces. A repository is a workspace, never a directory on this machine. |
| Harness detection | `Harnesses.ts`, `routes/harnesses.ts`, `routes/agents.ts` + tests | 230 | plue injects the credentials into the guest, so the app never probes for a CLI on the reader's box. |
| Sandbox | `Sandbox.ts` + test | 377 | Nothing to wrap. Two `Bun.spawn` calls survive: the keychain read in `CloudAuth.ts`, and, until the second pass below deleted it, the `git` reads in `routes/tutorial2-agent_change.ts`. The keychain read needs no seatbelt profile. |
| Session daemon | `LocalDaemon.ts`, `LocalDaemonProtocol.ts`, `LocalDaemonClient.ts`, `LocalDaemonLease.ts`, `LocalDaemonStop.ts` + test | 600 | Nothing. The daemon existed so long-running LOCAL work survived the window closing, and that work was targets, terminals and harnesses. Long-running work now lives in a plue workspace, which survives on its own. |

That is 13,072 lines of `apps/app/src/bun`, plus `Affected.ts`, `CiMatrix.ts`
and their three tests, whose line counts were not captured before they were
removed. Another ~5,000 lines of the renderer went with them: the target and
graph controllers, the target, graph, CI, affected, run-history and
run-timeline cards, the flows that were their only door, and the tests and
Playwright specs of all of it.

The daemon's one surviving job is single ownership of the chat turn journal's
SQLite file. `TurnJournalLease.ts` keeps exactly that: a pid file beside the
database, taken over when its owner is dead.

## One correction to the plan

Code intelligence was listed as local-only because the three `code.*` flows
declared `runtime: ["local.lsp"]`. That declaration was stale: the seam behind
them is dual-path and its cloud half is complete and wired
(`mainview/state/CloudLspClient.ts`, 815 lines, over the `/api/cloud-ws/…/lsp`
tunnel `apps/app/src/bun/server.ts` still serves). Deleting the flows would
have removed the only door to a working web feature, so they were kept and
re-doored on `cloud.terminal`. `CodeIntelSeam.ts`'s local branch and
`state/LspClient.ts` survive as unreachable code; see the follow-ups below.

## The capability rows that went

`packages/rpc/src/AppBootstrap.ts` no longer names `local.repositories`,
`local.repository-path-entry`, `local.targets`, `local.terminal`,
`local.harnesses` or `local.lsp`, and `localCapabilities` in
`packages/rpc/src/HostCapabilities.ts` emits only `agent`, `browser.read`,
`identity`, `cloud`, `cloud.terminal` and `cloud.pat` — the same rows the
Worker can emit. No host has a `local.*` door, so `registry.ts` `nativeOnly`
and `Commands.ts` `explainAbsent` have nothing left to refuse.

The native Electrobun RPC surface is down to one door, `openExternal`. The
folder picker (`pickLocalRepository`) is gone from
`packages/rpc/src/NativeRPC.ts`, from `mainview/native/NativeBridge.ts`, and
from the packaged E2E bridge.

`@smthrs/harness-detect` has lost its only consumer. The package is left in
place, unreferenced, for Will to decide on. It is the obvious table for the
cloud credential-injection path to read — plue decides which CLI to install
and configure inside a guest, and that decision is the same
harness-id-to-binary-and-model table — but nothing points at it today.

## The second pass

A follow-up cut (this commit) removed what the first one left behind because
it was inline, or because nothing pointed at it any more.

| Removed | Lines | Why it was dead |
| --- | --- | --- |
| `src/bun/server.ts`: the `/ws` topic bus (upgrade branch, subscribe/unsubscribe, `publish`, `onMessage`, the handler registry, the topic and subscription caps, `WsSocketData.topics`) | ~120 | Its only publishers were the local PTY, the target runs and the local language server. `/api/cloud-ws/` is unaffected; a bridge socket now carries only its bridge. |
| `src/bun/server.ts`: `chatStub`, `tutorialChangeHost`, `trailPath` | 20 | See below; `trailPath` had been the identity function since the lane paths went. |
| `src/bun/routes/tutorial2-agent_change.ts` + test | 125 | Nothing supplied `tutorialChangeHost`, so the route was never mounted and its three paths always answered 501. Its two `git -C` spawns were the last shell-outs outside the keychain read. |
| `src/bun/LocalHealthJournal.ts`, `JournalLines.ts`, `atomicWriteJson.ts`, `NativeOrigin.ts` + tests | 339 | Nothing in the repository imported any of the four. |
| `src/bun/routes.ts`: `notImplemented`, `:param` route support, `RouteContext.params`, the re-registration branch in `Router.add`, `LocalServer.router` | 35 | No route carries a parameter and no lane registers one: `startLocalServer` is the only caller of `add`. |
| `mainview/state/PtyClient.ts`, `LspClient.ts`, `TargetRunClient.ts`, `TopicSocket.ts` + tests | ~1,100 | The three clients spoke `/api/pty*`, `/api/lsp/*` and the target-run topics; `TopicSocket` was the `/ws` lifecycle all three shared. `TargetRunClient` was constructed and disposed by `AppController` and otherwise unreferenced. |
| `AppServices.socketUrl`, `AppController.pty` | — | The `/ws` URL and the PTY transport had no remaining consumer. `socketProtocols` stays: the cloud tunnels carry it. |
| `tabs/TerminalView.tsx`'s local branch | 20 | A terminal is a workspace terminal. A tab without one renders "no longer available" instead of dialing a PTY that cannot exist. |
| `seams/CodeIntelSeam.ts`'s local branch (`Prepared.kind`, the per-repository diagnostics subscription, digest reconciliation, `refused`) | 90 | `resolveFileTarget` can no longer answer `local`. `LspAnswer`/`LspRefusal` moved to `CloudLspClient.ts`, which is now their only definer. |
| `controller/connectors.ts` `reduceAccess` | 40 | `/api/repos`, `/api/repo/access` and `/api/repo/close` are gone. Narrowing or forgetting a connector is now a store act alone, so both doors are synchronous. |
| `flows/SearchQuery.ts` `OPEN_FLOWS.target` / `PRIMARY_FLOWS.target` | 2 | `target.open` and `target.run` are not registered flows any more. |

`ChatStub.ts` moved from `src/bun/` to `e2e/support/`, and `startLocalServer`
no longer reads `SMITHERS_CHAT_STUB` or imports a stub: it takes
`agent: (publish) => CloudAgent` and every test tier injects one
(`scripts/browser-test-host.ts`, `src/bun/server.test.ts`,
`src/bun/CloudWsTunnel.test.ts`). `serve.ts`, the real headless host, no longer
has a stub at all.

Two files still ship test scaffolding inside the bundle, and the evidence says
they have to:

- `src/bun/PackagedE2EBridge.ts` is the loopback bridge the packaged tier
  drives the **built binary** through (`e2e/packaged/PackagedApp.ts` spawns
  `.app` with `SMITHERS_E2E_BRIDGE=1`). Nothing can be injected into a process
  that is spawned, so the bridge has to be in the bundle. It stays inert
  without the env var and its token.
- The same is true of the stub: `e2e/packaged/packaged-app.e2e.test.ts`
  asserts `stub: <message>` in the packaged app's transcript, with
  `SMITHERS_CHAT_STUB=1` and `SMITHERS_LOCAL_MODE=offline`. `NativeApp.ts`
  therefore imports `e2e/support/ChatStub.ts` dynamically, behind that env
  var — the code lives with the tier that owns it even though the bundler
  follows it in.

One behaviour changed with the injection: `chatStub: true` also nulled the
identity upstream. Every host that used it is `SMITHERS_LOCAL_MODE=offline`,
where the identity upstream is null anyway, so only two tests that wanted a
cloud-only host had to say `identityUpstream: null` out loud.

## The third pass: the terminal and harness tabs (smithersai/smithers#2229)

The tabs the local PTY fed went last. Tabs are card tabs now (`tab.card`,
`tab.select`, `tab.close`); a terminal is the workspace card's Terminal facet
(`tabs/TerminalView.tsx`, embedded, never a tab).

| Removed | Why it was dead |
| --- | --- |
| `state/controller/tabs.ts` `openTerminalTab`, `openHarnessTab`, `readTab`, `toggleTabMenu`, the close question, `notePtyExit`, Cmd+T | posted `/api/pty` and read `/api/pty/:id/output`; no host serves either |
| `tab.read`, `tab.menu`, `tab.close.confirm`, `tab.close.cancel` | the flows over those seams and the `+` menu (`tabMenuOpen`, `pendingTabCloseId` session fields) |
| `TabSchema` terminal and harness rows; `pty.exited`, `pty.status.observed`, `tab.menu.toggled`, `tab.close.asked`, `harnesses.loaded`, `agents.loaded` transitions; the `harnesses` projection (`app-harnesses`) | persisted event kinds and rows: `APP_PROJECTOR_VERSION` 22 → 23 and `APP_SCHEMA_VERSION` 15 → 16. An older store's rows are validated against this build (a terminal or harness tab row fails `TabSchema` and is quarantined) and seed a fresh stream; boot reselects main. `tabs/tabs.migration.test.ts` opens such a store. |
| `AgentRoleMenu.ts`, the `harnesses` / `agents` form option providers, the orchestrator role section of the instructions, the harness lines of the opening and identity messages | read a harness inventory no host loads |
| `@smthrs/rpc/LocalApp` `PtySessionSchema`, `PtyCreateResponseSchema`, `PtyOutputResponseSchema`, `HarnessesResponseSchema`; `@smthrs/rpc/Health` `PtyStatusFrameSchema`; the process fields of `AgentRuntimeTabSchema` | the wire of the retired routes |
| `TabBodies.tsx` terminal bodies, breadcrumb and close dialog; `TerminalView` takes `repo` and `sessionId` | only card bodies remain |

Left in place: `HARNESS_IDS` and `HarnessSchema` (`@smthrs/harness-detect` and
`AgentRoles.ts` read them), the local `agent` card variant (conversations saved
before the cut still decode; the card renders as it did).

## The fourth pass: repository inventory (smithersai/smithers#2239)

The app now reads the backend repository inventory and workspace copies only.
The local inventory collection and event (`repos`, `repos.loaded`), the pins
(`pinnedRepos`, `repo.pinned`, `repo.unpinned`), the `local` working-copy kind
and `local:` selections, the local file transport, local form options,
admission bypass and prompt fallback are deleted, as is the
`@smthrs/rpc/LocalApp` repo-files route contract (`RepoSchema` stays for saved
`repo` cards). Saved local file cards
remain readable snapshots and offer no search action for the retired route.

Projector version 24 and schema version 17 seed a fresh event stream from
validated rows. Local inventory, pin and local working-copy rows fail their
schema and do not enter it; `app-repos` and `app-pinned-repos` are
cleanup-only keys, and local selections are cleared. Backend repository
selections, box selections and card tabs survive. The migration and reopen tests are in
`src/mainview/state/LocalReposRetirement.test.ts`.

## Follow-ups this cut did not take either

- `seams/SearchSeam.ts` still reads `targets` cards into `kind: "target"`
  search items. Those cards can only come from a conversation saved before the
  first cut, the same persistence class as the retired card schemas.
- `@smthrs/rpc/NativeFailureCodes` still carries the language-server route
  codes (`language_server_missing`, `language_server_failed`, `node_missing`)
  and `@smthrs/rpc/LocalApp` the PTY, repo and harness DTOs (the repo-files
  route contract left in the fourth pass). Shared package, separate change.
- `packages/rpc` keeps the card schemas for the retired kinds (`targets`,
  `graph`, `target-run`, `run-timeline`, `run-history`, `affected`,
  `ci-matrix`, `repo`) so a conversation saved before the cut still decodes.
  `cards/CardRenderers.tsx` renders them as empty. Dropping the schemas is a
  persistence migration, not part of this change.
- `@smthrs/harness-detect` is still unreferenced: nothing in the repository
  imports it (`apps/app/package.json` declares the dependency and
  `apps/app/PACKAGE.ts` keys the unit suite on its check target, which is all
  that is left). It is 100% covered and costs nothing where it sits.
