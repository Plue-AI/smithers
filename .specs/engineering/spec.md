# Smithers MVP engineering specification

Status: draft v0.4 by the engineering agent (smithers-8a), 2026-10-02. Implements [mvp.md v2.6](../product/mvp.md) (M-01..M-30, build stages §11, deferrals §16). It specifies the target system as if built from scratch. [delta.md](delta.md) maps today's `main` onto it, and [overview.md](overview.md) is the one-page version.

## 0. Stages and deferrals

mvp.md §11 builds the MVP in three stages, and every one ships at launch. Will confirmed live code co-editing (M-02) for the MVP on 2026-10-02. It is built in stage 3, but its contracts are fixed in stage 1 (§7.6) so stages 1 and 2 feed it instead of being retrofitted. Once stage 1 passes J1 and J2, Smithers' own development moves onto the stack on Will's Mac mini (M-31). Will's rulings of 2026-10-02 also apply throughout:
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
│              │    API · live hub · identity · GitHub sync · stack engine          │
│              │    admission scheduler · SSH gateway · flow dispatch · wiki docs   │
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

1.3 Execution boundary (M-29, M-30). Repository code MUST execute only inside a branch machine. Repository code means overridable flows, the coding agent, checks, terminals, SSH sessions and services. The host executes only code shipped in the install package. The install MUST refuse to start without working microVM isolation and MUST NOT fall back to host processes.

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
| Credential | token id | Kind ∈ {session, delegated, run, machine}. Only `session` acts as a person for approvals (§5.4). |
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

Actor notation used everywhere (events, activity, presence, audit): `{person: member id, via?: "smithers"|"claude-code"|"codex"|"ssh"|<agent>, session?: id}` for people and agents acting for them, and `{agent: "coding", run: run id, todo?: Tn}` for the coding agent, `{system: "smithers"}` for the stack service and other system operations, and `{outside: true}` for writes no session can claim (§9.3.1). Rendering (M-34): "Ben", "Claude Code for Ben" and "Coding agent for Ben" (each agent its own avatar in Ben's color_index), "Maya via SSH" (a person's own session), "Smithers" or "Smithers, for Ben", "Changed outside Smithers" (§14.6a).

---

## 3. Data model (PostgreSQL)

One schema, one forward-only migration ledger (existing). New or reshaped tables, with key columns only:

```
members(id, github_user_id UNIQUE, login, role, unix_uid UNIQUE, added_by, added_at,
        suspended_at, suspended_reason, removed_at, last_access_check_at)
credentials(id, member_id, kind, via, scopes[], token_digest, created_at, expires_at, revoked_at)
person_confirmations(id, member_id, kind[one_click|review_merge], action, subject, revision, requested_by_credential,
                     state[pending|approved|denied|expired], created_at, expires_at, decided_at)
install_settings(key PK, value jsonb, sealed bool, updated_by, updated_at)   -- bind, origins, setup token digest, budgets
github_app(id, slug, owner_login, owner_kind[user|org], client_id, pem_sealed, webhook_secret_sealed,
           client_secret_sealed, installation_id, created_at)

todos(id, repository_id, number, title, state, state_reason, owner_id, issue_number NULL,
      fixes_issue bool, stack_position, branch_id, pr_number NULL, created_by_actor jsonb,
      flow_name, flow_digest NULL, needs_you jsonb NULL, merging jsonb NULL, failure jsonb NULL, queue jsonb NULL,
      current_step NULL, lessons int, merged_at, dropped_at, version)
      -- UNIQUE (repository_id, number); numbers are allocated per repository under a per-repository advisory lock, so `T<n>` and the `todo:<n>` topic stay per repository (an install serves one; a composed multi-repository backend never shares a sequence across tenants)
todo_revisions(todo_id, rev, prompt, acceptance, seed_patch_blob NULL, author_actor jsonb,
               reason[create|amend|from-issue], issue_digest NULL, created_at)
todo_events(id, todo_id, seq, at, actor jsonb, kind, from_state, to_state, payload jsonb)
todo_waits(wait_id, todo_id, kind, owner[run|branch], payload jsonb, run_wait_id NULL, opened_at, settled_at NULL, settled_by jsonb NULL, outcome NULL)   -- §10.8.0; todos.needs_you holds the primary open wait (§4.1.0a); todos.merging is the merge fence (§10.6.2b); checks C-STK-07, C-STK-08
todo_attempts(todo_id, attempt, run_id, started_at, ended_at, outcome, evidence jsonb)
todo_approvals(todo_id, member_id, generation, pr_head_sha, credential_id, at)   -- approval binding (§10.6.2c); check C-ACC-02

branches(id, name UNIQUE, kind[item|scratch], todo_id NULL, forked_from jsonb,
         github_branch NULL, rebase_pending jsonb NULL, moved_off jsonb NULL, created_at, archived_at)
machines(branch_id PK, workspace_id, state, vm_id NULL, disk_id, image_recipe_digest, last_activity_at,
         sleeping_since, wake_reason, head_change_id, head_commit_id, snapshot_tree_id)
machine_requests(id, holder, branch_id NULL, class[person|todo|background], requested_by jsonb, reason,
                 state[waiting|granted|released|cancelled], created_at, granted_at, released_at)   -- holder: branch:<id> | prepare:<recipe digest> | run:<run id> (§8.3.1); a holder holds a slot from grant to confirmed stop (§8.3.2); check C-MCH-02

activity(id, branch_id, seq, at, actor jsonb, asked_by jsonb NULL,
         kind[step|steer|question|answer|edit|change|github|rebase|read|context],
         summary jsonb, burst_id NULL, versions_commit NULL, files int, github bool)
         -- asked_by: the requester of a stack operation ("Maya asked · Rebased onto T8"); read/context per mvp.md B.3
burst_files(burst_id, path, change[added|modified|deleted|renamed], renamed_to NULL,
            before_blob NULL, after_blob NULL, after_digest NULL)   -- per-file versions (§9.3.4); check C-COL-05
machine_event_receipts(branch_id, event_id, seq, committed_at, PRIMARY KEY(branch_id, event_id))   -- outbox dedupe (§9.1.4); check C-DUR-04
terminals(id, branch_id, owner_id NULL, run_id NULL, title, opened_at, closed_at)

flow_versions(id, flow_name, digest, source_commit, closure_blob, status[loaded|failed],
              load_error NULL, loaded_at)
flow_activations(flow_name, active_version_id, activated_at, previous_version_id)
proposals(id, learning_run_id, todo_from NULL, title, signature, evidence jsonb, refs jsonb,
          suggested_prompt, seed_patch_blob NULL, state[open|accepted|dismissed], todo_id NULL)
flow_config(scope[install|flow:<name>|agent:<role>], key, value jsonb, source[detected|owner|repo],
            updated_at)   -- install-stored defaults (§11.2) and agent models (§11.5a)
stack_attention(id, kind[order|force_push], payload jsonb, state[open|settled], created_at,
                settled_by jsonb NULL)
outbound_writes(key PK, seq bigserial, kind, target jsonb, field NULL, desired jsonb,
                precondition jsonb NULL, state[intended|unknown|done|superseded|conflict], settled_by NULL,
                github_ref NULL, created_at, done_at NULL)   -- §12.4.1; check C-GH-09

github_sync(stream PK, last_attempt_at, last_success_at, etag, cursor, target_interval_s,
            last_error jsonb NULL)
secrets(name PK, scope, ciphertext, created_by, updated_at)
member_credentials(member_id, file[claude_credentials|claude_account|codex_auth|gh_hosts|gitconfig],
                   ciphertext, written_at, from_branch_id NULL, PRIMARY KEY(member_id, file))   -- §8.7.3

presence_sessions(id, branch_id, member_id, via, started_at, ended_at)   -- coarse: one row per continuous presence ≥ 2 min, for the scorecard (§20.4)
conversations(id, branch_id UNIQUE, created_at)
conversation_entries(conversation_id, entry_id, seq, kind[prompt|answer|card|event], author_actor jsonb,
                     audience_member_id NULL, title, summary, summary_rev, tone, state NULL, action jsonb NULL,
                     context jsonb NULL, card jsonb NULL, run_id NULL, todo_id NULL, updated_at)
                     -- audience_member_id: set only on a private entry (§14.5.1)
                     -- card: {kind, payload} for a card with no topic of its own (a Draft's fields, §14.3)
agent_turns(id, conversation_id, author_member_id, author_actor jsonb, prompt text, prompt_entry_id NULL,
            state[queued|running|done|failed|cancelled|refused|interrupted], reason NULL, credential_id NULL,
            queued_at, started_at NULL, ended_at NULL)
            -- the prompt entry is appended when the turn starts, so a queued prompt stays editable (§15.1.1)
            -- without editing a shared entry (§14.5.1); check C-APP-02
member_conversation_state(member_id, conversation_id, scroll_anchor_entry NULL, card_view jsonb,
                          last_seen_seq, toasts_hidden bool, updated_at)
run_summaries(run_id, attempt, target[phase:<n>|cell:<n>], text, rev, updated_at,
              PRIMARY KEY(run_id, attempt, target))   -- monitor summaries by agent:fast (§11.6.3, §14.5.3)
background_dismissals(run_id PK, dismissed_by jsonb, dismissed_at)   -- Home card Dismiss; the run record stays (§14.3)
projection_events(topic, seq, at, payload jsonb)   -- per-topic monotonic stream (§7.2)
```

3.0 The existing GitHub synced store (`github_synced_*` tables, `B/services/github_synced_repos.go`) is the cache of issues, PRs and comments. No second cache table is added. `github_sync` adds per-stream cursors, ETags and health on top of it.

3.1 Every mutation that changes a card writes its row change and one `projection_events` row in the same transaction, then runs `NOTIFY live, '<topic>'`. T-STK-01 owns the `projection_events` migration and writer; T-COL-02 builds the live transport on it.

3.2 `todos.state` is stored, not computed at read time. Every change appends a `todo_events` row with the actor and cause. Reads never infer a state that has no event (honest state, mvp.md §2 rule 5).

3.3 Retention: `projection_events` keeps 24 h or 10,000 rows per topic, whichever is larger. Older cursors get a snapshot (§7.2).

---

## 4. State machines

### 4.1 TODO

4.1.0b **Transition data.** `.specs/engineering/state/todo-transitions.tsv` is the machine-readable authority: `from | trigger | guard-predicate | to | outcome: transition|noop|attention | flags`. T-STK-13 owner smithers-3f embeds it in Go; `Transition` is lookup plus named predicates. `todoItemPath` and the test oracle derive from these rows. `scripts/render-spec-tables.mjs` renders §4.1 under `pnpm docs:sync`; C-STK-01 proves every row and rendered-table parity. The independent QA model remains a second oracle. Code never parses spec prose to decide transitions.

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
| any unmerged → needs_you | A wait opens (§10.8.0): the run raises `question` or `approval` while working; the engine or the sync raises `conflict`, `moved_off` or `foreign_push` in any unmerged state | One `todo_waits` row per wait. The state is needs_you because it ranks above paused, failed and the item phase (§4.1.0a) |
| needs_you → working | First accepted answer (§10.8) | Answer is from a member, or the coding agent resolves a conflict |
| working → paused | Stop | The attempt's run is executing and no `question` or `approval` wait is open. An open branch wait (`conflict`, `moved_off`, `foreign_push`) doesn't refuse Stop; the state stays needs_you until that wait settles (§4.1.0a). A durable pause signal; the run parks in a `paused` wait at its next boundary (it is not cancelled), and `paused_at` is set when that wait opens; the machine is released once safe-idle |
| paused → queued | Resume | `paused_at` is set. Settles the pause wait and clears `paused_at`; the same run continues from its last finished step once a machine is granted, through starting (`run_attached`) |
| working → failed | Run terminal `failed` or `uncertain` | `failure = {step, class, message, retryable}` |
| failed → queued | **Retry** (optionally with a steer) | A new attempt: a new run of the same pinned flow version from its first step; the earlier attempt and its evidence are kept. Re-running finished steps is intended here, unlike Resume (§19.1) |
| failed → queued | **Retry with the current flow** (`todo.retry-current-flow`, in-card) | As Retry, but the new attempt pins the currently Active flow version; same TODO identity and evidence |
| working → in_review | `stack.propose` accepts the candidate (§10.4.4), and the PR is opened or updated | The PR head's tree is the accepted generation's tree |
| in_review → working | Changes requested, a review comment from a member, or a steer | Approvals for the old head are void |
| in_review → queued | As `in_review → working`, when the branch's machine was released and admission must grant it again [S2] | The same run continues through starting (`run_attached`) |
| in_review → in_review | Rebased, or a capture shows edits the accepted generation lacks (§10.4.5) | The run re-enters `candidate`. Merge is held (`rechecking` or `pending_work`, §10.6.2a) until `stack.propose` accepts a new generation |
| in_review → needs_you | An outside push to the TODO branch, or a rebase conflict the agent can't resolve | PR stays open |
| needs_you → queued | Answered after the machine was released (safe-idle), and the answer needs new work | The run resumes when admission grants the machine again. An answer that needs no new work goes to in_review instead, whether or not the machine was released (QA p1, 2026-10-02) |
| needs_you → working | Bring in (after an outside push) | The run rebases onto the pushed commit at its next checkpoint |
| needs_you → in_review | Discard (after an outside push), or another answer that needs no new work | The PR head is the verified candidate |
| any unmerged with an open PR (queued, starting, working, needs_you, paused, failed, in_review) → merged | GitHub reports the PR merged and `main` contains the commit | None: a merge on GitHub counts from any unmerged state (M-22). The same transaction cancels the attempt's run, settles every open wait and clears `needs_you`, `paused_at` and `merging` (§10.6.2b). A steer never converts the PR to draft, so a maintainer can still merge it |
| any unmerged → dropped | Drop, or the PR is closed on GitHub without merge | The PR is closed and later items are rebased. The same transaction cancels the run, settles every open wait and clears `needs_you` and `paused_at` |
| dropped → in_review | The PR is reopened on GitHub within 7 days | Once per reopen event. No run starts: the TODO keeps its last accepted generation, and the first input that needs work starts a new attempt (§10.7.4). `smithers/<slug>` is recreated at that generation's `pr_head`; machine cleanup doesn't matter (§12.3) |
| needs_you → paused | The last open wait settles while `paused_at` is set | §4.1.0a |
| needs_you → failed | The last open wait settles while the item is `blocked` | §4.1.0a. Retry is accepted throughout |

4.1.0 The stack engine's work record (`mythical_items.state`, 15 values) projects onto the TODO state. `todos.state` is written by the engine in the same transaction as the item change:

The table above is authoritative; the diagram omits some edges.

| Item state | TODO state |
| --- | --- |
| `queued`, `skipped` (not yet admitted) | queued |
| launched or re-admitted, run not yet attached (`run_attached`) | starting |
| `running`, `delivering`, `integrating`, `verifying`, `proposing`, `waiting`, `retrying` | working (`current_step` names the phase) |
| `proposed` | in_review (stays in_review while the PR rebuilds after an earlier merge) |
| `landed` | merged |
| `blocked` | failed |
| `cancelled`, `rejected`, `declined` | dropped (`state_reason` keeps the cause) |
| any non-terminal, with an open wait (§10.8.0) | needs_you (§4.1.0a) |
| any non-terminal, with `paused_at` set and no open wait | paused (§4.1.0a) |

Terminal item states win: `landed` always projects merged, and `cancelled`, `rejected` and `declined` always project dropped, whatever `needs_you` or `paused_at` hold. Check: C-STK-01.

4.1.0a **Precedence.** The engine derives the stored state from facts in this order, and the first row that holds wins:

| Rank | State | Holds when |
| --- | --- | --- |
| 1 | merged | item `landed` |
| 2 | dropped | item `cancelled`, `rejected` or `declined` |
| 3 | needs_you | at least one open wait (§10.8.0) |
| 4 | paused | `paused_at` is set |
| 5 | failed | item `blocked` |
| 6 | in_review, working, starting, queued | the item phase (§4.1.0) |

Open waits are independent: settling one never settles another. A `needs_you → X` row of §4.1 applies only when the settled wait was the last open one, and X is then the first lower rank that holds. With several open waits, the **primary wait** (`todos.needs_you`, whose kind sets the action, §14.5.2) is the first open one in the order `moved_off`, `conflict`, `foreign_push`, `approval`, `question`, then the oldest. Branch waits come first because they block the branch itself, and answering a question doesn't clear them. The TODO card lists every open wait with its own action. Command guards read facts, not the derived state: Stop needs an executing run with no open `question` or `approval`, Resume needs `paused_at`, Retry needs item `blocked`, and an answer needs its own wait open. Checks: C-STK-01 (the table), C-STK-08 (combinations).

4.1.1 `queued.queue = {reason: machine | merge_order | rebase, after?: n, position}` on the wire; `after` is the TODO number for `merge_order`. The card renders the reason as copy: "waiting for a machine #<position>", "merges after T<after>", "rebase pending". The position comes from §8.3.

4.1.2 `working.current_step` is the step id of the run's innermost active flow step. It is projected from runtime events within 1 s.

4.1.2a Stack-level attention (`order`, `force_push`) is not a TODO state. It lives in `stack_attention`, shows on the Home card for its audience (maintainers for `order`, the owner for `force_push`), and holds the stack's merges until settled.

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

5.1.0 First owner. `smthrs host start` prints a one-time setup URL for `http://localhost:4000` and for each configured public origin (§16.3.3), for example `http://localhost:4000/setup?token=…`. Only the token's digest is stored, in `install_settings`.
- **Setup sessions.** Opening the URL exchanges the token for a setup session: a random id in an HttpOnly cookie (§16.3.3), stored as a digest under the `install_settings` key `setup.session.<digest>`, which expires after 24 h without a request. The page then removes the token from its address. Any number of setup sessions may exist before the claim, so the owner may run setup from the Mac and from a laptop on the LAN (J1.1). A setup session has no member and no `session` credential. It reaches only `GET /api/install`, the setup steps before the claim (Address, GitHub App, Owner sign-in; §16.2) and the OAuth start and callback. All setup sessions share the durable step state, and starting a step is a compare-and-set from `pending`, `failed` or `blocked` to `running`, so two sessions never run one step twice.
- **Claim.** Owner sign-in sends the session's holder through GitHub user authorization with the new App. The callback arrives on the same origin with the same setup-session cookie (§16.3.3) and runs one transaction: delete the token's digest, aborting if it is already gone; insert the owner `members` row (one owner, §2); delete every setup session; mint a `session` credential. That completes the claim (mvp.md J1.2). Any other setup session, a second callback and a replayed token get `401 setup_closed`. Nobody without the installer's terminal output can claim the install.
- **Provisional owner.** The repository isn't bound at the claim, so the §5.1.2 permission check can't run yet. Until it passes, the owner is provisional: `Authorize` (§5.2.1) allows the setup steps and refuses every other action with `{code: "owner_unverified", class: "permission"}`. After the owner installs the App, the host reads the installation with the App's JWT (`GET /repos/{owner}/{repo}/installation`) and never trusts an `installation_id` callback parameter. It records the repository and `github_app.installation_id`, then runs the §5.1.2 check for the owner with the installation token. A pass sets the owner's `last_access_check_at` and ends the provisional phase. A fail blocks the step with "needs access on GitHub ↗"; the owner fixes access on GitHub and retries, or picks another repository.
- **Restart.** Before the claim, each backend restart re-mints the setup token and replaces its digest, so the old URL dies. Setup sessions and step states remain durable. At token mint the backend emits one structured stdout line `{"setup_urls": [...]}` containing the loopback setup URL and one setup URL for each origin in `install_settings`. The launcher relays this line verbatim. After the claim the backend emits no setup URL line. T-ACC-07 owns emission; T-INS-02 owns relay. Checks: C-SEC-04, C-SEC-02.

Check C-SEC-04 covers every rule in 5.1.0.

5.1.1 People sign in with GitHub through the install's GitHub App user authorization (OAuth web flow). The callback URLs registered on the App are the configured origins plus `http://localhost:4000` (§16.3.3).

5.1.2 On each sign-in after the claim, the host service checks two things; a provisional owner's sign-in (§5.1.0) skips them and stays provisional. The person must be the owner or have a `members` row that isn't removed. The person must also have `push` or higher permission on the repository, read with `GET /repos/{o}/{r}/collaborators/{login}/permission` using the installation token. If either fails, sign-in is refused with the reason, for example "needs access on GitHub ↗".

