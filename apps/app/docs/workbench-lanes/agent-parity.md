# Lane: agent parity. Anything a button does, the agent can do (2026-09-03)

Will, in the app at 11:29, after the agent said "I can't launch a Claude code
session", then tried `/box.terminal` (cloud) for "launch a terminal",
failed on the missing cloud session, and ran `/auth.prompt` (GitHub, already
connected): "more bugs. This rule that I set that I was very clear about how
anything we can do in the ui the agent should be able to do too is not being
followed."

The rule, restated as law (add it to apps/app/AGENTS.md under the flow law):
every act is ONE flow with three doors, slash, button, and agent. `userOnly`
is an enumerated exception for acts that are physically the human's gesture
or that the human alone may answer, and every such flow names its reason in
the registry. Consequential acts are agent-invocable WITH `confirm`; they are
never user-only because they are consequential.

## Root causes in the tree

1. `tab.terminal`, `tab.harness`, `agent.role`, `tab.card`, `tab.close`,
   `repo.open`, `repo.unpin`, `repo.tree`, `workspace.rename`, `target.run`,
   `target.run.pattern`, `target.open`, `box.facet`, `change.facet`,
   `change.pins`, `change.checks`, `flow.run.retry` are `userOnly: true` and
   mostly `hidden: true` in `flows/Flows.ts`, with the comment "browser
   mechanics the human clicks". Opening a local terminal or launching Claude
   Code is not browser mechanics: it is the product's main act.
2. No `cloud.prompt` exists. `auth.prompt` renders the GitHub sign-in card;
   nothing renders the Smithers Cloud sign-in card, so the agent reached for
   the wrong prompt. The runtime context (`packages/rpc/src/AgentContext.ts`)
   states GitHub connection but never the Smithers Cloud session state, so
   the agent could not know the cloud session was signed out.
3. `flows/agentTools.ts` `USER_ONLY_ALTERNATIVES` names alternatives for a
   handful of flows; every other user-only miss gets the generic "a control
   the human clicks".

## The policy (implement exactly this)

| Flow | New status | Why |
| --- | --- | --- |
| `tab.terminal` | agent-invocable, listed, no confirm | opening a local shell session is an ordinary act; args `[cwd]` optional, default the active working copy |
| `tab.harness <harnessId>` | agent-invocable, listed, **confirm** | launches Claude Code / Codex / Gemini / OpenCode: spends money and acts on the repo |
| `agent.role <roleId>` | agent-invocable, listed, **confirm** | same |
| `tab.card <cardId>` | agent-invocable, listed, no confirm | pins a card the agent just rendered into the sidebar |
| `tab.close <tabId>` | agent-invocable, listed, **confirm** | stops a process |
| `tab.select`, `tab.menu`, `tab.close.confirm/cancel` | user-only (keep) | focus and typed-confirm answers are the human's |
| `repo.open [path]` | agent-invocable, listed, **confirm** when a path is given; the folder dialog remains the human's (no path → the dialog only from a user/button door, the agent gets "name the path") | grants the agent a directory |
| `repo.unpin <copyId>` | agent-invocable, listed, **confirm** | forgets a repository |
| `repo.tree`, `workspace.rename` | agent-invocable, listed, no confirm | harmless |
| `target.run <target>`, `target.run.pattern <pattern>` | agent-invocable, listed, **confirm** | runs builds/tests locally |
| `target.open`, `change.pins`, `change.checks`, `box.facet`, `change.facet` | agent-invocable, listed, no confirm | showing a facet or pin is how the agent answers "show me the diff / the checks" |
| `target.filter/select/expand/pick/star/unstar`, `frame.*`, `card.maximize/minimize`, `toast.dismiss`, `composer.add`, `workspace.rename.edit`, `chat.send/stop/copy-message`, `system.recommend`, `flow.repo.choose`, `*.confirm`, `*.cancel`, `*.ask`, `app.download`, `flows`, `auth.sign-in/out`, `cloud.sign-in/out` | user-only (keep), each with a one-line `userOnlyReason` in the registry | gestures, picker answers, typed confirms, browser handoffs, the EMBED LAW |
| `flow.run.retry` | agent-invocable, **confirm** | a retry spends |

