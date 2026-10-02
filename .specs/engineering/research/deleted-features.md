# Recently deleted features — restore candidates (2026-09-28..2026-10-02)

Method: `jj log -r 'committer_date(after:"2026-09-28") & ~merges()'` in smithers (3,258 non-merge commits) and plue (522), with per-commit `diff().stat()`; file-level diffs of the two atomic cuts; each path checked against `main` (c04637a6f7) with `jj file list`. Plue's own ledgers (`docs/internal/mvp-cuts-2026-10-01.md`, `mvp-cuts-round2-2026-10-01.md`) list before/after SHAs and agree with the SHAs below. Statements marked "inferred" are my reading, not verified by running code.

## Summary

1. Only two deletions matter for mvp.md: macOS packaging (`39e43c0fe4`, §6.1) and Pair (`2753d2e3d2`, M-17/§6.8). Everything else in the cuts is create-app, review service, non-GitHub integrations, Cloud desktop, forge fork/transfer, themes, marketplace; none serves mvp.md.
2. Most §6.14 / §6.15 / §6.8 items you listed were NOT deleted in the window and exist on `main`: DevTools/monitor (RunDevTools.tsx, devtools.go), triggers (TriggersCard, TriggersSeam), notifications seam/card, terminal multi-viewer (terminal_session_manager.go, terminal_ring_buffer.go), SSH keys/workspace SSH, secrets, workspace fork + children, wiki Yjs collaboration, AgentCards, `@smthrs/flow` sync `BranchPresence`/`BranchShare`. Their status is "Partial" because they were never finished, not because they were cut.
3. macOS build: REWRITE as an installer, REUSE the bundling stages. `apps/app/scripts/build-native.ts` (313 lines) assembled node, pnpm check, git, jj (cargo), smithers-ffi, model/coding hosts, Linux helper and bundled Postgres into `.native/`. Its helpers `bundle-postgres.ts`, `system-linkage.ts`, `validate-git-bundle.ts` still exist on `main`. The Electrobun window, `NativeRendererServer.ts` (local-origin proxy) and `DeepLink.ts` are not needed because the spec serves browsers over HTTPS.
4. Pair: REWRITE on the existing flows/sync primitives; do not restore. Pair was a forked-workspace session model (`SetPairSessionForkBound`, per-session invites/links, shared draft, elected prompt queue). M-17 wants one shared live branch workspace. Harvest only: member roles + revoke semantics, heartbeat/stale sweeper, queue claim-lease SQL.
5. The Pair schema was NOT dropped: `pair_sessions`, `pair_session_members`, `share_listings` remain in `0001_product_baseline.sql` (no drop migration in the cut), so a restore needs no migration.
6. Custom-agent screens (D-11) went out before the window (`0af014e2a7`, 2026-09-27, `AgentRoleMenu.ts`, 43 lines; `packages/rpc/src/AgentRoles.ts` and `cards/AgentCards.tsx` survive). Nothing to restore for M-23; build the Agent card on AgentCards + AgentRoles.
7. Experimental mock panes (Triggers, Notifications, Flows, Harnesses, Journal, Sandbox, Memory, 30+ panes; `cfe574edda`, 2026-09-27) are throwaway UI mocks. Useful only as layout references for the Advanced doors.
8. Access: closed-alpha allowlist/waitlist (`88d42515d2`, `alpha_access.sql`, `69a1bebe69`) is the nearest ancestor of the M-05 roster. Rewrite (roster + GitHub write check + roles); do not restore.
9. Plue deleted nothing the MVP needs: hosted-only items (Notion sync worker, desktop nix module and manifests, Hindsight, Local SSD pool, cutover machinery). Plue canary Pair probe was removed from the runner.
10. Riskiest restore is any `git`-path restore over the Go backend: compose/router/openapi wiring and generated sqlc/SDK files changed in the same commit.

## Restore candidates

