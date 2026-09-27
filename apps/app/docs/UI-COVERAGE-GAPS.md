# UI coverage gaps (2026-09-02)

> Partly superseded 2026-09-27 (smithersai/smithers#2239): the local repository inventory (`repos.loaded`), pins (`repo.pinned`, `repo.unpinned`, `repo.unpin`), `repo.open`, `local:` working copies and `POST /api/repo/files` are gone. Working copies are boxes and shared copies.

Sweep of every user-facing capability in plue (205 rows) and the Smithers engine/CLI (175 rows) against the app's built UI (38 card kinds, 145 flows) and designed UI (115 surfaces in WORKBENCH-UX and ADR 0001–0005). 92 capabilities are covered; 88 have no UI or partial UI. Method: three inventory agents, one synthesis, one completeness critic (adds and corrections merged). Laws applied: EMBED LAW, NO INVENTION, every act is a flow.

Priority: P0 blocks the workbench or a daily task; P1 next; P2 later. Effort S/M/L. Coverage none/partial.

## P0 (7)

### approvals · Approvals inbox across runs (approvals projection without runId, MCP approvals_list, `ps --status waiting-approval`; plue GET /approvals)

- Source: both · coverage: none · effort: S
- Exists: Approval cards appear only for runs the pump is watching (apps/app/src/mainview/state/controller/workflow-pump.ts:199-205; gateway.approvals always passes runId at gateway.ts:165-167).
- UI: New `approvals-inbox` card: rows run · flow · question · age; each row carries its ApprovalPayload and its Approve/Deny invoke the existing approval.approve/approval.deny by row id; no sidebar badge; the pending count is the card header's mono line and system.recommend suggests approvals.list when it is non-zero.
- Flows: `approvals.list [owner/repo]; approvals.open <runId>; approval.approve <cardId|approvalId> [scope]; approval.deny <cardId|approvalId>`

### runs · Run inbox: list runs with status/flow/lineage filters, active-run count, per-workflow runs (`smithers ps`, Control List runs, `workspace-runs` projection; plue GET /runs, /workflow-runs/active-count)

- Source: both · coverage: none · effort: M
- Exists: One flow-run card per run the user launched (packages/rpc/src/Cards.ts:286). The relay allowlists only List flows; no `List runs` and no `workspace-runs` selector (packages/backend/internal/compose/browser_flow.go browserFlowProcedures; apps/app/src/mainview/state/controller/gateway.ts:99-112).
- UI: New `run-list` card: header repo and one mono count line by status; rows runId · flow · status · waiting reason · age · turns/calls; a row opens the flow-run card; filter chips re-invoke runs.list with the chip's argument. No sidebar badge (NO INVENTION forbids status badges outside the card); the non-terminal count is the card header's mono line and system.recommend suggests runs.list when it is non-zero.
- Flows: `runs.list [status] [flow] [by=<principal>] [lineage=<id>] [owner/repo]; runs.open <runId>`

### runs · Resume a parked run and rerun a finished one (Control Resume, `smithers run --resume`; plue run resume/rerun)

- Source: both · coverage: none · effort: S
- Exists: flow.run.retry only re-polls the watch (apps/app/src/mainview/flows/Flows.ts:521-529). Resume is not in the relay allowlist (packages/backend/internal/compose/browser_flow.go browserFlowProcedures).
- UI: flow-run card footer gains Resume when the run is parked and not on an approval, and Run again (same input, new run card) when terminal; both add Resume to the relay allowlist.
- Flows: `runs.resume <runId>; runs.rerun <runId>`

### runs · Steer a running agent: operator message, seat change, thinking level, add tools (Control Steer Message|Seat|Thinking|Tools; `smithers steer`)

- Source: smithers · coverage: none · effort: M
- Exists: Nothing. Steer is absent from the relay (packages/backend/internal/compose/browser_flow.go browserFlowProcedures) and RunSummary.steering.pending is not read (apps/app/src/mainview/state/controller/workflow-pump.ts).
- UI: flow-run card gains a steer composer row under the steps plus a mono strip `seat ▾ · thinking ▾ · tools ▾`; a queued steer reads `steering pending · delivered at the next turn` until control.steer.delivered.
- Flows: `runs.steer <runId> <message>; runs.seat <runId> <provider:model>; runs.thinking <runId> <none|minimal|low|medium|high|xhigh>; runs.tools <runId> <tool,...>`

### runs · Cancel a run while it is running, with a reason, and cancel every non-terminal run (`smithers cancel`, `smithers down`; plue run cancel)

- Source: both · coverage: partial · effort: S
- Exists: flow.run.stop does cancel durably (apps/app/src/mainview/state/controller/workflow-pump.ts:287-303) but the Stop button renders only in phase `quiet` (apps/app/src/mainview/ChatCards.tsx:455-470); no cancel-all; reason fixed to 'the human stopped it'.
- UI: Stop (confirm) on every non-terminal phase of the flow-run card with an optional reason line, bound to the existing flow.run.stop (it already cancels durably) instead of a second `runs.cancel` name for the same act (Flows law: one name per act); run-list footer `Stop all N` (confirm).
- Flows: `flow.run.stop <cardId> [reason] (confirm; agent-invocable); flow.run.stop-all [owner/repo] (confirm)`

### runs · Transcript and event stream of a run (`smithers logs [--follow]`, `transcript` and `run-events` projections, MCP get_chat_transcript; plue run log SSE)

- Source: both · coverage: none · effort: M
- Exists: flow-run card keeps a tail of step lines like `3 turns · 12 calls` (apps/app/src/mainview/state/controller/workflow-pump.ts:95-103); transcript/run-events selectors are never requested.
- UI: flow-run card gains a Transcript facet (rows turn · at · kind · text, follow toggle, maximize for the full log) and an Events facet that shows raw ControlEvent JSON when debug.verbose is on.
- Flows: `runs.logs <runId> [--follow]; runs.events <runId>`

### runs · Waiting reasons other than approval: quota park with resetAt, durable timer (wait flow), event/signal wait, released, plugin, and `accepted` with nothing driving it

- Source: smithers · coverage: none · effort: S
- Exists: The pump reads waitingReason only to detect approval (apps/app/src/mainview/state/controller/workflow-pump.ts:199); phase words cover launching/running/waiting-approval/quiet only (packages/rpc/src/Cards.ts:286).
- UI: flow-run phase line names the reason and the unblock act: `waiting · provider quota · resumes 12:40`, `waiting · timer · 14 min`, `waiting · signal deploy-done` (Signal button), `accepted · nothing is driving it` (Resume button).
- Flows: `none new; reuses runs.resume, runs.signal, approval.*`

## P1 (40)

### agent environment · Edit the agent environment setup script and per-secret egress bindings (PUT /agent-environment)

- Source: plue · coverage: partial · effort: S
- Exists: env card shows setupScript read-only (packages/rpc/src/Cards.ts:459); ADR 0002 L23-24 designs hosts/match_headers bindings without an editing surface.
- UI: env card Setup row opens the script in the code editor with Save; each secret row gains egress bindings `host · header match` with Add/Remove.
- Flows: `env.setup.edit [owner/repo]; env.egress.bind <NAME> <host> [header=]; env.egress.unbind <NAME> <host>`

### agent setup · Register the Smithers MCP server in Claude Code / Codex (`smithers mcp add`); plue MCP integrations catalog

- Source: both · coverage: none · effort: S
- Exists: Nothing; agent tabs launch harnesses (packages/rpc/src/Cards.ts:629) without registering Smithers in them.
- UI: Connectors surface gains rows `Claude Code` and `Codex` with the state word `MCP registered` and one act Install bound to agents.install, which runs mcp add; catalog rows from /api/integrations/mcp carry Add bound to catalog.mcp.add (every act is a flow).
- Flows: `agents.install [claude|codex]; agents.mcp.add [claude|codex]; catalog.mcp; catalog.mcp.add <id>`

### agent setup · Project MCP servers into a run's flow catalog (`--mcp-config <path>`, SMITHERS_MCP_CONFIG; a malformed file is a usage error)

- Source: smithers · coverage: partial · effort: S
- Exists: The MCP registration row adds Smithers to Claude Code/Codex (the reverse direction) and lists a catalog with an unbound Add; nothing declares which MCP servers a run's agent may call.
- UI: env card gains an MCP servers section: rows name · command or url · flows exposed with Remove (confirm); footer Add; the flow-plan envelope `flows` row lists them; a malformed config renders the usage error verbatim.
- Flows: `mcp.servers [owner/repo|local]; mcp.server.add <name> <command|url>; mcp.server.remove <name> (confirm)`

### agents · Cloud agent sessions: create, list, get, delete, messages, SSE stream (`smithers agent session|chat`)

- Source: plue · coverage: none · effort: M
- Exists: the local agent card variant (packages/rpc/src/Cards.ts:629) survives only in conversations saved before the harness tabs retired (#2229); workspace provenance names an `agent session` (ADR 0003 L20-47) with nothing to open.
- UI: No new card kind (an `agent-session` card duplicates the `agent` card: harnessId, task, sessionId, phase, exitCode): the agent card gains a cloud variant carrying workspaceId instead of cwd and an SSE transcript instead of a PTY tab, as the Terminal facet swaps PTY for WebSocket-to-SSH (WORKBENCH-UX L156-158); header session · workspace · harness · state; transcript rows; the app composer addresses the active session (no second composer in the card); footer Stop (confirm); listed as rows in the workspace card.
- Flows: `agent.session.new <workspaceId> <task>; agent.session.list; agent.session.view <id>; agent.session.say <id> <text>; agent.session.stop <id> (confirm)`

### agents / seats · Per-run budget (tokens, latency) from the envelope, provider key add, seat resolution state (anthropic/openai/openrouter/cerebras), ChatGPT-subscription mode for openai seats (SMITHERS_OPENAI_AUTH=chatgpt)

- Source: both · coverage: partial · effort: S
- Exists: Accounts card (`provider-accounts`): Claude (setup token or API key) and Codex (device sign-in) accounts per provider in pool order, with state, limited-until, reconnect, move and revoke (`secrets.connections`, `secrets.connect`, `secrets.connect.codex`, `secrets.move`, `secrets.revoke`). Balance card is USD (Cards.ts:149); no budget.
- UI: flow-plan budget row is editable before Run and the flow-run facts strip reads `tokens used / budget`.
- Flows: `flow.plan --budget <tokens>`

### approvals · Approval scope once|run|remembered and remembered bulk grants (Control Approve scope, installBulkGrant)

- Source: smithers · coverage: partial · effort: S
- Exists: approval card decides approve/deny with a fixed scope (packages/rpc/src/Cards.ts:108; Flows.ts:596-617). There is no grant store: the in-page chain policy that held session grants was deleted on 2026-09-18, so a scope control needs the host-injected GrantStore first.
- UI: approval card gains a segmented control `this time · this run · remember` beside Approve; a `grants` card lists remembered grants (capability · flow · granted at) with Revoke.
- Flows: `approval.approve <cardId> [once|run|remembered]; grants.list; grants.revoke <id>`

### billing · Usage and quotas: compute hours, suspended storage, previews, concurrent workspaces, sandbox-hours, run concurrency, connected-repo quota, API rate limits; org billing

- Source: plue · coverage: partial · effort: S
- Exists: balance card shows USD and a low/empty state (packages/rpc/src/Cards.ts:149); flow-run has a `no-capacity` phase; billing.upgrade/portal exist (Flows.ts:1475-1485).
- UI: balance card gains a Usage facet: rows compute hours · storage · previews · workspaces N of M · runs N of 5 · repos N of 10 with reset times, and an org switch.
- Flows: `billing.usage [org]; billing.org <org>`

### bookmarks/changes · Create and delete bookmarks

- Source: plue · coverage: partial · effort: S
- Exists: branches card lists name/head only (packages/rpc/src/Cards.ts:481; Flows.ts:973).
- UI: branches card footer New bookmark (name · from change ▾) and per-row Delete (confirm) plus Open workspace (box.open <bookmark>).
- Flows: `branches.create <name> [from]; branches.delete <name> (confirm)`

### bookmarks/changes · Working-copy status (remote /status and local jj status)

- Source: plue · coverage: partial · effort: S
- Exists: Composer origin chip and tree `N ahead` designed (ADR 0001 L20-21, L39-44); no status card.
- UI: No new card (a `workspace-status` card duplicates the designed change card): change.status renders the change card (ADR 0003) for the working-copy change `@`: header change id · bookmark · `working copy`; Diff facet lists modified/added/deleted paths with Open diff; the conflict line carries the count; footer already offers New change and Describe (change.new, change.describe); the composer origin chip keeps the drift line.
- Flows: `change.status [repo|workspace] (renders change.view @)`

### bookmarks/changes · File drafts: live-synced edit buffers, discard, commit to a jj change

- Source: plue · coverage: partial · effort: M
- Exists: Files facet with the markdown editor designed (WORKBENCH-UX L160-163); no draft state or commit act.
- UI: file card editor footer gains `Commit to change ▾` (current or new) and Discard (confirm); one mono meta line `draft · saved 2m ago` / `committed as <id>` (Copy law: mono meta rows, no pills); drafts list as rows in the working-copy change card's Diff facet, not in a separate status card.
- Flows: `files.write <path> [repo|workspace]; files.commit <path> [changeId] [message]; files.discard <path> (confirm)`

### changesets · Create a cross-repo changeset (members, parent stacking, validation) and materialize it in a workspace (changeset_id)

- Source: plue · coverage: partial · effort: M
- Exists: change card changeset rendering, Land, Retry and Split ready members designed (ADR 0003 L122-129); no creation or materialization act.
- UI: stack card footer `New changeset` opens rows to pick member changes across org repos (ADR 0001 tree picker) with parent ▾ and validation errors verbatim; box.open gains --changeset.
- Flows: `changeset.create <change...> [--parent <id>]; changeset.list <org>; box.open --changeset <id>`

### control plane targets · Run flows against a local checkout's control plane or an arbitrary remote gateway (`--remote`/`--credential`, `smithers serve`, read-only Sync follower)

- Source: smithers · coverage: partial · effort: M
- Exists: The app relays only to the per-repo Smithers Cloud workspace gateway (packages/backend/internal/compose/browser_flow.go); local.targets runs build targets locally, not flows.
- UI: Connectors surface gains rows `Local Smithers control plane` (root · .flows state · serve state; one act Serve or Stop) and `Remote gateway` (URL · token in keychain · `follow-only` as a state word derived from the connection, chosen at connect, not a toggle without a flow); flow.run target grammar gains `local` and a gateway name.
- Flows: `gateway.connect <url> [--follow]; gateway.disconnect <name> (confirm); gateway.serve [--port]; gateway.serve.stop (confirm); flow.run <name> local|<gateway>`

### control plane targets · Per-repo workspace gateway state and wake (POST /api/repos/{owner}/{repo}/gateway provision/resume; gateway-token relay)

- Source: plue · coverage: partial · effort: S
- Exists: flow-run phases `reconnecting` and `no-capacity` (packages/rpc/src/Cards.ts:286) are the only trace; the relay targets the gateway blindly (packages/backend/internal/compose/browser_flow.go); the control-plane targets row covers remote and local gateways, not the per-repo cloud one.
- UI: Connectors surface `cloud` row (ADR 0005 L128-133) reads `gateway · running · <version>` or `gateway · cold` from GET /health; the run-list header repeats the word; a cold gateway's one act is Wake.
- Flows: `gateway.status [owner/repo]; gateway.wake [owner/repo]`

### diagnostics · Doctor: registry discovery warnings, .flows state, control.db/engine.db migration ladder, Node version, jj on PATH, provider keys, unsupported backend, 0.x state

- Source: smithers · coverage: partial · effort: S
- Exists: debug.seams (ADMIN) probes seams (Flows.ts:1555); keys card shows keys; nothing project-level for a user session.
- UI: `doctor` card: one row per check with ok/warn/fail glyph and the fix as a button (Add key → keys card, Install jj → browser card, Migrate 0.x → migration card); offered on connect and on any launch failure.
- Flows: `doctor [owner/repo|local]`

### identity · SSH key management (list, add, delete) for git-over-SSH and workspace SSH

- Source: plue · coverage: none · effort: S
- Exists: Nothing.
- UI: New `account` card with a Keys facet: rows title · fingerprint · added with Delete (confirm); footer Add key reads a local ~/.ssh/*.pub via the local runtime or a pasted key.
- Flows: `account.ssh-keys; account.ssh-key.add [path]; account.ssh-key.remove <id> (confirm)`

### issues · Issue labels add/remove, repository labels CRUD, milestones, assignees

- Source: plue · coverage: partial · effort: S
- Exists: issue card shows labels read-only and has no assignees (packages/rpc/src/Cards.ts:378).
- UI: issue card header gains editable chips labels ▾ (with Create), assignees ▾ (members and agents), milestone ▾; issue-list filters by label/assignee/milestone are arguments of issues.list (an act needs a flow), not filter controls without one.
- Flows: `issues.list [open|closed|all] [label=] [assignee=] [milestone=] [owner/repo]; issues.label <n> <+label|-label>; issues.assign <n> <login>; issues.milestone <n> <name>; labels.list; labels.create <name> <color>; labels.delete <name> (confirm); milestones.list; milestones.create <name>`

### landing review · Stacked PRs against GitHub: submit, unsubmit, sync, land, status; active stack upsert

- Source: plue · coverage: none · effort: M
- Exists: stack card designed for Smithers Cloud-native stacks only (ADR 0003 §2).
- UI: stack card footer gains `Submit to GitHub` (confirm) when the repo has a GitHub mirror; rows carry the PR number and GitHub CI glyph; Sync and Unsubmit actions.
- Flows: `stack.submit [bookmark]; stack.sync; stack.unsubmit (confirm); stack.status; stack.land (confirm)`

### memory · Durable memory: facts with namespaces flow|agent|user|global and tags, threads, notes with status/supersede, FTS and semantic recall, remember/recall flows, ttl/compaction; plue Hindsight recall/retain/reflect/primers/browse/curate

- Source: both · coverage: partial · effort: M
- Exists: the Wiki card (kind `world`) lists documents path/title/confidence with wiki.new-note/select/delete (packages/rpc/src/Cards.ts:252; flows/entries/wiki.ts; the world.* names are hidden aliases in flows/entries/world.ts); no facts, namespaces, recall query or curation.
- UI: the Wiki card gains namespace chips (each re-invokes memory.list) and three facets: Facts (rows key · value · tags · source with Edit/Forget), Threads (rows thread · messages · last at; a row opens transcript-style rows; Compact (confirm), Delete (confirm)), Recall (query row → ranked rows with confidence and provenance); notes carry the state word active|superseded as a mono meta row, not a pill; ttl/compaction is `Clean up` (confirm) with dry-run counts like runs.gc; Reflect and Curate are agent acts that render their result rows.
- Flows: `memory.list [namespace] [prefix]; memory.get <key>; memory.set <key> <value>; memory.rm <key>; memory.threads [namespace]; memory.thread <id>; memory.thread.compact <id> (confirm); memory.thread.delete <id> (confirm); memory.recall <query> [banks]; memory.gc [--dry-run] (confirm); memory.reflect [scope]; memory.curate [scope]`

### repositories · Repository collaborators with per-repo access grants

- Source: plue · coverage: none · effort: S
- Exists: Nothing.
- UI: repo card gains an Access facet: rows login or team · permission ▾ · Remove; footer Invite.
- Flows: `repo.access [owner/repo]; repo.access.add <login|team> <read|write|admin>; repo.access.remove <login|team> (confirm)`

### repositories · Create a repository (user- or org-owned, from template)

- Source: plue · coverage: none · effort: S
- Exists: repos.import imports from GitHub (Flows.ts:790); repo.open opens a local checkout (Flows.ts:1180).
- UI: No new sidebar control (ADR 0001 names one tree and no `+`): repo.create invoked from the composer (the `+` menu retired, #2229) renders a `repo-new` card with owner ▾ · name · visibility · template ▾ and Create; done adds the tree row and offers box.open.
- Flows: `repo.create <name> [owner] [--private] [--template owner/repo]`

### repositories · Connect a local jj repo to Smithers Cloud: license check, GitHub App wait, connection file, auto-push jj hook, disconnect, status, 10-repo quota; repository sync from source

- Source: plue · coverage: partial · effort: M
- Exists: connector.add connects a local repo to the app only (Flows.ts:618); ADR 0005 L128-133 names a `cloud` connectors row with no anatomy.
- UI: connector-setup card kind cloud: steps Pick checkout → GitHub App (reuses kind github) → Install auto-push hook (shows the hook line, toggle); connected state `cloud · owner/repo · auto-push on · last push N ago · 3 of 10 repos`; Sync now and Disconnect (confirm).
- Flows: `cloud.connect [path]; cloud.status; cloud.sync [owner/repo]; cloud.disconnect <repo> (confirm)`

### repositories · Protected bookmarks: required reviews, approvals, checks, push restrictions; direct-push rejection

- Source: plue · coverage: none · effort: S
- Exists: Nothing; the change card Land button names a blocking check (ADR 0003 L68-74) but no rule surface exists.
- UI: repo card gains a Protection facet: rows bookmark glob · required approvals · required checks · push restricted to; Add rule / Edit / Remove (confirm); `managed by .smithers/protected-bookmarks.yml` when declared.
- Flows: `repo.protections [owner/repo]; repo.protect <bookmark> [reviews=] [checks=] [push=]; repo.protect.remove <bookmark> (confirm)`

### runs · Deliver a named durable signal to a run parked on WaitFor (Control Signal, `smithers signal`; NoMatchingWait)

- Source: smithers · coverage: none · effort: S
- Exists: Nothing; Signal is not relayed (packages/backend/internal/compose/browser_flow.go browserFlowProcedures).
- UI: When waitingReason is `event` the flow-run card shows `waiting for signal <name>` with a Signal button that opens one JSON payload row; a NoMatchingWait error renders verbatim under it.
- Flows: `runs.signal <runId> <name> [json]`

### runs · Plan preview before launch: PlanCard envelope (capabilities, callable flows, token/latency budget, host/deploy class), per-node cached|run, digest; plan-level deny (`smithers plan`, Control Plan/Deny)

- Source: smithers · coverage: none · effort: M
- Exists: launch plans, approves scope `run`, and runs in one motion with no card between (apps/app/src/mainview/state/controller/gateway.ts:120-150); the `plan` card is a chat checklist (packages/rpc/src/Cards.ts:103).
- UI: No new card: the existing approval card (packages/rpc/src/Cards.ts:108, with decision approved/denied, decidedAt, pending, error) gains a target `Plan` variant whose detail rows are the PlanCard envelope (capabilities, callable flows, budget, host/deploy class), digest, and node rows with a cached|run glyph; Approve launches and Deny is the plan-level deny, both through approval.approve/approval.deny (user-only, like every approval). flow.plan renders it; flow.run invoked by the agent renders it and waits when the envelope exceeds what the host granted.
- Flows: `flow.plan <name> [key=value...] [owner/repo]; approval.approve <cardId> [once|run|remembered]; approval.deny <cardId>`

### runs · Run diagnosis facts: verdict, seat, elapsed, tokens, calls/failed, edits, refusals, cause, cancellation attribution, unblock and next act (`smithers status|why`, run-summary projection, Cancellation projection; plue compact status)

- Source: both · coverage: partial · effort: S
- Exists: flow-run shows the verdict as `result` and step lines with turns/calls (apps/app/src/mainview/state/controller/workflow-pump.ts:95-103,214-222); seat, tokens, edits, cancellation and cause are dropped.
- UI: flow-run card gains a mono facts strip `seat · elapsed · tokens · calls (failed) · edits` and a `why` row with the cause sentence and the unblock act as its button; cancelled runs read `cancelled by <who> · <reason> · cascaded from r_…`.
- Flows: `runs.status <runId>; runs.why <runId>`

### runs · Run tree and lineage: agent cell calls (`run-tree` projection), parent/child/fork/continuation origin, lineage filters

- Source: smithers · coverage: none · effort: M
- Exists: Nothing; run-tree selector never requested and parentRunId/lineageId never shown.
- UI: flow-run card gains a Calls facet (rows call-N · label · status · seat · duration) and a header mono line `child of r_… · continuation 2` linking to the parent card; the run-list lineage filter is an argument of runs.list (an act needs a flow), not a control of its own.
- Flows: `runs.tree <runId>; runs.children <runId>; runs.list [parent=<runId>] [lineage=<id>]`

### runs · Node outputs of a run (`smithers output <run> [node]`, node-output projection, MCP get_node_detail; plue node detail)

- Source: both · coverage: partial · effort: S
- Exists: gateway.nodeOutput is relayed (apps/app/src/mainview/state/controller/gateway.ts:180-190) but no card renders arbitrary node output; only the verdict shows.
- UI: flow-run card gains an Outputs facet listing node ids with an outcome glyph; a row opens a `node-output` card rendering markdown or JSON; an unknown node lists the known ones.
- Flows: `runs.output <runId> [nodeId]`

### runs · Run health classification and alerts (Monitor healthy|stalled|wedged-node|runaway-loop|awaiting-human|failing with remedy, autoHeal beats; Alerts with severity via Sink)

- Source: smithers · coverage: partial · effort: M
- Exists: flow-run `quiet` phase with quietForMs (packages/rpc/src/Cards.ts:286); admin.health covers service health, not run health (Flows.ts:1624).
- UI: flow-run header pill uses the Monitor class word with its remedy as the button; notifications card gains engine alerts (severity · run · condition · first seen) with Ack, the app acting as the alert Sink.
- Flows: `runs.health [runId]; alerts.list; alerts.ack <id>`

### runs · Workflow artifacts: list, download, delete (plue /artifacts; MCP list_artifacts answers unsupported)

- Source: both · coverage: none · effort: S
- Exists: Nothing.
- UI: flow-run card gains an Artifacts facet: rows name · size · node · age with Open (file card for text, native save for binary) and Delete (confirm).
- Flows: `runs.artifacts <runId>; runs.artifact.open <runId> <name>; runs.artifact.remove <runId> <name> (confirm)`

### search · Search repositories, issues, users, wiki (code search is designed)

- Source: plue · coverage: partial · effort: S
- Exists: code.search designed (WORKBENCH-UX L362); nothing built; no issue or repo search.
- UI: search-results card gains a scope segmented control `code · issues · repos · users · wiki` with the same grouped rows; issue rows open the issue card.
- Flows: `search <query> [code|issues|repos|users|wiki]; issues.search <query>; repos.search <query>`

### secrets · Secrets and credentials: repo secrets set/delete, org secrets, write-only setup secrets, Credential create/rotate with CredentialRef, push Claude Code credential into repo secrets (`smithers auth claude push`)

- Source: both · coverage: partial · effort: S
- Exists: env card lists secretNames read-only (packages/rpc/src/Cards.ts:459); env.set writes nonsecret variables (Flows.ts:964).
- UI: env card gains a Secrets section: rows name · set at · Rotate/Delete, footer Add secret with a masked field never echoed to chat, a `Push my Claude Code credential` row, and a repo|org scope switch.
- Flows: `secrets.set <NAME> [owner/repo|org]; secrets.rotate <NAME>; secrets.remove <NAME> (confirm); secrets.push-claude [owner/repo]`

### sharing · Workflow and connector sharing catalog: browse, install, publish, unpublish, my listings, install/run counts

- Source: plue · coverage: none · effort: M
- Exists: Nothing.
- UI: Connectors surface `Catalog` row opens a `catalog` card: rows name · kind · installs · runs · Install; My listings with Unpublish; workflow-list row gains Publish (confirm).
- Flows: `catalog.browse [query]; catalog.install <id>; flow.publish <name> (confirm); flow.unpublish <name> (confirm)`

### triggers · Schedules and cron triggers with overlap skip|buffer-one|supersede and catch-up none|one|all; plue event triggers (push, landing, issue, workflow_run, workflow_artifact) and artifact-driven re-trigger

- Source: both · coverage: none · effort: M
- Exists: Nothing; `smithers cron` is refused in rc.0 and returns on @smthrs/triggers.
- UI: New `schedule` card: rows flow · cron or event · next fire · last run status · overlap/catch-up words · enabled toggle; footer Add; row actions Run now, Pause, Delete (confirm); `unsatisfiable_cron` error verbatim.
- Flows: `schedule.list [owner/repo]; schedule.add <flow> <cron|event> [overlap=] [catch-up=]; schedule.pause <id>; schedule.resume <id>; schedule.remove <id>; schedule.run-now <id>`

### triggers · Inbound webhooks and channels: Control Channels/WebhookChannel mapping payloads to Start or Signal; plue repository webhooks CRUD, test delivery, delivery history, redeliver

- Source: both · coverage: none · effort: M
- Exists: Nothing built or designed.
- UI: `webhooks` card in the connectors surface: rows name · URL · events · last delivery glyph; actions Test, Deliveries (sync-ops-style rows with Redeliver), Delete (confirm); channel rows read `payload → start <flow>` or `→ signal <name>`.
- Flows: `webhooks.list [owner/repo]; webhooks.add <url> <events...>; webhooks.test <id>; webhooks.deliveries <id>; webhooks.redeliver <deliveryId>; webhooks.remove <id>; channels.add <start <flow>|signal <name>> <secretRef>`

### users/orgs/teams · Organizations and teams: create/edit/delete org, members, teams, team membership, team-to-repo grants, my orgs, org repos, org secrets/variables, org billing

- Source: plue · coverage: none · effort: L
- Exists: Nothing; the Owners facet (ADR 0004 L110-125) names teams but no surface manages them.
- UI: Sidebar tree org row opens an `org` card with facets Members (login · role · Remove, footer Invite), Teams (name · members · repos with Add repo access), Repositories, Secrets, Billing (reuses balance/portal rows).
- Flows: `org.view <org>; org.create <name>; org.members <org>; org.member.add <org> <login>; org.member.remove <org> <login> (confirm); org.teams <org>; org.team.create <org> <name>; org.team.member.add <org> <team> <login>; org.team.repo.add <org> <team> <repo> <perm>; org.secrets.set <org> <NAME>; org.billing <org>`

### workflows/automation · Automated issue pipeline (Research, Plan, Implement, Review, Land): start, stage view, pause

- Source: plue · coverage: partial · effort: M
- Exists: issue card additions (workspace row, change row) and box.open --issue designed (WORKBENCH-UX §3.10; ADR 0003 L148-151); agent.delegate is local only (Flows.ts:1078).
- UI: issue card footer `Start pipeline` (confirm) and Pause; progress is the existing `plan` card (packages/rpc/src/Cards.ts:103: items with pending/active/done) carrying the five stages Research · Plan · Implement · Review · Land, each active or done item linking its run card; the issue card's designed workspace and change rows carry the rest; no new stage strip.
- Flows: `issues.pipeline.start <n> (confirm); issues.pipeline.status <n>; issues.pipeline.pause <n>`

### workflows/automation · Dispatch a repository workflow on the sandbox plane (POST /workflows/{id}/dispatch, POST /invoke; `smithers workflow dispatch|run`; per-repo and per-user run quotas) as distinct from a workspace-gateway run

- Source: plue · coverage: partial · effort: S
- Exists: flow.run plans and runs on the workspace gateway only (apps/app/src/mainview/state/controller/gateway.ts:120-150); plue sandbox-plane runs appear only as rows in the proposed run inbox.
- UI: flow.run target grammar (already extended by the control-plane targets row) gains `sandbox`; the flow-run card header states the plane `workspace gateway` or `sandbox plane`; run-list rows carry the same word; a refused dispatch renders the quota line `runs · 5 of 5` verbatim.
- Flows: `flow.run <name> sandbox [owner/repo]`

### workspaces · Workspace delete, persistence mode (ephemeral/sticky/persistent) and idle timeout, sessions list/destroy, snapshot templates, cross-repo workspace list

### workspaces · Workspace sharing (owner/editor/viewer, share link) and Smithers Pair sessions (create, join, roles, access mode, prompt queue, draft, presence)

- Source: plue · coverage: none · effort: L
- Exists: Snapshots facet `Share` action designed (WORKBENCH-UX L168); nothing for live sharing or pair.
- UI: workspace card header gains Share only (no member avatars, no presence dots: NO INVENTION); Share opens a `share` card: rows login · role ▾ · state word present|away from the presence DTO · Remove, a link row with Enable/Disable, and a Pair section with queue rows prompt · owner · state and Join by link.
- Flows: `workspace.share <id> <login> <owner|editor|viewer>; workspace.share.link <id> <on|off>; workspace.unshare <id> <login> (confirm); pair.start <workspaceId>; pair.join <link>; pair.queue <text>; pair.end (confirm)`

### workspaces · Preview environments for landing requests: auto-create/stop/wake, preview URL, logs

- Source: plue · coverage: none · effort: S
- Exists: Nothing.
- UI: change/pr card gains a Preview row: state · URL (opens the browser card) · Wake · Logs (service-log card).
- Flows: `change.preview <changeId>; change.preview.wake <changeId>; change.preview.logs <changeId>`

## P2 (41)

### admin · Admin users/orgs/repos/runners lists, cross-repo run list, audit log, feature flags, metrics, canary and alert incidents with remediation outcomes

- Source: plue · coverage: partial · effort: M
- Exists: admin.health, admin.requests, admin.allowlist.*, admin.grant built (Flows.ts:1561-1630); github.reconcile designed (ADR 0005 L98-99).
- UI: admin-health card gains facets Users (login · admin · disabled with Grant/Disable/Token), Orgs, Repos (incl. the GitHub synced-repos feed), Runners (pool rows), Runs (cross-repo), Audit (actor · action · target · at), Flags (name toggle), Metrics (query row → result rows), Incidents (canary/alert rows with outcome); every facet named in the feature has a flow.
- Flows: `admin.users; admin.user.create <login>; admin.user.disable <login>; admin.user.delete <login> (confirm); admin.user.token <login>; admin.orgs; admin.repos; admin.synced-repos; admin.runners; admin.runs; admin.audit [query]; admin.flags; admin.flag.set <name> <on|off>; admin.metrics <query>; admin.incidents`

### admin · Server devtools snapshots capture/list/latest (flag-gated)

- Source: plue · coverage: partial · effort: S
- Exists: admin.devtools panel and debug.snapshot read app state only (Flows.ts:1501, 1521).
- UI: devtools panel gains server snapshot rows with Capture.
- Flows: `debug.snapshot.capture; debug.snapshot.list`

### agent environment · Delete a nonsecret agent-environment variable and manage org-level variables (`smithers variable delete`, /api/orgs/{org}/variables)

- Source: plue · coverage: partial · effort: S
- Exists: env.set writes a variable (Flows.ts:964); no remove; the org row's flows carry org.secrets.set only.
- UI: env card variable rows gain Remove (confirm); the repo|org scope switch proposed in the secrets row also governs variables.
- Flows: `env.unset <NAME> [owner/repo|org] (confirm); env.set <NAME=value> org`

### agent setup · Configure the agent `test` standard flow: command, container, cwd, timeout (SMITHERS_TEST_COMMAND|CONTAINER|CWD|TIMEOUT_MS); the flow binds only when the command is set

- Source: smithers · coverage: none · effort: S
- Exists: Nothing; env card shows vars, setupScript and secretNames (packages/rpc/src/Cards.ts:459); an unset command silently leaves the agent without a tests flow.
- UI: env card gains a Tests row `command · cwd · container · timeout` with Edit and Clear; the flow-plan envelope `flows` row reads `tests` or `tests · not configured`.
- Flows: `env.tests.set <command> [cwd=] [container=] [timeout=]; env.tests.clear`

### bookmarks/changes · Branch locks (acquire, heartbeat, release) and join requests

- Source: plue · coverage: none · effort: M
- Exists: Nothing.
- UI: workspace card header lock glyph `locked by <login> · 4m`; Request to join renders an approval-style card for the holder with Allow/Deny.
- Flows: `branches.lock <bookmark>; branches.unlock <bookmark>; branches.join <bookmark>; branches.join.decide <id> <allow|deny>`

### build cache · Workflow caches list/stats/clear and per-repo hosted build cache tokens (create/list/revoke, `smithers cache connect` writing PACKAGE.ts)

- Source: both · coverage: none · effort: M
- Exists: targets card shows patternRuns only (packages/rpc/src/Cards.ts:536).
- UI: targets card gains a Cache row (hit rate · size · last save) with Clear (confirm) and `Connect hosted cache`, which mints a read token and shows the PACKAGE.ts edit in a diff card; token rows with Revoke.
- Flows: `cache.stats [owner/repo]; cache.clear [owner/repo] (confirm); cache.connect [owner/repo]; cache.token.list; cache.token.create; cache.token.revoke <id> (confirm)`

### evals · Evals and scorers: suites, deterministic runs, baselines, regression comparison, CI gate thresholds, score observations, scorer bindings

- Source: smithers · coverage: none · effort: L
- Exists: Nothing; `smithers eval|scores` refused in rc.0 (private packages).
- UI: New `eval-run` card: header suite · baseline · runId; rows per case with score, delta and regression|nondeterminism word; footer Gate verdict; flow-run card gains a Scores facet.
- Flows: `evals.run <suite>; evals.compare <runId> [baseline]; evals.gate <runId>; scores.list <runId>`

### flow authoring · Scaffold a flow (`smithers init`: flow.mdx with a seat from the first provider key) and edit a flow's source

- Source: smithers · coverage: partial · effort: S
- Exists: flow.create authors from a description on Smithers Cloud (Flows.ts:473); files.read plus the editor can open source by path.
- UI: flow.new renders the scaffolded flow.mdx in the file card editor with a seat picker row limited to resolved providers before saving; workflow-list row gains Edit.
- Flows: `flow.new <name> [seat]; flow.edit <name>`

### flow discovery · Discovery warnings and descriptor facts: effect tier sealed|compensable|irreversible, placement, workspace mode, origin local|installed, packs name@version

- Source: smithers · coverage: partial · effort: S
- Exists: workflow-list card shows key and description only (packages/rpc/src/Cards.ts:326).
- UI: workflow-list rows gain one mono meta row `tier · placement · origin · entry ts|mdx|skill` (Copy law: mono meta rows, no badges), installed packs group by name@version, and a Warnings section listing each DiscoveryWarning with path and Open source.
- Flows: `flow.list --warnings; flow.source <name>`

### identity · Personal access tokens with scopes, sessions list/revoke, connected accounts unlink, OAuth2 applications and revoke-all

- Source: plue · coverage: none · effort: M
- Exists: Nothing.
- UI: account card facets Tokens (name · scopes · last used, Create with scopes picker, Revoke), Sessions (device · last seen · Revoke), Connections (provider · Unlink), Apps (name · Revoke all).
- Flows: `account.tokens; account.token.create <name> <scopes>; account.token.revoke <id> (confirm); account.sessions; account.session.revoke <id>; account.connections; account.unlink <provider> (confirm); account.apps`

### identity · Profile edit, emails add/verify, avatar upload, push devices

- Source: plue · coverage: none · effort: S
- Exists: connect card shows github login only (packages/rpc/src/Cards.ts:243).
- UI: account card Profile facet: name · avatar · emails rows with Verify/Remove and Add.
- Flows: `account.profile; account.profile.set <field> <value>; account.email.add <address>; account.email.remove <address>`

### identity · Alternative sign-in providers (Auth0, Sign in with Key)

- Source: plue · coverage: none · effort: S
- Exists: auth.sign-in is GitHub only (Flows.ts:714).
- UI: connect card lists provider rows the server's feature flags enable.
- Flows: `auth.sign-in [github|auth0|key]`

### identity · OAuth2 consent: approve or deny a third-party application's requested scopes (GET/POST /api/oauth2/authorize, PKCE S256)

- Source: plue · coverage: none · effort: S
- Exists: Nothing; the consent page is server-rendered HTML today; the identity row manages applications and tokens only.
- UI: When the authorize URL opens inside the app, the consent renders as the approval card variant `oauth2`: rows application · scopes · redirect host, Approve/Deny; otherwise it remains the server page inside the browser card.
- Flows: `account.consent <requestId> <allow|deny>`

### integrations · Notion document sync and companion document side-repositories

- Source: plue · coverage: none · effort: M
- UI: connector-setup card kind notion: authorize, pick pages, target side-repo; results in the sync-ops card.
- Flows: `notion.connect [repo]; notion.sync [integration]; notion.disconnect <integration> (confirm)`

### integrations · Browse GitHub repos not yet imported (issues, pulls, PR diff, access diagnosis)

- Source: plue · coverage: partial · effort: S
- Exists: repos.import lists GitHub repos for import (Flows.ts:790); repos.watch chooser retired by ADR 0001 L26-27.
- UI: issue-list and pr-list accept an `owner/repo@github` target rendering read-only rows with Import as the one write; a 403 renders the access diagnosis line.
- Flows: `issues.list <owner/repo@github>; prs.view <n> <owner/repo@github>; github.access <owner/repo>`

### issues · Issue dependencies, pinned issues, reactions, lock, events log, issue artifacts

- Source: plue · coverage: none · effort: M
- Exists: issue card has none of these (packages/rpc/src/Cards.ts:378).
- UI: issue card gains a Depends-on row with Add (acyclic error verbatim), a Pin toggle (3 max), a reactions strip, Lock (confirm), an Activity facet from the events log, and Attachments rows.
- Flows: `issues.link <n> <m>; issues.unlink <n> <m>; issues.pin <n>; issues.unpin <n>; issues.react <n> <emoji>; issues.lock <n> (confirm); issues.events <n>; issues.attach <n> <file>`

### issues · Edit an issue's title and body (PATCH issue; `smithers issue edit`)

- Source: plue · coverage: none · effort: S
- Exists: issues.create/close/reopen/comment built (Flows.ts:820-847); issue card body is read-only (packages/rpc/src/Cards.ts:378); the labels row edits chips only.
- UI: issue card header Edit opens title and body in the shared editor with Save, mirroring the landing-request Edit row.
- Flows: `issues.edit <n> [title] [body] [owner/repo]`

### issues · Edit and delete issue comments (PATCH/DELETE issue comment)

- Source: plue · coverage: none · effort: S
- Exists: issues.comment posts only (Flows.ts:847); comment rows carry no actions (packages/rpc/src/Cards.ts:378).
- UI: each comment row the viewer authored gains Edit (editor) and Delete (confirm).
- Flows: `issues.comment.edit <n> <commentId> <text>; issues.comment.delete <n> <commentId> (confirm)`

### landing review · Edit a landing request; dismiss a review

- Source: plue · coverage: partial · effort: S
- Exists: prs.create/view/land/review built (Flows.ts:860-918); change card designed without Edit or Dismiss.
- UI: change/pr card header Edit opens title and description in the editor; each review row gains Dismiss (confirm, reason).
- Flows: `prs.edit <n> [title] [body]; prs.review.dismiss <n> <reviewId> <reason> (confirm)`

### maintenance · Garbage-collect terminal runs older than a threshold with dry-run (`smithers gc`)

- Source: smithers · coverage: none · effort: S
- Exists: Nothing.
- UI: run-list footer `Clean up · N terminal runs older than 30d` opens a confirm showing dry-run counts per database.
- Flows: `runs.gc [--older-than 30d] (confirm)`

### migration · 0.x project migration (`smithers migrate` scan/apply, gates that park, report dir) and the 0.x legacy notice

- Source: smithers · coverage: none · effort: M
- Exists: Nothing; the designed `migration` card is the LSC card (WORKBENCH-UX §3.8).
- UI: migration card gains a 0.x-project variant: header project · 0.x db state · non-terminal-runs blocker; rows per scanned flow; parked gates surface as approval cards; report dir opens as file-list.
- Flows: `migrate.scan [path]; migrate.apply <path> (confirm)`

### notifications · Notification preferences (account and per-repo subscription) and push devices

- Source: plue · coverage: none · effort: S
- Exists: notifications card lists and marks read (packages/rpc/src/Cards.ts:442; Flows.ts:939-953).
- UI: notifications card footer Preferences: rows reason · in-app · email · push toggles; per-repo watch state row; a Devices row `this device · registered 3d ago` with Register/Remove (push devices are named in the feature and need an act).
- Flows: `notifications.prefs; notifications.prefs.set <reason> <channel> <on|off>; notifications.device.register; notifications.device.remove <id> (confirm)`

### observability · OTLP export configuration (collector endpoint, headers, service identity)

- Source: smithers · coverage: none · effort: S
- Exists: Nothing.
- UI: doctor card Observability row: endpoint · headers (secret) · enabled with Test send.
- Flows: `observability.set <endpoint>; observability.test`

### releases · Releases CRUD with draft/prerelease, assets upload/download/delete, release events stream, download counts

- Source: plue · coverage: none · effort: M
- Exists: Nothing.
- UI: New `release-list` card (rows tag · name · draft/pre · assets · downloads) and `release` card (notes markdown, asset rows with Download/Delete, footer Publish (confirm) / Edit).
- Flows: `releases.list [owner/repo]; releases.view <tag>; releases.create <tag> [--draft|--pre]; releases.upload <tag> <file>; releases.publish <tag> (confirm); releases.delete <tag> (confirm)`

### repositories · Repository settings: edit, topics, archive/unarchive, transfer, delete; fork; star/unstar; watch/subscribe; deploy keys

- Source: plue · coverage: none · effort: M
- Exists: repo card is read-only (packages/rpc/src/Cards.ts:597).
- UI: repo card Settings facet with editable description/topics, Archive (confirm), Transfer (confirm names the owner), Delete (typed confirm); header Star and Watch toggles and Fork; Deploy keys rows with Add/Remove.
- Flows: `repo.edit <field> <value>; repo.archive; repo.unarchive; repo.transfer <owner> (confirm); repo.delete (confirm); repo.fork; repo.star; repo.unstar; repo.watch; repo.unwatch; repo.deploy-keys; repo.deploy-key.add <title> <key>; repo.deploy-key.remove <id> (confirm)`

### repositories · Clone URLs (SSH/HTTPS), Git LFS objects and file locks

- Source: plue · coverage: partial · effort: S
- Exists: repo card has no clone or LFS rows (packages/rpc/src/Cards.ts:597).
- UI: repo card header `Clone ▾` copies the ssh or https URL; an LFS row lists locks with Unlock (confirm).
- Flows: `repo.clone-url [ssh|https]; lfs.locks [owner/repo]; lfs.unlock <path> (confirm)`

### repositories · Clone a cloud repository into a local checkout (`smithers repo clone`)

- Source: plue · coverage: none · effort: S
- Exists: repo.open opens an existing local checkout (Flows.ts:1180); connector.add connects one (Flows.ts:618); the clone-URL row copies a URL only; nothing creates a checkout from a cloud repo.
- UI: repo card header Clone ▾ gains `Clone to…` when the local runtime is present; progress renders in the repo-import-style job card; done adds the working-copy row `~/path · 0 ahead` under the repo in the sidebar tree and offers repo.open.
- Flows: `repo.clone [owner/repo] [path]`

### sandbox · Sandbox provider choice among the nine providers with health probes and supervision state

- Source: smithers · coverage: partial · effort: M
- Exists: ADR 0002 L5-7 designs a container/vm/desktop kind picker; no provider picker or health view.
- UI: ADR 0002 fixes one option surface with three kinds (container · vm · desktop) and forbids a class picker, so no provider picker: the nine providers map onto the kinds behind it (container: Container, Kubernetes, Cloudflare, Vercel, Daytona, AWS; vm: Microsandbox; no isolation: Directory, JustBash) and the kind row reads the resolved provider with its SandboxHealth word `ok · <provider>` or `unavailable · <provider>`; doctor lists one health row per configured provider.
- Flows: `sandbox.list; sandbox.health <provider>; flow.plan --sandbox <container|vm|desktop>`

### support · Bug report with redacted run digest (`smithers bug`)

- Source: smithers · coverage: none · effort: S
- Exists: Nothing.
- UI: flow-run failed state gains `Report this`, opening a `bug-report` card with a summary field, the included redacted facts as rows, and Send.
- Flows: `bug <summary> [--run <runId>]`

### support · CLI update check against npm dist-tags (`smithers update`)

- Source: smithers · coverage: none · effort: S
- Exists: Nothing.
- UI: doctor card row `@smthrs/cli <version> · newer <tag> available` with Update running the command in the workspace card's Terminal facet (terminal tabs retired, #2229).
- Flows: `update`

### time travel · Replay, fork, rewind, retry and compensation over a flow run's journal (TimeTravel library; CLI verbs and MCP tools refused in rc.0)

- Source: smithers · coverage: none · effort: L
- Exists: frame.back/forward/fork act on chat frames (Flows.ts:570-586); target.runs.select replays build-target runs only (Flows.ts:1379).
- UI: flow-run card gains a History facet: journal frames with a scrub cursor and `Fork from here` (confirm) that opens a new run card with origin `fork`.
- Flows: `runs.replay <runId> [cursor]; runs.fork <runId> <cursor> (confirm); runs.rewind <runId> <cursor> (confirm)`

### triggers · Outbound channel projection: a channel posts, edits, or skips a message about a run in the originating system (Channels.project post|edit|noop)

- Source: smithers · coverage: none · effort: S
- Exists: Nothing; the webhooks row covers inbound mapping to Start or Signal only.
- UI: webhooks card channel rows gain an outbound column `→ posts to <channel>` or `→ silent`; the flow-run facts strip reads `posted to <channel> · edited 2m ago` from the projected message.
- Flows: `channels.outbound <channelId> <post|edit|none>`

### users · Public user profile, activity, repos, starred; user search

- Source: plue · coverage: none · effort: S
- Exists: Nothing.
- UI: New `user` card: login · avatar · activity rows · repos; reached from any author in issue, pr or review rows.
- Flows: `user.view <login>; search.users <query>`

### wiki · Repository wiki pages (plue): list, search, view, revisions, create, edit, delete

- Source: plue · coverage: partial · effort: S
- Exists: the `wiki` namespace is the notes pane renamed from World (2026-09-07): `wiki` opens the pane, `wiki.new-note` creates a note, `wiki.select <documentId>` opens one, `wiki.delete <documentId>` asks and `wiki.delete.confirm` / `wiki.delete.cancel` answer (flows/entries/wiki.ts; the world.* names are hidden aliases in flows/entries/world.ts). Notes are Smithers documents, not plue repository wiki pages; no page list, page view, revisions or page search.
- UI: Reuse file-list and file cards with a `wiki:` target plus a revisions row under the `wiki.page.*` names so they never collide with the note flows; search via the search-results wiki scope, which Librarian L5 serves with `search.wiki <query>` (`wiki.search` is its hidden alias, RULINGS 5), `wiki.open <path>`, `wiki.backlinks <path>` and `wiki.graph [path]` over notes and generated pages; the outline's heading click is the hidden user-only `wiki.heading <line>` (a viewport gesture).
- Flows: `wiki.page.list [owner/repo]; wiki.page.view <page>; wiki.page.edit <page>; wiki.page.delete <page> (confirm); wiki.page.revisions <page>`; page search folds into the L5 `search.wiki <query>` scope

### workflows/automation · Declarative .smithers/ config files (workspace.ts, preview.ts, ci.ts, config.yml, protected-bookmarks.yml, labels.yml, webhooks.yml) and their reconcile state

- Source: plue · coverage: partial · effort: S
- Exists: files.read opens any file; ADR 0002 L8-10 defers the environment editor.
- UI: repo card Config facet: one row per config file with present/absent · last reconciled · errors verbatim and Open in editor; domain cards read `managed by .smithers/<file>` when declared.
- Flows: `repo.config [owner/repo]; repo.config.edit <file>`

### workspaces · Non-interactive workspace exec and typed TypeScript execution as agent-callable acts

- Source: plue · coverage: partial · effort: S
- Exists: Terminal facet designed (WORKBENCH-UX L156-158) covers interactive use only.
- UI: workspace.exec returns a `file`-style output card (command · exit code · output) the agent can read; TS execution uses the same card.
- Flows: `workspace.exec <id> <command>; workspace.ts <id> <file>`

### workspaces · Anonymous sandboxes for allowlisted public repos (per-IP limit, hard TTL)

- Source: plue · coverage: none · effort: S
- Exists: Nothing.
- UI: Signed-out connect card offers `Try in a sandbox` for allowlisted repos, opening a workspace card with a TTL countdown.
- Flows: `sandbox.try <owner/repo>`

### workspaces · App-machine timelines synchronized across devices and members

- Source: plue · coverage: partial · effort: M
- Exists: frame.back/forward/fork are local (Flows.ts:570-586).
- UI: Frame strip gains one mono meta line `shared with N · synced 2s ago` (no sync glyph, no avatars: NO INVENTION); members list as rows under frame.share; sync itself is background work that states failures on the toast stack (300ms law) and is not a user act.
- Flows: `frame.share [login]; frame.unshare <login> (confirm)`

### workspaces · Workspace SSH connection info for an external terminal or editor (GET /workspaces/{id}/ssh; `smithers workspace ssh`; public SSH bridge login `msb_<id>+<user>`)

- Source: plue · coverage: none · effort: S
- Exists: Terminal facet designed over WebSocket-to-SSH inside the app (WORKBENCH-UX.md L156-158); nothing hands the user the SSH target for their own terminal or IDE.
- UI: workspace card Terminal facet gains one mono row `ssh msb_<id>+<login>@<host>` with Copy; the token never renders (the local runtime places it in the keychain).
- Flows: `workspace.ssh <workspaceId>`

## Critic notes

Laws applied, from the canon on disk: WORKBENCH-UX.md §2 L76-104 (EMBED LAW, NO INVENTION 'anatomy lists are exhaustive', Flows 'every act is a flow with slash, agent, and button invocations of the same name; consequential acts carry confirm', 300ms law, Copy 'no badges that are scores, mono meta rows for ids and timestamps') and apps/app/AGENTS.md L3-16 (no takeover by default; 'no decorative chrome, no status badges, no extra pills'). ADR 0002 L5-7 (three sandbox kinds, no class picker) and ADR 0005 L128-133 (Connectors rows, one action per row) were read to check conflicts. Verified in the tree: the relay allowlist is Plan, Run, Cancel, List, Projection.Snapshot, Approval.Submit (packages/backend/internal/compose/browser_flow.go browserFlowProcedures); Flows.ts registers no issues.edit, env.unset, repo.clone, workspace.ssh, mcp.server.*, or snapshot delete; card kinds match the UI inventory (packages/rpc/src/Cards.ts z.literal list).

(a) Twelve capabilities in the inventories that no gap row lists and the UI inventory does not plausibly cover: repo clone to a local checkout (plue commands_repo.go:306); issue title/body edit (issue PATCH, `issue edit`); issue comment edit/delete (router.go:1145-1146); variable delete + org variables (router.go:1264, 1674-1676); workspace SSH info / SSH bridge (router.go:1407, workspace_bridge.go); per-repo gateway provision/resume state (router.go:569, 579-580) which every flow-run depends on and which the `reconnecting`/`no-capacity` phases hide; sandbox-plane dispatch/invoke (router.go:1286-1291) distinct from the gateway Plan/Run path the app uses; OAuth2 consent decision (router.go:990-991); `--mcp-config` MCP servers as run flows (packages/smithers/src/NodeControl.ts:150-189); outbound channel projection post|edit|noop (packages/smithers/control/src/Channels.ts:402-456); SMITHERS_TEST_* configuration of the agent `test` flow (NodeControl.ts:764-830). Smaller misses folded into corrections rather than new rows: memory threads/messages and ttl/compaction (MemoryStore.ts:444-464, Maintenance.ts) into the memory row; push-device registration (router.go:1491-1492) into the notification-preferences row; admin orgs/repos/metrics/synced-repos (router.go:1723-1744, 1460) into the admin row; registry entry precedence ts|mdx|skill into the discovery row.

(b) Twenty-one corrected rows, same feature strings. Patterns: sidebar badges or sidebar copy (run inbox, approvals inbox, workspace delete `N of M`) violate NO INVENTION; avatars, presence dots and sync glyphs (workspace sharing, app timelines) are decorative chrome; pills and badges (file drafts, discovery, memory notes) violate the Copy law and become mono meta rows; acts without a flow (run inbox/run tree lineage filter, issue-list label filter, MCP catalog Add and Install, remote-gateway follow-only toggle, push devices, admin metrics/orgs/repos, memory threads) gain flows or become flow arguments; duplicates of an existing card (flow-plan duplicates the approval card for a Plan target; workspace-status duplicates the designed change card for `@`; agent-session duplicates the agent card, following the canon's own PTY-to-SSH substitution precedent; the pipeline stage strip duplicates the plan card); a second flow name for one act (runs.cancel beside the built flow.run.stop that already cancels durably); invented sidebar `+` (create repo); an overflow menu outside the designed footer anatomy (workspace delete); and a canon conflict (nine-provider picker vs ADR 0002's three kinds and no class picker). No row proposed a page or a takeover; account and org cards with many facets stay inside EMBED LAW as cards.

Left as-is but worth the author's attention: the steer row and the original agent-session row embed a composer inside a card (a second composer beside the app's); the `grants` card assumes list/revoke RPCs that packages/smithers/control exposes only as installBulkGrant; the signal row needs the awaited signal name, which RunSummary.waitingReason (an enum) does not carry; the `runs.*` namespace sits beside the built `flow.run.*` names; system/* catalog flows must be filtered from workflow-list and run-list rows (SystemFlows.ts:48-216); projection limits (10 000 events, 4 MiB row set, 500 runs) should render as verbatim resource_limit lines in the transcript and run-list facets. Observations outside the gap list: Flows.ts also registers cloud.sign-in and cloud.sign-out, which the UI inventory omits; the plue items 'stargazers list', 'landing comments list', 'mark one notification read', 'billing refresh' and 'Claude Code credential status' are sub-acts of covered rows and were not promoted. Protocol, internal, ops-only and CLI-ergonomic items (git/LFS transports, runner protocol, SSE tickets, rate limiting, --json/--quiet/completions, exit codes, removed verbs) were judged not user-facing in the app and excluded.

