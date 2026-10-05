# Smithers MVP engineering specification

Status: draft v0.4 by the engineering agent (smithers-8a), 2026-10-02. Implements [mvp.md v2.6](../product/mvp.md) (M-01..M-30, build stages §11, deferrals §16). It specifies behavior. [delta.md](delta.md) is the build plan, and [overview.md](overview.md) is the one-page version.

## 0. Stages and deferrals

mvp.md §11 builds the MVP in three stages, and every one ships at launch. Will confirmed live code co-editing (M-02) for the MVP on 2026-10-02. It is built in stage 3. Stage 1 requires only stale-write refusal (§7.6). Once stage 1 passes J1 and J2, Smithers' own development moves onto the stack on Will's Mac mini (M-31). Will's rulings of 2026-10-02 also apply throughout:
- Tailscale is not part of the product (§1.4, §16.3).
- Every limit derives from the detected host, never a Mac model (§8.2).
- Each branch has one shared conversation (§14.1).
- The app agent runs a context preflight before it answers (§15.1).

0.1 Each section below is tagged with the stage that first needs it: **[S1]** skeleton (J1, J2, J4, J5, J6.1), **[S2]** multiplayer without co-editing (J3), **[S3]** live code co-editing and learning. **[D]** marks behavior deferred from the MVP (mvp.md §16). No deferred item is promised for a specific release; only the maintainer release (mvp.md §14) has a date. It is specified only so the MVP leaves room for it, and the MVP MUST NOT build it. Check: C-CAT-01 (MVP catalog excludes deferred commands).