| Feature | Repo | Commit(s) | Paths at parent | Serves mvp.md | Restore / rewrite / ignore | Why |
| --- | --- | --- | --- | --- | --- | --- |
| macOS install package (bundled runtime) | smithers | `39e43c0fe4` (parent `5b77095672`); component `8c3d1e7c02` (parent `2ad6fe2afc`) | `apps/app/scripts/build-native.ts` (313), `apps/app/electrobun.config.ts` (75), `apps/app/hutch.config.ts` (9), `apps/app/scripts/ensure-devkit.mjs` (70), `apps/app/scripts/run-packaged-*-mode-matrix.ts`, `apps/app/e2e/packaged/*` | §6.1 Install on a Mac, M-10, M-26, §12 | Rewrite, reusing build-native stages | Keeps: toolchain pin checks, jj cargo install, smithers-ffi, hosts build, packaged git/jj smoke tests, `bundlePostgres`. Drops: Electrobun `.app`, CEF matrix, native window. MVP needs a launchd-managed server, HTTPS, `smthrs connect`, in-place upgrade (none existed). Inferred: signing/notarization were not in this script. |
| Native renderer/origin proxy | smithers | `39e43c0fe4` | `apps/app/src/bun/NativeRendererServer.ts` (319), `NativeApp.ts` (368), `NativeShutdown.ts`, `NativeUrlOpen.ts`, `DeepLink.ts` | §6.1 only for ideas (cookie jar, WS tunnel pending-bytes cap 1 MiB, clean shutdown) | Ignore (reference) | Browsers reach the backend directly over HTTPS. `smithers://open` deep link is not in the spec. |
| Pair presence + shared workspace access | smithers | `2753d2e3d2` (parent `a73a77de36`) | `packages/backend/internal/services/pair_session.go` (1982), `routes/pair_sessions.go` (798), `pairauth/pairauth.go` (13), `db/product/queries/pair_sessions.sql` (498), `pair.sql` (39), `internal/db/pair*.sql.go`, `docs/api/openapi/pair-sessions.yaml` (1048), `docs/pair-sessions.md` | M-17, §6.8 Presence, §6.15 Roles/members | Rewrite; harvest 4 pieces | Fork-bound sessions, email/username invites, public join links, paid-plan policy and elected prompt queue contradict "one live branch" and "no invitations". Harvest: `UpdatePairSessionMemberPresence`, `FailStalePairSessions`, `SetPairSessionMemberRole`/`RevokePairSessionMember`, queue lease (`ClaimPairPrompt`, `RenewPairPromptLease`, `SweepStalePairPromptClaims`) for M-13 admission. `POST /api/pair-sessions/{id}/presence` is the presence endpoint. |
| Branch presence (already present) | smithers | none (retained) | `packages/smithers/flows/sync/src/BranchPresence.ts`, `BranchShare.ts`, `BranchProtocol.ts`, `BranchServer.ts`, `WorkspaceShare.ts` on `main` | M-17, §6.8 | Build on, no restore | Ephemeral lease-table presence with capability-scoped roster; fits Effect/flow architecture. Need a backend route and the Branch card avatars. |
| Pair queue/draft | smithers | `2753d2e3d2` | `pair_sessions.sql` queue + draft queries; `pair_session.go` enqueue/draft funcs | M-13, §6.7 queue (reference) | Ignore the draft; reference queue lease | Shared drafts are cut ("Carets and selections... Cut"). Queue is per-session, spec wants one install-wide admission queue. |
| Custom-agent screens | smithers | `0af014e2a7` (parent `b98222ccd5`, 2026-09-27); D-11 | `apps/app/src/mainview/AgentRoleMenu.ts` (43) + `.test.ts`; `state/TabRead.test.ts`, `controller/tabs.*.test.ts` | M-23, §6.14 Configure an agent | Ignore; build new Agent card | Deleted before the window and only a role menu. `AgentCards.tsx`, `packages/rpc/src/AgentRoles.ts` (role id, harness ids) stay. Edits are TODO-proposed config, a different model from the old menu. |
| Terminal and harness tabs | smithers | `0af014e2a7` | tab chrome + pty transitions (1,960 lines removed) | §6.8 Terminals | Ignore | `tabs/TerminalView.tsx`, `CloudTerminalClient.ts`, `terminal_session_manager.go`, `terminal_ring_buffer.go` remain and already multi-view (spec status "Partial: per-person homes, watch/type control missing"). |
| Edge terminal relay | smithers | `4ba39640a0` (parent `4032aeb311`) | `apps/server/src/terminalRelay.ts`, `jevRelay.ts`, `repositoryTriggers.ts` | none | Ignore | Cloudflare Worker edge code; hosted Cloud only. |
| Experimental panes (mocks) | smithers | `cfe574edda` (parent `f7872aed8e`) | `apps/app/src/mainview/experimental/panes/{Triggers,Notifications,Sandbox,Flows,Journal,Harnesses,TimeTravel,...}.tsx` | §6.14 visual reference | Ignore (reference only) | Mocks behind a flag, deleted as "every door to them"; the real cards exist. |
| Closed-alpha roster | smithers | `88d42515d2` (parent `ae54f760f4`), `69a1bebe69`, `fecb2551d1`, `8ff6644ae3` | `packages/backend/db/product/queries/alpha_access.sql`, `docs/api/openapi/alpha-access.yaml`, `smthrs beta whitelist add/list/remove`, app access gate | M-05 roster, §6.15 Members | Rewrite | Roster must carry role (Owner/Maintainer/Member), GitHub-username add, hourly write-access recheck, session termination. Tables dropped by `0100_drop_alpha_access_tables.sql`. |
| Cloud desktop (stream, relay) | smithers + plue | `8c3d1e7c02`; plue `2ea9767a62` | `packages/backend/internal/services/workspace_desktop*.go`, `routes/workspace_desktop*.go`, `apps/app/src/mainview/state/seams/DesktopStream.ts`; plue `nix/modules/desktop.nix`, `desktop/agent.py` | none | Ignore | Not in the spec; browser/terminal paths are separate and kept. |
| Fork (repository fork/transfer, changesets) | smithers | `6f3465e0e7` / `e35a907078` | `routes/repos_transfer_requests.go`, `services/repo_transfer*.go`, `routes/changesets.go`, `smthrs repo fork/transfer`, `changeset *` | none (§6.7 Fork is the workspace fork) | Ignore | Workspace fork service (`ForkWorkspace`, `workspace_children*`, tests `workspace_fork_*_test.go`) remains; only repo-level fork/transfer was cut. |
| User-facing time travel (`runs fork/rewind`, TUI fork) | smithers | `4d455c697d` | `apps/site/src/data/help/runs/{fork,rewind}.txt`, `packages/smithers/test/HistoryForkResumeCli.test.ts`, TUI estimates | §6.14 says replay read-only, "no fork or rewind" | Ignore | Matches spec. |
| Model laboratory cards | smithers | `4d455c697d` | `apps/app/src/mainview/cards/ModelCards.tsx`, `ModelCallCard.tsx`, `flows/entries/model.ts`, `controller/modelCall.ts` | M-23 "owner picks from install's model access" (weak) | Ignore | Spec wants an owner model-access setting, not the lab. |
| Browser/push notifications | smithers | `857f0d197b` | `packages/backend/internal/services/apns.go` (logging-only APNs stub) | §4/M-14 toasts | Ignore | Logged only; the real notifications card/seam/prefs SQL remain. Spec's Web Push is not built (inferred: no web-push code in either repo on main). |
| Integrations (Slack, Telegram, Gmail, X, Calendar, Linear, Notion sync) | both | `8bf8037b73`/`a00989b434`, `f3612d5e48`, plue `2ea9767a62` | `packages/smithers/agent/integrations/*` (89), `packages/backend/chatconnector/*`, `wiki_sync_notion.go`, plue `apps/notion-sync` | none (GitHub only) | Ignore | Spec is GitHub-only. |
| Review service | smithers | `39e43c0fe4`, `e749f65b9194` | `apps/review/*` moved to `flows/review/*` (rename, not loss) | §6.10 | Nothing to restore | Review runs as a flow now. |
| Burndown flow | smithers | `367758e954` | `flows/burndown/*` (22,922 lines) | §8 "Issue-sweep/burndown: cut" | Ignore | Re-homed as `packages/patterns` Burndown (`cb79039728`). |
| Marketplace, themes, Explainer, calendar/traction notes, OAuth app hosting, community nominations | smithers | `2753d2e3d2` | see mvp-cuts-round2 ledger table | none; blocked by #3402/#3403 | Ignore | Do-not-implement per AGENTS.md. |

