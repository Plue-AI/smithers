# T-AGT-04 Internal /ceo repository flow dogfood

Stage M · Size S · Depends on T-APP-05, T-FLW-01, T-INS-02, T-FLW-03, T-FLW-04, T-FLW-07, T-CAT-01, T-ACC-03, T-SEC-01 · Unblocks — · Issue: [#3631](https://github.com/smithersai/smithers/issues/3631)
Spec: spec.md §1.3, §11, §14.2.1, §17.3 · Delta: delta.md §9 · Product: mvp.md M-38, M-34
Ready: 2026-10-03 smithers-8a sha256:ee5f585f9ed4

## Goal

Compose the internal /ceo brief on the install after stage 1 as dogfood of custom flow UI.

## Ownership

smithers-8a owns the repository-flow composition and accepts the integration evidence. Will decides the brief’s content and forwards a6’s prototype README and CEO-FLOW.md; those documents are references, not executable inputs. smithers-06 approves shared-view composition, smithers-b8 approves app wiring, smithers-38 approves flow authoring and presentation data, and smithers-3f approves machine execution and security. No ADR or public API change is authorized. Record owner review in #3631; existing recorded answers stand and owners review the implementation post hoc under Will’s parallel-build directive.

## Scope

In:
- A repository flow using shared components. Input is a6's prototype README and CEO-FLOW.md when product forwards them.
- Land dark against the specified contracts for every unlanded dependency above: keep ceo unavailable until isolated launch (T-INS-02, T-FLW-01), validated guest boundaries (T-SEC-01), activation and pinned loading (T-FLW-03, T-FLW-04), authorized dispatch (T-CAT-01, T-ACC-03), Flow card wiring (T-APP-05) and shipped custom-presentation rendering (T-FLW-07) are available. Refuse before repository import or launch when execution or authority is unavailable; omit the custom view while its renderer is unavailable. TestCeoUnavailableDependencies proves these guards. Reference delivery gates final brief implementation and acceptance, not dark landing; do not invent the brief.

Out:
- A shipped /ceo command, product route, default navigation, catalog entry or new product component.
- Prototype code, a second flow runtime, graph, renderer, presentation protocol or model service; repository JavaScript in the host or browser.
- External transcript adapters and ingestion (T-AGT-01–03), scheduled triggers, Cloud, root setup and image/toolchain changes.

## Changes

- Read the forwarded documents as references; do not port prototype code or invent their contents.
- Reuse `flows/repository/registry.ts:315` (`repositoryRegistration`) and `apps/app/src/mainview/flows/entries/flow.ts:101` (`flow.run`); no ceo-specific dispatcher.
- Reuse T-APP-05’s shared Flow card and T-FLW-07’s §11.6.2 presentation path through `apps/app/src/mainview/cards/RunTraceCard.tsx` and `CardRenderers.tsx`. Emit serializable presentation data from the machine; render only with install-shipped components. No app or library seam is added here.
- Add only `flows/ceo/flow.ts`, default-exporting `Flow.make("ceo", ...)` from `@smthrs/flow`, and reference-derived data/fixtures beside it. The existing registry and presentation path supply execution and UI; the new composition supplies the internal brief they do not contain. Reuse the installed APIs; do not port prototype components.
- Keep /ceo out of shipped catalog, default navigation and product API surfaces.

## Tests

- Repository-local integration `TestCeoUnavailableDependencies`: drive the production `flow.run` dispatcher with each dependency contract unavailable. Assert no repository import, host execution or unauthorized admission; missing rendering produces no custom view. Use literal refusal expectations fixed in the fixture, not production constants.
- Repository-local e2e `TestCeoBriefOnInstall`: on the real install, activate ceo through production flow-load, invoke `/flow.run ceo` with the committed fixture input, then open Inspect through the run card and `CardRenderers`. Assert reference-approved literal brief fields in the shared presentation, machine-only import/execution, and the agent’s member attribution. A direct registry call is supplemental only.
- `TestCeoInternalOnly`: use the production catalog, navigation and route boundaries to prove that an install without the repository flow has no ceo entry or route; installing the flow exposes only ordinary repository-flow invocation.
- Pin input, expected brief fields and rendering assertions after Will forwards the references; never read spec files or derive expectations from production code at runtime. Record the exact commands, commit, completion receipts, screenshots and host/guest canary evidence in #3631. Reuse C-J11-02’s custom-presentation and C-SEC-02’s isolation fixtures; add no MVP stage gate.

## Acceptance

TestCeoUnavailableDependencies, TestCeoBriefOnInstall and TestCeoInternalOnly pass with commit-bound completion evidence accepted by smithers-8a. Will accepts the reference-derived brief content. The internal brief runs on the install as a repository flow. No product route, command or component is added.

## Risks and notes

- Low priority, stage M after launch, using the installed S1 contracts. Blocks no MVP ticket or stage gate. Unlanded dependencies do not block Ready; guards keep the change dark until their contracts are available. No MVP check is added.
- M-29: discovery, import, planning and execution of ceo and its repository imports occur only as an unprivileged user inside a machine, never in the host or browser. Members and agents have no sudo. smithers-3f reviews this boundary; TestCeoBriefOnInstall retains guest positive controls and zero host canary effects.
- This ticket adds no root step and passes no brief, prototype, presentation or branch-built code to root. Shared privileged lifecycle inputs and their main/install versus branch/member sources remain those inventoried in T-SEC-01 and T-INS-02; do not change that inventory here. T-SEC-01’s TestGuestHelperInstallPinsInterpreterAndEnv, TestRootSetupNeverFollowsMemberSymlinks and TestRootPreflightParsesOnlyEnvelope validate branch/member data before privileged use under C-SEC-02. Unvalidated branch-sourced root input blocks enabling ceo; branch-built root payloads remain forbidden. TestCeoUnavailableDependencies proves refusal until this contract is available.

## Ready checklist
1. Depends on names install isolation, guest validation, activation, pinned loading, authorized catalog dispatch, Flow card and custom presentation; Scope names dark behavior for every unlanded contract.
2. Out excludes shipped ceo surfaces, prototype code, duplicate runtimes/renderers, transcripts, triggers, Cloud and privileged/image changes.
3. Named local tests use production flow-load, flow.run, Inspect, CardRenderers and catalog/route boundaries; fixed reference-approved fixtures define expectations independently of spec and code.
4. Will decides brief content; smithers-8a accepts integration evidence; smithers-06, smithers-b8, smithers-38 and smithers-3f decide their named seams. No new ADR or public API is authorized.
5. Owner pre-review questions, recorded in #3631; recorded answers stand and implementation review is post hoc: smithers-06: Does the brief compose only shipped shared views? smithers-b8: Does ordinary repository invocation avoid shipped catalog, route and navigation additions? smithers-38: Does ceo reuse tagged Flow.make and the existing serializable presentation contract without a second model? smithers-3f: Are import/planning/execution machine-only, and do unavailable security contracts refuse before import or launch?
6. M-29 and smithers-3f govern unprivileged machine execution; no root step is added. Shared lifecycle input inventories and named root-validation tests are cited above; unvalidated branch-sourced root inputs block enabling, and branch-built root code is forbidden.
