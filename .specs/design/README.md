# Smithers MVP design

The design spec is a working mock of the app: [`mock/`](mock/). It plays every P0 journey of the product spec on the app's real stylesheet, Paper palette and `@smthrs/ui` primitives. [`../product/mvp.md`](../product/mvp.md) is the requirements authority; this page records the design decisions the mock embodies. [`architecture.html`](architecture.html) draws them: one anchored diagram per recurring question.

Every reel step cites the spec line it shows in the caption chip ("J3.5", "§4.2", "B.4", "M-34"), so a review note lands on that line. Press play to judge motion: co-editing, typing and the composer exist only while a step plays.

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
| J6 Bring your own agent | Claude Code in a Smithers terminal, its own participant: "Claude Code for Ben" |
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
- **Timeline (desktop only).** One element. One line per entry: a title and a cheap model's one-line summary. Live entries pulse, Needs you is gold, and failures are ember. A band marks what is on screen, and the rail scrolls to keep it in view. Live work off screen pins to the top or bottom edge, two rows at most plus a count. On narrow screens each edge collapses to one pill ("↑ 2 live above").
- **Notifications.** Notable events and anything that needs a person are notices: on a desktop they dock at the rail's foot as its own bottom rows (one element per event, never floating over a card); on a narrow screen they float bottom-left. Three at most. One with an action stays until someone acts or hides it; hiding is per person and keeps its timeline entry. At a person's first Needs you, Smithers asks once to notify them while the tab is hidden; on plain HTTP it can't, and Settings links to the HTTPS docs.
- **Shared and personal.** In a branch's conversation, prompts carry their author and Smithers' answers say whom they were for. Cards and receipts are shared. Scroll, card views, theme, notice hides and unsent drafts are each person's own. There is no person-to-person chat.
- **Scroll authority.** A card shown to a person is where they are now: their screen goes there; nobody else's moves. A still or seeked frame shows the step's subject too.
- **Maximize.** Any card opens larger in place, with Restore. Inspect is the maximized Run card.

## Who acts, and how it looks

| Actor | Looks like | Example |
| --- | --- | --- |
| A person | A circle in their lane color | Alice |
| Smithers, undelegated (the stack service, M-34) | An ink rounded square with "S", a participant like anyone: presence, activity, line flags, chat | Smithers · Placed T12 after T9 |
| Smithers acting for a person (the app agent) | The same square in that person's lane color | Smithers for Ben |
| A branch's coding agent | A rounded square with the bot glyph, in its TODO owner's lane color; teal only when it acts for nobody | Coding agent for Ben |
| An agent a person runs (Claude Code, Codex) | Its own rounded square with its initial, in that person's lane color (M-34) | Claude Code for Ben |
| A person over SSH | The person's circle with a terminal badge | Maya via SSH |
| An unattributable outside write | A neutral square | Changed outside Smithers · 3 files |

- **External agents' conversations** (M-38, S2): Claude Code or Codex in a branch terminal shows its conversation in the branch's chat, read-only. Prompts name the session owner and turns name the agent, with no answer, steer, retry or resend controls.
- **Shape says what, color says for whom.** Agents are squares and people are circles. An agent or Smithers acting for a member takes that member's color (ui-components `Actor.color_index`). Status colors (teal live, gold needed, ember failed) are a separate channel.

- **The coding agent renders like a teammate** (mvp.md B.3):
  - reads are a "Read" line whose files open the File card;
  - edits are attributed spans with its line flag;
  - shell commands run in its own Terminal session that anyone can watch;
  - context is the Context chip;
  - a question is Needs you.
- **The app agent** acts with the person's authority, as "Smithers for Ben".
  - **Runs at once:** reads, steer, answer, stop, resume, retry, rebase, fork, run a flow, and wiki writes.
  - **One-click confirmation (A✓):** commit, amend or drop a TODO, add to stack, Bring in or Discard a foreign push, delete a wiki page, propose a flow or agent edit, and `/review`. Any agent acting for a person (Smithers, Claude Code) posts a private Confirm card with the exact command and who asked; only that person sees it and presses it, with ⏎. Everyone else sees "Needs Ben" on the TODO, then the shared receipt (product, 2026-10-02).
  - **A Draft is not a confirmation.** The app agent may draft a TODO; the person's own Commit on their draft is their own act.
  - **Merge:** it opens the person's own Review & merge.
  - **Members, secrets and settings:** it has no path to them.

## The TODO lifecycle

- **States:** Queued → Starting → Working ⇄ Needs you → In review → Merged.
  - Stop → Paused, and Resume → Queued.
  - Failed → Retry → Queued, as a new attempt beside the old one.
  - An answer that arrives after the machine was released → Queued.
  - Dropped is a person's act.
