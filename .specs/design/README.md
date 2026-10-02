# Smithers MVP design

The design spec is a working mock of the app: [`mock/`](mock/). It plays every P0 journey of the product spec on the app's real stylesheet, Paper palette and `@smthrs/ui` primitives. [`../product/mvp.md`](../product/mvp.md) is the requirements authority; this page records the design decisions the mock embodies.

## Run it

```sh
node .specs/design/mock/build.mjs        # writes mock/dist/index.html, one self-contained file
open .specs/design/mock/dist/index.html
node .specs/design/mock/check.mjs        # every step renders, and its pointer target exists
node .specs/design/mock/copy.mjs         # copy lint: no banned words, card lines of 12 words or fewer
apps/app/node_modules/.bin/tsc -p .specs/design/mock/tsconfig.json
node .specs/design/mock/shot.mjs <name> "j=j3&s=7" [--dark] [--width=390 --height=844]
```

Keys: Space plays or pauses, ← and → step, T switches the theme, and 1–9 pick a reel. A link with `?j=j3&s=7` opens a reel at a step.

| Reel | Shows |
| --- | --- |
| J1 Install | `smthrs host start` and its one-time link; setup in four asks (address, GitHub, repository, three model roles); Source ready before Machine ready; a first merge inside 60 minutes; members and secrets |
| J2 Issue to merged PR | Make TODO, Place, one question, the one-time notification ask, evidence, Merge, learning |
| J10 GitHub sync | Smithers and GitHub side by side: comments become steers, a laptop push is brought in, later items' PRs are drafts, merges cross both ways |
| J3 Join a branch | Two people and a coding agent on one branch: live co-editing, a watched terminal, SSH, outside changes |
| J4 The team's work | The stack as the morning view: answer, merge, reorder, retry |
| J5 Teach the factory | A flow edit as a TODO, versions, a learning proposal |
| J6 Bring your own agent | Claude Code in a Smithers terminal, acting as "Ben via Claude Code" |
| J7 Plan and fork | Insert, amend, fork a scratch branch, add it to the stack, drop, rebase |
| J8 Memory | A learning run writes a wiki decision; two people co-edit it; the next plan cites that revision |
| J11 Under the hood | Inspect a merged run, edit the flow's source, run it on a scratch branch, change an agent's model |
| Inside a run | One durable run per attempt: phases, thrashing, a wait for a person, a steer, the wait for merge |
| The coding agent at work | Each coding-agent action rendered as a teammate's (mvp.md B.3) |
| Ask Smithers | The app agent through ⌘K: answers, drafts, the person's own merge, a missing-input form |
| States | Every card state, one per step |
| Not in this release | Every deferred feature, one line each, for ratification |

## The model in one picture

```
acme/api                                   one stack, in merge order
main ──┬── T8   upgrade-stripe      In review   next to merge
       ├── T9   retry-webhooks      Needs you   Alice, coding agent
       │     └── ben/retry-try-2    scratch     Ben
       ├── T10  fix-checkout-race   Working
       └── T11  log-retries         Queued #1
```

- A TODO is one stack item, one change and one PR. Its ref (T9) is stable; the GitHub number is GitHub's.
- A branch is where work happens: a machine, the people and agents on it, its activity, files and terminals. Each stack item has one; a scratch branch is a fork.
- Each branch is one shared conversation, and main's is the repository's. Everyone on a branch sees every prompt and card; scroll position and card views stay each person's own.
- The conversation is not the agent's context. Preflight chooses context, shown as a "Context · 4" chip that each person expands.

## The shell

- **Chat plus cards.** Every surface is a card in a conversation. There are no tabs, no notification center and no repository switcher.
- **Crumbs and the branch tree.** `acme/api / main / retry-webhooks ▾`. Parent crumbs go up; the last crumb opens the branch tree: main, each item's branch in stack order, and forks under their origin, with presence.
- **Timeline (desktop only).** One line per entry: a title and a cheap model's one-line summary. Live entries pulse, Needs you is gold, and failures are ember. A band marks what is on screen. Live work off screen pins to the top or bottom edge, two rows at most plus a count. On narrow screens each edge collapses to one pill ("↑ 2 live above").
- **Notifications.** Notable events and anything that needs a person also pop at the bottom-left, three at most. One with an action stays until someone acts or hides it; hiding keeps its timeline entry. At a person's first Needs you, Smithers asks once to notify them while the tab is hidden; on plain HTTP it can't, and Settings links to the HTTPS docs.
- **Maximize.** Any card opens larger in place, with Restore. Inspect is the maximized Run card.

## Who acts, and how it looks

| Actor | Looks like | Example |
| --- | --- | --- |
| A person | A circle in their lane color | Alice |
| A branch's coding agent | A teal rounded square | Coding agent |
| An agent acting for a person | The person's circle with an agent badge | Ben via Smithers, Ben via Claude Code |
| A person over SSH | The person's circle with a terminal badge | Maya via SSH |
| The stack service (jj) | An ink square, "Smithers" | Maya asked · Rebased onto T8 |
| An unattributable outside write | A neutral square | Changed outside Smithers · 3 files |

- **The coding agent renders like a teammate** (mvp.md B.3):
  - reads are a "Read" line whose files open the File card;
  - edits are attributed spans with its line flag;
  - shell commands run in its own Terminal session that anyone can watch;
  - context is the Context chip;
  - a question is Needs you.
