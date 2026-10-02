# Smithers MVP engineering rules

## Background work controls and prompt queue (Will, 2026-09-24)

Background worker controls belong in the shared toast stack. Offer the actions
the observed worker state and host support; keep progress through launch and
execution. Share worker-action rules and prompt queue behavior with the TUI.
Enter steers the current turn; Alt+Enter queues a follow-up. Keep queued prompts
durable, scoped to their conversation, and editable without blocking Chat.

## Keyboard-only access is a product rule (Will, 2026-09-08)

Users must be able to operate all of Smithers without a mouse. Every action needs an accessible keyboard path, visible focus, and predictable focus movement. Use native control semantics, Tab/Shift-Tab navigation, Enter/Space activation, Escape dismissal, and appropriate arrow-key navigation. Preserve normal text editing. No hover-only, drag-only, or pointer-only required action. Keyboard-only completion is a release check for every new workflow, including onboarding.

## Signup onboarding (Will, 2026-09-20; amended 2026-10-01)

A signed-out cloud visitor (and any session whose signup stage is short of `done`) sees the signup in the transcript, never a page of its own, and it owns the screen: no Chat controls, no rail, no host diagnostic. An animated title-sized "Automate maintaining your codebase" (the landing tagline, which glides into it) sits at the top over the one sign-in door (GitHub = `auth.sign-in`), then "Finish creating your account" (full name prefilled from the GitHub profile name, `smithers.sh/<account>` prefilled from the login), then one question, the repository to connect: one button per GitHub repository plus Skip (amended 2026-10-01: the other six poll questions were cut because nothing read their answers, and the "Try Smithers on a new repo" tile was cut because it did what Skip does), then "Welcome, <first name>" with one giant Start Automating button. Each stage shows only itself: no receipts of earlier stages. Every stage and answer lives on `session.signup` (`state/Signup.ts`) so a reload resumes it. Start Automating sets the stage to `done`, after which every visit shows the first-run below. A session saved before this field existed skips the signup when signed in. Reference: `cards/SignupCards.tsx`, `state/controller/signup.ts`, `flows/entries/signup.ts`, `e2e/playwright/signup.spec.ts`.

## App home (Will, 2026-09-26, D-18)

A repository with apps in its homepage (`.smithers/FACTORY.ts` `S.Home.App`, D-11a) opens on the app home and nothing else: the prompt's title, the composer, and one picture tile per app. An app is a featured flow with a picture; there is no app model, registry or card of its own. A tile is the button door of its flow opened without input, so THE FORM LAW renders that flow's form (one input, one button) and the real run card follows; the launch is acknowledged at once and the toast follows the run. A tile shows the app's last result (the newest run card of the workflow its flow launches, `FlowMetadata.workflow`) where one exists, otherwise its picture. Signed out, the tiles show and opening one asks to sign in. The setup checklist, the recommended jobs and the host diagnostic below are the home of a session with no apps. Reference: `cards/RepositoryHomeCard.tsx`, `e2e/playwright/home-apps.spec.ts`; the TUI lists the same apps (`apps/tui/src/home.ts`) and `smthrs ls` prints them.

## First-run experience (Will, 2026-09-15, after the signup since 2026-09-20)