5.1.3 Hourly, the service rechecks every active member. A 401 or 403 on a member user-token call queues an immediate recheck through the same job. A successful installation-token permission lookup returning `none` or `read` sets `suspended_at` and publishes the revocation event (§5.6); regaining write clears suspension. Installation-level 401, 403 or 404, including an expired installation token or an App that lost repository access, sets the permission stream’s `github_sync` health to `refused` (§4.4) and changes no member row. Disambiguate a permission-endpoint 404 with `GET /users/{login}`: a confirmed unknown user is refused as unknown on add, an existing user with confirmed no repository permission follows the member-level rule, and an unresolved installation error preserves member state. Transient lookup failures also preserve member state and fail closed. Checks: C-ACC-03, C-ACC-04.

5.1.4 Role seeding: when a maintainer adds a person, the role defaults from GitHub. A person with only read access (or none) can't be added; the card shows "needs access on GitHub ↗". The owner can't be demoted or removed by anyone; owner transfer is deferred. Admin or maintain becomes Maintainer, and write becomes Member. A maintainer may change it.

### 5.2 Permission matrix

| Action | Owner | Maintainer | Member | Delegated (agent) | Coding agent (run) |
| --- | --- | --- | --- | --- | --- |
| Install settings: model access, capacity, GitHub App, upgrade | ✓ | | | | |
| Merge, approve a revision | ✓ | ✓ | | merge: `confirm` through Review & merge (a maintainer's session approves); approvals that gate a merge: `never` | |
| Members, roles, secrets write | ✓ | ✓ | | never (no confirmation path: secret values never pass through an agent or a pending confirmation) | |
| Merge flow/agent changes (same as Merge) | ✓ | ✓ | | `confirm` through Review & merge | |
| Create, place, amend, steer, answer, stop, resume, retry, drop TODOs; Bring in a foreign push | ✓ | ✓ | ✓ | `run`, except commit, amend, drop and Bring in: `confirm` (§15.1.5) | answer own conflicts only |
| Make a TODO from an issue with outsider text (§10.2.1); Discard a foreign push | ✓ | ✓ | | `confirm`: the requesting member must be a maintainer, and only that maintainer approves (§6.1.2b) | |
| Join branch, terminal, SSH, co-edit, fork, add to stack, run flows | ✓ | ✓ | ✓ | `run`, except add to stack: `confirm` (§15.1.5) | within its own branch |
| Read secret values | | | | | |

A `machine` credential has no person-command row. Workspace-restricted system tokens may report a head, access workspace children and use the provider pool only through machine-scoped actions whose subject is the token’s own workspace. Bind every requested child and provider request to that workspace; a different workspace returns 403 `permission`. These actions support the machine’s own branch and grant no person-command authority. Checks: C-ACC-01.

5.2.1 Every served command and in-card action passes through `Authorize(credential, command, subject)`. It reads actor eligibility, minimum role and `agent: run | confirm | never` from the literal `catalog.mvp.json` command-policy table (§6.1.2, §6.1.2b); §5.2 summarizes that table. C-CAT-01 proves its rows match product Appendices B and C. No ticket, Container or check maintains a second policy table. First check the credential scope and the member’s minimum role: failure returns `403 {class: "permission"}` with no confirmation. For an eligible delegated credential, `never` returns `403 {class: "never"}` with no confirmation, `run` executes, and `confirm` returns `202 {confirmation: id, state: "requested"}` after creating the private confirmation. The confirmation id contains no subject or secret data. UI hiding is presentation only. Checks: C-ACC-01, C-ACC-02, C-SEC-05. Actor-kind refusal returns HTTP 403 with class `never` and copy "Only a person can do this". If a confirmation-required decision has no installed consumer, dispatch fails closed before the handler with `{code: "confirmation_unavailable", class: "infra"}`. T-APP-04 renders the app Confirm card for 202 `{confirmation, state}` and the 403 `never` copy. T-CAT-02 renders those CLI outcomes; 202 prints "Waiting for <person> to confirm" and exits with a code distinct from refusal. Every confirmable API operation documents an OpenAPI 202 `{confirmation, state}` schema and a 403 `never` envelope. Checks: C-ACC-01, C-ACC-02, C-CAT-02. For Merge and merge-gating approval, an absent or invalid credential, a setup-only session, or a credential revoked because its member is suspended or removed returns HTTP 401, class `permission`, code `unauthenticated`. A valid provisional-owner session instead retains §5.1.0's `owner_unverified` permission refusal. Neither refusal creates a confirmation, fence, approval or outbound merge row. Unless a more specific rule names a code, a credential-scope, actor-eligibility, minimum-role or confirmation-owner refusal returns HTTP 403, class `permission`, code `permission`. The explicit delegated `never` refusal retains class and code `never`; §5.1.0 retains `owner_unverified`. Checks: C-STK-04, C-STK-07, C-ACC-02.

### 5.3 Credentials

| Kind | Issued to | How | Can approve/merge |
| --- | --- | --- | --- |
| `session` | Browser of a signed-in person | Sign-in cookie: HttpOnly, Secure, SameSite=Lax, 30-day TTL | Yes, for roles that allow it |
| `delegated` | An agent acting for a person: `smthrs login` (always), branch terminal auto sign-in, the app agent | Minted with `via` = the agent's name (claude-code, codex, smithers, terminal, cli) | No. It can request a person confirmation (§5.4) |
| `run` | One coding-agent run | Minted at run start, dies at the run's terminal state | No |
| `machine` | `smithers-machined` and the coding host on one machine | Minted per boot, scoped to that branch | No |

5.3.1 `smthrs login` MUST return a `delegated` credential, never a person-equivalent token, because the CLI can't know whether an agent will hold it. The `via` defaults to `cli`; `smthrs login --agent claude-code` sets it.

5.3.2 A branch terminal is signed in automatically with `delegated(via=terminal)` for its member and branch. In S1 the token is `/run/smithers/sessions/<session id>/token`, owned by the guest’s single uid, mode 0600, restricted to §8.11.1’s reads, own-TODO answer and steer, and append-only TODO creation; confirmations are outside its scope. In S2 it moves to `/run/smithers/<uid>/token`, owned by the member, mode 0600, and uses the full catalog policy. Both stages set `SMITHERS_TOKEN_FILE` and `SMITHERS_URL` and revoke the token within 5 s of session close. The skill’s `via` header identifies the agent participant acting for the member (§6.4, §14.6a). Checks: C-J6-01, C-SEC-05. An S1 `delegated(via=terminal)` credential requesting Merge is refused with HTTP 403, class `permission`, code `permission`, without a confirmation or merge side effect. In S2 the same `via` follows the full catalog policy and an eligible owner or maintainer receives the usual Review & merge confirmation. Checks: C-STK-04, C-STK-07, C-ACC-02.

### 5.4 Person confirmation

A delegated credential whose catalog row is `confirm` and whose scope and member role allow the command (§5.2.1) creates a `person_confirmations` row and returns `202 {confirmation: id, state: "requested"}`. The app shows it to that member only, bound to the exact subject revision. Only that member’s `session` can approve it, after the authorizer rechecks their current role. It expires after 24 h or when its subject revision changes. A delegated list/read response exposes only `{id, state}`; dispatch exposes only `{confirmation, state}`. Pending confirmations publish on `confirmations:<member>` (§7.2.2). Checks: C-ACC-01, C-ACC-02. Only the person who must press sees the Confirm card. Other viewers see no card, placeholder, subject or approver. Check: C-ACC-02.

### 5.5 Unix identity on machines (M-18, M-29)

5.5.1 Each member has a stable `unix_uid` from 20000 upward and a login equal to the GitHub login, sanitized to `[a-z0-9_-]{1,32}`. The coding agent runs as `agent` (uid 19999). The `smithers-machined` broker runs as root, and nothing else does; its daemon runs as `machined` (uid 19998, groups `{team}`) (§9.5.1). Check: C-COL-04.

5.5.2 No user on a machine has sudo, setuid helpers, file capabilities or membership in privileged groups. The image MUST NOT contain `sudo`. `su`, setuid/setgid binaries and binaries with file capabilities are removed or stripped. A sanitized login that collides with another gets a numeric suffix (`ben`, `ben2`), fixed at first assignment.

5.5.3 The working copy is owned `root:team` (gid 20000), with setgid directories and mode `g+rwX`. Every session has `umask 002`. Members and `agent` are in `team`.

5.5.4 Each member's home is `/home/<login>` on each machine, mode 0700, owned by that member's uid. A home belongs to one machine and is never shared between machines (§8.7.1). Tool logins carry from branch to branch through the member's credential store (§8.7.3), not through the home. A member added while a machine is awake gets a home there at their first session. `agent` has no access to member homes.

### 5.6 Revocation

5.6.1 Removing or suspending a member deletes their sessions, revokes their delegated credentials and SSH grants, and closes their live sockets, terminals and SSH sessions within 5 s. On machines this is `kill_sessions`, which returns only when none of their processes remains, background ones included (§9.6.3). In the same 5 s it cancels their queued app-agent turns and stops their running one (§15.1.4a). It also deletes their credential store rows and their seeded credential files on every machine (§8.7.3). Their TODOs keep their history; any maintainer can take one over with **Take over**, an in-card control on the TODO card (`todos.owner_id` change, audited). Checks: C-SPK-08, C-UI-06.

---

## 6. Commands, API and the catalog

### 6.1 One catalog

6.1.1 Every member-facing action is a command with a typed payload schema. The command is the single source for four doors: the app's slash menu, palette and card buttons; the app agent's tool list; the `smthrs` CLI; and the Smithers skill (M-21).

6.1.2 The MVP catalog is a machine-readable file, `catalog.mvp.json`, generated from the command descriptors. A command's descriptor is the one authority for it. Each row carries:
- the slash name, the CLI path, the journey and the group;
- visibility: `core` or `advanced` (an Appendix A row), `in-card` (a control inside a card: an mvp.md B.4 control or a B.1 card control) or `hidden`;
- actor eligibility: which of `person`, `app_agent` and `external_agent` may invoke it, read from the row's Appendix B Who column. **A** or **A✓** lists `app_agent`, and **X** lists `external_agent`. A UI-only row (B.1) never lists `external_agent`, since an external agent has no screen;
- the minimum role, `member`, `maintainer` or `owner`, from the same column (for example "maintainer for Discard" or "Owner only");
- the confirmation policy for delegated credentials, `agent: run | confirm | never` (§15.1.5). **A✓** gives `confirm`; otherwise **A** or **X** gives `run`; a row with neither gives `never`. A person-only row lists `person` alone and is `never`.

6.1.2a Doors follow from these fields. The slash menu, the palette and `/help` list exactly the `core` and `advanced` rows plus repository flows, and `/help` collapses `advanced`. An `in-card` row is a card button: it has no slash command, palette entry, `/help` row, CLI path or skill entry (for example Return to Tn, Keep for now, Bring in, Discard, OK on order attention, Reset to GitHub main, Make TODO from a proposal, Dismiss, Retry a background run). The app agent's tools are the rows that list `app_agent` and aren't `never`, `in-card` rows included. The skill carries the `core` and `advanced` rows that list `external_agent` (mvp.md B.6). The CLI carries the same rows plus person-facing open-card paths for `/secrets`, `/members` and `/settings`; those paths open the app card for the person, perform no mutation, and expose no external-agent path. Other rows have a `null` CLI path, the UI-only rows ⌘K, `/help`, `/stop` and `/theme` among them. `/terminal` maps to `workspace ssh`, `shell` and `exec` in the CLI. `/search` and `/github` status list `external_agent` and use the same read-only skill as the app agent. GitHub App changes stay owner-only. Sign-in and sign-out are never agent-invocable. The CLI hides non-MVP groups from MVP help with an explicit hidden list where incur lacks a flag. Check: C-CAT-01.

6.1.2b The host authorizer (§5.2.1) enforces the same fields for every credential: the actor kind must be eligible, its member must hold the minimum role, and a delegated credential follows `agent`. For a `confirm` row the authorizer checks the requesting member's role before it posts the confirmation and again when the member presses it, so a Member's agent can't post a maintainer-only Discard. §5.2 summarizes these fields. Check C-ACC-01 tests the authorizer against every `catalog.mvp.json` row, role and credential kind.

6.1.2c The allowlist (check C-CAT-01). mvp.md Appendix B is the registry of every flow and action: app flows, coding-host tools, backend system flows and workers, and CLI commands. Appendix C (`.specs/product/actions.md`, 386 rows) lists every `Flow.make`, `Action.make` and `AgentAction.make` tag in shipped flows and std tools, with where it runs. The build fails when:
- the `core` and `advanced` rows differ from Appendix A in either direction, or an Appendix A row that lists `external_agent` lacks a CLI path or skill entry;
- an `in-card` row has no B.4 or B.1 row, or a B.4 control (stable ids such as `todo.return-to-item`, `file.restore` and `merge.confirm`) has no `in-card` row;
- a row's actor eligibility, minimum role or `agent` differs from its Appendix B Who column;
- a registered app flow id or backend CLI command has no B.1, B.2, B.4 or B.6 row, or its row says Cut;
- a registered tag has no Appendix C row, or its row says Cut or Replaced;
- a tag is registered in a runtime its Appendix C row doesn't name: the host flow runtime registers only Install rows, and the coding host only Machine rows (§1.3, §11.1).

A ticket that adds a tag adds its Appendix C row in the same change. The Cut assertion turns on in the change that completes T-CUT-01's deletions, since 87 Cut tags are still registered today. The Replaced assertion turns on in T-FLW-11's change, which deletes the four separately launched entry points (`coding/Request`, `coding/Vibe`, `coding/Verify` and `review/change`); their steps keep running inside the one `todo` run (§10.4.1).

6.1.3 Commands outside the MVP stay published as libraries or CLI groups but are `hidden`. They are absent from the palette, `/help`, the agent's tools and the MVP docs.

6.1.4 A missing required input opens a form card, never a usage sentence.

### 6.2 HTTP API conventions

6.2.1 Every mutating request carries `Idempotency-Key`. A repeat with the same key returns the original result. An idempotency record is scoped to the authenticated actor and stores the operation, subject and canonical validated request, including the normalized reviewed SHA for Merge. After authentication and authorization to access the recorded result, the same key with the same operation, subject and canonical request returns the original result without executing again. The same key in that actor's scope with a different operation, subject or canonical request returns HTTP 409, class `conflict`, code `idempotency_mismatch`, message `Idempotency-Key was already used for a different request`, and creates no new confirmation, fence, approval or outbound write. Checks: C-STK-04, C-STK-07, C-ACC-02.

6.2.2 Responses state progress honestly. `202 {state:"requested"}` means persisted. `{state:"accepted"}` means durable admission. Completion arrives only as a projection event. A transport success is never completion.

6.2.3 Errors use one typed envelope: `{code, class: user|permission|capacity|github|infra|conflict|never, message, retry_at?, fix?}`. The class drives the UI fault copy ("not your fault" for infra and capacity). Class `never` means the actor kind may never perform the action, including agents on person-only commands. It returns HTTP 403 with copy "Only a person can do this". The UI renders `fix` as a link; API messages contain no "↗" glyph. Checks: C-ACC-01, C-ACC-04. Authorization uses §5.2.1's precedence. Eligible confirmable dispatch returns HTTP 202 with `{confirmation, state: requested}`, never a 403 confirmation fix. Check: C-CAT-01.

6.2.4 The OpenAPI document MUST describe every served route. Cut routes are deleted from both the code and the document in the same change. A route that Plue still serves but the Mac install must not (for example `/api/admin/*`) is unmounted in the install composition only, and the OpenAPI row carries `x-composition: plue`; the conformance test checks each composition against its own rows.

### 6.3 Resource surface (target)

```
/api/members            GET · POST add · PATCH role · DELETE remove
/api/todos              GET list · POST create{prompt,title,acceptance?,place,issue?,fixes?,seed_patch?}
/api/todos/{n}          GET · PATCH amend · POST {stop|resume|retry|retry-current-flow|drop|steer|answer|move|takeover}
/api/todos/{n}/merge    POST (session only) {reviewed_head_sha}
/api/stack              GET (home card snapshot)
/api/branches           GET · POST fork{from: main|Tn|branch, name?}
/api/branches/{b}       GET · POST {rebase|add-to-stack|sleep|wake|return-to-item|keep-moved|bring-in{sha}|discard-foreign{sha}} · /files · /diff · /activity
/api/branches/{b}/files/{path}  GET · POST {restore|restore-deleted} · GET compare
/api/conversations/{b}  GET entries · POST prompt · PUT view-state · POST turns/{id}/stop · PATCH turns/{id} {prompt} · DELETE turns/{id}   (turn routes: the author only; PATCH and DELETE while queued; C-APP-02)
/api/terminals          POST open{branch}
/api/flows              GET catalog with versions · POST edit{name, request} · POST run
/api/runs               GET · /{id} · /{id}/trace · POST /{id} {retry|dismiss} (failed background runs, §14.3; check C-J4-01)   (sending signals by hand is deferred)
/api/proposals          GET · POST {id}/accept · POST {id}/dismiss
/api/secrets            GET names · PUT · DELETE
/api/github/sync        GET health · POST retry
/api/confirmations      GET mine · POST create (any credential) · POST {id}/approve|deny (session only)
/api/agents             GET (roles, model, runs) · PUT {role}/model (owner)
/api/install            GET status (with a setup session before the claim, owner afterwards, §5.1.0) · PUT settings · POST setup/{step} · POST quiesce · DELETE quiesce · GET scorecard (owner)
/api/live               WebSocket (§7)
/ssh :2222              SSH gateway (§8.10)
```

### 6.4 Attribution header

Every request from an agent carries `Smithers-Via: <agent>`. The CLI and skill set it from the environment: `CLAUDECODE=1` → `claude-code`, `CODEX_*` → `codex`, otherwise the `via` in the credential. The host records `via` from the credential kind and the header, credential first. A `session` credential ignores the header.

---

## 7. Live channel [S1; presence S2; documents S3]

### 7.1 Transport

One authenticated WebSocket per browser tab, `ws://` or `wss://` matching the page's origin, at `/api/live`, subprotocol `smithers.live.v1`. It is authenticated by the session cookie, or by a bearer token for the CLI. Frames:

```
text   {"t":"sub","id":7,"topic":"todo:12","cursor":1043}
text   {"t":"unsub","id":7}
text   {"t":"snap","id":7,"cursor":1050,"data":{…}}        server → client
text   {"t":"delta","id":7,"cursor":1051,"data":{…}}
text   {"t":"gap","id":7}                                    client must resubscribe without a cursor
text   {"t":"err","id":7,"code":"unknown_topic|forbidden|unsupported"}   subscription refused; socket stays open
text   {"t":"presence","id":9,"where":{…}}                   client → server heartbeat
text   {"t":"saved","id":7,"sv":"<base64>","at":"…"}         server → client: a document is durable through state vector sv (§7.4.6)
binary [kind u8][sub id u32][payload]   kind: 1 yjs-sync, 2 yjs-awareness, 3 term-out, 4 term-in, 5 term-ctl
```

7.1.1 The server applies backpressure with a per-connection send budget of 2 MiB. On overflow, projection subscriptions receive `gap`, terminals drop to ring replay, and Yjs documents restart sync step 1.

7.1.2 Reconnects back off with jitter from 250 ms to 5 s. On reconnect the client resubscribes with its last cursors.

### 7.2 Projection topics

| Topic | Snapshot | Deltas from |
| --- | --- | --- |
| `home` | Stack, `main` row, counts, background runs, machines in use / capacity, sync health | todos, todo_events, machines, github_sync, runs |
| `todo:<n>` | TODO card model (§14.3) | todo_events, runs, activity, the GitHub synced store |
| `branch:<id>` | Branch card model: machine, presence, item, place, terminals | machines, presence, terminals |
| `branch:<id>:activity` | Last 200 activity entries | activity |
| `branch:<id>:files` | Changed files vs the item's base, plus per-file last writer | burst_files, live documents |
| `run:<id>` | Run summary, steps, phases and cells (§11.6.3) | runtime events (§11.6), `run_summaries` |
| `members` / `secrets` / `flows` / `proposals` / `agents` | Card models | their tables |
| `install` | Setup and Settings model (§14.3) | install_settings, github_app, host profile |
| `confirmations:<member>` | That member's pending confirmations (member-only) | person_confirmations |
| `view:<member>:<branch>` | That member's view state for a conversation (member-only) | member_conversation_state |
| `conversation:<branch>` | Shared entries with author, title, summary, tone, state, context | conversation_entries |

7.2.1 A delta MUST arrive at subscribers within 1 s (p95) of the committing transaction on the reference host (check C-PERF-02).

7.2.2 Shared topics carry only shared state. Per-member data lives on member topics named with the member id: `confirmations:<member>`, `view:<member>:<branch>` (view state, `last_seen_seq`), and private entries (`audience_member_id`, §14.5.1). The client derives `merged_since_last_look` and the Home card's `attention[]` from shared rows plus the member's own `last_seen_seq` and role. `NOTIFY` fan-out needs no member filter.

### 7.3 Presence [S2]

7.3.0 For 30 s after the host starts, presence is unknown, and the scheduler releases no machine in that window (§8.3.3).

7.3.1 Presence is in-memory in the host service, keyed `(branch, actor, session)`, with a 30 s TTL refreshed by heartbeats. Heartbeat sources:
- the browser, every 10 s and on every move, with where = `{path, line}` (§7.6), `{terminal}`, `{run step}` or `{branch}`;
- `smithers-machined` for SSH, terminal and editor sessions, with where = the file last written by that session (§9.3);
- the runtime for coding and reviewer agents, and the host turn runner for Smithers app agents, heartbeat every 10 s while working with the participant id, acting-for member and current step or file; external-agent skill calls bind an agent participant to their broker session, whose heartbeats keep its terminal/file presence alive until that agent session ends. Check: C-J3-01.

7.3.1a When a person's presence on a branch lasts at least 2 min, the host writes one coarse `presence_sessions` row (start, end) for the scorecard. Presence itself stays in memory.

7.3.2 Presence changes publish to `branch:<id>` as deltas, coalesced to at most 4 per second per branch, and reach subscribers within 1 s. Rows stay per session and render per participant: one avatar for each person or agent participant, with its sessions on hover. Smithers app agents, coding agents, external agents and reviewers each have a stable participant id for their active session or run, their own avatar and an acting-for member when present (§14.6a). Never collapse an agent into that member’s avatar. Checks: C-J3-01, C-J6-01.

### 7.4 Live documents (Yjs) [S3]

7.4.1 One protocol: Yjs sync step 1 and 2, updates, and awareness, carried in binary frames on the live channel. One client provider serves both document kinds.

7.4.2 Two document hosts implement it:
- **Code files:** `smithers-machined` inside the branch machine owns the file and the document's durable state: it alone saves to disk and acknowledges saves (§9.2). Browsers sync with one document per topic and never learn where its Yrs authority lives (§7.6). ADR 0003 places that document by T-COL-10's decision rule: in the daemon, with the host relaying frames unparsed over its machine connection, or in a host-side mirror for fan-out that syncs with the daemon over the same connection. Either way the host authenticates each subscriber and tags its updates with the subscriber's actor, the side browsers sync with rejects an update under another actor's client id (§7.4.4), and §7.4.6 and §9.2 hold unchanged.
- **Wiki pages:** the host service owns the document (Yrs). It persists the merged state and the rendered Markdown in PostgreSQL, in one transaction and one revision, after 2 s without an update or 10 s after the oldest unpersisted update, whichever comes first, rather than per update. It acknowledges updates only after that commit (§7.4.6).

7.4.3 The wiki moves onto 7.4.1 in stage 3, together with code co-editing, and the earlier POST-update and SSE-refetch protocol is deleted then. There is one co-editing implementation.

7.4.4 Attribution of characters: each subscriber connection gets a Yjs client id that the host records as `client id → actor`. That map is stored in the document's own `Y.Map("authors")` so every host and reader resolves colours identically. Edits applied by `smithers-machined` for an outside writer use a client id allocated to that writer (§9.2.4).

7.4.5 Awareness carries `{actor, colour, line}` only; selections and carets are not shown (mvp.md §6.8 Cut). The card renders a gutter name flag per remote editor line.

7.4.6 **Saves, reconnects and epochs.** Both document kinds follow one acknowledgment and recovery rule (check C-DUR-04, K7 and K8):
- The authority sends `saved{sv}` (§7.1) once the state with state vector `sv` is durable: for code, after the daemon's file and state record are on disk (§9.2.2); for the wiki, after the host's PostgreSQL commit (§7.4.2). A client's own update with clock c is saved when `sv` maps the client's id to at least c. That alone drives a card's saved state, such as "Saved to the machine" on a File card.
- A client keeps every update that no `saved` covers and sends it again in sync step 2 after any reconnect. The wiki client keeps them in its local `worldDocuments` store across reloads. The code client keeps them in memory, where at most about 1 s of typing waits for a save (§9.2.2). A host mirror (§7.4.2) is a client of the daemon under this rule and relays `saved` unchanged; after a host restart it rebuilds from the daemon before it answers browsers.
- An authority recovers a document from its stored state, never by reseeding from text, so reconnecting clients share its item identities and their updates merge without duplication. The snapshot of a `doc:` subscription carries the document's `epoch`, a random 128-bit id. An authority makes a new epoch only when it has no readable stored state and seeds from text. A client whose epoch differs retains its unacknowledged edits in the recovery buffer (§9.2.5a), replaces its local document and syncs fresh, so it never merges two epochs. It shows "N edits weren't saved" with Reapply and Copy instead of dropping those edits silently. Check: C-DUR-04.

### 7.5 Terminals on the channel

A terminal subscription streams the PTY [S2]. Kind 4 (input) is accepted only from the terminal owner. Input from anyone else is dropped, and the drop is counted (§8.11).

### 7.6 Co-editing contracts fixed in stage 1 [S1]

These hold from the first stage-1 commit, so stage 3 adds a document layer without changing any earlier interface. ADR 0003 (T-COL-10) records them. T-COL-10 also fixes the daemon↔host wire contract in `docs/architecture/0004-machined-wire.md` before component work starts. Golden frames in `packages/backend/internal/compose/cocontracts_test.go` and its shared testdata gate the Rust, Go and TS implementations and every fake. They cover stream kinds, RPC requests and responses, actor envelopes, outbox acknowledgements and S3 document frames. Check: C-COL-01. Runtime implementations remain S2 and S3 as marked below.

| Contract | From | Why stage 3 needs it |
| --- | --- | --- |
| Every write to a branch's files carries an actor (§2) and a `base_digest` precondition; a stale write is refused with `409 stale`, never applied silently | S1: the coding agent's write tool checks it in the machine (T-COL-07); the HTTP route is contract-only until S3, proven by an API test (C-COL-01) | Disk→document reconcile and "no silent overwrite" |
| Topics `doc:code:<branch>:<path>` and `doc:wiki:<page>` and binary frame kinds 1–2 are reserved on the live channel. A browser addresses a document only by its topic and never learns where its Yrs authority lives | S1 | The Yjs sync protocol rides the existing channel (§7.4.1), and ADR 0003 places code documents in the VM or in a host mirror (§7.4.2) with no browser change |
| The File card renders with CodeMirror 6, the surface `y-codemirror.next` binds to. Code intelligence (hover, definition, diagnostics) moves from the Pierre file view onto CodeMirror extensions. Diffs stay on `@pierre/diffs` | S1 (T-APP-15 builds it read-only first) | One editor for view and co-edit; no second renderer |
| Presence `where` uses `{path, line}` in the document's line coordinates, the same shape Yjs awareness carries | S2 | Gutter name flags come from presence before co-editing exists |
| The daemon's host connection reserves a document stream kind; `capture()` has a flush phase (a no-op until S3) | S2 | Sleep, upgrade and rebase flush documents first (§8.4.3, §9.4) |
| Change events carry each file's post-write content digest | S2 | The document host tells its own writes from others' (§9.2.2–9.2.3) |
| One machine per branch, keyed by branch (§8.1) | S2 | The document host lives on the branch's one machine |
| The wiki keeps `Y.Text("markdown")` as its document shape | S1 | The wiki moves to the same transport in S3 without a data migration |

---

## 8. Branches and machines [S2; jj flows §8.5 and images §8.6 S1]

### 8.1 Identity

8.1.1 A branch is identified by its name. An item branch is named `smithers/<todo-slug>`, where the slug is derived from the TODO title, is ≤ 48 characters and is unique. A scratch branch is named `scratch/<member>/<name>`.

8.1.2 Every member and the coding agent who join a branch use its single machine. No per-person or per-agent copy of a branch exists (M-17). Branch locks do not exist.

### 8.2 Capacity

8.2.1 Every limit derives from the host the install detects at start (M-06). The install never assumes a Mac model. Host profile: `hw.memsize`, `hw.perflevel0.physicalcpu` (performance cores) plus `hw.physicalcpu`, free disk on the `$STATE` volume, the macOS version, and Hypervisor.framework availability.

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

8.3.1 One queue, `machine_requests`, for every reason a machine must be awake. Classes in priority order: `person` (a member's terminal, SSH, edit, steer or answer that needs the machine), `todo` (a TODO run) and `background` (learning, flow load, wiki refresh). Each request names its holder: a branch's machine, or one ephemeral machine (a layer prepare or a background run). Demand coalesces per holder. Each actor's request is its own row, so cancelling one (§8.3.4) leaves the others, but a holder takes one slot however many rows it has. A holder ranks by the highest class among its waiting rows, then by its oldest row of that class. A person's request on a branch whose TODO already waits therefore promotes the branch to `person`, ranked by the person's request time (check C-MCH-11).

8.3.2 Scheduler: event-driven, with a 1 s tick. A **slot** is held by every VM from its grant until the runtime confirms that the VM has stopped or been deleted. Machines that are provisioning, waking, awake or releasing hold slots, and so do layer-prepare VMs and ephemeral background machines. The scheduler grants the first holder in rank order while `held` is below capacity (§8.2.1b). A grant takes a transaction-scoped advisory lock (`pg_advisory_xact_lock`), counts held slots and marks every waiting row of the holder `granted`, all in one transaction, so two scheduler instances never grant one slot twice. A request for a holder that already holds a slot is granted at once and takes no new slot. When the runtime confirms the stop, the holder's granted rows become `released`. A release that the runtime hasn't confirmed within 60 s is force-stopped, and its slot stays held until the stop is confirmed. At start, the host reconciles slots with the runtime: a slot whose VM the runtime doesn't have is released, and a VM that holds no slot is stopped. The runtime's own VM cap equals the memory and core terms of §8.2.1 and counts every VM that isn't stopped; the scheduler never reaches it. A position is the holder's rank within the waiting set, shown on each of its requests as "waiting for a machine #2" (check C-MCH-11).

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

8.5.0 Fork, Add to stack and Rebase now are system flows that any actor invokes. Stage 1 implements them over today's workspaces: a fork's source is `main`'s tip or an item's last verified head, and forking a scratch branch waits for stage 2's capture (§8.5.2). The stack service is the only writer of branch history (M-32): every fork, place, reorder, rebase and merge appears in branch activity as "Smithers", with the requester shown ("Smithers, for Ben"). Requesters include a person and the app agent, under §15.1.5 permissions (fork and rebase: `run`; add to stack: `confirm`). The buttons and the agent delegate to the stack service.

8.5.1 A fork creates a scratch branch from a revision. Sources: `main` (its tip), an item (its last captured head) or any branch (its last captured head, after an on-demand capture if the branch is awake).

8.5.2 A fork MUST NOT stop the source machine. It starts from a revision, not a disk copy; uncommitted work is included only via the capture, which is a jj snapshot and therefore a revision.

8.5.2a **Rebase now** on a scratch branch rebases it onto the current head of what it was forked from: `main`'s tip, or the item's last verified head.

8.5.2b A Rebase now conflict on a scratch branch has no TODO to raise Needs you on. The Branch card shows the conflicted paths with Resolve, and the branch stays on its pre-rebase head until someone presses Done (§10.5.4).

8.5.3 **Add to stack** from a scratch branch creates a new TODO from the scratch branch's whole change since its seed base, placed like any other (default: directly after the item it was forked from, or appended for a fork of `main`). A fork records `forked_from {kind, ref, commit, base, item?}`. For a fork of `main`, `base` is the `main` tip it started from. For a fork of item Tn, `base` is the revision Tn's own change is measured from in the forked head (the previous item's verified candidate, or `main` for the first item, §12.5.1), and `item` is Tn. The seed therefore holds Tn's work as well as the scratch edits (J7.3). Add to stack takes the scratch head (from stage 2, after a capture of an awake branch, §8.5.1), makes the TODO's change one jj change with parent `base` and the scratch head's tree, and stores its diff as revision 1's `seed_patch_blob`. Placement rebases that change like any other (§10.5). Placed after Tn, the part it shares with Tn merges cleanly when Tn hasn't changed since the fork, so its own diff is the scratch edits; a conflict follows §10.5.4.

8.5.3a Dropping Tn keeps Tn's work in every unmerged TODO forked from it. Before the drop rebases later items (§10.7.2), the stack engine squashes Tn's change into the first TODO after Tn in stack order whose `forked_from.item` is Tn (`jj squash --from <Tn> --into <Tk>`). Tk's tree is unchanged by the drop, and the items between Tn and Tk rebase without Tn's change. A TODO forked from Tn and placed before it already holds Tn's change. Check C-J7-02.

8.5.3b The scratch branch becomes the new TODO's item branch: it is renamed `smithers/<slug>` and keeps its machine, working copy and the people on it. A scratch branch's Diff card compares against its fork revision. [D] **Replace Tn**, which would make the scratch head the new head of item Tn's change, is deferred.

### 8.6 Images [S1]

8.6.1 A machine's root disk is built from a recipe. **Add to machine image** (an in-card control on Settings and on a failed step that names a missing tool) creates a TODO whose seed patch adds the package to `.smithers/machine.json`. The recipe is the pinned base image, the toolchain detected from the repository (§8.6.2), the declared image additions (`.smithers/machine.json` `packages[]`, reviewed like any change, M-29) and the dependency install for the head revision. The recipe digest keys a layer cache, so two branches with the same recipe share layers.

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

8.7.1a Disk: homes count against the machine's root disk, which §8.2.1 sizes from the host profile. A machine recreated from a new recipe starts with empty homes, and its credentials are seeded again (§8.7.3).

8.7.2 Nothing in a home is readable by `agent`, by other members, or by the host service's flows. The credential store is read only by the host's credential service and `smithers-machined`; no flow, API or card can read a value back. The sole transcript exception is §9.6.6: an owner-uid child reads that session owner's identified Claude Code or Codex transcript for M-38. Only normalized conversation content is shared on the branch. Raw files and unrelated home history remain inaccessible to other members and flows. Check: C-AGT-02.

8.7.3 **Credential store.** The host keeps each member's tool credential files in `member_credentials`, sealed under the install key (§17.4). Five files are tracked:
- `~/.claude/.credentials.json` (Claude Code);
- the account fields of `~/.claude.json` (`oauthAccount`, `userID`, `primaryApiKey` when present), merged into that file, which is never replaced whole;
- `~/.codex/auth.json`;
- `~/.config/gh/hosts.yml`;
- `~/.gitconfig`.

8.7.3a `smithers-machined` seeds these files into the member's home at the first session after each wake, and again whenever the store changes (`seed_credentials`, §9.1.2). It watches the five paths with inotify, apart from the working-copy watcher (§9.3.1), and never as bursts. A changed file comes back as `credential_changed{member, file, content, written_at}`, and the host keeps the newest `written_at`. A deleted file, such as a tool's logout, comes back with `content: null` and wins the same way: the host deletes that store row, and every machine where the member has a home deletes the file, at once or at its next wake. Guest clocks are host-synced; a tie goes to the later arrival. The host then seeds that copy into every other awake machine where the member has a home. Apart from the normalized session transcript content in §9.6.6 (C-AGT-02), nothing else in a home leaves its machine. Removing or suspending a member deletes their store rows, and every machine deletes their seeded files at once, or at its next wake if asleep (§5.6). Check: C-MCH-10 step 9.

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

8.11.1 A terminal is a PTY session that the daemon starts as the owner's unix user, in the working copy, in its own session cgroup. The host's terminal manager attaches to it over the daemon connection and serves it on the live channel (§7.5), replacing today's separate terminal WebSocket. It is signed in to Smithers (§5.3.2). In stage 1, before the daemon exists, terminals keep today's `msb exec -t` path as the guest's single user. The stage-1 terminal token is therefore readable by the coding agent. It is minted only when a member opens a terminal, expires with the session, and is limited to: reads the member can do; `todo.answer` and `todo.steer` on that branch's TODO; `todo.new` (append only); and wiki reads. `Authorize` enforces the list (check C-SEC-05). No release ships stage 1 alone.

8.11.2 [S2] Any member on the branch may watch; their view is read-only, and only the owner types (M-18). [D] **Ask to type**, with Allow and revoke, is deferred.

8.11.2a [S2] The coding agent's `bash` tool runs in the agent's own terminal session on the branch: a daemon PTY owned by `agent`, attributed to the run. Its commands therefore render in the Terminal card like anyone's (one card per flow, whoever runs it), and members can watch it read-only. Command output still returns to the agent as the tool result.

8.11.3 A terminal survives browser reloads through the ring replay (512 KiB). It does not survive a machine sleep, an install restart or a daemon restart (§9.6.4). A terminal open on a branch prevents safe-idle (§8.4).

### 8.12 Cleanup

A machine's VM and disk are deleted only when four things hold: its TODO is merged or dropped (or its scratch branch is archived), a final capture succeeded and the head ref equals the captured head, no terminal or service is active, and 24 h have passed. Services still running on a settled branch are stopped after those 24 h. History, activity and evidence remain in PostgreSQL and the repository store.

---

## 9. The machine daemon (`smithers-machined`) [S2; documents S3]

A static Rust binary (linux-arm64, musl) that starts inside every machine before any session. It runs as a root broker and an unprivileged daemon (§9.5). It is the only process that writes the working copy on behalf of Smithers, the only observer of writes, the supervisor of every session (§9.6), and the machine's single connection to the host.

### 9.1 Connection

9.1.1 `smithers-machined` keeps one multiplexed connection to the host over the host-relay port. It authenticates with the boot's `machine` credential, and the host authenticates to it (§9.5.3). It reconnects with backoff from 250 ms to 5 s and then resends its outbox (§9.1.4). Streams on the connection: control RPC, change events, live-document frames, presence, and one stream per session (§9.6.2).

9.1.2 Control RPC:
- `capture()`: flush documents, snapshot, push the head and the versions commits named by pending events, drain the outbox (§9.1.4), and return the head commit and its tree (§10.4.4, §10.4.5). Checks: C-DUR-04, C-STK-06;
- `read_file(path, at?)`;
- `write_file(path, base_digest | "absent", content, actor)`: the §7.6 compare-and-write, run under the mutation lock (§9.4.1);
- `open_session(user, kind: pty|exec|sftp, argv?, size?)`, `tcp_connect(port)`, `close_session(id)` and `kill_sessions(user | run)`: §8.10.3, §8.11, §9.6. The File card's language server is an `exec` session owned by the member who asked for code intelligence, one per (member, language), closed after 10 min without a request or when the machine sleeps; it doesn't count toward safe-idle (§8.4.1). Check: C-UI-11;
- `seed_credentials(member, files[])`: §8.7.3; the broker writes each file through a child running as the member (§9.5.1), mode 0600, merging `~/.claude.json` account fields;
- `register_run(run_id, session)`: the host calls it after it starts a run's coding host with `open_session(agent, exec)`, so writes by that session's processes resolve to the run. Only the host can call it (§9.5.3);
- `rebase(onto)`: §9.4;
- `return_to_item()`: §9.3.8;
- `wake_reconcile()`: runs on every boot before any session starts. It fetches `refs/smithers/branches/<id>/head` from the host. If the host rebased the branch while it slept (§10.5.5), it moves or rebases `@` onto that head and emits "Rebased onto Tk". A conflict becomes `needs_you{conflict}` on wake;
- `status()`;
- [S3] `open_doc(path)` and `close_doc(path)`.

9.1.2a Each capture is one jj operation, as is any jj command a person runs. Nothing outside the machine references a jj operation: activity uses burst versions commits (§9.3.4) and reads use the captured head (§8.4.4), both in the host store. Weekly, the daemon abandons operations older than 7 days (`jj op abandon`) and runs `jj util gc`, so the operation log holds at most 14 days. T-COL-01 measures snapshot latency (target under 500 ms) and the disk growth of 1,000 captures.

9.1.3 The guest's init supervises the broker, and the broker restarts the daemon on exit, with backoff, after ending every session (§9.6.4). While a machine is awake, capture runs after every burst (coalesced to one per 5 s) and at least every 5 min.

9.1.4 **Outbox.** Every event the daemon sends goes through an on-disk outbox (`/var/lib/smithers-machined/outbox`) that survives daemon and VM restarts. Only `file_written` and presence skip it: they are hints, sent directly. Check C-DUR-04.
1. Before an event enters the outbox, every object it names (a versions commit, a captured head) is durable on the machine disk (`syncfs`) and held by a local ref, `refs/smithers/pending/<event id>`, so `jj util gc` keeps it.
2. The daemon appends the event with a monotonic `seq` and a unique `event_id`, and `fsync`s the outbox.
3. In `seq` order, the daemon pushes each event's refs to the host store, several per `git push` (a batch never skips one), then sends the event.
4. The host confirms that every named object is in its store; otherwise it answers `missing_objects` and the daemon pushes again. In one transaction it applies the event and inserts a receipt `(branch, event_id)`, then acknowledges `seq`. An event whose receipt exists is acknowledged without being applied again.
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

9.3.3 **Ignored paths** produce no activity. Ignored means everything `jj` ignores (`.gitignore`, `.jj/`, `.git/`), plus the dependency and build paths the toolchain detector names (`node_modules/`, `target/`, `.venv/`, `dist/` when gitignored). Ignored directories get no activity watch, and any other event for an ignored path is dropped in user space. Metadata watches are separate and never produce activity: `.jj/repo/op_heads/heads/`, `.git/` (not recursive, for `HEAD` and `packed-refs`) and `.git/refs/` (recursive). Their events run the moved-off check (§9.3.8) once they stop for 200 ms.

9.3.4 **Bursts.** Writes through Smithers group by their exact actor. All other writes on the branch share one key, so at most one outside burst is open at a time, and its actor is decided at close (§9.3.1). A burst opens on its first write and closes after 1.5 s without a write for its key, 10 s after it opened, or before a write with another key touches a file the burst touched. Writes and closes run under the mutation lock (§9.4.1). Before each write through Smithers, the daemon drains pending inotify events, so outside writes that completed earlier are counted first. Check C-COL-05.
- **Versions.** Every path has a *recorded version*: a git blob, in the working copy's object store, of its content as last counted. A write through Smithers records the content it writes when it writes it. An outside burst records each touched file at close, except a path with an open document, whose version is the bytes the reconcile read (§9.2.3). A path untouched since the last capture has its blob in that capture. Per file, a burst keeps `before` (the recorded version when the burst first touched it) and `after` (the version it recorded last). A write that touches another key's file closes that burst first, so neither side ever includes another actor's change, even when bursts overlap or two actors write one file in turn.
- `file_written{path, actor, post_digest}`: sent within 200 ms of each write to a tracked path, so open cards reload in under 1 s (§18).
- The burst event, on close. The daemon builds one *versions commit*, a parentless git commit whose tree holds each file's `before` at `a/<path>` and `after` at `b/<path>` (an absent side is omitted). It sends `{burst_id, actor, files[{path, change, renamed_to?, before_blob, after_blob, post_digest}], versions_commit}` through the outbox (§9.1.4), which pushes the commit to `refs/smithers/branches/<id>/bursts/<burst>`, so a sleeping branch's activity and diffs never need the machine.

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
3. runs `capture()`, so every writer's work is captured first (mvp.md §4.2);
4. rewrites: `jj rebase -d <onto>` on the item change, or `jj edit`;
5. reconciles each open document from disk as one transaction attributed to the operation, for example "Rebased onto Tk" (§9.2.3), which keeps unsaved typing;
6. thaws the sessions and releases the lock.

9.4.2a Browsers keep typing into open documents throughout; only saves wait. Queued `write_file` calls then run against the new content, so a stale `base_digest` gets `409 stale` (§7.6), and the writer re-reads. The lock is held under 2 s at p95 (C-PERF-06). C-COL-03 proves that no writer's write is lost or lands mid-rewrite. During the freeze, everyone sees "Rebasing…" on the branch and on each frozen terminal. After success, activity records "Rebased onto Tn" with the actual target TODO. If step 1 times out, the branch keeps "Rebase pending", the host retries automatically, and the presser sees the blocking writer, for example "Waiting for a write in Ben's terminal". The daemon includes that session in its `busy` response. Checks: C-COL-03, C-PERF-06.

### 9.5 Privilege and confinement [S2]

9.5.1 The binary runs as two processes. The **broker** runs as root and does only what needs root: it creates, freezes and kills session cgroups; starts session processes as their user (§9.6); writes `/run/smithers/env` (§8.8.1); watches the five credential paths (§8.7.3); and reads and writes a member's home and `/run/smithers/<uid>/` through a child that has dropped to that member's uid and gids. The **daemon** runs as the unprivileged user `machined` (uid 19998, groups `{team}`) and does everything else: the host connection, RPC parsing, the watcher, jj and git, documents, and every working-copy read and write. The two talk over a socketpair made at start, and the broker accepts no other caller. A fault in the daemon therefore can't reach a home, a token file, or anything else `team` can't.

9.5.2 **Paths.** Every working-copy path in an RPC is relative. The daemon resolves it with `openat2` from a descriptor for `/workspace`, with `RESOLVE_BENEATH | RESOLVE_NO_MAGICLINKS | RESOLVE_NO_XDEV`, so `..` or a symlink, even one swapped in mid-call, can't leave the working copy. A write opens its parent the same way and creates, renames and swaps inside that parent descriptor; a symlink as the last component is refused. Reads and writes accept only regular files: a directory, FIFO, socket or device is refused after an `O_NONBLOCK` open and `fstat`. The broker's home child opens credential paths with `RESOLVE_BENEATH | RESOLVE_NO_SYMLINKS` from the home's descriptor and accepts only regular files up to 1 MiB. The guest kernel must provide `openat2` (Linux 5.6 or later); the daemon refuses to start without it.

9.5.3 **Identity.** Actors and users come only from authenticated context, never from a field the machine controls:
- A host RPC carries the actor the host's authorizer resolved (§5.2.1). The daemon accepts RPCs only on its host connection. On `bridge` the daemon dials the host. On `relay`, the host first presents the per-boot connection secret that the runtime writes at boot to a file only `machined` can read (0400), and the daemon closes any other connection to its port.
- The local socket `/run/smithers/machined.sock` (`root:agent`, 0660) serves only the coding agent: `read_file`, `write_file`, and `open_session(pty)` for the agent's own terminal (§8.11.2a). The daemon takes the caller's uid from `SO_PEERCRED`, requires `agent`, and maps the caller's cgroup to the run the host registered (`register_run`); that run is the actor. A caller outside a registered run is refused.
- The broker starts sessions only as `agent` (19999) or as a member uid of 20000 or more whose login matches `[a-z0-9_-]{1,32}`. It never starts one as root, and it refuses a login whose uid differs from the one already created on that machine.

Check C-COL-04.

### 9.6 Sessions [S2]

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

9.6.4 **Disconnects and restarts.** If the host connection drops, sessions keep running for 30 s, stalled by flow control. A host that reconnects in that time re-attaches their streams by session id; otherwise the daemon closes them. A host restart re-attaches nothing (§8.11.3). Before the broker restarts a daemon that exited, it kills every session cgroup, so no process outlives the daemon that attributes its writes, and the host marks those sessions ended.

9.6.5 Spike T-TRM-06 (check C-SPK-08) proves this contract with a real VS Code Remote session, flow control and 5 s revocation before the stage-2 daemon work starts. T-TRM-07 builds it.

9.6.6 **External-agent transcripts (M-38).** [S2] For Claude Code or Codex running in a registered member terminal, the broker discovers the agent and its transcript from the session process tree, cgroup, uid, working directory and configured agent home. Default transcript roots are `~/.claude/projects/` and `~/.codex/sessions/`; adapter fixtures document supported releases, path layouts and configuration overrides. A recent file or matching directory alone does not establish ownership. A child dropped to the session owner's uid and gids opens only the identified regular file beneath that owner's agent root, without symlink traversal (§9.5.2). No request supplies another member's uid or home. Separate inotify watches and a 1 s reconciliation scan tail complete records; partial records wait. The daemon sends versioned source records with session, participant, source generation and byte range through the §9.1.4 outbox. The host's existing TypeScript process calls T-AGT-01's pure adapters, commits conversation entries and transcript run events atomically with the receipt, then publishes live-channel deltas on `conversation:<branch>`. The Rust daemon owns discovery, record framing and transport; the host library owns semantic mapping. Rotation, truncation and overflow reconcile the identified source; source generations and record offsets deduplicate replay. Unsupported versions stop that source and publish an import error. A complete record appears within 5 s on a healthy connection. Watches follow the registered agent lifetime and stop on revocation. Imported edit reports never override §9.3 observed-write attribution. Checks: C-AGT-01, C-AGT-02.

---

## 10. Stack and TODO engine [S1; presence-aware rebase S2]

### 10.1 Ownership

The stack engine is a host service. It is the only writer of stack order, TODO states and the `mythical` history; `main` is never written (AGENTS.md). It reacts to commands, runtime events, `smithers-machined` events and GitHub events. Every transition goes through `todo_events` (§3.2).

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

10.2.2 Placement: `append` (default), `before Tn` or `amend Tn`. Amend creates no TODO. It appends a `todo_revisions` row to Tn with reason `amend` (revision n+1, shown as "+1"; revision 1 is the original), and if Tn is working, delivers the amendment to the run as a steer.

10.2.3 Position is a dense ordering key (`stack_position`). Move up and Move down swap adjacent unmerged items, and Drop removes one. Every reorder rebases the affected later items (§10.5).

### 10.3 Parallel work

10.3.1 Up to `parallel` TODOs work at once (paused, needs_you and in_review TODOs whose machine is released don't count), each on its own branch and machine. The default is `max(1, capacity − 1)`, which leaves one machine for people and background runs. The owner may set it from 1 to 8, capped by capacity. Queued items admit in stack order.

10.3.2 Item N's work starts from its **prefix**: the verified head (§10.4.4) of the nearest earlier unmerged item that has one, else `main`'s tip. Admission never waits for an earlier item to verify. When an earlier item publishes a verified head, its first or a newer one, or `main` moves, N gets `rebase_pending{onto}` (§10.5.1), and N's next candidate sits on the new prefix. The first unmerged item's prefix is `main`'s tip. Its PR shows only its own change (§12.5). Check: C-STK-06.

10.3.2a [S1] SelectPrefix selects the nearest earlier unmerged item's usable last accepted head, or main's tip when none exists. Each generation records the ordered included-items manifest inherited from that head, naming item identities, generation heads and changes, plus its recorded main base; its tree contains that main base, the manifest's changes and its own change, each once. The manifest may omit unverified predecessors. At rest, when every earlier unmerged item has accepted a generation on its current prefix and no rebase is pending, it contains all earlier unmerged items in stack order. In §12.5.1, “previous item's candidate” means the selected prefix candidate, or the recorded main base if the manifest is empty. Checks: C-STK-06.

### 10.4 The TODO run

10.4.1 A TODO's work is one run per attempt of the Active `todo` flow version, pinned when the TODO enters Starting (§11.4), executing on the TODO's branch machine. The run lives until the TODO is merged or dropped:

```
route → plan (cites wiki revisions) → implement → candidate → check → review (the overridable `review` flow)
      → stack.propose ──▶ wait for a stack event:
            clean rebase onto a new tip   → candidate → check → stack.propose → wait
            agent-resolved rebase conflict → implement → candidate → check → review → stack.propose → wait
            edited (§10.4.5)              → candidate → check → review → stack.propose → wait
            steer / changes requested     → implement → candidate → check → review → stack.propose → wait
            merged | dropped              → end
```

`stack.candidate` and `stack.propose` are system operations (§10.4.4). With the rebase (§10.5) and the merge (§10.6), they are the stack engine's part: capture the candidate on the item's prefix, accept its evidence, open or update the PR, and later merge after a person's approval. None of those are flow steps, so an override can't skip them. A refused `stack.propose` sends the run back to `candidate`, or to `implement` for `stale_inputs`. This replaces today's four separately launched runs (`coding/request`, `coding/vibe`, `coding/verify` and `review/change`, launched at `mythical_items.go:1681`, `:1775`, `:1905` and through `mythicalReviewFlow`) with one run per attempt (T-FLW-11).

10.4.1a The built-in `todo` flow is a short composition file over step flows published from the coding package. Overriding it (§11.5) copies only that composition into `flows/todo/flow.ts`, which imports the steps it doesn't change.

10.4.2 The prompt the agent receives is revision 1, plus every later revision delivered as a steer, plus the acceptance text, plus, when the TODO came from an issue, the issue context admitted with revision 1 (§10.2.1a), as quoted data marked with each author. Later issue comments never reach the run. Check: C-SEC-03.

10.4.3 Evidence recorded per attempt, each entry tagged with the candidate generation it describes (§10.4.4): the diff stat, checks run on the machine (name, outcome, duration, log blob), the agent's review summary, GitHub checks, the token and time totals, and the flow version. The PR body and the TODO card show the accepted generation's entries. A review summary from an earlier generation is shown only when that generation's own diff has the same `git patch-id --stable` as the accepted one, as after a clean rebase.

10.4.4 **Candidate handshake.** A candidate is an immutable commit of the item's working copy, and each one is a new **generation** of the item. The engine keeps the current generation on its work record: today's `mythical_items.generation`, `candidate_base`, `candidate_head`, `candidate_verified` and `pr_head`, plus a new `candidate_inputs_seq`. Recording a generation voids the verification of every earlier one, the invariant today's engine keeps when integration clears `candidate_verified` and re-verifies (`mythical_items.go:1901`). The handshake has three steps: `stack.candidate` and `stack.propose` are system operations with Appendix C rows. They have no slash, CLI or agent door and are absent from `/help`. T-ACC-03 maps them in its route→action table and admits only run and machine credentials. Checks: C-STK-06, C-ACC-01, C-CAT-01.
1. **Capture.** The run's `candidate` step calls `stack.candidate{inputs_seq}`. inputs_seq is the highest todo_events.seq in the owning run's durably acknowledged contiguous prefix of this item's work inputs: steers, amendments, member review comments delivered as steers, and answers delivered to the run. Zero denotes no such consumed input. DecideCandidate refuses invalid_inputs_seq (class conflict, no generation or effect) if the value is negative, above this item's committed event high-water mark, names a non-input event, exceeds the acknowledged input prefix or is below the previous generation's inputs_seq. A new attempt inherits the item's input history and must acknowledge it before advancing this cursor. Other items' events and this item's activity/state/check events do not advance the input cursor. Propose and Merge pending-work checks include unconsumed run answers in the same way as steers and amendments. Checks: C-STK-06, C-STK-07. The engine refuses with `rebase_pending` while the item has `rebase_pending`, or when its prefix head (§10.3.2) isn't an ancestor of the working-copy commit, in which case it sets `rebase_pending{onto: prefix head}`; the run then waits for the `rebased` signal (§10.5). Otherwise it captures the working copy (S1: a jj snapshot in the workspace and a push of its commit to the host store; from S2: `capture()`, §9.1.2). It writes one commit C whose tree is the snapshot's tree T and whose parent is the prefix head, pins it (`refs/smithers/keep/<C>`) and records generation g = {base: prefix head, head: C, tree: T, inputs_seq}. C is the item's one commit; the working copy's own history is never rewritten.

10.4.4a [S1] NextGeneration returns the persisted receipt for a replay of the same actor-scoped operation key and canonical request, or the next strictly increasing item generation for a successful new Candidate invocation. Record the generation, void earlier verification and store its receipt atomically; a crash after commit returns that generation on replay. Equal tree, base and inputs do not deduplicate distinct invocation keys. A key reused with a different request returns idempotency_mismatch under §6.2.1. Starting or retrying an attempt allocates no generation; the first successful new Candidate continues the item's sequence. Before the generation transaction commits, a failed invocation may leave a pinned orphan but no allocated generation. Checks: C-STK-06.

10.4.4b [S1] After prefix and input validation, DecideCandidate compares the captured tree with the selected prefix tree. Equality refuses empty_change (class conflict), before candidate commit pinning, generation allocation or verification changes. An item that merely carries earlier items' changes is likewise empty. The refusal records no generation or outbound write. The owning flow separately opens one durable question wait with code empty_change and prompt “T<n> has no change of its own” (product copy, 2026-10-02), deduplicated by invocation, and enters needs_you under §10.8; answering resumes implement, and Drop follows §10.7.2. Never classify an empty TODO as merged without GitHub merge truth. Checks: C-STK-06.
2. **Check and review.** The run's `check` step runs the configured checks in the working copy. The `review` flow reads the candidate's own diff (`base..C`), never the working copy. Every evidence entry carries g.

10.4.4c [S1] Repository checks must leave the captured tree unchanged. Capture before and after each machine check; when it changes the tree, record that check failed with code check_modified_tree and its changed paths, shown as “Check changed files: <paths>” (product copy), preserve the resulting files, and fail the check step visibly. Do not accept Propose, push a new PR head or automatically retry an edited→candidate loop for that failure. The run may explicitly apply a formatter or generator in implement before a fresh Candidate; verification then reruns without write modes. Ordinary concurrent edits still yield edited and are not attributed to the check without writer evidence. If the writer cannot be determined, report the changed-tree check failure without claiming attribution. No retry cap or reverted-edit detection is introduced. Checks: C-STK-06.
3. **Propose.** The run calls `stack.propose{generation: g, evidence}`. The engine captures the working copy again and accepts only when all of these hold:
   - g is the current generation;
   - the new capture's tree equals T, so no edit landed during the capture, the checks or the review;
   - no steer or amendment event has a seq above g's `inputs_seq`;
   - the item has no `rebase_pending`, its prefix head is still g's base, and `main`'s tip is still g's recorded main base (else refuse `stale_base`; QA S5);
   - every check entry in the evidence names g.

   On acceptance the engine sets `candidate_verified`, writes the PR head commit (tree T, whose parent is g's recorded main base, never a `main` tip read later; §12.5.1), pushes it and opens or updates the PR. On refusal it records nothing and returns the reason: `stale_generation`, `edited`, `stale_inputs`, `stale_base` or `rebase_pending`. Each refusal has its named `code` and class `conflict`. `rebase_pending` also carries `onto`, the required prefix head. Check: C-STK-06.

10.4.4d [S1] For a fresh Propose call, DecidePropose returns the first applicable outcome in this order: todo_closed for a merged or dropped item; Defer for a set merge fence; stale_generation; stale_inputs; rebase_pending; stale_base; edited; invalid_evidence; Accept. All refusal codes have class conflict and no generation, event, acceptance or outbound write. invalid_evidence covers missing or mismatched generation tags on any submitted evidence entry and a missing result for any configured machine check; failures remain results and do not by themselves violate generation binding. Zero check results are legal only for an explicitly known empty configured machine-check set. Unknown configuration refuses invalid_evidence. stale_inputs routes to implement; base refusals wait for reconciliation/rebase; invalid_evidence reruns check/review on the current generation; todo_closed ends the run. DecideCandidate likewise returns todo_closed before fence deferral for a fresh call. Checks: C-STK-06.

An item's **verified head** is C of its latest accepted generation. Accepted limit: an edit reverted before the propose capture leaves the trees equal and goes unseen. Check: C-STK-06.

10.4.4e [S1] Persist last_accepted_generation and its immutable head and manifest separately from current_generation and candidate_verified. Recording a new generation clears merge verification and approvals but does not erase last_accepted_generation. SelectPrefix may use that head while newer work is checked, provided its manifest and main base remain valid for the current stack and it has no pending rebase. A new Propose acceptance replaces that pointer and RebaseFanout writes each later item's required rebase in the same transaction; recapture alone does not publish a prefix head. Checks: C-STK-06, C-STK-07.

10.4.5 **Pending work.** [S1] Every branch capture carries an engine-issued capture_epoch and a monotonically increasing capture_seq assigned at capture time by the single branch capture authority, shared by Candidate, Propose and periodic reports. A new authority epoch is issued only after fencing the previous writer and obtaining a fresh capture; ordering survives restart. PendingWork ignores older epochs and lower sequences; an exact replay has no effect, and reuse of the same epoch/sequence with a different tree refuses capture_mismatch (class conflict). A report without valid ordering refuses invalid_capture (class conflict) and cannot establish newest capture or clear pending work. In one transaction, store each valid newer capture's tree in every TODO state and, only for in_review with a last accepted generation and a transition to a different non-accepted tree, enqueue one keyed edited signal. In other states, including working, merged and dropped, emit no edited signal. Merge row 7 uses that ordered newest capture, regardless of the state in which it was stored; capture unavailability cannot satisfy that row. A steer or amendment moves the TODO to working instead (§10.7.3). Checks: C-STK-06, C-STK-07.

10.4.5a [S1] PendingWork deduplicates by the immediately preceding valid ordered capture tree, not a lifetime set of signaled trees. For an eligible in_review item with accepted tree T, X1, X1, T, X1 emits edited twice; X1, X2, X1 emits three times. Observing T resets the comparison even though it emits no signal. Acceptance establishes a new baseline. Checks: C-STK-06, C-STK-07.

### 10.5 Rebase

10.5.1 When `main` or an earlier item publishes a new revision, or the stack is reordered, an earlier item is dropped, or an earlier item is amended, every later item gets `rebase_pending{onto}` (QA S8). A candidate is also refused as `rebase_pending` when its working copy contains commits from any item outside its current prefix chain (for example T4 moved above T3 while its working copy still holds T3).

10.5.2 If only the coding agent is present on the branch, the rebase runs at the run's next durable boundary. If people are present, the branch shows "Rebase pending". The rebase then runs when presence drops to the agent alone, or when someone on the branch selects **Rebase now**.

10.5.3 The rebase follows §9.4. Afterwards it posts activity "Rebased onto Tk" and signals the run `rebased`. The run captures a new generation and re-runs checks (§10.4.4), and the new generation voids earlier approvals (§10.6.2c). A clean rebase reruns checks only. Agent-resolved conflicts are new work: implement → candidate → check → review → stack.propose. Checks: C-STK-06, C-STK-07.

10.5.3a [S1] A successful rebase changing the base or prefix manifest requires a distinct Candidate invocation and therefore a new generation, even if the captured tree equals the previous generation's tree. RebaseFanout records required per-item onto facts atomically with the triggering stack transition; it does not allocate generations. Until rebase and the new Propose acceptance complete, Smithers Merge stays held. Re-run all configured checks for the new generation; review summaries may be reused only under §10.4.3's own-diff patch-id rule. Earlier generation approvals are void and cannot be rebound by tree equality. Empty own changes still follow the empty_change rule. Checks: C-STK-06, C-STK-07.

10.5.4 A conflict goes to the coding agent first. If the agent doesn't resolve it within its policy (one attempt by default), the TODO enters `needs_you{kind: conflict, paths}` with **Resolve**. In stage 1 Resolve opens the TODO card's conflict view (conflicted files, terminal and SSH line); from stage 2 it opens the Branch card. The wait settles when someone presses **Done** and the working copy has no conflict markers in those paths. An engine-raised conflict creates its own durable wait on the TODO.

10.5.5 Asleep branches rebase on the host against their captured head, without waking. A conflict wakes nothing; it becomes Needs you.

### 10.6 Merge [S1]

10.6.1 Merge is enabled for exactly the first unmerged item in stack order. Later items show "Merges after Tn". Smithers enforces the order. GitHub doesn't, because every PR is based on `main` (§12.5).

10.6.2 `POST /api/todos/{n}/merge {reviewed_head_sha}` requires a `session` credential with role owner or maintainer, and `MergeReady` (§10.6.2a) under the merge fence (§10.6.2b). The server records `todo_approvals` with the generation and `reviewed_head_sha`, then calls GitHub's merge API with `sha = reviewed_head_sha` and `merge_method = squash`, so each item is one commit on `main`. Setup refuses a repository that disallows squash merging and shows "Enable squash merging on GitHub ↗". A refusal surfaces GitHub's reason text verbatim, for example "1 approving review required on GitHub". After authorization succeeds for execution or eligible confirmation creation, `reviewed_head_sha` must be a string of exactly 40 hexadecimal characters; normalize it to lowercase. A missing, empty or malformed value returns HTTP 400, class `user`, code `invalid_reviewed_head_sha`, message `reviewed_head_sha must be a 40-character hexadecimal commit SHA`, before any confirmation, fence, approval or outbound merge row is created. A well-formed value differing from the PR head fails row 8 with `stale_head`. A definitive refusal from GitHub's merge endpoint returns its HTTP 405, 409 or 422 status in the §6.2.3 envelope with class `github`, code `github_refused`, and GitHub's `message` verbatim. If the response may mean the PR is already merged, look up the PR before treating it as a refusal: a confirmed merge settles the outbound row `done`, returns HTTP 202 with `{state: requested}`, and projects completion only after `main` contains the commit. A timeout, reset or response that cannot establish whether the write took effect leaves the outbound row `unknown` and follows §12.4.1b, rather than clearing its fence as a definitive refusal. Checks: C-STK-04, C-STK-07, C-ACC-02.

10.6.2a **One merge predicate.** `MergeReady(todo, reviewed_head_sha)` is the only definition of merge readiness. The Merge control's `merge_block`, the merge route, the approve of a Review & merge confirmation (§5.4) and the recheck before dispatch all call it. It holds when every row holds, and the first row that fails gives the reason:

| # | Condition | Reason |
| --- | --- | --- |
| 1 | The TODO is `in_review` (§4.1.0a): no open wait, `paused_at` unset | `state` |
| 2 | It is the first unmerged item in stack order | `order` |
| 3 | No `stack_attention` row is open | `attention` |
| 4 | No merge fence is set (§10.6.2b) | `merging` |
| 5 | The current generation is accepted (`candidate_verified`), its PR push is settled (`pending_op` empty) and `pr_head` is set | `rechecking` |
| 6 | No `rebase_pending`, and the generation's base is the mirror's `main` tip | `rechecking` |
| 7 | No pending work: no unconsumed steer, amendment, member review comment delivered as a steer, or run answer above the generation's `inputs_seq`, and the branch's valid ordered newest capture has the generation's tree (§10.4.5); capture unavailability does not satisfy this row | `pending_work` |
| 8 | `reviewed_head_sha` = `pr_head` = GitHub's current PR head | `stale_head` |
| 9 | Required GitHub checks pass on that head, required reviews are satisfied per GitHub branch protection, the PR is not draft, and GitHub affirmatively reports it mergeable | `checks`, `review_required`, `github` |

Rows 1-7 read PostgreSQL; rows 8-9 read GitHub, and `merge_block` uses the last synced PR head and checks for them. `merge_block` is `{reason, detail?}`, with Tn for `order`, the check's name for `checks` and GitHub's text for `github`. Check: C-STK-07. For merge readiness refusals, zero GitHub calls means zero calls to the merge endpoint (`PUT /repos/{owner}/{repo}/pulls/{number}/merge`); the reads required by §10.6.2b are permitted. Authorization refusals do not start readiness reads or create a fence, approval or outbound merge row. Row 9 first evaluates required checks: a failed or pending required check returns HTTP 409, class `conflict`, code `checks`, with its name as detail and message. If several checks block, choose the first by bytewise check name, then stable GitHub check identifier. Only after required checks pass does a known non-mergeable PR return HTTP 409, class `github`, code `github`; any GitHub reason text is preserved verbatim. If no reason text is supplied, detail and message are `GitHub reports this PR is not mergeable`. `DecideMerge` is the shared decision function for the merge route, the viewer's `merge_block`, Review & merge confirmation approval, and dispatch or recovery rechecks. It applies the catalog authorizer and then the single `MergeReady` predicate; eligible delegated creation yields Confirm without executing a merge. The caller supplies synced facts for projection and live facts for dispatch. At rows 8–9, a required fact that has never been synced or whose stream is not fresh under §12.2.3 returns HTTP 409, class `conflict`, code `rechecking`, detail and message `Waiting for fresh GitHub merge facts`. Unknown required-check configuration is not an empty required-check set. Earlier failing rows retain priority; known facts use the normal row reasons, including the known-null rule. At row 1, when the supplied PR lifecycle fact is known and closed unmerged, refuse with HTTP 409, class `conflict`, code `state`, detail and message `PR is closed on GitHub`; do not fall through to head or check failures. A live recheck that discovers this fact clears its fence and submits the same inbound close transition used by polling (§12.3), without a merge PUT. A PR reported merged is reconciled as a merge fact, not classified as closed unmerged; completion still waits for its commit on `main`. Earlier authorization failures retain priority. Row 9, after required checks pass, requires the PR not to be draft, including when GitHub's `mergeable` field is true. A draft PR returns HTTP 409, class `github`, code `github`, with GitHub's supplied draft refusal text verbatim, or detail and message `PR is still draft on GitHub` when none is supplied; no merge PUT is sent. This check precedes other mergeability evaluation within row 9. The normal first-item ready transition (§12.5.1) runs through §12.4; Merge and confirmation approval do not change draft state themselves, and a refused confirmation remains pending under §10.6.2c. Checks: C-STK-04, C-STK-07, C-ACC-02. Within row 9, evaluate required checks, required reviews, draft state, then mergeability. Unsatisfied required reviews return HTTP 409, class `conflict`, code `review_required`, with detail and message `Required reviews are not satisfied on GitHub`. Role is enforced by the catalog authorizer (T-ACC-03), never by `MergeReady`. A `review_required` block links to the PR. Checks: C-STK-07, C-ACC-01.

10.6.2b **Merge fence.** A merge runs in three steps:
1. One transaction locks the stack row (`mythical_stacks`, `FOR UPDATE`), then the TODO row, evaluates rows 1-7 and sets `todos.merging = {generation, head, by, at}`. Every stack mutation takes the same locks in the same order and reads `todos.merging`: place, amend, move, drop, steer, answer, admission, `rebase_pending` writes, `stack.candidate`, `stack.propose` and the fold after a merge.
2. Before dispatch, outside the transaction, the server rechecks: a fresh capture when the branch's machine is awake (row 7; an asleep branch's captured head is final), `main` by `git ls-remote` (row 6), and the PR head, required checks and mergeable state from GitHub (rows 8-9). A failure clears the fence and returns its reason. If GitHub reports `mergeable: null`, re-read the PR once after 2 seconds. If it is still null, refuse with HTTP 409, class `github`, code `github`, and detail and message `GitHub is still computing mergeability`; clear the fence and send no merge request. Re-evaluate rows 8–9 against the second read, including checks for its head. After live reads and immediately before claiming dispatch, `DecideMerge` rechecks the approving person's credential eligibility, current membership and role, and confirmation ownership where applicable; it never treats a stored approval as current authorization. The dispatch claim serializes with role changes and credential revocation, so a downgrade or revocation committed first sends no PUT, clears this operation's fence and returns the applicable permission or unauthenticated refusal. It records the reason any existing approval is no longer usable. A change committed after the claim cannot cancel a sent GitHub request; its outcome is reconciled as usual. Recovery applies the same check to the recorded person and bound authorization, without minting a session. Checks: C-STK-04, C-STK-07, C-ACC-02.
3. The server records `todo_approvals` and calls GitHub's merge through the outbound path (§12.4.1). A definitive GitHub refusal clears the fence and retains the approval receipt (§10.6.2c). Success keeps the fence until the `merged` transaction clears it. At boot, reconcile fences and their pending or unknown outbound rows under §12.4.1b before further dispatch; a confirmed merge keeps its fence until `merged` commits. Check: C-STK-07.

While a fence is set:
- A placement that changes the item's position (Before, Move, Drop) and an amend of the item get `409 {code: merging}`.
- A steer or a member's review comment for the item commits and is held. If the merge completes, it stays recorded and undelivered. If the fence clears without a merge, it is delivered then, with its usual transition (`in_review → working`).
- `rebase_pending` for the item and `stack.propose` for the item wait until the fence clears. stack.candidate also waits while the item's merge fence is set. DecideCandidate returns Defer before capture, pinning, generation allocation or verification changes; waiting does not hold database locks. After the fence clears, a fresh call reevaluates all facts: a merged or dropped item refuses todo_closed, otherwise the normal candidate decision applies. Deferred operations never clear or replace the fence; inbound confirmed merges retain §10.6.2b's exception. Checks: C-STK-06, C-STK-07.
- "A merge is in flight" for `smthrs host upgrade` and quiesce (§16.4, §16.5) means a set fence. A GitHub merge confirmed on `main` is an exception to fence deferral: its inbound transition and containment fold take the stack lock and TODO locks in the usual order, apply even across a set fence, and clear fences for items actually marked merged. The dispatch claim and this fold serialize on those locks. A fold that wins before dispatch makes the unsent merge row `superseded` and sends no PUT; a dispatch that wins may finish but its result cannot revert or repeat the inbound transition. An already-sent row remains subject to target serialization and lookup until settled, even after the TODO fence clears. The originating request returns HTTP 202 with `{state: requested}` if the target is proven merged by the fold; otherwise it returns its normal decision or GitHub refusal. Held inputs remain recorded and undelivered for merged items. Checks: C-STK-04, C-STK-07, C-ACC-02.

Limits: a write to the working copy after step 2's capture isn't in the merge; it stays in the branch's final capture (§8.12). GitHub's merge API has no base precondition, so a `main` move on GitHub after step 2's `ls-remote` lets GitHub squash the reviewed head onto the newer `main`. Check: C-STK-07.

10.6.2c **Approval binding.** A `todo_approvals` row and a Review & merge confirmation's subject revision (§5.4) both bind the generation and the PR head. A new generation voids approvals, and a new generation or a different PR head on GitHub expires a pending confirmation. An approve that `MergeReady` refuses leaves the confirmation pending until it expires. A TODO that returns to working keeps its PR open and ready, so GitHub may still merge its last proposed head (§4.1). Check: C-ACC-02. A recorded session approval is retained after a definitive GitHub refusal, with an activity receipt naming its generation, head and failure; clearing the fence does not erase it. A Review & merge confirmation remains pending after such a refusal unless its revision or lifetime has expired; it becomes approved only when GitHub confirms the merge. A retained approval is not permission to retry a definitively refused merge automatically: retry requires another explicit eligible session press and a fresh `DecideMerge`. Reconciliation of a pending or unknown dispatch follows §12.4.1b. Voiding an approval because work, generation or head changed records why it was cleared before removing it from the active approvals; a head change expires its pending confirmation. Checks: C-STK-04, C-STK-07, C-ACC-02.

10.6.3 After the merge, later items rebase onto the new `main` (§10.5), and each open PR is force-updated with that item's next accepted generation (§10.4.4). Its body then stops listing the merged item.

10.6.4 An out-of-order merge on GitHub happens when someone marks a later draft ready and merges it first. The engine marks the merged item merged, and marks merged only those earlier unmerged items whose verified head the merged generation's recorded included-items list contains (QA S6). Any other earlier item gets `rebase_pending` onto the new `main` (and `stack_attention{kind: order}` per the rest of this paragraph); its unmerged work is never marked merged. It notes on each earlier one "T3 merged before T2; T2's change is in T3's commit" and closes each earlier item's open PR with the comment "Merged via #<n> (T3)". It then folds `main` and opens `stack_attention{kind: order}` for maintainers with that sentence, settled by **OK** (in-card). Later items rebase as after any merge. For one out-of-order merge containing several earlier items, create one order attention entry for that merge event. Its text joins, with a newline, one sentence per contained earlier item in pre-fold stack order: `Tk merged before Tj; Tj's change is in Tk's commit`. Each earlier item's note contains only its own sentence, and each open earlier PR receives `Merged via #<n> (Tk)` once. A stack has at most one open `order` attention row. Each new out-of-order merge appends an event entry to that row, deduplicated by PR identity and merge commit, and increments its revision; entries preserve application order and each entry's sentences follow pre-fold stack order. OK requires an eligible maintainer session and the displayed attention revision. If an entry arrived after that revision, return HTTP 409, class `conflict`, code `stale_attention`, keep the row open and show its current entries. A duplicate poll appends nothing. Containment is proved from the PR head actually merged, fetched from GitHub, matched to the persisted accepted-generation PR head and its immutable prefix manifest of item identities, generation heads and changes. That manifest must record which changes are present in that candidate, not merely which items preceded it. The reported merge commit must also be present on `main`; squash ancestry alone is not evidence of earlier-item containment. If the merged head does not match a retained accepted head, the manifest is missing, or inclusion of an earlier change cannot be proved, do not mark that earlier item merged, close its PR or close its issue. Mark the directly merged PR's TODO merged once its merge commit is on `main`, fold the mirror, and add an order attention entry `Tk merged out of order; containment of Tj is unverified` for each unproven earlier item in pre-fold stack order. Proven contained items still fold normally. Later rebases continue under §10.6.3; Smithers merges remain blocked by the attention. Missing head evidence is retried by polling; an ambiguous head is never guessed to contain another item's work. Every item marked merged by a proven containment fold receives the ordinary merged effects, including closing its linked issue only when `fixes_issue` is true. The closing comment links the PR and commit that actually landed its change and names `Merged via #<n> (Tk)`. Issue-close and comment writes use §12.4's durable deduplication; duplicate polls create no additional writes. An external merge or containment fold never creates a `todo_approvals` row. Checks: C-STK-04, C-STK-07, C-ACC-02.

### 10.7 Stop, resume, retry, drop, steer

10.7.1 Stop: send a durable pause signal; the run parks in a `paused` wait at its next durable boundary (an in-flight model call finishes first, ≤ 60 s), the TODO shows `paused`, and the machine is released when safe-idle. The run is not cancelled. Stop is refused while a `question` or `approval` wait is open; an open branch wait doesn't refuse it (§4.1). Resume re-admits and continues the same run from its last finished step, and the TODO turns working when the coding host reports the run attached (§4.1). Retry starts a new attempt of the pinned flow version (Retry with the current flow pins the Active one, §4.1); an optional steer becomes the first message.

10.7.2 Drop: confirm, cancel the run, take a final capture, close the PR with comment "Dropped in Smithers by @x", mark `dropped`, archive the branch, fold the item's change into the first later TODO forked from it (§8.5.3a), and rebase later items. The attempt closes with outcome `dropped`, and its last accepted generation stays on the record for a reopen (§10.7.4). Check: C-J7-02.

10.7.2a The coding agent can ask a person mid-implementation. The `ask` tool is bound for the implementing seats (`coding/edit-atom`, `coding/dispatch-turn`), not only at flow-step boundaries. It raises `needs_you{kind: question}` as a durable wait and continues with the first answer (§10.8.2).

10.7.3 Steer: any member, or an agent acting for one. The text is delivered to the run as a durable signal. Steer is `agent: run`: an agent steers at once for its person, with `via` recorded. A steer never settles an open question: while `needs_you{kind: question}` is open, Answer is the primary action, and the steer reaches the agent at once as context. The agent may replace its question with a better one, but the question stays open until a person answers (mvp.md §4.1). A steer to a queued TODO is held and delivered when its run starts; one to a paused TODO is delivered on resume; one to an in_review TODO moves it to working. The run's flow MUST accept steers at every step boundary, and inside the implement step between agent turns (≤ one model turn of latency). The steer appears in branch activity with its author's avatar. A steer to a starting TODO is held and delivered when the run's first step starts, like one to a queued TODO. A steer to a failed TODO is **Retry with that steer** (mvp.md: Failed offers Retry, steer or drop): it starts a new attempt with the steer as its first input (§4.1 failed → queued). A steer to a merged or dropped TODO is refused with `todo_closed`. Check: C-STK-01.

10.7.4 Reopen (§12.3): a PR reopened on GitHub within 7 days of its TODO's drop returns the TODO to in_review, once per reopen event, with no live run. The attempt the drop closed stays closed, and its last accepted generation is the TODO's candidate again; if it still satisfies `MergeReady`, it merges as is. The first input that needs work starts a new attempt as Retry does (§10.7.1): a new run of the dropped attempt's pinned flow version from its first step, with that input as its first message. Such inputs are a steer, an amendment, a member's review comment, `rebase_pending` and pending work (§10.4.5). The machine wakes from its disk, or from the branch's final capture when cleanup removed the disk (§8.12). Check: C-J10-08.

### 10.8 Needs you

10.8.0 **Waits.** Each reason a TODO needs a person is its own durable wait: one `todo_waits` row `{wait_id, kind, owner: run|branch, payload, run_wait_id?, opened_at, settled_at?, settled_by?, outcome?}`. Run waits (`question`, `approval`) belong to the attempt's run and expire when that run ends. Branch waits (`conflict`, `moved_off`, `foreign_push`) describe the branch and stay open across attempts, Stop and Resume until resolved. Merge and drop close every open wait in their own transaction (§4.1). Precedence and the primary wait: §4.1.0a. Check: C-STK-08.

10.8.1 TODO kinds: `question` (the agent asked), `approval` (a flow step's human approval), `conflict` (§10.5.4), `moved_off` (§9.3.8), `foreign_push` (§12.3). Stack-level kinds, `order` (§10.6.4) and `force_push` (§12.3), live in `stack_attention` (§4.1.2a).

10.8.1a A planner that declines with questions (today's `declined` with questions) raises `needs_you{kind: question}` and waits, instead of ending the item.

10.8.2 First answer wins. Answers carry the wait id. The first committed answer settles the wait, and later submissions get `409 {answered_by}`. A late submitter's text stays in their draft with **Send as steer**.

10.8.3 Toasts go to the TODO's owner and, from stage 2, to anyone present on its branch (stage 1 has no presence). Everyone else sees it on the Home card (M-14).

---

## 11. Flows [S1]

### 11.1 Catalog

11.1.1 **System flows** are packaged with the install and never overridable: stack operations (including `stack.propose`), merge, members, settings, secrets, sync, admission, setup, `flow-load` and the summarizer (M-30). They run in the host flow runtime or as Go services exposed as commands, except `flow-load`, which loads repository code and so runs in an ephemeral machine (§11.3.1). Check: C-SEC-02.

11.1.2 **Overridable flows** are `todo`, `learning`, `review`, plus any repository flow at `flows/<name>/flow.ts`. Each has a built-in default version shipped with the install. A repository file of the same name, on `main`, overrides it once Active. Overridable flows always run inside a machine (§1.3).

11.1.3 Every flow is `Flow.make("<name>", {description, payload, success, error?, body, ...})` from `@smthrs/flow` (AGENTS.md "Flow layering").

### 11.2 Configuration without a commit (M-11)

The install generates and stores the configuration the default flows need in `flow_config`. Stored with it: the detected check commands (`package.json` scripts `test`/`lint`/`typecheck`/`build`; `go test ./...`; `cargo test`; `pytest`), the default wiki page declaration and model seats. All of it lives in PostgreSQL, not in the repository. A repository's own `.smithers/*` configuration, when present on `main`, takes precedence field by field. Planning needs at least one check. Today's two-check minimum (`flows/coding/planning.ts:38`) becomes one. A repository with no detected check runs a build-only check and says "no checks detected" in the PR evidence. The default wiki pages are an overview, an architecture page and one page per top-level package directory, at most 10.

### 11.3 Loading and activation

11.3.0 A flow's closure is every repository file its entry reaches: relative imports, imports a loader maps to repository files (package.json `imports`, tsconfig `paths`), workspace packages, and every overridable flow it imports. Any import that resolves to a file inside the repository is a closure module, whatever its specifier. So a `todo` run's one digest also pins the `review` flow it calls (J5.4) and every helper it imports from anywhere in the repository. The closure's dependency environment is the installed third-party packages its modules import, identified by the lockfile digest (`ExecutionSnapshot.ts:59-65`). `@smthrs/*` packages come from the coding host the install ships. A version's digest covers the execution digest and that lockfile digest, so a lockfile change makes a new version.

11.3.1 Every `main` move admits a background `flow-load` run in an ephemeral machine at `main`'s new commit, whatever paths changed, because a closure can import any repository file and the lockfile. Loads coalesce: at most one runs at a time, and when it ends the next starts at the newest `main` commit not yet loaded, skipping the commits between. The run loads every overridable flow, typechecks it and computes its digest (§11.3.0). For a new digest it stores a content-addressed closure blob that holds the closure modules and the dependency environment's packages, stored per file so versions share unchanged files, and writes one `flow_versions` row with status `loaded` or `failed{error}`. A digest that already has a row writes nothing (check C-J5-02).

11.3.2 Activation: a `loaded` version from a newer `main` commit replaces the Active one in `flow_activations`. A `failed` version leaves the previous Active version in place, and the Flow card shows "Merged · not active" with the error (§4.3).

11.3.3 The Flow card's "Proposed" version is any open TODO whose change touches `flows/<name>/`.

### 11.4 Pinning

11.4.1 A run records `(flow_name, digest)` when its TODO enters Starting. The coding host on the branch machine loads the pinned closure blob by digest. It never loads the branch working copy's `flows/` for a TODO run, so a TODO that edits a flow doesn't run its own edit. It never resolves the closure's imports from the working copy either. Closure modules come from the blob, and third-party packages from the blob's dependency environment, unpacked once per machine under `/var/lib/smithers/flow-env/<lockfile digest>`. Restore checks the lockfile digest against that environment, never against the working copy (`ExecutionSnapshot.ts:138-142`). A TODO that edits an imported helper or the lockfile, or rebases onto such a change, still runs its pinned version, and its Retry and Resume restore that version unchanged (check C-J5-01).

11.4.2 Retries and resumes reuse the pinned digest. Two versions of one flow can run at once because each branch machine runs its own coding host.

11.4.3 A scratch branch may **Run** its working-copy version of a flow with a test input (J11.3). That run is labeled "draft version" and can't be a TODO run. **Plan** on a scratch branch loads the working-copy version inside that branch's machine and returns its graph without running a step (§1.3); for the Active version it reads the stored `flow_versions` steps (§11.3.1). A draft-version run of `todo` ends before `stack.propose`: the stack engine refuses a run with no TODO (`not_a_todo_run`), so the run ends there, proposing nothing and writing nothing to GitHub. Check: C-J11-02.

### 11.5 Changing the factory (J5)

`/flow.edit <name> <request>`: the app agent produces a patch against the current source of `<name>`. If no repository override exists, the patch creates `flows/<name>/flow.ts` from the built-in composition plus the change (§10.4.1a). The Flow card shows the proposed diff first (J5.2). **Make TODO** creates a TODO with that patch as its `seed_patch`. If the seed patch no longer applies when the run starts, the agent re-derives the change from the request and says so in the evidence. The TODO flow applies the seed patch in its implement step, runs checks and opens the PR. Merging and activation follow §10.6 and §11.3.

11.5b **Source** on the Flow card (`/flow.source`) opens the flow's file in the File card on the branch of the TODO that proposes the change. If none exists yet, it first creates that TODO through `/flow.edit`, with an empty seed.

### 11.5a Agent card [S1]

The Agent card shows each factory agent (planner, implementer, reviewer, app agent): its model, a link to its instructions (the flow source), and the runs it took part in. The owner picks the model from the install's model access. The choice is an owner setting stored in `flow_config` (`agent:<role>`), not a TODO. It applies immediately, to every model call started after the change, including calls in runs already in progress; flow digests don't change. Three model roles are set in Settings and asked for in setup (J1):
- `fast` (Cerebras by default) for the app agent, preflight and timeline summaries;
- `coding` for the coding agent;
- `jev` through the AI Gateway for decisions.

Without a fast-model key, the app agent and summaries fall back to the coding model. The owner-only model configuration (`model.*` commands, `ModelCards.tsx`) is restored from `5b77095672` without the model laboratory (`ModelCallCard.tsx`, `controller/modelCall.ts` stay deleted). Instructions are Markdown in the repository: the TODO flow's prompts (beside its source) and `.smithers/instructions/app.md` for the app agent. The install loads them as data (never as code, §1.3) from Active `main`. They change through a TODO, and apply to work started afterwards. Tools and permissions change through the overridable flow's source. [D] Editing permissions, tools and budgets is deferred.

### 11.6 Runtime events and the monitor

11.6.1 The flow runtime emits ordered events per run: step started, finished or failed (with input, output and token/time/cost usage), wait opened or settled (kind, since), run attached (the coding host started or resumed the run on a machine; it moves a TODO from starting to working, §4.1), attempt retried, agent transcript chunks, and steer received. The host projects them into `run:<id>`, `todo:<n>` and conversation-entry summaries. Check: C-STK-03.

11.6.2 The monitor reads the same events. Each step's label comes from its Appendix C row's Inspect rendering (for example "Planned the change", "Edited retry.ts"). Engine bookkeeping tags render under one collapsed "Engine" row per run. It also shows the run's raw event journal, and the flow's declared custom view (the descriptor's `presentation`) when one exists. It shows the graph with live step states, per-step input/output/transcript, timeline with attempts, durable waits with "since", tokens/time/cost per step, and a read-only replay scrubber. It has no fork or rewind control (AGENTS.md).

11.6.3 **Phases and cells** (product ruling, 2026-10-02; mvp.md §6.14 Monitor). The monitor groups each attempt's events into phases, one per executed flow step instance, in order. Phase boundaries and titles are deterministic host code over run events: a title is the step's Appendix C label plus the outcome its recorded output reports (failed checks, files changed, findings), for example "Ran checks · 2 failed"; a step with no such outcome shows its label alone. Its tone is live, ok, fail, wait (an open durable wait) or thrash (§11.6.4). Each phase holds cells, one per agent action rendered by its mvp.md B.3 / Appendix C row: context, read, edit, run, think, ask, steer, reviewer or rebase. A cell carries a deterministic label ("Read retry.ts", "Ran pnpm test · 1 failed"), plus the code, output or quote it shows, and its time, tokens and actor. Under each phase title, `agent:fast` writes a one-line summary, and it writes an explanation for each cell an agent wrote. Both render marked as model summaries. They come from the timeline summarizer (§14.5.3) at phase and cell granularity and are stored in `run_summaries` (§3): debounced, written only for runs someone inspects, never blocking the run, using no machine. While one is pending or after it fails, the title or label stands alone, with no error state. The run's trailing wait for merge (§10.4.1) shows as state `held` with since. Each attempt keeps its own graph. Check: C-J11-01.

11.6.4 **Thrashing** (product, 2026-10-02; mvp.md §6.14). Within one attempt, a phase is thrashing when the same failing check fails 3 times with no edit in between to the files that failure names. "The same check" means the same test id, or the same error signature after normalizing paths, line numbers and other numbers. The detector is deterministic host code over run events, with no model. It sets the phase tone `thrash` and adds the TODO card indicator "Thrashing: <check> failed 3×". The indicator clears when an edit touches a named file or the check passes. It is information for a person and changes no run behavior. Check: C-J11-04.

### 11.7 Triggers

[D] Triggers are deferred (mvp.md §16). The engine and registrar stay as they are; the MVP neither exposes nor extends them. For the record, a trigger binds a flow to a schedule or an event:
- **Schedule:** five-field cron, an IANA timezone, and the next run time shown.
- **Event:** `main` moved, an issue labeled `<label>`, or a PR opened.

Maintainers create, pause and resume triggers, and **Run now** fires one. Runs triggered on `main` by a person or a schedule are trusted for main-only secrets (§8.8.2); event triggers from non-members are not.

### 11.8 Learning (§6.12, J5.5) [S3]

11.8.1 After each merge, the engine admits a background `learning` run with input `{todo}`. The run reads that TODO's attempts, check failures, review comments and steers, and the outcomes of the last 20 merged TODOs. It writes two kinds of output:
- wiki pages recording decisions with their reasons, each citing the change link and the run ids;
- proposals, each with a title, evidence (counts, TODO refs, failure signatures), a suggested prompt and an optional seed patch to a flow.

11.8.2 A proposal becomes a TODO only by a member's **Make TODO** (an in-card control, `POST /api/proposals/{id}/accept`). Dismissed proposals are kept for 90 days so the same signature isn't proposed twice.

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

12.1.3 The owner then installs the App on the one repository. The install records the installation id.

### 12.2 Polling (M-03)

| Stream | Request | Cadence | Requests/h, worst case |
| --- | --- | --- | --- |
| refs | `git ls-remote` of `main` and `refs/heads/smithers/*` | 30 s | 120 git, 0 REST |
| pulls | `GET /pulls?state=all&sort=updated&direction=desc&per_page=50`, conditional | 45 s | 80 |
| pr-state | One GraphQL query per 50 open TODO PRs: each PR's state, draft flag, head sha, mergeable state, last 20 reviews, and its head's `statusCheckRollup` contexts with name, status, conclusion and `isRequired` | 45 s | 80 per 50 PRs |
| review comments | `GET /pulls/comments?sort=updated&direction=desc&since=…`, conditional | 45 s | 80 |
| conversation comments | `GET /issues/comments?since=…`, conditional | 45 s | 80 |
| issues | `GET /issues?state=all&since=…&sort=updated&per_page=100`, conditional | 120 s | 30 |
| issue events | `GET /issues/events?per_page=100`, conditional, paged back to the durable event-id cursor (§10.2.1a) | 120 s | 30 |
| members' permission | `GET /collaborators/{login}/permission` | hourly | 1 per member |
| installation token | `POST /app/installations/{id}/access_tokens` | 5 min before expiry | 1 per permission set |

12.2.1 Every REST read is conditional (`If-None-Match` with the stored ETag). Each cursor stays at the newest `updated_at` or event id seen, so an unchanged stream repeats its URL and gets 304. A 304 doesn't count against the primary rate limit. GraphQL has no conditional form, so every `pr-state` query counts. A page beyond the first is fetched only when every row of the first page is newer than the cursor, and each page counts as a request. Installation tokens are cached until five minutes before expiry.

12.2.1a `pr-state` covers every open TODO PR in one query, so the checks and reviews of ten pending PRs cost the same 80 queries an hour as one PR, including after a merge force-updates every later PR. Per-head REST reads of check-runs and statuses would cost 120 requests per pending head per hour, 1,200 for ten, and are not used.

12.2.2 Budget. The host counts its GitHub requests per rolling hour, writes and Retry included, in two figures. Raw counts every REST and GraphQL request, 304s included. Charged counts REST responses other than 304, every GraphQL query and every write. The budget is at most 1,500 raw and 1,000 charged per hour (check C-GH-08). With ten TODO PRs and ten members, polling costs at most 392 requests an hour even when every response changed: 320 for the four 45 s streams, 60 for the two 120 s streams, 10 permission checks and 2 tokens. That leaves over 600 charged requests for writes, admission reads (at most two per label event, §10.2.1a), extra pages and Retry. When `X-RateLimit-Remaining` for a resource falls below 20 % of its limit, the issues, issue-events and members' permission cadences double until the reset; the other streams keep theirs. A 403 or 429 with `Retry-After` pauses that stream until `retry_at` and marks health `limited`.

12.2.3 Targets: PRs (state, reviews and comments), checks and `main` within 60 s of the change on GitHub, in the worst case: the 45 s cadence (30 s for refs) leaves 15 s for the fetch and the projection. Issues within 5 min (§9 of mvp.md). Measured by check C-GH-07. Health (§4.4) uses the required streams (refs, pulls, `pr-state`) against a 60 s target. When several states hold, `refused` > `limited` > `stale` > `fresh`. Only `mirror: pull` is supported for the install's repository.

12.2.4 Webhooks are optional. When the install has a public URL, a signed delivery triggers an immediate fetch of its stream. Webhooks never stretch a cadence, so a missed delivery costs no freshness. Webhook payloads are never trusted as the final state; the fetch is.

### 12.3 Inbound mapping

12.3.0 Every inbound GitHub fact has a defined outcome in every TODO state: a transition (§4.1), a recorded no-op (one activity row, no state change), or stack attention (§4.1.2a). A duplicate or stale fact (a merge or close for a TODO already merged or dropped, a repeated push, checks for a superseded head, a reopen while not dropped) is a recorded no-op, never a refusal or an error. A landed item over a dropped TODO never adopts a second TODO; it raises stack attention. Check: C-GH-13 (every fact × every state × first, duplicate and reordered delivery). The fact table is authored as `.specs/engineering/state/github-facts.tsv`. Pure `decideGitHubFact(fact, todo, item, now)` in `packages/backend/internal/services/github_inbound.go` returns exactly one `Decision{Events | Noop reason | Attention kind}` from this table and §4.1. T-GH-05 owns it; T-GH-04 and T-GH-06 consume it without private mappings. Item mutations derive from the decision, never the reverse. C-GH-13 proves every cell without PostgreSQL; each consumer proves its production path calls the function in a real PostgreSQL integration test.

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
| `main` rewritten (not a fast-forward) | `stack_attention{kind: force_push}` for the owner. **Reset to GitHub main** (`main.reset-to-github`, in-card) appears on the Needs you card. Only the owner's session may invoke it; agents cannot invoke it or request delegated confirmation. The owner confirms before it resets the mirror and rebases the stack onto the new `main`. Checks: C-CAT-01, C-ACC-01, C-J10-07. |
| Issue opened, edited or commented | The synced store updates (§3.0). The issue card updates. |
| Issue labeled `todo` | Admitted or reverted by the §10.2.1 table. An admitted TODO takes the first issue read after the label event as revision 1 (§10.2.1a). |
| Review with "changes requested", review comment or conversation comment on a TODO PR | Activity entry with the GitHub mark, attributed to the member whose GitHub login wrote it. From a member: delivered to the run as one steer per review submission (its comments batched, anchored to path:line) or per standalone comment; `in_review → working`. From a non-member: shown in activity as `{github: login}` and never delivered as a steer (§17.5). An edited comment updates its entry and is re-delivered only if the run hasn't consumed it; a deleted one hides its entry. |
| Review "approved" | Recorded on the PR card. Not a Smithers approval (§10.6). |
| Checks finished on a TODO PR head | Evidence updated. A failed required check names itself on the Merge control. |
| TODO PR merged | `merged` (§4.1). The linked issue closes with a link if `fixes_issue`. Later items rebase and their PRs are force-updated (§10.6.3). |
| TODO PR closed unmerged | `dropped` with "closed on GitHub by @x". Reopen within 7 days restores `in_review` at the TODO's previous stack position when it is still free (otherwise appended), with `smithers/<slug>` recreated at its last accepted generation's PR head and no run; the first input that needs work starts a new attempt (§10.7.4). Check: C-J10-08. |
| Push to `smithers/<slug>` by anyone other than Smithers | `needs_you{kind: foreign_push, by, sha}`, whether the TODO is working or in review: "Alice pushed to `smithers/retry-webhooks` on GitHub", linking the commit. Smithers never overwrites a person's commit (M-33): the agent's next push is held while this is open. A newer push while it is open updates it to name the newer sha, and every pushed commit is kept. The answers are:
- **Bring in**: the decision names the sha the card shows and is refused as stale (class `conflict`) once a newer push arrives. The stack engine fetches that commit and rebases the item onto it at the run's next checkpoint (§9.4); the agent resolves conflicts, and the pushed change becomes part of the item's change, attributed in activity;
- **Discard** (maintainers only, mvp.md B.4): explicit. The decision names the sha the card shows and is refused as stale (class `conflict`) once a newer push arrives. The commit is kept in the host repository store (`refs/smithers/kept/<sha>`) and linked from activity. The next verified push leases against that sha (§12.5.2). If the branch moved again before it, the lease fails, nothing is overwritten, and the Needs you reopens naming the newer sha. [D] Merging such pushes into the working copy is deferred. |
| A teammate's own branch or PR | `/review` works on any PR a member opened: it admits a `background` ephemeral machine at the PR head, which counts against capacity and never holds a TODO's machine, and it writes nothing to GitHub. A non-member's PR is refused (§17.5; outside-PR review waits for the maintainer release, mvp.md §8). Check: C-J10-09. [D] **Open on a machine** is deferred. |

### 12.4 Outbound writes

12.4.1 Every outbound GitHub write is recorded in `outbound_writes`, in its own committed transaction, before the call: open PR (title = TODO title), update the PR body, mark a PR ready or draft, push, merge, close a PR on Drop, close an issue on merge, add a label with the "Committed as Tn" comment, revert a label (§10.2.1), and comment. A row holds:
- `key` = `<kind>:<target>:<revision>`. The revision is the body digest for a body update, the intended head for a push, the reviewed sha for a merge, and otherwise the `todo_events` sequence, attention id or confirmation id of the action that asked for the write. A retry of one decision reuses its key; a new decision, attempt or action gets a new one.
- `target`, one PR, issue or branch ref, and `field`, the state the write sets: `state` (open or closed), `draft`, `body`, `label:<name>`, `ref` or `merged`. A comment has no field.
- `desired`, the value the write makes true, and `precondition`, the value Smithers saw when it decided. For a push, `precondition` is the remote head it leases against.
- `seq`, which orders the writes to one target.

12.4.1a Order and supersession. Writes to one target run one at a time in `seq` order. A write starts only after every earlier write to its target is settled: `done`, `superseded` or `conflict`. A request whose response doesn't arrive (a timeout, a reset or a crash) leaves its row `unknown`, and the next write to that target waits for reconcile. Recording a write for a target and field marks every earlier unsent row for that target and field `superseded`, and a superseded row is never sent. Comments and merges are never superseded.

12.4.1b Reconcile. At boot, and before the next write to a target, every `unknown` row for that target is looked up, never repeated blind (§19.2):

| Kind | Lookup | `done` when | Repeated once when | Otherwise |
| --- | --- | --- | --- | --- |
| Open PR | PRs for the head branch (`GET /pulls?head=…&state=all`) | one exists | none exists | |
| Comment | The marker `<!-- smithers:<key> -->` in the App's comments since the row's `created_at` minus 1 min | it is found | it isn't found | |
| Body | The PR body's digest | it equals `desired` | it differs and no newer body row waits | `superseded` |
| Close, ready or draft, label add or remove | The target's events since the row's `created_at` (issue events; the PR timeline for ready and draft), then its current value | an App event set `desired`, whatever followed it, or the value equals `desired` | no App event, and the value equals `precondition` | `conflict`: someone else changed it, §12.3 applies, and Smithers writes nothing |
| Merge | `GET /pulls/{n}` | it is merged | it is open, its head is the reviewed sha, and §10.6.2 still holds | `superseded`, and Merge returns to the card |
| Push | `git ls-remote` | the remote head is `desired` | the remote head is `precondition` | `conflict`, and `foreign_push` (§12.3) |

So a newer contrary action on GitHub, such as a person reopening a PR that Smithers closed just before a crash, is never undone by replaying the older write. Every settled row records how it settled (`response`, `event`, `state` or `lookup`), and each reconciled row writes one recovery receipt. Check C-GH-09. At boot, recover unsent `pending` merge rows as well as `unknown` merge rows. A pending row whose PR is already merged settles `done`; otherwise it sends its first request only with its existing bound session approval, current approving-member authorization and a fresh `DecideMerge` under a newly acquired or verified merge fence. If those conditions fail, settle it `superseded`, retain the approval's receipt and expose the current decision on the card. Before crossing the send boundary, durably claim the row as potentially sent; a crash after that claim recovers by lookup as `unknown`. An unknown row looks up the PR and, only if it is open at the reviewed head and the same authorization/readiness conditions hold, may repeat once as this table specifies. Recovery neither fabricates a new approval nor sends an approval with no outbound merge intent. Only the matching operation's verified fence is excluded from row 4 during its own dispatch/recovery decision; every competing fence still refuses with `merging`. The statement that merges are never superseded in §12.4.1a forbids supersession by newer queued writes, not the failed-precondition outcomes here or the external fold in §10.6.2b. Checks: C-STK-04, C-STK-07, C-ACC-02.

12.4.2 Writes are made as the App and attributed in the body ("Requested by @owner", "by @ben via Smithers").

### 12.5 Pull requests [S1]

12.5.1 A TODO's PR opens when its run reaches `in_review`. Head: `smithers/<slug>`. Base: `main`. Only the first item's PR is ready for review on GitHub; later items' PRs are opened as **drafts**. When an item merges, the next PR rebases onto the new `main`, holds only its own change and is marked ready (GraphQL `markPullRequestReadyForReview`). When an item stops being first (moved down, or an item placed before it), its PR returns to draft (`convertPullRequestToDraft`). GitHub offers draft PRs only on public repositories and on paid plans. Where drafts are unavailable, later PRs open ready, with the title prefix "[waits for Tn]" and the label `smithers:waiting`, and Smithers enforces the order. The head commit has the tree of the item's accepted generation (§10.4.4) on the generation's recorded main base: that base plus the immutable included-items manifest (§10.3.2a) plus this item's own change, each once. The body has the prompt (latest revision), acceptance, evidence (checks table, diff stat, review summary), the earlier stack items it includes ("Includes T3, T4 until they merge"), a link back and "Requested by @owner". The PR card in Smithers shows only the item's own change: the diff from the previous item's candidate to this one. Check: C-STK-06. If a person marks a later PR ready on GitHub without a stack-position change, sync its actual draft state and do not issue a corrective redraft merely because it is later. Smithers still enforces §10.6.2a's order and shows `Merges after Tn`. A subsequent change of position applies the ordinary ready/draft policy through §12.4, subject to its event and conflict reconciliation. If that later PR actually merges, apply §10.6.4. Checks: C-STK-04, C-STK-07, C-ACC-02.

12.5.1a [S1] The outbound invariant is that every PR head Smithers writes has the exact tree of a persisted accepted generation; GitHub need not display the current generation during recapture or push settlement. Keep the last settled pr_head distinct from the intended pending head and current generation. Smithers Merge remains held until the current generation is accepted and its push is settled. If GitHub merges the older displayed head, reconcile that actual merged head and commit under §10.6.4; do not infer containment from the newest generation or pending head. The directly merged TODO becomes merged once its merge commit is on main; newer unlanded work is preserved in the branch's final capture, not described as landed. No automatic second merge or fabricated approval follows. Checks: C-STK-06, C-STK-07.

12.5.2 The branch reaches GitHub when the PR is proposed and on every later verified update, with `--force-with-lease` against the remote head Smithers last accepted: its own last push, a brought-in sha, or the sha a Discard named (§12.3). A refused lease is never retried: the push row settles `conflict`, and the observed head raises `foreign_push` (§12.4.1b).

12.5.3 [D] Stacked bases with retargeting, in-app line comments mirrored as review comments, and agent replies in review threads are deferred. In the MVP, the agent's response to a review shows as new commits and in the branch activity.

### 12.6 Health surface

`GET /api/github/sync` and the `home` topic expose `{state: fresh|stale|refused|limited, last_success_at, cause?, retry_at?}`. The client computes "synced N s ago" from `last_success_at`, so no delta is needed each second. **Retry** forces all streams now; any member may press it (`agent: run`).

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

14.1.2 Entries are shared: prompts show their author, and cards are the same cards for everyone. Each member keeps their own scroll position, card view state (maximized, tab, filters) and last-seen entry in `member_conversation_state`. Opening a conversation restores that state.

14.1.3 There is no person-to-person chat. A prompt is always addressed to an agent. People coordinate through presence, live edits and branch activity.

14.1.4 UI-only flows (theme, open, maximize, navigate, palette, filters, input mode) affect only the screen of the person who ran them, even when that person's app agent ran them. They never write shared state.

14.1.5 Legacy per-member conversations stay readable. Each one becomes a read-only archived conversation that only its member can see, and it is listed under the branch tree's "Earlier" node. Nothing is migrated into a shared conversation (AGENTS.md: old sessions remain readable). Removed card kinds decode through one legacy decoder as read-only tombstones that keep their title, so legacy and shared conversations stay readable after any card is removed; a kind is never live and legacy at once (card-kinds.md §2, T-APP-22). Check: C-CUT-02.

### 14.2 Cards are projections

Every card renders one live topic (§7.2) or a set of topics, and every card action runs one catalog command (§6.1). Cards hold no business state. The same component renders inline and maximized.

14.2.1 Ownership (Will, 2026-10-02). Design builds every visual component in `apps/app` and `@smthrs/ui`: cards, the shell, the timeline, toasts, the branch tree, forms and CSS. Engineering wires them to data and actions. Each card is split in two:
- `<Card>View` in `apps/app/src/mainview/cards/views/`: presentational, props only (the view model plus callbacks), with fixture stories. A handler does exactly one of three things: it calls `onAction(action.tag, input?)` from a control carrying `data-flow={action.tag}`; it calls `onView(patch)` for per-member view state (§14.1.2); or it touches only React local state, DOM focus or the clipboard (ui-components.md Rules). A View imports no state, flows or RPC and does no fetch. Design owns it.
- `<Card>Container`: subscribes to the card's topics, maps them to the view model, and builds `actions[]` and `gestures` through `cardActions`, which binds `onAction` to `flowAction`, so the three-door and agent-parity rules hold at the Container. `Action.tag` is the catalog's tag type (T-CAT-01). Engineering owns it. 

14.2.2 **Schemas and owners.** A card crosses three schemas, each with one owner: the topic schema (the publishing ticket owns the Go snapshot builder; the wiring ticket owns the TypeScript decoder `packages/rpc/src/topics/<Topic>.ts`, the golden fixture `packages/rpc/test/fixtures/topics/<topic>.json` and the Go test that compares the builder's output with it), the view model (`packages/rpc/src/<Card>Card.ts`, T-APP-19), and the card reference an entry stores (`Cards.ts`, a subject reference only). The wiring ticket's adapter `to<Card>Model(topic, viewer, view)` derives every per-viewer value and labels every action; the Container only subscribes, calls it, binds `cardActions` and stores `onView` patches. card-kinds.md §1 lists the owner of each. Checks: C-UI-08, C-UI-13.

The seam is one zod view-model schema per card in `packages/rpc/src/<Card>Card.ts` (the `SubagentCard.ts` precedent), written from §14.3's field lists (T-APP-19), with fixtures in `packages/rpc/test/fixtures/<Card>.ts`, exported through per-module subpaths (`@smthrs/rpc/TodoCard`; no barrel), so the app imports them and no package depends on an app. §14.3 is the source of truth for fields, and the TypeScript types are its executable form. A field a view needs but §14.3 lacks is a spec change, raised with the tech lead.

### 14.3 Card models

14.3.0 **Inventory.** Each row of the table below is a card whose View renders a §14.3 model, and a View in `apps/app/src/mainview/cards/views/` exists only for a row here. A ticket that adds a card adds its row and its ui-components.md props in the same change. The shell parts take their fields from the sections that define them: entry rows and the Context line (§14.5.1, §15.1.2), timeline lines (§14.5.4), toasts (§14.4), branch tree nodes (§14.1.1) and actor chips (§14.6a). The Stage column says by which stage the card's View, Container and schema all exist; fields tagged with a later stage are absent or empty until then (check C-UI-13). Retained cards keep their existing schemas in `packages/rpc/src/Cards.ts`, which are their contract, and have no row here. Each keeps its current renderer, outside `cards/views/` and the View-seam rule, and the ticket named with it owns that renderer and its schema snapshot: Issue (`issue`, T-GH-02), PR (`pr`, `change`, T-GH-03), Review findings (the `change` card's `ChangeReviewSchema` and `ChangeFindingSchema` in `packages/rpc/src/Changes.ts`, T-FLW-11), Wiki (`world`, `wiki-history`, `wiki-links`, `wiki-graph`, T-COL-09), the flow Form (`flow-form`, T-CAT-01), the webpage reader (`browser`, T-APP-15), the plan view (`flow-plan`, T-APP-05), the run list (`run-list`, T-FLW-07), search results (`search-results`, T-APP-16) and approvals (`approval`, T-STK-07). Any other card that mvp.md Appendix B names and this table lacks is retained the same way, owned by the ticket that wires its flow. A change to a retained card's fields is a spec change that first adds its row here. Checks: C-UI-08, C-UI-13. Retained kinds also include `file-list` (T-APP-15), `issue-list` (T-GH-02), `pr-list` (T-GH-03), `workflow-list` (T-APP-05), and `plan` and `status` (answer parts, T-APP-16). Deferred and hidden surfaces keep their card kinds and schemas: `anonymous-ceiling`, `balance`, `billing-plans`, `environment-images`, `repo-update`, `repository-choice`, `sync-ops`, `trigger-list`, `workflow-repo` (card-kinds.md §3). Check: C-CUT-02.

| Card | Topic | Stage | Model fields (all present in the projection; TypeScript in ui-components.md) |
| --- | --- | --- | --- |
| Home | `home` | S1 | Repository name; `main {sha, title, last_success_at, health: fresh|stale|limited|refused, cause?, retry_at?}` (§4.4); `attention[]` (stack_attention for this viewer, each with its action); items[] `{n, title, state, owner, place, queue?, step?, rebase_pending?, needs_you? {kind, prompt}, merge, pr? {number, draft}, approval_cleared?, amendments, lessons?, branch {id, name}, present[], elapsed_s?, actions[]}`, where `present[]` holds actors, agents included (M-34), and `merge` is the TODO row's; counts by state; merged_since_last_look (per member); machines `{in_use, capacity, slots[] {branch, actor, awake}}`; parallel (owner only); background_runs[] `{id, title, state: queued|running|waiting|failed, detail?, actions[]}` with Retry and Dismiss (in-card): Retry admits a new background run of the same flow, version and input; Dismiss writes `background_dismissals` (§3), so the run leaves every member's card while its record stays. A finished run leaves the card. "Last look" advances when the Home card has been on screen for 2 s |
| TODO | `todo:<n>` | S1 | n, title, state, owner, owner_removed? (removed or suspended; Take over, §5.6), place?, queue?, rebase_pending?, step (its label); prompt revisions `{text, acceptance[], by, at}`; issue `{number, url, fixes}`; branch `{id, name, machine}`; present[]; the run's step list with `waiting`/`paused` states and its trailing wait for merge (`held`); the run's indicators (waiting for a person since; thrashing, §11.6.4); open waits[] `{id, kind, prompt, since, paths?, by?, sha?}`, primary first, each with its action (§4.1.0a); the latest question's first answer; steers[] `{text, by, at}` (§10.7.3); failure `{step, class, message, retryable, missing_tool? {name, file}}` (§8.6.2; Add to machine image); evidence[] per attempt `{attempt, revision, items[], previous? {revision, items[]}, reviewing?}`, where items are the diff stat, machine checks `{name, state, took_s?, log_url?}`, GitHub checks `{name, state, required, url}`, the review summary, usage, the flow version and the model access (§10.4.3); PR `{number, url, head, draft, draft_after ("Draft · merges after T8"), included_items}`; merge `{state: ready|waiting|blocked|merging|done, reason?, detail?, on_github}`, where `reason` and `detail` are §10.6.2a's `merge_block`; approval_cleared?; `merged_via` ("Merged · in T15's commit", §10.6.4); lessons? |
| Branch | `branch:<id>` + `:activity` + `:files` | S2 | Machine (§4.2: awake, asleep, waking, waiting with its position, closed, or failed with its error and Retry) with in-card Sleep and Wake; item `{n, title, state, step?, place}` or scratch `{forked_from}`; rebase: pending `{onto, waiting_for?}` (`waiting_for` names the busy writer, sent only to the member who pressed Rebase now, §9.4.2), rebasing `{onto}`, or a scratch conflict `{onto, paths[]}` with Resolve and Done (§8.5.2b); moved_off; presence[] `{actor, where: file {path, line?} | terminal {id} | step {label} | branch, watching?}`, people and agents (M-34); terminals[] `{id, title, owner, agents[], watchers[], command?, frozen}`; activity[] `{actor, asked_by?, kind, text, items?, files?, github, at, actions[]}` (§3), where a change or edit entry's action opens its burst's diff; changed files `{path, change, renamed_to?, authors[]}`; the SSH line |
| File | `branch:<id>:files` and the file content route (§6.3); live doc `doc:code:<branch>:<path>` [S3] | S1 | [S1] path, branch, language, digest, content (text; too large, with its text; or binary), mode (read_only or live), last writer, diagnostics, the hover result, reveal (a same-file definition or a cited range). [S2] gone `{deleted, by}` or `{renamed, to, by}`; `outside {version, at}` (the outside version that Compare reads, §9.2.3); editors[] `{actor, line}` from presence. [S3] authors[] with the editor binding's author ranges (ui-components.md § T-UI-19); editors from awareness; saved state; unsaved `{count, text}` ("N edits weren't saved" with Reapply and Copy, §7.4.6) |
| Diff | `branch:<id>:files` | S1 | Path and branch; against: the previous item's candidate (§12.5.1), a scratch branch's fork revision (§8.5.3b) or one burst's before and after versions (§9.3.4); change and renamed_to; binary sizes; hunks `{old_start, new_start, lines[] {op, text}}`; Restore this file on a burst diff (§9.3.5) |
| Terminal | terminal stream + `branch:<id>` | S2 | Id, title, branch, owner, the agents working in it (M-34), watchers, running command, viewer_is_owner, frozen ("Rebasing…", §9.4.2) |
| Flow | `flows` | S1 | Source label (built-in or `flows/<name>/flow.ts`), versions `{state: active|proposed|merged-syncing|merged-failed|previous, todo?, error?, steps[] {id, label, detail?, agent?, added?}}`, and for the TODO flow the trailing merge wait with its signals (clean rebase → check, resolved conflict → implement → check → review, steer → implement); actions Source, Plan, Run, Edit; the agent of each step |
| Members / Secrets | `members` / `secrets` | S1 / S2 | Login, name, avatar, color_index, role, needs_access (never had write access), suspended (lost it; automatic, §5.1.3), each row's Role and Remove, and the repository's GitHub access URL; secret name, scope (`all_branches` or `main_only`, §8.8), optional bound hosts (set in Add and Replace; no separate Bind door), each row's Replace and Delete |
| Setup / Settings | `install` | S1 | Address `{listen, bind, origins[]}`; steps[] `{id, state: pending|running|done|blocked|failed, blocked? {line, fix_url}, error? {class, message}, pct?}` for the setup steps in §16.2 order (`address`, `app`, `sign_in`, `repository`, `models`, `source`, `machine`), with the ids and states T-INS-06 stores (the squash check runs inside `repository` and blocks it with its fix link); "This Mac" (the detected host, its limits and, when capacity is 0, the limiting term and its fix, §8.2.1a); GitHub `{owner?, signed_in, app_installed, squash_allowed?}`; repository, and the choices while it is being chosen; models[] `{role: fast|coding|jev, provider, key: none|validating|saved|failed, error?}` (shown as "Fast model", "Coding model" and "Jev" with its "AI Gateway key", mvp.md §6.5) and the ChatGPT sign-in flag. Settings adds capacity, parallel, the laptop-agent lines `smthrs login <origin>`, `notifications_need_https` (§14.6), health `{process, postgres_bytes, disk_free_gb, github {health, cause?, retry_at?, rate_remaining, rate_limit}}` (§20.2) and [S2] the Obsidian folder `{path, last_sync_at?, error?}` (§13.3) |
| Proposal | `proposals` | S3 | Title, evidence, refs, state, and the TODO it became `{n, title}` |
| Draft | the author's `view:<member>:<branch>` until Commit, then `conversation:<branch>` (§14.5.1) | S1 | title, prompt, acceptance[], place `{mode: append|before|amend, n?, options[] {n, title, state}}` (unmerged items only), issue `{number, title, url, fixes}`?, seed `{files[]}`? (a seed patch, shown read-only), committed `{n, rev}`? (rev 1 is a new TODO, rev > 1 an amendment shown "+1"), private (true until Commit). The fields live in the entry's `card` column (§3). Commit runs `/todo.new` or `/todo.amend Tn` once, with one `Idempotency-Key` (§6.2.1) |
| Commands | none: `catalog.mvp.json` (§6.1.2), fixed per install version | S1 | groups[] `{label, advanced, commands[] {tag, synopsis, description, agent: run|confirm|never}}`, filtered for the viewer's role; `synopsis` and `description` are the Appendix A command and its line |
| Run (monitor, Inspect) | `run:<id>` | S1 | Title, todo?, branch?; state incl. `held` for the wait for merge; attempts[], oldest first (a TODO's attempts; one for any other run), each with its run id, state, graph, steps[] per step instance `{key, id, k, label, state, started_at?, ended_at?, took_s?, input, output, agent, usage? {tokens, cost_usd}}` (no usage for a step with no model call) and phases[] `{id, step, title, summary?, took_s, tone, indicator?, cells[]}` with cells `{id, kind: context|read|edit|run|think|ask|steer|reviewer|rebase, label, explain?, code?, output?, quote?, tone?, took_s?, tokens?, actor?}`. `title` and `label` are deterministic (the step's Appendix C label plus its recorded outcome, "Ran checks · 2 failed"; "Read retry.ts"); `summary` and `explain` are optional `agent:fast` lines rendered as model summaries (§11.6.3). Phase and cell ids are stable across deltas. Waits[] `{id, kind, label, since, settled? {by, at}}`; tokens, time and cost; Appendix C engine labels; the journal, loaded when its tab opens; replay `{at, last}` (the container re-projects the run at journal seq `at` and writes nothing, §11.6.2); the flow's custom view, passed to the View as a rendered slot |
| Agent | `agents` | S1 | Name, instructions path, role (shown as "Fast model", "Coding model" or "Jev"), model and the owner's choices, runs it took part in |
| Confirm | `confirmations:<member>` | S1 | Kind (`one_click` or `review_merge`), action, a one-line summary, subject `{kind: todo|branch|flow|agent|wiki, ref, revision?}`, the exact text the command sends (one_click), who asked, and for review_merge `{title, place, pr, evidence, approved_revision?, merge}` with each check of the subject revision; a receipt `{by, result: done|cancelled|expired, at, text?}` |
| Docs | none: pages bundled in the app (`apps/app/src/docs/`) | S2 | toc[] `{slug, title}`, page `{slug, title, summary, markdown}`, anchor?, not_found? (M-35, T-APP-20) |
| Debug API | none: `docs/api/openapi.yaml`, bundled | S2 | operations[] `{id, method, path, summary, group}`; selected?; pending `{method, path}`? (a mutation waiting for its in-card confirmation); exchange `{request {method, url, headers, body?}, response? {status, headers, body, duration_ms}, failure? {class, message, status?}}`; the Send action's form comes from the operation's parameters and body schema (M-36, T-APP-21) |

### 14.4 Toasts

14.4.1 Notable events and anything that needs action pop as toasts with their one action: Needs you, an approval, a PR ready for review (in_review), a failure, a rebase conflict, and the merge of the viewer's own TODO. A toast goes to the people §10.8.3 names (the TODO's owner and those present on its branch) and to the prompter for their own runs. Every toast is also an entry in its conversation, and therefore a timeline line.

14.4.2 Each member can hide toasts (`member_conversation_state.toasts_hidden`, plus one global preference). Hiding never hides the entry, the edge map or the home card.

14.4.3 Background progress for a member's own commands uses the shared toast stack: 300 ms debounce, through launch and execution, settled only by the real terminal event, at most three plus "+N more". Actions are Open, Stop, Steer, Answer and Retry.

14.4.4 Live work in cards scrolled out of view shows on the left edge, top-left for above and bottom-left for below, each with its single action.

### 14.5 Conversation entries and the timeline

14.5.1 Every entry (a prompt, an answer, a card or an event) is a `conversation_entries` row in its branch's conversation. An entry without a run takes its title from its first line (prompt) or its card title, and has no summary. Entries are append-only; nobody deletes a prompt from a shared conversation. Two kinds are private to one member and carry `audience_member_id`: a Confirm card (§5.4), and a Draft card until its author commits it. A private entry publishes only on its member's topics (§7.2.2), has no summary, and never enters an app-agent turn (§15.1.2a). Commit clears `audience_member_id` in the transaction that creates the TODO, so the entry first reaches `conversation:<branch>` already committed. Discard marks the Draft discarded, and it never becomes shared. Unsent composer text never leaves the author's browser. Check: C-UI-06. Each row has the author, title, summary, tone, state, context (§15.1.2) and a derived action. Each entity (a TODO, a flow, a file, a branch, a run) has one persistent entry per conversation, keyed by (kind, id); showing it again jumps to that entry instead of appending a duplicate (design G11).

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

14.6a.1 Every working agent is a participant with its own stable id, kind, avatar and session/run id; `for_member` records the person it acts for and is absent when no person delegated the work. Adapt existing `{person, via}` and `{agent: coding, run}` actors into this participant model without changing authorization. Presence, activity, line flags and terminals render the same participant and "for Ben" when present. System events keep the system actor and never impersonate an agent. T-APP-09 owns the actor adapter; T-COL-06 owns participant presence, T-COL-04 activity, T-TRM-05 agent terminals, and T-APP-14 line-flag data. Checks: C-J3-01, C-J6-01. Smithers, Coding agent, Claude Code, Codex and Reviewer each render their own avatar, for example "Claude Code for Ben". The broker registers each agent process lifetime and session/run. A command in a person's terminal is not an agent by inference. Participant ids confer no authorization rights. Checks: C-J3-04, C-J3-10 (line flags and terminal fixtures).

| Actor | Renders as |
| --- | --- |
| A person | "Ben" (avatar) |
| `via` smithers, claude-code, codex | "Smithers, for Ben", "Claude Code, for Ben", "Codex, for Ben" (the agent’s own avatar) |
| `via` ssh, terminal, cli | "Ben via SSH", "Ben's terminal", "Ben via CLI" |
| The coding agent | "Coding agent, for Ben" (its own avatar; TODO when ambiguous) |
| A reviewer agent | "Reviewer, for Ben" (its own avatar and review/run id) |
| System | "Smithers" |
| A non-member GitHub user | "@login" with the GitHub mark |

### 14.6b Copy rules

Visible copy uses product words (mvp.md §3). The conformance lint bans these internal terms in visible strings: workflow, thread, task, lane, box, workspace, mythical, sandbox, VM, seat, profile. A card body block (a paragraph, list item, heading, label, button or table cell) holds at most 12 words, and visual wrapping doesn't count. A block holds one sentence at most, and a design copy review rejects explanatory sentences (AGENTS.md MINIMAL TEXT). Check: C-UI-02.

### 14.7 Keyboard and input

Every P0 journey completes with the keyboard alone (§9 of mvp.md). Normal, Vim and dictation input are kept as built.

---

## 15. Agents [S1]

### 15.1 App agent

15.1.1 The app agent answers in a branch's conversation. Each prompt runs as a turn with a `delegated(via=smithers)` credential of the prompt's author, so "Ben via Smithers" has exactly Ben's non-person rights. Turns in one conversation run in order, one at a time per conversation. A member's `/stop` stops only their own turn, and their queued prompts stay editable until they start (the single-user prompt queue AGENTS.md keeps).

15.1.2 **Context preflight.** The conversation is not the context window. Every turn begins with a preflight step that chooses what to add to the model's context. Its inputs are the prompt, the author, the branch, the titles and summaries of the conversation's recent shared entries, and the branch's state. Its candidates are files, wiki pages, TODOs and runs. Its output is a list `context[] = {kind, ref, revision?, reason}` within a token budget (default 24k tokens, an owner setting). Only the selected items, the prompt and the last 3 shared entries' text enter the answer step. The list is stored on the answer entry, the answer shows a compact "Context" line, and Inspect shows preflight as the turn's first step. Jev picks the commands the answer may call (existing `POST /api/commands/select`). Preflight selection is a model call on the cheap fast model and is recorded like any step.

15.1.2a **Audience filter.** A turn reads only shared entries (`audience_member_id IS NULL`, §14.5.1). The filter covers preflight's inputs and candidates, the last-3 window and every conversation read the turn's credential makes, and it excludes the author's own private entries too. A turn's credential can't subscribe to `view:*` or `confirmations:*` topics. A shared answer, its stored `context[]`, its summary and its Inspect trace therefore hold nothing private, and every viewer sees the same Inspect. Checks: C-UI-06, C-UI-07.

15.1.3 The app agent runs in the host's model host, outside every machine. It cannot run commands or write files on a machine. It may open a terminal for its author (that person's own session, §15.1.5), but it never types in one. "Run the webhook tests on retry-webhooks" becomes a request to that branch's coding agent (a steer, or a run on the branch), shown as "Ben via Smithers asked". It can call UI-only flows only on its author's own screen (§14.1.4). It cannot merge or approve. When asked to, it creates a person confirmation (§5.4) and renders the Confirm card for its author.

15.1.4 App-agent turns run entirely on the host, including command dispatch. Today's browser-side tool execution moves to the host turn runner, which calls each command through the same command→API mapping the CLI uses (§6.1). Its credential is a `delegated(via=smithers)` credential for the prompt's author, minted on the host when the turn starts (not when it is queued), revoked when the turn ends, and never sent to a browser. UI-only flows (§14.1.4) go to the author's own browser as instructions on the live channel. A turn therefore survives its author closing the tab and can be queued server-side. A `confirm` command from the agent posts a Confirm card (§15.1.5), and `never` commands are absent from the agent's tool list (`agent-parity.test.ts`).

15.1.4a **Turn queue and the author's access.** Each prompt queues one `agent_turns` row (§3). When a turn reaches the head of its conversation's queue, the runner checks that its author is still an active member (not removed or suspended) and only then mints the turn credential. A failed check ends the turn `refused` with the reason, and nothing runs. Removing or suspending a member (§5.6) cancels their queued turns (`cancelled`, reason `author_revoked`) and stops their running turn within 5 s: the credential is revoked, so every later command call is refused, the model stream is aborted, and the turn writes nothing more. The runner learns of it from the revocation event §5.6 publishes. The conversation's next turn then starts. Check: C-UI-06. A queued prompt shows only in its author's queue on `view:<member>:<branch>`; its shared entry is appended when the turn starts. Check: C-APP-02.

15.1.5 Agent permissions (mvp.md Appendix B legend and B.6). They apply to every delegated credential: the app agent, external agents through the CLI or skill, and terminal sessions. Each catalog row carries one of three values (§6.1.2):
- **run:** executes immediately with the person's rights. Reads, UI-only flows on the prompter's own screen, steer, answer, stop, resume, retry, rebase, fork, run a flow, wiki writes, open a terminal, and sleep or wake a machine.
- **confirm:** posts a one-click Confirm card (`person_confirmations`, kind `one_click`) to the requesting person. Commit, amend or drop a TODO, add to stack, Bring in or Discard a foreign push, delete a wiki page, propose a flow or agent edit, and review a PR (`/review`); catalog descriptors hold the full list (§6.1.2). The primary button is the command’s verb, with Cancel beside it. A minimum role above member requires the requester to hold that role; only their session approves (§6.1.2b). Merge opens **Review & merge** (`review_merge`) for the requesting owner or maintainer. The private card becomes a receipt after approval; other viewers see nothing of the Confirm card. After execution the ordinary shared action entry may appear (§14.5.1). Checks: C-ACC-01, C-ACC-02.
- **never:** refused and absent from agent tools. Members, secrets, settings, and approvals that gate a merge.

### 15.2 Coding agent

The coding agent runs on the branch machine as `agent`, inside the pinned `todo` flow. Its model calls go through the host model proxy with its `run` credential. Provider keys never enter the machine, so the install's model access applies (provider keys, or the owner's ChatGPT subscription sign-in when enabled). Every run records the model access it used. A member's personal subscription is used only in that member's own terminal.

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

16.1.2 [S1] `smthrs host start [--bundle <dir>]` installs and starts a launchd daemon that runs as the installing user (`UserName` key), so the install runs before anyone logs in to the Mac. It runs the server bundle at `--bundle` (in stage 1, the build output of T-INS-01) or, without the flag, the bundle the tap installed beside `smthrs` (§16.1.1). It verifies the bundle's manifest first, records the bundle's absolute path in the plist, and prints the setup URLs. A second run with the same bundle changes nothing and keeps the setup token; a run with another bundle rewrites the plist and restarts the service once. Installing a LaunchDaemon needs one `sudo` at `smthrs host start`; the quickstart says so. A W0 spike (T-INS-03) confirms Hypervisor.framework works from that daemon. The fallback is a launchd agent plus macOS automatic login (no sudo), documented. The choice is made before stage 1 ends. `smthrs host stop` stops it. `smthrs host status` reports the health of every process and the bundle path. Stage 1 ships the service and these three commands; the tap, upgrade, backup and restore come before launch (check C-INS-06).

### 16.2 Setup (J1)

The setup card runs on whichever known origin (§16.3.3) the owner opened the setup link on (§5.1.0). Steps, in order (mvp.md J1.2):
1. **Setup session:** the one-time link opens a token-backed setup session.
2. **Address:** This Mac only (loopback), or Network plus a public address (§16.3). It comes first because the GitHub App's callback URLs are registered to it.
3. **GitHub App:** setup asks which account owns the repository, then creates the App through the manifest flow (§12.1).
4. **Owner sign-in:** GitHub sign-in through the new App completes the owner claim (§5.1.0). Then the owner picks the repository and installs the App on it, and the host verifies the owner's access with the installation token. Until it does, the owner can do only setup.
5. **Model access:** the three roles (§11.5a): a coding-model provider key, a fast-model key (Cerebras by default, optional), the AI Gateway key for Jev, and optionally a ChatGPT sign-in for coding.
6. **Squash-merge check** on the repository (§10.6.2).
7. **Mirror:** "Source ready" shows here, and questions work from this point.
8. **First machine image** ("Machine ready").

Each step is durable and resumable. The setup card shows seven steps with the ids `address`, `app`, `sign_in`, `repository`, `models`, `source` and `machine` (§14.3 Setup). Step 1 is the session itself. Step 6's squash check runs inside `repository` as soon as the repository is chosen and again on every Retry; a disabled squash merge blocks `repository` with its fix link. Check: C-J1-02.

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
- `MANIFEST.json`, written last. It records the version, schema version, PostgreSQL major, the quiesce op and time, the path, size and SHA-256 of every file, and a summary to check a restore against: the stack (each TODO's number, state and place), each branch's captured head and disk file, each credential store row (member, file, `written_at`, ciphertext SHA-256) and each run's last finished step.

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

17.3 The host service never executes repository code and never loads repository flows into its own process.

17.4 Provider keys and the GitHub App PEM stay on the host. The install key lives in `$STATE/config/secrets.json` (mode 0600). Every backup copies it, so a backup directory is mode 0700, and anyone holding a backup can decrypt its sealed rows (§16.5.2, check C-REL-06). Sealed blobs (App PEM, client secret, provider keys) live in PostgreSQL, encrypted under that key.

17.5 Contributor trust rules are enforced from launch (mvp.md §14). Outsider text (an issue, PR, comment, mention or label from a non-member, §10.2.1) never starts credentialed work on its own: no run, proposal, triage or machine request follows from it. An issue with outsider text becomes a TODO only by a maintainer's Make TODO or `todo` label, and only as admitted then (§10.2.1a). After that, its author's comments, like every later issue comment, never reach the run, and a non-member's PR comments show in activity and never steer (§12.3). Labels from non-members are reverted with a comment. Check C-SEC-03.

17.6 A plain-HTTP public origin sends session cookies unencrypted on the network. This is a documented limitation of the team's chosen exposure, not of the install. The quickstart recommends HTTPS in front, and Settings marks an http origin with one word: "unencrypted".

17.6a A request's scheme comes only from the configured origin it matches, and only a loopback peer can set its host through `X-Forwarded-Host` (§16.3.3). A proxy on another host gets no trust: the install reads only the `Host` it passes on (check C-INS-03).

---

## 18. Performance budgets (reference host: a 32 GB Apple Silicon Mac mini, mvp.md §9; every artifact records the host profile, §8.2.1)

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

19.2 Interrupted external actions reconcile before retrying, with no new engine API (library review, 2026-10-02). Every action with an outside effect declares its `tier` and an `idempotencyKey` explicitly. When an `intended` irreversible crossing has a key, the engine re-executes the body (`ActionPersistence.ts`, the `IrreversibleRetryRequiresIdempotencyKey` gate refuses only a keyless crossing), and the body checks remote state first and returns what it finds: a GitHub write reconciles by kind (§12.4.1b), and a push runs `git ls-remote` and compares the remote ref with the intended and expected heads. A model call is retried, since it has no outside effect. A check command on an immutable source export declares `tier: "sealed"`. A keyless irreversible crossing fails as `interrupted`, with Retry. Check: C-GH-09.

19.3 No state is shown before its event exists. A command's toast stays running until the projection reports terminal.

19.4 Typed failures carry a fault class end to end (§6.2.3). Infra and capacity failures say they aren't the user's fault. Class `never` returns HTTP 403 and says "Only a person can do this" when the actor kind may never perform the action. Check: C-ACC-01.

---

## 20. Observability

20.1 Structured logs with request id, actor, todo, branch and run on every line. Logs go to `$STATE/logs/`, rotated at 100 MiB × 10.

20.2 `smthrs host status` and the Settings card show process health, PostgreSQL size, disk free, machines and capacity, GitHub sync health and rate budget.

20.3 Metrics are kept in-process and exposed at `/api/install/metrics` (owner only). They cover the latencies in §18, queue depth, wake count and time, burst rate and live-channel connections.

20.4 Alpha scorecard (mvp.md §10). Computed from product tables, never from logs, at `GET /api/install/scorecard` (owner). Definitions:
- **accepted**: a TODO committed to the stack;
- **merged, dropped, failed**: TODO states (§4.1);
- **terminal edits**: bursts whose actor has `via` terminal or ssh;
- **second-member action**: an activity entry on a branch by a person other than the TODO's owner;
- **session**: one person's continuous presence on a branch for at least 2 min;
- **flow revisions**: activations (§11.3);
- **outside work**: commits that reached `main` without a TODO PR;
- **person-minutes**: for each accepted TODO, sum attributed answer, review and edit effort durations across people, unioning overlapping intervals for the same person and TODO. Persist intervals in product tables; elapsed run duration and burst counts are not effort. Autonomous agent work contributes no person time. Report weekly accepted counts and the median effort for TODOs accepted in that week. Core value targets at least 10 accepted per week and a median below 15 person-minutes; fewer than 3 accepted in week 2 or a rising weekly median is a kill signal. Missing effort instrumentation returns `source_missing`. Check: C-REL-04.
- **no hand-written code**: a merged TODO with no person-authored code edit, including an edit made through a delegated tool. Report the share as a diagnostic only; it never controls the core-value verdict. Check: C-REL-04;
- **measurably helps**: after a learning proposal merges, its failure signature's rate over the next 5 TODOs is lower than over the previous 5.

Install, first-answer and first-merge times come from `todo_events` and conversation entries.

---

## 21. Test strategy

| Layer | Scope | Where |
| --- | --- | --- |
| Unit | Pure rules: the TODO state projection and engine guards, capacity formula, placement, merge guard, permission matrix and `agent: run/confirm/never`, burst grouping and session attribution, catalog and Appendix B/C parity | Next to the code, `go test` / `bun test` / `cargo test` |
| Integration | Real PostgreSQL, real jj, real inotify and cgroups (in a microVM or a Linux CI runner), a fake GitHub server that speaks REST, GraphQL drafts and ETags | `packages/backend/internal/...`, `crates/smithers-machined/tests` |
| End to end | Real app in a browser against a real install with microVMs and a scratch GitHub repository | `apps/app/e2e/real/` |
| Fault | Kill points across runs, merges, GitHub writes, bursts, rebases | `packages/smithers/test/faults/`, `packages/backend/...` |
| Performance | §18 budgets on the reference host | `scripts/perf/` |
| Journey | J1–J8, J10 and J11 on a fresh Mac mini, in both themes, recorded (mvp.md §12.1). The recording includes a restart mid-run, a duplicate launch, an outside save landing on a file two people are typing in, and a wiki decision edit that the next plan follows | `checks/` C-J* |

21.1 **Library review bar** (smithers-38, packages/ owner, 2026-10-02). Any ticket that changes a public export of a `packages/` TypeScript library meets all of these, and the library owner signs off the public-API diff before it lands:
- Need: the change names its real caller and shows, with a code sketch, why the existing API or a userland composition can't do it. A new abstraction needs two callers.
- Surface: no option overlaps an existing one. Each export has JSDoc with `@since` and a page in the package's `docs/`. Errors are typed tagged errors, public types have no `any`, and new code carries no `@slop` tag.
- Durable formats (journal, engine store, keys, canonical encoding, plan step keys): old records keep decoding. A format change ships a fixture written by the previous version and a decode test.
- Tests: the package stays at 100% lines, branches, functions and statements. A new `v8-ignore` carries a one-line reason. Unit tests cover the behavior, its errors, interruption and replay. Integration tests use real SQLite, PostgreSQL and jj, never mocks of our own modules.
- Hot paths (action dispatch in `ActionPersistence`, journal append and replay, canonical encode and hash, step-cache lookup, sync projection): the change adds or extends a counter fixture in `//scripts:benchmarkGate` (`scripts/bench/gate.mjs`, `baseline.json`), which counts SQLite queries and prepares, scheduler dispatches and pages with at most 5% growth, plus output digests. The baseline changes only with the reviewer's sign-off. Counters, not wall time: wall time is noise on a loaded host. The library owner adds fixtures for the paths the gate doesn't cover yet (ledger #3480 item 4).
- A migration deletes the old path in the same change.

21.2 **Declared-input existence in //:targetIndex and the drift set at landing.** [S1] Declared inputs must exist when `//:targetIndex` resolves `Smithers.file()`, `paths:` and `workflows:` declarations, including supported globs and brace expansion. Actionlint discovers workflows from `.github/workflows`. Landing runs `smthrs lint '//:driftCi' '//:targetIndex' '//:ci' '//scripts:trackedHygiene' '//scripts:conflictMarkers'` locally and refuses push on failure. The per-SHA, non-cancelling drift status is required on main and includes `//:ci`; the long CI remains advisory until its existing repair is green. T-PRC-01 owners smithers-38 + smithers-22 implement this rule. Check: C-PRC-01.

21.3 **DB-free migration gate and planned table ownership at Ready.** [S1] At Ready, the lead records every new table in `ownership.csv` as `planned:<ticket>` with one owner. Reserve tables before implementation; assign migration numbers at landing. The default Go target runs DB-free checks for unique, gapless numbers, registry/embed parity, duplicate CREATE statements (IF NOT EXISTS included), ownership of created tables and removal of dropped tables. A lane cannot create a table planned for another ticket. `scripts/renumber-migration.mjs <file>` renames the migration, updates the registry and regenerates sqlc output at landing. T-PRC-02 owners smithers-3f + smithers-8a implement this rule. Check: C-PRC-02.

21.4 **Check receipts required to close a ticket.** [S1] A ticket closes only with a machine-written receipt for every named check, bound to the landed commit. `scripts/check-run.mjs C-XXX-NN` runs its `Automation:` command, refuses an absent path or `to write` declaration, and writes `.artifacts/checks/<id>/<ts>/receipt.json` with `{check, commit, layer, command, exit, started, ended, log_digest}`. `issue-claim.mjs comment --release --close --receipt <path>...` requires passing receipts for every named check at the landed commit and verifies log digests. Missing, failed or mismatched evidence exits 2 before the issue write. Reports list receipts; prose PASS claims do not close tickets. T-PRC-03 owners smithers-22 implement this rule. Check: C-PRC-03.

Every check in [checks/](checks/) names its layer and its automation path. Executed coverage, configured thresholds, skipped cases and platform-specific evidence are reported separately (AGENTS.md testing quality).
