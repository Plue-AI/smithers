# Lane: flow forms. Missing input renders a form, never a usage sentence (2026-09-03)

Laws (apps/app/AGENTS.md incl. THE THREE-DOOR LAW, apps/DESIGN.md): EMBED LAW
(the form is a card in the chat), NO INVENTION (options come from seams:
installed harnesses, model lists, open repos, loaded bookmarks), no useEffect,
card state in the payload via the dispatcher, every act one flow with three
doors, consequential acts confirm (the form's Submit runs the same flow, so
the same confirm card follows).

## The rule, as law (add to apps/app/AGENTS.md under the three-door law)

THE FORM LAW: a flow invoked without its required input, by the agent or by
a slash, renders a form card for exactly the missing fields, prefilled with
whatever was given. No door ever answers with a usage sentence. The agent's
tool result says "rendered a form for <fields>" so the model tells the human
to fill it in, never to type arguments.

## Today

## Design

## Tests

## Files

`apps/shared/src/Cards.ts`, new `@smthrs/ui/flow-form` (+test), `flows/Commands.ts`,
`flows/agentTools.ts`, `flows/Flows.ts` (field hints only; re-read before
each edit, the code-intel workflow edits it concurrently), `flows/registry.ts`
(`form` metadata), new `cards/FlowFormCards.tsx` (+test), `cards/AgentCards.tsx`
(remove the bespoke form), `ChatCards.tsx` (mount), `state/controller/agents.ts`,
a small `state/controller/forms.ts` for `form.set`, `state/AppController.ts`,
`state/Instructions.ts`, `apps/app/AGENTS.md`.

## Verification

`cd apps/shared && bun test`; `cd apps/app && bun x tsc --noEmit -p . && bun test src/mainview/flows src/mainview/cards src/mainview/state/InstructionsBudget.test.ts`, then `bun test src/mainview` once. Write `flow-forms.REPORT.md`.

## Named submission

Submit runs the flow with the form's own payload, not with the line it
prints. `@smthrs/ui/flow-form` `submissionPayload(input, fields, given, draft)`
builds that payload: every filled field under its own name, a blank optional
absent instead of shifting the next field's value onto it, a prefilled free
text field the human cleared as the empty string it now shows, a field the
schema requires and a `required: false` hint lets stand blank as that same
empty string, a structured field parsed back out of the JSON its text control
holds, and a list field split on the spaces `assembleArgs` joined it with.
Whatever the form could not represent stays as the invocation gave it.

`state/controller/forms.ts` `submitForm` hands that payload to
`flows/Commands.ts` `submit({ name, payload, actor, display, invocation })`,
which is the ordinary run path entered past the composer boundary:
availability, the requirement axis, the confirmation axis and the agent
authorization are the ones every other trigger meets, and the declaration's
input schema validates the payload inside the binding. `assembleArgs` still
writes the slash line, now as display copy only: the card's echo, the
`/verbose` trace, and the confirmation message. Nothing parses it back into a
payload.

The durable park and the confirmation action are still text shaped
(`deferCommand`, `requestFlowConfirmation` carry `args`), so a submission that
defers on a requirement or waits for a confirmation resumes from the display
line and is only as faithful as the flow's grammar. Grammar coverage is
gated: `flows/SlashPayload.test.ts` fails when a declaration carries an `args`
hint and no decoder, which is how `triggers.register` discarded a named
repository.

## Authorization on submission

Every agent form continuation resolves its target in the command registry and
checks that target's declared capabilities with the active chain authorization
service. The call slot and lineage stay in host memory, outside the card payload.
A nested approval requirement parks the outer call; resuming checks the target
again before its handler runs. A continuation without host authority applies the
default policy and cannot execute protected capabilities.

Approval decisions are user-only at every agent entry point. Forms shown or
patched by the model always retain agent provenance; their flow names, fields,
and drafts are input, never authority. Submitting a user's form from an agent
call also uses agent authorization.