Open the app directly. New sessions show ONE first-run card, the setup checklist (Talk to Smithers → Connect GitHub → Add a repository → Set up a job; on the cloud web app the signup is the GitHub sign-in, so it lists Talk to Smithers → Add a repository → Set up a job), whose steps check off from live state and whose buttons are those steps' flows. Talk to Smithers is `chat.open` with a ⌘K key chip and checks off once the conversation holds a message from the person (Will, 2026-10-01). The last step IS the repository's job tiles (the five jobs, then the repository's featured flows), each tile reading the state its card reads. When every step is complete, or the card is dismissed, only the tiles remain: every conversation still reaches every job in one press (amended 2026-09-18; one card since 2026-10-01, which retired the separate "Learn how to" recommended-actions card). The signup owns the screen until it is done: no Chat controls, no rail, no host diagnostic. While the first-run card is all the transcript holds it sits at the top, as the signup does. On the cloud web app Chat arrives with the first job: its controls stay away until a job is registered, the card is dismissed, or the person sends a message (never while no job tile is offered), then rise in once (Will, 2026-10-01). Signed-out visitors start with the practice repository behind the signup. First-sight hints use HelpBubble, persist dismissal, and show one at a time in DOM order. Command/Control-K opens Chat, also while its controls stay away; touch hints omit key names. There is no scripted lesson sequence.

## Current onboarding brief (Will, 2026-09-08)

The new shell opens with a one-second SMITHERS entrance and progressively introduces capabilities. The UI is the default view: full-screen, no composer, and a composer left open is never restored on load. Command-K summons ONLY the composer — one solid floating card in a transparent layer over the content at the top of the page; the chat history lives in the full-screen UI underneath. Escape, a press outside the card, or a second Command-K dismisses it (Will, 2026-09-14: this restores the pre-dock overlay and supersedes the 2026-09-09 bottom dock). The guide's lessons keep their own bottom Chat dock, documented in `docs/ONBOARDING.md`. This explicit brief supersedes the always-visible-chat and fixed-sidebar requirements below. Outputs still use the existing flows and shared state.


## ⚖️ THE EMBED LAW — read this before anything else (will, 2026-08-09, permanent)

**Everything embeds in the chat. Nothing opens full-screen unless the user explicitly asks.**

This binds BOTH agent populations:

1. **Agents building this app:** every capability's output renders as a card/embed inside the transcript at conversation width, composer visible below. Building a surface that opens as a takeover/full-screen/second view by default is a defect — the diff gets rejected. Full-screen exists only as a _presentation transition of the same embedded component_ (maximize), entered only by the user's explicit act.
2. **The agent inside the app (encode this in its system prompt and tool projection):** when the user asks about something ("what is in the wiki?"), the agent ANSWERS IN THE CHAT — with an embedded card when a surface is involved — and never opens a full-screen view. Surface-maximizing commands are user-triggered only (`trigger: user` on the axis); the agent's invocation of any surface command renders its embedded form. Full-screen happens only when the user explicitly asks for it, in those words.

The user has stated this law repeatedly; violations keep shipping. Treat any full-screen-by-default behavior — new or existing — as a bug to fix on sight, not legacy to preserve.

## ⚖️ NO INVENTION (will, 2026-08-09, permanent)

Nothing user-visible may be added unless the current brief or the canon (`DESIGN.md`, the vault laws) names it: no decorative chrome, no status badges, no extra pills, no helpful-seeming labels or placeholder copy. Absence is the default; an empty state is a valid state. Unrequested user-visible additions are defects, not initiative.

See the [permanent MINIMAL TEXT rule](../../AGENTS.md).

## ⚖️ THE THREE-DOOR LAW (will, 2026-09-03, permanent)

**Anything a button does, the agent can do.** Every act is ONE flow with three doors: slash, button, and agent. `userOnly` is an enumerated exception for acts that are physically the human's gesture (a folder dialog, an OAuth redirect, focus, a menu, a slider, the clipboard) or that the human alone may answer (a confirm dialog, a picker card, an approval), and every such flow names its reason in the registry as `userOnlyReason` — `flows/agent-parity.test.ts` enumerates every one and fails on a user-only flow without a reason. Consequential acts (launching Claude Code or another harness, running a target, closing a session, unpinning a repository) are agent-invocable WITH `confirm`: the agent's invocation renders the confirm card and the human's click runs the flow. They are never user-only because they are consequential. When a user-only act has an agent door (`auth.prompt`, `cloud.prompt` render the human's button in the chat), the refusal names it. Opening a local terminal or launching a harness is the product's main act, not browser mechanics. The button door is typed on both sides: a card names its flow as a `FlowName` (`flows/FlowName.ts`, so a misspelling does not compile) and hands its values to `flowArgs` (`flows/FlowArgs.ts`), which writes the one slash line the flow's grammar parses. A card never interpolates a line of its own; only the slash door passes text a human typed.

## ⚖️ THE FORM LAW (will, 2026-09-03, permanent)

**A flow invoked without its required input, by the agent or by a slash, renders a form card for exactly the missing fields, prefilled with whatever was given. No door ever answers with a usage sentence.** The form is derived from the flow's own input schema (`@smthrs/ui/flow-form`) plus the flow's `form` hints; its options come only from the seams (installed harnesses with credential state, model lists, open repos, cloud repos, loaded bookmarks, workspaces, agents); its draft lives in the card payload and commits through `form.set`; Submit (`form.submit`) runs the same flow as the actor that asked, so a consequential flow the agent asked for still confirms. The agent's tool result says "rendered a form for <fields>" so the model tells the human to fill it in, never to type arguments. A button always carries its args and never meets the form.