| Deferred [D] | Where it would live |
| --- | --- |
| In-app line comments; agent replies in GitHub review threads | §12.5.3 |
| Stacked PR bases and retargeting (PRs stay based on `main`) | §12.5 |
| Laptop pushes merged into the live working copy; Open on a machine | §12.3 |
| Ask to type in another member's terminal | §8.11.2 |
| Command name on change entries, per-entry Undo, replaced-edit flags | §9.3.2, §9.3.6, §9.3.7 |
| Email and phone notifications (#3423) | §14.6 |
| Triggers, the Machine view, sending signals by hand, agent permissions/tools/budget editing | §11.7, §6.14 of mvp.md |
| Obsidian over git from laptops | §13.3 |
| Replace a stack item's work with a scratch branch | §8.5.3 |
| Secret usage by run | §8.8.1 |
| Exact per-write kernel attribution (fanotify) | §9.3.1 |

Conventions. **MUST** and **MUST NOT** are requirements that a check in [checks/](checks/) verifies. **SHOULD** is a default the engineer may change with a recorded reason. Product words come from mvp.md §3, and internal names appear in `code` the first time they're used. Section numbers (§n.m) are stable: tickets and checks cite them.

---

## 1. Deployment topology

```
 Team laptops (browser, smthrs CLI, Claude Code / Codex with the Smithers skill)
        │ HTTP(S) to the install's public origin      │ SSH :2222 (same host)
        ▼                                             ▼
┌──────────────────────── Apple Silicon Mac (macOS 15+) ───────────────────────────┐
│ launchd ─▶ host launcher (`smthrs host`)                                       │
│              ├─ host service `smithers-backend` (Go)                             │
│              │    API · /api/live · identity · GitHub pollers · stack engine      │
│              │    VM admission · SSH gateway · flow dispatch · wiki docs          │
│              ├─ PostgreSQL 18 (bundled, loopback, private data dir)               │
│              └─ host flow runtime (packaged TS; system flows only)                │
│ Repository store: bare mirror + jj repo per install · blob store (filesystem)     │
│                                                                                   │
│  microVM per awake branch (libkrun via msb) ──────────────────────────────┐      │
│  │ working copy (jj, colocated git) · machine daemon `smithers-machined`   │      │
│  │ coding host (flow runtime for repository flows) · coding agent CLIs    │      │
│  │ daemon-owned sessions (member uids, no sshd) · services the team runs  │      │
│  └─────────────────────────────────────────────────────────────────────────┘      │
└───────────────────────────────────────────────────────────────────────────────────┘
        │ GitHub App (installation token): git + REST                ▲ optional webhooks
        ▼                                                             │
      GitHub: main · issues · pull requests · reviews · checks
```

1.1 One install serves one team and one repository (mvp.md §2 rule 2). The install is one macOS user account's data directory, `~/Library/Application Support/Smithers` (`$STATE`). Every durable byte lives under it.

1.2 Processes. launchd starts the host launcher, which supervises the host service and PostgreSQL. A crash of either restarts both under the existing supervisor contract. No Docker, Kubernetes, Electron or Electrobun process exists on the MVP install.

1.3 Execution boundary (M-29, M-30). Repository code MUST execute only inside a branch machine. Repository code means overridable flows, the coding agent, checks, terminals, SSH sessions and services. The host executes only code shipped in the install package. The install MUST refuse to start without working microVM isolation and MUST NOT fall back to host processes. A machine may run on a registered remote host under the same microVM isolation, behind the `remoteSandboxes` flag (§8.13).

1.4 Network [S1]. The install is origin-agnostic:
- By default every listener binds loopback: HTTP on `127.0.0.1:4000`, SSH on `127.0.0.1:2222`, PostgreSQL.
- The owner may set a bind address (for example `0.0.0.0` or one interface) and the install's public origins (http or https, any host name) in Settings (§16.3), or at install time with `smthrs host start --bind <addr> --origin <url>`. HTTP and SSH listen on loopback always, plus the bind address when one is set; PostgreSQL stays on loopback.
- HTTPS, if any, comes from whatever the team puts in front, such as Tailscale serve or a reverse proxy. The docs show both, and no code depends on either.

A machine reaches the host only through the host-relay port and its own egress policy (§8.9).

---

## 2. Domain model

| Entity | Identity | Invariants |
| --- | --- | --- |
| Install | singleton | Exactly one repository, one owner. |
| Member | GitHub user id | Access = (owner ∨ added by a maintainer) ∧ live GitHub write access (M-05). Role ∈ {owner, maintainer, member}. Stable unix uid. |
| Credential | token id | Kind ∈ {session, delegated, run, machine, setup}. Only `session` acts as a person for approvals (§5.4). |
| Stack | singleton per repository | Ordered list of unmerged TODOs. Item order = merge order. |
| TODO | `T<n>` (for example `T12`), sequential per install; GitHub's `#n` stays for issues and PRs | One stack item, one change, one branch, one PR. Prompt revisions are append-only. |
| Branch | name, unique per install | Kind ∈ {item, scratch}. An item branch belongs to exactly one TODO. |
| Machine | branch id (1:1) | At most one live VM per branch. Disk outlives the VM. |
| Run | run id | One durable execution of one pinned flow version. |
| Flow version | (flow name, digest) | Immutable. At most one Active version per overridable flow name. |
| Activity entry | id, per branch | Append-only. One entry per burst of writes or per agent step, steer, answer or GitHub event. |
| Presence | (branch, actor, session) | Ephemeral. Expires 30 s after its last heartbeat. |
| Terminal | id | Owner = one member. Runs as the owner's unix user. |
| Live document | (branch, path) or wiki page id | One Yjs document; one authoritative host (§7.4). |
| Secret | name | Value write-only. Scope ∈ {all-branches, main-only}. |
| Proposal | id | Produced by a learning run; becomes a TODO only by a member's action. |
| Conversation | branch id (1:1) | One per branch, shared by everyone on the branch. `main`'s conversation is the team's home and holds the stack. Prompts go to agents; there is no person-to-person chat (M-08). |
| Conversation entry | (conversation, entry) | Shared. A prompt, an answer, a card or an event. Has author, title, summary, tone, state and context (§14.5, §15.1). |
| Member view state | (member, conversation) | Private: scroll position, card view state, last seen entry, toast hiding. |

2.6 [S1] People merge (M-39). PRs are human-gated by default. An owner or maintainer approves through Review & merge, bound to the reviewed revision, or Pre-approve on the TODO. A pre-approved TODO merges only when MergeReady holds. todo.preapprove (Pre-approve) and todo.unapprove (Remove pre-approval) are person-only in-card commands for an owner or maintainer (§6.1.2e). Agents never grant or remove pre-approval or move main. Check: C-STK-13.

Actor notation used everywhere (events, activity, presence, audit): `{person: member id, via?: "smithers"|"claude-code"|"codex"|"ssh"|<agent>, session?: id}` for people and agents acting for them, and `{agent: "coding", run: run id, todo?: Tn}` for the coding agent, `{system: "smithers"}` for the stack service and other system operations, and `{outside: true}` for writes no session can claim (§9.3.1). Rendering (M-34): "Ben", "Claude Code for Ben" and "Coding agent for Ben" (each agent its own avatar in Ben's color_index), "Maya via SSH" (a person's own session), "Smithers" or "Smithers, for Ben", "Changed outside Smithers" (§14.6a). For a GitHub author who is not a member, use {github: login}; it renders @login with the GitHub mark and never authorizes work (§12.3, §17.5). Check: C-J10-02.

---

## 3. Data model (PostgreSQL)

One schema, one forward-only migration ledger (existing). Existing tables first, then the few new ones, with key columns only:

```
collaborators: existing (repository_id, user_id, permission); add github_user_id, unix_uid UNIQUE, suspended_at;
      reuse the uncalled AddCollaborator; copy only the last-owner FOR UPDATE pattern from services/org.go
access_tokens: existing; in install mode a non-system PAT is `delegated`, with a `via` scope entry (§5.3)
approvals: existing (pending|approved|rejected|expired, payload, expires_at); session_id nullable, add member_id,
      credential_id, kind[one_click|review_merge] (§5.4)
install_settings(key PK, value jsonb, sealed bool, updated_by, updated_at)   -- existing; bind, public_origins, setup token
      digest, budgets, owner flow config and agent models (§11.2, §11.5a), the issue-events cursor (§12.2),
      the owner's pre-approval default (§10.6.2d); checks C-INS-03, C-SEC-04
github_app(id, slug, owner_login, owner_kind[user|org], client_id, pem_sealed, webhook_secret_sealed,
           client_secret_sealed, installation_id, created_at)   -- landed (T-GH-01)

mythical_items: existing; add number, stack_position, title, owner_id, created_by, needs_you, failure, paused_at,
      fixes_issue, flow_digest, revisions jsonb, merged_at, dropped_at; keep state, version, generation, candidate,
      pending_op, checks and PR fields   -- UNIQUE (repository_id, number) under a per-repository advisory lock
      -- checks.Attempts: per-attempt evidence; checks.Land: the merge approval (§10.6.2c);
      -- checks.Automerge: pre-approval (§10.6.2d); pending_op: outbound GitHub writes (§12.4)
product_job_events: existing; item/branch state, steers, answers, agent steps, GitHub comments and bursts;
      append in the change transaction; branch:<id>:activity and todo:<n> read the item’s operation streams
mythical_stacks: existing; add attention jsonb (order, force_push; §4.1.2a)
workspaces, workspace_shares: existing; a lane's workspace is its branch's machine, shared by write grants [S2] (§8.1)
chat_turns: existing; add indexed conversation_id (§15.1.4a); cards and events use existing turn output
collaborators.view_state: per-member branch view state, keyed by branch id
repository_secrets: existing; add scope; retain host-bound repository_agent_environment_secrets
workflow_runs: add dismissed_by and dismissed_at for Home dismissal
terminal sessions: existing in-process terminal manager; branch:<id> reads it
presence evidence: audit_log rows of kind presence, for sessions lasting at least 2 min
learning proposals: existing pending memory notes; accepted creates a TODO, rejected suppresses for 90 days

burst_files(burst_id, path, change[added|modified|deleted|renamed], renamed_to NULL,
            before_blob NULL, after_blob NULL, after_digest NULL)   -- [S2] §9.3.4; check C-COL-05
machine_event_receipts(branch_id, event_id, seq, committed_at, PRIMARY KEY(branch_id, event_id))   -- [S2] §9.1.4; check C-DUR-04

workflow_definitions: existing; add source_commit, digest, status[loaded|failed], load_error;
      retain versions per name; is_active marks the newest loaded row

run_summaries(run_id, attempt, target[phase:<n>|cell:<n>], text, rev, updated_at,
              PRIMARY KEY(run_id, attempt, target))   -- monitor summaries by agent:fast (§11.6.3, §14.5.3)
```

3.0 Do not add parallel tables: `members` → `collaborators`; `credentials` → `access_tokens`; `person_confirmations` → `approvals`; `todos` → `mythical_items`; `todo_revisions` → `mythical_items.revisions`; `todo_events`, `item_events`, `activity` → `product_job_events`; `todo_attempts` → `checks.Attempts`; `todo_approvals` → `checks.Land`; `todo_preapprovals` → `checks.Automerge`; `branches`, `machines` → `workspaces` and `workspace_shares`; `outbound_writes` → `pending_op`; `github_sync` → poller memory; `flow_versions`, `flow_activations` → `workflow_definitions`; `flow_config` → `install_settings`; `agent_turns`, `conversations`, `conversation_entries` → `chat_turns` and `chat_turn_batches`; `member_conversation_state` → `collaborators.view_state`; `projection_events` → source durable cursors; `machine_requests` → runtime admission queue. Keep `github_synced_*`. Drop the orphan Pair tables in one migration: `pair_prompt_queue`, `pair_session_draft`, `pair_session_invites`, `pair_session_links`, `pair_session_members`, `pair_sessions`, `pair_share_links`, `pair_state`, `share_listing_event_cooldowns`, `share_listings`. Check: C-PRC-02.

3.1 Card state is a pure projection of committed source facts. Publish after commit through the existing broker and durable cursor. Branch conversations use chat turn/batch ordering and replay; authorize branch membership on reads and subscriptions. Queued prompts, approvals and member view state remain private. Check: C-APP-04.

3.2 The `mythical_items` row is the TODO. One Go function (§4.1.0) projects its product state. `product_job_events` stores many lifecycle facts per item. No separate TODO row, revision table or state-sync writer exists. Check: C-STK-01.

---

## 4. State machines

### 4.1 TODO

4.1.0c Run attachment. A run_attached payload includes attempt. Accept it only when attempt is the item's current attempt and Checkpoint.RunID equals the run id recorded at launch in the starting transaction. ProjectFlowRuntime uses pgx.BeginFunc to guard attachment and commit item facts and product_job_events atomically. Check: C-STK-01.

```
            place          machine granted          agent launched
 (draft) ─────────▶ queued ──────────────▶ starting ───────────────▶ working ◀──┐
                      │                                 │  │ ▲               │
                      │ drop                    ask/approval/conflict/       │answer
                      ▼                         moved-off │ │ steer          │resolve
                   dropped ◀──── drop ─────────────┐     ▼ │                │
                      ▲                            │  needs_you ─────────────┘
                      │ drop                       │
         ┌────────────┴─────────┐  stop            │
         │                      ▼                  │
         │  paused ◀── stop ── working ── run error ──▶ failed ── retry ──▶ queued
         │    └── resume ──▶ queued                          │
         │                     working ── PR opened ──▶ in_review ── merge ──▶ merged
         │                                                   │  ▲
         │                     changes requested / steer ────┘  │ checks/rebase
         └──────────────────── PR closed on GitHub ─────────────┘ (stays in_review)
```

| From → to | Trigger | Guard |
| --- | --- | --- |
| queued → starting | Admission grants the branch's machine | Machine `waking` or `awake`; flow version pinned at this moment (or reused on Resume, §11.4.2) |
| starting → working | The coding host reports the attempt's run attached on the granted machine (`run_attached`): a new run's first step starts, or a resumed or re-admitted run continues its next unfinished step | Coding host up on the machine. Resume, re-admission and a new attempt all leave starting this way, never by waiting for a first step that already ran |
| starting → failed | The machine or the coding host fails to start | `failure.step = "start"` |
| any unmerged → needs_you | A wait opens (§10.8.0): the run raises `question` or `approval` while working; the engine or the sync raises `conflict`, `moved_off` or `foreign_push` in any unmerged state | One durable wait per reason (§10.8.0). The state is needs_you because it ranks above paused, failed and the item phase (§4.1.0a) |
| needs_you → working | First accepted answer (§10.8) | Answer is from a member, or the coding agent resolves a conflict |
| working → paused | Stop | The attempt's run is executing and no `question` or `approval` wait is open. An open branch wait (`conflict`, `moved_off`, `foreign_push`) doesn't refuse Stop; the state stays needs_you until that wait settles (§4.1.0a). A durable pause signal; the run parks in a `paused` wait at its next boundary (it is not cancelled), and `paused_at` is set when that wait opens; the machine is released once safe-idle |
| in_review → paused | Stop | A live nonterminal run held for stack events counts as executing; no question or approval is open. Stop opens the run's paused wait after an in-flight packaged operation settles. The PR remains open; terminal settlement wins. Checks: C-STK-03, C-STK-06 |
| working or in_review → paused | Daily token capacity is exhausted | The host opens the engine budget pause at a durable boundary; the card says "Paused · daily token budget · <owner>". Preserve run, inputs and PR; §15.2. Checks: C-STK-03, C-STK-06 |
| paused → queued | Resume | `paused_at` is set. Settles the pause wait and clears `paused_at`; the same run continues from its last finished step once a machine is granted, through starting (`run_attached`), then restores its prior stack wait or next unfinished work. For a budget pause, Resume requires §15.2 capacity; automatic budget recovery cannot settle an independent person Stop. Check: C-STK-03 |
| working → failed | Run terminal `failed` or `uncertain` | `failure = {step, class, message, retryable}` |
| failed → queued | **Retry** (optionally with a steer) | A new attempt: a new run of the same pinned flow version from its first step; the earlier attempt and its evidence are kept. Re-running finished steps is intended here, unlike Resume (§19.1) |
| failed → queued | **Retry with the current flow** (`todo.retry-current-flow`, in-card) | As Retry, but the new attempt pins the currently Active flow version; same TODO identity and evidence |
| working → in_review | `stack.propose` accepts the candidate (§10.4.4), and the PR is opened or updated | The PR head's tree is the accepted generation's tree |
| in_review → working | Changes requested, a review comment from a member, or a steer | Approvals for the old head are void |
| in_review → queued | As `in_review → working`, when the branch's machine was released and admission must grant it again [S2] | The same run continues through starting (`run_attached`) |
| in_review → in_review | Rebased, or a capture shows edits the verified candidate lacks | A new candidate is verified. Merge is held (`rechecking` or `pending_work`, §10.6.2a) until it is |
| in_review → needs_you | An outside push to the TODO branch, or a rebase conflict the agent can't resolve | PR stays open |
| needs_you → queued | Answered after the machine was released (safe-idle), and the answer needs new work | The run resumes when admission grants the machine again. An answer that needs no new work goes to in_review instead, whether or not the machine was released (QA p1, 2026-10-02) |
| needs_you → working | Bring in (after an outside push) | The run rebases onto the pushed commit at its next checkpoint |
| needs_you → in_review | Discard (after an outside push), or another answer that needs no new work | The PR head is the verified candidate |
| any unmerged with an open PR (queued, starting, working, needs_you, paused, failed, in_review) → merged | GitHub reports the PR merged and `main` contains the commit | None: a merge on GitHub counts from any unmerged state (M-22). The same transaction cancels the attempt's run, settles every open wait and clears `needs_you`, `paused_at` and `merging` (§10.6.2b). A steer never converts the PR to draft, so a maintainer can still merge it |
| any unmerged → dropped | Drop, or the PR is closed on GitHub without merge | The PR is closed and later items are rebased. The same transaction cancels the run, settles every open wait and clears `needs_you` and `paused_at` |
| dropped → in_review | The PR is reopened on GitHub within 7 days | Once per reopen event. No run starts: the TODO keeps its last accepted generation, and the first input that needs work starts a new attempt (§10.7.4). `smithers/<slug>` is recreated at that generation's `pr_head`; machine cleanup doesn't matter (§12.3) |
| needs_you → paused | The last open wait settles while `paused_at` is set | §4.1.0a |
| needs_you → failed | The last open wait settles while the item is `blocked` | §4.1.0a. Retry is accepted throughout |

4.1.0 One Go function projects the nine product states from `mythical_items` and its current lifecycle facts, using the table below and §4.1.0a precedence. REST and card shapes project one TODO schema in `packages/rpc`. C-STK-01 table-tests the function with literal expected states.

The table above lists command effects; the diagram omits some edges.

| Item state | TODO state |
| --- | --- |
| `queued`, `skipped` (not yet admitted), for a non-terminal TODO without an open PR | queued |
| `queued`, with an open PR on the item (current GitHub fact), for a non-terminal TODO | in_review (the PR stays open while the item rebuilds) |
| launched or re-admitted, run not yet attached (`run_attached`) | starting |
| `running`, `delivering`, `integrating`, `verifying`, `proposing`, `waiting`, `retrying` | working (`current_step` names the phase) |
| `proposed` | in_review (stays in_review while the PR rebuilds after an earlier merge) |
| `landed` | merged |
| `blocked` | failed |
| `cancelled`, `rejected`, `declined` | dropped (`state_reason` keeps the cause) |
| any non-terminal, with an open wait (§10.8.0) | needs_you (§4.1.0a) |
| any non-terminal, with `paused_at` set and no open wait | paused (§4.1.0a) |

Terminal item states win: `landed` always projects merged, and `cancelled`, `rejected` and `declined` always project dropped, whatever `needs_you` or `paused_at` hold. Check: C-STK-01. The queued/skipped row applies only to non-terminal TODOs. Terminal failed, dropped and merged facts take precedence over queued/skipped; derive them from the current item and lifecycle facts, never a separate stored product state. Check: C-STK-01.

4.1.0a **Precedence.** The projection function reads facts in this order; the first matching row wins:

| Rank | State | Holds when |
| --- | --- | --- |
| 1 | merged | item `landed` |
| 2 | dropped | item `cancelled`, `rejected` or `declined` |
| 3 | needs_you | at least one open wait (§10.8.0) |
| 4 | paused | `paused_at` is set |
| 5 | failed | item `blocked` |
| 6 | in_review, working, starting, queued | the item phase (§4.1.0) |

Open waits are independent: settling one never settles another. A `needs_you → X` row of §4.1 applies only when the settled wait was the last open one, and X is then the first lower rank that holds. With several open waits, the **primary wait** (`mythical_items.needs_you`, whose kind sets the action, §14.5.2) is the first open one in the order `moved_off`, `conflict`, `foreign_push`, `approval`, `question`, then the oldest. Branch waits come first because they block the branch itself, and answering a question doesn't clear them. The TODO card lists every open wait with its own action. Command guards read facts, not the derived state: Stop needs an executing run with no open `question` or `approval`, Resume needs `paused_at`, Retry needs item `blocked`, and an answer needs its own wait open. A live nonterminal run held for stack events counts as executing for Stop. Runtime cancellation reports the committed merged/dropped outcome, or failed/cancelled_external if no merge/drop settlement exists (§10.7.1). Daily-token-budget pause is an engine pause fact, not an open person wait; Resume remains subject to §15.2. Checks: C-STK-03, C-STK-06. Checks: C-STK-01 (the table), C-STK-08 (combinations).

4.1.1 `queued.queue = {reason: machine | merge_order | rebase | daily_limit, after?: n, position}` on the wire; `after` is the TODO number for `merge_order`. The card renders the reason as copy: "waiting for a machine #<position>", "merges after T<after>", "rebase pending", "Daily limit reached · starts tomorrow". daily_limit holds admission under §10.4.1b; it does not fail an attempt. The position comes from §8.3. Checks: C-STK-06, C-STK-03.

4.1.2 `working.current_step` is the step id of the run's innermost active flow step. It is projected from runtime events within 1 s.

4.1.2a Stack-level attention (`order`, `force_push`) is not a TODO state. It lives in `mythical_stacks.attention`, shows on the Home card for its audience (maintainers for `order`, the owner for `force_push`), and holds the stack's merges until settled.

4.1.3 Learning never changes `merged` (M-15). It increments `lessons` when its proposals and pages are written.

### 4.2 Machine

```
 none ──create──▶ provisioning ──▶ awake ◀──wake── asleep ◀──sleep── awake
                     │               │  ▲            │
                     │ fail          │  └─ waking ◀──┘ (granted)
                     ▼               ▼
                  failed          releasing ──▶ asleep          archived (TODO settled + captured)
```

Machine states shown in the product: awake, asleep, waking, waiting #n (= request queued), closed (= archived). `failed` shows as the failure with Retry.

### 4.3 Flow version

```
 proposed (open TODO touches flows/<name>/) ── merged on main ──▶ merged-syncing
 merged-syncing ── load ok ──▶ active (previous → previous)
 merged-syncing ── load fails ──▶ merged-failed (previous stays active)
```

### 4.4 GitHub sync health

`fresh` while the oldest required stream's `last_success_at` is ≤ 2 × target. Past that it is `stale`, which shows gold. It is `refused` when GitHub answered with a permission or not-installed error; that names the cause and links Settings. It is `limited` when rate-limited, with `retry_at`.

---

## 5. Identity, roles and credentials [S1; §5.5 S2]

### 5.1 Sign-in

5.1.0 The existing bootstrap token becomes single-use: backend mint, digest in install_settings, constant-time verification and serialized owner claim. Extend the existing install_setup_session exchange/validation; one HttpOnly, host-only SameSite=Lax cookie reaches only install setup and OAuth, expires after 24 h idle, and never grants person authority. Claim under installSetupOwnerLockID consumes the token, invalidates all setup sessions, inserts self_host_owners plus the owner’s collaborator row, and mints the person session. A second claim returns 401 setup_closed. Until repository permission is verified, that person can use only setup; other actions return 403 owner_unverified. Resolve App installation server-side, never from a callback parameter. Restart before claim rotates the token while retaining existing setup sessions and step state; after claim mint nothing. T-ACC-01 owns exchange/claim, T-INS-08 owns the 0600 handoff file and T-INS-02 the launcher relay. Checks: C-SEC-04, C-SEC-02.

5.1.1 People sign in with GitHub through the install's GitHub App user authorization (OAuth web flow). The callback URLs registered on the App are the configured origins plus `http://localhost:4000` (§16.3.3).

5.1.2 On each sign-in after the claim, the host service checks two things; a provisional owner's sign-in (§5.1.0) skips them and stays provisional. The person must be the owner or have a `collaborators` row that isn't removed. The person must also have `push` or higher permission on the repository, read with `GET /repos/{o}/{r}/collaborators/{login}/permission` using the installation token. If either fails, sign-in is refused with the reason, for example "needs access on GitHub ↗".

5.1.3 Hourly, the service rechecks every active member. A 401 or 403 on a member user-token call queues an immediate recheck through the same job. A successful installation-token permission lookup returning `none` or `read` sets `suspended_at` and publishes the revocation event (§5.6); regaining write clears suspension. Installation-level 401, 403 or 404, including an expired installation token or an App that lost repository access, sets the permission stream’s health to `refused` (§4.4) and changes no member row. Disambiguate a permission-endpoint 404 with `GET /users/{login}`: a confirmed unknown user is refused as unknown on add, an existing user with confirmed no repository permission follows the member-level rule, and an unresolved installation error preserves member state. Transient lookup failures also preserve member state and fail closed. Checks: C-ACC-03, C-ACC-04.

5.1.4 Role seeding: when a maintainer adds a person, the role defaults from GitHub. A person with only read access (or none) can't be added; the card shows "needs access on GitHub ↗". The owner can't be demoted or removed by anyone; owner transfer is deferred. Admin or maintain becomes Maintainer, and write becomes Member. A maintainer may change it.

5.1.4a After credential validity, scope, minimum role and actor/delegation policy pass, any request to demote or remove the owner, or set any member's role to owner, returns HTTP 403, class `permission`, code `owner_immutable`, and creates no member or projection change. The owner is equally subject to this invariant. Lower-role callers retain the ordinary permission refusal; eligible delegated callers retain the preceding `never` refusal. A no-op write on an owner record does not constitute owner transfer and must not be used to bypass the invariant. Checks: C-ACC-01, C-ACC-04.

### 5.2 Permission matrix

| Action | Owner | Maintainer | Member | Delegated (agent) | Coding agent (run) |
| --- | --- | --- | --- | --- | --- |
| Install settings: model access, capacity, GitHub App, upgrade | ✓ | | | | |
| Merge, approve a revision | ✓ | ✓ | | merge: `confirm` through Review & merge (a maintainer's session approves); approvals that gate a merge: `never` | |
| Members, roles, secrets write | ✓ | ✓ | | never (no confirmation path: secret values never pass through an agent or a pending confirmation) | |
| Merge flow/agent changes (same as Merge) | ✓ | ✓ | | `confirm` through Review & merge | |
| Create, place, amend, steer, answer, stop, resume, retry, drop TODOs; Bring in a foreign push | ✓ | ✓ | ✓ | `run`, except commit, amend, drop and Bring in: `confirm` (§15.1.5) | answer own conflicts only |
| Make a TODO from an issue with outsider text (§10.2.1); Discard a foreign push | ✓ | ✓ | | `confirm`: the requesting member must be a maintainer, and only that maintainer approves (§6.1.2b) | |
| Join branch, terminal, co-edit, fork, add to stack, run flows | ✓ | ✓ | ✓ | Appendix B actor eligibility applies per command: join/fork/run flows `run`; add to stack `confirm`; opening a personal terminal admits app_agent only; source co-edit admits external_agent only. | Own branch: join, source co-edit, fork, run flows only; no personal-terminal opening, SSH, add-to-stack, rebase, sleep or wake. |
| Read Members card or secret names | ✓ | ✓ | ✓ | `never` | |
| Read install status after claim | ✓ | | | `never` | |
| Copy SSH line / personal SSH access | ✓ | ✓ | ✓ | `never` | |
| Read secret values | | | | | |

5.2.0a Reading a stored secret value has no eligible credential kind and returns HTTP 403, class and code `permission` for a live otherwise admitted credential; it never returns a value field. Credential death, setup scope and provisional-owner checks retain their earlier refusals. Check: C-ACC-01.

5.2.0b A run credential allows `todo.answer` only on its own open conflict, and `branch.join`, `flow.source-coedit`, `branch.fork` and `flow.run` only with its own branch as subject. Fork/run execution must remain within explicitly bound run authority; any child credential is newly scoped to that child and inherits no person privileges. `box.terminal`, `ssh.copy`, `branch.add-to-stack`, `branch.rebase`, `branch.rebase-now`, `branch.sleep` and `branch.wake` return HTTP 403, class and code `permission`, even on the run's own branch. An agent-owned command terminal is a machine/run system facility, not the person-facing `box.terminal` action. No other person-command write is granted by the phrase ‘own branch’; candidate and proposal system operations use §10.4.4. Check: C-ACC-01.

5.2.0c The Members card and secret-name read have minimum role member for sessions, reflecting §6.15 and T-ACC-02; they remain person-only for delegated policy, as Appendix B requires. Change the generated descriptor person minimum-role fields for these reads to member and retain agent `never`; reconcile the conflicting blanket Maintainer wording in Appendix B for person reads before catalog parity approval. No secrets response returns a stored value. Install status is setup-only before claim and owner-session-only afterwards, including a provisional owner. Delegated owner install status returns `never`; lower delegated roles fail the owner check with `permission`. GitHub sync-health status is a different action and keeps B.2's P, A, X read eligibility. Scope and role refusals precede `never`. Checks: C-ACC-01, C-SEC-04. Members-card and secret-name reads admit every active member session and no delegated, run or machine credential. Writes require a maintainer or owner session. Checks: C-ACC-01, C-CAT-01.

A `machine` credential has no person-command row. Workspace-restricted system tokens may report a head, access workspace children and use the provider pool only through machine-scoped actions whose subject is the token’s own workspace. Bind every requested child and provider request to that workspace; a different workspace returns 403 `permission`. These actions support the machine’s own branch and grant no person-command authority. Checks: C-ACC-01.

5.2.0d Run and machine read grants are limited to the bound branch's TODO execution snapshot (`todo.read`), its files and diffs, its bound run's trace/events, and wiki reads explicitly marked coding-readable in Appendix B. A read returns only the fields required for execution: no secret names or values, roster, private conversation entries, confirmations or personal view state. The subject is the actual stored branch/workspace/run binding, not a caller-supplied assertion; cross-branch access, list-all requests and a missing binding return HTTP 403, class and code `permission`. `agents.read` (the factory Agents card) is denied for run and machine credentials even when a branch is supplied. Needed runtime agent configuration is a separately declared scoped system read, not that card. Machine event/head reporting, workspace children and provider-pool requests use separate hidden system descriptors, validating workspace identity and child ancestry before effects. A machine credential never gains a person command write; §10.4.4's system candidate/proposal grants remain explicit. All unlisted read actions are denied. Check: C-ACC-01.

5.2.1 Every served command and in-card action passes through one `Authorize(credential, command, subject)` before any effect. It reads actor eligibility, minimum role and `agent: run | confirm | never` from `catalog.mvp.json` (§6.1.2); §5.2 summarizes that table, and no second policy table exists. Roles map to the existing `canOwnRepo`, `canAdminRepo` and `canWriteRepo` helpers (`B/services/repo_permissions.go:115-204`); agents stay capped by `RequirePerson` and `capCredentialPermission` (`B/middleware/run_credential.go:145-176`). A refusal is a 403 at the route in the §6.2.3 envelope: `401 unauthenticated` for a missing, expired or revoked credential, including one whose member is suspended or removed; `403 permission` otherwise; `403 never` ("Only a person can do this") for a delegated caller on a person-only row. A `confirm` row returns `202 {confirmation, state: "pending"}` (§5.4). In install mode no credential may move or delete `main` through repo-host landing; `main` moves only by the GitHub squash merge (§10.6). On an install only the GitHub sync writes `main` and the default bookmark, and it only fast-forwards them; the install binds only a repository whose GitHub default branch is `main` (§16.2). Every receive admits only fully qualified names under `refs/` in git's ref format, and a refused push that cannot be rolled back holds the repository's writes until the operator restores its refs. Checks: C-ACC-01, C-ACC-02, C-SEC-04.

5.2.1a Dead credentials and hidden repositories (8a ruling, 2026-10-05, #3559; implemented 8a7918331e). The credential loader decides before routing. A request that presents a session cookie or bearer token that is unknown, expired, revoked, or belongs to a suspended or removed member gets HTTP 401 with class `permission` and code `unauthenticated` (§6.2.3), message "Sign in again", so the app can send the person to sign-in; the 401 does not clear the cookie, so a late 401 cannot wipe a fresh sign-in. A live session of someone not on the install roster gets 403 `permission` from the roster check, also before any repository lookup. A request with no credential gets 404 `not_found` on repository routes, so a private repository stays hidden. Every one of these responses is byte-identical for an existing private repository, a nonexistent repository and a nonexistent owner. Public routes (health, sign-in, OAuth, logout, setup, webhooks, SSE `?ticket=`) treat a dead cookie as no cookie. Check: `TestDeadCredentialRepoRoutesComposedInstallPostgres`, a table over {no credential, five dead cookie kinds, five dead token kinds, live non-member, live member} × {existing private repository, nonexistent repository, nonexistent owner}: 404, 401, 401, 403, normal (C-ACC-01).

### 5.3 Credentials

| Kind | Issued to | How | Can approve/merge |
| --- | --- | --- | --- |
| `session` | Browser of a signed-in person | Sign-in cookie: HttpOnly, Secure, SameSite=Lax, 30-day TTL | Yes, for roles that allow it |
| `delegated` | An agent acting for a person: `smthrs login` (always), branch terminal auto sign-in, the app agent | Minted with `via` = the agent's name (claude-code, codex, smithers, terminal, cli) | No. It can request a person confirmation (§5.4) |
| `run` | One coding-agent run | Minted at run start, dies at the run's terminal state | No |
| `machine` | `smithers-machined` and the coding host on one machine | Minted per boot, scoped to that branch | No |
| `setup` | Holder of a pre-claim setup session | Setup URL exchange; memberless and invalidated at claim (§5.1.0) | No |

5.3.0 Credentials are the existing `access_tokens`. In install mode a non-system PAT classifies as `delegated` (one branch in `TokenCredentialKind`, `run_credential.go:66-78`), with `via` as a scope entry that `audit_log.metadata` records. Unknown kinds and legacy sync or platform kinds have no install authority. A setup credential has no member. CLI delegated credentials expire after 30 days; turn and terminal credentials after 1 hour. Checks: C-ACC-01, C-SEC-04, C-SEC-05.

5.3.1 `smthrs login` MUST return a `delegated` credential, never a person-equivalent token, because the CLI can't know whether an agent will hold it. The `via` defaults to `cli`; `smthrs login --agent claude-code` sets it.

5.3.1a The issuer binds delegated actor class to the stored credential: `smithers` is app_agent; `cli`, `claude-code`, `codex` and `terminal` are external_agent. Unknown issuer actor classes are refused. `Smithers-Via` is attribution only and cannot alter that binding or scope profile. Checks: C-ACC-01, C-SEC-05.

5.3.2 A branch terminal signs in its member and branch with separate person and delegated credentials. The person credential uses stored kind session and via terminal; agent sessions use delegated credentials with issuer-bound via. Never give an agent session the person credential. In S1 the delegated token is `/run/smithers/sessions/<session id>/token`, mode 0600, owned by the guest’s single uid. S2 stores delegated credentials beneath /run/smithers/<uid>/token/sessions/<session id>/token, using a 0700 member directory and 0600 files. Replacement/deletion checks session and credential identity; no current-token alias exists. Person bearer bytes remain in the host terminal command broker. Human commands use an authenticated person-session terminal UI command channel; guest CLI/skill calls always use delegated credentials. No person bearer enters guest environment, files or inherited descriptors. Session.ts and Client.ts evict only the exact credential on 401, resolve only the same session on the next explicit request and never replay mutations or fall back to another identity. Checks: C-SEC-05, C-J6-01. Both stages set `SMITHERS_TOKEN_FILE` and `SMITHERS_URL` for the delegated credential and revoke it within 5 s of session close. The skill header supplies attribution only. S1 delegated Merge remains 403 permission/permission without effects; S2 eligible delegated Merge opens Review & merge. Checks: C-J6-01, C-SEC-05, C-STK-04, C-ACC-02.

5.3.2a The server stores the S1 `terminal_s1` profile with member and branch at minting. A person typing in their own terminal or CLI appends `todo.new` directly only with a person-bound credential whose stored kind is session, stored via is terminal or cli, and no agent session is bound. A delegated credential, including stored via terminal, cli, claude-code or codex, commits `todo.new` under A✓: return 202 with a private Confirm card for its person, and create no TODO until that person confirms from their own app session. If S1 has no Confirm-card path for this command, return HTTP 403, class `permission`, code `confirm_in_app`, message "Confirm in the app", with no TODO, confirmation row or other side effect. Stored credential kind and via decide the actor; client headers cannot select person authority or widen scope. Checks: C-SEC-05, C-J6-01, C-ACC-01. Own-branch question/conflict answer, steer and eligible non-private/wiki reads remain allowed. Approval-kind answer, non-append creation, explicit confirmation creation, merge, drop, move, other-branch answer/steer, secrets and member administration remain 403 permission/permission. Creating the private Confirm card for an eligible delegated append is an internal dispatch path, not permission to invoke explicit confirmation creation. Closed credentials return 401 permission/unauthenticated. S2 uses ordinary catalog policy. Check: C-SEC-05.

### 5.4 Person confirmation

A delegated credential whose catalog row is `confirm` and whose scope and member role allow the command (§5.2.1) creates an `approvals` row (kind `one_click` or `review_merge`; existing idempotent decide, 409 and expiry in `B/services/approvals.go`) and returns `202 {confirmation: id, state: "pending"}`. The app shows it to that member only, bound to the exact subject revision. Only that member’s `session` can approve it, after the authorizer rechecks their current role. It expires after 24 h or when its subject revision changes. A delegated list/read response exposes only `{id, state}`; dispatch exposes only `{confirmation, state}`. Pending confirmations publish on `confirmations:<member>` (§7.2.2). Checks: C-ACC-01, C-ACC-02. Only the person who must press sees the Confirm card. Other viewers see no card, placeholder, subject or approver. Check: C-ACC-02.

5.4.1 The create endpoint accepts only a delegated credential with confirmation scope and a resolved command whose catalog policy is `confirm`. It resolves the command and exact subject, validates their descriptor and performs one Authorize decision on that underlying action before creating anything; it does not first authorize a generic create action and then make a second command decision. A full-scope delegated requester receives HTTP 202 only if actor eligibility, role and subject permit that command. A session caller of explicit create gets HTTP 403 permission and must invoke the command directly; run, machine and setup callers also get HTTP 403 permission while live. Dead callers get HTTP 401. `never` targets receive 403 never after role/scope checks; a target with policy `run` has no confirmation-create path and returns 403 permission. List is own-only for session/delegated; run/machine return 403 permission. Approval or denial requires that confirmation's requesting member's session, current underlying-command role and exact revision; delegated/run/machine and another member's session receive 403 permission. A session press is a new request with one fresh Authorize decision on the bound action; the previous creation decision cannot authorize execution. Without a confirmation consumer, return HTTP 503, class `infra`, code `confirmation_unavailable`, before any handler effect or fabricated 202. Checks: C-ACC-01, C-ACC-02.

5.4.2 Confirmation dispatch and approval use §6.2.1 credential-scoped idempotency and a fresh bound decision for each request. Check: C-ACC-02. New confirmations use state pending in the stored row, 202 dispatch envelope, GET /api/confirmations results, delegated id/state reads, live projection and CLI output. The confirmation API never reports requested as a state. Checks: C-ACC-02, C-CAT-02.

### 5.5 Unix identity on machines (M-18, M-29)

5.5.1 Each member has a stable `unix_uid` from 20000 upward and a login equal to the GitHub login, sanitized to `[a-z0-9_-]{1,32}`. The coding agent runs as `agent` (uid 19999). The `smithers-machined` broker runs as root, and nothing else does; its daemon runs as `machined` (uid 19998, groups `{team}`) (§9.5.1). Check: C-COL-04.

5.5.2 No user on a machine has sudo, setuid helpers, file capabilities or membership in privileged groups. The image MUST NOT contain `sudo`. `su`, setuid/setgid binaries and binaries with file capabilities are removed or stripped. A sanitized login that collides with another gets a numeric suffix (`ben`, `ben2`), fixed at first assignment.

5.5.3 The working copy is owned `root:team` (gid 20000), with setgid directories and mode `g+rwX`. Every session has `umask 002`. Members and `agent` are in `team`.

5.5.4 Each member's home is `/home/<login>` on each machine, mode 0700, owned by that member's uid. A home belongs to one machine and is never shared between machines (§8.7.1). Tool logins persist only in that machine's home across sleep and wake (§8.7.3, C-MCH-10). A member added while a machine is awake gets a home there at their first session. `agent` has no access to member homes.

### 5.6 Revocation

5.6.1 Removing or suspending a member deletes their sessions, revokes their delegated credentials, member-bound run credentials and SSH grants, and closes their live sockets, terminals and SSH sessions within 5 s. On machines this is `kill_sessions`, which returns only when none of their processes remains, background ones included (§9.6.3). In the same 5 s it cancels their queued app-agent turns and stops their running one (§15.1.4a). Their TODOs keep their history; any maintainer can take one over with **Take over**, an in-card control on the TODO card (`mythical_items.owner_id` change, audited). Checks: C-SPK-08, C-UI-06.

5.6.1a Every person-owned TODO run records the sponsoring member with its credential at minting. Run authorization checks that member's current active state without assigning the run a person role or person-command authority. Suspension or removal denies subsequent run calls immediately with HTTP 401, class `permission`, code `unauthenticated`; persistent token revocation completes within the same 5 s as the member's other credentials. Revoke all active run credentials bound to that member, including tokens minted before a later TODO ownership change. Stop the affected execution from issuing further authenticated effects; retained TODO/run history is not permission to continue. Takeover by a maintainer does not reactivate a revoked token, and resumed execution mints a fresh credential bound to the new sponsoring member. Clearing suspension does not resurrect revoked credentials. Machine credentials remain separately workspace-scoped and gain no authority to continue a revoked member's run. Checks: C-ACC-01, C-ACC-03.

5.6.2 Member state, credential revocations and durable revocation events commit in one transaction before response. NewTransactionalDBPublisher uses that transaction; fanout sees only committed events. Recovery polls at most every 1 s, leaving time for stream close and guest child termination within 5 s of commit even when NOTIFY is lost. Check: C-ACC-03.

---

## 6. Commands, API and the catalog

### 6.1 One catalog

6.1.1 Every member-facing action is a command with a typed payload schema. The command is the single source for four doors: the app's slash menu, palette and card buttons; the app agent's tool list; the `smthrs` CLI; and the Smithers skill (M-21).

6.1.2 A command's descriptor is its `app-operations` `Operation`, the one authority for it. The MVP catalog file `catalog.mvp.json` and the CLI mount are generated from those descriptors (E-14). Each row carries:
- the slash name, the CLI path, the journey and the group;
- visibility: `core` or `advanced` (an Appendix A row), `in-card` (a control inside a card: an mvp.md B.4 control or a B.1 card control) or `hidden`;
- actor eligibility: which of `person`, `app_agent` and `external_agent` may invoke it, read from the row's Appendix B Who column. **A** or **A✓** lists `app_agent`, and **X** lists `external_agent`. A UI-only row (B.1) never lists `external_agent`, since an external agent has no screen;
- the minimum role, `member`, `maintainer` or `owner`, from the same column (for example "maintainer for Discard" or "Owner only");
- the confirmation policy for delegated credentials, `agent: run | confirm | never` (§15.1.5). **A✓** gives `confirm`; otherwise **A** or **X** gives `run`; a row with neither gives `never`. A person-only row lists `person` alone and is `never`.

6.1.2d Keep person-command descriptors to tag, slash, CLI, visibility, actors, minimum role and agent policy. System handlers use the existing run/machine/setup guards and stored-subject checks; unbound or unknown authority refuses. Candidate/propose require the exact item, attempt and workspace. No second credential-policy catalog. Checks: C-ACC-01, C-CAT-01.

6.1.2e [S1] todo.preapprove (Pre-approve) and todo.unapprove (Remove pre-approval) are maintainer-only in-card TODO commands from Appendix B.4. Each lists person alone, agent: never, no CLI or skill door, and denies run, machine and setup credentials. Only a session or trusted person credential may execute; delegated, agent, run and machine credentials receive HTTP 403, class permission, code permission, with no record or confirmation. A via or person header cannot change credential eligibility. Add/remove events name the person and via. Check: C-STK-13. They have no slash, palette, /help or agent-tool entry. The owner's pre-approval default for new TODOs is one owner-session-only `install_settings` key that records the enabling owner, via and timestamp; an agent cannot enable it. T-STK-04 owns `checks.Automerge`, the evaluator and the shared merge dispatch path, and T-APP-02 binds TODO controls. Checks: C-STK-13, C-CAT-01.

6.1.2a Doors follow from these fields. The slash menu, the palette and `/help` list exactly the `core` and `advanced` rows plus repository flows, and `/help` collapses `advanced`. An `in-card` row is a card button: it has no slash command, palette entry, `/help` row, CLI path or skill entry (for example Return to Tn, Keep for now, Bring in, Discard, OK on order attention, Reset to GitHub main, Make TODO from a proposal, Dismiss, Retry a background run). The app agent's tools are the rows that list `app_agent` and aren't `never`, `in-card` rows included. The skill carries the `core` and `advanced` rows that list `external_agent` (mvp.md B.6). The CLI carries the same rows plus person-facing open-card paths for `/secrets`, `/members` and `/settings`; those paths open the app card for the person, perform no mutation, and expose no external-agent path. Other rows have a `null` CLI path, the UI-only rows ⌘K, `/help`, `/stop` and `/theme` among them. `/terminal` maps to `workspace ssh`, `shell` and `exec` in the CLI. `/search` and `/github` status list `external_agent` and use the same read-only skill as the app agent. GitHub App changes stay owner-only. Sign-in and sign-out are never agent-invocable. The CLI hides non-MVP groups from MVP help with an explicit hidden list where incur lacks a flag. Check: C-CAT-01. The `/github` command and external-agent skill read status only through GET /api/github/sync. Retry uses the separate in-card descriptor `github.retry`, minimum role Member, agent: run, and POST /api/github/sync. Checks: C-J10-06, C-CAT-01.

6.1.2b The host authorizer (§5.2.1) consumes one descriptor authority for every kind. Session/delegated callers require actor eligibility and current member role; delegated callers follow agent policy. Run, machine and setup require the existing system-handler guards and stored-subject predicates, not a person role or delegated policy. Member-bound runs also require a live active sponsor. Check: C-ACC-01. For a `confirm` row the authorizer checks the requesting member's role before it posts the confirmation and again when the member presses it, so a Member's agent can't post a maintainer-only Discard. §5.2 summarizes these fields. Check C-ACC-01 tests the authorizer against every `catalog.mvp.json` row, role and credential kind.

6.1.2b1 Delegated decisions are identical across vias only when trusted actor class, scope profile, role and subject are equal. Appendix B can distinguish app_agent from external_agent; the terminal_s1 profile permits direct append only for the person credential in §5.3.2a; delegated append retains A✓. Checks: C-ACC-01, C-SEC-05. Members-card and secret-name reads are person-only with minimum role member; writes require maintainer. Install status after claim is owner-session-only. order.ok is maintainer person-only, agent: never. Check: C-CAT-01.

6.1.2b2 `todo.answer` resolves an open question or conflict wait; `approval.approve` and `approval.deny` resolve approval-kind waits and require a maintainer or owner session. Their descriptors and command ids remain distinct. The server reads the stored wait kind before authorization; a submitted kind cannot relabel an approval as a question. An answer route that targets an approval resolves to the approval command before its single Authorize decision, or refuses without effect if the payload cannot resolve to that command. Run answers are restricted to their own conflict; they cannot answer general questions or approval waits. Checks: C-ACC-01, C-ACC-02.

6.1.2c The allowlist (check C-CAT-01). mvp.md Appendix B is the registry of every flow and action: app flows, coding-host tools, backend system flows and workers, and CLI commands. Appendix C (`.specs/product/actions.md`, 386 rows) lists every `Flow.make`, `Action.make` and `AgentAction.make` tag in shipped flows and std tools, with where it runs. The build fails when:
- the `core` and `advanced` rows differ from Appendix A in either direction, or an Appendix A row that lists `external_agent` lacks a CLI path or skill entry;
- an `in-card` row has no B.4 or B.1 row, or a B.4 control (stable ids such as `todo.return-to-item`, `file.restore` and `merge.confirm`) has no `in-card` row;
- a row's actor eligibility, minimum role or `agent` differs from its Appendix B Who column;
- a registered app flow id or backend CLI command has no B.1, B.2, B.4 or B.6 row, or its row says Cut;
- a registered tag has no Appendix C row, or its row says Cut or Replaced;
- a tag is registered in a runtime its Appendix C row doesn't name: the host flow runtime registers only Install rows, and the coding host only Machine rows (§1.3, §11.1).

6.1.2c1 Catalog parity retains A✓ for delegated `todo.new`, including terminal_s1. The S1 direct-append exception applies only to a person’s own terminal or CLI credential under §5.3.2a. Check: C-SEC-05.

A ticket that adds a tag adds its Appendix C row in the same change. The Cut assertion turns on in the change that completes T-CUT-01's deletions, since 87 Cut tags are still registered today. The Replaced assertion turns on in T-FLW-11's change, which folds `coding/Request` and `coding/Vibe` into the `todo` composition; `coding/Verify` and `review/change` stay engine launches (§10.4.1).

6.1.3 Commands outside the MVP stay published as libraries or CLI groups but are `hidden`. They are absent from the palette, `/help`, the agent's tools and the MVP docs.

6.1.4 A missing required input opens a form card, never a usage sentence.

### 6.2 HTTP API conventions

6.2.1 Every mutating request carries `Idempotency-Key`. A repeat with the same key returns the original result. An idempotency record is scoped to the authenticated actor and stores the operation, subject and canonical validated request, including the normalized reviewed SHA for Merge. After authentication and authorization to access the recorded result, the same key with the same operation, subject and canonical request returns the original result without executing again. The same key in that actor's scope with a different operation, subject or canonical request returns HTTP 409, class `conflict`, code `idempotency_mismatch`, message `Idempotency-Key was already used for a different request`, and creates no new confirmation, fence, approval or outbound write. Checks: C-STK-04, C-STK-07, C-ACC-02.

6.2.1a For install commands, authenticated actor scope is `(install_id, credential_kind, immutable_credential_id, bound_member_or_run_or_workspace_id)`; a session has its server-side session identity and every token has its stored credential identity. A replacement or differently scoped credential does not share that scope. Never key by a caller-provided actor id, `via` header or member id alone. Resolve the canonical command/subject first and run the request's single Authorize decision, including live role/state, before disclosing or returning an existing idempotency result. A denied or dead caller receives the current typed refusal and no recorded response; a confirmation-required replay may return only the same existing private confirmation result that its current decision permits, not execute the command or insert a second row. Its stored state must reflect expiry or resolution, never pretend an expired confirmation is a new pending request. The same key with a different canonical command, subject or payload retains HTTP 409 conflict/idempotency_mismatch within that credential's scope. A different credential starts a distinct authorized operation even if its member and key match. Confirmation approval and delegated creation therefore have separate idempotency scopes; exactly-once effects additionally use the confirmation's terminal state and operation-level durable deduplication. Replay never replaces a fresh confirmation-owner check or the specialized Merge dispatch guard. Checks: C-ACC-01, C-ACC-02.

6.2.2 Responses state progress honestly. Confirmation dispatch returns `202 {confirmation: id, state:"pending"}` after persisting the private confirmation. Only a chat acknowledgment uses `202 {state:"requested"}`. Other persisted command requests use `202 {state:"accepted"}`; accepted means durable admission, not completion. Completion arrives only as a projection event. A transport success is never completion. Checks: C-CAT-01, C-ACC-02, C-UI-05.

6.2.3 Errors use one typed envelope: `{code, class: user|permission|capacity|github|infra|conflict|never, message, retry_at?, fix?}`. The class drives the UI fault copy ("not your fault" for infra and capacity). Class `never` means the actor kind may never perform the action, including agents on person-only commands. It returns HTTP 403 with copy "Only a person can do this". The UI renders `fix` as a link; API messages contain no "↗" glyph. Checks: C-ACC-01, C-ACC-04. Authorization uses §5.2.1's precedence. Eligible confirmable dispatch returns HTTP 202 with `{confirmation, state: pending}`, never a 403 confirmation fix. Check: C-CAT-01.

6.2.4 The OpenAPI document MUST describe every served route. Cut routes are deleted from both the code and the document in the same change. A route that Plue still serves but the Mac install must not (for example `/api/admin/*`) is unmounted in the install composition only, and the OpenAPI row carries `x-composition: plue`; the conformance test checks each composition against its own rows.

### 6.3 Resource surface (target)

```
/api/members            GET · POST add · PATCH role · DELETE remove
/api/todos              GET list · POST create{prompt,title,acceptance?,place,issue?,fixes?}
/api/todos/{n}          GET · PATCH amend · POST {stop|resume|retry|retry-current-flow|drop|steer|answer|move|takeover}

/api/todos/{n}/attempts/{attempt}/logs/{digest} GET (authorized TODO read; digest must be referenced by that attempt, otherwise 404; T-STK-01; C-J2-04 and todo_evidence_db_test.go)
/api/todos/{n}/merge POST {reviewed_head_sha} (owner/maintainer session executes; eligible delegated credential requests private Review & merge, HTTP 202; run/machine HTTP 403 permission)`.

/api/todos/{n}/preapproval POST grant · DELETE remove (owner/maintainer session only; todo.preapprove / todo.unapprove; delegated/agent/run/machine 403 permission/permission; C-STK-13)
/api/stack              GET (home card snapshot)
/api/branches           GET · POST fork{from: main|Tn|branch, name?}
/api/branches/{b}       GET · POST {rebase|add-to-stack|sleep|wake|return-to-item|keep-moved|bring-in{sha}|discard-foreign{sha}} · /files · /diff · /activity
/api/branches/{b}/files/{path}  GET · POST {restore|restore-deleted} · GET compare
/api/conversations/{b}  GET entries · POST prompt · PUT view-state · POST turns/{id}/stop · PATCH turns/{id} {prompt} · DELETE turns/{id}   (turn routes: the author only; PATCH and DELETE while queued; C-APP-02) Conversation append locks its conversation row and allocates seq transactionally with UNIQUE(conversation_id, seq). Entries, sequence counter and projections roll back together; branch/conversation creation shares one transaction. GET and snapshots apply audience filtering as well as subscriptions; foreign private entries, queued prompts and view state never reach the reader. SharedEntries excludes all private entries. Check: C-APP-04.
/api/terminals          POST open{branch}
/api/flows              GET catalog with versions · POST edit{name, request} · POST run
/api/runs               GET · /{id} · /{id}/trace · POST /{id} {retry|dismiss} (failed background runs, §14.3; check C-J4-01)   (sending signals by hand is deferred)
/api/proposals          GET · POST {id}/accept · POST {id}/dismiss
/api/secrets            GET names · PUT · DELETE
/api/github/sync        GET health · POST retry
/api/confirmations GET mine (session full own rows; delegated own id/state only) · POST create{command,subject,payload} (eligible delegated confirmation dispatch only) · POST {id}/approve or deny (requesting member's session only)`.
/api/agents             GET (roles, model, runs) · PUT {role}/model (owner)
/api/install            GET status (with a setup session before the claim, owner afterwards, §5.1.0) · PUT settings · POST setup/{step} · POST quiesce · DELETE quiesce · GET scorecard (owner)

/api/install/setup/app POST (GitHub App setup; the only App setup step route; no github_app alias; stored step id app_manifest; C-J1-02)
/api/live               WebSocket (§7)
/ssh :2222              SSH gateway (§8.10)
```

6.3.1 User-configurable trigger list/register/approve/pause/resume/run routes are not served by the MVP install composition and have no person, app-agent or external-agent catalog door. Requests to those unmounted paths return HTTP 404, not an owner-only authorization result. Internal event admission and scheduled system work remain enabled through hidden system descriptors; their service identity grants no user trigger-management authority. Plue may retain its own trigger routes and composition-specific OpenAPI entries under §6.2.4. T-CUT-03 unmounts GET /api/repos/{owner}/{repo}/repository-jobs; GET /api/repos/{owner}/{repo}/repository-jobs/{job}/dispatches; POST /api/repos/{owner}/{repo}/repository-jobs/{job}/pause (pause; no resume alias is mounted); GET and POST /api/repos/{owner}/{repo}/repository-jobs/{job}/approvals; PUT /api/gateways/{hostID}/repository-jobs/{job}; PUT /api/gateways/{hostID}/repository-jobs/{job}/manual/{requestID}; C-ACC-01 proves HTTP 404 and absence from the install route manifest and OpenAPI composition. Retained gateway worker routes require explicit hidden system grants and cannot provide a user-management bypass.

### 6.4 Attribution header

Every request from an agent carries `Smithers-Via: <agent>`. The CLI and skill set it from the environment: `CLAUDECODE=1` → `claude-code`, `CODEX_*` → `codex`, otherwise the `via` in the credential. The host records `via` from the credential kind and the header, credential first. A `session` credential ignores the header.

---

## 7. Live channel [S1; presence S2; documents S3]

### 7.1 Transport

One authenticated WebSocket per browser tab, `ws://` or `wss://` matching the page's origin, at `/api/live`, subprotocol `smithers.live.v1`. It is a thin adapter over the existing `sse.Broker` (`B/sse/broker.go:34,296`), its `DurableStream` cursors (`durable.go:31-37`) and the revocation watcher [S1]. It is authenticated by the session cookie, or by a bearer token for the CLI. The client is the landed `MV/runtime/LiveChannel.ts` minus its unread TanStack collection. Where a client needs presence or resumable follow, it reuses `@smthrs/sync` (`BranchProtocol.ts`, `SyncClient.ts`, `BranchPresence.ts`) rather than new frames. Terminals keep their own WebSocket (§7.5); documents join in S3. Frames:

```
text   {"t":"sub","id":7,"topic":"todo:12","cursor":1043}
text   {"t":"unsub","id":7}
text   {"t":"snap","id":7,"cursor":1050,"data":{…}}        server → client
text   {"t":"delta","id":7,"cursor":1051,"data":{…}}
text   {"t":"gap","id":7}                                    client must resubscribe without a cursor
text   {"t":"err","id":7,"code":"unknown_topic|forbidden|unsupported"}   subscription refused; socket stays open
text   {"t":"saved","id":7,"sv":"<base64>","at":"…"}         [S3] a document is durable through state vector sv (§7.4.6)
binary [kind u8][sub id u32][payload]   [S3] kind: 1 yjs-sync, 2 yjs-awareness
```

7.1.1 The server applies backpressure with a per-connection send budget of 2 MiB. On overflow, subscriptions receive `gap` and Yjs documents restart sync step 1.

7.1.2 Reconnects back off with jitter from 250 ms to 5 s. On reconnect the client resubscribes with its last cursors.

### 7.2 Projection topics

| Topic | Snapshot | Deltas from |
| --- | --- | --- |
| `home` | Stack, `main` row, counts, background runs, machines in use / capacity, sync health | mythical_items, product_job_events, mythical_stacks, workspaces, poller health, runs |
| `todo:<n>` | TODO card model (§14.3) | product_job_events, runs, product_job_events, the GitHub synced store |
| `branch:<id>` | Branch card model: machine, presence, item, place, terminals | workspaces, presence, terminals |
| `branch:<id>:activity` | Last 200 activity entries | product_job_events |
| `branch:<id>:files` | Changed files vs the item's base, plus per-file last writer | burst_files, live documents |
| `run:<id>` | Run summary, steps, phases and cells (§11.6.3) | runtime events (§11.6), `run_summaries` |
| `members` / `secrets` / `flows` / `proposals` / `agents` | Card models | collaborators, repository_secrets, workflow_definitions, memory notes, install_settings |
| `install` | Setup and Settings model (§14.3) | install_settings, github_app, host profile |
| `confirmations:<member>` | That member's pending confirmations (member-only) | approvals |
| `view:<member>:<branch>` | That member's view state for a conversation (member-only) | collaborators.view_state |
| `conversation:<branch>` | Shared entries with author, title, summary, tone, state, context | chat_turns |

7.2.1 A delta MUST arrive at subscribers within 1 s (p95) of the committing transaction on the reference host (check C-PERF-02).

7.2.2 Shared topics contain started turns and shared source facts only. Confirm cards use `confirmations:<member>`; view state uses `view:<member>:<branch>`. Uncommitted Drafts stay in the browser. Derive per-viewer attention from shared facts, role and last_seen_seq. Check: C-UI-06.

### 7.3 Presence [S2]

7.3.0 For 30 s after the host starts, presence is unknown, and the scheduler releases no machine in that window (§8.3.3).

7.3.1 Reuse `packages/smithers/flows/sync/src/BranchPresence.ts` through the runtime bridge. Add person-or-agent kind and location to its lease roster; keep 30 s leases keyed `(branch, actor, session)`. Do not restore Pair presence or create another roster. Check: C-J3-01. Heartbeat sources, all through `@smthrs/sync`'s branch protocol (§7.1):
- the browser, every 10 s and on every move, with where = `{path, line}` (§7.6), `{terminal}`, `{run step}` or `{branch}`;
- `smithers-machined` for SSH, terminal and editor sessions, with where = the file last written by that session (§9.3);
- the runtime for coding and reviewer agents, and the host turn runner for Smithers app agents, heartbeat every 10 s while working with the participant id, acting-for member and current step or file; external-agent skill calls bind an agent participant to their broker session, whose heartbeats keep its terminal/file presence alive until that agent session ends. Check: C-J3-01.

7.3.1a Restore only the heartbeat/lease SQL shape from `pair_sessions.sql` deleted in 2753d2e3 where admission or presence needs it, and Pair's revocation race tests for shared branch access. Do not restore sessions, invites, links, prompt queue or draft. T-COL-06 owns roster wiring; T-MCH-06 owns admission leases; T-ACC-02 owns revocation tests. A person's presence lasting at least 2 min writes one coarse `audit_log` row for the scorecard. The roster stays in memory. Checks: C-J3-01, C-MCH-02, C-SPK-08.

7.3.2 Presence changes publish to `branch:<id>` as deltas, coalesced to at most 4 per second per branch, and reach subscribers within 1 s. Rows stay per session and render per participant: one avatar for each person or agent participant, with its sessions on hover. Smithers app agents, coding agents, external agents and reviewers each have a stable participant id for their active session or run, their own avatar and an acting-for member when present (§14.6a). Never collapse an agent into that member’s avatar. Checks: C-J3-01, C-J6-01.

### 7.4 Live documents (Yjs) [S3]

7.4.1 One protocol: Yjs sync step 1 and 2, updates, and awareness, carried in binary frames on the live channel. One client provider serves both document kinds.

7.4.2 Two document hosts implement it:
- **Code files:** `smithers-machined` inside the branch machine owns the file and the document's durable state: it alone saves to disk and acknowledges saves (§9.2). Browsers sync with one document per topic and never learn where its Yrs authority lives (§7.6). ADR 0003 places that document by T-COL-11's decision rule: in the daemon, with the host relaying frames unparsed over its machine connection, or in a host-side mirror for fan-out that syncs with the daemon over the same connection. Either way the host authenticates each subscriber and tags its updates with the subscriber's actor, the side browsers sync with rejects an update under another actor's client id (§7.4.4), and §7.4.6 and §9.2 hold unchanged.
- **Wiki pages:** the host service owns the document (Yrs). It persists the merged state and the rendered Markdown in PostgreSQL, in one transaction and one revision, after 2 s without an update or 10 s after the oldest unpersisted update, whichever comes first, rather than per update. It acknowledges updates only after that commit (§7.4.6).

7.4.3 The wiki moves onto 7.4.1 in stage 3, together with code co-editing, and the earlier POST-update and SSE-refetch protocol is deleted then. There is one co-editing implementation.

7.4.4 Attribution of characters: each subscriber connection gets a Yjs client id that the host records as `client id → actor`. That map is stored in the document's own `Y.Map("authors")` so every host and reader resolves colours identically. Edits applied by `smithers-machined` for an outside writer use a client id allocated to that writer (§9.2.4).

7.4.5 Awareness carries `{actor, colour, line}` only; selections and carets are not shown (mvp.md §6.8 Cut). The card renders a gutter name flag per remote editor line.

7.4.6 **Saves, reconnects and epochs.** Both document kinds follow one acknowledgment and recovery rule (check C-DUR-04, K7 and K8):
- The authority sends `saved{sv}` (§7.1) once the state with state vector `sv` is durable: for code, after the daemon's file and state record are on disk (§9.2.2); for the wiki, after the host's PostgreSQL commit (§7.4.2). A client's own update with clock c is saved when `sv` maps the client's id to at least c. That alone drives a card's saved state, such as "Saved to the machine" on a File card.
- A client keeps every update that no `saved` covers and sends it again in sync step 2 after any reconnect. The wiki client keeps them in its local `worldDocuments` store across reloads. The code client keeps them in memory, where at most about 1 s of typing waits for a save (§9.2.2). A host mirror (§7.4.2) is a client of the daemon under this rule and relays `saved` unchanged; after a host restart it rebuilds from the daemon before it answers browsers.
- An authority recovers a document from its stored state, never by reseeding from text, so reconnecting clients share its item identities and their updates merge without duplication. The snapshot of a `doc:` subscription carries the document's `epoch`, a random 128-bit id. An authority makes a new epoch only when it has no readable stored state and seeds from text. A client whose epoch differs retains its unacknowledged edits in the recovery buffer (§9.2.5a), replaces its local document and syncs fresh, so it never merges two epochs. It shows "N edits weren't saved" with Reapply and Copy instead of dropping those edits silently. Check: C-DUR-04.

### 7.5 Terminals

Terminals keep their existing WebSocket and are not on `/api/live` [S2]. Kind 4 (input) is accepted only from the terminal owner. Input from anyone else is dropped, and the drop is counted (§8.11).

### 7.6 Write preconditions [S1]

7.6.1 Every write through Smithers carries `base_digest`; a stale write is refused. T-COL-10 owns the written contract and the existing std digest compare. The wiki keeps `Y.Text("markdown")`. Check: C-COL-01.

7.6.2 [S2] T-COL-03r (ADR 0004) defines the daemon-host wire contract, stream kinds, RPC requests, actor envelopes and outbox acknowledgements with Go/Rust codecs and golden frames when the daemon first uses them. Presence carries `{path, line}`; change events carry post-write digests; one machine serves each branch. Checks: C-COL-01, C-COL-02, C-COL-05.

7.6.3 [S3] T-COL-08 defines document topics, binary document frames, stream codecs, golden frames and capture flush when live documents first use them. Checks: C-COL-01, C-J3-04.

---

## 8. Branches and machines [S2; jj flows §8.5 and images §8.6 S1]

### 8.1 Identity

8.1.1 A branch is identified by its name. An item branch is named `smithers/<todo-slug>`, where the slug is derived from the TODO title, is ≤ 48 characters and is unique. A scratch branch is named `scratch/<member>/<name>`.

8.1.2 [S2] Every member and the coding agent who join a branch use its single machine: the lane's workspace, joined through write grants in the existing `workspace_shares` (consumer `B/services/workspace_access.go:42-110`). No per-person or per-agent copy of a branch exists (M-17). S1 adds no `branches` or `machines` table. Branch locks are deleted.

### 8.2 Capacity

8.2.1 Every limit derives from the host the install detects at start (M-06). With registered remote hosts, each host has its own limits and install capacity is their sum (§8.13.4). The install never assumes a Mac model. Host profile: `hw.memsize`, `hw.perflevel0.physicalcpu` (performance cores) plus `hw.physicalcpu`, free disk on the `$STATE` volume, the macOS version, and Hypervisor.framework availability. The ticket touching detection collapses the three host-profile readers to one; the check runner stops parsing the ops health line. Check: C-MCH-01.

| Limit | Formula | 24 GB / 8 P-cores / 200 GiB free | 32 GB / 10 / 400 | 64 GB / 12 / 1 TiB |
| --- | --- | --- | --- | --- |
| Machine memory | 8 GiB, or 6 GiB when host memory < 24 GiB | 8 | 8 | 8 |
| Machine vCPUs | `clamp(perf_cores / 2, 2, 4)` | 4 | 4 | 4 |
| Capacity | `min(floor((mem − reserve) / machine_mem), floor(perf_cores / 2), floor((free_disk − 40) / 32))`, reserve = 8 GiB; it may be 0 (§8.2.1a) | 2 | 3 | 6 |
| Layer budget | `min(48 GiB, 25 % of free disk)` | 48 | 48 | 48 |

The owner may lower capacity but never raise it above the formula. The T-MCH-01 measurements calibrate the reserve and the per-machine memory, not the shape of the formula. Settings shows the detected profile and the resulting limits.

8.2.1a Capacity can be 0, for example on a host with less than 14 GiB of memory or less than 72 GiB free. The host service then refuses to start a fresh install (no owner yet), and `smthrs host start` prints the limiting term and its fix, such as "needs 14 GiB of memory" or "free 9 GiB on Macintosh HD". The minimum host therefore runs one machine: memory of at least the reserve plus one machine's memory, 2 performance cores, and 72 GiB free on the `$STATE` volume. An install that already has an owner still starts when its capacity is 0 and serves everything that needs no machine. Its machine requests wait (§8.3), and Settings and `smthrs host status` show the limiting term and its fix (check C-MCH-04).

8.2.1b Free disk is re-read before every grant. The memory and core terms are fixed at start, and the disk term is recomputed from the current free disk on the `$STATE` volume. The scheduler grants only while `held` (§8.3.2) is below each of the memory term, the core term, the owner's capacity setting and `floor((free_disk_now − 40) / 32)`. Sleeping disks, retained history, layers and backups all reduce free disk, so their growth lowers capacity as it happens. A capacity below `held`, whether from disk or from the owner lowering it, stops new grants and never stops a VM that holds a slot (§8.3.3) (check C-MCH-11).

8.2.2 A layer-prepare VM holds a slot like any machine (§8.3.2). When a granted wake needs a layer that isn't built, the prepare VM runs inside that grant's slot, and the slot passes to the branch's VM once the prepare VM has stopped. A cold first boot therefore needs one slot, also at capacity 1. One build runs per recipe digest; a second grant that needs the same layer waits for that build and holds its own slot meanwhile (check C-MCH-11).

### 8.3 Admission

8.3.1 Admission extends the runtime’s in-memory admission under one mutex. Queue requests by holder and actor; rank holders by person, TODO, background, then FIFO within the highest class. Coalesce holders into one slot without merging actor cancellation. Return a typed capacity refusal. Check: C-MCH-11.

8.3.2 One in-process scheduler grants under the runtime mutex on events and a 1 s tick, within §8.2 limits. Count provisioning, waking, awake, releasing, prepare and background VMs until confirmed stopped. A prepare VM passes its held slot to the branch VM after stopping. Cancel only the leaving actor’s demand; release a holder when no demand remains. At restart, reconcile runtime VMs before admitting work and rebuild demand from live sessions and durable jobs; never persist a second admission queue. Force-stop an unconfirmed release after 60 s and retain its slot until confirmed. Collapse the existing start guards in the same change. Checks: C-MCH-02, C-MCH-11.

8.3.3 Preemption: none. A working coding agent is never paused to free a machine (M-13). When requests wait and capacity is full, the scheduler releases the longest-idle machine that is safe-idle (§8.4).

8.3.4 A granted request whose actor leaves before the wake finishes is cancelled, and the machine sleeps again if nothing else holds it. Its slot stays held until that stop is confirmed (§8.3.2).

### 8.4 Safe-idle and sleep

8.4.1 A machine is **safe-idle** when four things hold:
- no presence on its branch other than watchers of a finished run;
- no open terminal or SSH session;
- no running run step that needs the machine (a run waiting on a person, in review or paused doesn't count);
- no burst open, and every live document flushed.

8.4.2 Release order: first, waiting requests trigger release of the longest safe-idle machine. Otherwise a machine sleeps after 30 min safe-idle, or after 2 min safe-idle when its TODO is `in_review`, `needs_you` or `paused`.

8.4.3 Sleeping runs a final capture before the VM stops: flush documents, close bursts, jj snapshot, push the head ref to the host, and drain the outbox (§9.1.4). The disk is kept. Check: C-DUR-04.

8.4.4 Reading a sleeping branch never wakes it. Files, diff, activity and head come from the last captured snapshot in the host repository store (`refs/smithers/branches/<id>/head`). Only a person's work action or a TODO run wakes it: a terminal, SSH, an edit in a File card, a steer, an answer or a resume.

### 8.5 Fork, Add to stack, Rebase now [S1] (M-32)

8.5.0 Fork, Add to stack and Rebase now are system flows invoked only after the request authorizer admits the resolved command. A run may fork within its own explicitly bound authority; it cannot add to stack or rebase, even on its own branch (§5.2.0b). Check: C-ACC-01. Stage 1 implements them over today's workspaces: a fork's source is `main`'s tip or an item's last verified head, and forking a scratch branch waits for stage 2's capture (§8.5.2). The stack service is the only writer of branch history (M-32): every fork, place, reorder, rebase and merge appears in branch activity as "Smithers", with the requester shown ("Smithers, for Ben"). Requesters include a person and the app agent, under §15.1.5 permissions (fork and rebase: `run`; add to stack: `confirm`). The buttons and the agent delegate to the stack service.

8.5.1 A fork creates a scratch branch from a revision. Sources: `main` (its tip), an item (its last captured head) or any branch (its last captured head, after an on-demand capture if the branch is awake).

8.5.2 A fork MUST NOT stop the source machine. It starts from a revision, not a disk copy; uncommitted work is included only via the capture, which is a jj snapshot and therefore a revision.

8.5.2a **Rebase now** on a scratch branch rebases it onto the current head of what it was forked from: `main`'s tip, or the item's last verified head.

8.5.2b A Rebase now conflict on a scratch branch has no TODO to raise Needs you on. The Branch card shows the conflicted paths with Resolve, and the branch stays on its pre-rebase head until someone presses Done (§10.5.4). Scratch conflict completion uses the branch.rebase system command on POST /api/branches/{b}, bound to the retained conflict change and onto revision. It validates unresolved paths in the guest and advances the branch only after Done succeeds. A stale target or remaining conflict leaves the pre-rebase head and recorded paths unchanged. The Branch View renders these controls in S2 (T-APP-10); no synthetic TODO or coding run is created. Check: C-J7-03. The command descriptor and OpenAPI row pin the accepted typed payload to {conflict_change, onto_revision} using the existing change and revision id schemas; the subject branch comes from {b}. Check: C-J7-03.

8.5.3 **Add to stack** from a scratch branch creates a new TODO from the scratch branch's whole change since its seed base, placed like any other (default: directly after the item it was forked from, or appended for a fork of `main`). A fork records `forked_from {kind, ref, commit, base, item?}`. For a fork of `main`, `base` is the `main` tip it started from. For a fork of item Tn, `base` is the revision Tn's own change is measured from in the forked head (the previous item's verified candidate, or `main` for the first item, §12.5.1), and `item` is Tn. The seed therefore holds Tn's work as well as the scratch edits (J7.3). Add to stack takes the scratch head (from stage 2, after a capture of an awake branch, §8.5.1), makes the TODO's change one jj change with parent `base` and the scratch head's tree, and records its captured head plus proposed diff as revision-1 request context, through the stack service. Placement rebases that change like any other (§10.5). Placed after Tn, the part it shares with Tn merges cleanly when Tn hasn't changed since the fork, so its own diff is the scratch edits; a conflict follows §10.5.4.

8.5.3a Dropping Tn keeps Tn's work in every unmerged TODO forked from it. Before the drop rebases later items (§10.7.2), the stack engine squashes Tn's change into the first TODO after Tn in stack order whose `forked_from.item` is Tn (`jj squash --from <Tn> --into <Tk>`). Tk's tree is unchanged by the drop, and the items between Tn and Tk rebase without Tn's change. A TODO forked from Tn and placed before it already holds Tn's change. Check C-J7-02.

8.5.3b The scratch branch becomes the new TODO's item branch: it is renamed `smithers/<slug>` and keeps its machine, working copy and the people on it. A scratch branch's Diff card compares against its fork revision. [D] **Replace Tn**, which would make the scratch head the new head of item Tn's change, is deferred.

### 8.6 Images [S1]

8.6.1 A machine's root disk is built from a recipe. **Add to machine image** (an in-card control on Settings and on a failed step that names a missing tool) creates a TODO whose request asks to add the package to `.smithers/machine.json`. The recipe is the pinned base image, the toolchain detected from the repository (§8.6.2), the declared image additions (`.smithers/machine.json` `packages[]`, reviewed like any change, M-29) and the dependency install for the head revision, run as agent, never the broker. The recipe digest keys a layer cache, so two branches with the same recipe share layers.

8.6.2 Toolchain detection reads these files and nothing else. The supported envelope is Node, Go, Rust and Python. A repository with none of them gets the base image only, and a run step that needs a missing tool fails, naming the file to add.

| File | Detected |
| --- | --- |
| `.node-version`, `.nvmrc`, `package.json#engines.node` | Node version |
| `package.json#packageManager`, lockfiles (`pnpm-lock.yaml`, `package-lock.json`, `yarn.lock`, `bun.lock[b]`) | Package manager + install command |
| `go.mod` (`go` and `toolchain` directives) | Go version, `go mod download` |
| `rust-toolchain.toml`, `Cargo.toml` | Rust toolchain, `cargo fetch` |
| `.python-version`, `pyproject.toml`, `uv.lock`, `requirements*.txt` | Python version, `uv sync` / `pip install` |

8.6.2a Detected tool versions resolve through a pinned toolchain manifest shipped in the install bundle (`toolchains.json`: version → download URL → SHA-256), updated each release. A version absent from the manifest resolves to the nearest pinned patch of the same minor version, or fails naming the file to change.

8.6.3 "Source ready" means the mirror holds `main`. "Machine ready" means the first recipe for `main` is built. They are separate setup steps (J1.4).

### 8.7 Homes and logins

8.7.1 Member homes are per machine (product, 2026-10-02; mvp.md §6.8 Terminals). Each is `/home/<login>` on the machine's own disk, created by the guest helper at the member's first session on that machine, owned by their uid with mode 0700. The disk is kept across sleep (§8.4.3), so tool history, caches and databases persist per machine. No home is shared between machines. Spike T-MCH-02 (#3437, C-SPK-02, `.artifacts/checks/C-SPK-02/20261002T212556Z/`) showed why. Two awake VMs writing one virtiofs home lost data: 2,739 missing append records, 4,499 SQLite errors and 3,014 acknowledged WAL rows lost. (The spike's "0/6 cross-VM lock exclusion" had no positive control, so it isn't cited as proven.) `msb` can't add a mount to a running VM, so per-member mounts can't serve a member added while a machine is awake. One shared mount kept guest `chown` (6/6 across reboot and a second VM) but failed because its root `/home` presents as `0:0 700`, so members can't traverse into their homes; a `0711` root is untested. Homes on the machine's own disk avoid all three issues, so homes use no virtiofs.

8.7.1a Disk: homes count against the machine's root disk, which §8.2.1 sizes from the host profile. A machine recreated from a new recipe starts with empty homes, and each person logs in to tools again on that machine (§8.7.3, C-MCH-10).

8.7.2 Nothing in a home is readable by `agent`, by other members, or by the host service's flows. Tool credentials stay in the member's home on that machine; no flow, API or card returns their values. Check: C-MCH-10. The sole transcript exception is §9.6.6: an owner-uid child reads that session owner's identified Claude Code or Codex transcript for M-38. Only normalized conversation content is shared on the branch. Raw files and unrelated home history remain inaccessible to other members and flows. Check: C-AGT-02.

8.7.3 **Per-machine tool logins.** A person logs in to Claude Code, Codex, `gh` or another tool separately on each machine. The login persists in that machine's home across sleep and wake. Tokens, tool history, caches and databases stay on that machine. Smithers never seeds, watches, uploads or copies tool tokens between machines. Check: C-MCH-10; the live 24 h persistence soak is C-REL-05.

8.7.3a [D] Logging in once per install through a synced per-member credential store is deferred to product §16 because machines compete to refresh the same token. T-MCH-15 is deferred. Per-person homes remain in T-MCH-11. Check: C-MCH-10.

### 8.8 Secrets

8.8.0 A secret that declares hosts stays egress-bound, as today: the relay substitutes its value only toward those hosts, and the value never enters the machine. Only secrets without declared hosts become environment variables (§8.8.1).

8.8.1 [S2] All-branches secrets without declared hosts are written to `/run/smithers/env` (root:team 0640) at boot, and rewritten by the daemon within 5 s of a change. New sessions and runs load the new values; running processes keep theirs. Any session on a machine can print these values: "nobody reads values back" applies to the API and the Secrets card, as with GitHub Actions secrets. [D] Recording each use by run is deferred.

8.8.2 Main-only secrets reach only trusted runs on `main`, in an ephemeral background machine: a manual run by a maintainer (schedules are deferred with triggers). They never reach item or scratch branches, agent runs or outsider-triggered runs (D-24).

8.8.3 Provider model keys never enter a machine. The coding agent's model calls go through the host's model proxy with a `run` credential (§15.2).

### 8.9 Network

A machine's egress is open to the internet by default for package installs, through the host egress relay with per-run audit. Bound secrets are swapped in by the relay for their allowed hosts only. The host service is reachable from a machine only on the relay port.

### 8.10 SSH gateway

8.10.1 The host listens on port 2222 (§1.4). The username is the branch name or slug, for example `retry-webhooks`, which resolves `smithers/retry-webhooks` and then `scratch/*/retry-webhooks`. Ambiguity is an error that lists the candidates. The install composition uses branch-name usernames. Plue's composition keeps its `<sandbox>+<user>` login form.

8.10.2 Authentication: the public key must match one of the member's keys. Keys are the member's GitHub keys (`GET /users/{login}/keys`, refreshed at sign-in and hourly, cached) plus keys added with `smthrs ssh-key`.

8.10.3 The gateway admits a `person` wake request (§8.3) and then proxies the session into the machine as the member's unix user, in the working copy directory. Machines run no sshd. The gateway maps SSH channels onto the daemon's session primitives (§9.1.2):
- shell and exec become a PTY or process as the member's uid in a new session cgroup;
- `subsystem sftp` becomes `sftp-server` as the member;
- `direct-tcpip` becomes a TCP connect to the guest's loopback port.

Exit status, exit signals, window changes, signals, EOF and flow-control windows map one to one onto the session protocol (§9.6.2). That is what VS Code, Cursor and Zed remote need, and spike T-TRM-06 proves it with VS Code before the stage-2 daemon work (C-SPK-08). SSH agent forwarding and remote forwarding (`tcpip-forward`) are refused in the MVP.

8.10.4 Presence shows "Maya via SSH" while the session lives, with where = the file last written by that session.

8.10.5 The SSH host is the host name of the install's first public origin, or `localhost` when none is set. The Branch card copies `ssh -p 2222 <branch>@<host>`; `smthrs ssh <branch>` is the alternative.

### 8.11 Terminals

8.11.1 A terminal is a PTY session that the daemon starts as the owner's unix user, in the working copy, in its own session cgroup. The host's terminal manager attaches to it over the daemon connection and serves it on the existing terminal WebSocket (§7.5). It is signed in to Smithers (§5.3.2). In stage 1, before the daemon exists, terminals keep today's `msb exec -t` path as the guest's single user. The stage-1 terminal token is therefore readable by the coding agent. It is minted only when a member opens a terminal, expires with the session, and is limited to: reads the member can do; `todo.answer` and `todo.steer` on that branch's TODO; `todo.new` (append only, delegated A✓ with a private Confirm card or 403 permission/confirm_in_app under §5.3.2a); and wiki reads. `Authorize` enforces the list (check C-SEC-05). No release ships stage 1 alone. Person commands use the authenticated host terminal UI broker; guest CLI/skill calls use only the delegated credential bound to that terminal session, never a shared current-token file. Checks: C-SEC-05, C-J6-01.

8.11.2 [S2] Any member on the branch may watch; their view is read-only, and only the owner types (M-18). [D] **Ask to type**, with Allow and revoke, is deferred.

8.11.2a [S2] The coding agent's `bash` tool runs in the agent's own terminal session on the branch: a daemon PTY owned by `agent`, attributed to the run. Its commands therefore render in the Terminal card like anyone's (one card per flow, whoever runs it), and members can watch it read-only. Command output still returns to the agent as the tool result.

8.11.3 A terminal survives browser reloads through the ring replay (512 KiB). It does not survive a machine sleep, an install restart or a daemon restart (§9.6.4). A terminal open on a branch prevents safe-idle (§8.4).

### 8.12 Cleanup

A machine's VM and disk are deleted only when four things hold: its TODO is merged or dropped (or its scratch branch is archived), a final capture succeeded and the head ref equals the captured head, no terminal or service is active, and 24 h have passed. Services still running on a settled branch are stopped after those 24 h. History, activity and evidence remain in PostgreSQL and the repository store.

### 8.13 Placement and remote machines [S1; branch machines S2; Cloud boxes S2] (M-40)

Will's ruling (2026-10-04, product position on #3706, M-40 pending in mvp.md): sandboxes run on this machine or on remote machines, behind one flag. This section amends §1.3, §8.2 and §10.3. "Machine" below means a TODO's workspace in stage 1 (T-MCH-14) and a branch machine from stage 2 (§8.1.2). Both run on one `WorkspaceRuntime` (`packages/backend/workspace/contracts.go`).

8.13.0 **Reconciliation pending (Will, 2026-10-04 ~13:30 PT, #3706).** Remote machines reuse the Smithers Cloud machinery from Plue: a controller with a host registry and scheduler, and a `microsandbox-worker` per computer that boots microVMs and registers by signed heartbeat over mutual TLS, behind Plue's controller-backed `WorkspaceRuntime` adapter. The install does not get a new SSH-prefixed runtime. Until this section is rewritten from smithers-56's spike of that stack on `beaver`:
- **Still in force:** §8.13.1 (only the machine moves; engine, journal, keys and merge stay on the install), §8.13.2 (the flag), §8.13.4 (capacity per computer, summed), §8.13.5 (placement, pause, forks), §8.13.6 (unreachable and Remove) and design placement.md.
- **Superseded:** §8.13.3's SSH key registration and probe, §8.13.7's install-dialed SSH connection and reverse forwards, and §8.13.8's two Cloud branches. Registration, reachability and Cloud follow the controller and worker.
- **Open (product, 98):** where the controller and worker run for a self-hosted install, which today live in Plue; and whether a worker that dials the controller requires the install to be reachable from each computer, which §1.4's loopback default does not allow.
T-RMT-02, T-RMT-03 and T-RMT-04 are on hold; T-RMT-01 is replaced by smithers-56's spike.

8.13.1 **Placements.** A machine runs on a **machine host** (product word: **computer**, design placement.md): `this-mac`, the install's own host, or a **remote host** the owner registered. `this-mac` always exists and is the default. Only the machine moves. The engine, the stack service, the journal (PostgreSQL), the repository store, merge, the model proxy and every provider key stay on the install. A remote host holds only the VMs placed on it and their disks. Check: C-RMT-03.

8.13.2 **The flag.** `remoteSandboxes` (Go `feature_flags.remote_sandboxes`, environment `SMITHERS_REMOTE_SANDBOXES`, app `AppFeatures.remoteSandboxes`) is set in the install's config, has no UI, is off by default and gates every remote placement, Cloud included. It is a separate flag from the existing `remote_sandbox_enabled` (iOS and desktop remote clients); a config test asserts the two are distinct keys. While it is off:
- new machines go only to `this-mac`;
- `PUT /api/install` refuses adding a host with class `disabled`, and the Computers list and the Runs on control don't render (design placement.md "The flag");
- a host that still holds machines keeps its row ("beaver · 2 branches · remove to finish") and those machines keep running and waking there until the owner removes the host (§8.13.6).
Check: C-RMT-02.

8.13.3 **Registering a remote host.** Owner only (§5.2), in Settings. A remote host is a Linux machine (arm64 or x86_64) reachable by SSH, with `/dev/kvm`, where the install runs the same pinned `msb` and guest image it runs locally. Registration stores `{name, ssh: user@host[:port], host_key, state_dir}` under the `install_settings` key `machines`.
1. The install generates one ed25519 key pair per install, seals the private key in `install_settings`, and shows the public key for the owner to add to `authorized_keys`.
2. The first connection pins the host key. Settings shows its fingerprint, and the owner confirms it. A later mismatch refuses every connection to that host with class `security` until the owner re-confirms.
3. A probe over SSH reads the profile (§8.13.4), checks `/dev/kvm`, installs or verifies the pinned `msb` and pulls the guest image for the host's architecture. A host without KVM is refused naming the fix ("needs /dev/kvm"). Repository code never runs on a remote host outside a microVM: no plain-SSH or container execution path exists (§1.3, M-29, M-30).
A remote host is trusted like the install's own host for the machines placed on it: its root can read their disks. Settings says so beside **Add machine**. Check: C-RMT-02. Security review: smithers-3f must approve before this lands.

8.13.4 **Capacity.** Each host has its own profile and its own §8.2.1 limits. On a remote host the profile comes from `/proc/meminfo`, physical cores (the core term uses physical cores where macOS uses performance cores) and free disk under `state_dir`, re-read before every grant as in §8.2.1b. Install capacity is the sum over reachable hosts. The owner may lower any host's capacity, never raise it. An unreachable host contributes 0 and keeps the slots of machines it holds until they are confirmed stopped or moved. `parallel` (§10.3.1) defaults from the summed capacity. Check: C-RMT-04.

8.13.5 **Placement at wake.** The admission scheduler (§8.3) grants a slot on a specific host. A machine with no disk yet goes to its TODO's **Runs on** value: `auto` (default, not stored on the TODO) or a host name, set on the Draft card or by Edit while Queued. `auto` picks the online host with the most free slots; ties go to `this-mac`. A pinned TODO waits for its host even when another has room. A fork runs where its origin branch runs; a fork from `main` is `auto`. A machine that has a disk wakes on the host that holds it. The owner may **pause** a host, `this-mac` included: no new machines go there and awake ones keep running. Paused, unreachable and signed-out hosts contribute no capacity. Main-only secret machines (§8.8.2) run on `this-mac`; each host builds its own layers. Cards show the host only once a second host exists ("retry-webhooks · awake · beaver"). Check: C-RMT-04.

8.13.6 **Unreachable and removal.** A host that fails its connection for 60 s is unreachable. Its awake machines show "Machine unreachable · beaver" with **Retry**; their running TODO step fails with class `computer_unreachable`; asleep ones read "Asleep · beaver unreachable", and reads of them still come from the host store (§8.4.4). The owner may **Remove** a host with no machines. Removing an unreachable host that holds machines closes them; each branch's activity records "Closed · beaver removed by <owner>", and queued TODOs pinned to it move to `auto`. A TODO whose machine was closed this way restarts on Retry from the last head the install holds (the last candidate in stage 1, the captured head from stage 2), placed by `auto`; uncaptured work and homes on the removed host are lost, and the Remove confirmation says so. The old disk is deleted if the host is ever reachable again (§8.12). Check: C-RMT-04.

8.13.7 **Reaching the install.** The install always dials; a remote host never needs inbound access to it, so loopback-only installs (§1.4) work. Per remote host, the install keeps one SSH connection that runs `msb` and carries reverse forwards for the endpoints a guest uses on `this-mac`: the host-relay port (§8.9, §9.1) and the endpoints the in-guest Flow host uses today (its journal database and the model proxy, `flowhost/journal_database.go`, `flowhost/model_credential.go`). The forwards bind the remote loopback only. Guest egress leaves through the install's egress relay over the same connection, so audit and host-bound secret substitution (§8.8.0) are unchanged. The connection reconnects with backoff from 250 ms to 5 s, like §9.1.1. T-RMT-01 measures whether this path meets C-PERF budgets for package installs. Check: C-RMT-03.

8.13.8 **Cloud boxes** [S2]. Smithers Cloud is a remote host kind. If spike T-RMT-01 shows that a Cloud box runs `msb` under nested KVM, a Cloud box registers like any remote host, through `CloudSandbox`'s SSH grant (`packages/smithers/src/CloudSandbox.ts`) instead of a stored key. Otherwise T-RMT-05 adds a second `WorkspaceRuntime` adapter in which the Cloud box itself is the machine. Cloud billing stays out of the MVP (M-09). Check: C-RMT-05.

8.13.9 **Flows that select a sandbox.** A prompt flow's `sandbox:` frontmatter selects a provider from `Application.Config.sandboxProviders`. That path is unchanged. Registered hosts are not added to it in the MVP: TODO work is placed by §8.13.5, and the install's flows run inside the machine. [D] Exposing registered hosts as `command` providers to `sandbox:` flows.


---

## 9. The machine daemon (`smithers-machined`) [S2; documents S3]

A static Rust binary (linux-arm64, musl) that starts inside every machine before any session. It runs as a root broker and an unprivileged daemon (§9.5). It is the only process that writes the working copy on behalf of Smithers, the only observer of writes, the supervisor of every session (§9.6), and the machine's single connection to the host.

### 9.1 Connection

9.1.1 `smithers-machined` keeps one multiplexed connection to the host over the host-relay port. It authenticates with the boot's `machine` credential, and the host authenticates to it (§9.5.3). The side that dials (the daemon on `bridge`, the host on `relay`) reconnects with backoff from 250 ms to 5 s; after authentication the daemon resends its outbox (§9.1.4). Check: C-DUR-04. Streams on the connection: control RPC, change events, live-document frames, presence, object streams (ADR 0004; Security review: smithers-3f must approve before this lands (gaps 5–8)), and one stream per session (§9.6.2).

9.1.2 Control RPC:
- `capture()`: flush documents, close bursts, snapshot, send the head and the versions commits named by pending events as git bundles on ADR 0004 object streams, drain the outbox (§9.1.4), and return the head commit and its tree (§10.4.4). Checks: C-DUR-04, C-STK-06. Security review: smithers-3f must approve before this lands (gaps 5–8);
- `read_file(path, at?)`;
- `write_file(path, base_digest | "absent", content, actor)`: the §7.6 compare-and-write, run under the mutation lock (§9.4.1);
- `open_session(user, kind: pty|exec|sftp, argv?, size?)`, `tcp_connect(port)`, `close_session(id)`, `kill_sessions(user | run)` and `attach_session(id, received)`: §8.10.3, §8.11, §9.6. The File card's language server is an `exec` session owned by the member who asked for code intelligence, one per (member, language), closed after 10 min without a request or when the machine sleeps; it doesn't count toward safe-idle (§8.4.1). Check: C-UI-11;

- `register_run(run_id, session)`: the host calls it after it starts a run's coding host with `open_session(agent, exec)`, so writes by that session's processes resolve to the run. Only the host can call it (§9.5.3);
- `rebase(onto)`: §9.4;
- `return_to_item()`: §9.3.8;
- `wake_reconcile(head)`: the host sends its head’s objects on an ADR 0004 object stream, waits for the daemon’s stream `close`, then calls it on every boot before any session starts. If the host rebased the branch while it slept (§10.5.5), it moves or rebases `@` onto that head and emits "Rebased onto Tk". A conflict becomes `needs_you{conflict}` on wake. Check: C-DUR-04. Security review: smithers-3f must approve before this lands (gaps 5–8);
- `status()`;
- [S3] `open_doc(path)` returns a stream id; `close_doc(stream)` closes that stream (ADR 0004, T-COL-08b). Check: C-COL-01.

9.1.2a Each capture is one jj operation, as is any jj command a person runs. Nothing outside the machine references a jj operation: activity uses burst versions commits (§9.3.4) and reads use the captured head (§8.4.4), both in the host store. Weekly, the daemon abandons operations older than 7 days (`jj op abandon`) and runs `jj util gc`, so the operation log holds at most 14 days. T-COL-01 measures snapshot latency (target under 500 ms); T-COL-11 measures the disk growth of 1,000 captures and records the retention decision.

9.1.3 The guest's init supervises the broker, and the broker restarts the daemon on exit, with backoff, after ending every session (§9.6.4). While a machine is awake, capture runs after every burst (coalesced to one per 5 s) and at least every 5 min.

9.1.4 **Outbox.** Every event the daemon sends goes through an on-disk outbox (`/var/lib/smithers-machined/outbox`) that survives daemon and VM restarts. Only `file_written` and presence skip it: they are hints, sent directly. Check C-DUR-04.
1. Before an event enters the outbox, every object it names (a versions commit, a captured head) is durable on the machine disk (`syncfs`) and held by a local ref, `refs/smithers/pending/<event id>`, so `jj util gc` keeps it.
2. The daemon appends the event with a monotonic `seq` and a unique `event_id`, and `fsync`s the outbox.
3. In `seq` order, the daemon sends each batch’s objects as one git bundle on an object stream of the connection (ADR 0004), then the events. A batch never skips an event. Check: C-DUR-04. Security review: smithers-3f must approve before this lands (gaps 5–8).
4. The host confirms that every named object is in its store; otherwise it answers `missing_objects` and the daemon resends a bundle using the host’s `haves` as prerequisites (ADR 0004). In one transaction it applies the event and inserts a receipt `(branch, event_id)`, then acknowledges `seq`. An event whose receipt exists is acknowledged without being applied again. For `captured`, the host moves the head ref only when the event’s `base` equals the head it last sent this machine; otherwise it records the receipt, sets `rebase_pending` and acknowledges `stale_base`. The daemon deletes that entry and pending ref but leaves `refs/smithers/acked/head` unchanged. Check: C-DUR-04. Security review: smithers-3f must approve before this lands (gaps 5–8).
5. The daemon deletes acknowledged entries and their pending refs.

After a reconnect, a daemon restart or a VM restart, the daemon resends every unacknowledged entry in order. `capture()` returns only when the outbox is empty, so sleep (§8.4.3) and cleanup (§8.12) never drop an event.

### 9.2 Live code documents [S3]

Stage 2 has no co-editing. An open File card is read-only to everyone except through SSH, the terminal and the agent, and it reloads within 1 s of a change event (§9.3.4) that touches its path. Stage 3 adds everything below. It all runs in the daemon under either ADR 0003 topology (§7.4.2): with a host mirror, the daemon keeps its own replica of each document, saves and acknowledges it, and the mirror is one more client (§7.4.6).

9.2.1 A document opens on the first subscriber. `smithers-machined` loads its state record (§9.2.5), or, when it has none, reads the file and seeds a Yrs document with a single `Y.Text("content")`. Only UTF-8 text files up to 1 MiB are live-editable. Larger or binary files open read-only, with a "too large to co-edit" state.

9.2.2 **Document → disk.** The daemon saves a document 200 ms after its last update, and at least once a second while updates continue. One save:
1. Writes the *state record* `/var/lib/smithers/docs/<path digest>`: the epoch, the full Yrs state with `Y.Map("authors")`, the text being saved, its digest, and the previous save's digest. Temp file, `fsync`, `rename`, then `fsync` of the directory.
2. Writes the text to a temp file beside the target, `.smithers-doc-<path digest>-<random>`, and `fsync`s it.
3. Swaps it into place with `renameat2(RENAME_EXCHANGE)` (`RENAME_NOREPLACE` when the path is absent) and `fsync`s the directory. The temp name now holds the displaced file.
4. Deletes the displaced file if its digest equals `last_disk_digest`. Otherwise an outside write landed after the daemon last read the path: the daemon keeps the displaced file open, reads it again once it has had no write for 200 ms (at most 2 s), deletes it, and reconciles those bytes as an outside write (§9.2.3). The outside save is kept whichever comes first, the watcher's event or the save.
5. Sets `last_disk_digest` to the saved digest and the merge base to the saved text, then sends `saved{sv}` (§7.4.6).

Steps 1–3 and 5 run under the mutation lock (§9.4.1); the step 4 wait doesn't hold it. The saved file keeps its mode; its owner becomes `machined`, and its group stays `team` (§9.5.1). A process that holds the file open and writes after step 4 writes into the deleted file, as with any editor's atomic save. The daemon knows its own writes by path and post-write digest and excludes them from watcher bursts. It adds `.smithers-*` to `.git/info/exclude`, so jj and git never track its temp files. Document edits get their own activity entries instead: one per editor per idle period (2 s), for example "Alice edited retry.ts".

9.2.3 **Disk → document** (mvp.md §6.8 save and recovery). The daemon reconciles an open document's path when an outside write to it completes (`IN_CLOSE_WRITE` or `IN_MOVED_TO`, never `IN_MODIFY`) or a save displaces one (§9.2.2 step 4). Under the mutation lock it reads the path's current bytes. If they equal `last_disk_digest`, it does nothing, so late or coalesced events never apply stale content. Otherwise it merges three ways, with base = the text of its last save, ours = the live document and theirs = the bytes read, and the outside burst records those bytes as the path's version (§9.3.4):
- **No overlap:** the outside changes apply to the document as one transaction attributed to the outside actor (§9.3.1), and card readers see them within 1 s (§18).
- **Overlap:** the live document wins on disk. The outside version stays recoverable as its burst's `after` version (§9.3.4). The daemon applies the non-overlapping outside hunks, saves the document, and flags the file "Changed outside Smithers · Compare" (`file.compare` opens that version against the document).

9.2.3a Saved means on disk (fsync'd) within 1 s of the keystroke and surviving a restart of the machine or the install. A restart never loses an acknowledged save: one that a `saved` frame covers (§7.4.6).

9.2.4 Attribution of outside edits: each outside actor (a person's session, the coding agent or a terminal tool) gets a stable Yjs client id per document, recorded in `Y.Map("authors")`. The edit is produced in a scratch document with that client id, synced from the live state, and its update is applied to the live document. The cost is O(document size) per outside edit, which the 1 MiB limit bounds.

9.2.5 A document closes 60 s after its last subscriber leaves, after a final save. Its state record (§9.2.2) stays on the machine disk outside the working copy, so authors survive reopening. When the daemon opens a document, including after its own restart, it loads the record and compares the file on disk:
- the record's digest: the document is as saved;
- the record's previous digest: a save stopped before its swap, so the daemon finishes it by writing the record's text;
- anything else: an outside write while the document was closed or the daemon was down, reconciled as in §9.2.3 with base = the record's text, so existing characters keep their authors.

9.2.5a A leftover `.smithers-doc-<path digest>-*` file is either an unswapped save, which matches the record and is deleted, or a displaced outside write (§9.2.2 step 4), which the daemon reconciles the same way and then deletes. Only a missing or unreadable record seeds the document from the file, with a new epoch (§7.4.6). The file on disk stays the truth for what is saved. On reconnect to a recovered document, the client retains every local edit not covered by its last `saved` acknowledgment. If recovery cannot merge those edits, including an epoch change (§7.4.6), the editor shows "N edits weren't saved", where N counts the retained local edit transactions, with **Reapply** and **Copy**. Reapply submits them as new edits attributed to the member in the recovered document; Copy copies their retained text. The client keeps this recovery buffer until Reapply is acknowledged or Copy succeeds. Check: C-DUR-04.

9.2.6 **Delete and rename while open.** In stage 2 the File card shows the same states from `file_written` and burst events. Restore rewrites the delete burst's `before` version (§9.3.4), and Follow opens the new path. In stage 3, a delete marks the document `gone{kind: deleted, by}`, and editing pauses. **Restore** rewrites the last document text. A rename to a new path inside the working copy marks it `gone{kind: renamed, to, by}`, and **Follow** reopens the document at the new path.

### 9.3 Watching and attribution (M-27) [S2]

9.3.1 `smithers-machined` watches the working copy with inotify (recursive watches, re-armed on directory creation). Writes are attributed as follows (mvp.md §6.8, v2.5):
- **Writes through Smithers carry their exact author.** File documents, coding tools and app commands retain the person or agent participant id, agent kind, session/run id and acting-for member (§14.6a). The daemon performs the write (§9.4.1), records that actor with its path and digest, and never attributes its own inotify events to another actor. Activity, line flags and terminal ownership use this same actor; a reviewer write retains the reviewer participant. Checks: C-J3-01, C-J6-01.
- **Other writes** (terminal tools, SSH editors, the agent's `bash`, hand-run `git`/`jj`) form bursts, attributed to the actor of the only session active on the branch during the burst. A session is active when any process in its cgroup used CPU during the burst window (`cpu.stat` `usage_usec` grew), so a shell idle at its prompt doesn't count. Sessions are the broker's sessions (§9.6): people's terminals and SSH sessions, and the run's coding host and terminal. Processes left running after a session closes still count as that session (§9.6.3). When more than one session is active, or none, the burst reads "changed outside Smithers" (actor `{outside: true}`).
- [D] Exact per-write kernel attribution (fanotify with writer pids) is deferred.

9.3.2 An inotify queue overflow (`IN_Q_OVERFLOW`) starts a resync under the mutation lock, before any other write runs (check C-COL-05):
1. Remove and re-add every watch, scanning each directory, so directories created during the overflow are watched.
2. Take a jj snapshot and compare every tracked path with its recorded version (§9.3.4). Record the differences as one burst "changed outside Smithers" (`{outside: true}`).
3. Reconcile every open document from disk (§9.2.3), so live documents show the current bytes.
4. Run the moved-off check (§9.3.8).

Writes queued during the resync run after it.

9.3.3 **Ignored paths** produce no activity. Ignored means everything `jj` ignores (`.gitignore`, `.jj/`, `.git/`), plus the dependency and build paths the toolchain detector names (`node_modules/`, `target/`, `.venv/`, `dist/` when gitignored). Ignored directories get no activity watch, and any other event for an ignored path is dropped in user space. Metadata watches are separate and never produce activity: `.jj/repo/op_heads/heads/`, `.git/` (not recursive, for `HEAD` and `packed-refs`) and `.git/refs/` (recursive). Their events run the moved-off check (§9.3.8) once they stop for 200 ms. Paths that are not valid UTF-8 produce no activity; capture still snapshots them. Check: C-COL-05.

9.3.4 **Bursts.** Writes through Smithers group by their exact actor. All other writes on the branch share one key, so at most one outside burst is open at a time, and its actor is decided at close (§9.3.1). A burst opens on its first write and closes after 1.5 s without a write for its key, 10 s after it opened, or before a write with another key touches a file the burst touched. Writes and closes run under the mutation lock (§9.4.1). Before each write through Smithers, the daemon drains pending inotify events, so outside writes that completed earlier are counted first. Check C-COL-05.
- **Versions.** Every path has a *recorded version*: a git blob, in the working copy's object store, of its content as last counted. A write through Smithers records the content it writes when it writes it. An outside burst records each touched file at close, except a path with an open document, whose version is the bytes the reconcile read (§9.2.3). A path untouched since the last capture has its blob in that capture. Per file, a burst keeps `before` (the recorded version when the burst first touched it) and `after` (the version it recorded last). A write that touches another key's file closes that burst first, so neither side ever includes another actor's change, even when bursts overlap or two actors write one file in turn.
- `file_written{path, actor, post_digest}`: sent within 200 ms of each write to a tracked path, so open cards reload in under 1 s (§18).
- The burst event, on close. The daemon builds one *versions commit*, a parentless git commit whose tree holds each file's `before` at `a/<path>` and `after` at `b/<path>` (an absent side is omitted). It sends `{burst_id, actor, files[{path, change, renamed_to?, before_blob, after_blob, post_digest}], versions_commit}` through the outbox (§9.1.4), which sends the commit as a git bundle on the daemon connection (ADR 0004); the host verifies the objects and publishes `refs/smithers/branches/<id>/bursts/<burst>`, so a sleeping branch's activity and diffs never need the machine. Check: C-DUR-04. Security review: smithers-3f must approve before this lands (gaps 5–8).

Document edit entries (§9.2.2) carry versions the same way, from the editor's first save in the period to its last.

The host turns it into one activity entry, for example "Maya via SSH changed 12 files", which opens each file's diff from `before` to `after` and nothing else, plus one `burst_files` row per file. Open File and Diff cards whose paths changed reload. Every burst's end state is therefore recoverable from the host store ("recoverable from snapshots", M-27).

9.3.5 **Restore this file** (`file.restore`, in-card on an outside-change diff) writes one file's `before` version from that burst back through `write_file`, with the burst's `post_digest` for that file as `base_digest`. If the file changed since that burst, the write is stale, and the card opens Compare instead of overwriting. The write is attributed to the person who pressed it. Each burst's end state is recoverable; states inside a burst are not guaranteed. [D] Per-entry Undo of a whole burst stays deferred.

9.3.6 [D] Command names on entries.

9.3.7 [D] Out-of-band stale-save flags ("Ben's save replaced Alice's edit · Restore"). Detection rule, for the record: let B be the content the writing session last opened, P the pre-image and W the new content. Flag when merge3(B, P, W) ≠ W and the merge has no conflict.

9.3.8 **Moved off the item.** When a metadata watch fires (§9.3.3), and after every overflow resync (§9.3.2), `smithers-machined` checks two conditions, attributing the move like a burst (§9.3.1). The working-copy commit `@` must still descend from the branch's item change, and that change must still be present. If either fails, it emits `moved_off{by, item}`. The TODO enters `needs_you{kind: moved_off}`, and the coding agent stops writing. **Return to Tn** (`return_to_item`) runs `jj edit` back to the working-copy commit from before the move (`@` of the latest operation in `jj op log` whose `@` descends from the item change), under the §9.4.2 sequence; anything written afterwards stays in its own commit and is recoverable. **Keep for now** records the move, and the TODO stays in Needs you until the working copy is back on the item. Both are in-card controls (§6.1.2). The coding agent's write tool refuses with `moved_off` while the branch is moved off. The stack keeps the item's last captured change throughout.

9.3.9 **Agent awareness.** Each change event not caused by the coding agent is appended to the coding agent's transcript as a system note before its next tool call: "Maya via SSH changed `retry.ts`, `deliver.ts`". The agent's file-write tool MUST re-read a file whose digest changed since the agent last read it before writing (`stale_read` refusal otherwise).

### 9.4 The mutation lock and rebase safety

9.4.1 **One mutation lock.** The daemon makes every working-copy write under one lock per branch, in arrival order: `write_file`, document saves (§9.2.2), burst closes (§9.3.4), `capture()`, `rebase(onto)`, `return_to_item()`, `wake_reconcile()` and the overflow resync (§9.3.2). `write_file` uses the save's swap: a temp file, `renameat2(RENAME_EXCHANGE)` (`RENAME_NOREPLACE` for base `"absent"`), then a digest check of the displaced file. If the displaced file isn't the base, the daemon swaps it back and answers `409 stale`, so a stale write never applies, even when an outside write lands between the check and the swap. A `write_file` to a path with an open document compares `base_digest` with the document's text, not the disk, and applies as one document transaction attributed to its actor (§9.2.4). Check C-COL-03.

9.4.2 **Rewrites stop every writer.** A rebase of the branch's change (§10.5) and `return_to_item()` rewrite files from jj, so they also stop processes outside Smithers. Holding the lock, the daemon:
1. freezes the parent cgroup of every session (§9.6.1) with `cgroup.freeze` and waits for `frozen 1`, at most 1 s. On timeout it thaws, answers `busy`, and the rebase stays pending;
2. drains the inotify queue and closes every open burst;
3. takes a local capture: flush documents, snapshot, and pin and queue the snapshot in the outbox, so every writer’s work is captured first (mvp.md §4.2). The rewrite does not wait for the host’s acknowledgement. Checks: C-COL-03, C-PERF-06;
4. rewrites: `jj rebase -d <onto>` on the item change, or `jj edit`;
5. reconciles each open document from disk as one transaction attributed to the operation, for example "Rebased onto Tk" (§9.2.3), which keeps unsaved typing;
6. thaws the sessions and releases the lock.

9.4.2a Browsers keep typing into open documents throughout; only saves wait. Queued `write_file` calls then run against the new content, so a stale `base_digest` gets `409 stale` (§7.6), and the writer re-reads. The lock is held under 2 s at p95 (C-PERF-06). C-COL-03 proves that no writer's write is lost or lands mid-rewrite. During the freeze, everyone sees "Rebasing…" on the branch and on each frozen terminal. After success, activity records "Rebased onto Tn" with the actual target TODO. If step 1 times out, the branch keeps "Rebase pending", the host retries automatically, and the presser sees the blocking writer, for example "Waiting for a write in Ben's terminal". The daemon includes that session in its `busy` response. Checks: C-COL-03, C-PERF-06.

### 9.5 Privilege and confinement [S2]

9.5.1 The binary runs as two processes. The **broker** runs as root and does only what needs root: it creates, freezes and kills session cgroups; starts session processes as their user (§9.6); writes `/run/smithers/env` (§8.8.1); reads and writes a member's home and `/run/smithers/<uid>/` through a child that has dropped to that member's uid and gids. The **daemon** runs as the unprivileged user `machined` (uid 19998, groups `{team}`) and does everything else: the host connection, RPC parsing, the watcher, jj and git, documents, and every working-copy read and write. The two talk over a socketpair made at start, and the broker accepts no other caller. A fault in the daemon therefore can't reach a home, a token file, or anything else `team` can't.

9.5.2 **Paths.** Every working-copy path in an RPC is relative. The daemon resolves it with `openat2` from a descriptor for `/workspace`, with `RESOLVE_BENEATH | RESOLVE_NO_MAGICLINKS | RESOLVE_NO_XDEV`, so `..` or a symlink, even one swapped in mid-call, can't leave the working copy. A write opens its parent the same way and creates, renames and swaps inside that parent descriptor; a symlink as the last component is refused. Reads and writes accept only regular files: a directory, FIFO, socket or device is refused after an `O_NONBLOCK` open and `fstat`. The broker's home child opens credential paths with `RESOLVE_BENEATH | RESOLVE_NO_SYMLINKS` from the home's descriptor and accepts only regular files up to 1 MiB. The guest kernel must provide `openat2` (Linux 5.6 or later); the daemon refuses to start without it.

9.5.3 **Identity.** Actors and users come only from authenticated context, never from a field the machine controls:
- A host RPC carries the actor the host’s authorizer resolved (§5.2.1). The daemon accepts RPCs only on its host connection. On `bridge` the daemon dials the host. On either topology, the host proves the per-boot secret with HMAC-SHA256 over the daemon’s nonce and boot id using ADR 0004’s domain separator; the secret never crosses the connection. The runtime writes `/run/smithers/machined/boot`, owner `machined`, mode 0400. On `relay`, the broker binds `127.0.0.1:970` and hands the listener to the daemon. A connection that fails the proof is closed; one that passes the handshake replaces the live connection. Check: C-COL-04. Security review: smithers-3f must approve before this lands (gaps 5–8).
- The local socket `/run/smithers/machined.sock` (`root:agent`, 0660) is bound by the broker and handed to the daemon. It serves only the coding agent: `read_file`, `write_file`, and `open_session(pty)` for the agent's own terminal (§8.11.2a). The daemon takes the caller's uid from `SO_PEERCRED`, requires `agent`, and maps the caller's cgroup to the run the host registered (`register_run`); that run is the actor. A caller outside a registered run is refused. Local `write_file` has no actor field; carrying one fails `unknown_field` and writes nothing. Check: C-COL-04. Security review: smithers-3f must approve before this lands (gaps 5–8).
- `open_session` and `kill_sessions` carry host `{login, uid}` for the broker’s check; no daemon-sent frame or actor envelope names a branch, machine or uid. Security review: smithers-3f must approve before this lands (gaps 5–8). The broker starts sessions only as `agent` (19999) or as a member uid of 20000 or more whose login matches `[a-z0-9_-]{1,32}`. It never starts one as root, and it refuses a login whose uid differs from the one already created on that machine.

Check C-COL-04.

### 9.6 Sessions [S2]

9.6.0 Person commands use the authenticated host terminal UI broker; guest CLI/skill calls use only the delegated credential bound to that terminal session, never a shared current-token file. Checks: C-SEC-05, C-J6-01.

9.6.1 Every process a person or the agent runs on a machine is a session the broker starts: a terminal or SSH shell (`pty`), an SSH exec or the coding host (`exec`), `sftp-server` (`sftp`), or a TCP connection to a guest loopback port (`tcp`). Each session has its own cgroup under one parent, `/sys/fs/cgroup/smithers/sessions/`, which §9.4.2 freezes as a whole. The daemon and the broker live outside it.

9.6.2 **Protocol.** `open_session` returns a session id and opens one stream on the host connection. Frames:
- `data`: input to the process, and output from it (a pty merges output; exec keeps stdout and stderr apart);
- `eof`: closes one direction. The host's `eof` closes the process's stdin; the daemon's `eof` follows the process closing its output;
- `resize{cols, rows}` (pty) and `signal{name}` (pty and exec: `INT`, `TERM`, `HUP`, `KILL`, `QUIT`, `USR1`, `USR2`), delivered to the session's process group;
- `exit{code}` or `exit{signal, core}`, when the session's first process exits;
- `window{bytes}`: credit-based flow control. Each direction starts with 256 KiB of credit. A sender with no credit stops reading its source, so a slow reader stalls the process instead of losing bytes or growing memory;
- `close`, from either side.

The SSH gateway maps these one to one onto SSH channel requests and messages: `exit-status`, `exit-signal`, `window-change`, `signal`, EOF and window adjust.

9.6.3 **Ending.** `close_session` sends `HUP` to a pty's process group, or closes an exec's stdin. Processes that remain keep running in the session's cgroup as that user's, until `kill_sessions` or a machine sleep ends them. They count for attribution (§9.3.1) but not for safe-idle (§8.4.1). `kill_sessions(user | run)` kills every matching cgroup (`cgroup.kill`) and replies once each reports `populated 0`. Revocation (§5.6) and a run's end use it, so a removed member's processes, background ones included, are gone within 5 s.

9.6.4 **Disconnects and restarts.** If the host connection drops, sessions keep running for 30 s, stalled by flow control. A host that reconnects in that time calls `attach_session(id, received)` for each stream; each side reports received-byte counts and resends from those offsets within the 256 KiB credit bound (ADR 0004, T-TRM-07, C-COL-04). It re-attaches streams by session id; otherwise the daemon closes them. A host restart re-attaches nothing (§8.11.3). Before the broker restarts a daemon that exited, it kills every session cgroup, so no process outlives the daemon that attributes its writes, and the host marks those sessions ended.

9.6.5 Spike T-TRM-06 (check C-SPK-08) proves this contract with a real VS Code Remote session, flow control and 5 s revocation before the stage-2 daemon work starts. T-TRM-07 builds it.

9.6.6 **External-agent transcripts (M-38).** [S2] For Claude Code or Codex running in a registered member terminal, the broker discovers the agent and its transcript from the session process tree, cgroup, uid, working directory and configured agent home. Default transcript roots are `~/.claude/projects/` and `~/.codex/sessions/`; adapter fixtures document supported releases, path layouts and configuration overrides. A recent file or matching directory alone does not establish ownership. A child dropped to the session owner's uid and gids opens only the identified regular file beneath that owner's agent root, without symlink traversal (§9.5.2). No request supplies another member's uid or home. Separate inotify watches and a 1 s reconciliation scan tail complete records; partial records wait. T-AGT-02 owns the transcript payload and record framing. ADR 0004 reserves durable event variant 5; T-AGT-02 defines it and its golden frames in the shared codecs before enabling import (C-AGT-02). The daemon sends versioned source records with session, participant, source generation and byte range through the §9.1.4 outbox. The host's existing TypeScript process calls T-AGT-01's pure adapters, commits conversation entries and transcript run events atomically with the receipt, then publishes live-channel deltas on `conversation:<branch>`. The Rust daemon owns discovery, record framing and transport; the host library owns semantic mapping. Rotation, truncation and overflow reconcile the identified source; source generations and record offsets deduplicate replay. Unsupported versions stop that source and publish an import error. A complete record appears within 5 s on a healthy connection. Watches follow the registered agent lifetime and stop on revocation. Imported edit reports never override §9.3 observed-write attribution. Checks: C-AGT-01, C-AGT-02.

---

## 10. Stack and TODO engine [S1; presence-aware rebase S2]

### 10.1 Ownership

The stack engine is a host service. It is the only writer of stack order and item facts and the `mythical` history; `main` is never written (AGENTS.md). It reacts to commands, runtime events, `smithers-machined` events and GitHub events. Every transition goes through `product_job_events` (§3.2).

### 10.2 Creation and placement

10.2.1 Doors. A TODO comes from chat (`/todo.new`), from an issue by **Make TODO** (`/todo.from-issue #n` for GitHub issue #n), or from the `todo` label on GitHub. Issue text is team text when the issue's author and the last editor of its title and body are members or the install's App, the rule of today's `approvesIssueText` (`github_issue_trust.go:158`). Anything else is outsider text, which is untrusted (§17.1). Who may turn an issue into a TODO:

| Issue text | An owner or maintainer acts | A Member acts | Anyone else labels (non-member, suspended member, another App) |
| --- | --- | --- | --- |
| Team text | TODO | TODO | The label is reverted with a comment |
| Outsider text | TODO | Make TODO is refused with class `permission` before any draft; a label is reverted with "Only a maintainer can make a TODO from this issue" | The label is reverted with a comment |

To act is to commit a Make TODO from one's own session or to apply the label. An agent's Make TODO is a `confirm` request, checked against its member's role before the confirmation is posted (§6.1.2b). The table holds for the app, the CLI and the label (check C-SEC-03).

10.2.1a The admitted snapshot. The admitting action fixes revision 1 and the issue context the run receives:
- **Make TODO.** The app agent drafts the title, prompt, acceptance and `fixes` from one read of the issue's title, body and comments. The drafting call has no tools and receives the issue as quoted data. The member edits, places and commits the draft. Revision 1 is the committed text, and the read the draft came from is the issue context (`issue_digest`).
- **Label.** The issue-events stream (§12.2) hands over every `labeled` event for `todo` once, in event-id order, from a durable cursor, so a label removed and reapplied between polls is still seen. Revision 1 is the issue's title and body in the first issue read after the event is consumed. That read's comments are the issue context, and its digest is `issue_digest`. The TODO card shows that text as the admitted text, with the read time. If a non-member renamed or edited the issue after the label event (an issue-events `renamed` event, or GraphQL `Issue.lastEditedAt` later than the event with an `editor` who isn't a member), no TODO is created, and the label is reverted with "Changed after it was labeled. Label it again to make a TODO." A repeated delivery of the same event is idempotent by `(issue, label event id)`.

10.2.1b Later issue edits and comments never change the TODO and never reach its run (§10.4.2). Outsider text in the issue context reaches the agent only as quoted data marked with its author, never as an instruction or a steer (§17.5). An issue has at most one unmerged TODO; labeling it again while one exists is a no-op. TODOs made from an issue default to `fixes_issue = true`. Checks: C-SEC-03 for the doors, issue text and roles; C-J2-02 for the snapshot and the cursor.

10.2.2 Placement: `append` (default), `before Tn` or `amend Tn`. Amend creates no TODO. It appends the revised prompt and acceptance to `mythical_items.revisions` with reason `amend` and revision n+1 (shown as "+1"; revision 1 is the original). If Tn is working, it delivers the amendment as a steer. Check: C-STK-01.

10.2.3 Position is a dense ordering key (`stack_position`). Move up and Move down swap adjacent unmerged items, and Drop removes one. Every reorder rebases the affected later items (§10.5).

### 10.3 Parallel work

10.3.1 Up to `parallel` TODOs work at once (paused, needs_you and in_review TODOs whose machine is released don't count), each on its own branch and machine. The default is `max(1, capacity − 1)`, which leaves one machine for people and background runs. The owner may set it from 1 to 8, capped by capacity. Queued items admit in stack order.

10.3.2 Item N's work starts from its **prefix**: the verified head (§10.4.4) of the nearest earlier unmerged item that has one, else `main`'s tip. Admission never waits for an earlier item to verify. When an earlier item publishes a verified head, its first or a newer one, or `main` moves, N gets `rebase_pending{onto}` (§10.5.1), and N's next candidate sits on the new prefix. The first unmerged item's prefix is `main`'s tip. Its PR shows only its own change (§12.5). Check: C-STK-06.

10.3.2a [S1] SelectPrefix selects the nearest earlier unmerged item's usable last accepted head, or main's tip when none exists. Each candidate records the ordered included-items manifest inherited from that head, naming item identities, candidate heads and changes, plus its recorded main base; its tree contains that main base, the manifest's changes and its own change, each once. The manifest may omit unverified predecessors. At rest, when every earlier unmerged item has accepted a candidate on its current prefix and no rebase is pending, it contains all earlier unmerged items in stack order. In §12.5.1, “previous item's candidate” means the selected prefix candidate, or the recorded main base if the manifest is empty. Checks: C-STK-06.

### 10.4 The TODO run

10.4.1 Each attempt pins one Active `todo` flow digest when the TODO enters Starting (`mythical_items.flow_digest`, §11.4) and passes it to every launch of that attempt, on the TODO's branch machine (E-19). The overridable `todo` composition covers route → deliver and replaces today's `coding/request` and `coding/vibe` launches (deleting `deliver`, `mythical_items.go:1765-1783`). Verify and review stay engine launches (M-30). Signals carry a stable identity and a per-TODO committed sequence; replay deduplicates identity. At each boundary, terminal merged/dropped settlement wins; paused work retains other pending inputs until Resume. Otherwise consume text inputs in sequence order. changes_requested is a steer carrying review metadata, not a second delivery of the same review event. Coalesce edited invalidations and rebase targets to the latest authoritative tree/prefix, recording each superseded identity. Any input requires implement; otherwise edited requires candidate/review, and rebase requires candidate/check with review reuse only under §10.4.3. Required rebase completes before candidate; input delivery may occur while rebase is pending but coding work waits. Record consumption and the selected continuation durably before dispatch; inputs arriving later remain queued and invalidate stale propose. Terminal attempt outcomes are merged or dropped, recorded from TODO settlement in the same transaction as cancellation/wait settlement. A failed run has failed{step,class,message,retryable}; the runtime transport status does not replace domain outcome. During the post-propose durable wait current_step is null and the monitor state is held with since; a replayed terminal signal cannot overwrite the first domain outcome. Checks: C-STK-06, C-STK-03.

```
route → plan (cites wiki revisions) → implement → candidate → check → review (the overridable `review` flow)
      → stack.propose ──▶ wait for a stack event:
            clean rebase onto a new tip   → candidate → check → stack.propose → wait
            agent-resolved rebase conflict → implement → candidate → check → review → stack.propose → wait
            edited (a newer capture)      → candidate → check → review → stack.propose → wait
            steer / changes requested     → implement → candidate → check → review → stack.propose → wait
            merged | dropped              → end
```

`stack.candidate` and `stack.propose` are system operations (§10.4.4). With the rebase (§10.5) and the merge (§10.6), they are the stack engine's part: capture the candidate on the item's prefix, accept its evidence, open or update the PR, and later merge after a person's approval. None of those are flow steps, so an override can't skip them. `coding/verify` (`mythical_items.go:1905`) and `review/change` (`mythicalReviewFlow`) stay engine launches pinned to the attempt's digest (T-FLW-11).

10.4.1a The built-in `todo` flow is a short composition file over step flows published from the coding package. Overriding it (§11.5) copies only that composition into `flows/todo/flow.ts`, which imports the steps it doesn't change. Before its first accepted proposal, a TODO attempt has a host watchdog of 1,024 completed flow-step instances or 4 hours of active execution, whichever occurs first. Durable human/stack waits, pause, admission and suspension do not accrue active time; runnable work and in-flight calls do. Returning success without an accepted proposal, or exhausting this allowance, fails with code no_proposal, class factory, retryable true. The host persists counters across restart and enforces time even when an override never yields. Repository code cannot disable or change the watchdog. Product note (2026-10-02): revisit with the first 20 dogfood TODOs' cycle times. Checks: C-STK-06, C-J5-01.

10.4.1b Reuse the launch, outage and replan bounds in `mythical_items.go:74–75,3364–3378` and `checks.Launches/LaunchBase/Outages/VeryHard/Replans`. Add only the daily allowance of 12 as an `install_settings` key. Check: C-STK-03.

10.4.2 The prompt the agent receives is revision 1, plus every later revision delivered as a steer, plus the acceptance text, plus, when the TODO came from an issue, the issue context admitted with revision 1 (§10.2.1a), as quoted data marked with each author. Later issue comments never reach the run. Check: C-SEC-03. Admission may include other open issue numbers/titles for duplicate detection, excluding this issue. Pin them with revision-1 context, author attribution and untrusted framing; titles are evidence, never instructions or work admission. Retain the 24 KiB issue-body and 48 KiB whole-prompt caps; the duplicate-context loop stops once accumulated prompt size exceeds 36 KiB. Check: C-STK-06.

10.4.3 Evidence recorded per attempt, each entry tagged with the candidate generation it describes (§10.4.4): the diff stat, checks run on the machine (name, outcome, duration, log blob), the agent's review summary, GitHub checks, the token and time totals, and the flow version. The PR body and the TODO card show the accepted generation's entries. A review summary from an earlier generation is shown only when that generation's own diff has the same `git patch-id --stable` as the accepted one, as after a clean rebase. Evidence writes atomically validate run-to-attempt and generation-to-persisted-candidate ownership and versions. Superseded producers cannot update the current attempt. Late GitHub checks use persisted attempt/generation/pushed-head publication ownership; identical heads across attempts require that ownership, and ambiguity writes nothing. Log authorization verifies the attempt’s digest reference before blob retrieval; denied/unrelated requests invoke no retrieval. Check: C-J2-04.

10.4.4 **Candidate and verified head.** The existing engine keeps the candidate on `mythical_items` (`generation`, `candidate_base`, `candidate_head`, `candidate_verified`, `pr_head`, `pending_op`). Verify runs on an immutable rebased commit, a new candidate clears `candidate_verified` (`mythical_items.go:1901`), and the PR tree is the verified candidate (`mythical_items.go:1838-1905,2029`). An item's **verified head** is its latest verified candidate. `stack.candidate` and `stack.propose` are system operations with Appendix C rows and no slash, CLI or agent door; they admit only the run and machine credentials bound to the current attempt (§6.1.2d). Review uses a fresh reviewer context, reads the candidate's own diff (`base..C`) and an immutable candidate export as untrusted data, never the working copy, and has read-only tools; only the exact first-line tokens `approve` and `request-changes` are verdicts. A steer, amendment or answer after verification needs a new verified candidate before merge (§10.6.2a row 7). The ticket touching ancestry collapses the three commit-ancestor implementations to one in the same change. Checks: C-STK-06, C-SEC-02.

### 10.5 Rebase

10.5.1 When `main` or an earlier item publishes a new revision, or the stack is reordered, an earlier item is dropped, or an earlier item is amended, every later item gets `rebase_pending{onto}` (QA S8). A candidate is also refused as `rebase_pending` when its working copy contains commits from any item outside its current prefix chain (for example T4 moved above T3 while its working copy still holds T3).

10.5.2 If only the coding agent is present on the branch, the rebase runs at the run's next durable boundary. If people are present, the branch shows "Rebase pending". The rebase then runs when presence drops to the agent alone, or when someone on the branch selects **Rebase now**.

10.5.3 The rebase follows §9.4. Afterwards it posts activity "Rebased onto Tk" and signals the run `rebased`. The run captures a new generation and re-runs checks (§10.4.4), and the new generation voids earlier approvals (§10.6.2c). A clean rebase reruns checks only. Agent-resolved conflicts are new work: implement → candidate → check → review → stack.propose. Checks: C-STK-06, C-STK-07.

10.5.3a [S1] A successful rebase changing the base or prefix manifest requires a distinct Candidate invocation and therefore a new candidate, even if the captured tree equals the previous candidate's tree. RebaseFanout records required per-item onto facts atomically with the triggering stack transition; it does not allocate candidates. Until rebase and the new Propose acceptance complete, Smithers Merge stays held. Re-run all configured checks for the new candidate; review summaries may be reused only under §10.4.3's own-diff patch-id rule. Earlier candidate approvals are void and cannot be rebound by tree equality. Empty own changes still follow the empty_change rule. Checks: C-STK-06, C-STK-07.

10.5.4 A conflict goes to the coding agent first. If the agent doesn't resolve it within its policy (one attempt by default), the TODO enters `needs_you{kind: conflict, paths}` with **Resolve**. In stage 1 Resolve opens the TODO card's conflict view (conflicted files, terminal and SSH line); from stage 2 it opens the Branch card. The wait settles when someone presses **Done** and the working copy has no conflict markers in those paths. An engine-raised conflict creates its own durable wait on the TODO.

10.5.5 Asleep branches rebase on the host against their captured head, without waking. A conflict wakes nothing; it becomes Needs you. A replayed capture cannot replace this head when its `base` differs from the head last sent to the machine (§9.1.4). Reconciliation runs on wake. Check: C-DUR-04.

### 10.6 Merge [S1]

10.6.1 Merge is enabled for exactly the first unmerged item in stack order. Later items show "Merges after Tn". Smithers enforces the order. GitHub doesn't, because every PR is based on `main` (§12.5).

10.6.2 `POST /api/todos/{n}/merge {reviewed_head_sha}` requires a `session` credential with role owner or maintainer, and `MergeReady` (§10.6.2a) under the merge fence (§10.6.2b). The server records the approval in `checks.Land` with the generation and `reviewed_head_sha`, then calls GitHub's merge API with `sha = reviewed_head_sha` and `merge_method = squash`, so each item is one commit on `main`. Setup refuses a repository that disallows squash merging and shows "Enable squash merging on GitHub ↗". A refusal surfaces GitHub's reason text verbatim, for example "1 approving review required on GitHub". After authorization succeeds for execution or eligible confirmation creation, `reviewed_head_sha` must be a string of exactly 40 hexadecimal characters; normalize it to lowercase. A missing, empty or malformed value returns HTTP 400, class `user`, code `invalid_reviewed_head_sha`, message `reviewed_head_sha must be a 40-character hexadecimal commit SHA`, before any confirmation, fence, approval or outbound merge row is created. A well-formed value differing from the PR head fails row 8 with `stale_head`. A definitive refusal from GitHub's merge endpoint returns its HTTP 405, 409 or 422 status in the §6.2.3 envelope with class `github`, code `github_refused`, and GitHub's `message` verbatim. If the response may mean the PR is already merged, look up the PR before treating it as a refusal: a confirmed merge settles the outbound row `done`, returns HTTP 202 with `{state: accepted}`, and projects completion only after `main` contains the commit. A timeout, reset or response that cannot establish whether the write took effect leaves the outbound row `unknown` and follows §12.4.1b, rather than clearing its fence as a definitive refusal. Checks: C-STK-04, C-STK-07, C-ACC-02. T-STK-04 owns the prs.land command handler and POST /api/todos/{n}/merge route. T-APP-04 binds the Review & merge control to that command only. Checks: C-STK-04, C-ACC-02.

10.6.2a **One merge predicate.** `MergeReady(todo, reviewed_head_sha)` is the only definition of merge readiness. The Merge control's `merge_block`, the merge route, the approve of a Review & merge confirmation (§5.4) and the recheck before dispatch all call it. It holds when every row holds, and the first row that fails gives the reason:

| # | Condition | Reason |
| --- | --- | --- |
| 1 | The TODO is `in_review` (§4.1.0a): no open wait, `paused_at` unset | `state` |
| 2 | It is the first unmerged item in stack order | `order` |
| 3 | No stack attention is open (`mythical_stacks.attention`) | `attention` |
| 4 | No merge fence is set (§10.6.2b) | `merging` |
| 5 | The current generation is accepted (`candidate_verified`), its PR push is settled (`pending_op` empty) and `pr_head` is set | `rechecking` |
| 6 | No `rebase_pending`, and the generation's base is the mirror's `main` tip | `rechecking` |
| 7 | No pending work: no unconsumed steer, amendment, member review comment delivered as a steer, or run answer after the verified candidate, and the branch's newest capture has the candidate's tree; capture unavailability does not satisfy this row | `pending_work` |
| 8 | `reviewed_head_sha` = `pr_head` = GitHub's current PR head | `stale_head` |
| 9 | Required GitHub checks pass on that head, required reviews are satisfied per GitHub branch protection, the PR is not draft, and GitHub affirmatively reports it mergeable | `checks`, `review_required`, `github` |

Rows 1-7 read PostgreSQL; rows 8-9 read GitHub, and `merge_block` uses the last synced PR head and checks for them. `merge_block` is `{reason, detail?}`, with Tn for `order`, the check's name for `checks` and GitHub's text for `github`. Check: C-STK-07. For merge readiness refusals, zero GitHub calls means zero calls to the merge endpoint (`PUT /repos/{owner}/{repo}/pulls/{number}/merge`); the reads required by §10.6.2b are permitted. Authorization refusals do not start readiness reads or create a fence, approval or outbound merge row. Row 9 first evaluates required checks: a failed or pending required check returns HTTP 409, class `conflict`, code `checks`, with its name as detail and message. If several checks block, choose the first by bytewise check name, then stable GitHub check identifier. Only after required checks pass does a known non-mergeable PR return HTTP 409, class `github`, code `github`; any GitHub reason text is preserved verbatim. If no reason text is supplied, detail and message are `GitHub reports this PR is not mergeable`. `DecideMerge` is the shared decision function for the merge route, the viewer's `merge_block`, Review & merge confirmation approval, and dispatch or recovery rechecks. At request entry, `DecideMerge` obtains or consumes the request's single bound Authorize decision before applying the single `MergeReady` predicate; eligible delegated creation yields Confirm without executing a merge. Dispatch and recovery use the specialized current approving-member eligibility, membership, role and confirmation-owner guard in §10.6.2b, rather than making another generic Authorize decision for the originating HTTP request. A recovery attempt separately checks its recorded authority; it does not borrow an old allow decision. The caller supplies synced facts for projection and live facts for dispatch. At rows 8–9, a required fact that has never been synced or whose stream is not fresh under §12.2.3 returns HTTP 409, class `conflict`, code `rechecking`, detail and message `Waiting for fresh GitHub merge facts`. Unknown required-check configuration is not an empty required-check set. Earlier failing rows retain priority; known facts use the normal row reasons, including the known-null rule. At row 1, when the supplied PR lifecycle fact is known and closed unmerged, refuse with HTTP 409, class `conflict`, code `state`, detail and message `PR is closed on GitHub`; do not fall through to head or check failures. A live recheck that discovers this fact clears its fence and submits the same inbound close transition used by polling (§12.3), without a merge PUT. A PR reported merged is reconciled as a merge fact, not classified as closed unmerged; completion still waits for its commit on `main`. Earlier authorization failures retain priority. Row 9, after required checks pass, requires the PR not to be draft, including when GitHub's `mergeable` field is true. A draft PR returns HTTP 409, class `github`, code `github`, with GitHub's supplied draft refusal text verbatim, or detail and message `PR is still draft on GitHub` when none is supplied; no merge PUT is sent. This check precedes other mergeability evaluation within row 9. The normal first-item ready transition (§12.5.1) runs through §12.4; Merge and confirmation approval do not change draft state themselves, and a refused confirmation remains pending under §10.6.2c. Checks: C-STK-04, C-STK-07, C-ACC-02. Within row 9, evaluate required checks, required reviews, draft state, then mergeability. Unsatisfied required reviews return HTTP 409, class `conflict`, code `review_required`, with detail and message `Required reviews are not satisfied on GitHub`. Role is enforced by the catalog authorizer (T-ACC-03), never by `MergeReady`. A `review_required` block links to the PR. Checks: C-STK-07, C-ACC-01.

10.6.2b **Merge fence.** A merge runs in three steps:
1. One transaction locks the stack row (`mythical_stacks`, `FOR UPDATE`), then the TODO row, evaluates rows 1-7 and sets `mythical_items.merging = {generation, head, by, at}`. Every stack mutation takes the same locks in the same order and reads `mythical_items.merging`: place, amend, move, drop, steer, answer, admission, `rebase_pending` writes, `stack.candidate`, `stack.propose` and the fold after a merge.
2. Before dispatch, outside the transaction, the server rechecks: a fresh capture when the branch's machine is awake (row 7; an asleep branch's captured head is final), `main` by `git ls-remote` (row 6), and the PR head, required checks and mergeable state from GitHub (rows 8-9). A failure clears the fence and returns its reason. If GitHub reports `mergeable: null`, re-read the PR once after 2 seconds. If it is still null, refuse with HTTP 409, class `github`, code `github`, and detail and message `GitHub is still computing mergeability`; clear the fence and send no merge request. Re-evaluate rows 8–9 against the second read, including checks for its head. After live reads and immediately before claiming dispatch, `DecideMerge` rechecks the approving person's credential eligibility, current membership and role, and confirmation ownership where applicable; it never treats a stored approval as current authorization. The dispatch claim serializes with role changes and credential revocation, so a downgrade or revocation committed first sends no PUT, clears this operation's fence and returns the applicable permission or unauthenticated refusal. It records the reason any existing approval is no longer usable. A change committed after the claim cannot cancel a sent GitHub request; its outcome is reconciled as usual. Recovery applies the same check to the recorded person and bound authorization, without minting a session. Checks: C-STK-04, C-STK-07, C-ACC-02.
3. For Review & merge, the server records `checks.Land`; for a pre-approved TODO it retains the recorded `checks.Automerge` authority (§10.6.2d). Both call GitHub's merge through the outbound path (§12.4.1). A definitive GitHub refusal clears the fence and retains the approval receipt (§10.6.2c). Success keeps the fence until the `merged` transaction clears it. At boot, reconcile fences and their intended or unknown outbound rows under §12.4.1b before further dispatch; a confirmed merge keeps its fence until `merged` commits. Check: C-STK-07.

While a fence is set:
- A placement that changes the item's position (Before, Move, Drop) and an amend of the item get `409 {code: merging}`.
- A steer or a member's review comment for the item commits and is held. If the merge completes, it stays recorded and undelivered. If the fence clears without a merge, it is delivered then, with its usual transition (`in_review → working`).
- `rebase_pending` for the item and `stack.propose` for the item wait until the fence clears. stack.candidate also waits while the item's merge fence is set. DecideCandidate returns Defer before capture, pinning, generation allocation or verification changes; waiting does not hold database locks. After the fence clears, a fresh call reevaluates all facts: a merged or dropped item refuses todo_closed, otherwise the normal candidate decision applies. Deferred operations never clear or replace the fence; inbound confirmed merges retain §10.6.2b's exception. Checks: C-STK-06, C-STK-07.
- "A merge is in flight" for `smthrs host upgrade` and quiesce (§16.4, §16.5) means a set fence. A GitHub merge confirmed on `main` is an exception to fence deferral: its inbound transition and containment fold take the stack lock and TODO locks in the usual order, apply even across a set fence, and clear fences for items actually marked merged. The dispatch claim and this fold serialize on those locks. A fold that wins before dispatch makes the unsent merge row `superseded` and sends no PUT; a dispatch that wins may finish but its result cannot revert or repeat the inbound transition. An already-sent row remains subject to target serialization and lookup until settled, even after the TODO fence clears. The originating request returns HTTP 202 with `{state: accepted}` if the target is proven merged by the fold; otherwise it returns its normal decision or GitHub refusal. Held inputs remain recorded and undelivered for merged items. Checks: C-STK-04, C-STK-07, C-ACC-02.

Limits: a write to the working copy after step 2's capture isn't in the merge; it stays in the branch's final capture (§8.12). GitHub's merge API has no base precondition, so a `main` move on GitHub after step 2's `ls-remote` lets GitHub squash the reviewed head onto the newer `main`. Check: C-STK-07.

Retarget race (accepted residual risk; lead's ruling, 2026-10-04, #3529). GitHub's merge API takes a head precondition (`sha`) and no base precondition, so no client check can close the window between the last read of the pull request's base and the merge request: a pull request retargeted inside it merges into its new base. Retargeting requires write access to the repository, and a person with that access can already put the same commit on that branch directly; a protected target branch enforces its own rules on the App's merge; `main` is never affected, and the TODO is never shown Merged without `main` containing the commit. The race is bounded: (a) the base is read at the press and read again immediately before the dispatch claim, so the window is one round trip; (b) a sent merge GitHub later reports merged with a base other than `main` clears its fence with a receipt naming the branch ("GitHub merged the pull request into <branch>, not main"), the TODO closes as a pull request closed on GitHub does and is never Merged, and later TODOs are not held behind it; (c) the event is logged for the owner (`mythical.merge_off_main`). Check: C-STK-07.

Sent merges. Everything but the request happens before the dispatch claim: the decision's live reads, then the merge's GitHub destination and an installation token minted for it, so a failed lookup or mint records nothing as sent. The claim records, before the request leaves, that the merge is being sent, in one transaction. It first takes every lock it needs in the install's one lock order: the repository row; the stack row, then the TODO row (every stack writer takes them in this order, the run projection included); the users rows of the approver and of the repository's owner; then each other row it reads in table-name order, the order account erasure deletes in: the approver's session, the App's row, the repository's App installation rows, its GitHub sources, the approver's linked GitHub accounts, the owning organization and its members, the repository's GitHub connections, and last the install owner. A repository's deletion takes its row first, erasure takes the users row first, and every other writer of these rows writes one of them. PostgreSQL ends any cycle a writer outside this order makes by aborting one transaction; an aborted claim records nothing and sends nothing, the fence stays, and the next pass decides again. Under those locks the claim reads every local fact again: the TODO row (its save is a version check), the session, the person, the install owner, the linked GitHub account against the approval's account, and the repository's GitHub binding (destination, installation, App, stack account) against the one the merge was prepared for. It reads the factory's policy again from the repository host, which PostgreSQL cannot lock. Only then does it read the time, for the approval's age, the session's expiry and the age of GitHub's facts: GitHub's permission, head, base, checks and reviews cannot be locked, so a claim more than 5 seconds after the decision's last read of GitHub sends nothing, and the next pass reads GitHub again. A revocation, expiry or binding change that comes before the claim sends nothing; a writer of a locked row after it waits for the claim, and a row inserted after it orders after the claim; neither recalls the request. A merge whose request was sent, or whose claim committed before the worker stopped, is never sent again, never ended by the approval's age or a later refusal of its approver: lookup alone settles it, when GitHub shows it merged, closed, or at another head. The card shows it `merging` meanwhile. Only a never-sent intent expires (10 minutes after its approval) or is ended by an authorization refusal. Check: C-STK-07.

10.6.2c **Approval binding.** A `checks.Land` approval and a Review & merge confirmation's subject revision (§5.4) both bind the generation and the PR head. A new generation voids approvals, and a new generation or a different PR head on GitHub expires a pending confirmation. An approve that `MergeReady` refuses leaves the confirmation pending until it expires. A TODO that returns to working keeps its PR open and ready, so GitHub may still merge its last proposed head (§4.1). Check: C-ACC-02. A recorded session approval is retained after a definitive GitHub refusal, with an activity receipt naming its generation, head and failure; clearing the fence does not erase it. A Review & merge confirmation remains pending after such a refusal unless its revision or lifetime has expired; it becomes approved only when GitHub confirms the merge. A retained approval is not permission to retry a definitively refused merge automatically: retry requires another explicit eligible session press and a fresh `DecideMerge`. Reconciliation of an intended or unknown dispatch follows §12.4.1b. Voiding an approval because work, generation or head changed records why it was cleared before removing it from the active approvals; a head change expires its pending confirmation. Checks: C-STK-04, C-STK-07, C-ACC-02.

10.6.2d [S1] Pre-approved TODOs (M-39). Pre-approval is `checks.Automerge`, set by Pre-approve or a maintainer's `automerge` label, with approver, via and time. On checks settled, stack order change, Needs-you cleared, rebase settled, pre-approval added and boot recovery, T-STK-04's evaluator (the existing `automerge` label path, `mythical_items.go:58-65,215,2236`) calls the shared DecideMerge and its single MergeReady predicate for the current accepted PR head. It uses the same stack lock, TODO locks, reviewed-head checks and merge fence as Review & merge. Pre-approval survives rebases but each outbound intent binds the current head. Dispatch rechecks the active pre-approval and current approving-member authority, then uses §12.4.1's existing outbound path. No pre-approval bypasses required checks, stack order, Needs you or protected-path policy. Removal serialized before send prevents the request; after send §12.4.1b reconciles it. Duplicate evaluation and recovery create no second merge intent. Completion reads Merged · pre-approved by <name>. Check: C-STK-13.

10.6.3 After the merge, later items rebase onto the new `main` (§10.5), and each open PR is force-updated with that item's next accepted generation (§10.4.4). Its body then stops listing the merged item.

10.6.4 An out-of-order merge on GitHub happens when someone marks a later draft ready and merges it first. The engine marks the merged item merged, and marks merged only those earlier unmerged items whose verified head the merged generation's recorded included-items list contains (QA S6). Any other earlier item gets `rebase_pending` onto the new `main` (and `attention{kind: order}` per the rest of this paragraph); its unmerged work is never marked merged. It notes on each earlier one "T3 merged before T2; T2's change is in T3's commit" and closes each earlier item's open PR with the comment "Merged via #<n> (T3)". It then folds `main` and opens `attention{kind: order}` for maintainers with that sentence, settled by **OK** (in-card). Later items rebase as after any merge. For one out-of-order merge containing several earlier items, create one order attention entry for that merge event. Its text joins, with a newline, one sentence per contained earlier item in pre-fold stack order: `Tk merged before Tj; Tj's change is in Tk's commit`. Each earlier item's note contains only its own sentence, and each open earlier PR receives `Merged via #<n> (Tk)` once. A stack has at most one open `order` attention row. Each new out-of-order merge appends an event entry to that row, deduplicated by PR identity and merge commit, and increments its revision; entries preserve application order and each entry's sentences follow pre-fold stack order. OK requires an eligible maintainer session and the displayed attention revision. If an entry arrived after that revision, return HTTP 409, class `conflict`, code `stale_attention`, keep the row open and show its current entries. A duplicate poll appends nothing. Containment is proved from the PR head actually merged, fetched from GitHub, matched to the persisted accepted-generation PR head and its immutable prefix manifest of item identities, generation heads and changes. That manifest must record which changes are present in that candidate, not merely which items preceded it. The reported merge commit must also be present on `main`; squash ancestry alone is not evidence of earlier-item containment. If the merged head does not match a retained accepted head, the manifest is missing, or inclusion of an earlier change cannot be proved, do not mark that earlier item merged, close its PR or close its issue. Mark the directly merged PR's TODO merged once its merge commit is on `main`, fold the mirror, and add an order attention entry `Tk merged out of order; containment of Tj is unverified` for each unproven earlier item in pre-fold stack order. Proven contained items still fold normally. Later rebases continue under §10.6.3; Smithers merges remain blocked by the attention. Missing head evidence is retried by polling; an ambiguous head is never guessed to contain another item's work. Every item marked merged by a proven containment fold receives the ordinary merged effects, including closing its linked issue only when `fixes_issue` is true. The closing comment links the PR and commit that actually landed its change and names `Merged via #<n> (Tk)`. Issue-close and comment writes use §12.4's durable deduplication; duplicate polls create no additional writes. An external merge or containment fold never writes `checks.Land`. Checks: C-STK-04, C-STK-07, C-ACC-02. The order.ok descriptor admits only a maintainer or owner person session, agent: never. A scope/role-eligible delegated request returns HTTP 403, class and code never. Catalog publication must match this adopted Appendix B.4 security restriction. Check: C-STK-04.

### 10.7 Stop, resume, retry, drop, steer

10.7.1 Stop: send a durable pause signal; the run parks in a `paused` wait at its next durable boundary (an in-flight model call finishes first, ≤ 60 s), the TODO shows `paused`, and the machine is released when safe-idle. The run is not cancelled. Stop is refused while a `question` or `approval` wait is open; an open branch wait doesn't refuse it (§4.1). Resume re-admits and continues the same run from its last finished step, and the TODO turns working when the coding host reports the run attached (§4.1). Retry starts a new attempt of the pinned flow version (Retry with the current flow pins the Active one, §4.1); an optional steer becomes the first message. A live run waiting for stack events is executing for the Stop guard. Stop is accepted in in_review and during stack.candidate or stack.propose, unless a question or approval is open; an in-flight operation settles to a durable result before the paused wait opens. Resume restores the prior stack wait or next unfinished boundary. Terminal settlement wins over pause. Cancelling a TODO run through run controls, outside a committed merge/drop decision, marks its attempt failed with code cancelled_external, class user, retryable true. It does not drop the TODO, close its PR, or auto-admit another run; Retry uses its existing person-only typed-stop guard. Retry of a typed stop, including external cancellation, no_proposal, proposal_loop and policy bounds, requires a person. Only an untyped blocked item may be retried by an authorized run. A person's Retry resets operational bound counters with an actor-attributed event, never repository daily spend; Resume resets none. Prior attempt records and evidence remain immutable, and ordinary Retry retains the pinned closure. Checks: C-STK-03, C-STK-06.

10.7.2 Drop: confirm, cancel the run, take a final capture, close the PR with comment "Dropped in Smithers by @x", mark `dropped`, archive the branch, fold the item's change into the first later TODO forked from it (§8.5.3a), and rebase later items. The attempt closes with outcome `dropped`, and its last accepted generation stays on the record for a reopen (§10.7.4). Check: C-J7-02. Drop sets a durable terminal fence under the same TODO lock as proposal acceptance, settles waits and cancels execution; later acceptance is refused. Supersede unsent proposal intents where permitted by §12.4.1a. Already-sent or unknown push/open/body writes reconcile before dependent closure; never repeat a superseded proposal decision. Record a close-after-reconcile obligation keyed by Drop's event even when the PR number is unknown, resolve the PR by branch, then close it through `pending_op`. Gate branch archival/final cleanup on reconciled proposal effects and retained final capture. A late PR creation cannot erase this obligation; external reopening follows §10.7.4. Check: C-STK-06.

10.7.2a The coding agent can ask a person mid-implementation. The `ask` tool is bound for the implementing seats (`coding/edit-atom`, `coding/dispatch-turn`), not only at flow-step boundaries. It raises `needs_you{kind: question}` as a durable wait and continues with the first answer (§10.8.2).

10.7.3 Steer: any member, or an agent acting for one. The text is delivered to the run as a durable signal. Steer is `agent: run`: an agent steers at once for its person, with `via` recorded. A steer never settles an open question: while `needs_you{kind: question}` is open, Answer is the primary action, and the steer reaches the agent at once as context. The agent may replace its question with a better one, but the question stays open until a person answers (mvp.md §4.1). A steer to a queued TODO is held and delivered when its run starts; one to a paused TODO is delivered on resume; one to an in_review TODO moves it to working. The run's flow MUST accept steers at every step boundary, and inside the implement step between agent turns (≤ one model turn of latency). The steer appears in branch activity with its author's avatar. A steer to a starting TODO is held and delivered at the first unfinished step boundary after run_attached; for a resumed run this is its next boundary, not its original first step, like one to a queued TODO. A steer to a failed TODO is **Retry with that steer** (mvp.md: Failed offers Retry, steer or drop): it starts a new attempt with the steer as its first input (§4.1 failed → queued). A steer to a merged or dropped TODO is refused with `todo_closed`. Check: C-STK-01. Steer-as-Retry uses Retry's authority guard; it does not bypass a person-only typed stop. While a question is open, record each steer once in the waiting agent's durable context and emit steer_received; it does not settle the question. If the agent uses that context to revise its question, the replacement preserves the open wait identity. Answer and steer serialize by committed sequence; the next model turn consumes all inputs committed before its dispatch, and a later steer is consumed at the following turn boundary. Checks: C-STK-03, C-STK-06.

10.7.4 Reopen (§12.3): a PR reopened on GitHub within 7 days of its TODO's drop returns the TODO to in_review, once per reopen event, with no live run. The attempt the drop closed stays closed, and its last accepted generation is the TODO's candidate again; if it still satisfies `MergeReady`, it merges as is. The first input that needs work starts a new attempt as Retry does (§10.7.1): a new run of the dropped attempt's pinned flow version from its first step, with that input as its first message. Such inputs are a steer, an amendment, a member's review comment, `rebase_pending` and pending work (§10.6.2a row 7). The machine wakes from its disk, or from the branch's final capture when cleanup removed the disk (§8.12). Check: C-J10-08. todo_closed applies until the reopen transition commits; a steer does not itself reopen. After reopen, accepted work input uses a new attempt; the closed dropped run is never revived. Check: C-STK-06.

### 10.8 Needs you

10.8.0 **Waits.** Each reason a TODO needs a person is its own durable wait, derived rather than stored in a new table: run waits from the runtime's `WaitingReason` (`packages/backend/flowruntime/contracts.go:143`) and HumanTask, branch waits from `checks.ForeignHead` and integration conflicts. First answer wins through the `approvals` pending guard (`db/product/queries/approvals.sql:33-42`). Run waits (`question`, `approval`) belong to the attempt's run and expire when that run ends. Branch waits (`conflict`, `moved_off`, `foreign_push`) describe the branch and stay open across attempts, Stop and Resume until resolved. Merge and drop close every open wait in their own transaction (§4.1). Precedence and the primary wait: §4.1.0a. Check: C-STK-08.

10.8.1 TODO kinds: `question` (the agent asked), `approval` (a flow step's human approval), `conflict` (§10.5.4), `moved_off` (§9.3.8), `foreign_push` (§12.3). Stack-level kinds, `order` (§10.6.4) and `force_push` (§12.3), live in `mythical_stacks.attention` (§4.1.2a).

10.8.1a A planner that declines with questions (today's `declined` with questions) raises `needs_you{kind: question}` and waits, instead of ending the item.

10.8.2 First answer wins. Answers carry the wait id. The first committed answer settles the wait, and later submissions get `409 {answered_by}`. A late submitter's text stays in their draft with **Send as steer**.

10.8.3 Toasts go to the TODO's owner and, from stage 2, to anyone present on its branch (stage 1 has no presence). Everyone else sees it on the Home card (M-14).

---

## 11. Flows [S1]

### 11.1 Catalog

11.1.1 **System flows** are packaged with the install and never overridable: stack operations (including `stack.propose`), merge, members, settings, secrets, sync, admission, setup, `flow-load` and the summarizer (M-30). They run in the host flow runtime or as Go services exposed as commands, except `flow-load`, which loads repository code and so runs in an ephemeral machine (§11.3.1). Check: C-SEC-02.

11.1.2 **Overridable flows** are `todo`, `learning`, `review`, plus any repository flow at `flows/<name>/flow.ts`. Each has a built-in default version shipped with the install. A repository file of the same name, on `main`, overrides it once Active. Overridable flows always run inside a machine (§1.3).

11.1.3 Use only `Flow.make("<name>", {description, payload, success, error?, body, ...})` from `@smthrs/flow`; the ticket touching a flow deletes the duplicate shape in the same change. Check: C-CAT-01.

### 11.2 Configuration without a commit (M-11)

11.2.1 [S1] The install generates and stores the configuration the default flows need as `install_settings` keys (`0104_install_settings.sql`); defaults come from `Checklist.evidence` (`packages/smithers/src/suggest/Checklist.ts:183`) and overlay in `loadProject` (`flows/coding/project-config.ts:55`). Stored with it: the detected check commands (`package.json` scripts `test`/`lint`/`typecheck`/`build`; `go test ./...`; `cargo test`; `pytest`), the default wiki page declaration and model seats. All of it lives in PostgreSQL, not in the repository. A repository's own `.smithers/*` configuration, when present on `main`, takes precedence field by field. Planning needs at least one check. Today's two-check minimum (`flows/coding/planning.ts:38`) becomes one. A repository with no detected check runs a build-only check and says "no checks detected" in the PR evidence. The default wiki pages are an overview, an architecture page and one page per top-level package directory, at most 10. Check: C-STK-06.

11.2.2 [S1] The `correction_rounds` setting defaults to 3 and accepts integers 0–8; Active-main configuration overrides this field under the existing precedence. Snapshot it at attempt admission. Each failed check may start one correction implementation until this allowance is exhausted, then fail check with code correction_bound, class factory, retryable true. Corrections also spend the proposal-cycle allowance; neither allowance overrides the other. Check: C-STK-06.

11.2.3 [S1] The no-detected-check build-only fallback applies to every candidate generation, including after rebase; it does not trigger replanning. Record the configured build result for that generation with no checks detected; absence of an executable build command is a typed check configuration failure, never a fabricated pass. Check: C-STK-06.

### 11.3 Loading and activation

11.3.0 A flow version is `(flow_name, source_commit, digest)`. The digest is the existing `Executable.catalog` execution digest, which covers the repository modules the flow imports (so a `todo` digest also pins the `review` flow it calls, J5.4) and the lockfile digest (`ExecutionSnapshot.ts:59-65`). `@smthrs/*` packages come from the coding host the install ships. The MVP stores no closure blobs and packs no dependency environment (E-12).

11.3.1 Every `main` move admits a background `flow-load` run in an ephemeral machine at `main`'s new commit. Loads coalesce: at most one runs at a time, and when it ends the next starts at the newest `main` commit not yet loaded. The run loads every overridable flow, typechecks it and computes its digest, and writes one `workflow_definitions` row with status `loaded` or `failed{error}`. A digest that already has a row writes nothing. Check: C-J5-02.

11.3.2 Activation: Active is the newest `loaded` `workflow_definitions` row. A `failed` version leaves the previous Active version in place, and the Flow card shows "Merged · not active" with the error (§4.3). Fix `packages/smithers/agent/registry/src/Executable.ts:2037` to keep the previous executable.

11.3.3 The Flow card's "Proposed" version is any open TODO whose change touches `flows/<name>/`.

### 11.4 Pinning

11.4.1 A TODO pins `(flow_name, source_commit, digest)` when it enters Starting. The coding host on the branch machine loads the flow from that commit with the existing `Registry.loadBody(name, digest)` (`packages/smithers/agent/registry/src/Registry.ts:392-440`), which refuses `execution_changed`. It never loads the branch working copy's `flows/` for a TODO run, so a TODO that edits a flow, an imported helper or the lockfile, or rebases onto such a change, still runs its pinned version, and its Retry and Resume restore that version unchanged. Check: C-J5-01.

11.4.2 Retry and Resume reuse the attempt's pinned digest. Retry with the current flow starts a new attempt on the Active version (§4.1, §10.7.1), retaining the TODO's identity and earlier evidence. Two versions of one flow can run at once because each branch machine runs its own coding host. Check: C-STK-03.

11.4.3 A scratch branch may **Run** its working-copy version of a flow with a test input (J11.3). That run is labeled "draft version" and can't be a TODO run. **Plan** on a scratch branch loads the working-copy version inside that branch's machine and returns its graph without running a step (§1.3); for the Active version it reads the stored `workflow_definitions` steps (§11.3.1). A draft-version run of `todo` ends before `stack.propose`: the stack engine refuses a run with no TODO (`not_a_todo_run`), so the run ends there, proposing nothing and writing nothing to GitHub. Check: C-J11-02.

### 11.5 Changing the factory (J5)

11.5.1 `/flow.edit <name> <request>` creates an ordinary TODO with the prompt “Change flows/<name>/flow.ts: <request>; start from the built-in composition when no override exists”. Quote the agent’s proposed diff as revision-1 context. The agent derives the change from that request; no seed patch is stored or applied. Check: C-J5-01.

11.5b **Source** on the Flow card (`/flow.source`) opens the flow's file in the File card on the branch of the TODO that proposes the change. If none exists yet, it first creates that TODO through `/flow.edit`, with an empty seed.

### 11.5a Agent card [S1]

The Agent card shows each factory agent (planner, implementer, reviewer, app agent): its model, a link to its instructions (the flow source), and the runs it took part in. The owner picks the model from the install's model access. The choice is an owner setting stored as the `install_settings` key `agent:<role>`, not a TODO. It applies immediately, to every model call started after the change, including calls in runs already in progress; flow digests don't change. Three model roles are set in Settings and asked for in setup (J1):
- `fast` (Cerebras by default) for the app agent, preflight and timeline summaries;
- `coding` for the coding agent;
- `jev` through the AI Gateway for decisions.

Without a fast-model key, the app agent and summaries fall back to the coding model. The owner-only model assignment (`model.*` commands, `ModelCards.tsx`, `flows/entries/model.ts`) is restored from `39e43c0f^` without the model laboratory (`ModelCallCard.tsx`, `controller/modelCall.ts` stay deleted). `SettingsModels` (786f9ac5) is its duplicate and is deleted. Instructions are Markdown in the repository: the TODO flow's prompts (beside its source) and `.smithers/instructions/app.md` for the app agent. The install loads them as data (never as code, §1.3) from Active `main`. They change through a TODO, and apply to work started afterwards. Tools and permissions change through the overridable flow's source. [D] Editing permissions, tools and budgets is deferred.

### 11.6 Runtime events and the monitor

11.6.1 The flow runtime emits ordered events per run: step started, finished or failed (with input, output and token/time/cost usage), wait opened or settled (kind, since), run attached (the coding host started or resumed the run on a machine; it moves a TODO from starting to working, §4.1), attempt retried, agent transcript chunks, and steer received. The host projects them into `run:<id>`, `todo:<n>` and conversation-entry summaries. Check: C-STK-03. step_started includes step instance and consumed input sequences. Emit model_turn_started with turn identity and consumed input sequences before dispatching each model request; steer_received includes its stable identity and sequence. These journal records, ordered with run_attached, are the timing oracle for input delivery. Check: C-STK-06.

11.6.2 The monitor reads the same events. Each step's label comes from its Appendix C row's Inspect rendering (for example "Planned the change", "Edited retry.ts"). Engine bookkeeping tags render under one collapsed "Engine" row per run. It also shows the run's raw event journal, and the flow's declared custom view (the descriptor's `presentation`) when one exists. The machine produces serializable presentation data; the monitor renders it with install-shipped code. The host and browser never import or evaluate repository modules to render a view. smithers-38 and smithers-3f approve the presentation wire contract before T-FLW-07 starts. Check: C-J11-02. It shows the graph with live step states, per-step input/output/transcript, timeline with attempts, durable waits with "since", tokens/time/cost per step, and a read-only replay scrubber. It has no fork or rewind control (AGENTS.md).

11.6.3 **Phases and cells** (product ruling, 2026-10-02; mvp.md §6.14 Monitor). The monitor groups each attempt's events into phases, one per executed flow step instance, in order. Phase boundaries and titles are deterministic host code over run events: a title is the step's Appendix C label plus the outcome its recorded output reports (failed checks, files changed, findings), for example "Ran checks · 2 failed"; a step with no such outcome shows its label alone. Its tone is live, ok, fail, wait (an open durable wait) or thrash (§11.6.4). Each phase holds cells, one per agent action rendered by its mvp.md B.3 / Appendix C row: context, read, edit, run, think, ask, steer, reviewer or rebase. A cell carries a deterministic label ("Read retry.ts", "Ran pnpm test · 1 failed"), plus the code, output or quote it shows, and its time, tokens and actor. Under each phase title, `agent:fast` writes a one-line summary, and it writes an explanation for each cell an agent wrote. Both render marked as model summaries. They come from the timeline summarizer (§14.5.3) at phase and cell granularity and are stored in `run_summaries` (§3): debounced, written only for runs someone inspects, never blocking the run, using no machine. While one is pending or after it fails, the title or label stands alone, with no error state. The run's trailing wait for merge (§10.4.1) shows as state `held` with since. Each attempt keeps its own graph. Check: C-J11-01.

11.6.4 **Thrashing** (product, 2026-10-02; mvp.md §6.14). Within one attempt, a phase is thrashing when the same failing check fails 3 times with no edit in between to the files that failure names. "The same check" means the same test id, or the same error signature after normalizing paths, line numbers and other numbers. The detector is deterministic host code over run events, with no model. It sets the phase tone `thrash` and adds the TODO card indicator "Thrashing: <check> failed 3×". The indicator clears when an edit touches a named file or the check passes. It is information for a person and changes no run behavior. Check: C-J11-04.

### 11.7 Triggers

11.7.0 [D] User-configurable triggers are deferred (mvp.md §16). This section describes internal triggers only for the MVP; user trigger configuration remains deferred by product Appendix B. The engine and registrar remain internal system facilities. T-CUT-03 unmounts user-management routes in install mode (§6.3.1). Check: C-ACC-01. A trigger binds a flow to a schedule or an event:
- **Schedule:** five-field cron, an IANA timezone, and the next run time shown.
- **Event:** `main` moved, an issue labeled `<label>`, or a PR opened.

11.7.1 [D] Maintainer create, pause, resume and Run now controls remain deferred. Internal scheduled system work retains explicit authority and the main-only secret rules of §8.8.2; event admission from non-members gains no credentialed authority (§17.5). Check: C-ACC-01.

### 11.8 Learning (§6.12, J5.5) [S3]

11.8.1 After each merge, the engine admits a background `learning` run with input `{todo}`. The run reads that TODO's attempts, check failures, review comments and steers, and the outcomes of the last 20 merged TODOs. It writes two kinds of output:
- wiki pages recording decisions with their reasons, each citing the change link and the run ids;
- proposals, each with a title, evidence (counts, TODO refs, failure signatures), a suggested prompt and an optional proposed diff quoted as context.

11.8.2 A proposal is a pending learning note. Make TODO accepts it and creates an ordinary TODO with its evidence and proposed diff as context. Dismiss rejects the note and suppresses its signature for 90 days. Check: C-J8-02.

11.8.2a A proposal's `signature` names the failure pattern it addresses (for example `check:lint@review`). Learning runs never propose a signature that is open or was dismissed within 90 days.

11.8.3 The merged TODO's `lessons` counts the pages written plus proposals created by its learning run.

---

## 12. GitHub sync [S1]

### 12.1 The GitHub App

12.1.1 The App is created during install with GitHub's App manifest flow. The manifest's `redirect_url` is the origin the setup page is served from, whether `localhost` on the Mac or the address a LAN laptop used (§5.1.0). It's a browser redirect, so any origin the browser can reach works. Before posting the manifest, setup step 3 asks which GitHub account owns the repository (a user or an organization name), because the App's owner is fixed at creation. A user-owned repository gets an App owned by that user. An organization repository gets an App owned by the organization (`github.com/organizations/<org>/settings/apps/new`), which needs an organization owner. If the signed-in person isn't one, setup says so and shows the URL to hand to one. The setup browser posts the manifest to `github.com/settings/apps/new` (or the organization's equivalent). The browser redirect reaches `<setup origin>/setup/github/callback`. It is a browser redirect, not a server callback, so no public address is needed (spike within T-GH-01). The host exchanges the code (`POST /app-manifests/{code}/conversions`) and stores the App id, PEM, webhook secret and client id/secret, sealed in PostgreSQL under the install key.

12.1.2 Manifest permissions:
- contents: write
- workflows: write (agent changes may touch `.github/workflows/**`)
- pull_requests: write
- issues: write
- checks: read
- statuses: read
- administration: read (required checks in branch protection)
- metadata: read
- members: read

The webhook is created inactive (`hook_attributes.active = false`), because polling is the contract (§12.2). Callback URLs: the configured origins plus `http://localhost:4000` (§16.3.3).

12.1.3 The owner then installs the App on the one repository. The install records the installation id. T-GH-01 collapses the seven installation-token minters to one and deletes the others in the same change. Check: C-GH-01.

### 12.2 Polling (M-03)

The existing pollers run at M-03 cadences with ETags and cached scoped tokens (E-08). Change their constants (`github_main_pull.go:40`, `mythical_items.go:51-52`, `mythical.go:39`); no new stream scheduler or sync table.

| Stream | Request | Cadence |
| --- | --- | --- |
| refs | `git ls-remote` of `main` and `refs/heads/smithers/*` | 30 s |
| pulls | `GET /pulls?state=all&sort=updated&direction=desc&per_page=50`, conditional | 45 s |
| PR state and checks | The existing `follow` loop per open TODO PR (`HeadChecks`, `mythical_github.go:611`), conditional | 45 s |
| review comments | `GET /pulls/comments?sort=updated&direction=desc&since=…`, conditional | 45 s |
| conversation comments | `GET /issues/comments?since=…`, conditional | 45 s |
| issues | `GET /issues?state=all&since=…&sort=updated&per_page=100`, conditional | 120 s |
| issue events | `GET /issues/events?per_page=100`, conditional, paged back to the durable event-id cursor (§10.2.1a) | 120 s |
| members' permission | `GET /collaborators/{login}/permission` | hourly |
| installation token | `POST /app/installations/{id}/access_tokens` | 5 min before expiry |

12.2.1 Every REST read is conditional (`If-None-Match` with an in-memory ETag). Each cursor stays at the newest `updated_at` or event id seen, so an unchanged stream repeats its URL and gets 304. The issue-events cursor is an `install_settings` key; other cursors, ETags and health live in the pollers' memory. Installation tokens are cached per permission set until five minutes before expiry. Use `landingGitHubAPI.request` (`landing_github_pull.go:421`) for every call and delete the duplicate rate-limit parser (`github_import.go:2426`).

12.2.2 Rate limits. When `X-RateLimit-Remaining` for a resource falls below 20 % of its limit, the issues, issue-events and members' permission cadences double until the reset; the other streams keep theirs. A 403 or 429 with `Retry-After` pauses that stream until `retry_at` and marks health `limited`. Check: C-GH-08.

12.2.3 Targets: PRs (state, reviews and comments), checks and `main` within 60 s of the change on GitHub, in the worst case: the 45 s cadence (30 s for refs) leaves 15 s for the fetch and the projection. Issues within 5 min (§9 of mvp.md). Measured by check C-GH-07. Health (§4.4) uses the required streams (refs, pulls, PR state and checks) against a 60 s target. When several states hold, `refused` > `limited` > `stale` > `fresh`. Only `mirror: pull` is supported for the install's repository.

12.2.4 Webhooks are optional. When the install has a public URL, a signed delivery triggers an immediate fetch of its stream. Webhooks never stretch a cadence, so a missed delivery costs no freshness. Webhook payloads are never trusted as the final state; the fetch is.

### 12.3 Inbound mapping

12.3.0 Every inbound GitHub fact has a defined outcome in every TODO state: a transition (§4.1), a recorded no-op (one activity row, no state change), or stack attention (§4.1.2a). The existing `follow` loop maps each fact; a duplicate or stale fact is a recorded no-op, never a refusal or an error. A landed item over a dropped TODO never adopts a second TODO. Check: C-GH-13.

12.3.0a Cases the matrix exposed (QA, 2026-10-02; tech-lead rulings):
1. A foreign push to `smithers/<slug>` opens its own `foreign_push` wait (§10.8.0) in any unmerged state with an open PR; waits stack and never overwrite one another. A later foreign push with a new sha while that wait is open updates the wait's recorded sha and writes an activity row; a decision made against an older sha is refused as stale (§12.3 Discard row). In queued or starting with no PR yet, the push is recorded and the next propose leases against it.
2. A member's review or PR comment while the TODO is failed is recorded (activity row) and held as a steer; Retry delivers held steers as the new attempt's first input.
3. A dropped TODO whose change later lands on `main` (contained in another merged PR) becomes merged with `merged_via` (M-22: GitHub's merge is the truth). No other TODO ever adopts its item.
4. Removing the `todo` label, or closing or reopening the issue on GitHub, updates the synced issue only; the TODO is unchanged (a TODO is committed work, not the issue).
5. Deleting a comment withdraws its steer only while the steer is still held (not yet delivered); a delivered steer stays in the record.
6. Re-applying `todo` (a new label event) to an issue whose TODO is merged or dropped creates a new TODO under §10.2.1's admission rules.
The reopen window is 7 days from the drop or close time, inclusive at exactly 7 days.

| GitHub change | Smithers effect |
| --- | --- |
| `main` moved (fast-forward) | Mirror updates. The home `main` row updates. Later items get `rebase_pending` (§10.5). A flow load (§11.3.1). |
| `main` rewritten (not a fast-forward) | `attention{kind: force_push}` for the owner. **Reset to GitHub main** (`main.reset-to-github`, in-card) appears on the Needs you card. Only the owner's session may invoke it; agents cannot invoke it or request delegated confirmation. The owner confirms before it resets the mirror and rebases the stack onto the new `main`. Checks: C-CAT-01, C-ACC-01, C-J10-07. Reset, ordinary pulls and merge dispatch share repository serialization and the repo-host write lock. Recheck attention and merge fences under that boundary before expected-old ref writes. Persist reset intent before writing; attention settlement, projections and keyed main-moved intents commit atomically afterward. Consumers recover idempotently, including machine-only flow loading. At a third mirror tip, recovery preserves the ref and leaves attention open. Check: C-J10-07. |
| Issue opened, edited or commented | The synced store updates (§3.0). The issue card updates. |
| Issue labeled `todo` | Admitted or reverted by the §10.2.1 table. An admitted TODO takes the first issue read after the label event as revision 1 (§10.2.1a). |
| Review with "changes requested", review comment or conversation comment on a TODO PR | Activity entry with the GitHub mark, attributed to the member whose GitHub login wrote it. From a member: delivered to the run as one steer per review submission (its comments batched, anchored to path:line) or per standalone comment; `in_review → working`. From a non-member: shown in activity as `{github: login}` and never delivered as a steer (§17.5). An edited comment updates its entry and is re-delivered only if the run hasn't consumed it; a deleted one hides its entry. Review activity, delivery receipt, TODO transition/events and durable steer intent commit in one transaction through transaction-aware admission. Dispatch follows commit. Resolve current active membership at admission and held delivery; historical membership or login attribution grants no steer authority. Removed, suspended and outsider authors remain record-only. Check: C-J10-02. |
| Review "approved" | Recorded on the PR card. Not a Smithers approval (§10.6). |
| Checks finished on a TODO PR head | Evidence updated. A failed required check names itself on the Merge control. |
| TODO PR merged | `merged` (§4.1). The linked issue closes with a link if `fixes_issue`. Later items rebase and their PRs are force-updated (§10.6.3). |
| TODO PR closed unmerged | `dropped` with "closed on GitHub by @x". Reopen within 7 days restores `in_review` at the TODO's previous stack position when it is still free (otherwise appended), with `smithers/<slug>` recreated at its last accepted generation's PR head and no run; the first input that needs work starts a new attempt (§10.7.4). Check: C-J10-08. |
| Push to `smithers/<slug>` by anyone other than Smithers | `needs_you{kind: foreign_push, by, sha}`, whether the TODO is working or in review: "Alice pushed to `smithers/retry-webhooks` on GitHub", linking the commit. Smithers never overwrites a person's commit (M-33): the agent's next push is held while this is open. A newer push while it is open updates it to name the newer sha, and every pushed commit is kept. The answers are:
- **Bring in**: the decision names the sha the card shows and is refused as stale (class `conflict`) once a newer push arrives. The stack engine fetches that commit and rebases the item onto it at the run's next checkpoint (§9.4); the agent resolves conflicts, and the pushed change becomes part of the item's change, attributed in activity;
- **Discard** (maintainers only, mvp.md B.4): explicit. The decision names the sha the card shows and is refused as stale (class `conflict`) once a newer push arrives. The commit is kept in the host repository store (`refs/smithers/kept/<sha>`) and linked from activity. The next verified push leases against that sha (§12.5.2). If the branch moved again before it, the lease fails, nothing is overwritten, and the Needs you reopens naming the newer sha. [D] Merging such pushes into the working copy is deferred. |
| A teammate's own branch or PR | `/review` works on any PR a member opened: it admits a `background` ephemeral machine at the PR head, which counts against capacity and never holds a TODO's machine, and it writes nothing to GitHub. A non-member's PR is refused (§17.5; outside-PR review waits for the maintainer release, mvp.md §8). Check: C-J10-09. [D] **Open on a machine** is deferred. |

### 12.4 Outbound writes

12.4.1 The existing stack lease serializes one `pending_op {kind,target,desired,precondition,state}` per item for push, open PR, body, merge and close PR in propose/merge/drop. Commit intent, then mark it potentially sent before the call; never overwrite an unsettled slot. Labels, unlabels, comments and issue-close remain best-effort with the existing comment marker. Checks: C-GH-09, C-DUR-03.

12.4.1b Reconcile the slot at boot and before the next operation. Push compares the remote head to desired/precondition; open PR looks up its head branch; body compares the digest; merge reads the PR; close reads canonical-App events then current state. Lookup precedes any repeat. A foreign change conflicts rather than being overwritten. An applied merge settles without another send. Otherwise merge requires the same bound head, active checks.Land or checks.Automerge, current approving-maintainer authority and fresh DecideMerge under the matching fence; missing wiring refuses. A stale unsent merge clears its slot and reevaluates without fabricating approval. Drop's durable item state retains the close obligation until any uncertain open settles. Machine proxy mutations refuse before token issuance. Checks: C-GH-09, C-DUR-03, C-STK-07, C-STK-13, C-SEC-03.

12.4.2 Writes are made as the App and attributed in the body ("Requested by @owner", "by @ben via Smithers").

### 12.5 Pull requests [S1]

12.5.1 A TODO's PR opens when its run reaches `in_review`. Head: `smithers/<slug>`. Base: `main`. Only the first item's PR is ready for review on GitHub; later items' PRs are opened as **drafts**. When an item merges, the next PR rebases onto the new `main`, holds only its own change and is marked ready (GraphQL `markPullRequestReadyForReview`). When an item stops being first (moved down, or an item placed before it), its PR returns to draft (`convertPullRequestToDraft`). GitHub offers draft PRs only on public repositories and on paid plans. Where drafts are unavailable, later PRs open ready, with the title prefix "[waits for Tn]" and the label `smithers:waiting`, and Smithers enforces the order. The head commit has the tree of the item's accepted generation (§10.4.4) on the generation's recorded main base: that base plus the immutable included-items manifest (§10.3.2a) plus this item's own change, each once. The body has the prompt (latest revision), acceptance, evidence (checks table, diff stat, review summary), the earlier stack items it includes ("Includes T3, T4 until they merge"), a link back and "Requested by @owner". The PR card in Smithers shows only the item's own change: the diff from the previous item's candidate to this one. Check: C-STK-06. If a person marks a later PR ready on GitHub without a stack-position change, sync its actual draft state and do not issue a corrective redraft merely because it is later. Smithers still enforces §10.6.2a's order and shows `Merges after Tn`. A subsequent change of position applies the ordinary ready/draft policy through §12.4, subject to its event and conflict reconciliation. If that later PR actually merges, apply §10.6.4. Checks: C-STK-04, C-STK-07, C-ACC-02.

12.5.1a [S1] The outbound invariant is that every PR head Smithers writes has the exact tree of a persisted accepted candidate; GitHub need not display the current candidate during recapture or push settlement. Keep the last settled pr_head distinct from the intended pending head and current candidate. Smithers Merge remains held until the current candidate is accepted and its push is settled. If GitHub merges the older displayed head, reconcile that actual merged head and commit under §10.6.4; do not infer containment from the newest candidate or pending head. The directly merged TODO becomes merged once its merge commit is on main; newer unlanded work is preserved in the branch's final capture, not described as landed. No automatic second merge or fabricated approval follows. Checks: C-STK-06, C-STK-07. Every host publication git caller uses controlled configuration that disables repository hooks, external diff, textconv, merge drivers and credential helpers, including repository-local configuration. Repository programs run only in machines, with isolation refusal and no host fallback. Check: C-J10-01.

12.5.2 The branch reaches GitHub when the PR is proposed and on every later verified update, with `--force-with-lease` against the remote head Smithers last accepted: its own last push, a brought-in sha, or the sha a Discard named (§12.3). A refused lease is never retried: the push row settles `conflict`, and the observed head raises `foreign_push` (§12.4.1b).

12.5.3 [D] Stacked bases with retargeting, in-app line comments mirrored as review comments, and agent replies in review threads are deferred. In the MVP, the agent's response to a review shows as new commits and in the branch activity.

### 12.6 Health surface

`GET /api/github/sync` and the `home` topic expose `{state: fresh|stale|refused|limited, last_success_at, cause?, retry_at?}`. The client computes "synced N s ago" from `last_success_at`, so no delta is needed each second. **Retry** immediately schedules all streams subject to persisted `retry_at` and shared budget admission; any member may press it (`agent: run`). Repeated Retry during a rate-limit pause or exhausted budget sends no upstream request. Stale-boundary timers recover on startup and publish without polling. Check: C-J10-06. The `/github` command and external-agent skill read status only through GET /api/github/sync. Retry uses the separate in-card descriptor `github.retry`, minimum role Member, agent: run, and POST /api/github/sync. Checks: C-J10-06, C-CAT-01.

---

## 13. Wiki [S1; citations and co-editing transport S3]

13.1 Storage: wiki pages and their revisions live in PostgreSQL plus the blob store. The Markdown with frontmatter is canonical, and attachments live in blobs.

13.2 Co-editing: §7.4 with the host as document owner. Backlinks and outline come from the existing navigation index.

13.3 [S2] Obsidian: the existing folder sync (`wiki_sync.obsidian`, `B/services/wiki_sync_obsidian.go`) becomes a Settings control on the install's Mac. The owner picks a folder, which the worker reads from `install_settings` instead of host config. The sync keeps bytes, frontmatter and attachments, and edits made in Obsidian import as page revisions attributed to the owner. [D] Laptop access to the vault over git stays deferred.

13.4 Planning reads the wiki through the API. It chooses pages with the same selector as the app agent's preflight (§15.1.2) restricted to wiki pages, using the TODO's prompt. A plan receipt records `{slug, revision, digest}` for every page it cited (J8.4).

13.5 Generated pages refresh after merges through the existing wiki flow, using the install-stored default declaration when the repository has none (§11.2).

---

## 14. The app [S1; Branch and File cards S2]

### 14.1 Shell and branch conversations

14.1.1 Each branch has one conversation, shared by everyone on the branch (M-08). `main`'s conversation is the team's home: it opens with the Home card (the stack) and is where most members start. A branch tree navigates between conversations, showing a branch, the branch it forked from, and its children. ⌘K opens the composer and palette in the current branch's conversation.

14.1.2 Entries are shared: prompts show their author, and cards are the same cards for everyone. Each member keeps their own scroll position, card view state (maximized, tab, filters) and last-seen entry in `collaborators.view_state`. Opening a conversation restores that state.

14.1.3 There is no person-to-person chat. A prompt is always addressed to an agent. People coordinate through presence, live edits and branch activity.

14.1.4 UI-only flows (theme, open, maximize, navigate, palette, filters, input mode) affect only the screen of the person who ran them, even when that person's app agent ran them. They never write shared state.

14.1.5 Legacy per-member conversations stay readable. Each one becomes a read-only archived conversation that only its member can see, and it is listed under the branch tree's "Earlier" node. Nothing is migrated into a shared conversation (AGENTS.md: old sessions remain readable). Removed card kinds decode through one legacy decoder as read-only tombstones that keep their title, so legacy and shared conversations stay readable after any card is removed; a kind is never live and legacy at once (card-kinds.md §2, T-APP-22). Check: C-CUT-02.

### 14.2 Cards are projections

Every card renders one live topic (§7.2) or a set of topics, and every card action runs one catalog command (§6.1). Cards hold no business state. The same component renders inline and maximized.

14.2.1 Design owns Views, shell components and CSS. Engineering uses the existing card file as the container: it maps data to View props and binds catalog actions through `flows/cardActions.ts`. `CardRenderers.tsx` is the only card mount point. A View takes props, imports no state, flows or RPC and does no fetch. Its handlers call `onAction`, call `onView` or change local state, focus or the clipboard. The same rules cover shell components. Check: C-UI-08.

14.2.1a A wiring ticket replaces the legacy rendering in the same commit: HomeView replaces StackCard and RepositoryHomeCard; ConfirmView replaces ApprovalCard and ApprovalAnswer; FlowView replaces WorkflowCards; File/Diff replace FileCards/CodeSurface and ChangeCards/DiffSurface; Run replaces RunTraceCard and RunsCards. Keep the existing file as the container and delete duplicate rendering. C-UI-13 passes a card row only when its View is mounted and its legacy duplicate is deleted.

14.2.2 The publishing ticket owns the topic builder. Each card ticket owns its schema and maps topic data, viewer state and actions in the existing card file. No separate Container class, fixture layer or golden layer is required. Delete kinds in `packages/rpc/src/Cards.ts` that duplicate the new schemas; retain one read-only decoder for old conversations. T-STK-04 owns `prs.land` and POST /api/todos/{n}/merge; T-APP-04 binds Review & merge to that command. Home ownership remains T-COL-02 for snapshot and decoder, T-APP-01 for mapping and commands. T-COL-02 owns the LiveChannel client; T-COL-02 extends it. Checks: C-UI-08, C-UI-13, C-STK-04, C-ACC-02, C-COL-02.

14.2.2b [S1] The S1 TODO conflict view takes a card-rendered terminal slot outside the rpc model; its conflict wait carries an optional ssh_line. TodoView places the slot and renders the line without connecting a terminal or executing commands. T-STK-08 owns wiring and schema changes. Checks: C-UI-08, C-UI-12, C-UI-13.

14.2.2a [S1] T-APP-19 and T-APP-19b are landed history. Each card ticket owns its schema changes and public API review under §21.1. Checks: C-UI-08, C-UI-12.

The seam is one zod schema per card in `packages/rpc`, exported through per-module subpaths. §14.3 defines the fields. Each card ticket updates its schema and View together. Check: C-UI-08.

### 14.3 Card models

14.3.0 **Inventory.** Each row of the table below is a card whose View renders a §14.3 model, and a View in `apps/app/src/mainview/cards/views/` exists only for a row here. A ticket that adds a card adds its row and its ui-components.md props in the same change. The shell parts take their fields from the sections that define them: entry rows and the Context line (§14.5.1, §15.1.2), timeline lines (§14.5.4), toasts (§14.4), branch tree nodes (§14.1.1) and actor chips (§14.6a). The Stage column says by which stage the card's View is mounted and its schema exists; fields tagged with a later stage are absent or empty until then (check C-UI-13). Retained cards keep their existing schemas in `packages/rpc/src/Cards.ts`, which are their contract, and have no row here. Each keeps its current renderer, outside `cards/views/` and the View-seam rule, and the ticket named with it owns that renderer and its schema snapshot: Issue (`issue`, T-GH-02), PR (`pr`, `change`, T-GH-03), Review findings (the `change` card's `ChangeReviewSchema` and `ChangeFindingSchema` in `packages/rpc/src/Changes.ts`, T-FLW-11), Wiki (`world`, `wiki-history`, `wiki-links`, `wiki-graph`, T-COL-09), the flow Form (`flow-form`, T-CAT-01), the webpage reader (`browser`, T-APP-15), the plan view (`flow-plan`, T-APP-05), the run list (`run-list`, T-FLW-07), and search results (`search-results`, T-APP-16). Any other card that mvp.md Appendix B names and this table lacks is retained the same way, owned by the ticket that wires its flow. A change to a retained card's fields is a spec change that first adds its row here. Checks: C-UI-08, C-UI-13. Retained kinds also include `file-list` (T-APP-15), `issue-list` (T-GH-02), `pr-list` (T-GH-03), `workflow-list` (T-APP-05), and `plan` and `status` (answer parts, T-APP-16). Deferred and hidden surfaces keep their card kinds and schemas: `anonymous-ceiling`, `balance`, `billing-plans`, `environment-images`, `repo-update`, `repository-choice`, `sync-ops`, `trigger-list`, `workflow-repo` (card-kinds.md §3). Check: C-CUT-02.

14.3.0a [S1] Shell data contracts include BranchTreeNode archive_count (required for the Earlier node), optional supplied node action, EntryRow tombstone (title only), branch/archive navigation view fields and shared ShellView {toast_hidden?, jump_to?, on_screen?, timeline_visible?}. Each shell ticket owns its schema changes. Callback and rendered React slots belong to the props, not serialized models. Checks: C-UI-08, C-UI-12. Catalog inputs use draft.discard {draft: DraftId} only, confirm.cancel {confirmation, revision} with the existing Confirm-card revision schema, and settings.model.set {role, model} with the existing model-role enum and model-catalog id schema. The role ids include jev; Decisions is view copy only. Runtime parsing uses strict z.object schemas and producer tests reject extra or invalid fields. The catalog policy table enforces Draft author-only, confirmation person-only and model owner-session-only/agent-never rules. A stale confirmation revision returns typed stale. Checks: C-CAT-01, C-UI-08, C-UI-12. The S1 conflict View uses the selected-conflict terminal slot in §14.2.2b. React terminal props stay outside packages/rpc; the View opens no connection. T-STK-08 owns wiring and schema changes. Check: C-UI-13.

| Card | Topic | Stage | Model fields (all present in the projection; TypeScript in ui-components.md) |
| --- | --- | --- | --- |
| Home | `home` | S1 | Repository name; `main {sha, title, last_success_at, health: fresh|stale|limited|refused, cause?, retry_at?}` (§4.4); `attention[] {kind, text, todo?, actions[]}` (mythical_stacks.attention for this viewer); items[] `{n, title, state, owner, place, queue?, step?, rebase_pending?, needs_you? {kind, prompt}, merge, pr? {number, draft}, approval_cleared?, amendments, lessons?, branch {id, name}, present[], elapsed_s?, actions[]}`, where `present[]` holds actors, agents included (M-34), and `merge` is the TODO row's; counts by state; merged_since_last_look (per member); machines `{in_use, capacity, slots[] {branch, actor, awake}}`; [S2] parallel (owner only, T-STK-03); background_runs[] `{id, title, state: queued|running|waiting|failed, detail?, actions[]}` with Retry and Dismiss (in-card): Retry admits a new background run of the same flow, version and input; Dismiss writes `workflow_runs.dismissed_by` (§3), so the run leaves every member's card while its record stays. A finished run leaves the card. "Last look" advances when the Home card has been on screen for 2 s |
| TODO | `todo:<n>` | S1 | n, title, state, owner, owner_removed? (removed or suspended; Take over, §5.6), place?, queue?, pause? {reason: person\|daily_token_budget, owner?, since, resume_at?} (§15.2; daily_token_budget renders "Paused · daily token budget · <owner>"; C-STK-03), rebase_pending?, step (its label); prompt revisions `{text, acceptance[], by, at}`; issue `{number, url, fixes}`; branch `{id, name, machine}`; present[]; the run's step list with `waiting`/`paused` states and its trailing wait for merge (`held`); the run's indicators (waiting for a person since; thrashing, §11.6.4); open waits[] `{id, kind, prompt, since, paths?, ssh_line?, by?, sha?, actions[]}`, primary first (§4.1.0a); the latest question's first answer; steers[] `{text, by, at}` (§10.7.3); failure `{step, class, message, retryable, missing_tool? {name, file}}` (§8.6.2; Add to machine image); evidence[] per attempt `{attempt, revision, items[], previous? {revision, items[]}, reviewing?}`, where items are the diff stat, machine checks `{name, state, took_s?, log_url?}`, GitHub checks `{name, state, required, url}`, the review summary, usage, the flow version and the model access (§10.4.3); PR `{number, url, head, draft, draft_after ("Draft · merges after T8"), included_items}`; merge `{state: ready|waiting|blocked|merging|done, reason?, detail?, on_github}`, where `reason` and `detail` are §10.6.2a's `merge_block`; approval_cleared?; `merged_via` ("Merged · in T15's commit", §10.6.4); lessons? |
| Branch | `branch:<id>` + `:activity` + `:files` | S2 | Machine (§4.2: awake, asleep, waking, waiting with its position, closed, or failed with its error and Retry) with in-card Sleep and Wake; item `{n, title, state, step?, place}` or scratch `{forked_from}`; rebase: pending `{onto, waiting_for?}` (`waiting_for` names the busy writer, sent only to the member who pressed Rebase now, §9.4.2), rebasing `{onto}`, or a scratch conflict `{onto, paths[]}` with Resolve and Done (§8.5.2b); moved_off; presence[] `{actor, where: file {path, line?} | terminal {id} | step {label} | branch, watching?}`, people and agents (M-34); terminals[] `{id, title, owner, agents[], watchers[], command?, frozen}`; activity[] `{actor, asked_by?, kind, text, items?, files?, github, at, actions[]}` (§3), where a change or edit entry's action opens its burst's diff; changed files `{path, change, renamed_to?, authors[]}`; the SSH line |
| File | `branch:<id>:files` and the file content route (§6.3); live doc `doc:code:<branch>:<path>` [S3] | S1 | [S1] path, branch, language, digest, content (text; too large, with its text; or binary), github_url? (required for binary and too_large content; supplies the on GitHub link; C-UI-08), mode (read_only or live), last writer, diagnostics, the hover result, reveal (a same-file definition or a cited range). [S2] gone `{deleted, by}` or `{renamed, to, by}`; `outside {version, at}` (the outside version that Compare reads, §9.2.3); editors[] `{actor, line}` from presence. [S3] authors[] with the editor binding's author ranges (ui-components.md § T-UI-19); editors from awareness; saved state; unsaved `{count, text}` ("N edits weren't saved" with Reapply and Copy, §7.4.6) |
| Diff | `branch:<id>:files` | S1 | Path and branch; against: the previous item's candidate (§12.5.1), a scratch branch's fork revision (§8.5.3b) or one burst's before and after versions (§9.3.4); change and renamed_to; binary sizes; hunks `{old_start, new_start, lines[] {op, text}}`; Restore this file on a burst diff (§9.3.5) |
| Terminal | terminal stream + `branch:<id>` | S2 | Id, title, branch, owner, the agents working in it (M-34), watchers, running command, viewer_is_owner, frozen ("Rebasing…", §9.4.2) |
| Flow | `flows` | S1 | Source label (built-in or `flows/<name>/flow.ts`), versions `{state: active|proposed|merged-syncing|merged-failed|previous, todo?, error?, steps[] {id, label, detail?, agent?, added?}}`, and for the TODO flow the trailing merge wait with its signals (clean rebase → check, resolved conflict → implement → check → review, steer → implement); actions Source, Plan, Run, Edit; the agent of each step |
| Members / Secrets | `members` / `secrets` | S1 / S2 | Login, name, avatar, color_index, role, needs_access (never had write access), suspended (lost it; automatic, §5.1.3), each row's Role and Remove, and the repository's GitHub access URL; secret name, scope (`all_branches` or `main_only`, §8.8), optional bound hosts (set in Add and Replace; no separate Bind door), each row's Replace and Delete |
| Setup / Settings | `install` | S1 | Address `{listen, bind, origins[]}`; steps[] `{id, state: pending|running|done|blocked|failed, blocked? {line, fix_url}, error? {class, message}, pct?}` for the setup steps in §16.2 order (`address`, `app_manifest`, `sign_in`, `repository`, `models`, `source`, `machine`), with the ids and states T-INS-06 stores (the squash check runs inside `repository` and blocks it with its fix link); "This Mac" (the detected host, its limits and, when capacity is 0, the limiting term and its fix, §8.2.1a); GitHub `{owner?, signed_in, app_installed, squash_allowed?}`; repository, and the choices while it is being chosen; models[] `{role: fast|coding|jev, provider, key: none|validating|saved|failed, error?}` (shown as "Fast model", "Coding model" and "Decisions" with its "AI Gateway key", mvp.md §6.5) and the ChatGPT sign-in flag. Settings adds capacity, [S2] parallel (T-STK-03), existing budgets and todo_daily_admissions (default 12; positive integer; owner may raise it), stored in install_settings and shown beside the budgets (§10.4.1b; T-APP-03; C-STK-06), the laptop-agent lines `smthrs login <origin>`, `notifications_need_https` (§14.6), health `{process, postgres_bytes, disk_free_gb, github {health, cause?, retry_at?, rate_remaining, rate_limit}}` (§20.2) and [S2] the Obsidian folder `{path, last_sync_at?, error?}` (§13.3) |
| Proposal | `proposals` | S3 | Title, evidence, refs, state, and the TODO it became `{n, title}` |
| Draft | browser-local until Commit, then `conversation:<branch>` (§14.5.1) | S1 | title, prompt, acceptance[], place `{mode: append|before|amend, n?, options[] {n, title, state}}` (unmerged items only), issue `{number, title, url, fixes}`?, seed `{files[]}`? (proposed diff context, shown read-only), committed `{n, rev}`? (rev 1 is a new TODO, rev > 1 an amendment shown "+1"), private (true until Commit). The fields live in browser draft state. Commit runs `/todo.new` or `/todo.amend Tn` once, with one `Idempotency-Key` (§6.2.1) |
| Commands | none: `catalog.mvp.json` (§6.1.2), fixed per install version | S1 | groups[] `{label, advanced, commands[] {tag, synopsis, description, agent: run|confirm|never}}`, filtered for the viewer's role; `synopsis` and `description` are the Appendix A command and its line |
| Run (monitor, Inspect) | `run:<id>` | S1 | Title, todo?, branch?; state incl. `held` for the wait for merge; attempts[], oldest first (a TODO's attempts; one for any other run), each with its run id, state, graph, steps[] per step instance `{key, id, k, label, state, started_at?, ended_at?, took_s?, input, output, agent, usage? {tokens, cost_usd}}` (no usage for a step with no model call) and phases[] `{id, step, title, summary?, took_s, tone, indicator?, cells[]}` with cells `{id, kind: context|read|edit|run|think|ask|steer|reviewer|rebase, label, explain?, code?, output?, quote?, tone?, took_s?, tokens?, actor?}`. `title` and `label` are deterministic (the step's Appendix C label plus its recorded outcome, "Ran checks · 2 failed"; "Read retry.ts"); `summary` and `explain` are optional `agent:fast` lines rendered as model summaries (§11.6.3). Phase and cell ids are stable across deltas. Waits[] `{id, kind, label, since, settled? {by, at}}`; tokens, time and cost; Appendix C engine labels; the journal, loaded when its tab opens; replay `{at, last}` (the container re-projects the run at journal seq `at` and writes nothing, §11.6.2); the flow's custom view, passed to the View as a rendered slot |
| Agent | `agents` | S1 | Name, instructions path, role (shown as "Fast model", "Coding model" or "Decisions"), model and the owner's choices, runs it took part in |
| Confirm | `confirmations:<member>` | S1 | Kind (`one_click` or `review_merge`), action, a one-line summary, subject `{kind: todo|branch|flow|agent|wiki, ref, revision?}`, the exact text the command sends (one_click), who asked, and for review_merge `{title, place, pr, evidence, approved_revision?, merge}` with each check of the subject revision; a receipt `{by, result: done|cancelled|expired, at, text?}` |
| Docs | none: pages bundled in the app (`apps/app/src/docs/`) | S2 | toc[] `{slug, title}`, page `{slug, title, summary, markdown}`, anchor?, not_found? (M-35, T-APP-20) |
| Debug API | none: `docs/api/openapi.yaml`, bundled | S2 | TypeScript browser projection (T-UI-22, dark until T-APP-21): operations[] `{id, method, path, summary, group}`; selected?; pending `{method, path}`? (a mutation waiting for its in-card confirmation); exchange `{request {method, url, headers, body?}, response? {status, headers, body, duration_ms}, failure? {class, message, status?}}`; the Send action's form comes from the operation's parameters and body schema (M-36, T-APP-21) |

### 14.4 Toasts

14.4.1 Notable events and anything that needs action pop as toasts with their one action: Needs you, an approval, a PR ready for review (in_review), a failure, a rebase conflict, and the merge of the viewer's own TODO. A toast goes to the people §10.8.3 names (the TODO's owner and those present on its branch) and to the prompter for their own runs. Every toast is also an entry in its conversation, and therefore a timeline line.

14.4.2 Each member can hide toasts (`collaborators.view_state.toasts_hidden`, plus one global preference). Hiding never hides the entry, the edge map or the home card.

14.4.3 Background progress for a member's own commands uses the shared toast stack: 300 ms debounce, through launch and execution, settled only by the real terminal event, at most three plus "+N more". Actions are Open, Stop, Steer, Answer and Retry.

14.4.4 Live work in cards scrolled out of view shows on the left edge, top-left for above and bottom-left for below, each with its single action.

### 14.5 Conversation entries and the timeline

14.5.1 Branch history reads `chat_turns` and `chat_turn_batches`, including prompt, answer, card and event output, ordered by the existing replay cursor. Shared output is append-only. Confirm cards remain member-private `approvals`; an uncommitted Draft stays in the browser and Commit creates one ordinary TODO and shared event. Neither is model input. View state lives in `collaborators.view_state`, keyed by branch. Reopening an entity focuses its existing card. Check: C-UI-06.

14.5.2 **Tone** is derived deterministically: live while a run is active, attention for Needs you and stack attention (`order`, `force_push`), failed, done, quiet otherwise, In review included (ui-components.md Tone). **State** is the TODO state word when the entry is a TODO or its run, else null. **Action** is derived per viewer from state, `needs_you.kind` and the viewer's role, and is never stored per viewer:

| State / kind | Action |
| --- | --- |
| question or approval | Answer → `/todo.answer Tn` |
| conflict, moved_off | Resolve → `/branch Tn` |
| foreign_push, order, force_push | Review → `/todo Tn` (force_push: owner only; order: maintainers) |
| failed | Retry → `/todo.retry Tn` |
| in_review, first in order, viewer may merge | Merge → `/merge Tn` |
| otherwise | none |

14.5.3 **Summary** is one line written by the install's cheap fast model (`agent:fast`, §11.5a) from the entry's run events. It is shared by everyone who sees the entry. While at least one subscriber has the timeline on screen (the client renews a 30 s `timeline_visible_until` lease in its `view:<member>:<branch>` state) and the run is live, it is refreshed 5 s after the last event and at least every 30 s while events keep arriving. Otherwise it is written once per state change. A summarizer failure keeps the last summary. The summarizer never blocks or slows the run, and it uses no machine. The same summarizer writes the monitor's phase summaries and cell explanations (§11.6.3) into `run_summaries` (§3), only for runs someone inspects. When a `run:<id>` subscription opens, it fills the missing ones with one call per phase. While that subscription lasts, it refreshes a live phase 5 s after its last event and at least every 30 s, and retries a failed call every 30 s. A pending or failed one leaves the deterministic title or label standing alone, with no error state (check C-J11-01).

14.5.4 The timeline (desktop only) shows one line per entry with its title, summary and tone. A band marks the entries on screen, and clicking a line scrolls to it. On narrow screens each edge collapses to one pill. The timeline replaces `ChatRunTimeline`. Desktop means a viewport at least 1180 px wide; below that the timeline is absent and each edge collapses to one pill (design G2, 2026-10-02).

14.5.5 **External-agent conversations (M-38).** [S2] Claude Code and Codex conversations from branch terminals appear in the branch's shared conversation through the same prompt, assistant, tool and error components as Smithers agents. Imported prompts name the session owner. Assistant turns and tool events name the registered agent participant, with its own avatar and "for Ben" (§14.6a, M-34). Source identities and ordered transcript events do not create executable Smithers runs. Entries carry `origin: external`, agent kind, source format version, session and participant ids, and `read_only: true`. Copy, disclosure and navigation remain available. Edit, resend, answer, approve, retry, stop and steer controls are absent for imported content; backend mutations against external identities are refused. Imported prompts never enqueue app-agent turns; imported tool text never invokes commands. T-AGT-01 owns mapping and adapters, T-AGT-02 ingestion, and T-AGT-03 wiring. Design extends T-UI-07's shared chat presentation in S2. Checks: C-AGT-01, C-AGT-02.

### 14.6 Browser notifications [S2]

When the tab is hidden, a Needs you, In review or Failed toast for that member (§14.4.1) also raises a browser notification. There is one permission ask, a toast with **Allow notifications** (`notifications.allow`, a person-only gesture, since `Notification.requestPermission()` needs one) at the member's first Needs you. A click focuses the tab and opens the card. Delivery is the live channel; no service worker, no push. The Notification API exists only in secure contexts (https or `localhost`). On a plain-HTTP origin the toast still appears and the Allow toast is not shown. The quickstart's HTTPS examples (§16.3.4) are how a team gets notifications. [D] Email and phone stay deferred (#3423).

### 14.6a Actor rendering

14.6a.1 Every working agent is a participant with its own stable id, kind, avatar and session/run id; `for_member` records the person it acts for and is absent when no person delegated the work. Adapt existing `{person, via}` and `{agent: coding, run}` actors into this participant model without changing authorization. Presence, activity, line flags and terminals render the same participant and "for Ben" when present. System events keep the system actor and never impersonate an agent. T-APP-09 owns the actor adapter; T-COL-06 owns participant presence, T-COL-04 activity, T-TRM-05 agent terminals, and T-APP-14 line-flag data. Checks: C-J3-01, C-J6-01. Smithers, Coding agent, Claude Code, Codex and Reviewer each render their own avatar, for example "Claude Code for Ben". The broker registers each agent process lifetime and session/run. A command in a person's terminal is not an agent by inference. Participant ids confer no authorization rights. Checks: C-J3-04, C-J3-10 (line flags and terminal fixtures). The ticket touching actor rendering collapses actor-label modules to one and actor, via and role enums to one each in the same change. Check: C-UI-08.

| Actor | Renders as |
| --- | --- |
| A person | "Ben" (avatar) |
| `via` smithers, claude-code, codex | "Smithers, for Ben", "Claude Code for Ben", "Codex, for Ben" (the agent’s own avatar) |
| `via` ssh, terminal, cli | "Ben via SSH", "Ben's terminal", "Ben via CLI" |
| The coding agent | "Coding agent, for Ben" (its own avatar; TODO when ambiguous) |
| A reviewer agent | "Reviewer, for Ben" (its own avatar and review/run id) |
| System | "Smithers" |
| A non-member GitHub user | "@login" with the GitHub mark |

### 14.6b Copy rules

Visible copy uses product words (mvp.md §3). The conformance lint bans these internal terms in visible strings: workflow, thread, task, lane, box, workspace, mythical, sandbox, VM, seat, profile, Jev, forge. Match whole words in any case, including plurals with s/es. A card body block (a paragraph, list item, heading, label, button or table cell) holds at most 12 words, and visual wrapping doesn't count. A block holds one sentence at most, and a design copy review rejects explanatory sentences (AGENTS.md MINIMAL TEXT). Check: C-UI-02.

### 14.7 Keyboard and input

Every P0 journey completes with the keyboard alone (§9 of mvp.md). Normal, Vim and dictation input are kept as built.

---

## 15. Agents [S1]

### 15.1 App agent

15.1.1 The app agent answers in a branch's conversation. Each prompt runs as a turn with a `delegated(via=smithers)` credential of the prompt's author, so "Smithers for Ben" has exactly Ben's non-person rights. Turns in one conversation run in order, one at a time per conversation. A member's `/stop` stops only their own turn, and their queued prompts stay editable until they start (the single-user prompt queue AGENTS.md keeps).

15.1.2 **Context preflight.** The conversation is not the context window. Every turn begins with a preflight step that chooses what to add to the model's context. Its inputs are the prompt, the author, the branch, the titles and summaries of the conversation's recent shared entries, and the branch's state. Its candidates are files, wiki pages, TODOs and runs. Its output is a list `context[] = {kind, ref, revision?, reason}` within a token budget (default 24k tokens, an owner setting). Only the selected items, the prompt and the last 3 shared entries' text enter the answer step. The list is stored on the answer entry, the answer shows a compact "Context" line, and Inspect shows preflight as the turn's first step. Jev picks the commands the answer may call (existing `POST /api/commands/select`). Preflight selection is a model call on the cheap fast model and is recorded like any step.

15.1.2a **Audience filter.** Preflight and turn reads use only shared started turns and outputs. Exclude queued prompts, approval cards and browser Drafts, including the author’s own. Turn credentials cannot read `view:*` or `confirmations:*`. Shared context and Inspect contain no private data. Checks: C-UI-06, C-UI-07.

15.1.3 The app agent runs in the host's model host, outside every machine. It cannot run commands or write files on a machine. It may open a terminal for its author (that person's own session, §15.1.5), but it never types in one. "Run the webhook tests on retry-webhooks" becomes a request to that branch's coding agent (a steer, or a run on the branch), shown as "Smithers for Ben asked". It can call UI-only flows only on its author's own screen (§14.1.4). It cannot merge or approve. When asked to, it creates a person confirmation (§5.4) and renders the Confirm card for its author.

15.1.4 App-agent turns run entirely on the host, including command dispatch, and reuse the existing `chat_turns` claim, lease and dispatcher (E-20). Today's browser-side tool execution moves to the host turn runner, which calls each command through the same command→API mapping the CLI uses (§6.1). Its credential is a `delegated(via=smithers)` credential for the prompt's author, minted on the host when the turn starts (not when it is queued), revoked when the turn ends, and never sent to a browser. UI-only flows (§14.1.4) go to the author's own browser as instructions on the live channel. A turn therefore survives its author closing the tab and can be queued server-side. A `confirm` command from the agent posts a Confirm card (§15.1.5), and `never` commands are absent from the agent's tool list (`agent-parity.test.ts`). Turn admission locks the conversation and enforces one running turn with a database uniqueness constraint. Persist credential and lease ownership. Mint-success/launch-failure, shutdown and crash recovery revoke and release before another turn is admitted. Check: C-APP-05.

15.1.4a **Turn queue and the author's access.** Each prompt queues one existing `chat_turns` row with its `conversation_id` (§3); `app_timelines` is deleted. When a turn reaches the head of its conversation's queue, the runner checks that its author is still an active member (not removed or suspended) and only then mints the turn credential. A failed check ends the turn `refused` with the reason, and nothing runs. Removing or suspending a member (§5.6) cancels their queued turns (`cancelled`, reason `author_revoked`) and stops their running turn within 5 s: the credential is revoked, so every later command call is refused, the model stream is aborted, and the turn writes nothing more. The runner learns of it from the revocation event §5.6 publishes. The conversation's next turn then starts. Check: C-UI-06. A queued prompt shows only in its author's queue on `view:<member>:<branch>`; its shared entry is appended when the turn starts. Check: C-APP-02.

15.1.5 Agent permissions (mvp.md Appendix B legend and B.6). They apply to every delegated credential: the app agent, external agents through the CLI or skill, and agent sessions in terminals. A person’s own terminal or CLI credential follows §5.3.2a. Each catalog row carries one of three values (§6.1.2):
- **run:** executes immediately within the member's rights and the descriptor's trusted actor eligibility. Reads, UI-only flows on the prompter's own screen, steer, question or conflict answers, stop, resume, retry, rebase, fork, flow execution, wiki writes, personal terminal opening and machine sleep or wake follow their individual descriptors. Personal terminal opening admits app_agent only; source co-edit admits external_agent only. Members, secret names and install status are person-only reads under §5.2.0c. Checks: C-ACC-01, C-SEC-05.
- **confirm:** posts a one-click Confirm card (an `approvals` row, kind `one_click`) to the requesting person. Commit, amend or drop a TODO, add to stack, Bring in or Discard a foreign push, delete a wiki page, propose a flow or agent edit, and review a PR (`/review`); catalog descriptors hold the full list (§6.1.2). The primary button is the command’s verb, with Cancel beside it. A minimum role above member requires the requester to hold that role; only their session approves (§6.1.2b). Merge opens **Review & merge** (`review_merge`) for the requesting owner or maintainer. The private card becomes a receipt after approval; other viewers see nothing of the Confirm card. After execution the ordinary shared action entry may appear (§14.5.1). Checks: C-ACC-01, C-ACC-02.
- **never:** refused and absent from agent tools. Members, secrets, settings, and approvals that gate a merge. These policies apply after actor eligibility and credential scope checks, with direct append reserved for a person’s own terminal or CLI credential under §5.3.2. Delegated `todo.new` always requires the person’s private Confirm card; unavailable S1 dispatch returns 403 permission/confirm_in_app, "Confirm in the app", without effects. No other `via` or attribution header grants an exception. Checks: C-ACC-01, C-SEC-05.

15.1.5a [S1] Agents never grant or remove a TODO pre-approval. todo.preapprove and todo.unapprove are absent from agent tools. Their explicit delegated/agent/run/machine refusal is 403 permission/permission rather than the generic never envelope. A new TODO created by an agent may inherit the owner's repository default; that authority belongs to the owner, not the agent. Check: C-STK-13. todo.preapprove (Pre-approve) and todo.unapprove (Remove pre-approval) list person alone, agent: never, and no CLI or skill door. Only a session or trusted person credential may execute; setup credentials are denied. A via or person header cannot change credential eligibility. Add/remove events name the person and via. These commands are person-only in-card catalog rows (§6.1.2e); agents also cannot change the owner-only repository pre-approval default. Check: C-STK-13.

### 15.2 Coding agent

15.2.1 [S1] The coding agent runs on the branch machine as `agent`, inside the pinned `todo` flow. Its model calls go through the host model proxy with its `run` credential. Provider keys never enter the machine, so the install's model access applies (provider keys, or the owner's ChatGPT subscription sign-in when enabled). Every run records the model access it used. A member's personal subscription is used only in that member's own terminal. Check: C-SEC-02.

15.2.2 [S1] TODO model admission requires a daily token budget: the repository's declared `dailyTokens`, or 600,000,000 (ten run reserves) when it declares none, so a repository with no Smithers declarations still runs TODOs (mvp.md J1.4). Account on UTC days, atomically across workers: reserve 60,000,000 tokens for each model-active TODO run in addition to recorded usage, replacing rather than duplicating its reservation on wake/replay. Held, paused and person-waiting runs release unused reservations after in-flight calls settle. Reacquire before any resumed model call, including at UTC rollover. Before every model request reserve a conservative finite maximum input/output allowance; settle actual usage atomically and refuse dispatch when remaining daily budget or the run's reservation cannot cover it. Renew run reserve only against available daily capacity. Missing accounting, an unreadable policy or a declared budget of 0 fails closed; exhausted work parks in a durable paused state until 00:00 UTC or capacity release, retaining the same run and unconsumed inputs. The pause names the install owner: "Paused · daily token budget · <owner>". Budget waits are engine waits, not question/approval waits. Checks: C-STK-06, C-STK-03.

15.2.3 [S1] A daily-token-budget pause opens an engine pause wait with reason daily_token_budget and the install owner's id, then sets paused_at and projects paused under §4.1.0a. Settle in-flight calls before releasing the reservation and machine. The host rechecks capacity at UTC rollover or reservation release, reacquires run and call allowances, then restores the same run's next unfinished boundary. Resume cannot bypass accounting, change the pin, reset counters or discard inputs. An independent person Stop remains open when the budget wait settles. This engine wait is not a question or approval wait; a branch wait still has §4.1.0a precedence. Checks: C-STK-03, C-STK-06.

### 15.3 Your own agents

The Smithers skill is generated from `catalog.mvp.json` (§6.1.2). An agent that runs `smthrs` with a delegated credential has exactly the member's non-person rights.

---

## 16. Install, upgrade, backup [S1; upgrade before launch]

### 16.1 Package

16.1.0 The bundle includes the pinned guest base image as an OCI archive, so the first machine needs no registry pull. The Docker self-host image is deleted: no install path, Plue, CI consumer or published release uses it (#2481), and it can't host microVMs.

16.1.0a Release bottles for macOS arm64 are built by a macOS job added to the existing `.github/workflows/release.yml`, which already builds per-platform artifacts. No Smithers host can build macOS binaries, since machines are Linux. This is a release build, not a factory.

16.1.1 Distribution is a Homebrew tap (`brew install smithersai/tap/smithers`), built before launch. It installs `smthrs` and the server bundle, at the keg path that `smthrs host start` uses by default (§16.1.2):
- `smithers-backend` (darwin-arm64);
- the PostgreSQL 18 bundle;
- packaged flow hosts;
- `msb` with libkrun/libkrunfw;
- the guest root filesystem image with `smithers-machined`, a linux-arm64 `smthrs` CLI and the Smithers skill (for terminal sign-in, §5.3.2);
- git and jj;
- the web app assets.

The formula ad-hoc signs binaries with `com.apple.security.hypervisor`. No Smithers account and no network service run by us is needed.

16.1.2 [S1] `smthrs host start [--bundle <dir>]` verifies the bundle manifest, installs a per-user LaunchAgent in `~/Library/LaunchAgents` under `gui/<uid>`, and prints setup URLs after readiness. No privilege escalation. Use T-INS-01's output or the installed bundle beside `smthrs`. Same-bundle start is idempotent; changing bundles rewrites the absolute path and restarts once. `host stop` stops the service; `host status` reports process health and bundle path. S1 assumes the installing user is logged in. T-INS-03's release spike is evidence only. Check: C-INS-06.

### 16.2 Setup (J1)

The setup card runs on whichever known origin (§16.3.3) the owner opened the setup link on (§5.1.0). Steps, in order (mvp.md J1.2):
1. **Setup session:** the one-time link opens a token-backed setup session.
2. **Address:** This Mac only (loopback), or Network plus a public address (§16.3). It comes first because the GitHub App's callback URLs are registered to it.
3. **GitHub App:** setup asks which account owns the repository, then creates the App through the manifest flow (§12.1).
4. **Owner sign-in:** GitHub sign-in through the new App completes the owner claim (§5.1.0). Then the owner picks the repository and installs the App on it, and the host verifies the owner's access with the installation token. Until it does, the owner can do only setup.
5. **Model access:** the three roles (§11.5a): a coding-model provider key, a fast-model key (Cerebras by default, optional), the AI Gateway key for Decisions, and optionally a ChatGPT sign-in for coding.
6. **Squash-merge check** on the repository (§10.6.2).
7. **Mirror:** "Source ready" shows here, and questions work from this point.
8. **First machine image** ("Machine ready").

Each step is durable and resumable. The setup card shows seven steps with the ids `address`, `app_manifest`, `sign_in`, `repository`, `models`, `source` and `machine` (§14.3 Setup). Step 1 is the session itself. Step 6's squash check runs inside `repository` as soon as the repository is chosen and again on every Retry; a disabled squash merge blocks `repository` with its fix link. The same check refuses a repository whose GitHub default branch is not `main`: it blocks `repository` with code `default_branch_not_main` and the fix "Rename the default branch to main on GitHub", before anything is imported. After setup, every import and refresh repeats the check: when GitHub's default branch changes, the import fails with `default_branch_not_main` before it fetches anything, and `main` stays as it is. Supporting another default name means keying the import, readiness and the machine layer builder on the default bookmark; that is a later ticket. Check: C-J1-02. The app_manifest step uses POST /api/install/setup/app. No github_app setup route is served. Check: C-J1-02.

16.2.1 Commit durable app-step CAS before external begin. Validate durable session, callback state and origin before exchanges, and durably consume single-use state before the remote exchange. Sealed credentials, callback configuration, completion and projection then commit in one local transaction; no atomic transaction spans GitHub. Expired/claim-invalidated sessions and state/origin refusals send zero exchanges. Check: C-GH-01.

### 16.3 Reaching the install (M-28) [S1]

16.3.1 The install binds loopback by default. In Settings the owner can set a bind address and one or more public origins, for example `http://studio-mini.local:4000` or `https://smithers.example.ts.net`. Changes apply without a restart.

16.3.2 The app MUST work in a secure context (https or localhost) and an insecure one (plain HTTP on a LAN host). It therefore uses no secure-context-only browser API:
- UUIDs come from one `getRandomValues`-based helper, and `crypto.randomUUID` is banned by lint;
- the single `crypto.subtle` use is replaced;
- the clipboard falls back to `document.execCommand("copy")`;
- service workers and push are not used; browser notifications ride the live channel and need a secure origin (§14.6).

16.3.3 **Effective origin.** The host resolves every request on its HTTP listeners to one effective origin, and every origin-dependent rule reads it:
1. The request host is the `Host` header. When the socket peer is a loopback address and the request carries `X-Forwarded-Host`, the host is that header's first value instead, because a proxy on the Mac, such as `tailscale serve` or Caddy, connects over loopback. The peer is the socket's own address, never one rewritten from `X-Forwarded-For`. No other forwarding header is read, and none is read from a non-loopback peer.
2. The effective origin is the known origin whose host and port equal the request host. Known origins are the configured public origins and, for a loopback peer only, `http://localhost`, `http://127.0.0.1` and `http://[::1]` on the loopback listener's port (4000). The scheme comes from the known origin, never from a header. Settings refuses two public origins that a browser would send with the same `Host` value, such as `http://box` and `https://box`, so the match is unique.
3. A request that matches no known origin gets `421` with `{code: "unknown_origin", class: "user"}` before authentication, which also stops DNS rebinding. `/readyz` from a loopback peer is exempt, and so is the host-relay port (§8.9), whose callers carry machine or delegated credentials and no cookie.

These rules read the effective origin:
- Cookies (session, CSRF, OAuth state, setup session) are host-only (no `Domain`), `Path=/` and `SameSite=Lax`, HttpOnly except the CSRF cookie, and `Secure` exactly when the effective origin is https.
- A request whose `Origin` header differs from its effective origin gets 403. A cookie-authenticated request that changes state needs an `Origin` equal to the effective origin and an `X-CSRF-Token` equal to the CSRF cookie. The live channel upgrades a cookie-authenticated socket only with that `Origin`. Bearer-token requests (CLI, skill) carry no cookie and need neither. The app calls only its own origin, so no response carries CORS allow headers.
- Sign-in and setup's owner step set `redirect_uri` to `<effective origin>/api/auth/github/callback`. A start on `http://127.0.0.1:4000` or `http://[::1]:4000` first redirects to the same path on `http://localhost:4000`. The OAuth state cookie and `redirect_uri` share one origin, so the callback returns to the browser that started it, and a callback whose `state` doesn't match its cookie is refused. A public origin missing from the App's callback URLs gets the one-line fix below instead of a GitHub error page.

GitHub App callback URLs are the configured origins plus `http://localhost:4000` (§12.1.2). GitHub has no API to change an existing App's callback URLs. When the owner adds an origin later, Settings shows the one-line fix: the App settings URL and the exact URL to add. Check C-INS-03 covers the resolution and every rule above at a loopback origin, a plain-HTTP LAN origin and an https origin behind a loopback proxy.

16.3.4 HTTPS and remote access come from whatever the team puts in front, such as Tailscale serve or a reverse proxy. The quickstart documents Tailscale serve and Caddy. No code depends on either. A proxy on another host must pass the original `Host` header (§16.3.3); Caddy does by default, and the quickstart's examples do.

### 16.4 Upgrade (M-26)

`smthrs host upgrade`:
1. Refuse while a merge fence is set (§10.6.2b) or a burst is open, naming each, before changing anything. Check: C-REL-06.
2. Quiesce (§16.5.1).
3. Back up (§16.5.2), adding the current bundle (the Cellar version) to the backup.
4. Write `$STATE/.upgrade-incomplete`, run `brew upgrade smithers`, and restart the service on the new bundle. While the marker exists, a starting host keeps the freeze.
5. Start and migrate, forward only. The database refuses an older binary.
6. Run the health check: every process ready, migrations at head, and one machine wakes, the only grant the freeze allows. Then delete the marker and reopen (§16.5.1).
7. On failure, keep the marker, so a plain start refuses, and print the exact restore command (§16.5.3).

An install made on launch day MUST upgrade to the maintainer release with no data loss (check C-REL-03, run on the reference host with work in flight).

### 16.5 Quiesce, backup and restore

16.5.1 Quiesce. `POST /api/install/quiesce` (owner) quiesces the install, and `DELETE /api/install/quiesce` reopens it. Upgrade and backup both use it:
1. **Freeze.** Write `install_settings.quiesce = {op, by, since, lease_until}`, a 30 s lease that the caller renews every 10 s. While it holds, every mutating request is refused with `{code: "install_quiesced", class: "infra", retry_at}`, and the scheduler grants nothing (§8.3). No run, app-agent turn, terminal or SSH session, live-document or wiki edit, GitHub poll, outbound GitHub write or periodic job starts. Reads keep working.
2. **Drain**, for at most 60 s. In-flight requests finish, host flow steps and app-agent turns stop at their next durable boundary, and live wiki documents persist. Work still running at 60 s is stopped; after reopening it resumes or shows interrupted with Retry (§19.1).
3. **Machines.** Each awake machine ends its sessions, stops its coding host, runs the final capture (§8.4.3) and stops its VM with the disk kept. A failed capture aborts the quiesce and names the branch.
4. **Host.** The host flow runtime stops. Only PostgreSQL and the host service's read paths keep running.
5. **Reopen.** Clearing `quiesce` resumes admissions, and machines wake on demand. Any failed step reopens. A lapsed lease reopens on its own and is logged, unless `$STATE/.upgrade-incomplete` exists (§16.4).

16.5.2 Backup. `smthrs host backup` refuses like §16.4 step 1, quiesces, writes one backup and reopens. A backup is the directory `$STATE/backups/<version>-<UTC ts>/`, mode 0700 because it holds the install key. It is self-contained and records no absolute path, so it restores on this Mac or on another one (§16.5.3). It holds:
- a `pg_dump` in custom format, made with the bundled tools. It is the only copy of the database: the live PostgreSQL data directory is never cloned;
- an APFS clone (`cp -c`) of every other tree under `$STATE` except `backups/` and `logs/`: the install key, the repository and blob stores, machine disks (which hold member homes and the machines' run journals) and the host flow runtime journal. A volume that isn't APFS is refused;
- for an upgrade, the current bundle;
- `MANIFEST.json`, written last. It records the version, schema version, PostgreSQL major, the quiesce op and time, the path, size and SHA-256 of every file, and a summary to check a restore against: the stack (each TODO's number, state and place), each branch's captured head and disk file, each run's last finished step.

The directory is built as `backups/.partial-<ts>/` and renamed after the manifest is synced to disk; a directory without a manifest is not a backup. Before freezing, the command refuses when free disk minus the 40 GiB floor (§8.2.1) is less than the database size plus, for an upgrade, the bundle. The three newest backups are kept, and older ones are deleted after a new one completes.

16.5.3 Restore. `smthrs host restore <dir>` restores onto this Mac or another one. It refuses a running install, a manifest whose file hashes don't verify, and an installed version older than the manifest's. The original install must be stopped first, since two running installs would both act on the repository. Restore moves any live trees and PostgreSQL data directory aside to `backups/pre-restore-<ts>/`, clones the backup's trees into `$STATE`, and loads the dump into a new data directory made by the bundled `initdb` of the manifest's PostgreSQL major. It then starts the install: on the backup's bundle when it holds one (`smthrs host start --bundle <dir>/bundle`, §16.1.2), otherwise on the installed bundle, which migrates forward. Every machine starts asleep, and its wake recreates the VM from its restored disk, so nothing outside `$STATE` is needed. Runs resume or show interrupted (§19.1), GitHub writes reconcile by kind (§12.4.1b, §19.2), and capacity is recomputed for the new host (§8.2.1). The restored bind address and origins name the old host; the owner changes them in Settings (§16.3.1), and `http://localhost:4000` works meanwhile. The command prints the backup's time, since later work isn't in it. Check C-REL-06 restores host A's backup onto a second Mac and compares it with the manifest, and covers quiesce and backup under concurrent work and crashes.

---

## 17. Security model

17.1 Trust boundaries:
- the host service and packaged code are trusted;
- a machine is untrusted, since it runs repository code and agents steered by issue text;
- members are trusted with write access but not with each other's personal logins (M-18, M-29);
- GitHub content is untrusted input.

17.2 A machine holds only these credentials: its `machine` credential (branch-scoped), per-session `delegated` credentials (one member, one branch), and the `run` credential for the current run. None of them can merge, approve, change members or read secrets beyond §8.8.

17.3 The host service never executes repository code and never loads repository flows into its own process. The installed bundle is its trust anchor (ruling, revised 2026-10-04, #3450):
1. The bundle manifest, pinned once at startup through a protected chain, governs everything the host loads, runs or plants: the backend executable; every in-process library (`libsmithers_ffi.dylib`); `msb` and the guest kernel `lib/libkrunfw*.dylib`; `node`, the model host bundle and the PostgreSQL binaries; the guest helper's bytes and every planted artifact. Each is verified by SHA-256 against the pinned manifest before it is loaded or run: the library before `dlopen`, `msb` and the kernel before every `msb` run.
2. The in-guest interpreter and the system tools guest root uses (`env`, `python3` and its standard library, the account tools, `apt`) are the base image's, pinned by digest inside the verified backend, in root-owned system directories a machine user cannot write. T-SEC-01 R1–R4 protect them; they are not verified against the manifest on each call. This revises the earlier ruling that every input of a root step is a manifest member (Astra round 2, N2).
3. The backend treats every path it is handed (environment or argument) as untrusted and verifies it. An executable or library must be the bundle's own manifest member, the same file with the verified digest, or startup refuses and names the variable and the path. A host-state directory (`SMITHERS_DATA_ROOT`, which holds the microVM metadata and layer records) must be absolute and reached through a protected chain (owned by the user or root, not writable by group or others, symlinks resolved once), or startup refuses. Beside a bundle nothing falls back to the working directory. Test seams are Go options in tests, never the environment.
4. Beside a bundle the backend does not inherit its environment (ruling addition, 2026-10-05, #3450). At the start of `serve` and `microvm doctor`, before `Prepare` and before any child process or library load, it (a) refuses to start, naming the variable, when any dynamic-loader variable (`DYLD_*`, `LD_*`) or any git variable other than `GIT_EXEC_PATH` and `GIT_TEMPLATE_DIR` naming the bundle's own directories, `GIT_CONFIG_NOSYSTEM=1` and `GIT_CONFIG_GLOBAL` or `GIT_CONFIG_SYSTEM` set to `/dev/null` is present; (b) builds one environment from the launcher's allowlist, each path verified and replaced by its canonical target, with `PATH` fixed to `<bundle>/bin:/usr/bin:/bin:/usr/sbin:/sbin` and `HOME` from the user database, replaces its whole environment with it, and gives every child an environment built from it, never the inherited one; (c) runs every child by an absolute path that is a verified bundle member or a fixed system path, never by name through `PATH`. The assembler signs the backend ad hoc with the hardened runtime and only the `disable-library-validation` entitlement, so the dynamic loader ignores `DYLD_*`; the manifest records the signature, and startup refuses a process or manifest without the runtime flag.

17.4 Provider keys and the GitHub App PEM stay on the host. The install key lives in `$STATE/config/secrets.json` (mode 0600). Every backup copies it, so a backup directory is mode 0700, and anyone holding a backup can decrypt its sealed rows (§16.5.2, check C-REL-06). Sealed blobs (App PEM, client secret, provider keys) live in PostgreSQL, encrypted under that key. Tool logins stay in machine homes (§8.7.3); the install key seals no per-member tool credential store. Check: C-MCH-10. The ticket touching model access collapses the three model-key stores into the existing sealed owner secrets in the same change. Check: C-SEC-03.

17.5 Contributor trust rules are enforced from launch (mvp.md §14). Outsider text (an issue, PR, comment, mention or label from a non-member, §10.2.1) never starts credentialed work on its own: no run, proposal, triage or machine request follows from it. An issue with outsider text becomes a TODO only by a maintainer's Make TODO or `todo` label, and only as admitted then (§10.2.1a). After that, its author's comments, like every later issue comment, never reach the run, and a non-member's PR comments show in activity and never steer (§12.3). Labels from non-members are reverted with a comment. Check C-SEC-03. Maintainer admission preserves outsider provenance for the TODO/workspace. Before accepting any generation, compare its own changed paths with protected paths loaded from current trusted main, never its candidate; a match refuses proposal with policy/protected_paths and stops for a person. Unreadable policy cannot accept or publish. Retain outsider lane network restrictions; run/machine credentials do not widen egress. Check: C-STK-06. Review activity, delivery receipt, TODO transition/events and durable steer intent commit in one transaction through transaction-aware admission. Dispatch follows commit. Resolve current active membership at admission and held delivery; historical membership or login attribution grants no steer authority. Removed, suspended and outsider authors remain record-only. Check: C-J10-02.

17.6 A plain-HTTP public origin sends session cookies unencrypted on the network. This is a documented limitation of the team's chosen exposure, not of the install. The quickstart recommends HTTPS in front, and Settings marks an http origin with one word: "unencrypted".

17.6a A request's scheme comes only from the configured origin it matches, and only a loopback peer can set its host through `X-Forwarded-Host` (§16.3.3). A proxy on another host gets no trust: the install reads only the `Host` it passes on (check C-INS-03).

---

## 18. Performance budgets (reference host: the team's 64 GB Apple Silicon Mac mini (10 performance cores), mvp.md §9; every artifact records the host profile, §8.2.1)

18.0 A 32 GB host’s p95 is not measured until a 32 GB host is tested. Capacity still follows §8.2.1. Checks: C-PERF-01–06.

| Budget | Target (p95) | Measured by |
| --- | --- | --- |
| App agent first token (the `fast` model, clock from submit, preflight included and reported separately) | < 1.5 s | C-PERF-01 |
| Answer with cards (no machine) | < 8 s | C-PERF-01 |
| Projection delta to subscribers | < 1 s | C-PERF-02 |
| Keystroke to remote viewer (File card) | < 1 s | C-PERF-03 |
| Outside disk write to open File card | < 1 s | C-PERF-04 |
| Warm wake (asleep → awake) | < 5 s | C-PERF-05 |
| GitHub PR/checks/main freshness | < 60 s | C-GH-07 |
| Rebase with people present (hold on writes) | < 2 s | C-PERF-06 |

18.1 Each budget has a benchmark script that runs on the reference host and stores its artifact under `.artifacts/perf/<date>/`. Budgets are measured on the reference host; limits derive from the detected host on every install (§8.2.1). Checks: C-PERF-01..06, C-GH-07, C-MCH-02.

---

## 19. Durability and failure semantics

19.1 Killing the host service, PostgreSQL or a machine at any point re-runs no completed flow step. Every run then either resumes or shows as `interrupted` with Retry (C-DUR-01..04).

19.1a Turn admission locks the conversation and enforces one running turn with a database uniqueness constraint. Persist credential and lease ownership. Mint-success/launch-failure, shutdown and crash recovery revoke and release before another turn is admitted. Check: C-APP-05.

19.2 Interrupted external actions reconcile before retrying, with no new engine API (library review, 2026-10-02). Every action with an outside effect declares its `tier` and an `idempotencyKey` explicitly. When an `intended` irreversible crossing has a key, the engine re-executes the body (`ActionPersistence.ts`, the `IrreversibleRetryRequiresIdempotencyKey` gate refuses only a keyless crossing), and the body checks remote state first and returns what it finds: a GitHub write reconciles by kind (§12.4.1b), and a push runs `git ls-remote` and compares the remote ref with the intended and expected heads. A model call is retried, since it has no outside effect. A check command on an immutable source export declares `tier: "sealed"`. A keyless irreversible crossing fails as `interrupted`, with Retry. Check: C-GH-09.

19.3 No state is shown before its event exists. A command's toast stays running until the projection reports terminal.

19.4 Typed failures carry a fault class end to end (§6.2.3). Infra and capacity failures say they aren't the user's fault. Class never returns HTTP 403 and says Only a person can do this for a role/scope-eligible delegated request to a person-only command. An excluded actor class on a multi-actor command or an absent run/machine/setup grant returns permission (§5.2.1). Check: C-ACC-01. Check: C-ACC-01. Cache rows, cursor/ETag and pending consumer deliveries commit atomically. Delivery identity binds stream/object version or issue event id and consumer. Consumer receipts and effects commit atomically; acknowledgement follows commit, and failures/restarts retry the same identity. Every install GitHub transport, including repository listing and token minting, uses shared budget admission and accounting. Worker replacement is install-only; Plue keeps its workers. Check: C-GH-08. Reset, ordinary pulls and merge dispatch share repository serialization and the repo-host write lock. Recheck attention and merge fences under that boundary before expected-old ref writes. Persist reset intent before writing; attention settlement, projections and keyed main-moved intents commit atomically afterward. Consumers recover idempotently, including machine-only flow loading. At a third mirror tip, recovery preserves the ref and leaves attention open. Check: C-J10-07.

---

## 20. Observability

20.1 Structured logs with request id, actor, todo, branch and run on every line. Logs go to `$STATE/logs/`, rotated at 100 MiB × 10.

20.2 `smthrs host status` and the Settings card show process health, PostgreSQL size, disk free, machines and capacity, GitHub sync health and rate budget.

20.3 Metrics are kept in-process and exposed at `/api/install/metrics` (owner only). They cover the latencies in §18, queue depth, wake count and time, burst rate and live-channel connections.

20.4 Alpha scorecard (mvp.md §10). Automated measures come from product tables, never logs, at `GET /api/install/scorecard` (owner). Person-minutes are reviewed separately from sampled, annotated alpha sessions. The API reports `person_minutes: {source: "sampled_alpha_sessions", verdict: "manual"}` and ingests no effort intervals. Check: C-REL-04. Definitions:

20.4a After stage 1, all of Smithers' own work runs as TODOs on the install by default (M-37). Each exception names an owner, the reason it cannot run through Smithers yet, and an expiry. Report every outside merge and its person effort daily against the product §10 kill signal. Check: C-REL-04.
- **accepted**: a TODO committed to the stack;
- **merged, dropped, failed**: TODO states (§4.1);
- **terminal edits**: bursts whose actor has `via` terminal or ssh;
- **second-member action**: an activity entry on a branch by a person other than the TODO's owner;
- **session**: one person's continuous presence on a branch for at least 2 min;
- **flow revisions**: activations (§11.3);
- **outside work**: commits that reached `main` without a TODO PR;
- **person-minutes**: the alpha owner samples and annotates alpha sessions, recording TODO, person, answer/review/edit intervals and sampling method. Union overlapping intervals for the same person and TODO, then sum across people; autonomous agent time contributes zero. Report weekly accepted counts and sampled weekly median effort, with sample size and unsampled TODOs explicit. Core value targets at least 10 accepted TODOs per week and a sampled median below 15 person-minutes; fewer than 3 accepted in week 2 or a rising weekly median is a kill signal. Missing annotations leave effort unmeasured. No effort table, effort lifecycle writer or automated run-data ingestion ships. Check: C-REL-04.
- **no hand-written code**: a merged TODO with no person-authored code edit, including an edit made through a delegated tool. Report the share as a diagnostic only; it never controls the core-value verdict. Check: C-REL-04;
- **measurably helps**: after a learning proposal merges, its failure signature's rate over the next 5 TODOs is lower than over the previous 5.

Install, first-answer and first-merge times come from `product_job_events` and conversation entries.

20.4b [S1; S2/S3 sources at their owning stages] Lifecycle receipts are emitted by each step’s existing writer in its step transaction: T-INS-06 writes setup/install start in install_settings; T-APP-16 writes app-turn answers through T-APP-16’s chat_turns append writer; T-STK-01 writes TODO lifecycle product_job_events, and T-STK-04 uses that writer for merge settlement; T-COL-04 writes product_job_events and burst_files; T-COL-06 writes audit_log; T-FLW-03 writes workflow_definitions; T-GH-02 writes synced main commits; T-FLW-06 writes proposals. T-REL-03 only reads these sources and their coverage. It creates no lifecycle writer, receipt ingestion route or effort table. Person-minutes remain sampled alpha-session annotations. Check: C-REL-04.

---

## 21. Test strategy

| Layer | Scope | Where |
| --- | --- | --- |
| Unit | Pure rules: the TODO state projection and engine guards, capacity formula, placement, merge guard, permission matrix and `agent: run/confirm/never`, burst grouping and session attribution, catalog and Appendix B/C parity | Next to the code, `go test` / `bun test` / `cargo test` |
| Integration | Real PostgreSQL, real jj, real inotify and cgroups (in a microVM or a Linux CI runner), a fake GitHub server that speaks REST, GraphQL drafts and ETags | `packages/backend/internal/...`, `crates/smithers-machined/tests` |
| End to end | Real app in a browser against a real install with microVMs and a scratch GitHub repository | `apps/app/e2e/real/` |
| Fault | Kill points across runs, merges, GitHub writes, bursts, rebases | `packages/smithers/test/faults/`, `packages/backend/...` |
| Performance | §18 budgets on the reference host | `scripts/perf/` |
| Journey | J1–J8, J10 and J11 on a fresh macOS user account on the reference mini, in both themes, recorded (mvp.md §12.1). The recording includes a restart mid-run, a duplicate launch, an outside save landing on a file two people are typing in, and a wiki decision edit that the next plan follows | `checks/` C-J* |

21.1 **Library review bar** (smithers-38, packages/ owner, 2026-10-02). Any ticket that changes a public export of a `packages/` TypeScript library meets all of these, and the library owner signs off the public-API diff before it lands:
- Need: the change names its real caller and shows, with a code sketch, why the existing API or a userland composition can't do it. A new abstraction needs two callers.
- Surface: no option overlaps an existing one. Each export has JSDoc with `@since` and a page in the package's `docs/`. Errors are typed tagged errors, public types have no `any`, and new code carries no `@slop` tag.
- Durable formats (journal, engine store, keys, canonical encoding, plan step keys): old records keep decoding. A format change ships a fixture written by the previous version and a decode test.
- Tests: the package stays at 100% lines, branches, functions and statements. A new `v8-ignore` carries a one-line reason. Unit tests cover the behavior, its errors, interruption and replay. Integration tests use real SQLite, PostgreSQL and jj, never mocks of our own modules.
- Hot paths (action dispatch in `ActionPersistence`, journal append and replay, canonical encode and hash, step-cache lookup, sync projection): the change adds or extends a counter fixture in `//scripts:benchmarkGate` (`scripts/bench/gate.mjs`, `baseline.json`), which counts SQLite queries and prepares, scheduler dispatches and pages with at most 5% growth, plus output digests. The baseline changes only with the reviewer's sign-off. Counters, not wall time: wall time is noise on a loaded host. The library owner adds fixtures for the paths the gate doesn't cover yet (ledger #3480 item 4).
- A migration deletes the old path in the same change.
- Export removal (smithers-38, 2026-10-02): removing or renaming a public export needs a CHANGELOG "Removed" entry naming the replacement, a sketch of how a consumer migrates, and a citation of `RELEASE_SUPPORT.md`. That is enough during the release candidate; after 1.0 it also needs a major version. "No callers in this repository" is not evidence of no outside users.

21.2 **Declared-input existence in //:targetIndex and the drift set at landing.** [S1] Declared inputs must exist when `//:targetIndex` resolves `Smithers.file()`, `paths:` and `workflows:` declarations, including supported globs and brace expansion. Actionlint discovers workflows from `.github/workflows`. Landing runs `smthrs lint '//:driftCi' '//:targetIndex' '//:ci' '//scripts:trackedHygiene' '//scripts:conflictMarkers'` locally and refuses push on failure. The per-SHA, non-cancelling drift status is required on main and includes `//:ci`; the long CI remains advisory until its existing repair is green. T-PRC-01 owners smithers-38 + smithers-22 implement this rule. Check: C-PRC-01.

21.3 **DB-free migration gate and planned table ownership at Ready.** [S1] At Ready, the lead records every new table in `ownership.csv` as `planned:<ticket>` with one owner. Reserve tables before implementation; assign migration numbers at landing. The default Go target runs DB-free checks for unique, gapless numbers, registry/embed parity, duplicate CREATE statements (IF NOT EXISTS included), ownership of created tables and removal of dropped tables. A lane cannot create a table planned for another ticket. `scripts/renumber-migration.mjs <file>` renames an unlanded migration, updates the registry and regenerates sqlc output at landing. Refuse to renumber any file already on `origin/main`; establish unlanded status before any write and refuse if it cannot be established. `scripts/commit.mjs --push` runs `go test -run 'TestMigrationGate|TestMigrationRegistry' ./packages/backend/db/product/` after renumbering/regeneration and before either supported VCS push path; a nonzero exit prevents publication and preserves the gate output. Exclude `PARTITION OF` children from independent ownership checks, matching the installed-schema `NOT c.relispartition` filter; retain ownership checks for the parent. T-PRC-02 owners smithers-3f + smithers-8a implement this rule. Check: C-PRC-02.

21.4 **Check receipts required to close a ticket.** [S1] A ticket closes only with a machine-written receipt for every named check, bound to the landed commit. `scripts/check-run.mjs C-XXX-NN` runs its `Automation:` command, refuses an absent path or `to write` declaration, and writes `.artifacts/checks/<id>/<ts>/receipt.json` with `{version: 1, check, commit, layer, command, exit, started, ended, log_digest}`. `issue-claim.mjs comment --release --close --receipt <path>...` requires passing receipts for every named check at the landed commit and verifies log digests. Missing, failed or mismatched evidence exits 2 before any issue write, including comment or claim release. Validate every comment --close request with or without --release; --force does not bypass evidence. Automation runs on the check’s declared Runs in host without publication credentials; smithers-3f reviews this boundary. Check: C-PRC-03. Reports list receipts; prose PASS claims do not close tickets. T-PRC-03 owners smithers-22 implement this rule. Check: C-PRC-03.

21.4a [S1] Engineering check automation runs its approved command on the check’s declared Runs in host with GH_TOKEN, GITHUB_TOKEN and SMITHERS_GITHUB_PROXY absent and ~/.config/issue-claim unreadable. Publication credentials stay behind issue-claim.mjs write(). Receipts use {version: 1, check, commit, layer, command, exit, started, ended, log_digest}: full commit SHA, integer exit, ISO UTC timestamps and sha256:<hex>. Every comment --close variant requires --landed <sha>, verifies ancestry of origin/main, derives checks from the ticket and requires receipt.commit == sha. Refuse symlinks, .. and receipt/log realpaths outside .artifacts/checks/. Invalid evidence exits 2 before every write with action evidence-refused and per-check {check, receipt?, reason: missing|coverage|failed|commit|digest}; held claims retain action refused. Check: C-PRC-03. M-29 governs branch machines, not this runner.

Every check in [checks/](checks/) names its layer and its automation path. Executed coverage, configured thresholds, skipped cases and platform-specific evidence are reported separately (AGENTS.md testing quality).
