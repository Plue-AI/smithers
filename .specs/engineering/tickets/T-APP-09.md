# T-APP-09 Actor adapter: participants and "for Ben" (§14.6a, M-34)

Stage S1 · Size S · Depends on T-ACC-04, T-UI-01 · Unblocks T-AGT-01, T-AGT-03, T-APP-02, T-APP-04, T-APP-06, T-APP-07, T-APP-10, T-APP-11, T-APP-12, T-APP-14a, T-APP-16, T-MCH-08, T-REL-02, T-TRM-02 · Issue: [#3503](https://github.com/smithersai/smithers/issues/3503)
Spec: spec.md §2 (actor notation), §5.3, §6.4, §14.6a, §14.6a.1 · Delta: delta.md §9 (Modify: actor rendering with `via` badges) · Product: mvp.md J6.3, §6.13 Attribution, M-21, M-34
Ready: 2026-10-03 smithers-8a sha256:0f0b0e3b97e0

## Goal
Every card, toast and line that names who acted renders the §14.6a participant one way, from one actor module, one actor enum, one via enum and one role enum (minimal-code synthesis v1 §6).

## Scope
In:
- Reuse `apps/app/src/mainview/state/ProductActor.ts:20,35` (`todoActors`, `toActor`, stored notation). `state/TodoActors.ts` is already absent. The adapter maps `via`, `for_member` and `color_index` (members 0–5, undelegated agent 6, GitHub and outside 7).
- Reuse the one formatter, `cards/views/actorName.ts:4`, as delta.md §9 requires. Keep its re-exports at `state/ProductActor.ts:18` and `cards/views/ActorChip.tsx:7-8`; `EntryRow.tsx:5` and the Views keep importing through `ActorChip`. Re-exports are not second implementations. Change the system label from "Install event" to "Smithers" (§2, §14.6a); keep its system kind and neutral color.
- Reuse `packages/rpc/src/CardPrimitives.ts`: `ActorSchema` (`:129`), `ViaSchema` (`:77`), `AgentKindSchema` (`:92`) and `ModelRoleIdSchema` (`:113`) are the shared schemas. No `ActorRef` exists in `packages/rpc/src` (read-only `rg`).
- `CardAction.ts:91` already uses `ModelRoleId` for `settings.model-key`; preserve it. No new actor, via, agent or model-role enum, schema, package or formatter is needed.
- Land dark against the T-ACC-04 and T-UI-01 contracts if either dependency is unavailable: reuse the adapter and formatter without enabling delegated producers or mounting pending Views. Missing recorded member context refuses projection through the existing `TodoSeam` error path; never infer a person, agent or authority from a header. Enable the affected render paths only with their owning wiring ticket and passing production-boundary tests. Tests: `TodoSeam.test.ts` missing-context case and `CardRenderers.test.ts` pending-card case; delegated integration: C-J6-01.

Out:
- A new `packages/rpc/src/ProductActor.ts`; the stored notation stays an app type until a second package reads it.
- Minting delegated credentials, the `Smithers-Via` header and recording `via` (T-ACC-04).
- Broker registration of agent processes, presence, activity and terminals (S2 tickets).
- The app's dispatcher `ActorSchema` (`state/AppState.ts:525`), which names the Flux actor, not the product actor.
- Setup-step command migration (`CardAction.ts:92` uses `app`; `SetupCard.ts:31` uses `app_manifest`), Settings handlers and catalog policy. T-INS-06 and T-CAT-01 own that integration; this ticket does not change step ids.
- New participant storage, credential or header parsing, authorization changes, terminal execution, root provisioning, live transport, new View mounts and avatar redesign.

## Changes
- `apps/app/src/mainview/cards/views/actorName.ts`: reuse the formatter; render system actors as "Smithers" without converting them to agent participants.
- `apps/app/src/mainview/state/ProductActor.ts`, `cards/views/ActorChip.tsx` and `EntryRow.tsx`: retain the adapter, formatter re-exports and production consumers. Keep `TodoActors.ts` absent.
- `packages/rpc/src/CardPrimitives.ts` and `CardAction.ts`: retain the existing shared actor, via, agent and model-role definitions; no schema rewrite.
- `apps/app/lint/conformance/Rules.ts:281,289` and `ActorLabels.test.ts` (existing): reuse the actor-label lint. Card and toast sources call the shared formatter; do not build " via ", " for " or "'s terminal" by hand.
## Tests
- Extend existing `state/ProductActor.test.ts` and `cards/views/ActorChip.test.tsx`: stored shapes render literal labels "Ben", "Smithers for Ben", "Claude Code for Ben", "Codex for Ben", "Ben via SSH", "Ben's terminal", "Ben via CLI", "Coding agent for Ben", "Reviewer for Ben", "@octocat", "Smithers" (system) and "Changed outside Smithers". Unknown agent names render verbatim; removed members keep their login. Assert literal participant kinds, session/run ids, acting-for member and colors 0–5, 6 and 7; -1 and 8 fail to parse. System writes remain system actors, including a stored requester.
- Extend existing `state/seams/TodoSeam.test.ts`: drive `showTodo` through its HTTP transport and subscribed TODO updates through the production seam, persistence and projection decoding. Assert literal labels and actor fields for historical authors. Missing roster context refuses the projection and reports the error; it does not substitute an identity. This proves decoding, not credential classification.
- Extend existing `cards/views/Views.test.tsx`: render the production `EntryRow` and `ActorChip` with recorded actors. Assert literal visible labels and accessible avatar labels, independent agent identity and the acting-for member's color. Do not substitute a capture View or call the formatter to compute DOM expectations.
- Extend existing `cards/CardRenderers.test.ts`: an unavailable T-UI-01/wiring path stays pending and does not mount a replacement View. Existing actor paths keep their formatter. No fixture mounts a pending card to claim production reachability.
- Reuse `lint/conformance/ActorLabels.test.ts`: the production source scan rejects handwritten participant labels and accepts shared-formatter calls and ordinary copy.
- C-J6-01 at the real installed terminal, packaged CLI/skill, authenticated command route and browser: a delegated Claude Code action records and renders "Claude Code for Ben"; a person-session action with `Smithers-Via: claude-code` remains "Ben". T-ACC-04 owns header/credential classification; a `toActor` unit test cannot prove it. Run this integration when the terminal and credential providers are available, before enabling delegated rendering.
- Expected labels, enums, identities and refusal outcomes are committed literals. Tests never read spec Markdown or derive expected values from production schemas, enum exports, formatter output or fixture models at runtime.
## Acceptance
- [C-UI-13](../checks/C-UI-13.md): retain production reachability and pending-card behavior; this ticket adds no View mount. Its own seam and `EntryRow` tests prove attribution at the production consumers.
- [C-J1-04](../checks/C-J1-04.md): S1 journey integration after the first-merge install and card providers land; it does not block a dark adapter merge.
- [C-J6-01](../checks/C-J6-01.md): actions Claude Code takes from Ben's branch terminal show "Claude Code for Ben" on the cards that record them. This gates enabling delegated integration, not Ready or a dark merge. Its named automation path is planned, not present in the current code clone.

## Risks and notes
- M-34 replaces the "Ben via Smithers" badge with the agent's own avatar and "for Ben"; `via` stays on the wire and only the rendering changes.
- smithers-b8 decides app adapter and consumer seams; smithers-06 decides actor-chip presentation and copy; smithers-38 approves the shared RPC contract and enum reuse. smithers-8a resolves spec/delta disagreements, including label punctuation, before any public contract change. This ticket needs no ADR or new public API.
- Security reviewer: smithers-3f. Rendering recorded attribution confers no authority and executes no repository code. C-J6-01 runs repository commands only as the unprivileged member/agent inside a machine (M-29); unavailable isolation or credential providers keep that integration disabled. Host tests use inert recorded data, not repository scripts. This ticket adds no root step and consumes no main- or branch-sourced root inputs. Any proposed root execution is outside scope and requires a separate input inventory and a named validation test for every branch-sourced input before it can proceed.

## Ready checklist
1. Dependencies: T-ACC-04 supplies trusted recorded attribution; T-UI-01 supplies the actor chip. Scope keeps unavailable producers and pending Views dark. Journey providers gate later integration, not this rendering-only merge; no new runtime dependency edge is needed.
2. Exclusions: Scope excludes credential/header policy, broker registration, presence/activity/terminal/line-flag producers, setup-step migration, root provisioning, new schemas, new View mounts and avatar redesign.
3. Boundary tests: existing TODO HTTP/live seam tests, production `EntryRow`/`ActorChip` DOM tests and pending-card renderer tests use literal expectations; C-J6-01 checks credential attribution through the actual installed command route. No spec-derived or runtime-derived oracle.
4. Decisions: smithers-b8 owns app seams, smithers-06 presentation/copy, smithers-38 RPC compatibility, smithers-3f execution security and smithers-8a spec/delta conflicts. No ADR or new public API is introduced.
5. Owner pre-review before start: smithers-b8: Does retaining `ProductActor`'s adapter and the formatter re-export preserve every app consumer? Does unavailable attribution fail closed without enabling producers? smithers-06: Does the existing chip distinguish agents from system events while rendering the required labels? smithers-38: Are the existing RPC schemas and model-role type sufficient without a second enum? smithers-3f: Does the terminal integration keep repository execution unprivileged inside machines with no root input path? Record owner answers here; existing recorded answers stand, and the parallel-build directive permits post hoc owner review.
6. Security: smithers-3f reviews the M-29 machine-only execution precondition for C-J6-01 and the separation of recorded identity from authority. Adapter/DOM tests execute no repository payload; this ticket introduces no root step or root inputs. Root execution or branch-sourced root inputs require a separately reviewed inventory and named validation tests.