New flows:

- `cloud.prompt`: agent-invocable, listed, runtime `["Smithers Cloud"]`, summary
  "Offer the Smithers Cloud sign-in step in the chat"; renders one Smithers
  message with action `{ flow: "cloud.sign-in", label: "Sign in to Smithers
  Cloud" }`, mirroring `auth.prompt`. When the cloud session is already
  signed in it returns "Smithers Cloud is already signed in as <user>."

Honesty and context:

- `packages/rpc/src/AgentContext.ts` gains `cloud: { state: "signed-in" |
  "signed-out" | "degraded" | "unavailable", username: string | null }` and
  renders one line: `- Smithers Cloud: signed out (workspaces, changes and
  sync need it; cloud.prompt renders the sign-in button)` or `signed in as
  <user>`. `state/controller/turns.ts` fills it from the cloud auth session.
- `flows/agentTools.ts` `USER_ONLY_ALTERNATIVES`: `cloud.sign-in` → "invoke
  cloud.prompt, which renders that button in the chat"; remove entries for
  flows that stop being user-only. A user-only refusal for any flow with a
  `userOnlyReason` quotes that reason.
- A cloud flow refused for the missing session (`Sign in to Smithers Cloud
  first`) must name `cloud.prompt`, not `/cloud.sign-in`, in the agent's
  failure text, so the model's next act is the right prompt.
- `state/Instructions.ts`: the capability sentence names "open a local
  terminal, launch Claude Code or another harness as a session (confirm)".
  `InstructionsBudget.test.ts` must stay green (staged degradation handles
  the larger catalog; check the stage it lands in and report it).

## Tests

- New `flows/agent-parity.test.ts`: every flow with `userOnly: true` appears
  in an explicit allowlist in the test with its `userOnlyReason`, and the
  allowlist contains nothing else; every flow in the table's agent rows is
  invocable through `executeAgentToolCall` (a `confirm` flow yields the
  confirm card, not a refusal); `cloud.prompt` renders the card; a missing
  cloud session on `box.terminal` names `cloud.prompt`.
- Registry/parity pins, `Wave13*.test.ts`, `AgentRuntimeContext.test.ts`
  (the cloud line), `ChromeBar.test.tsx` (the `+` menu still binds the same
  flows), `AgentRoleMenu.test.ts`.
- A T1 spec if one covers the `+` menu (`e2e/playwright/tabs.spec.ts`): the
  agent door is unit-tested; the button door must not regress.

## Files

`flows/Flows.ts`, `flows/registry.ts` (`userOnlyReason`), `flows/Commands.ts`
(refusal quotes the reason; keep the W0 `explainAbsent`/`unavailable` path
intact), `flows/agentTools.ts`, `flows/SlashPayload.ts` (args for the newly
listed flows), `state/controller/tabs.ts` (`tab.terminal [cwd]`,
`repo.open [path]` agent path), the cloud controller for `cloud.prompt`
(`state/controller/auth-billing.ts` or where `promptSignIn` lives),
`packages/rpc/src/AgentContext.ts`, `state/controller/turns.ts`,
`state/Instructions.ts`, `apps/app/AGENTS.md` (the law), and the tests above.
Do not edit cards, seams, ChromeBar.tsx beyond a test, or apps/server.

## Verification

`cd apps/app && bun x tsc --noEmit -p . && bun test src/mainview/flows src/mainview/state/Instructions*.test.ts src/mainview/state/InstructionsBudget.test.ts src/mainview/state/Wave13.test.ts src/mainview/state/Wave13c.test.ts src/mainview/state/AgentRuntimeContext.test.ts src/mainview/state/AgentRoles.test.ts src/mainview/tabs src/mainview/AgentRoleMenu.test.ts`, then `bun test src/mainview` once and `cd packages/rpc && bun test`. Write `agent-parity.REPORT.md`: the final user-only allowlist with reasons, the instruction stage the catalog now lands in, tests by name, counts.