- **The app agent** acts with the person's authority, as "Ben via Smithers".
  - **Runs at once:** reads, steer, answer, stop, resume, retry, rebase, fork, run a flow, and wiki writes.
  - **One-click confirmation (A✓):** commit or drop a TODO, add to stack, delete a wiki page, and propose a flow or agent edit. Only the asker can press it, with ⏎.
  - **Merge:** it opens the person's own Review & merge.
  - **Members, secrets and settings:** it has no path to them.

## The TODO lifecycle

- **States:** Queued → Starting → Working ⇄ Needs you → In review → Merged.
  - Stop → Paused, and Resume → Queued.
  - Failed → Retry → Queued, as a new attempt beside the old one.
  - An answer that arrives after the machine was released → Queued.
  - Dropped is a person's act.
- **One attempt is one durable run:** Plan → Implement → Verify → Review → Propose, then a calm, dashed wait for merge. A rebase signal loops the run back to Verify. Every card's step strip ends in that wait.
- **Evidence is bound to a revision.** A rebase or push reruns the checks, and an earlier approval no longer applies.
- **Merging is in stack order.** Later items' PRs are GitHub drafts ("Draft · merges after T8"). They are based on main and list the earlier items they include. An item merged out of order on GitHub reads "Merged · in T15's commit".

## Cards

| Card | Is |
| --- | --- |
| Home | The stack: main pinned on top with sync health, items in merge order, counts as filters, live background runs, machines |
| TODO | The work: prompt, place, step strip, the question, evidence, Merge |
| Branch | The place: machine state, everyone on the branch, activity, files, terminals, Fork, Add to stack, Rebase now |
| File, Diff | A live co-editor with name flags and code intelligence; hunks with authors; Compare and Restore for outside changes |
| Terminal | A personal session: its owner types, everyone else watches |
| Run | Phases at a glance; maximized, the attempt graph, a timeline under step headers, and an explanation on every cell |
| Review, Confirm | /review findings with Please fix; the person's own Review & merge |
| Act | The app agent's A✓ confirmation, then its receipt |
| Issue, Draft | GitHub discussion; a TODO being written and placed |
| Flow, Proposal, Agent | Steps, versions and the merge wait; a learning suggestion; an agent's instructions file and model |
| Wiki | A page co-edited live, with its revision and the change it came from |
| Setup, Settings, Members, Secrets | Install and owner administration |
| Commands, Form | /help; typed input for a command missing its arguments |

## Visual rules

- **One meaning per color.** Teal means live or act. Gold means a person is needed. Ember means failed. In review, Merged and waiting for merge are neutral. Violet is retired from the chrome.
- **One state vocabulary.** Each TODO state has one glyph and one pill, on every card.
- **One solid button per card,** for its primary act. Row actions are outline buttons; order lives in a ⋯ menu.
- **Minimal text.** A count, an avatar, a chip or a diff instead of a sentence. Card body lines are 12 words or fewer.
- **Product words only:** TODO, branch, change, stack, issue, run, wiki, flow, member and machine. `copy.mjs` bans workflow, thread, task, lane, box, workspace, mythical, sandbox, VM, seat, profile, Jev and forge.
- **Honest state.** Nothing shows before it is true. Waiting carries its reason and place, and background work settles in place.
- **One focus ring:** `outline: 2px solid var(--ring-border)` on every `:focus-visible`.

## Porting

`mock/src/mock.css` and `mock/src/css/*.css` mark proposed product CSS with **PORT** and the review harness with **MOCK**. Cards are written against the app's own `.smithers-card` anatomy, so each `cards/*.tsx` maps to one app card renderer. `world.ts` lists what each card reads; it is the design's view of the data, not an API.

## Decisions taken with product (2026-10-02)

- The install runs on one Mac: `smthrs host start` prints a one-time setup link, and `smthrs host upgrade` upgrades it. It serves plain HTTP and listens only to this Mac until the owner lets the network in. HTTPS comes from what the team puts in front; the journeys use `https://maya-mini.tail1234.ts.net`. SSH is `ssh -p 2222 <branch>@<that host>`, and laptops connect with `smthrs login <address>`.
- Setup asks for the address first, because the GitHub App's callback returns to it.
- Model access has three roles: a fast model (Cerebras) for the app agent and summaries, a coding model (a key or ChatGPT sign-in), and the AI Gateway key for typed decisions.
- People take machines ahead of queued TODOs. Opening a sleeping branch never wakes it.
- Live co-editing happens in the File card. SSH editors join on save. An outside burst is one entry, named only when one session was running; its diff offers Restore this file.
- Smithers never overwrites a person's commit: a laptop push is Needs you, with Bring in or Discard.
- Agents never approve or merge.
- A late answer reads "Ben answered" and keeps the draft as Send as steer.
- Flow versions are Active, Proposed, "Merged · active after sync" and "Merged · not active". System flows are read-only.
- Roles are Owner, Maintainer (merges, people, secrets) and Member. A member sees "A maintainer merges".
- There is no sudo on a machine. A missing system package offers "Add to machine image", a reviewed change.
- Deferred features are listed in the "Not in this release" reel, not hidden by their absence.

## Real-app changes from this design work

- c6cff4d8 (#3418): skeletons use `--surface-2`.
- 0d92b5c2 (#3419): toast detail wraps.
- c22ce091 (#3420): the toast stack caps at three with "+N more".
- c04637a6 (#3421): every `:focus-visible` outline uses `--ring-border`.
- Filed: #3427 (light ring contrast; use `--water-500`) and #3428 (DeadCss red).
