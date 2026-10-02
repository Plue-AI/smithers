# Smithers MVP product spec

Status: v2.4 by the product agent (smithers-98), 2026-10-02. Builds on the [overview](overview.md). Three Codex Astra (xhigh) review passes, then full independent reviews by Codex Astra and Opus (their deferrals are applied in §11 and §16, and the open questions are in §13). Design feedback from smithers-06, engineering pushback from smithers-8a, and Will's rulings applied. Will reviews last.

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

This is a hypothesis. Section 10 says how the alpha tests it.

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
| **App agent** | The fast assistant in each branch's conversation. It answers questions and drives the app. Each prompt runs with the authority of the person who wrote it. |
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
 │ app UI           │◀──────▶│ app agent (per member)     │──ask──▶│ coding agent (per branch) │
 │ UI-only flows    │        │ system: stack, GitHub sync,│        │ files · terminals · tests │
 │ (theme, cards…)  │        │ queue, learning, summaries │◀─PR────│ external agents in a      │
 └──────────────────┘        └────────────────────────────┘        │ person's terminal         │
                                                                    └───────────────────────────┘
```

| Actor | Runs in | Acts as | Can | Cannot | Hands work to |
| --- | --- | --- | --- | --- | --- |
| **Member** | Browser, SSH, terminals | Themselves | Everything their role allows (§6.15) | What their role excludes | Any agent |
| **App agent** ("Ben via Smithers") | The install's model host, outside every machine | Whoever wrote the prompt, with a delegated credential | UI-only flows on the prompter's own screen (theme, open/maximize cards, navigate, palette, filters, input mode). Install flows from Appendix A: create, place, steer and answer TODOs; read code, branches, runs and the wiki; open the monitor; propose flow and agent edits as TODOs. | Run anything on a machine (no terminal, no file writes, no commands). Approve, merge, manage people or secrets. Change anyone else's screen. | A branch's coding agent: "run the webhook tests on retry-webhooks" becomes a request to that branch's coding agent, shown as "Ben via Smithers asked". New work becomes a TODO. |
| **Coding agent** (one per awake branch) | The branch's machine, through its coding host | The coding agent, for the TODO's owner | Read and write that branch's working copy (versioned writes). Run commands and terminals on that machine. Run tests and checks. Read web pages and the wiki. Ask a person (Needs you). Propose its change to the stack. | Merge or approve. Touch other branches or machines. Change settings, members or secrets. Edit system flows. `sudo`. Read people's home directories. | People (Needs you). The stack service (propose). |
| **External agent** (Claude Code, Codex, others) | A person's branch terminal or laptop | That person, with a delegated credential | On a machine: whatever that person's terminal can do. Through the Smithers skill and CLI: the same catalog the app agent has. | Approve or merge: the person gets a **Review & merge** confirmation. UI-only flows (it has no screen). | Same as the app agent |
| **System** ("Smithers") | The install | The install | Stack service: rebase, propose PRs, and merge after a person's approval. GitHub sync. The admission queue. Learning runs. Wiki refresh. Timeline summaries. Jev decisions. | Anything a person must decide | People (Needs you) |

UI-only flows run only in the member's own browser, for that member. A person or their app agent can call them; coding and external agents cannot, because they have no screen.

Appendix B lists every flow and action with its actors, where it runs and the card that renders it. Anything not in Appendix B doesn't ship.

## 4. TODOs

### 4.1 States

```
 Queued ──▶ Starting ──▶ Working ◀──▶ Needs you
   │          │  ▲
   │          │  └── Resume ── Paused ◀── Stop
   │          ├──▶ Failed ── Retry ──▶ Working   (earlier attempts and evidence kept)
   │          └──▶ In review (PR open) ──▶ Merged  (done)
   │                   └── changes requested ──▶ Working
   └──▶ Dropped   (any unmerged TODO; a person's action)
```

| State | Meaning | Who acts |
| --- | --- | --- |
| Queued | Waiting, with a reason and position: "waiting for a machine #2". | Nobody |
| Starting | It has a machine, and the coding agent is launching. | Nobody |
| Working | The coding agent is planning, editing or checking. | Anyone on the branch may watch or steer. |
| Needs you | The agent asked a question, needs an approval, or hit a conflict it can't resolve. | Any member. The first accepted answer settles it. Others then see "Ben answered", and any unsent draft stays with **Send as steer**. |
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
- **Rebase.** When `main` or an earlier item publishes a new revision, the later items queue a rebase. On a branch with only the coding agent present, it runs at the agent's next checkpoint. On a branch where people are present, it shows "Rebase pending" and runs when nobody is present, or when someone on the branch presses **Rebase now**. Either way it first snapshots every writer's work and never runs during a write made through Smithers. People on the branch then see "Rebased onto #2" in the activity, and their open cards refresh. A rebase changes the revision, so checks rerun and any earlier approval no longer applies. A conflict the coding agent can't resolve becomes Needs you, with a Resolve action that opens the branch.
- **Merging.** Only the next item in order can merge; later items show "Merges after Tn". **Move up**, **Move down** and **Drop** unblock a stuck item. Each PR is the verified candidate for its item, based on `main` and squashed to one commit on merge, as built today. Smithers enforces the stack order. The PR card in Smithers shows only the item's own change. The GitHub PR body names the earlier items it includes until they merge. Stacked PR bases are deferred (§16).
- **Not in MVP:** splitting or squashing across TODOs.

## 5. User journeys

The design mocks these. P0 journeys must play in the first design build. Every capability a P0 journey uses is P0, even where a P1 journey shows it in more depth.

### J1. Install to first merged TODO (P0)

1. The owner installs Smithers on a Mac and opens it in a browser on the LAN.
2. Setup asks for three things in one card, and checks one prerequisite: GitHub allows squash merging (a failed check links to the fix). The three things:
   - **GitHub connection:** sign-in, plus the GitHub App that lets Smithers read and write the repository.
   - **The repository.**
   - **Model access:**
     - one provider key for the agents;
     - the AI Gateway key that Jev uses for fast decisions;
     - optionally, a ChatGPT subscription sign-in for coding.
3. Smithers mirrors the repository. Questions work as soon as the source is readable.
4. The first machine image prepares in the background, and the card shows **Source ready** and **Machine ready** as separate steps. A repository with no Smithers declarations still gets a working machine: Smithers detects the toolchain and installs dependencies.
5. The owner asks the app agent about the code and gets an answer with file cards.
6. The owner writes a first TODO. It gets a branch, a machine and the coding agent, and a pull request opens on GitHub with its evidence.
7. They review it in the app and merge it.
8. From the Members card they add Ben and Alice by GitHub username. Ben is a Maintainer and Alice a Member. They open the install's address, which the owner set in Settings (here, the team's Tailscale name). The owner sets the two secrets the tests need on the Secrets card.

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
2. The app agent opens the Flow card for the TODO flow (plan, implement, check, review, open PR) and proposes the edit as a diff.
3. The edit becomes a TODO like any other, and a person merges it. When the install has synced and loaded it, the Flow card shows the new version as Active.
4. TODOs started after that use the new version. Runs already in progress keep the version they started with.
5. Later, a learning run proposes an improvement backed by evidence: "3 of the last 5 TODOs failed lint at review; add lint to the check step". The lead turns it into a TODO, it merges, and the next TODO passes lint the first time.

### J6. Bring your own agent (P1)

1. A member opens a terminal on a branch and runs `claude` or `codex`, signed in with their own subscription. The terminal comes signed in to Smithers as that member, and the Smithers skill is installed.
2. Its edits land in the shared working copy. Teammates see them live, and the edits become part of that branch's change.
3. Through the skill, Claude Code reads the wiki, answers the TODO's Needs you, and places a follow-up TODO. Each action shows as "Ben via Claude Code".
4. The same works from the member's laptop after `smthrs login` to the install.
5. Teammates can watch the session but can't use the member's login.

### J7. Plan and fork (P1, jj)

1. A member inserts a TODO before T3, then amends T2's prompt with a follow-up requirement (no new TODO; T2 shows "+1").
2. They fork T2's branch into a scratch branch to try another approach by hand. The fork starts from T2's current revision.
3. The scratch work is better. **Add to stack** makes it a new TODO after T2, and they drop T2. (Replacing T2's work in place is deferred, §16.)
4. `main` moves, and the stack rebases. The coding agent resolves one conflict and shows what it did.

### J8. Memory (P1)

1. After a merge, the learning run writes a wiki page recording the decision and its reason, with a link to the change.
2. A teammate edits that page in the app while another edits it too. Co-editing is live.
3. The next related TODO's plan cites that page revision.

### J9. Ask the repository (P1)

1. A member asks a question ("where do we retry webhooks?").
2. The app agent answers with file, code and wiki cards.
3. The answer offers **Make TODO** and **Save to wiki**.

### J10. Work with GitHub (P0)

1. A TODO reaches In review. Its PR appears on GitHub as `smithers/retry-webhooks`, based on `main`, with the prompt, the evidence and the earlier stack items it includes in the body.
2. A teammate leaves a review comment on GitHub. Within a minute it appears in the branch activity as their steer. The TODO goes back to Working, and the agent pushes a fix that updates the PR.
3. Alice pushes a commit to that branch from her laptop. Smithers shows Needs you: "Alice pushed to `smithers/retry-webhooks` on GitHub". She redoes the change over SSH on the branch's machine instead.
4. Someone merges an unrelated PR on GitHub. The `main` row updates, and the stack shows "Rebase pending" on branches with people present; the others rebase.
5. The lead merges the TODO's PR on GitHub instead of in Smithers. The TODO turns Merged, and its issue closes with a link.
6. The `main` row reads "synced 40 s ago" throughout. When the network drops, it turns gold, "synced 6 min ago · Retry".

### J11. Look under the hood (P1, advanced)

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
| Install on a Mac | One install on Apple Silicon macOS runs the backend, PostgreSQL 18 and microVMs (isolation on by default) as a launchd service, reachable at the addresses the owner sets (M-28). The package is rebuilt from the assembler half of the deleted `apps/app/scripts/build-native.ts` (at `5b77095672`), without Electrobun. The Docker image isn't an MVP install path, because it can't host microVMs. | Missing: no package exists. The launcher binds loopback only and drops the isolation and GitHub settings. |
| Reaching the install | The install doesn't care which address it's reached at. It listens on loopback by default. In Settings the owner sets a bind address and the public addresses (http or https, any host), and SSH listens on the same address on port 2222. The app works on plain HTTP: it doesn't need a secure browser context. HTTPS and remote access are whatever the team puts in front, and the docs recommend `tailscale serve` or a reverse proxy. | Missing (bind settings and secure-context-free app) |
| Machine image without declarations | Smithers detects the toolchain (`.node-version`, `packageManager`, `go.mod` …) and installs dependencies. Declarations only make it faster. | Partial: layers need a committed target index. |
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
| An issue gets the `todo` label from a member | A TODO is committed from the issue's current text (J2). | Built |
| A review or review comment on a TODO's PR | It enters the branch activity as a steer, attributed to the reviewer. "Changes requested" sends the TODO back to Working. Agent replies inside GitHub threads are deferred (§16). | Missing |
| Checks finish on a TODO's PR | The PR card and the TODO's evidence update. A failed required check holds Merge, giving the check's name. | Partial: checks are read only on the automerge path. |
| A TODO's PR is merged on GitHub | Same as Merge in Smithers: the TODO turns Merged. A merge out of stack order shows Needs you on the stack. | Partial |
| A TODO's PR is closed without merging | The TODO turns Dropped, with "closed on GitHub by @x". Reopening the PR restores it. | Partial |
| Someone pushes to a TODO's branch from a laptop | Shown as Needs you: "Alice pushed to `smithers/retry-webhooks` on GitHub", with a link to the commit. Smithers' next push replaces it, so their work belongs in the branch on Smithers (SSH or terminal). Bringing such pushes into the live working copy is deferred (§16). | Missing |
| A teammate pushes their own branch or opens their own PR | `/review` works on any PR. **Open on a machine** for teammates' own branches is deferred (§16). | Built (`/review`) |
| GitHub branch protection | Respected. Merge shows GitHub's reason when blocked, e.g. "1 approving review required on GitHub". | Partial |

**From Smithers to GitHub** (through the install's GitHub App, attributed)

| In Smithers | On GitHub | Status |
| --- | --- | --- |
| A TODO reaches In review | One PR on its branch `smithers/<todo-slug>`, based on `main`. Its body holds the prompt, the evidence, the earlier stack items it includes, and a link back. It is opened by the Smithers app, with "Requested by @owner". | Built (Mythical PRs) |
| A commit is made on a TODO's branch | It reaches GitHub when the PR is proposed and on every later update. Each item lands on `main` as one squashed commit. | Built |
| Make TODO on an issue | The issue gets the `todo` label and the comment "Committed as TODO #12 ↗". | Partial |
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
| Home card | The stack, with `main` pinned at the top and items in merge order. Counts act as filters, and the card shows the last sync time and machines in use against capacity. Below the stack it shows background runs (learning, wiki refresh, other flows) that are queued, running, waiting or failed, each with a resumable card. A failed run stays until someone retries or dismisses it. These runs never become TODOs. Every member sees the same home card, so private chat is not the only way to see the team's work. | Partial (StackCard) |
| Branch conversations (Will) | Each branch is one conversation, shared by everyone on the branch. `main`'s conversation is the team's home and holds the stack, so it is long. Prompts show their author, and cards are shared. Each person keeps their own scroll position and card view state. A branch tree navigates between conversations: a branch, the branch it forked from, and its children. ⌘K opens the composer and palette in the current branch's conversation. | Partial: today each member has their own conversation per repository. |
| No chat between people | People don't message each other in the app; they use Meet, Slack or whatever they already use. In Smithers they coordinate through presence, live edits and branch activity. | Decision |
| Commands | Slash commands, the palette and agent tools list only MVP flows. Debug and admin commands never reach members. | Partial: the catalog is too wide. |
| Toasts for events (Will) | Notable events and anything that needs action pop as toasts with their one action: approvals, Needs you, a PR ready, a failure. Each person can hide them. Every toast also stays as an entry in the timeline. Live work in cards scrolled out of view shows on the left edge: above at the top-left, below at the bottom-left. | Partial (the toast stack is built) |
| Timeline (Will) | Desktop only, between the two toast edges: one line per transcript entry. Each line has a title and a one-line summary of what happened there, written by the install's cheap fast model and refreshed as the entry's run progresses (debounced), e.g. "Agent: edited retry.ts line 14" or "Asks: backoff or timeout?". Live entries pulse, Needs you is gold and failures are ember. A band marks the entries on screen, and clicking an entry scrolls to it. On narrow screens and phones there's no timeline; each edge collapses to one pill ("↑ 2 live above"). It replaces the per-run ChatRunTimeline strip; the run card keeps its own scrubber. | Missing: needs a stored one-line summary and live tone per conversation entry |
| Browser notifications | Deferred (§16, #3423). The toast map and the home card carry attention in the MVP. | Deferred |
| Input and theme | Normal, Vim and dictation input, keyboard-only throughout, and the light and dark Paper palette. These are kept as built but don't gate acceptance. | Built |

### 6.5 App agent

| Feature | Behavior | Status |
| --- | --- | --- |
| Answers | Answers questions about the repository with cards. Jev chooses the commands it needs. | Built. Self-host needs an owner default model and an AI Gateway key. |
| Context preflight (Will) | A conversation isn't the agent's context window. Before answering, the agent runs a preflight that chooses what to add to its context: files, wiki pages, TODOs, runs. An answer shows a compact "Context" line listing what preflight added, and Inspect shows the preflight as its first step. This is what keeps `main`'s long conversation usable. | Partial: the preflight exists; the Context line and Inspect cell are missing. |
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
| Presence | Avatars of the people and agents on the branch, and where each one is: a terminal session, a file or a run. | Missing: Pair's presence API was removed in `2753d2e3d2`. |
| Live co-editing | The File card is a live co-editor for code, built on the Yjs collaboration the wiki already uses. Keystrokes reach everyone with the file open in under 1 s, each person's characters in their colour, with a name flag in the gutter on each editor's line. The live document saves to the working copy continuously, debounced, so the header shows "Saved to the machine" and there is no Save button. Writes from the coding agent and from terminals enter the document as attributed edits. | Missing: a new system. The wiki's Yjs sends HTTP updates with an SSE refetch, has no presence, and keeps the document in the API, not on the machine. |
| No silent overwrite | Writes that bypass the live document, such as a terminal tool saving an older copy, are checked against what's there. A save that replaces another writer's change made since the saver last read the file is flagged on the file: "Ben's save replaced Alice's edit · Restore". The branch snapshots on every write. Each terminal runs as its person, so every save has an author. Unsaved terminal-editor buffers belong to that editor. | Missing. Snapshots exist every 30 s today. |
| External changes | Anything can change the machine's files: SSH editors, terminal tools, formatters, package managers, or `git` and `jj` run by hand. The app handles all of it without breaking. The machine watches the working copy and records each change with the person or agent whose user made it. <br>• Branch activity groups each burst into one entry, e.g. "Maya via SSH changed 3 files", which opens the diff. <br>• An open File card applies the change live. A deleted or renamed file says so ("Deleted by Maya via SSH · Restore", "Renamed to `deliver.ts` · Follow"). <br>• Hand-run version control that moves the working copy off its item shows Needs you ("Maya moved this branch off T2 · Undo · Keep"). <br>• The coding agent re-reads changed files before writing. <br>• Ignored paths never show as edits. <br>• Every change is recoverable from the branch's snapshots. <br>The command name on each entry, per-entry Undo, and flags for a save that replaced someone's edit are deferred (§16). | Partial: commit-level head updates every 2 s and snapshots every 30 s. |
| Live updates | File, diff and branch cards update when the working copy changes, showing who changed what. | Missing: only commit-level head updates exist. |
| Terminals | Each person's terminal runs as that person on the machine, with their own home directory, so their tool logins stay theirs. Anyone on the branch can watch any session; only its owner types. Ask to type is deferred (§16). | Partial: terminals can stream to several viewers; per-person homes are missing. |
| Shared agent activity | The coding agent's transcript, steers from any member (with the author shown), and runs are visible to everyone on the branch. | Partial |
| Not in MVP | Carets and selections of other people inside files. The gutter name flag shows where each person is. | Cut |

### 6.9 Coding agent

| Feature | Behavior | Status |
| --- | --- | --- |
| Works TODOs | Runs the repository's TODO flow on the branch machine: route, plan, implement, check, review, open PR, and address review comments. It reads the wiki before planning and cites the page revisions it used. | Partial. Built for configured repositories (`coding/request` → `factory/Todo` → implementation → verify → PR); routes need `.smithers/coding-project.json`. A fresh repository needs automatic configuration (§11.10). |
| Model access | The install's model access is the owner's, connected during setup: provider keys, or a ChatGPT subscription sign-in. Every TODO run records the model access it used. Members' personal subscriptions are used only in their own terminals. | Partial: the ChatGPT pool is behind a flag on self-host. |

### 6.10 Review and merge

| Feature | Behavior | Status |
| --- | --- | --- |
| PR card | The diff, checks run on the machine, GitHub checks, the agent's review summary, the TODO it came from, and **Merge** (enabled only for the next item). Merge records the person's approval of the exact revision they reviewed. | Partial: approval gating is built (D-23). |
| Line comments | Deferred (§16). In the MVP, people comment on the PR on GitHub, and their comments arrive as steers (§6.3). | Deferred |
| Agents can't merge | No agent credential can merge or move `main`. | Built |

### 6.11 Wiki

| Feature | Behavior | Status |
| --- | --- | --- |
| Pages and editing | Read and edit in the app, with live co-editing (Yjs), backlinks and outline. | Built |
| One vault for both agents | The app agent and the coding agent read the same vault. Planning records the page revisions it cited. | Partial |
| Obsidian | Deferred (§16): no route serves the vault as git yet. The vault is plain Markdown, so it stays Obsidian-compatible. | Deferred |
| Generated pages | Pages describing the code refresh after merges. Kept, because they're built and planning reads them. | Partial: built where the repository declares pages; a fresh repository needs a default declaration (§11.10). |

### 6.12 Flows and the factory

| Feature | Behavior | Status |
| --- | --- | --- |
| Default flows | Smithers ships the TODO flow, the learning flow and the stack operations built in. The configuration they need is generated and stored in the install, not committed to the repository. | Partial: the flows are built (except learning), but they need repository configuration today. |
| Flow card | A flow's steps and prompts, with proposed, merged and active versions told apart. Each run shows the step it's on. | Partial: there is a read-only flow viewer. |
| Change the factory | Ask the app agent to change a flow. Only the TODO, learning and review flows, plus any flow the repository adds, can be overridden. A first edit copies the built-in into `flows/<name>/flow.ts`, where the repository's copy wins. Every edit is a TODO a person merges. Overridable flows are repository code, so they always run inside a machine. | Missing: no command edits an existing flow from chat. `/flow.create` is built. |
| Pinned versions | Each run records the exact flow revision it used. A merged customization becomes **Active** once the install has synced it and loaded it successfully. It applies to TODOs started afterwards, while running TODOs and their retries keep their own version. Until it's active, the Flow card shows "Merged · active after sync". If loading fails, the previous version stays active and the card shows "Merged · not active" with the error. | Partial: each TODO's branch machine runs its own coding host, which loads the run's pinned flow closure by digest (`ExecutionSnapshot.restore`), and retries reuse it. A failed refresh dropping the previous version (`Executable.ts:2036`) is the remaining fix. |
| Learning | After each merge, the learning run writes source-linked decisions to the wiki and proposes flow improvements, backed by evidence, as suggested TODOs. A member decides each one. | Missing: `improve.mine` is declared only. Pending notes from failed checks are Partial. |
| Run any flow | Repository flows appear as slash commands with typed input forms. | Built |

### 6.13 Your own agents, the CLI and the API

| Feature | Behavior | Status |
| --- | --- | --- |
| Smithers skill | One skill, which carries the command catalog the app agent uses, so Claude Code, Codex or any other agent can work with Smithers. | Built (incur generates skills from commands) |
| CLI | `smthrs` exposes every MVP flow through the shared command catalog, with typed input. Branch terminals sign in automatically and laptop agents sign in with `smthrs login`. Both use delegated credentials attributed to the member and the agent. Those credentials can't approve, merge or move `main`. A command that needs a person's approval opens a confirmation in the app, bound to the reviewed revision, which agent processes can't reach. | Partial: incur generates the CLI and skills, but the app (271 commands) and the CLI (205) keep two catalogs. M-21 holds once they are one (§11). Delegated agent credentials are Partial too: personal tokens still classify as people. |
| API | The whole HTTP API is open source and documented, and it is the same API the app and CLI use. | Built |
| Attribution | Actions taken through any agent are recorded as the person, with the agent named. | Partial |

### 6.14 Advanced: one click away

These primitives come from the API, and we expose them because "everything is a flow" is the product. They are never on the first screen. Each is one click from a core card and is found after using the core flows: **Inspect** on a run, and **Source**, **Run** and the agent behind a step on a flow. `/help` lists them in a collapsed Advanced group, and the palette finds them by search. One dismissible hint after the first merged TODO points at **Inspect**. No other promotion.

| Primitive | Behavior | Door | Status |
| --- | --- | --- | --- |
| Monitor | The debug view of any run. It shows the flow's graph with live step states and each step's input, output and agent transcript. It also shows the timeline with attempts and retries, durable waits (what a run waits for, and since when), the journal of events, and tokens, time and cost per step. Replay scrubs recorded state read-only (no fork or rewind). A flow can declare a custom view that the monitor shows. | **Inspect** on any run card or TODO step; `/monitor` lists every run. | Partial (run trace, graph, timeline and DevTools exist; DevTools is admin-only) |
| Write flows | Create a flow with the agent's help (`/flow.new`), or open any flow's source in the File card and co-edit it. Preview its plan before running, and run it with typed input on a scratch branch. A flow merges like any change. | **Source**, **Plan** and **Run** on the Flow card | Partial (create-flow and the plan view are built; source editing uses the File card) |
| Configure an agent | An Agent card for each agent the factory uses (planner, implementer, reviewer, and the app agent). It shows the agent's model, which the owner chooses from the install's model access, its instructions (a link to its flow source, edited like any flow), and the runs it took part in. Permissions, tool and budget editing is deferred (§16). | Agent chip on a flow step or a branch's coding agent; `/agents` | Partial: restore the owner-only model configuration (`model.*`, `ModelCards.tsx`) from `5b77095672`, without the lab. |
| Triggers | Deferred (§16). | — | Partial |
| Machine | Deferred (§16). SSH covers hands-on access. | — | Partial |
| Signals and approvals | Every durable wait or approval the factory holds is visible in the monitor. Sending typed signals by hand is deferred (§16). | **Inspect** → wait | Built |

Raw developer tools stay hidden from members: seams, network inspectors, sync operations, the admin console.

### 6.15 Access, secrets and SSH

These are the GitHub-style basics without which most teams can't do useful work.

| Feature | Behavior | Status |
| --- | --- | --- |
| Members and maintainers | A Members card lists everyone with access and their role. A maintainer adds a person by GitHub username. That person must already have access to the repository on GitHub; otherwise the card shows "needs access on GitHub ↗". There are no invitations: the person signs in with GitHub. Maintainers change roles and remove people. Removing someone ends their sessions, terminals and SSH access. Their TODOs keep their history, and any maintainer can take one over. On first sign-in, a GitHub admin or maintain role becomes Maintainer, and write access becomes Member. | Missing (self-host admits one owner; orgs, teams and collaborators exist in the backend but are blocked) |
| Roles | **Owner:** installed it; everything, plus install settings (model access, machine capacity, GitHub App, upgrade). **Maintainer:** merges, manages members and roles, sets secrets, merges flow and agent changes, and manages triggers. **Member:** everything else: create, place, steer, answer and drop TODOs; join branches; terminals; SSH; co-edit; fork; comment; run flows. | Missing |
| Secrets | A Secrets card. Maintainers add, replace and delete secrets. Values are write-only: everyone sees names, nobody reads values back. Each secret is available to every branch's machine as an environment variable, or is main-only (D-24): reaching only trusted runs on `main` and never agent or outsider runs. Provider keys for models stay on the host (§6.9). | Built (CRUD, main-only scope, egress binding); Partial (card polish) |
| SSH into a branch | The Branch card's **SSH** button copies one line, `ssh -p 2222 retry-webhooks@<install host>` (macOS Remote Login owns port 22), using the install's public host name, or `smthrs ssh retry-webhooks`. The person lands as themselves, in the branch's working copy on its machine; connecting wakes it under the admission rules. Keys come from the member's GitHub SSH keys automatically, or from keys added with `smthrs ssh-key`. VS Code, Cursor and Zed remote editing work. Port forwarding (`-L 3000:localhost:3000`) previews a running app. Saves arrive in the live document as attributed edits, and presence shows "Maya via SSH" with the file being edited. Nobody on a machine has `sudo` (M-29). | Partial (the SSH server with workspace sessions is in the open backend and serves Cloud; the self-host binary doesn't start it, and it isn't documented) |

## 7. Decisions

| ID | Decision | Why |
| --- | --- | --- |
| M-01 | A TODO is done when its PR merges into `main` on GitHub. | GitHub is where the team already trusts `main`. |
| M-02 (Will) | On a shared branch, the File card co-edits live, like the wiki, on a new collaborative-document layer on the machine. It saves to the working copy continuously, and agent and terminal writes enter as attributed edits. Out-of-band saves are visible and recoverable. Gutter name flags replace carets and selections. It is in the MVP, and the engineering architecture supports it from stage 1, although it is built in stage 3. | Will: on the same branch it "feels like a CRDT". Co-editing "forces us to architect the engineering up front to support it, and it's a holy shit feature that really makes the value prop clear". |
| M-03 | No public address is required. Smithers polls GitHub (§6.3 targets); webhooks only make it faster. | The team's Mac sits behind NAT. |
| M-04 | Self-improvement goes through review. Memory goes to the wiki; process changes reach flows only as merged TODOs. | A factory that rewrites itself unreviewed can't be trusted. |
| M-05 | Three roles: Owner, Maintainer and Member (§6.15). Access needs a place on the roster (added by a maintainer) plus live write access on GitHub, re-checked at sign-in and hourly; losing write access suspends the member. Maintainers merge, manage people and set secrets. Members do all other work. Agents never merge, and a person's approval binds to the revision they reviewed. | Will asked for maintainer management. Without a roster, every write collaborator in a GitHub organization would get machines and SSH. The maintainer release (§14) needs the maintainer role. |
| M-06 (Will) | Capacity is derived from the detected host (memory, cores, disk), reserving memory for macOS and the install first. It is never tied to a Mac model. Everything beyond capacity queues visibly. | A fixed 3 × 8 GiB fills a 24 GB host before macOS and the backend, and hosts differ. |
| M-07 | One stack per repository. TODOs are placed by Append, Before or Amend, and each TODO is one change and one PR. | This is Will's Mythical rule (AGENTS.md), and it's built. |
| M-08 (Will) | Each branch is one shared conversation, and `main`'s is the team's home. There is no person-to-person chat in the app. Prompts carry their author's authority, and UI-only flows affect only the prompter's own screen. | Will: "each branch is one conversation… you can navigate around the tree structure" and "no chat in the app for now; users can just chat on Google Meet or whatever". |
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
| M-21 (Will) | Any agent can drive Smithers: Claude Code, Codex, or others. It uses the Smithers skill and the `smthrs` CLI, which incur generates from the same commands the app agent calls. The entire API is open source. Actions are attributed to the person, with the agent named ("Ben via Claude Code"). | Agent parity extends beyond our own agents. |
| M-22 | GitHub keeps `main`, issues, PRs, reviews and checks; Smithers keeps TODOs, stack order, live branches, runs, the wiki and configuration. Events flow both ways as in §6.3. Scratch branches never reach GitHub until they join the stack. A merge or close on GitHub counts the same as one in Smithers. | The team's GitHub stays clean and authoritative. Smithers adds the live layer on top. |
| M-23 (Will) | Advanced primitives (the monitor, writing flows, configuring agents, triggers, machine details) ship in the MVP. Each is one click from a core card and absent from the first screen. Custom-agent screens removed by D-11 return only as configuration of the factory's agents. | Everything is a flow, so its primitives are the product's depth. Product judgment keeps them out of the way until someone has used the core loop. |
| M-24 | SSH into a branch's machine is in the MVP: one copyable line, GitHub SSH keys, landing as yourself in the shared working copy. Editors connected over SSH contribute on save, as attributed edits; live keystroke co-editing is the File card's job. | Most engineers do real edits in their own editor. Without SSH, people can only use the browser and terminal cards, which blocks more than half of users from editing on a shared branch. |
| M-25 | Secrets are in the MVP. In-app line comments are deferred (§16); GitHub review comments arrive as steers. | Without secrets, tests that need credentials fail on the machine. GitHub's review UI already serves line comments, and reviewers' comments reach the agent. |
| M-26 | Every MVP install upgrades in place, preserving data, with one owner command. | The maintainer release ships seven days after launch, so every alpha install must take it. |
| M-27 (Will) | External changes to a branch's files are first-class. The machine watches its working copy and attributes every change by user. The app shows grouped activity entries, and open cards reconcile to what's on disk. Nothing breaks, whatever made the change, and every change is recoverable from snapshots. The command name, per-entry Undo and replaced-edit flags are deferred (§16). | Tools outside the collaborative editor can't co-edit, but they must never break the app or go unseen. |
| M-28 (Will) | The install works at any address. It binds loopback by default; the owner sets a bind address and public addresses (http or https) in Settings. The app works on plain HTTP. HTTPS and remote access are the team's choice, and the docs recommend Tailscale or a reverse proxy. | Will: "Tailscale isn't part of our product; it's just how teams practically will often use it." |
| M-29 | Nobody on a branch machine has `sudo`: not members, not agents. System packages come from toolchain detection and the image declaration. Adding one is a change ("Add to machine image"), reviewed like any other. | Personal logins are isolated by user, which `sudo` would defeat. An agent steered by untrusted text must never be able to read a teammate's tokens. |
| M-30 | Only the TODO, learning and review flows, plus any repository flow, can be overridden. Stack operations, merge, members and settings are system flows that can't be overridden. | Customization must never weaken "people merge" or stack order. |
| M-31 (Will) | Once stage 1 passes J1 and J2, Smithers' own development moves onto the stack on Will's Mac mini, and `issue-sweep` stops pushing straight to `main`. | The dogfood target (§10) only counts if we stop using the side door. |

## 8. What we cut

"Cut" means delete from the product surface; libraries stay published. "Defer" means hide now and keep for later. "Hide" means members never see it, but the system still uses it.

| Existing feature | Decision | Reason |
| --- | --- | --- |
| Five-job setup UI (setup tiles and cards, evals, trials, activation wizard) and the CI, Feature and Chores jobs | Cut | TODOs and their flow replace them, and customizing replaces setup. The issue and review machinery (event admission, dispatch, reproduction, review, approvals) stays for §14. |
| Automatic triage, duplicate search and reproduction on new issues; replies to authors | Defer to the maintainer release (§14) | These serve outside contributors. Hide them for the MVP; keep the code. |
| Review of outside PRs | Defer to the maintainer release (§14) | The TODO flow reviews its own work; outside PRs come one week later. |
| Contributor trust rules (agent-filed issues, outsider runs, approved-source revisions, main-only secrets) | Keep and enforce from launch | Public repositories and credentialed agents exist at launch. Required approvals stay visible. |
| CI setup, AI checks, CI matrix | Cut | GitHub checks are the checks. Teams add checks by editing the TODO flow. |
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
| Sync-ops, notifications center, raw devtools (seams, network) | Hide | Developer tools. The member-facing debug view is the monitor (§6.14). |
| TUI | Defer from launch | The GUI is the MVP surface, and the terminal card covers terminal users. |
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
| Core value | 50% or more of a team's merged TODOs need no person editing the code. | Under 25% in week 2. |
| Multiplayer | Each outside team has two or more members acting on the same branch in at least 3 separate sessions a week. | Zero sessions in week 2. |
| Retention | In week 3, each outside team commits 10 or more TODOs. | Fewer than 3 TODOs committed in week 3. |
| Self-improvement | Each outside team merges at least one learning-proposed flow change, and that change measurably helps a later TODO. | No team accepts a proposal in two weeks. |

## 11. Build order: walking skeleton first

Launch needs all three stages. They're built in this order so each stage is usable and testable before the next one starts. Engineering owns the tickets (`.specs/engineering/`).

**Stage 1: the skeleton (J1, J2, J4, J5, J6 step 1).**
1. Mac install: the assembler from `5b77095672` plus a launchd service, bind and public-address settings, an app that works without a secure context, isolation and GitHub settings passed through, and PostgreSQL 18.
2. Team access: multi-member self-host with GitHub sign-in, the roster and roles (M-05, M-17). This is the first engineering ticket.
3. Model access: restore the owner-only model configuration (`model.*`, `ModelCards`) from `5b77095672` for J1 and the Agent card.
4. TODO object: its own prompt, Make TODO drafting, placement, steering a working TODO, stop and resume.
5. Factory editing (J5): `/flow.edit` copies the built-in flow and proposes it as a TODO; the Flow card shows versions; fix `Executable.ts:2036` so a failed refresh keeps the previous version.
6. Fresh repositories: toolchain detection, plus coding and wiki configuration generated in the install.
7. GitHub: the sync-status row, follow `main` by default, reviews become steers, checks read for every PR, and the GitHub App manifest setup.
8. One command catalog for the app and the CLI, trimmed to Appendix A and guarded by an allowlist test, with §8 applied in code.

**Stage 2: multiplayer (J3 without co-editing).**
9. One live branch: drop `user_id` from the active-workspace key (`0084_named_workspaces.sql`). Members and the coding agent share one workspace per branch, with presence.
10. Personal terminals: per-person users and homes, watch-only sharing, no `sudo`.
11. SSH on port 2222 with GitHub keys, and the Secrets card.
12. External changes: watch the working copy, attribute changes by user, grouped activity entries, and live reload of open cards.
13. The admission queue: people first, safe release of idle machines, and sleep reads served from snapshots.

**Stage 3: co-editing and learning (J3 step 5, J8).**
14. Live co-editing of code files: a new collaborative-document layer on the machine (M-02). It is architected in stage 1, so the workspace, file and presence designs of stages 1 and 2 already carry it.
15. Learning: lessons written to the wiki after merges, plus one evidence-backed flow proposal.

## 12. Release

The MVP ships when:
1. J1 to J5 and J10 pass end to end on a fresh Mac mini against a real GitHub repository, reached from a second laptop. The recording includes:
   - a restart mid-run;
   - a duplicate launch;
   - two writers' overlapping and non-overlapping edits to one file, with the conflict resolved;
   - recovery receipts for the restart.
2. The Smithers team meets the dogfood target.
3. Every §8 cut is gone from the product surface.
4. The docs are one quickstart for this user, plus the reference for flows.
5. The macOS install is public and needs no Smithers account.
6. An install made on launch day upgrades in place to the maintainer release, keeping its data (M-26, #1667).

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
- **Trust rules:** already built in the backend. An outsider's issue or PR never starts credentialed work on its own, and an issue becomes a TODO only by a maintainer's action.

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
| Notifications | Deferred: browser, email and phone | §16, [#3423](https://github.com/smithersai/smithers/issues/3423) |
| File history and blame | Deferred | [#3424](https://github.com/smithersai/smithers/issues/3424) |
| Deploy previews (via Actions or integrations) | Deferred; SSH port forwarding covers it for now | [#3425](https://github.com/smithersai/smithers/issues/3425) |
| Mobile web | Deferred | [#3426](https://github.com/smithersai/smithers/issues/3426) |
| Code search, file browsing, branches, issues, PRs, checks | MVP | §6.3, Appendix A |
| Branch protection | Respected, and managed on GitHub | §6.3 |
| Releases, tags, Projects, Discussions, Insights, forks | Not in scope | GitHub keeps them |

## 16. First release after the MVP

These are deferred from the MVP after the Codex Astra and Opus full reviews. None of them is on the path from a TODO to a merged PR on a shared branch, and each is large. They ship in the first release after the MVP, alongside §14 where they overlap.

| Deferred | Area |
| --- | --- |
| In-app line comments on diffs; agent replies inside GitHub review threads | §6.10, §6.3 |
| Stacked PR bases and retargeting (PRs stay based on `main`) | §4.2, §6.3 |
| Laptop pushes brought into the live working copy; **Open on a machine** for teammates' branches | §6.3 |
| Ask to type in someone else's terminal | §6.8, M-18 |
| The command name on each external-change entry, per-entry Undo, and flags for a save that replaced someone's edit | §6.8, M-27 |
| Browser, email and phone notifications (#3423) | §6.4 |
| Triggers, the Machine view, sending signals by hand, and editing an agent's permissions, tools and budget | §6.14 |
| Obsidian access to the vault over git | §6.11 |
| Replacing a stack item's work with a scratch branch | J7 |
| Secret usage by run | §6.15 |

## Appendix A. The MVP command catalog

This is what `/help`, the palette, the CLI and the Smithers skill list for a member. Every entry has three doors: a ⌘K prompt in plain words, the slash command, and a button on its card. Repository flows also appear as their own slash commands (for example `/release-notes`). Controls inside a card (maximize, form fields, filters) aren't listed. The "was" column names the existing command to rename or reuse, and "new" means it doesn't exist yet.

| Slash | What it does | Journey | Was |
| --- | --- | --- | --- |
| **Ask** | | | |
| ⌘K (no slash) | Ask or tell Smithers anything | all | chat.send |
| `/help` | List these commands | | chat.commands |
| `/stop` | Stop the current answer | | chat.stop |
| `/search` | Search code, wiki and runs | J9 | search.open |
| **TODOs and the stack** | | | |
| `/stack` | Show the stack and background runs | J4 | history.show |
| `/todo.new` | Write and place a TODO | J1, J2 | history.todo |
| `/todo.from-issue #n` | Draft a TODO from an issue | J2 | new (issue.implement) |
| `/todo T12` | Open a TODO's card | J2, J4 | history.view |
| `/todo.answer T12` | Answer the agent's question | J2, J4 | approval.approve, runs.signal |
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
| `/review` | Review a change, return findings | J2 | prs.review, flows/review |
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

The app agent acts with the member's authority and appears as "Ben via Smithers": Ben's avatar with an agent badge, in the same pattern as "Ben via Claude Code". Like any agent, it cannot approve or merge. When asked to merge, it opens the person's own **Review & merge** confirmation.