- Do not use React `useEffect` in application code.
- Prefer derived values during render, event-driven updates, TanStack Query for server state, and focused hooks from a maintained hooks library for external subscriptions.
- If synchronization truly cannot fit one of those patterns, stop and document why before introducing lifecycle synchronization.
- React components are projections, never authorities for application state. Store all application state in TanStack DB collections.
- `useState` is exempt only for transient chrome that no reader would miss after a reload: a "Copied" flag on its timer, a menu's keyboard highlight, an open/closed disclosure with no address. Anything a card projects — a filter, a selection, a drawer, a view mode — lives in the card payload and changes through a flow, so it survives a reload and an open-in-tab (`cards/TargetCards.tsx` `target.filter` / `target.select`, `cards/GraphCard.tsx` `target.graph.filter` / `target.graph.focus`).
- Human, Smithers, and system changes must enter through the shared Flux transition dispatcher with their actor recorded.
- Persist local collections with SQLite. Preserve the collection boundary so Electric can become the synced authority without rewriting UI consumers.
- Keep Smithers' Wiki (its world state; the `world` ids persist under the Wiki label) as Markdown-native, linked documents in its own TanStack DB collection. Record provenance, confidence, actor, and revision; do not present inferred world state as ground truth.
- Build every agent context from a fresh versioned world-state snapshot. React does not assemble or own agent context.

## Frames are the navigation model

- New capability output appears first as a chat message containing an embedded mini-app. No capability opens a tab or replaces chat by default.
- Embedded and maximized views render the same frame component from the same persisted state. Maximizing is a presentation transition, not a second implementation.
- A maximized frame keeps Smithers chrome visible: the composer overlays or remains adjacent to the content, and minimize, back, and forward remain available.
- Every visible frame has a durable identity, parent frame, workspace, branch, and app-state revision. Persist the frame graph in SQLite through the shared transition dispatcher and journal.
- Put stable frame, workspace, and branch identifiers in the URL. The URL is a pointer into durable state, not the state payload.
  Exception (will, 2026-09-07): the app for a repository lives at exactly /owner/name; when the page boots from that path the address bar keeps it for the page's life and the frame location travels in history.state (runtime/FrameHistory.ts).
- Browser back and forward traverse frame history. Core recorded-branch and historical-fork machinery remains available to the libraries; user-facing fork and rewind controls are deferred for the MVP (Will, 2026-10-01).
- Frame navigation, maximize, minimize, back, and forward are Flows with the same slash, agent, and button invocation path as every other capability.
- Deep-link reload, back/forward, unchanged embedded/maximized component identity, and composer visibility are mandatory end-to-end tests. Core fork and recovery tests retain coverage of historical mutations.

## New Smithers only

- Product code under `src/` uses the new Flows, Harness, Journal, Kernel, and related `@smthrs/*` implementations owned by this repository's `packages/` tree.
- Do not import retired runtime packages into the product.
- The `smithersai/ui` repository is interaction reference code, not a dependency authority; its remaining `@smthrs/*` imports do not authorize those imports here.
- Enforce this boundary with dependency and forbidden-import tests so a legacy package cannot return transitively unnoticed.
- Smithers workflow dashboards under `.smithers/ui/` are control-plane tooling, not shipped product code, and may use the workflow runtime's own Gateway UI components.

<!-- smithers:prefer-workflows START -->

## Smithers workflows

Use your best judgment, weighing speed, quality, and token usage, to decide
whether a request should run as a [smithers.sh](https://smithers.sh) workflow
or with regular subagents. Prefer a smithers workflow for multi-step plans and
for work that benefits from retries, approvals, review, or replay; reach for
plain subagents when a request is a quick one-off.

Use the repository [Smithers maintenance skill](../../.agents/skills/smithers-maintenance/SKILL.md)
for current CLI and flow authoring guidance. Check `smthrs flow list` for
available file flows and `smthrs flow start <id>` to launch one; inspect the
run receipt before reporting completion.

When a session ends successfully and the work could have been a smithers
workflow, offer to turn the session into a reusable smithers workflow for next
time.

<!-- smithers:prefer-workflows END -->