## All deletion commits

Smithers has duplicated rewritten stacks (same change id, several commit ids, same stat); `39e43c0fe4` and `2753d2e3d2` are the atomic landings that supersede the component commits (`8c3d1e7c02`, `0448786fcd`, `e749f65b91`/`27dd03eadc`, `8bf8037b73`, `26897bf3bc`, `d570484f74`, `e35a907078`). Listed: commits with at least 150 removed lines or a 🔥. Stat is removed/added lines. Roughly 150 more small commits matched remove/delete/retire/drop keywords and are fixes or test pruning; none touch an mvp.md feature (list reproducible with the method above).

| repo | change id | commit | date | description | stat | MVP relevance |
| --- | --- | --- | --- | --- | --- | --- |
| smithers | sqrpxxqw | 2753d2e3d2 | 10-01 | refactor: integrate approved second MVP cuts (#3404) | -28824/+1761 | HIGH |
| smithers | nxnosypv | 3c8034340a | 10-01 | ✅ test(app): drop browser specs for features the MVP cut removed | -164/+7 | low |
| smithers | lwqkwpym | 7ef2c9400d | 10-01 | ✅ test(app): reconcile the unit and coverage suites with the MVP cut | -220/+78 | low |
| smithers | ppwwmlvz | 962ae7d453 | 10-01 | 🔥 style(app): drop CSS rules whose markup the MVP cut removed | -5/+0 | none |
| smithers | ykvmkqyn | 39e43c0fe4 | 10-01 | refactor: focus the MVP on repository maintenance (#3385) | -162741/+13645 | HIGH |
| smithers | xwxykqqo | 9eee9fd6ed | 10-01 | docs: record approved MVP cuts and protected product boundaries | -12955/+1607 | low |
| smithers | stywwvpl | a00989b434 | 10-01 | refactor: retire non-GitHub app and backend integrations (#3389) | -5278/+408 | low |
| smithers | urrvvyql | 4d455c697d | 10-01 | Retire client model laboratory, manual time travel and predictive estimates (#3387) | -10273/+197 | low |
| smithers | ltxsmnkm | 85c58059bd | 10-01 | refactor(integrations): retain GitHub adapters for MVP (#3389) | -32750/+1325 | low |
| smithers | vkoyzqqx | cbd18ea56d | 10-01 | Retire native application and Cloud desktop for the focused MVP (#3387) | -17661/+457 | HIGH |
| smithers | kqxzmzmv | ddfe477b1a | 10-01 | refactor(create-app): retire application scaffolding for MVP (#3386) | -44961/+111 | none |
| smithers | pkkkkpvw | 6f3465e0e7 | 10-01 | refactor(forge): retire public fork transfer and changeset doors (#3386) | -8988/+201 | low |
| smithers | porvromn | d570484f74 | 10-01 | refactor: retire non-GitHub app and backend integrations (#3389) | -5278/+408 | low |
| smithers | krnwzkln | 26897bf3bc | 10-01 | Retire client model laboratory, manual time travel and predictive estimates (#3387) | -10273/+197 | low |
| smithers | xryvtwxn | 8bf8037b73 | 10-01 | refactor(integrations): retain GitHub adapters for MVP (#3389) | -32750/+1325 | low |
| smithers | xyzzuksu | 8c3d1e7c02 | 10-01 | Retire native application and Cloud desktop for the focused MVP (#3387) | -17661/+457 | HIGH |
| smithers | mkpvwomo | 0448786fcd | 10-01 | refactor(create-app): retire application scaffolding for MVP (#3386) | -44961/+111 | none |
| smithers | unwvrwlo | 91eb60b716 | 10-01 | fix(app): preserve native landing after changeset retirement (#3386) | -383/+45 | none |
| smithers | yulvoqmz | e35a907078 | 10-01 | refactor(forge): remove public forks transfers and changeset product doors | -8606/+157 | low |
| smithers | mltzqlms | d0b23f3aa4 | 10-01 | 🔥 chore(factory): drop the landed journal-consensus queue spec (#2055) | -156/+7 | none |
| smithers | qkutkypx | 367758e954 | 09-30 | 🔥 refactor(flows): delete the burndown flow; skip the root .jj in package discovery | -22922/+75 | low |
| smithers | pxzrqslu | f3612d5e48 | 09-30 | 🔥 chore(backend): retire the Linear integration (#1819) | -16088/+1268 | low |
| smithers | lwmkxmvw | 5c3b24f932 | 09-30 | ♻️ refactor(create-app): route flows as canonical Flow.make declarations and drop defineFlo | -483/+530 | none |
| smithers | mnmvplrp | 575f05d2f6 | 09-30 | 🔒 fix(secrets): close review findings on workflow secret host bindings | -178/+240 | none |
| smithers | utxrxsqm | 4ba39640a0 | 09-30 | 🔥 feat(server): retire the shared-edge cutover scripts and evidence tooling | -29925/+305 | low |
| smithers | oyzxroqt | a904ccb9a5 | 09-30 | 🔥 feat(server): retire the canary's closed-alpha roster and the admin allowlist secret | -107/+64 | none |
| smithers | uqyoqykp | 69a1bebe69 | 09-30 | 🔥 feat(app): retire the closed-alpha access gate and its request queue | -1342/+440 | low |
| smithers | qrrsyqzt | fecb2551d1 | 09-30 | 🔥 feat(server): retire the closed-alpha allowlist gate; any signed-in user is admitted | -924/+276 | low |
| smithers | rtsmzyrs | c021ff600b | 09-30 | 🔥 chore(server): record the sibling Worker data disposition and drop the identity export tar | -309/+52 | none |
| smithers | xxuqtzpy | 81c5644ba6 | 09-30 | 🔥 chore(server): drop the retired identity, billing and chat Workers from CN-18 and delete C | -1719/+108 | none |
| smithers | rtsuxtzt | 090c6e5f1f | 09-30 | 🔧 chore(ci): remove the cache-publish job that publishes nothing | -176/+37 | none |
| smithers | wszsvyyw | d494b56dbc | 09-30 | 🔥 feat(errors): retire the closed-alpha failure codes (#2145) | -63/+28 | none |
| smithers | sonmkuon | 88d42515d2 | 09-30 | 🔥 feat(auth): retire the closed-alpha gate; signup is public (#2145) | -5947/+209 | low |
| smithers | kouknrpo | 8b2b8edbc1 | 09-29 | 🔥 chore(tui): remove the orphaned vendor harness entry | -243/+0 | none |
| smithers | tnvwquuq | e2fcc4d75f | 09-29 | 🔥 refactor(app): delete agent.change, whose /api/tutorial/change routes no host serves | -799/+170 | none |
| smithers | xrqxquzu | 30167a8986 | 09-29 | 🐛 fix(app): retire legacy auth session identity path (#2277) | -310/+314 | none |
| smithers | oqkmzyzk | ec2e290ba5 | 09-29 | 🔥 chore(site): drop unshipped S.Automation proposal (#2150) | -539/+0 | none |
| smithers | mvppqztq | fa0a5b8577 | 09-29 |  | -2189/+5117 | none |
| smithers | kwqnvtkv | e3bf78debb | 09-29 | 🔥 test(journal): delete the scratch repro test that landed with #2472 | -22/+0 | none |
| smithers | sxstnuyt | 857f0d197b | 09-28 | 🔥 refactor(backend): remove logging-only APNs approval push (#1823) | -323/+15 | low |
| smithers | lopsxxvn | 3b116deb19 | 09-28 | 🔥 refactor(workflows): delete the whole-workflow VM path of the sandbox scheduler (#1769) | -1980/+580 | none |
| plue | quxwoyrr | 820cc41038 | 10-01 | refactor: reconcile hosted probes and second MVP recovery records (#794) | -1443/+7943 | none |
| plue | lrtmxpup | 2ea9767a62 | 10-01 | refactor: retire deferred hosted adapters and record MVP recovery (#789) | -4111/+1448 | low |
| plue | szxwxkwt | 2d7fd47a5d | 10-01 | 🔒 fix(workspace): close guest file races, retire service launchers, guard SSH metrics, bind  | -293/+1185 | none |
| plue | tlwurwmy | 89f2d703e0 | 09-30 | 🔥 chore(secrets): retire the first-party Linear OAuth containers (#474) | -49/+46 | none |
| plue | nvuloskq | ecf0a90d30 | 09-30 | 🔥 feat(deploy): drop the closed-alpha admission gate from terraform, helm and deploy scripts | -297/+17 | none |
| plue | nqyuuywm | eadeb2e122 | 09-30 | 🔥 feat(admin): retire the closed-alpha commands and waitlist runbook | -452/+5 | none |
| plue | qkllwuls | 25effc29ce | 09-30 | 🔥 chore(release): delete every image producer but Cloud Build (#362) | -1390/+54 | none |
| plue | oqlmvzpl | 795a1f1994 | 09-29 | 👷 ci(release): gate on Smithers Cloud CI and retire the GitHub CI job (#404) | -343/+150 | none |
| plue | zqwluvlt | 1e87956969 | 09-29 | 🔥 chore(infra): finish the Hindsight retirement after its data export (#683) | -217/+62 | none |
| plue | sxuxtsmk | 1a646669b1 | 09-29 | 🔥 chore(infra): retire the Local SSD sandbox pool (#717) | -31/+109 | none |
| plue | kksxvopm | 58111a97d0 | 09-29 | 🧹 refactor(deploy): remove remaining cutover gates and helpers | -667/+153 | none |
| plue | wvxlnlps | 94a82ca836 | 09-29 | 🗑️ chore(deploy): delete rehearsal and staged cutover machinery | -4477/+68 | none |
| plue | wpuxkzkx | 69b5d686f2 | 09-28 | 🔥 chore(flows): delete the stale vendored coding flow bundles | -184/+50 | none |
| plue | tosynuup | bcf82e4a8d | 09-28 | 🔥 chore(infra): retire Hindsight and keep its database for export (#683) | -3756/+379 | none |
| plue | spotpqwu | d22971199d | 09-28 | ci: delete the Terraform apply job and the always-red GitHub canary workflow | -218/+78 | none |
| plue | qqmvwkzv | 67f88fa38a | 09-28 | refactor(infra): harden the Standard cluster and delete Autopilot and Electric dead code | -3196/+710 | none |
| smithers | pnxoxtnk | 0af014e2a7 | 09-27 | 🔥 refactor(app): retire the terminal and harness tabs, the + menu and the pty transitions (before window, context) | -1960/+387 | low (AgentRoleMenu) |
| smithers | yorysxvr | cfe574edda | 09-27 | 🔥 refactor(app,rpc): delete the experimental mocks, their flag and every door to them (before window, context) | -9670 | low (mock reference) |
| smithers | sktqrnwy | de7f36a9f9 | 09-27 | 🔥 refactor(backend): delete the box gateway (before window, context) | -4274 | none |
| smithers | twolknzl | b8c34f950f | 09-25 | refactor(backend)!: delete the retired runner coordination surface (before window, context) | -4947 | low (admission reference) |
| smithers | wnskkzyx | 72bb02cf6d | 09-24 | 🔥 chore(backend): drop the unmounted Pair route and dead auth seams (before window, context) | -4866 | low (earlier Pair removal; Pair came back in a later lineage, inferred) |

## Recovery recipes

All read-only; `--ignore-working-copy` avoids snapshot lock contention with other agents (a plain `jj file show` hit `.git/index.lock` once). Restore into a worktree-free working copy only after Will's go-ahead for Pair paths (#3401 is do-not-implement; M-17 supersedes it only for the parts named in the spec).

```sh
# macOS build (parent of 39e43c0fe4 is 5b77095672)
cd ~/smithers
jj --ignore-working-copy file show -r 5b77095672 apps/app/scripts/build-native.ts > /tmp/build-native.ts
jj --ignore-working-copy file list -r 5b77095672 apps/app/scripts apps/app/src/bun apps/app/e2e/packaged
jj diff -r 39e43c0fe4 --summary | grep -E 'apps/app/(scripts|src/bun|e2e)'   # exact deleted set
# keep on main already: scripts/bundle-postgres.ts, system-linkage.ts, validate-git-bundle.ts

# Pair (parent of 2753d2e3d2 is a73a77de36)
for f in packages/backend/internal/services/pair_session.go \
         packages/backend/internal/routes/pair_sessions.go \
         packages/backend/internal/pairauth/pairauth.go \
         packages/backend/db/product/queries/pair_sessions.sql \
         packages/backend/db/product/queries/pair.sql \
         docs/api/openapi/pair-sessions.yaml; do
  jj --ignore-working-copy file show -r a73a77de36 $f > ~/pair-ref/$(basename $f); done
jj restore --from a73a77de36 packages/backend/internal/services/pair_session.go   # only if a straight restore is chosen
# the queries need `sqlc generate`; compose/router.go wiring is in the M part of 2753d2e3d2:
jj diff -r 2753d2e3d2 -- packages/backend/internal/compose/router.go packages/backend/internal/compose/main.go

# Custom-agent role menu (parent of 0af014e2a7 is b98222ccd5)
jj --ignore-working-copy file show -r b98222ccd5 apps/app/src/mainview/AgentRoleMenu.ts

# Experimental pane mocks (parent f7872aed8e)
jj --ignore-working-copy file show -r f7872aed8e apps/app/src/mainview/experimental/panes/Triggers.tsx

# Alpha roster (parent ae54f760f4)
jj --ignore-working-copy file show -r ae54f760f4 packages/backend/db/product/queries/alpha_access.sql

# Plue records
cd ~/plue && jj --ignore-working-copy file show -r 820cc41038 docs/internal/mvp-cuts-round2-2026-10-01.md
```

## Risks

- **Pair compose wiring.** `2753d2e3d2` also edited `compose/main.go`, `router.go`, ~20 compose tests, `runtime_helpers.go`, `oauth2.sql`, `workspace.sql`, `app_timelines.sql` (generated `internal/db/*.sql.go` changed). A file-level restore will not compile without redoing those hunks and regenerating sqlc.
- **API baseline.** The generated SDK dropped exactly 38 operations (28 Pair, 6 marketplace, 4 OAuth apps) and plue pins the backend module at `v1.0.0-rc.0.0.20261002060207-2753d2e3d24e`; Observe embeds OpenAPI generated from it. Restoring Pair routes means a new backend pin and a plue Observe regeneration (inferred from the ledger).
- **Pair semantics.** `workspace_fork_pair_test.go` (still on main) states the Pair workspace was a fork of the source (`IsFork`). A restored Pair would give each pair a separate workspace, which conflicts with M-17 "one live branch". `pairauth` and branch locks conflict with "Branch locks removed".
- **Security fixes landed after Pair was written.** 09-29/09-30: `dcf02f3e63` (authorize every Pair mutation under the session lock), `1a9333f2fd` (recheck waiting submissions after access change), `79dd776792` (heartbeat racing session end), `5e640ff199` (malformed presence cursors). They are in the parent `a73a77de36`, so restoring from the parent keeps them, but restoring from older revisions loses them.
- **Cloud-account coupling.** Pair authorized by account/plan (paid-plan policy); M-09 removes plans and M-17 needs GitHub-roster membership. Any restore must replace the authorization layer.
- **macOS build.** `build-native.ts` pins Node 26.4+, a jj git revision `47589ada70`, Rust via `rustup`, and builds with `SMITHERS_BUILD_SHA`; it also packaged `smithers-ffi` and a Linux guest helper. The `.native/` layout (bin, libexec, share, postgres, licenses) is what `NativeApp.ts` expected; a launchd/HTTPS install needs a different consumer. The 39e43c0fe4 also removed `packages/rpc/src/NativeRPC.ts`, `AppLinks.ts` and `mainview/native/*`, so the web bundle no longer has a native bridge (good for the browser-served design).
- **Docs gate.** Smithers docs are generated; restoring paths that had docs (`pair-sessions.md`, `docs/api/openapi/*.yaml`) requires `pnpm docs:sync`, `pnpm docs:check`, `smthrs docs //<dir>:docs`.
- **Uncommitted tree.** The smithers working copy has many added `.specs/` files; `jj restore` into it would mix with them. Restore in a separate jj workspace per AGENTS.md rules (inferred from the instruction that main checkout stays on main).
