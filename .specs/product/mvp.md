# Smithers MVP product spec

Status: v2.5 by the product agent (smithers-98), 2026-10-02. Builds on the [overview](overview.md). Reviewed by Codex Astra (3 passes plus a consistency pass), full reviews by Astra, Opus and Fable, design feedback from smithers-06, engineering pushback from smithers-8a, and Will's rulings. Will reviews last. Decisions marked "(Fable for Will)" were made by a Fable subagent on Will's behalf, at his instruction.

Smithers MVP is one install, on one machine a small team owns, that wraps their GitHub repository. In it, people and agents turn TODOs into merged pull requests on shared branches, and the process they follow is a flow the team edits.

## 1. The user

### 1.1 Who we build for

**A small team that already codes with agents.** Every feature in this spec is judged by whether this team needs it to finish journeys J1 to J5.

| | |
| --- | --- |
| Team | 2 to 8 engineers. One GitHub repository they own and commit to themselves. Its visibility doesn't matter. |
| Today | Each engineer runs Claude Code or Codex daily, often several sessions at once, on their own laptop. |
| Hardware | One always-on Apple Silicon Mac (for example a Mac mini) that teammates can reach from their laptops. Many teams will use Tailscale for that; Smithers doesn't depend on it. |
| First instance | Will and the Smithers maintainers, working their own TODOs in `smithersai/smithers` on one Mac. The spec must hold for us first. |

This is a hypothesis, ratified by Fable for Will. Section 10 says how the alpha tests it.

### 1.2 Their problem

1. **Agent work is trapped on laptops.** It stops when the lid closes, teammates can't see it, and it can't be handed off.
2. **Parallel agents collide.** Each person juggles worktrees, branches and terminals by hand.
3. **Reviewing agent output is the bottleneck.** Diffs arrive without the evidence needed to trust them.
4. **Context is lost.** Every session starts cold, and each person's agent instructions drift apart.
5. **The process lives in people's heads.** How the team wants work done is re-typed into prompts and never improves.

### 1.3 What they do instead

Claude Code or Codex on laptops, git worktrees or Conductor for parallel sessions, GitHub pull requests for review, Slack or Linear to coordinate, and `CLAUDE.md`/`AGENTS.md` files as memory. Some teams SSH into a shared box and use tmux.

Smithers has to beat that setup on three counts:
- **Shared and always on:** work runs on the team machine, and anyone can join it.
- **Remembers:** the wiki carries context across sessions and people.
- **Improves:** the process is a flow the team edits, and the factory proposes improvements from its own outcomes.

### 1.4 Not our user (the half we cut)

| Group | What they would need | MVP decision |
| --- | --- | --- |
| Maintainers with outside contributors | Triage of strangers' issues, replies to authors, review of outside PRs, contributor trust rules | Defer to the maintainer release, exactly one week after MVP launch (§14). One of our first markets. |
| Teams that want hosted infrastructure | Smithers Cloud, billing, usage plans | Defer |
| Enterprises | SSO, audit logs, many repositories, admin consoles | Cut |
| Teams with several repositories in one place | Repository switching, work across repositories | Defer: one repository per install |
| Non-GitHub teams | GitLab, Bitbucket, Linear sync | Cut |
| People who want a browser IDE as their main editor | Project-wide refactoring, extensions and a debugger in the browser | Cut. The File card is a live co-editor for quick changes, with code intelligence. Heavy editing happens through agents, the terminal or your own editor. |
| Linux-server owners | KVM host support | Defer: Apple Silicon Mac first |

## 2. MVP rules

1. **Everything is a flow.** Every button, slash command, agent action, CLI command and API call runs the same typed flow, and the factory's process is a flow in the repository. Any agent (Claude Code, Codex, or another) uses Smithers through the Smithers skill and the `smthrs` CLI. They expose the same command catalog the app agent uses, and the whole API is open source.
2. **One team, one machine, one repository.**
3. **Built is not shipped.** Much of this exists. MVP work is cutting what's out, integrating what's in, and polishing each surface to the §9 bar.
4. **The app is chat plus cards.** Output appears as cards in the conversation, plus one shared home card for the team's work (§6.4). A person can maximize any card.
5. **Honest state.** Requested, queued, working, waiting for you, paused, failed and done are always distinct, and chat never waits for background work.
6. **People merge.** Agents propose. A person's approval, bound to the reviewed revision, is required for anything to reach `main`.
7. **Minimal text.** Show a button, a count, an avatar or a diff instead of a sentence.

## 3. Vocabulary

| Word | Meaning |
| --- | --- |
| **Install** | One Smithers install on one machine, for one team and one repository. Install and docs only; members see the repository name. |
| **Member** | A person on the install's roster: added by a maintainer, or the owner. They must still have write access to the repository on GitHub, re-checked at sign-in and every hour; losing it suspends them. |
| **main** | GitHub's default branch. Read-only in Smithers, with no machine. Work reaches it only through a merged pull request. |
| **Stack** | The repository's one ordered line of changes heading to `main`: Will's "mythical" history. Every TODO is exactly one item on it. Items reach `main` in order, one commit and one pull request each. |
| **TODO** | Committed work, identified as `T12` from the moment it's committed (GitHub's `#n` stays for issues and PRs). It is one stack item, one stable change and one pull request. Its text is the first prompt the coding agent receives. It may link the issue it came from. |
| **Branch** | The single live place where work happens. Each working TODO has its own branch. A member can also fork a scratch branch. Awake, a branch has one machine, shared by everyone on it. |
| **Machine** | The isolated VM an awake branch runs on: its working copy, terminals, services and coding agent. |
| **Issue** | A GitHub issue, where discussion happens. |
| **App agent (Smithers)** | The fast assistant in each branch's conversation. It answers questions and drives the app. Each prompt runs with the authority of the person who wrote it. It appears as a participant with its own avatar, like a person (M-34). |
| **Conversation** | One per branch, shared by everyone on that branch. `main`'s conversation is the team's home and holds the stack. People prompt the agents there; it is not for chatting with each other. |
| **Coding agent** | The agent on a branch's machine that works a TODO. |
| **Run** | One durable execution of a flow. TODO work, questions, stack operations and learning are all runs. |
| **Wiki** | The team's memory: one Markdown vault per repository. People and agents read and write it, and Obsidian can open it. |
| **Flow** | A durable workflow, stored in the repository at `flows/<name>/flow.ts`. The factory is made of flows. |
| **Card** | An embedded view in the conversation: a file, diff, branch, TODO, run, terminal, wiki page, flow or preview. |

```
GitHub: main · issues · PRs
   ▲ merge            │ discussion
   │                  ▼
 Stack: T1 ─ T2 ─ T3 ─ …        (ordered; each item = 1 TODO = 1 change = 1 PR)
         │    │    │
       Branch Branch Branch      (one per working TODO; scratch forks beside them)
       Machine: one working copy; people + coding agent present together
   Wiki (memory)        Flows (the factory: how a TODO is worked)
```

### 3.1 Who acts, and where

Every actor works through flows, and every action renders with the same card whoever performs it. When the coding agent runs a command, it appears in the Terminal card. Its file write appears in the File and Diff cards. Its question appears as Needs you. Each looks exactly as it would if a person did it.

```
 Member's browser            The install (the Mac)                  A branch machine (microVM)
 ┌──────────────────┐        ┌────────────────────────────┐        ┌───────────────────────────┐
 │ app UI           │◀──────▶│ app agent (per branch)     │──ask──▶│ coding agent (per branch) │
 │ UI-only flows    │        │ system: stack, GitHub sync,│        │ files · terminals · tests │
 │ (theme, cards…)  │        │ queue, dispatch, summaries │◀─PR────│ external agents in a      │
 └──────────────────┘        └────────────────────────────┘        │ person's terminal         │
                                                                    └───────────────────────────┘
```

| Actor | Runs in | Acts as | Can | Cannot | Hands work to |
| --- | --- | --- | --- | --- | --- |
| **Member** | Browser, SSH, terminals | Themselves | Everything their role allows (§6.15) | What their role excludes | Any agent |
| **App agent** ("Smithers for Ben") | The install's model host, outside every machine | Whoever wrote the prompt, with a delegated credential | UI-only flows on the prompter's own screen (theme, open/maximize cards, navigate, palette, filters, input mode). Install flows from Appendix A: create, place, steer and answer TODOs; read code, branches, runs and the wiki; open the monitor; propose flow and agent edits as TODOs. | Run anything on a machine (no terminal, no file writes, no commands). Approve, merge, manage people or secrets. Change anyone else's screen. | A branch's coding agent: "run the webhook tests on retry-webhooks" becomes a request to that branch's coding agent, shown as "Smithers for Ben asked". New work becomes a TODO. |
| **Coding agent** (one per awake branch) | The branch's machine, through its coding host | The coding agent, for the TODO's owner | Read and write that branch's working copy (versioned writes). Run commands and terminals on that machine. Run tests and checks. Read web pages and the wiki. Ask a person (Needs you). Propose its change to the stack. | Merge or approve. Touch other branches or machines. Change settings, members or secrets. Edit system flows. `sudo`. Read people's home directories. | People (Needs you). The stack service (propose). |
| **External agent** (Claude Code, Codex, others) | A person's branch terminal or laptop | That person, with a delegated credential | On a machine: whatever that person's terminal can do. Through the Smithers skill and CLI: the same catalog the app agent has. | Approve or merge: the person gets a **Review & merge** confirmation. UI-only flows (it has no screen). | Same as the app agent |
| **System** ("Smithers") | The install | The install | Stack service, the agent in charge of jj (M-32): fork, place, reorder, rebase, propose PRs, and merge after a person's approval, all attributed to it in branch activity. GitHub sync. The admission queue. Learning runs. Wiki refresh. Timeline summaries. Jev decisions. | Anything a person must decide | People (Needs you) |

UI-only flows run only in the member's own browser, for that member. A person or their app agent can call them; coding and external agents cannot, because they have no screen.

Appendix B lists every flow and action with its actors, where it runs and the card that renders it. Anything not in Appendix B doesn't ship.

## 4. TODOs

### 4.1 States

```
 Queued ──▶ Starting ──▶ Working ◀──▶ Needs you ──▶ Queued   (answered after its machine was released)
                           │  ├──▶ Paused ── Resume ──▶ Queued        (Stop)
                           │  └──▶ In review (PR open) ──▶ Merged     (done)
                           │            ├── changes requested or steer ──▶ Working
                           │            └── a rebase conflict the agent can't resolve ──▶ Needs you
 Starting or Working ──▶ Failed ── Retry ──▶ Queued                   (earlier attempts and evidence kept)
 Any unmerged state ──▶ Dropped                                       (a person's action)
```

| State | Meaning | Who acts |
| --- | --- | --- |
| Queued | Waiting, with a reason and position: "waiting for a machine #2". | Nobody |
| Starting | It has a machine, and the coding agent is launching. | Nobody |
| Working | The coding agent is planning, editing or checking. | Anyone on the branch may watch or steer. |
| Needs you | The agent asked a question, needs an approval, or hit a conflict it can't resolve. | Questions: any member. Approvals that gate a merge: a maintainer. The first accepted answer settles it. Others then see "Ben answered", and any unsent draft stays with **Send as steer**. A steer sent while a question is open reaches the agent at once as context. The agent may replace its question with a better one, but only an answer settles it. |
| Paused | A person stopped it. The machine is released once it's safely idle. | Resume or drop |
| Failed | A run stopped on an error. Evidence is kept. | Retry, steer or drop |
| In review | The pull request is open with its evidence. GitHub checks run. | A person reviews and merges. |
| Merged | The pull request merged into `main` on GitHub. **This is done.** | Nobody |
| Dropped | A person abandoned it. Its PR closes, and later items rebase. | Nobody |

Learning is a separate run after a merge. It never changes the Merged state. It shows as a receipt on the merged TODO (for example "2 lessons") that opens the wiki pages and any suggested TODO.

### 4.2 Placement and order

- **Place.** A new TODO is placed on the stack in one of three ways:
  - **Append**, the default;
  - **Before Tn**;
  - **Amend Tn**, which creates no second TODO. It updates that unmerged TODO's prompt and acceptance criteria and keeps its identity, branch, PR and amendment history (shown as "+1"). The work continues on that item's branch.
