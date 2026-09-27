# Lane `agent-parity` — REPORT

> Superseded 2026-09-27 (smithersai/smithers#2229): the terminal and harness tabs, the `+` menu, `tab.terminal`, `tab.harness`, `tab.read`, `tab.menu`, `tab.close.confirm/cancel`, the `pty.*` transitions and the harness inventory are gone. Tabs are card tabs (`tab.card`, `tab.select`, `tab.close`); a terminal is the workspace card's Terminal facet. The text below is the record of the lane as it ran.
>
> Superseded 2026-09-27 (smithersai/smithers#2239): the local repository inventory (`repos.loaded`), pins (`repo.pinned`, `repo.unpinned`, `repo.unpin`), `repo.open`, `local:` working copies and `POST /api/repo/files` are gone. Working copies are boxes and shared copies.

Brief: `agent-parity.md`. Law: `apps/app/AGENTS.md` "THE THREE-DOOR LAW".
Status: shipped and green. `bun x tsc --noEmit -p .` clean in `apps/app` and
`packages/rpc`; the brief's verification set 246/246 (17 files); `bun test
src/mainview` 1474/1474 (139 files; the three TargetGraph.integration fixture
failures the brief warned about did not occur in this run); `cd packages/rpc &&
bun test` 132/132. Nothing committed; no `jj`/`git` write ran.

## What shipped

1. **The policy table, in `flows/Flows.ts`.** Seventeen flows left `userOnly`:
   - agent-invocable, listed, no confirm: `tab.terminal [cwd]`, `tab.card`,
     `repo.tree`, `workspace.rename`, `target.open`, `change.pins`,
     `change.checks`, `box.facet`, `change.facet`;
   - agent-invocable, listed, **confirm**: `tab.harness` ("launch a harness as
     a session"), `agent.role` ("launch an agent role as a session"),
     `tab.close` ("close the session"), `repo.unpin` ("unpin the repository"),
     `target.run` ("run the Smithers target"), `target.run.pattern` ("run the
     Smithers verb over the pattern"), `repo.open [path]` (confirms only when a
     path is given, see 4);
   - agent-invocable, hidden, **confirm**: `flow.run.retry` ("check the run
     again").
   Every remaining `userOnly` flow carries a `userOnlyReason` (new field on
   `FlowMetadata`, `flows/registry.ts`). `auth.sign-in` / `auth.sign-out` were
   NOT user-only in the tree despite the trigger axis, the brief's "keep", and a
   dead `USER_ONLY_ALTERNATIVES` entry; they are user-only now, with reasons, and
   added to `USER_ONLY_VISIBLE` (invocable.test.ts's exception list).
2. **`cloud.prompt`** (runtime `["Smithers Cloud"]`, listed, "Offer the Smithers Cloud
   sign-in step in the chat"): one Smithers message with action
   `{ flow: "cloud.sign-in", label: "Sign in to Smithers Cloud" }`; signed in it
   answers "Smithers Cloud is already signed in as <user>." On a host without
   the PAT door (the web, where the GitHub sign-in IS the Cloud sign-in) it
   renders `auth.prompt`'s step instead of a button to an absent flow.
   `promptCloudSignIn` lives beside `promptSignIn` in `state/AppController.ts`.
3. **The Smithers Cloud line in the runtime context.**
   `packages/rpc/src/AgentContext.ts` gains optional
   `cloud: { state: signed-in | signed-out | degraded | unavailable, username }`
   and renders `- Smithers Cloud: signed out (workspaces, changes and sync need
   it; cloud.prompt renders the sign-in button).` / `signed in as <user>.` /
   the degraded and unavailable lines. `state/controller/turns.ts` fills it from
   `cloudSessions` on the native host, from the GitHub identity on the web host,
   and `unavailable` where no `cloud.pat` door exists.
4. **The agent doors in `flows/agentTools.ts` and `flows/Commands.ts`.**
   - `USER_ONLY_ALTERNATIVES` is now the "instead" clause only (`auth.sign-in`,
     `cloud.sign-in` → "invoke cloud.prompt, which renders that button in the
     chat", `app.download`, `admin.reset`, `chat.send`, `card.maximize`); the
     dead alias rows (`reset`, `theme`, `dark-mode`, `send`, `appearance.*`)
     are gone. A refusal reads `failed: /<name> is user-only — <userOnlyReason>
     [— <alternative>]` on both agent doors (`executeAgentToolCall` and
     `runForAgent`).
   - A handler refusal returned to the AGENT has its imperative
     "sign in … /cloud.sign-in" rewritten to name `cloud.prompt`
     (`agentFailureText`, applied in `settle` for the agent invoker only). The W0
     `explainAbsent`/`unavailable` path is untouched: "/cloud.sign-in is not in
     the web app — …" keeps its name (Commands.test.ts pins it).
   - `confirm` accepts a payload-aware function (`confirmLabel` in
     registry.ts); only `repo.open` uses it: a named path confirms ("open the
     local repository at <path>"), no path never reaches the folder dialog —
     `openLocalRepo` refuses the agent actor with "Name the path: repo.open
     <path> — the folder dialog is the human's to open."
   - `tab.terminal [cwd]`: `openTerminalTab(cwd?)` resolves `cwd` to an OPEN
     working copy by path, server id, display name, or pin key, and refuses
     anything else listing the open ones. The local server takes a repository
     id and never a filesystem path (`src/bun/server.ts`: "Browser input
     carries a repo id, never a filesystem path"), so an arbitrary directory is
     not a door here; `repo.open <path>` is.
   - `flows/SlashPayload.ts`: `tab.terminal` → `optional("cwd")`, `repo.open`
     → `optional("path")`.
5. **`state/Instructions.ts`**: the capability sentence names "open a local
   terminal, launch Claude Code or another harness as a session (confirm)".
6. **`apps/app/AGENTS.md`**: THE THREE-DOOR LAW, after NO INVENTION.

## The final user-only allowlist (49 flows, each with its registry reason)

Pinned verbatim in `flows/agent-parity.test.ts` `USER_ONLY_ALLOWLIST`; the gate
unions the native (EVERYTHING) and cloud registries as an admin, so the
host-scoped and admin-plugin flows are covered.

| Flow | Reason |
| --- | --- |
| `chat.send` | the composer is the human's; the model is already the turn, and sending would nest one |
| `chat.stop` | stopping the model's own turn is the human's Escape key |
| `chat.copy-message` | the clipboard write is the human's browser gesture |
| `flows` | a surface switch; the model lists flows with flow.list, which answers as an embedded card |
| `system.recommend` | the system's own refresh; a model must not steer what the human is offered next |
| `flow.repo.choose` | the answer to the which-repository card is the human's choice; a model must not provision on its guess |
| `card.maximize` | maximizing a card is the human's explicit act (THE EMBED LAW) |
| `card.minimize` | minimizing a card is the human's explicit act |
| `frame.back`, `frame.forward` | frame navigation is the human's browser gesture |
| `frame.fork` | forking a frame is the human's browser gesture |
| `connector.remove.ask` | opens the human's confirm dialog; the act itself is connector.remove |
| `connector.remove.cancel`, `world.delete.confirm`, `world.delete.cancel`, `tab.close.confirm`, `tab.close.cancel`, `admin.reset.cancel`, `admin.grant.cancel` | a confirm-dialog answer is the human's |
| `auth.sign-in` | the GitHub OAuth redirect is the human's browser gesture; the agent renders the step with auth.prompt |
| `auth.sign-out` | dropping the human's session is theirs alone |
| `app.download` | a browser handoff the human clicks; the agent renders the step with app.download.prompt |
| `cloud.sign-in` | the Smithers Cloud browser login is the human's gesture on their account; the agent renders the step with cloud.prompt |
| `cloud.sign-out` | dropping the human's Smithers Cloud credential is theirs alone |
| `toast.dismiss` | dismissing a toast is the human's gesture |
| `tab.select` | focus is the human's |
| `tab.menu` | opening a menu is the human's gesture |
| `repo.select` | which pinned repository is active is the human's selection; an act names its working copy instead (tab.terminal [cwd]) |
| `workspace.rename.edit` | opening the inline editor is the human's gesture; the agent names the workspace with workspace.rename |
| `composer.add` | opening the composer's menu is the human's gesture |
| `target.filter` | the targets table's filter is the human's control; the agent lists targets with target.list |
| `target.select` | the targets table's row drawer is the human's control; the agent shows a target with target.open |
| `target.star`, `target.unstar` | starring is the human's own ranking of the table |
| `target.expand` | the targets table's grouped rows are the human's control |
| `target.pick` | picking a grouped row's members is the human's control |
| `target.run.set` | runs the members the human picked in the table; the agent runs a target by label with target.run |
| `target.graph.focus` | the graph drawer's own selection; the agent opens the graph focused with target.graph [label] |
| `target.run.scrub` | the replay slider is the human's gesture (time travel) |
| `target.source.open` | opens the declaration in the human's editor — a handoff off the app |
| `admin.reset` | destroys the whole store with no undo; the confirm dialog is the only door |
| `admin.reset.ask` | opens the human's confirm dialog for the reset |
| `billing.upgrade` | external checkout with real money; the human clicks |
| `billing.portal` | the external billing portal; the human clicks |
| `admin.devtools` | the admin panel's presentation toggle |
| `debug.backend` | admin diagnostics; the agent must never reason about its engine |
| `debug.grants.reset` | revokes the chain's own session grants; the operator's act |
| `admin.grant.confirm` | a grant confirmation is the operator's own answer (approve:self) |
| `admin.queue.approve` | approving an access request is the operator's own decision (approve:self) |

Six of these were not in the brief's table (`repo.select`, `target.run.set`,
`target.graph.focus`, `target.run.scrub`, `target.source.open`,
`admin.queue.approve`); each is a gesture, a picker, or an approval under the
law, and each names the agent's own route where one exists.

## Counts

- User-only: 64 before (53 base + 11 admin) → 49 after (17 promoted to the
  agent, `auth.sign-in`/`auth.sign-out` newly user-only).
- On the InstructionsBudget fixture (local host, repository open, 8
  capabilities): 176 registered, 141 callable by the agent, 119 disclosed in
  the prompt's catalog (was 102).

## The instruction stage

The composed prompt lands in **stage 2** (one line per namespace naming its
commands; summaries and arguments come from the tool's `list` action) — the
same stage it landed in before this lane with 102 disclosed flows. Measured on
the InstructionsBudget fixture: prompt 10,917 B, composed prompt + rendered
context 13,673 B of the 16,384 B seam cap (2,711 B headroom); the per-command
budget for that turn is 13,116 B and a stage-0 rendering of the 119-flow
catalog would be 17,731 B. `InstructionsBudget.test.ts` stays green.

## Tests

New: `flows/agent-parity.test.ts` (8 tests, 112 expects) — the allowlist gate
across both hosts; every agent row of the table through the production door
`executeForAgent` (confirm rows yield the confirm card and perform nothing;
`tab.terminal` opens in the active copy, `tab.card` pins the card,
`workspace.rename` names the workspace); `tab.terminal [cwd]` by path/id with
the refusal listing the open copies; `repo.open` without a path refuses the
agent, opens the dialog for the human, confirms with a path; `cloud.prompt`
renders the card and answers signed-in; `box.terminal` without the
cloud session names `cloud.prompt` to the agent and `/cloud.sign-in` to the
human; a user-only refusal quotes the reason and the agent's door on both
agent doors; the `+` menu's flows are callable and disclosed.

Moved to the new law: `state/AgentRoles.test.ts` (`agent.role` is
model-invocable and confirms), `state/Wave12.test.ts` (`flow.run.retry`
confirms; `flow.repo.choose` stays user-only), `state/seams/RepoTreeSeam.test.ts`
(`repo.tree` listed and callable), `flows/registry.test.ts` (`cloud.prompt` in
the registered set). Extended: `tabs/ChromeBar.test.tsx` (the `+` menu binds
the same flows AND they are the agent's, with the launches confirming),
`state/AgentRuntimeContext.test.ts` (the cloud line: native signed-out /
signed-in / degraded, the web derived from GitHub, no door → unavailable),
`packages/rpc/src/AgentContext.test.ts` (the four rendered lines; an older
payload without `cloud` validates and renders no line).

Runs: verification set 246/246 (17 files); `bun test src/mainview` 1474/1474
(139 files); `packages/rpc` 132/132 (14 files); tsc clean in both packages.

## Not built, and why

- `tab.terminal <arbitrary directory>`: the local PTY route resolves the cwd
  from a repository id and refuses paths from the browser by design; the flow
  takes an open working copy and points at `repo.open <path>` for a new one.
- `e2e/playwright/tabs.spec.ts` was not run (needs a browser and the local
  server) and was not changed: the `+` menu still binds `tab.terminal`,
  `agent.role`, `tab.harness` as the user, and user invocations never confirm,
  so the button door is unchanged; `ChromeBar.test.tsx` pins the bindings.
- Seams keep their human wording ("Sign in to Smithers Cloud first —
  /cloud.sign-in."); only the agent's copy of a refusal is rewritten, at the
  dispatch boundary, so cards, seams, `apps/server`, `ChromeBar.tsx`, and
  `vite.config.ts` are untouched as instructed.