- **One attempt is one durable run:** Plan → Implement → Verify → Review → Propose, then a calm, dashed wait for merge. A rebase signal loops the run back to Verify. Every card's step strip ends in that wait.
- **Evidence is bound to a revision** (spec §10.4.3). A clean rebase reruns the checks only; the earlier review stands, labelled "Reviewed 8b1e204 · same change". New code or a resolved conflict reruns the review too, and the earlier review is not shown. Any rebase clears an approval.
- **One merge rule** (`mergeReadiness` in `mock/src/world.ts`, spec §10.6.2a's MergeReady), read by the Home row, the TODO card and Review & merge. The first failing row is the reason: in review ("Needs you"), stack order ("Merges after T8"), rechecking on the machine ("Checks running on c41a9e0"), then required GitHub checks and GitHub's rule in its own words, with a link to the PR. The reason is text beside where Merge would be, never a disabled button. Role is not a row: a member gets no Merge and reads the same reason, or "Ready · a maintainer merges".
- **Stop is not offered while a question or approval waits** (spec §10.7.1).
- **Run monitor.** Phase titles are deterministic, from the step and its output ("Ran tests · 1 failed ×3"). The one-line summary under each and every cell's explanation are the fast model's, marked with a small sparkle; without one, the title stands alone. Answer settles a question; Steer never does.
- **Refs never reorder.** A TODO keeps its T number from commit; a new one takes the next number above every existing ref.
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

The port follows [`../engineering/ui-components.md`](../engineering/ui-components.md) in its order of need (T-UI-01..20). Design builds each card as a props-only View in `apps/app/src/mainview/cards/views/*View.tsx` with fixtures in `cards/fixtures/` and styles in `styles/views.css`; the frontend lead's containers feed it `CardProps<M>` and turn `onAction(action.tag)` into catalog commands. A View imports no state, flow or RPC module (C-UI-08). A field a View needs that the model lacks is a spec change raised with the tech lead, never a workaround. Once a View exists, the mock renders that View through an adapter, so later polish lands in the product, not here.

## Decisions taken with Will (2026-10-03)

- Self-hosted first stands, with bring-your-own keys: core users won't adopt without them. A Cloud-first, Smithers-billed release was considered and dropped the same day.
- Only the fast model runs on Smithers' infrastructure: Cerebras, reached by signing the install in to a Smithers account with GitHub. The coding model and the AI Gateway stay the team's own keys.

## Decisions taken with product (2026-10-02)

- The install runs on one Mac: `smthrs host start` prints a one-time setup link, and `smthrs host upgrade` upgrades it. It serves plain HTTP and listens only to this Mac until the owner lets the network in. HTTPS comes from what the team puts in front; the journeys use `https://maya-mini.tail1234.ts.net`. SSH is `ssh -p 2222 <branch>@<that host>`, and laptops connect with `smthrs login <address>`.
- Setup asks for the address first, because the GitHub App's callback returns to it.
- Model access has three roles: a fast model for the app agent and summaries, a coding model (a key or ChatGPT sign-in), and the AI Gateway key for typed decisions. The fast model is Cerebras through Smithers' own infrastructure (2026-10-03, above).
- People take machines ahead of queued TODOs. Opening a sleeping branch never wakes it.
- Live co-editing happens in the File card. SSH editors join on save. An outside burst is one entry, named only when one session was running; its diff offers Restore this file.
- Smithers never overwrites a person's commit: a laptop push is Needs you, with Bring in or Discard.
- Agents never approve or merge.
- A late answer reads "Ben answered" and keeps the draft as Send as steer.
- Flow versions are Active, Proposed, "Merged · active after sync" and "Merged · not active". System flows are read-only.
- Roles are Owner, Maintainer (merges, people, secrets) and Member. A member never gets Merge.
- There is no sudo on a machine. A missing system package offers "Add to machine image", a reviewed change.
- Deferred features are listed in the "Not in this release" reel, not hidden by their absence.
- Machine placement (#3706, flag `remote_sandboxes`): a branch's machine runs on a **computer**, which is This Mac, an SSH computer or Smithers Cloud. The owner adds computers in Settings; cards show `· beaver`; a TODO picks Runs on in its Draft. See [placement.md](placement.md).

## Real-app changes from this design work

- c6cff4d8 (#3418): skeletons use `--surface-2`.
- 0d92b5c2 (#3419): toast detail wraps.
- c22ce091 (#3420): the toast stack caps at three with "+N more".
- c04637a6 (#3421): every `:focus-visible` outline uses `--ring-border`.
- 664360dc (#3427): the light focus ring is `--water-500` (4.57:1 on `--surface-2`), with a 3:1 contrast test in every palette and mode. 803cbc58 removed two node_modules symlinks that commit carried by mistake.