- **Parallel work.** Items work in parallel, each on its own branch.
- **Rebase.** When `main` or an earlier item publishes a new revision, the later items queue a rebase. On a branch with only the coding agent present, it runs at the agent's next checkpoint. On a branch where people are present, it shows "Rebase pending" and runs when nobody is present, or when someone on the branch presses **Rebase now**. Either way it first snapshots every writer's work and never runs during a write made through Smithers. People on the branch then see "Rebased onto T2" in the activity, and their open cards refresh. A rebase changes the revision, so checks rerun and any earlier approval no longer applies. A conflict the coding agent can't resolve becomes Needs you, with a Resolve action that opens the branch.
- **Merging.** Only the next item in order can merge; later items show "Merges after Tn". **Move up**, **Move down** and **Drop** unblock a stuck item. Each PR is the verified candidate for its item, based on `main` and squash-merged. Only the next item's PR is ready for review on GitHub. Later items' PRs are GitHub **drafts**, so GitHub won't merge them, and they are reviewed in Smithers, where the PR card shows only the item's own change. When an item merges, the next PR is rebased onto the new `main`, contains only its own change, and becomes ready. If someone merges out of order anyway (by un-drafting a PR on GitHub), Smithers shows Needs you: "T3 merged before T2; T2's change is in T3's commit". It marks both merged, with that note on T2, and folds `main`. Stacked PR bases are deferred (§16).
- **Not in MVP:** splitting or squashing across TODOs.

## 5. User journeys

The design mocks these. P0 journeys must play in the first design build. Every capability a P0 journey uses is P0, even where a P1 journey shows it in more depth.

### J1. Install to first merged TODO (P0)

1. The owner installs Smithers on a Mac. `smthrs host start` prints a one-time setup link. The owner opens it on the Mac, or from a laptop if the install is exposed on the network. The link opens a setup session that can only do setup.
2. Setup is one card, in this order:
   1. **Address:** This Mac only, or Network with the public address teammates will use. It comes first because the GitHub App's sign-in callback is registered to it.
   2. **GitHub App,** created in one step with GitHub's app-manifest flow.
   3. **Owner sign-in:** the owner signs in with GitHub through the new App, which completes the ownership claim. They then choose the repository and install the App on it.
   4. **Model access** (§6.5): the fast model (Cerebras by default), the coding model (a provider key or a ChatGPT sign-in), and the AI Gateway key for Jev.
   5. **Prerequisite check:** GitHub allows squash merging. A failed check links to the fix.
3. Smithers mirrors the repository. Questions work as soon as the source is readable.
4. The first machine image prepares in the background, and the card shows **Source ready** and **Machine ready** as separate steps. A repository with no Smithers declarations still gets a working machine: Smithers detects the toolchain and installs dependencies.
5. The owner asks the app agent about the code and gets an answer with file cards.
6. The owner writes a first TODO. It gets a branch, a machine and the coding agent, and a pull request opens on GitHub with its evidence.
7. They review it in the app and merge it.
8. From the Members card they add Ben and Alice by GitHub username. Ben is a Maintainer and Alice a Member. They open the install's address, which the owner set during setup (here, `https://maya-mini.tail1234.ts.net`, which the team serves through `tailscale serve`, as the docs suggest). The owner sets the two secrets the tests need on the Secrets card.

Activation target: an unassisted first merge within 60 minutes of starting the install.

### J2. Issue to merged PR, the core loop (P0)

1. A teammate opens a GitHub issue, and discussion happens there.
2. A member opens the issue card and selects **Make TODO**. The app agent drafts the TODO from the discussion, and the member edits it, places it and commits it. Labeling the issue `todo` on GitHub is a second way in. It commits the issue's current title and body as the prompt, appended to the stack. Smithers records that exact revision and ignores repeated deliveries. Later edits to the issue don't change the TODO.
3. The TODO queues, gets its branch and starts Working.
4. The agent asks one question, which shows as Needs you. The owner and anyone on the branch get a toast; any member can answer.
5. The PR opens with evidence: the diff, the checks run on the machine, GitHub checks, and the agent's review summary.
6. A person merges. The TODO turns Merged, and the issue closes if the TODO says it fixes it. A learning run follows.

### J3. Join a branch (P0, multiplayer)

1. A member sees a TODO in Needs you and opens its branch.
2. The Branch card shows who is there and where each one is (a terminal session, a file, or a run): Alice in the File card, the coding agent, and Maya editing `retry.ts:12` from Cursor over SSH ("Maya via SSH"). Maya's saves appear in open cards as attributed changes. Editors connected over SSH join on save; character-by-character co-editing happens in the File card.
3. The member opens their own terminal on the same machine and runs the failing test. Alice sees the session appear and can watch it.
4. Maya runs `pnpm format` in her SSH session. One activity entry reads "Maya via SSH changed 12 files" and opens the diff. Open cards update in place, and nothing breaks.
5. The member fixes one line in the File card while Alice types further down the same file. Each sees the other's characters arrive live in the author's colour, with a name flag on the line each is editing. The file is saved to the machine continuously, so the agent and terminals see it at once.
6. The coding agent had asked a question, so the branch's input reads "Answer the coding agent", with **Answer** as the primary action and **Steer** beside it. The member answers ("use the existing retry helper"), and the answer settles the question with their avatar in the branch activity. A steer never settles a question by itself. The agent continues on the same working copy.

### J4. The team's work (P0, async)

1. The lead opens Smithers in the morning, in `main`'s conversation. Its home card is the stack: Needs you 2, Working 3, Queued 1, In review 4, and 5 merged since they last looked.
2. They answer one question, merge the next item after reading its evidence, move a ready item above a stuck one, and retry one failure with a steer.
3. Toasts report background progress while they keep chatting. Nothing blocks.

### J5. Teach the factory (P0, everything is a flow)

1. The lead tells the app agent: "Every TODO must run `pnpm test` and update the changelog."
2. The app agent opens the Flow card for the TODO flow (plan, implement, verify, review, propose, then wait for merge) and proposes the edit as a diff.
3. The edit becomes a TODO like any other, and a person merges it. When the install has synced and loaded it, the Flow card shows the new version as Active.
4. TODOs started after that use the new version. Runs already in progress keep the version they started with.
5. Later, a learning run proposes an improvement backed by evidence: "3 of the last 5 TODOs failed lint at review; add lint to the verify step". The lead turns it into a TODO, it merges, and the next TODO passes lint the first time.

### J6. Bring your own agent (P0, steps 1–3)

1. A member opens a terminal on a branch and runs `claude` or `codex`, signed in with their own subscription. The terminal comes signed in to Smithers as that member, and the Smithers skill is installed.
2. Its edits land in the shared working copy. Teammates see them live, and the edits become part of that branch's change.
3. Through the skill, Claude Code reads the wiki, answers the TODO's Needs you, and places a follow-up TODO. Each action shows as "Claude Code for Ben": Claude Code's own avatar in Ben's color (M-34).
4. The same works from the member's laptop after `smthrs login` to the install.
5. Teammates can watch the session but can't use the member's login.

### J7. Plan and fork (P0, jj)

1. A member inserts a TODO before T3, then amends T2's prompt with a follow-up requirement (no new TODO; T2 shows "+1").
2. They fork T2's branch into a scratch branch to try another approach by hand. The fork starts from T2's current revision.
3. The scratch work is better. **Add to stack** makes it a new TODO after T2. The new TODO takes the scratch branch's whole change from the item before the fork point, so it includes T2's work and dropping T2 loses nothing. They drop T2. (Replacing T2's work in place is deferred, §16.)
4. `main` moves, and the stack rebases. The coding agent resolves one conflict and shows what it did.

### J8. Memory (P0)

1. After a merge, the learning run writes a wiki page recording the decision and its reason, with a link to the change.
2. A teammate edits that page in the app while another edits it too. Co-editing is live. They change the decision.
3. The next related TODO's plan cites the edited revision and follows it.

### J9. Ask the repository (P1)

1. A member asks a question ("where do we retry webhooks?").
2. The app agent answers with file, code and wiki cards.
3. The answer offers **Make TODO** and **Save to wiki**.

### J10. Work with GitHub (P0)

1. A TODO reaches In review. Its PR appears on GitHub as `smithers/retry-webhooks`, based on `main`, with the prompt, the evidence and the earlier stack items it includes in the body.
2. A teammate leaves a review comment on GitHub. Within a minute it appears in the branch activity as their steer. The TODO goes back to Working, and the agent pushes a fix that updates the PR.
3. Alice pushes a commit to that branch from her laptop. Smithers never overwrites a person's commit. It holds the agent's next push and shows Needs you: "Alice pushed to `smithers/retry-webhooks` on GitHub", with **Bring in Alice's commit** (the branch rebases onto it at a checkpoint, and the coding agent resolves any conflict) and **Discard Alice's commit** (an explicit choice, with her commit kept in the branch history). Ben brings it in.
4. Someone merges an unrelated PR on GitHub. The `main` row updates, and the stack shows "Rebase pending" on branches with people present; the others rebase.
5. The lead merges the TODO's PR on GitHub instead of in Smithers. The TODO turns Merged, and its issue closes with a link.
6. The `main` row reads "synced 40 s ago" throughout. When the network drops, it turns gold, "synced 6 min ago · Retry".

### J11. Look under the hood (P0, advanced)

1. After a TODO merges, the lead selects **Inspect** on its run card. The monitor opens and shows:
   - the flow's graph with each step's state;
   - each step's input, output and agent transcript;
   - the timeline with retries;
   - the wait for Ben's answer;
   - tokens and time per step.
2. From the TODO flow's card they select **Source**. The flow opens in the File card, and they add a step.
3. **Run** with a test input on a scratch branch shows the new graph live in the monitor.
4. They open the review agent from the Flow card's step and switch its model to a cheaper one on the Agent card.

## 6. Features in the MVP

Status reflects `main` on 2026-10-02:
- **Built:** works today.
- **Partial:** exists, but needs work for this spec.
- **Missing:** must be built.

Section 11 ranks the gaps.

### 6.1 Install and machine

| Feature | Behavior | Status |
| --- | --- | --- |
| Install on a Mac | One install on Apple Silicon macOS runs the backend, PostgreSQL 18 and microVMs (isolation on by default) as a launchd service, reachable at the addresses the owner sets (M-28). The package is rebuilt from the assembler half of the deleted `apps/app/scripts/build-native.ts` (at `5b77095672`), without Electrobun. The Docker image is removed (an engineering ticket): it was never published (#2481; deletion is #3460) and can't host microVMs. The bundle ships the machine base image, so the first machine needs no registry pull. | Missing: no package exists. The launcher binds loopback only and drops the isolation and GitHub settings. |
| Reaching the install | The install doesn't care which address it's reached at. It listens on loopback by default. In Settings the owner sets a bind address and the public addresses (http or https, any host), and SSH listens on the same address on port 2222. The app works on plain HTTP: it doesn't need a secure browser context. HTTPS and remote access are whatever the team puts in front, and the docs recommend `tailscale serve` or a reverse proxy. | Missing (bind settings and secure-context-free app) |
| Machine image without declarations | Smithers detects the toolchain (`.node-version`, `packageManager`, `go.mod` …) and installs dependencies. Declarations only make it faster. The 60-minute activation target covers repositories whose toolchain is detectable from standard files: Node (npm, pnpm, yarn, bun), Go, Rust (cargo) and Python (uv, pip). Other repositories need a declaration first. | Partial: layers need a committed target index. |
| Restart | Completed steps replay without running again. Interrupted external actions (a shell command, a model call, a GitHub write) reconcile their outcome before retrying. A process that can't be recovered shows as interrupted. Terminal processes are not promised to survive a reboot. | Built in the engine; Partial until exercised through J1 to J5. |

### 6.2 Access

| Feature | Behavior | Status |
| --- | --- | --- |
| Team sign-in | GitHub sign-in. Members are GitHub users with write access to the repository. No separate accounts or invitations. | Partial: OAuth exists, but self-host admits only one owner (#1667). |
| Roles | Owner, Maintainer and Member, as defined in §6.15. | Missing |

### 6.3 GitHub sync

Smithers wraps the team's GitHub repository; it doesn't replace it. GitHub stays the home of `main`, issues, pull requests, reviews and checks. Smithers owns TODOs, the stack order, branches' live state (machines, presence, working copies), runs, the wiki and flow configuration. Anything that exists on GitHub links out to it ("on GitHub ↗").

**From GitHub into Smithers**

| On GitHub | In Smithers | Status |
| --- | --- | --- |
| `main` moves (a merge or push by anyone) | The stack queues rebases under the §4.2 rules. The home card's `main` row shows the new commit. Following `main` is on by default for every wrapped repository. | Partial: a repository without `mirror: "pull"` never follows `main` today. |
| An issue is opened, edited or commented on | The issue card updates. **Make TODO** is available on it. | Built |
| An issue gets the `todo` label from a member | A TODO is committed from the issue's current text (J2). | Partial: label admission exists; committing a TODO with its own captured prompt needs §11 stage 1 item 4. |
| A review or review comment on a TODO's PR | It enters the branch activity as a steer, attributed to the reviewer. "Changes requested" sends the TODO back to Working. Agent replies inside GitHub threads are deferred (§16). | Missing |
| Checks finish on a TODO's PR | The PR card and the TODO's evidence update. A failed required check holds Merge, giving the check's name. | Partial: checks are read only on the automerge path. |
| A TODO's PR is merged on GitHub | Same as Merge in Smithers: the TODO turns Merged. Merging out of order is handled as in §4.2. | Partial |
| A TODO's PR is closed without merging | The TODO turns Dropped, with "closed on GitHub by @x". Reopening the PR restores it. | Partial |
| Someone pushes to a TODO's branch from a laptop | Smithers never overwrites a person's commit. The agent's next push is held, and Needs you offers **Bring in** (rebase onto the commit at a checkpoint; the coding agent resolves conflicts) or **Discard** (an explicit choice, with the commit kept in the branch history). | Missing |
| A teammate pushes their own branch or opens their own PR | `/review` works on any PR. **Open on a machine** for teammates' own branches is deferred (§16). | Built (`/review`) |
| GitHub branch protection | Respected. Merge shows GitHub's reason when blocked, e.g. "1 approving review required on GitHub". | Partial |

**From Smithers to GitHub** (through the install's GitHub App, attributed)

| In Smithers | On GitHub | Status |
| --- | --- | --- |
| A TODO reaches In review | One PR on its branch `smithers/<todo-slug>`, based on `main`. Its body holds the prompt, the evidence, and a link back. It is opened by the Smithers app, with "Requested by @owner". It is ready for review only when it's the next item; later items stay drafts (§4.2). | Built (Mythical PRs); drafts are Missing |
| A commit is made on a TODO's branch | It reaches GitHub when the PR is proposed and on every later update. Each item lands on `main` as one squashed commit. | Built |
| Make TODO on an issue | The issue gets the `todo` label and the comment "Committed as T12 ↗". | Partial |
| A TODO merges | The PR is squash-merged, so each item is one commit on `main`. Setup checks that the repository allows squash merging and, if not, shows "Enable squash merging on GitHub ↗". If the TODO fixes the issue, the issue closes with a link to the change. | Built (squash) |
| A scratch branch | Stays in Smithers. Nothing reaches GitHub until the work joins the stack. | Built |
| An agent replies to review comments | Deferred (§16). In the MVP, the agent's response shows as new commits and in the branch activity. | Deferred |

**Freshness and health**

| Feature | Behavior | Status |
| --- | --- | --- |
| No public address | Polling covers refs, issues, PR reviews and checks, and merges made outside Smithers. Targets: PRs, checks and `main` within 1 minute; issues within 5. Webhooks only make it faster. | Partial: `main` and PRs poll every 5 min and issues every 15. |
| Sync status | The `main` row on the home card shows "synced 40 s ago". Past twice the target it turns gold, "synced 6 min ago · Retry". If GitHub refuses (a missing App permission or a rate limit), it names the cause, with the fix on the Settings card. | Partial |
| GitHub App setup | Created during install in one step, using GitHub's app-manifest flow. | Missing |
| `main` rewritten on GitHub | A force push to `main` shows Needs you for the owner, and the stack rebases onto the new `main` once the owner confirms. | Missing |

### 6.4 App shell

| Feature | Behavior | Status |
| --- | --- | --- |
| Home card | The stack, with `main` pinned at the top and items in merge order. Counts act as filters, and the card shows the last sync time and machines in use against capacity. Below the stack it shows background runs (learning, wiki refresh, other flows) that are queued, running, waiting or failed, each with a resumable card. A failed run stays until someone retries or dismisses it. These runs never become TODOs. Every member sees the same home card in `main`'s shared conversation. | Partial (StackCard) |
| Branch conversations (Will) | Each branch is one conversation, shared by everyone on the branch. `main`'s conversation is the team's home and holds the stack, so it is long. Prompts show their author, and cards are shared. Each person keeps their own scroll position and card view state. A branch tree navigates between conversations: a branch, the branch it forked from, and its children. ⌘K opens the composer and palette in the current branch's conversation. | Partial: today each member has their own conversation per repository. |
| No chat between people | People don't message each other in the app; they use Meet, Slack or whatever they already use. In Smithers they coordinate through presence, live edits and branch activity. | Decision |
| Commands | Slash commands, the palette and agent tools list only MVP flows. Debug and admin commands never reach members. | Partial: the catalog is too wide. |
| Toasts for events (Will) | Notable events and anything that needs action pop as toasts with their one action: approvals, Needs you, a PR ready, a failure. Each person can hide them. Every toast also stays as an entry in the timeline. Live work in cards scrolled out of view shows on the left edge: above at the top-left, below at the bottom-left. | Partial (the toast stack is built) |
| Timeline (Will) | Desktop only, between the two toast edges: one line per transcript entry. Each line has a title and a one-line summary of what happened there, written by the install's cheap fast model and refreshed as the entry's run progresses (debounced), e.g. "Agent: edited retry.ts line 14" or "Asks: backoff or timeout?". Live entries pulse, Needs you is gold and failures are ember. A band marks the entries on screen, and clicking an entry scrolls to it. On narrow screens and phones there's no timeline; each edge collapses to one pill ("↑ 2 live above"). It replaces the per-run ChatRunTimeline strip; the run card keeps its own scrubber. | Missing: needs a stored one-line summary and live tone per conversation entry |
| Browser notifications (Fable for Will) | When the tab is hidden, a Needs you, In review or Failed toast for that person also raises a browser notification. There is one permission ask, at the person's first Needs you. Browsers allow notifications only on HTTPS or `localhost`. On a plain-HTTP address the toast still shows, the Allow action is hidden, and Settings shows one line: "Notifications need HTTPS", linking to the docs. Email and phone come later (#3423). | Missing |
| Input and theme | Normal, Vim and dictation input, keyboard-only throughout, and the light and dark Paper palette. Both themes gate acceptance (§12). | Built |

### 6.5 App agent

| Feature | Behavior | Status |
| --- | --- | --- |
| Models | Three roles, set in Settings. A **fast model** (Cerebras by default) runs the app agent and writes timeline summaries; it is what makes the app agent "very fast". A **coding model** runs the coding agent: a provider key or a ChatGPT sign-in. **Jev** makes typed decisions through the AI Gateway key. J1 asks for all three. Without a fast-model key, the app agent uses the coding model and is slower. | Partial: model routing exists; the fast-model role and setup are missing. |
| Answers | Answers questions about the repository with cards. Jev chooses the commands it needs. | Built. Self-host needs an owner default model and an AI Gateway key. |
| Context preflight (Will) | A conversation isn't the agent's context window. Before answering, the agent runs a preflight that chooses what to add to its context: files, wiki pages, TODOs, runs. An answer carries a small "Context · 4" chip that expands to list what preflight added. Inspect shows the preflight as its first step. This is what keeps `main`'s long conversation usable. | Partial: Jev's command selection and the coding agent's `memory` flow exist; an app-agent context preflight and the Context line are Missing. |
| Drives the app | Calls the same flows a button calls, through one tool. Missing inputs become a form card. | Built |

### 6.6 TODOs and the stack

| Feature | Behavior | Status |
| --- | --- | --- |
| Create | From chat, from an issue (**Make TODO**, drafted from the discussion), or with the `todo` label on GitHub. Placed by Append, Before Tn or Amend Tn. | Partial. Today a TODO is a GitHub issue labeled `todo` by a maintainer, its prompt is the issue body, and chat items exist. |
| TODO card | Prompt, state, place, branch, owner, the flow's steps with the current one lit, the question inline, evidence, PR, and Merge. The prompt is editable while Queued. | Partial |
| Parallel work | Several items work at once, each on its own branch. The stack rebases later items. | Built: Mythical lanes, default 2. |
| Order | Move up, move down, drop. Only the next item merges. | Partial |
| Steer | Any member sends a message into a working TODO, and the agent continues with it. | Missing for stack lanes |
| Stop and resume | Stop pauses; Resume continues from the last finished step. | Partial |

### 6.7 Branches and machines

| Feature | Behavior | Status |
| --- | --- | --- |
| One live branch | One workspace per repository and branch. Every member and the coding agent who join reuse it. | Missing: today each person gets their own workspace per branch, and the agent path can fork a separate one. |
| Branch card | Presence, machine state, the item it works and its place ("3rd in stack") or "scratch", then activity, files and terminals. | Missing: it is spread over three unrelated cards today. |
| Fork | A scratch branch from `main`, an item, or a branch. **Add to stack** turns its work into a TODO. | Partial: the backend can fork, but there is no member-facing flow. |
| Sleep | An idle branch sleeps with its disk kept. Reading a sleeping branch uses retained snapshots and never wakes it. Only work wakes it: a terminal, a TODO, a steer or an edit. | Partial: file reads can wake a machine today. |
| Capacity and queue | One admission queue for TODO work and for people waking branches. Each entry shows its reason and position. People go first (M-13). Branches that are idle, waiting or in review release their machine once safely idle. | Missing: the runtime refuses at capacity. |
| Cleanup | A machine is deleted only after its TODO is settled, its work is captured durably, and no terminal or service is active. Uncommitted work is saved first. History and evidence are kept. | Partial: stopped disks are reclaimed after 24 h without capturing everything first. |

### 6.8 Multiplayer on a branch

| Feature | Behavior | Status |
| --- | --- | --- |
| Presence (Will) | Every participant doing work shows on the branch exactly like a person: people; Smithers, the app agent (its own avatar); the coding agent; external agents such as Claude Code; and reviewers. Each shows its avatar and where it is (a terminal session, a file and line, a run). When Smithers works for someone, its avatar carries "for Ben". | Missing: Pair's presence API was removed in `2753d2e3d2`. |
| Live co-editing | The File card is a live co-editor for code, built on the Yjs collaboration the wiki already uses. Keystrokes reach everyone with the file open in under 1 s, each person's characters in their colour, with a name flag in the gutter on each editor's line. The live document saves to the working copy continuously, debounced, so the header shows "Saved to the machine" and there is no Save button. Writes from the coding agent and from terminals enter the document as attributed edits. | Missing: a new system. The wiki's Yjs sends HTTP updates with an SSE refetch, has no presence, and keeps the document in the API, not on the machine. |
| No silent overwrite | Every write through Smithers (agents, the app) carries the version it was based on. A write that would replace a newer version is refused, and the writer re-reads and retries: the coding agent does this automatically, and the File card never needs to because it is the live document. Writes that bypass Smithers, such as an editor in a terminal saving an older copy, are recorded with their author and recoverable from the branch's snapshots. Flagging them ("Ben's save replaced Alice's edit") is deferred (§16). | Missing (stage 1 contract: `base_digest` on every write, stale write refused) |
| External changes | Anything can change the machine's files: SSH editors, terminal tools, formatters, package managers, or `git` and `jj` run by hand. The app handles all of it without breaking. The machine watches the working copy. Changes made through Smithers carry their exact author. A change from a terminal or SSH session is attributed to that session's person when only one person's session was active on the branch; otherwise it reads "changed outside Smithers". Exact per-write attribution of terminal changes is deferred (§16). <br>• Branch activity groups each burst into one entry, e.g. "Maya via SSH changed 3 files", which opens the diff. <br>• An open File card applies the change live. A deleted or renamed file says so ("Deleted by Maya via SSH · Restore", "Renamed to `deliver.ts` · Follow"). <br>• Hand-run version control that moves the working copy off its item shows Needs you: "Maya moved this branch off T2". **Return to T2** puts the working copy back on the item's commit, and anything written since stays recoverable. **Keep for now** records the move and holds the TODO in Needs you until the working copy is back on T2. <br>• The coding agent re-reads changed files before writing. <br>• Ignored paths never show as edits. <br>• Every change is recoverable from the branch's snapshots. <br>The command name on each entry, per-entry Undo, and flags for a save that replaced someone's edit are deferred (§16). | Partial: commit-level head updates every 2 s and snapshots every 30 s. |
| Save and recovery guarantees | **Saved:** a co-edited file reaches the working copy within 1 s of a keystroke, and every save survives a restart. **External save to an open file:** it is merged into the live document as an attributed edit. If it overlaps unsaved typing, the live document wins on disk, the external version is kept as a snapshot, and the file shows "Changed outside Smithers · Compare". **Capture:** external changes are snapshotted in bursts, ending 1.5 s after the last write and at most every 10 s. Each burst's end state is recoverable; intermediate states inside one burst are not guaranteed. Writes through Smithers are versioned individually. **Restore:** an external-change entry opens its diff, where **Restore this file** puts one file back to its state before the burst, as a new attributed edit. Undoing a whole entry is deferred (§16). | Missing |
| Live updates | File, diff and branch cards update when the working copy changes, showing who changed what. | Missing: only commit-level head updates exist. |
| Terminals | Each person's terminal and SSH session runs as that person on the machine, in a home directory that belongs to that machine alone. No two machines ever share a home (spike T-MCH-02: sharing lost data). A person logs in to a tool like Claude Code once per install. Smithers keeps each member's tool credential files (Claude Code, Codex, `gh`, git identity) in a per-member store on the host. It seeds them into every machine's home at wake and whenever the store changes, and copies refreshed credentials back, with the newest write winning. Tool history, caches and databases stay on their machine. A member added while a machine is awake gets a home on it immediately. Anyone on the branch can watch any session; only its owner types. Ask to type is deferred (§16). | Partial: terminals can stream to several viewers; per-person homes and the credential store are missing. |
| Shared agent activity | The coding agent's transcript, steers from any member (with the author shown), and runs are visible to everyone on the branch. | Partial |
| Not in MVP | Carets and selections of other people inside files. The gutter name flag shows where each person is. | Cut |

### 6.9 Coding agent

| Feature | Behavior | Status |
| --- | --- | --- |
| Works TODOs | Runs the repository's TODO flow on the branch machine: route, plan, implement, check, review, open PR, and address review comments. It reads the wiki before planning and cites the page revisions it used. | Partial. Built for configured repositories (`coding/request` → `factory/Todo` → implementation → verify → PR); routes need `.smithers/coding-project.json`. A fresh repository needs automatic configuration (§11, stage 1 item 6). |
| Model access | The install's model access is the owner's, connected during setup: provider keys, or a ChatGPT subscription sign-in. Every TODO run records the model access it used. Members' personal subscriptions are used only in their own terminals. | Partial: the ChatGPT pool is behind a flag on self-host. |

### 6.10 Review and merge

| Feature | Behavior | Status |
| --- | --- | --- |
| PR card | The diff, checks run on the machine, GitHub checks, the agent's review summary, the TODO it came from, and **Merge** (enabled only for the next item). Merge records the person's approval of the exact revision they reviewed. | Partial: approval gating is built (D-23). |
| Line comments | Deferred (§16). In the MVP, people comment on the PR on GitHub, and their comments arrive as steers (§6.3). | Deferred |
| Agents can't merge | No agent credential can merge or move `main`. | Partial: agent merge restrictions exist, but delegated credentials must cover the app agent, the CLI and terminals (§6.13). |

### 6.11 Wiki

| Feature | Behavior | Status |
| --- | --- | --- |
| Pages and editing | Read and edit in the app, with live co-editing (Yjs), backlinks and outline. | Built |
| One vault for both agents | The app agent and the coding agent read the same vault. Planning records the page revisions it cited. | Partial |
| Obsidian | The vault syncs both ways with a folder on the install's Mac (`wiki_sync.obsidian`, which exists behind the wiki feature flag), so Obsidian on that Mac opens it directly. Teammates on laptops use the wiki in the app. Laptop access over git comes later (§16). | Partial: folder sync exists, configured in the config file only; it needs a Settings control. |
| Generated pages | Pages describing the code refresh after merges. Kept, because they're built and planning reads them. | Partial: built where the repository declares pages; a fresh repository needs a default declaration (§11, stage 1 item 6). |

### 6.12 Flows and the factory

| Feature | Behavior | Status |
| --- | --- | --- |
| Default flows | Smithers ships the TODO flow, the learning flow and the stack operations built in. The configuration they need is generated and stored in the install, not committed to the repository. | Partial: the flows are built (except learning), but they need repository configuration today. |
| Flow card | A flow's steps and prompts, with proposed, merged and active versions told apart. Each run shows the step it's on. | Partial: there is a read-only flow viewer. |
| Change the factory | Ask the app agent to change a flow. Only the TODO, learning and review flows, plus any flow the repository adds, can be overridden. A first edit copies the built-in into `flows/<name>/flow.ts`, where the repository's copy wins. Every edit is a TODO a person merges. Overridable flows are repository code, so they always run inside a machine. | Missing: no command edits an existing flow from chat. `/flow.create` is built. |
| Pinned versions | Each run records the exact flow revision it used. A merged customization becomes **Active** once the install has synced it and loaded it successfully. It applies to TODOs started afterwards, while running TODOs and their retries keep their own version. A failed TODO offers **Retry** (same flow version) and **Retry with the current flow** (a new attempt on the active version, keeping the TODO's identity and evidence). Until it's active, the Flow card shows "Merged · active after sync". If loading fails, the previous version stays active and the card shows "Merged · not active" with the error. | Partial: today a TODO runs as four separately launched runs. The single durable `todo` run per attempt (engineering T-FLW-11) is substantial work, and the failed-refresh bug (`Executable.ts:2036`) must also be fixed. |
| Learning | After each merge, the learning run writes source-linked decisions to the wiki and proposes flow improvements, backed by evidence, as suggested TODOs. A member decides each one. | Missing: `improve.mine` is declared only. Pending notes from failed checks are Partial. |
| Run any flow | Repository flows appear as slash commands with typed input forms. | Built |

### 6.13 Your own agents, the CLI and the API

| Feature | Behavior | Status |
| --- | --- | --- |
| Smithers skill | One skill, which carries the command catalog the app agent uses, so Claude Code, Codex or any other agent can work with Smithers. | Partial: incur generates skills from commands; one shared app-and-CLI catalog is still needed (§11 stage 1 item 8). |
| CLI | `smthrs` exposes every MVP flow through the shared command catalog, with typed input. Branch terminals sign in automatically and laptop agents sign in with `smthrs login`. Both use delegated credentials attributed to the member and the agent. Those credentials can't approve, merge or move `main`. A command that needs a person's approval opens a confirmation in the app, bound to the reviewed revision, which agent processes can't reach. | Partial: incur generates the CLI and skills, but the app (271 commands) and the CLI (205) keep two catalogs. M-21 holds once they are one (§11). Delegated agent credentials are Partial too: personal tokens still classify as people. |
| API | The whole HTTP API is open source and documented, and it is the same API the app and CLI use. | Built |
| Attribution | Actions taken through any agent are recorded as the person, with the agent named. | Partial |

### 6.14 Advanced: one click away

These primitives come from the API, and we expose them because "everything is a flow" is the product. They are never on the first screen. Each is one click from a core card and is found after using the core flows: **Inspect** on a run, and **Source**, **Run** and the agent behind a step on a flow. `/help` lists them in a collapsed Advanced group, and the palette finds them by search. One dismissible hint after the first merged TODO points at **Inspect**. No other promotion.

| Primitive | Behavior | Door | Status |
| --- | --- | --- | --- |
| Monitor | The debug view of any run. It shows the flow's graph with live step states and each step's input, output and agent transcript. It also shows the timeline with attempts and retries, durable waits (what a run waits for, and since when), the journal of events, and tokens, time and cost per step. Replay scrubs recorded state read-only (no fork or rewind). Phases (Will): the run's timeline is broken into phases by what the agent was doing. Phase boundaries and titles are deterministic (the step plus its output, e.g. "Ran checks · 1 failed ×3"). Under each phase title, the cheap fast model writes a one-line summary, and every cell an agent wrote gets a human-readable explanation, both marked as summaries. If a summary isn't ready or fails, the deterministic label stands alone, with no error state. A **Thrashing** flag marks an attempt where the same check failed 3 times with no edit, in between, to the files that failure names. It's a deterministic rule with no model, shown on the TODO card and the Inspect phase so a person knows where to look. A flow can declare a custom view that the monitor shows. | **Inspect** on any run card or TODO step; `/monitor` lists every run. | Partial (run trace, graph, timeline and DevTools exist; DevTools is admin-only) |
| Write flows | Create a flow with the agent's help (`/flow.new`), or open an overridable flow's source in the File card and co-edit it. Preview its plan before running, and run it with typed input on a scratch branch. A flow merges like any change. | **Source**, **Plan** and **Run** on the Flow card | Partial (create-flow and the plan view are built; source editing uses the File card) |
| Configure an agent | An Agent card for each agent the factory uses: planner, implementer, reviewer, and the app agent. **Instructions:** Markdown files in the repository; the TODO flow's prompts for the coding agents, and `.smithers/instructions/app.md` for the app agent. Edits are proposed as a TODO and merged, and they apply to work started afterwards. **Tools and permissions:** declared in the overridable flow's source (M-30), changed the same way. **Model:** an owner setting that applies immediately. The card also shows the runs the agent took part in. Budget editing is deferred (§16). | Agent chip on a flow step or a branch's coding agent; `/agents` | Partial: restore the owner-only model configuration (`model.*`, `ModelCards.tsx`) from `5b77095672`, without the lab. App-agent instructions file is Missing. |
| Triggers | Deferred (§16). | — | Partial |
| Machine | Deferred (§16). SSH covers hands-on access. | — | Partial |
| Signals and approvals | Every durable wait or approval the factory holds is visible in the monitor. Sending typed signals by hand is deferred (§16). | **Inspect** → wait | Built |

Raw developer tools stay hidden from members: seams, network inspectors, sync operations, the admin console.

### 6.15 Access, secrets and SSH

These are the GitHub-style basics without which most teams can't do useful work.

| Feature | Behavior | Status |
| --- | --- | --- |
| Members and maintainers | A Members card lists everyone with access and their role. A maintainer adds a person by GitHub username. That person must already have access to the repository on GitHub; otherwise the card shows "needs access on GitHub ↗". There are no invitations: the person signs in with GitHub. Maintainers change roles and remove people. Removing someone ends their sessions, terminals and SSH access. Their TODOs keep their history, and any maintainer can take one over. When a maintainer adds a person, the role defaults from their GitHub permission (admin or maintain becomes Maintainer, write becomes Member). After that, the Members card is authoritative. | Missing (self-host admits one owner; orgs, teams and collaborators exist in the backend but are blocked) |
| Roles | **Owner:** installed it; everything, plus install settings (model access, machine capacity, GitHub App, upgrade). **Maintainer:** merges, manages members and roles, sets secrets, and merges flow and agent changes. **Member:** everything else: create, place, steer, answer and drop TODOs; join branches; terminals; SSH; co-edit; fork; comment; run flows. | Missing |
| Secrets | A Secrets card. Maintainers add, replace and delete secrets. Values are write-only: everyone sees names, nobody reads values back. Each secret is available to every branch's machine as an environment variable, or is main-only (D-24): reaching only trusted runs on `main` and never agent or outsider runs. Provider keys for models stay on the host (§6.9). | Built (CRUD, main-only scope, egress binding); Partial (card polish) |
| SSH into a branch | The Branch card's **SSH** button copies one line, `ssh -p 2222 retry-webhooks@<install host>` (macOS Remote Login owns port 22), using the install's public host name, or `smthrs ssh retry-webhooks`. The person lands as themselves, in the branch's working copy on its machine; connecting wakes it under the admission rules. Keys come from the member's GitHub SSH keys automatically, or from keys added with `smthrs ssh-key`. VS Code, Cursor and Zed remote editing work. Port forwarding (`-L 3000:localhost:3000`) previews a running app. Saves arrive in the live document as attributed edits, and presence shows "Maya via SSH" with the file being edited. Nobody on a machine has `sudo` (M-29). | Partial (the SSH server with workspace sessions is in the open backend and serves Cloud; the self-host binary doesn't start it, and it isn't documented) |

## 7. Decisions

| ID | Decision | Why |
| --- | --- | --- |
| M-01 | A TODO is done when its PR merges into `main` on GitHub. | GitHub is where the team already trusts `main`. |
| M-02 (Will) | On a shared branch, the File card co-edits live, like the wiki, on a new collaborative-document layer on the machine. It saves to the working copy continuously, and agent and terminal writes enter as attributed edits. Writes through Smithers carry the version they were based on, and one that would replace a newer version is refused: the writer re-reads and retries, so nothing is silently overwritten. Out-of-band saves (an editor in a terminal) are recorded and recoverable from snapshots. Gutter name flags replace carets and selections. It is in the MVP, and the engineering architecture supports it from stage 1, although it is built in stage 3. | Will: on the same branch it "feels like a CRDT". Co-editing "forces us to architect the engineering up front to support it, and it's a holy shit feature that really makes the value prop clear". |
| M-03 | No public address is required. Smithers polls GitHub (§6.3 targets); webhooks only make it faster. | The team's Mac sits behind NAT. |
| M-04 | Self-improvement goes through review. Memory goes to the wiki; process changes reach flows only as merged TODOs. | A factory that rewrites itself unreviewed can't be trusted. |
| M-05 | Three roles: Owner, Maintainer and Member (§6.15). Access needs a place on the roster (added by a maintainer) plus live write access on GitHub, re-checked at sign-in and hourly; losing write access suspends the member. Maintainers merge, manage people and set secrets. Members do all other work. Agents never merge, and a person's approval binds to the revision they reviewed. | Will asked for maintainer management. Without a roster, every write collaborator in a GitHub organization would get machines and SSH. The maintainer release (§14) needs the maintainer role. |
| M-06 (Will) | Capacity is derived from the detected host (memory, cores, disk), reserving memory for macOS and the install first. It is never tied to a Mac model. Everything beyond capacity queues visibly. | A fixed 3 × 8 GiB fills a 24 GB host before macOS and the backend, and hosts differ. |
| M-07 | One stack per repository. TODOs are placed by Append, Before or Amend, and each TODO is one change and one PR. | This is Will's Mythical rule (AGENTS.md), and it's built. |
| M-08 (Will; shared reading ratified by Fable for Will) | Each branch is one shared conversation, and `main`'s is the team's home. There is no person-to-person chat in the app. Prompts carry their author's authority, and UI-only flows affect only the prompter's own screen. | Will: "each branch is one conversation… you can navigate around the tree structure" and "no chat in the app for now; users can just chat on Google Meet or whatever". |
| M-09 | Smithers Cloud, billing and plans are out of the MVP. | Our user self-hosts and brings their own model access. |
| M-10 | Apple Silicon macOS is the only supported host. | It matches the user's machine and the microVM path. |
| M-11 | Default flows are built in. The repository holds `flows/<name>/flow.ts` only after the team customizes it. | Installing must not require a pull request into the user's repository. |
| M-12 | This spec replaces `docs/mvp/PRODUCT.md` once Will signs off. Inbound references and AGENTS.md rules are updated in the same change. | One product spec. |
| M-13 | People go before agents for machines. A person's waking action takes the next free machine ahead of queued TODOs. A working agent is never paused to free one. | J3 must work when the team is busy. |
| M-14 | Needs you toasts go to the TODO's owner and anyone on its branch. Everyone else sees it on the home card. | The person who asked for the work answers by default. |
| M-15 | Learning is a receipt on a merged TODO, not a state. | Nothing moves after done. |
| M-16 | A TODO is its own object, a stack item with its own prompt, not a labeled issue. An issue can create one, and the `todo` label stays as a second way in. | Issues are discussion; TODOs are committed work (overview). |
| M-17 | Self-host becomes multi-member, superseding #1667's single-owner model. The parts of Pair this spec needs (shared workspace access, presence) return, superseding the hold on #3401 for those parts only. Branch locks (one holder per branch) are removed. | Multiplayer is the product. |
| M-18 | Each person's terminal and tool logins are theirs. Others can watch but not type (Ask to type is deferred). Provider keys stay on the host, and scoped credentials may enter the machine. | A shared machine must not share personal subscriptions. |
| M-19 | No public benchmark claim at launch without a sealed, paired run with published method and artifacts (#1846). | AGENTS.md rule. The current best evidence is a tie: Smithers and Codex CLI each resolved 34/43 on a 45-instance SWE-bench Verified subset, with Smithers' model cost about two-thirds of Codex's. But the Smithers arm wasn't network-sealed, and the Codex cost was modelled. |
| M-20 (Will) | Maintainers with outside contributors are deferred, not cut. Their release ships exactly one week after the MVP launch (§14). | They are one of our first markets. |
| M-21 (Will) | Any agent can drive Smithers: Claude Code, Codex, or others. It uses the Smithers skill and the `smthrs` CLI, which incur generates from the same commands the app agent calls. The entire API is open source. Actions are attributed to the person, with the agent shown as a participant ("Claude Code for Ben", M-34). | Agent parity extends beyond our own agents. |
| M-22 | GitHub keeps `main`, issues, PRs, reviews and checks; Smithers keeps TODOs, stack order, live branches, runs, the wiki and configuration. Events flow both ways as in §6.3. Scratch branches never reach GitHub until they join the stack. A merge or close on GitHub counts the same as one in Smithers. | The team's GitHub stays clean and authoritative. Smithers adds the live layer on top. |
| M-23 (Will; scope ratified by Fable for Will) | Advanced primitives ship in the MVP: the monitor, writing flows, and configuring the factory's agents. Each is one click from a core card and absent from the first screen. Triggers and the Machine view are deferred (§16). Custom-agent screens removed by D-11 return only as configuration of the factory's agents. | Everything is a flow, so its primitives are the product's depth. Product judgment keeps them out of the way until someone has used the core loop. |
| M-24 | SSH into a branch's machine is in the MVP: one copyable line, GitHub SSH keys, landing as yourself in the shared working copy. Editors connected over SSH contribute on save, as attributed edits; live keystroke co-editing is the File card's job. | Most engineers do real edits in their own editor. Without SSH, people can only use the browser and terminal cards, which blocks more than half of users from editing on a shared branch. |
| M-25 | Secrets are in the MVP. In-app line comments are deferred (§16); GitHub review comments arrive as steers. | Without secrets, tests that need credentials fail on the machine. GitHub's review UI already serves line comments, and reviewers' comments reach the agent. |
| M-26 | Every MVP install upgrades in place, preserving data, with one owner command (`smthrs host upgrade`; also `start`, `stop`, `status`, `backup`, `restore`). | The maintainer release ships seven days after launch, so every alpha install must take it. |
| M-27 (Will) | External changes to a branch's files are handled without breaking anything, and shown. The machine watches its working copy. Writes through Smithers carry their exact author; other changes are attributed to the single active session's person, or read "changed outside Smithers". Recovery follows §6.8's guarantees: each burst's end state, plus Restore this file. Per-entry Undo, replaced-edit flags and exact per-write attribution are deferred (§16). | Will: there should be "UI that shows an external party edited file system… without things breaking". |
| M-28 (Will) | The install works at any address. It binds loopback by default; the owner sets a bind address and public addresses (http or https) in Settings. The app works on plain HTTP. HTTPS and remote access are the team's choice, and the docs recommend Tailscale or a reverse proxy. | Will: "Tailscale isn't part of our product; it's just how teams practically will often use it." |
| M-29 | Nobody on a branch machine has `sudo`: not members, not agents. System packages come from toolchain detection and the image declaration. Adding one is a change ("Add to machine image"), reviewed like any other. | Personal logins are isolated by user, which `sudo` would defeat. An agent steered by untrusted text must never be able to read a teammate's tokens. |
| M-30 (ratified by Fable for Will) | Only the TODO, learning and review flows, plus any repository flow, can be overridden. The app agent's instructions are a Markdown file, data rather than code, because the app agent runs on the install. Stack operations, merge, members and settings are system flows that can't be overridden. | Customization must never weaken "people merge" or stack order. |
| M-31 (Will) | Once stage 1 passes its parts of J1 and J2 (§11), Smithers' own development moves onto the stack on Will's Mac mini, and `issue-sweep` stops pushing straight to `main`. | The dogfood target (§10) only counts if we stop using the side door. |
| M-32 (Fable for Will) | The stack service is the agent in charge of jj, as Will described: the only writer of branch history. Every fork, place, reorder, rebase and merge is attributed to it in branch activity. The app agent and the buttons delegate to it, and the coding agent resolves conflicts. jj operations are never free-form model output. | Will: "There is an agent that is in charge of doing jj stuff." One writer keeps history safe (AGENTS.md: only the stack service writes the stack). |
| M-33 | Smithers never overwrites a person's commit. A push from outside Smithers to a TODO's branch holds the agent's push until a person chooses Bring in or Discard. | A wrapper that discards a teammate's push is worse than plain GitHub. |
| M-34 (Will) | Any agent doing work appears as a participant in the workspace, just like a person. That includes Smithers, the main agent you talk to on the fast model, as well as the coding agent, external agents and reviewers. Each has its own avatar in presence, activity, line flags and terminals. When an agent acts for a person, its avatar shows "for Ben" in place of the old "Ben via Smithers" badge. | Will: "make it so any agent doing work including smithers… should be shown as participating in the workspace just like a human." |
| M-35 (Will, via the frontend lead) | Docs live in the app as their own flow (`/docs`), rendered from one Markdown source per page. The standalone docs site is removed. The README and one install page on smithers.sh stay, because you can't read in-app docs before installing. An in-app page describes only what its build does, with no availability labels; each feature's lane adds its page section in the same commit as the feature. Only the install page labels planned commands, until the first release ships `smthrs host`. | Will: "remove the docs completely and make it just a part of the app; /docs should be its own flow in the app." |
| M-36 (Will, via the frontend lead) | An in-app API playground (`/debug-api`) lets a person try any call in the open API. It's an advanced primitive, one click away (§6.14). | Everything is a flow, and the whole API is open; the playground is the lowest-level door. |
| M-37 (Fable for Will, 2026-10-02) | After stage 1, every S and M ticket runs as a TODO on the install. Only the L tickets on the stage 2/3 spine may run as diff-back lanes outside the stack, and their share of merged changes is reported daily as "outside the stack" against the §10 kill signal. Remote machines for the install stay deferred (M-06, M-09). | M-31 moves development onto the install, and a Mac mini runs 2–3 TODO machines. Building stages 2 and 3 is the bootstrap AGENTS.md allows outside the stack; everything else is dogfood. |
| M-38 (Will, 2026-10-02, via his assistant) | When someone runs Claude Code or Codex in a terminal on a branch machine, the app shows that agent's conversation in the same chat components as our own agents, read-only, with the agent as a participant (M-34). One adapter per agent turns its transcript into our chat and event model. Stage 2, beside terminals and presence. Our own internal `/ceo` flow, Will's brief page composed from the app's shared components, is built on the install after stage 1 as dogfood of custom flow UI. It's a repository flow, not a product surface. | Will: the adapters are "work we need done anyway". External agents are first-class (§6.13), and a person should see what any agent on the branch is doing in one place. |

## 8. What we cut

"Cut" means delete from the product surface; libraries stay published on npm, each with its README and colocated `docs/` in the package (the per-library docs sites go with the standalone docs site, M-35). "Defer" means hide now and keep for later. "Hide" means members never see it, but the system still uses it.

| Existing feature | Decision | Reason |
| --- | --- | --- |
| Five-job setup UI (setup tiles and cards, evals, trials, activation wizard) and the CI, Feature and Chores jobs | Cut | TODOs and their flow replace them, and customizing replaces setup. The issue and review machinery (event admission, dispatch, reproduction, review, approvals) stays for §14. |
| Automatic triage, duplicate search and reproduction on new issues; replies to authors | Defer to the maintainer release (§14) | These serve outside contributors. Hide them for the MVP; keep the code. |
| Review of outside PRs | Defer to the maintainer release (§14) | The TODO flow reviews its own work; outside PRs come one week later. |
| Contributor trust rules (agent-filed issues, outsider runs, approved-source revisions, main-only secrets) | Keep and enforce from launch | Public repositories and credentialed agents exist at launch. Required approvals stay visible. |
| CI setup, AI-check setup as a separate job, CI matrix | Cut | GitHub checks are the checks. Teams add checks by editing the TODO flow. The check flows that the TODO flow's verify and review steps run (`checks/*`, `coding/*Check`) are kept. |
| Dispatcher screen, chores, triggers | Cut as a screen; triggers deferred (§16) | Triggers return later as an advanced primitive on the Flow card. Event admission and dispatch stay running for GitHub events and §14. |
| Repository registration and admin review | Cut | The owner adds their own repository at install. |
| Smithers Cloud hosting, billing, balance, plans, checkout | Defer | Our user self-hosts. |
| Admin console (access queue, allowlist, balance grants, service health) | Cut | Owner settings replace it. |
| Signup poll, first-run checklist, five job tiles, practice repository | Cut | J1 replaces them. |
| Repository switching and multi-repository management | Defer | One repository per install. |
| Issue-sweep / burndown | Cut from the product | Our own operations tool; the home card is the product version. |
| Cloud agent sessions outside TODOs | Cut | Coding agents live on branches. |
| Subagent grid | Cut | The home and Branch cards replace it. |
| Branch locks (one holder per branch) | Cut | They contradict a shared branch. |
| Workspace Services, Egress and Environment-images views | Defer (§16) | SSH covers hands-on access to the machine. |
| Commit-list and branch-list cards modelled on GitHub | Merge | Into the home and Branch cards. |
| Splitting and squashing across TODOs | Cut | They break TODO identity. |
| Lanes, bootstrap and backfill controls | Hide | Plumbing. The parallel-work count is one owner setting. |
| Sync-ops and raw devtools (seams, network) | Hide | Developer tools. The member-facing debug view is the monitor (§6.14). |
| Notifications center | Cut | Toasts and the timeline replace it. |
| TUI | Defer from launch (Fable for Will) | The browser app is the MVP surface. The Terminal card, the CLI and the skill are the terminal doors, and users bring Claude Code or Codex into the Terminal card. |
| CLI and Smithers skill | Keep | This is how any agent uses Smithers. incur generates both from the same commands. Command groups outside the MVP flows stay published but are left out of MVP docs and acceptance. |
| Webpage reader card; code intelligence in file cards | Keep | Built, and useful as evidence and in review. |

## 9. Quality bar

Targets are p95 on the reference host: a 32 GB Apple Silicon Mac mini, with the browser on the same network.

| Area | Target |
| --- | --- |
| App agent | First token under 1.5 s. An answer with cards under 8 s for a question that needs no machine. |
| Branch wake | Warm wake under 5 s. A cold first image is reported as progress, not a spinner. |
| Live updates | Keystrokes in a co-edited file reach every viewer in under 1 s. A disk write from an agent or terminal reaches open cards in under 1 s. |
| GitHub freshness | PR, checks and `main` within 1 minute of the change on GitHub (§6.3). |
| Durability | Killing the install mid-run re-runs no completed step. Interrupted external actions reconcile their outcome before retrying, and every run resumes or shows as interrupted. |
| Honesty | No state is shown before it's true. A failure names the failing step and can be retried. |
| Keyboard | Every P0 journey completes with the keyboard alone. |
| Copy | Product words only. No explanatory paragraphs on cards. |
| Isolation | Each awake branch is its own microVM, on by default. Provider keys stay on the host. Agents can't merge. Nobody has `sudo` on a machine. (Today self-host runs flows as trusted processes, and the launcher drops the isolation setting.) |

## 10. Success and kill criteria

The alpha is the Smithers team, then three outside teams that match §1.1. Each team gets a scorecard recorded from run data:
- timestamps for install, first answer and first merge;
- TODOs accepted, merged, dropped and failed;
- terminal edits;
- second-member actions on a branch;
- flow revisions;
- work done outside Smithers (laptop fallback).

| Measure | Target | Kill signal |
| --- | --- | --- |
| Dogfood | The Smithers team merges 50 TODOs through its own install over two weeks. | Fewer than 20 TODOs merged in two weeks, or more than half our changes made on laptops. |
| Activation | An outside team merges its first TODO unassisted within 60 minutes of starting the install. | Two of three teams need our help to reach a merge. |
| Core value | Each outside team accepts 10 or more TODOs a week, with a median of under 15 person-minutes per TODO (answers, review and edits, from run data). The share of TODOs merged with no hand-written code is reported as a diagnostic, not a target: co-editing a fix is a success too. | Fewer than 3 accepted TODOs in week 2, or median person-minutes rising week over week. |
| Multiplayer | Each outside team has two or more members acting on the same branch in at least 3 separate sessions a week. | Zero sessions in week 2. |
| Retention | In week 3, each outside team commits 10 or more TODOs. | Fewer than 3 TODOs committed in week 3. |
| Self-improvement | Each outside team merges at least one learning-proposed flow change, and that change measurably helps a later TODO. | No team accepts a proposal in two weeks. |

## 11. Build order: walking skeleton first

Launch needs all three stages. They're built in this order so each stage is usable and testable before the next one starts. Engineering owns the tickets (`.specs/engineering/`).

**Stage 1: the skeleton (J1 without the Secrets card, J2 without post-merge learning, J4, J5 steps 1–4, J6 steps 1–3 with one person's terminal, J7, J11 step 1).**
1. Mac install: the assembler from `5b77095672` plus a launchd service, bind and public-address settings, an app that works without a secure context, isolation and GitHub settings passed through, and PostgreSQL 18.
2. Team access: multi-member self-host with GitHub sign-in, the roster and roles (M-05, M-17). This is the first engineering ticket.
3. Model access: restore the owner-only model configuration (`model.*`, `ModelCards`) from `5b77095672` for J1 and the Agent card.
4. TODO object: its own prompt, Make TODO drafting, placement, steering a working TODO, stop and resume. Bind `ask` for the implementing agent so it can raise Needs you (Appendix B.3).
5. Factory editing (J5): `/flow.edit` copies the built-in flow and proposes it as a TODO; the Flow card shows versions; fix `Executable.ts:2036` so a failed refresh keeps the previous version.
6. Fresh repositories: toolchain detection, plus coding and wiki configuration generated in the install.
7. GitHub: the sync-status row, follow `main` by default, reviews become steers, checks read for every PR, and the GitHub App manifest setup.
7a. jj from the app: fork, add to stack and rebase now (J7), as system flows any actor can invoke (M-32).
7b. A basic branch terminal for one person, signed in to Smithers, so J6 works (shared and watch-only terminals are stage 2).
8. One command catalog for the app and the CLI, trimmed to Appendix A and guarded by an allowlist test, with §8 applied in code.

**Stage 2: multiplayer (J3 without co-editing).**
9. One live branch: one workspace per repository and branch. That means changing the active-workspace key in `0095_workspace_source_commit.sql`, which today also includes `kind` and `name`, and covering every provisioning path that creates a workspace. Members and the coding agent share one workspace per branch, with presence.
10. Personal terminals: per-person users and homes, watch-only sharing, no `sudo`. The coding agent's `bash` runs in its own terminal session on the branch, so its commands render in the Terminal card (Appendix B.3).
11. SSH on port 2222 with GitHub keys, and the Secrets card.
12. External changes: watch the working copy, attribute changes by user, grouped activity entries, and live reload of open cards.
13. The admission queue: people first, safe release of idle machines, and sleep reads served from snapshots.

**Stage 3: co-editing and learning (J3 step 5, J8).**
14. Live co-editing of code files: a new collaborative-document layer on the machine (M-02). It is architected in stage 1, so the workspace, file and presence designs of stages 1 and 2 already carry it.
15. Learning: lessons written to the wiki after merges, plus one evidence-backed flow proposal.

## 12. Release

The MVP ships when:
1. J1 to J8, J10 and J11 pass end to end on a fresh Mac mini against a real GitHub repository, reached from a second laptop, in both light and dark themes. The recording includes:
   - a restart mid-run;
   - a duplicate launch;
   - two people typing on the same line of one file, with both edits applied, plus an out-of-band stale save that is recorded and recoverable;
   - an external save landing on a file two people are typing in;
   - a person editing a wiki decision, and the next related plan following that exact revision (J8);
   - recovery receipts for the restart.
2. The Smithers team meets the dogfood target.
3. Every §8 cut is gone from the product surface.
4. The docs are one quickstart for this user, plus the reference for flows.
5. The macOS install is public and needs no Smithers account.
6. Upgrade in place is rehearsed: a launch candidate upgrades to a later candidate with `smthrs host upgrade`, keeping its data, and a backup restores cleanly (M-26, #3444). The real receipt, an install made on launch day upgrading to the maintainer release, gates the maintainer release (§14).

## 13. Unresolved, with owners

| Question | Owner |
| --- | --- |
| Reconcile standing strategy with this spec (M-12): AGENTS.md, docs, the site, plue docs and Smithers-Ops. | Will approved it on 2026-10-02. Subagents are carrying it out. |
| Product name at install ("Smithers" alone) | Will. Deferred: it doesn't change screens. |
| Default parallel-work count on a 24 GB Mac: 1 or 2 | Product agent, after measuring the reference host (#3365) |

## 14. Next release: maintainers (launch + 1 week)

Will, 2026-10-02: maintainers with outside contributors are one of our first markets. Their release ships exactly one week after the MVP launch. It adds, on top of the MVP:

- **Incoming issues:** triage, duplicate search and reproduction on new issues, producing evidence for a maintainer rather than actions taken on the maintainer's behalf.
- **Replies to authors:** draft-first, then posted after a person approves.
- **Outside PRs:** review of pull requests from outside contributors, using the same review step the TODO flow uses.
- **Trust rules:** already built in the backend. An outsider's issue or PR never starts credentialed work on its own, and an outsider's issue becomes a TODO only by a maintainer's action. Members may commit the team's own issues as TODOs.

The trust rules are enforced from launch. Only triage, author replies and outside-PR review wait until day seven; they stay hidden but intact until then.

MVP designs must leave room for them:
- The issue card will gain a triage evidence section and a draft reply.
- The home card will gain an "incoming" filter.
- An outside PR is not a TODO. It keeps the contributor's PR identity and gets its own review card: findings and GitHub links, with no stack Merge action. Turning it into committed work takes a separate maintainer action.

## 15. GitHub features we compared against

Will asked for the GitHub features a team would miss. Test: does lacking it block useful work for more than half of the users trying Smithers? If so it's in the MVP. If not, it's a high-priority issue for the first release after the MVP (label `priority:high`).

| GitHub has | Decision | Where |
| --- | --- | --- |
| Collaborators and roles | MVP | §6.15 Members and maintainers |
| Repository secrets | MVP | §6.15 Secrets |
| Codespaces / remote access | MVP: SSH into a branch | §6.15, M-24 |
| Line comments in PR review | Deferred; GitHub review comments arrive as steers | §16, §6.3 |
| Notifications | MVP: browser. Deferred: email and phone | §6.4, §16, [#3423](https://github.com/smithersai/smithers/issues/3423) |
| File history and blame | Deferred | [#3424](https://github.com/smithersai/smithers/issues/3424) |
| Deploy previews (via Actions or integrations) | Deferred; SSH port forwarding covers it for now | [#3425](https://github.com/smithersai/smithers/issues/3425) |
| Mobile web | Deferred | [#3426](https://github.com/smithersai/smithers/issues/3426) |
| Code search, file browsing, branches, issues, PRs, checks | MVP | §6.3, Appendix A |
| Branch protection | Respected, and managed on GitHub | §6.3 |
| Releases, tags, Projects, Discussions, Insights, forks | Not in scope | GitHub keeps them |

## 16. Deferred

These are deferred from the MVP after the Codex Astra and Opus full reviews, and ratified by Fable for Will (every item except browser notifications, which returned to §6.4). Only §14 has a date. Each deferral below is tracked as its own GitHub issue and prioritized from alpha evidence, after Will's review of the final mock. None is promised for a specific release.

| Deferred | Area |
| --- | --- |
| In-app line comments on diffs; agent replies inside GitHub review threads | §6.10, §6.3 |
| Stacked PR bases and retargeting (PRs stay based on `main`) | §4.2, §6.3 |
| Bringing a laptop push into the live working copy automatically, without a person's Bring in (M-33's Bring in ships in the MVP); **Open on a machine** for teammates' branches | §6.3 |
| Ask to type in someone else's terminal | §6.8, M-18 |
| The command name on each external-change entry, per-entry Undo, and flags for a save that replaced someone's edit | §6.8, M-27 |
| Email and phone notifications (#3423) | §6.4 |
| Triggers, the Machine view, sending signals by hand, and editing an agent's permissions, tools and budget (#3469) | §6.14 |
| Obsidian on teammates' laptops (the vault over git) | §6.11 |
| Replacing a stack item's work with a scratch branch | J7 |
| Secret usage by run | §6.15 |
| Exact per-write attribution of terminal and SSH changes when several people's sessions are active | §6.8 |
| The TUI (#3468) | §8 |
| Smithers Cloud, billing and plans (#3467) | M-09 |
| Agent-pinnable rail icons (#3334) | §6.4: the MVP shell has no rail |

## Appendix A. The MVP command catalog

This is what `/help`, the palette, the CLI and the Smithers skill list for a member. Every entry has three doors: a ⌘K prompt in plain words, the slash command, and a button on its card. Repository flows also appear as their own slash commands (for example `/release-notes`). Controls inside a card (maximize, form fields, filters) aren't listed. The "was" column names the existing command to rename or reuse, and "new" means it doesn't exist yet.

| Slash | What it does | Journey | Was |
| --- | --- | --- | --- |
| **Ask** | | | |
| ⌘K (no slash) | Ask or tell Smithers anything | all | chat.send |
| `/help` | List these commands | | chat.commands |
| `/docs` | Read the docs in the app | | new (M-35) |
| `/stop` | Stop the current answer | | chat.stop |
| `/search` | Search code, wiki and runs | J9 | search.open |
| **TODOs and the stack** | | | |
| `/stack` | Show the stack and background runs | J4 | history.show |
| `/todo.new` | Write and place a TODO | J1, J2 | history.todo |
| `/todo.from-issue #n` | Draft a TODO from an issue | J2 | new (issue.implement) |
| `/todo T12` | Open a TODO's card | J2, J4 | new (`todo`) |
| `/todo.answer T12` | Answer the agent's question | J2, J3, J4 | new (`todo.answer`; question answers only) |
| `/todo.steer T12` | Send the agent a correction | J3, J4 | runs.steer |
| `/todo.amend T12` | Change an unmerged TODO's prompt | J7 | new |
| `/todo.stop T12` | Pause a working TODO | J4 | flow.run.stop |
| `/todo.resume T12` | Resume a paused TODO | J4 | runs.resume |
| `/todo.retry T12` | Retry a failed TODO | J4 | history.retry |
| `/todo.drop T12` | Abandon an unmerged TODO | J4, J7 | new |
| `/stack.move T12 up\|down` | Reorder an item | J4 | new |
| `/merge T12` | Review and merge the next item | J1, J2, J4 | history.land, change.land |
| **Branches and machines** | | | |
| `/branches` | List branches with presence | J3 | branches.list, box.list |
| `/branch <name\|T12>` | Open a branch's card | J3 | box.open |
| `/branch.fork` | Fork a scratch branch | J7 | new |
| `/branch.add-to-stack` | Add a scratch branch as a TODO | J7 | new |
| `/branch.rebase` | Rebase this branch now | J7 | new |
| `/terminal` | Open a terminal on a branch | J3, J6 | box.terminal |
| **Files and code** | | | |
| `/file <path>` | Open and co-edit a file | J3, J9 | files.read |
| `/files` | Browse a branch's files | J3 | files.list, repo.tree |
| `/diff` | Show a branch's changes | J2, J3 | change.diff |
| **Review** | | | |
| `/review` | Review a change, return findings | J2 | prs.triage, flows/review |
| `/pr #n` | Open a pull request's card | J2 | prs.view |
| **Issues** | | | |
| `/issues` | List the repository's issues | J2 | issues.list |
| `/issue #n` | Open an issue's card | J2 | issues.view |
| `/issue.new` | Open a GitHub issue | | issues.create |
| `/issue.comment #n` | Comment on an issue | J2 | issues.comment |
| **Wiki** | | | |
| `/wiki` | Open the wiki | J8 | wiki |
| `/wiki.page <name>` | Open or create a page | J8 | wiki.open, wiki.new-note |
| `/wiki.save` | Save this answer as a page | J9 | new |
| **Flows** | | | |
| `/flows` | List the repository's flows | J5 | flow.list |
| `/flow <name>` | Show a flow's steps and versions | J5 | new |
| `/flow.edit <name>` | Propose a change to a flow | J5 | new |
| `/flow.run <name>` | Run a flow with typed input | | flow.run |
| `/flow.new` | Create a new flow | | flow.create |
| **Runs** | | | |
| `/runs` | Active and attention-needing runs | J4 | runs.list, runs.attention |
| `/run <id>` | Open a run's card | J4 | runs.open |
| **GitHub** | | | |
| `/github` | Show sync status and retry | J10 | github.reconcile, github.app |
| **Advanced (collapsed in /help)** | | | |
| `/monitor` | Every run, with its debug view | J11 | new (runs.trace.view) |
| `/debug-api` | Try any call in the open API | | new (M-36) |
| `/run.inspect <id>` | Open a run's monitor | J11 | runs.trace.view, runs.graph.* |
| `/flow.source <name>` | Co-edit a flow's source | J11 | new |
| `/flow.plan <name>` | Preview a flow's plan | J11 | flow.plan |
| `/agents` | The factory's agents | J11 | agent.list |
| `/agent <name>` | Configure an agent | J11 | new |
| **Account and settings** | | | |
| `/settings` | Model access, machines, GitHub (owner) | J1 | new |
| `/secrets` | Set secrets machines can use | J1 | secrets.set, secrets.list |
| `/members` | Add people and manage roles | J1 | new |
| `/ssh <branch>` | Copy the SSH line for a branch | J3 | new (`smthrs ssh-key` exists) |
| `/sign-in`, `/sign-out` | Sign in with GitHub | J1 | auth.sign-in, auth.sign-out |
| `/theme` | Switch light or dark | | appearance.dark-mode |

Every other existing command is cut, deferred or hidden under §8, and it leaves the palette, the agent's tools and the CLI's MVP docs.

The app agent acts with the member's authority and appears as "Smithers for Ben": Smithers' own avatar in Ben's color, in the same pattern as "Claude Code for Ben" (M-34). Like any agent, it cannot approve or merge. When asked to merge, it opens the person's own **Review & merge** confirmation.

## Appendix B. Every flow and action, who runs it, and its card

This registry, together with [Appendix C](actions.md) (every internal action and flow, with the Inspect rendering of each), is complete: anything not listed in them doesn't ship. It was inventoried from `main` on 2026-10-02: 304 app flows, the coding host's tools, the backend's system flows and workers, and the CLI's 205 commands. Engineering turns it into the allowlist test (§11, stage 1 item 8).

**Rendering rule (Will).** A flow has one card, whoever runs it. When the coding agent runs a shell command, it appears as a session in the Terminal card. Its file edit appears in the File and Diff cards. Its question appears as Needs you. Each looks exactly as it would for a person, apart from the actor's glyph.

**Legend**
- **Who:**
  - P = person.
  - A = app agent, with the catalog field `agent: run | confirm | never`. **A** runs at once when the prompter asked for it. These are reads, the prompter's own screen, steer, answer, stop, resume, retry, rebase, fork, run a flow, and wiki writes. All are reversible or versioned. **A✓** posts a confirmation the prompter presses: committing or dropping a TODO, adding a scratch branch to the stack, deleting a wiki page, proposing a flow or agent edit, and merging, which opens Review & merge. **–** means never: members, secrets, settings and approvals happen only by the person's own hand in the app.
  - C = coding agent.
  - X = external agent through the CLI or skill. It has the same run, confirm and never rules as the app agent.
  - S = system.
- **Runs in:** Browser, Install (the backend on the Mac), Machine (a branch's microVM).
- **MVP:** Keep, Rename (→ the Appendix A name), Hide (system only), Defer (§16 or §14), Cut.

### B.1 UI-only flows (Browser; one person's own screen)

Coding agents and external agents can't call these (they have no screen). The app agent calls them only for the person who prompted.

| Flow | What | Who | MVP | Card |
| --- | --- | --- | --- | --- |
| `appearance.dark-mode` | Light or dark, per person | P, A | Rename → `/theme` | none |
| `input.mode` | Normal, Vim, dictation | P, A | Keep | none |
| `chat.send`, `chat.stop`, `chat.retry` | Send a prompt, stop or retry the answer | P (retry: A) | Keep (`/stop`) | conversation |
| `chat.queue`, `.edit`, `.remove`, `.restore`, `.resume` | Queued prompts: each waits on the branch's turn queue until its turn starts; `.resume` resumes a queue its author paused | P | Keep | composer |
| `chat.filter`, `.grep`, `.toggle`, `.reset` | Filter the conversation | P, A | Keep | conversation |
| `chat.copy-message`, `chat.dictate`, `chat.open`, `chat.reload`, `chat` | Copy, dictate, open composer, reload | P (reload: A) | Keep | none |
| `chat.commands` | List commands | P, A | Rename → `/help` | message |
| `chat.clear` | Archive the conversation | – | Cut: a branch's conversation is shared and permanent | – |
| `card.maximize`, `card.minimize`, `card.history.back`, `.forward`, `card.dismiss` | Card view controls (per person) | P, A | Keep | any card |
| `frame.back`, `frame.forward` | Frame navigation | P, A | Keep | none |
| `palette.open`, `palette.actions`, `palette.recent` | ⌘K palette | P, A | Keep | overlay |
| `form.set`, `form.submit` | Typed input forms | P, A | Keep | flow-form |
| `toast.dismiss` | Hide a toast | P | Keep | toast |
| (new) `notifications.allow` | Allow browser notifications (the one-time ask) | P | Keep, Missing | toast |
| `app.hint.dismiss` | Dismiss the one hint | P | Keep | none |
| `search.open`, `search.files`, `.flows`, `.issues`, `.runs`, `.wiki`, `.changes`, `.history` | Palette search | P,P, A, X | Keep (`/search`) | search-results |
| `search.targets`, `search.boxes`, `search.secrets` | Search build targets, boxes, secrets | – | Cut (targets, boxes); Hide (secrets: names only, on the Secrets card) | – |
| `storage.recovery`, `.export`, `.reset` | Private local recovery | P (offer: A) | Keep | message |
| `runs.graph.*`, `runs.trace.*`, `runs.coding.select`, `runs.steps`, `flow.plan.select`, `flow.plan.tab` | Monitor and plan-view controls | P, A | Keep (monitor) | run-trace, flow-plan |
| `prs.tab`, `change.facet`, `box.facet` | Card tabs | P, A | Keep | pr, change, branch |
| `wiki.open`, `.select`, `.view`, `.heading`, `.graph`, `.backlinks`, `.new-note`, `.space`, `.card.*`, `wiki`, `wiki.pane` | Wiki navigation | P, A (create: A✓) | Keep | wiki |
| `wiki.delete`, `.delete.cancel`, `.delete.confirm` | Delete a page (asks) | P (A✓) | Keep | wiki |
| `tab.card`, `tab.close`, `tab.select` | Card tabs | – | Cut: the branch tree replaces tabs | – |
| `world`, `world.*` | Old wiki aliases | – | Cut | – |
| `subagents`, `flows` (pane), `connect`, `smithers.who`, `workspace.rename`, `.edit`, `app.first-run.dismiss`, `notifications.read-update`, `notifications.tag` | Retired surfaces | – | Cut | – |
| `debug.errors`, `debug.verbose`, `debug.reset`, `debug.snapshot`, `debug.events`, `debug.net`, `debug.backend`, `admin.devtools`, `admin.reset*` | Developer tools | – | Hide (developers only) | message |
| (new) branch tree | Move between a branch, the branch it forked from, and its children | P, A | Keep, Missing | branch tree |

### B.2 Install flows (Install; shared state)

| Flow today | What | Who | MVP | Card |
| --- | --- | --- | --- | --- |
| `history.show`, `history.view` | The stack | P, A, X | Rename → `/stack` | stack (home) |
| `history.todo` | Commit a TODO | P, A✓, X | Rename → `/todo.new` | TODO |
| `issue.implement` | Draft a TODO from an issue | P, A✓, X | Rename → `/todo.from-issue` | TODO |
| (new) `todo`, `todo.amend`, `todo.drop`, `stack.move` | Open, amend, drop, reorder | P, X; A for open and move, A✓ for amend and drop | Keep, Missing | TODO, stack |
| `runs.steer` (for a TODO) | Steer the coding agent | P, A, X | Rename → `/todo.steer` | branch activity |
| `approvals.list`, `approvals.open`, `runs.attention` | What needs you | P, A, X | Rename → `/runs` (Needs you) | run-list, approval |
| `approval.approve`, `approval.deny` | Answer an approval | P only | Keep | approval |
| (new) `todo.answer` | Answer the coding agent's question | P, A, X | Keep, Missing | TODO |
| (new) `todo.takeover` | Take over a removed member's TODO (in-card control) | Maintainer (P only) | Keep, Missing | TODO |
| `history.retry` | Retry a failed TODO | P, A, X | Rename → `/todo.retry` | TODO |
| `history.land`, `prs.land`, `change.land` | Merge the next item | P (maintainer). A✓ and X open the person's Review & merge confirmation | Rename → `/merge` | PR |
| `history.parallel` | Parallel-work count | Owner | Hide → Settings | settings |
| `history.bootstrap`, `history.backfill` | Stack plumbing | S | Hide | – |
| `branches.list`, `commits.list`, `commits.read` | Branches and their history | P, A, X | Rename → `/branches`, read inside the Branch card | branch |
| `box.open`, `box.view` | Open a branch's card without waking its machine | P, A, X | Rename → `/branch` | branch |
| `box.list` | List branches without waking machines | P, A, X | Rename → `/branches` | branch |
| `box.suspend`, `box.resume` | Sleep and wake | P, A, S | Keep (inside the Branch card) | branch |
| `box.delete`, `box.session.destroy` | Clean up a machine or session | S (P for own session) | Hide (cleanup rules, §6.7) | – |
| `box.select` | Pick a box | – | Cut | – |
| (new) `branch.fork`, `branch.add-to-stack`, `branch.rebase` | Fork, add to stack, rebase now | P, X; A for fork and rebase, A✓ for add to stack | Keep, Missing | branch |
| `files.read`, `files.list`, `files.open-diff`, `box.file`, `box.files`, `repo.tree` | Read files (`main`, a branch, a snapshot) | P, A, C, X | Rename → `/file`, `/files` | File |
| `files.add` | Attach files | – | Cut | – |
| `code.hover`, `code.definition`, `code.diagnostics` | Code intelligence | P, A | Keep (File card) | File |
| `change.view`, `change.diff`, `change.pins`, `change.checks` | A change, its diff and checks | P, A, X | Rename → `/diff`, PR card | diff, PR |
| `change.resolve` | Send a conflict to the coding agent | P, A✓ | Keep (Resolve on Needs you) | branch |
| `change.request`, `change.split`, `change.revert` | Old change doors | – | Cut (TODOs replace request; split is cut; revert is a new TODO) | – |
| `prs.list`, `prs.view` | Pull requests | P, A, X | Rename → `/pr` | PR |
| `prs.triage` | Review a change | P, A✓, X | Rename → `/review` | findings |
| `prs.review` | Approve or request changes in the app | – | Defer (§16): reviews happen on GitHub | – |
| `prs.create` | Open a PR by hand | – | Cut: PRs come from TODOs | – |
| `findings.please-fix`, `findings.not-useful` | Act on a review finding | P, A✓ | Keep (please-fix becomes a steer) | findings |
| `review.request`, `.unrequest`, `.since-mine`, `.done`, `.ack`, `.reopen` | In-app review threads | – | Defer (§16) | – |
| `issues.list`, `issues.view`, `issues.comment`, `issues.close`, `issues.reopen`, `issues.create` | GitHub issues | P, A (writes: A✓), X | Keep (`/issues`, `/issue`, `/issue.new`, `/issue.comment`) | issue |
| `issues.fix`, `issues.verify`, `issues.set`, `issues.comment.react`, `issues.comment.retry`, `issues` | Native issue states | – | Cut: issues are GitHub's | – |
| `issue.repro`, `issue.poc`, `issue.add-flow`, `issue.flows`, `issue-sweep` | Issue automation | – | Defer to the maintainer release (§14); issue-sweep is cut from the product | – |
| `wiki.cloud`, `.cloud.open`, `.cloud.new`, `.cloud.rename`, `.cloud.delete`, `wiki.edit`, `wiki.history`, `wiki.sync`, `wiki.attach` | Wiki pages, live co-editing | P, A (delete: A✓), C (read), X | Keep (`/wiki`, `/wiki.page`) | wiki |
| `wiki.create` | Refresh generated pages | S | Hide | – |
| `wiki.ask` | Ask the codebase | – | Cut: ⌘K asks | – |
| (new) `wiki.save` | Save an answer as a page | P, A | Keep, Missing | wiki |
| `flow.list`, `flow.run`, `flow.create`, `flow.plan`, `flow.run.stop`, `.retry`, `.stop-all` | Repository flows | P, A (create: A✓), X | Rename → `/flows`, `/flow.run`, `/flow.new`, `/flow.plan` | flows, run-trace |
| (new) `flow`, `flow.edit`, `flow.source` | Show a flow, propose an edit, co-edit its source on the branch of the TODO that proposes the change | Show and open source: P, A, X. Propose an edit: P, A✓, X. Co-edit source on a machine: P, X. | Keep, Missing | Flow |
| `runs.list`, `runs.open`, `runs.logs`, `runs.events`, `runs.rerun`, `runs.resume`, `runs.continue` | Runs and their controls | P, A, X | Keep (`/runs`, `/run`, `/run.inspect`) | run-trace |
| (new) `monitor` | Every run with its debug view | P, A, X | Keep, Missing (`/monitor`) | run-list |
| (new) `agent` | Open a factory agent's card | P, A, X; model changes: Owner only | Keep, Missing (`/agent`) | agent |
| `runs.signal` | Send a signal by hand | – | Defer (§16) | – |
| `runs.takeover`, `runs.release`, `runs.handoff`, `runs.burndown.*` | Take over a run, handoff brief, burndown board | – | Cut | – |
| `agent.list` | The factory's agents | P, A, X | Rename → `/agents` | agents |
| `model.*` (restore from `5b77095672`) | Choose an agent's model | Owner | Keep, Missing (restore) | agent |
| `agent.session.*` | Cloud agent sessions | – | Cut: coding agents live on branches | – |
| `browser.open` | Read a web page as a card | P, A | Keep | browser |
| `secrets.list`, `.set`, `.delete`, `.scope`, `.bind` | Repository secrets | Maintainer (P only; agents: never) | Rename → `/secrets` | secrets |
| `secrets.connect`, `.connect.codex`, `.connections`, `.move`, `.revoke`, `env.*` | Subscription and environment connections | Owner | Rename → `/settings` (model access) | settings |
| `github.app`, `github.app.choose`, `github.app.open`, `github.reconcile` | GitHub App and sync health | Owner (status: P, A, X) | Rename → `/github`, setup card | github |
| `github.mirror-sync`, `github.mirror.retry-ref`, `sync.ops.show-more` | Mirror plumbing | S | Hide (the sync row's Retry calls it) | – |
| `auth.sign-in`, `auth.sign-out`, `auth.prompt`, `account.show` | Sign in, account | P | Keep (`/sign-in`, `/sign-out`; account inside Settings) | account |
| (new) `members`, `members.add`, `.role`, `.remove` | People and roles | Maintainer (P only; agents: never) | Keep, Missing | members |
| (new) `settings` | Model access, machines, address, GitHub | Owner (P only; agents: never) | Keep, Missing | settings |
| (new) `ssh` | Copy the SSH line | P | Keep, Missing | branch |
| `repos.import`, `repos.import.retry` | Mirror the repository | S (install setup) | Hide → setup card | setup |
| `repo.choose`, `repo.create`, `repo.select`, `repo.overview`, `repo.update` | Several repositories | – | Defer (§8): hidden, code kept; one repository per install | – |
| `notifications.list`, `notifications.read` | Notification center | – | Cut: toasts and the timeline replace it | – |
| `triggers.list`, `.register`, `.approve`, `.pause`, `.resume`, `.run` | Triggers | – | Defer (§16) | – |
| `egress.allow`, `egress.session`, `box.egress`, `box.services`, `box.images` | Machine details | – | Defer (§16) | – |
| `box.terminal`, `box.sessions` | Terminals on a branch | P, A (opens the prompter's own terminal; the agent never types in it) | Rename → `/terminal` | Terminal |
| `billing.*`, `cloud.*` | Cloud billing and sign-in | – | Defer (§8, M-09): hidden, code kept for Smithers Cloud | – |
| `admin.grant*`, `admin.health`, `repository.register`, `signup.*`, `setup.*`, `issues.setup`, `review.setup`, `ci.setup`, `feature.setup`, `chores.setup`, `feature.prototype`, `system.recommend` | Admin, registration, signup, five-job setup | – | Cut | – |

### B.3 The coding agent's actions (Machine; one per awake branch)

These are the tools the coding host binds today (`NativeControl.ts:1382-1404`), with the card each one renders into.

| Action (`ctx.call`) | What | MVP | Renders as |
| --- | --- | --- | --- |
| `read`, `ls`, `glob`, `grep` | Read and search the working copy | Keep | A "read" line in the branch activity, opening the File card |
| `write`, `edit`, `apply_patch` | Change files (versioned writes, M-02) | Keep | An attributed edit in the File and Diff cards, with the agent's line flag |
| `bash` | Run a command | Keep. **Missing:** each command must run in an agent-owned terminal session on the branch, so it renders in the Terminal card and anyone on the branch can watch. Today it spawns processes with no terminal. | Terminal card (agent session) |
| `test` | Run the declared tests | Keep. **Missing:** bound only when `SMITHERS_TEST_COMMAND` is set; the install must provide it from toolchain detection. | Terminal card plus checks |
| `memory`, `recall` | Pick context (wiki, code, history, facts) | Keep | The "Context" line, and the preflight cell in Inspect |
| `remember` | Save a fact | Keep (through learning) | Learning receipt |
| `jev` | Typed decisions | Keep | Inspect only |
| `ask` | Ask a person | **Missing for the implementing agent:** `coding/edit-atom` and `coding/dispatch-turn` don't bind it today, so only flow steps can ask. Bind it. | Needs you |
| `wait` | Durable sleep | Keep (prompt flows) | Inspect |
| `fetch`, `webfetch`, `websearch`, `http-post`, `lsp`, `explore`, `update_plan`, `agent/spawn`, `agent/send`, `agent/await`, `flows/show-script`, `flows/write-flow`, MCP tools | Declared but not bound | Not in the MVP: the agent reads the web through `bash` (curl through the egress proxy) | – |

The coding flows' internal steps (76 `Action.make` tags and 9 `AgentAction` seats in `flows/coding/*`: plan, implement-atom, review lenses, POC, verify, vibe landing, correction rounds, learning notes) aren't tools. They are the TODO flow's steps, and they render as the TODO card's step list and as cells in Inspect. Inspect titles each phase by what it did, and every cell has a plain explanation.

### B.4 In-card controls

These are actions on a card, not slash commands, each with a stable id for the catalog and the tests.

| Control (id) | Card | What | Who |
| --- | --- | --- | --- |
| `todo.return-to-item` (**Return to Tn**) | Needs you: "moved this branch off Tn" | Put the working copy back on the item's commit; later writes stay recoverable | P, A |
| `todo.keep-moved` (**Keep for now**) | same | Record the move; the TODO waits in Needs you until the copy is back on Tn | P |
| `branch.bring-in` (**Bring in**) / `branch.discard-foreign` (**Discard**) | Needs you: foreign push | Rebase onto a teammate's pushed commit, or discard it (kept in history) | P (maintainer for Discard); A✓ |
| `file.restore` (**Restore this file**) | External-change diff | Put one file back to its state before the burst, as an attributed edit | P, A |
| `file.compare` (**Compare**) | File: "Changed outside Smithers" | Show the live document beside the external version | P, A |
| `file.restore-deleted` (**Restore**) / `file.follow-rename` (**Follow**) | File: deleted or renamed | Bring a deleted file back, or open its new path | P, A |
| `todo.retry-current-flow` (**Retry with the current flow**) | TODO: Failed | A new attempt on the active flow version | P, A |
| `branch.rebase-now` (**Rebase now**) | Branch: Rebase pending | Rebase at once instead of waiting for nobody to be present | P, A |
| `learning.accept` (**Make TODO**) / `learning.dismiss` | Learning receipt | Turn a proposed flow improvement into a TODO, or dismiss it | P, A✓ |
| `terminal.watch` | Terminal | Watch someone's session | P |
| `notifications.allow` | First Needs you toast | Allow browser notifications (HTTPS or localhost only) | P only |
| `todo.takeover` (**Take over**) | TODO of a removed member | A maintainer takes ownership | Maintainer only |
| `merge.confirm` (**Review & merge**) | PR | The person's approval, bound to the reviewed revision | Maintainer only |
| `order.ok` (**OK**) | Needs you: out-of-order merge ("T3 merged before T2") | Acknowledge, and both items stay Merged with the note | P, A |
| `background.retry` (**Retry**) / `background.dismiss` (**Dismiss**) | Home card: a failed background run | Retry the run, or remove it from the home card (its record stays) | P, A |
| `main.reset-to-github` (**Reset to GitHub main**) | Needs you: `main` rewritten on GitHub (§6.3) | Accept the rewritten `main`; the stack rebases onto it | Owner only |
| `image.add` (**Add to machine image**) | Machine setup: a missing system package | Propose the package as a change to the image declaration (M-29). It becomes a TODO reviewed like any other; merging stays with maintainers | P, A✓ |

### B.5 System orchestration and background runs

One TODO attempt is one durable `todo` run (engineering §10.4.1). It plans, implements, verifies and reviews, proposes through the system operation `stack.propose`, then waits for rebase, steer and merge signals until the TODO merges or is dropped. That run is the TODO flow that J5 customizes and Inspect shows. The stack steps below are the system operations around it.


| System flow | What | MVP | Renders as |
| --- | --- | --- | --- |
| Stack: admit | An issue labeled `todo`, or a committed TODO, joins the stack | Keep | TODO Queued |
| Stack: start | Admit one pinned `todo` run per attempt on the TODO's branch machine | Keep | Starting, then Working |
| Stack: integrate | Rebase the candidate onto `main` and earlier items, and signal the same TODO run to recheck | Keep | Branch activity ("Rebased onto T2"); checks |
| Stack: propose | Open or update the verified candidate's GitHub PR, based on `main` and squash-merged | Keep | In review; PR card |
| TODO run: review | Review the change inside the same TODO run on its branch machine | Keep | Findings on the PR card |
| Stack: merge | Squash-merge after a person's approval at the exact head. **Change:** today it merges on the `automerge` label | Keep | Merged |
| Stack: fold, complete | Fold `main` back; close the linked issue only when the TODO says it fixes it | Keep | Merged receipt |
| Stack: wiki → `coding/wiki` | Refresh generated pages after merges | Keep | Background run on the home card |
| Stack: bootstrap, backfill, lane sweeps | Plumbing | Hide | – |
| GitHub main pull, webhook worker, synced-repo reconciler, App reconciler, mirror recovery | GitHub sync (§6.3) | Keep | The `main` row's sync status |
| Admission and lane scheduler | Machines and parallel work (M-06, M-13) | Keep; the people-first queue is Missing | "waiting for a machine #2" |
| Workspace head reporter | Reports each machine's head | Keep (feeds live updates and external-change entries) | Branch activity |
| Learning | The install starts a background machine run of the overridable learning flow, which writes lessons and proposes one flow improvement. (`record-learning` exists; `memory/mine` and `improve.mine` aren't running.) | Keep, Missing | Learning receipt |
| Timeline summaries | One-line summary per conversation entry | Keep, Missing | Timeline |
| Old repository setup, registration, and the CI, Feature and Chores job workers | Retired setup and jobs | Cut; keep the issue and review machinery for §14 | – |
| Factory event admission and dispatch | GitHub events and the retained maintainer machinery | Hide; keep running | – |
| User-configurable triggers (only the nightly `security-audit` registers today) | Rules and schedules | Defer (§16) | – |
| Cleaners and reapers | Housekeeping | Hide | – |

### B.6 External agents (CLI and skill)

The CLI's 205 commands become one catalog with the app (§11, stage 1 item 8). Kept for the MVP:
- Appendix A commands that Appendix B allows external agents; person-only actions open confirmations;
- `login` and `ssh-key`, for signing in from a laptop and managing SSH keys;
- `workspace ssh`, `shell`, `exec` and `cp`, for a person's own machine access;
- `api`, under the same actor permissions;
- `smthrs host start`, `stop`, `status`, `upgrade`, `backup` and `restore`: run by the owner (P) on the install's Mac.

Delegated agent credentials follow the same `run | confirm | never` rules: merge opens the person's Review & merge confirmation; members, secrets, settings and approvals have no agent path at all. Cut from MVP docs and acceptance: `admin` (35 commands), `org` (18; members replace it), `webhook`, `variable`, `cache`, `artifact`, `label`, `notification`, `workflow` (legacy), `stack` (the GitHub PR stack tool, which conflicts with the Smithers stack), `workspace children`, and `egress` (deferred).
