# Spec findings from the standing Codex Sol reviewer

Appended per review cycle (~/.config/smithers-review-loop); each line is a falsifiable claim with a path. Owners: product (mvp.md), engineering (spec.md, delta.md, card-kinds.md, ui-components.md), design (mock).


## 0001-20261003T221220
- [FIX] /Users/williamcory/smithers/.specs/engineering/ui-components.md:438 — Flow version selection explicitly uses React local state without emitting a view patch — This contradicts the application rule requiring card selections to persist through flows.
- [FIX] /Users/williamcory/smithers/.specs/engineering/spec.md:1205 — The File/Diff migration says to replace CodeSurface and DiffSurface while card-kinds.md:22 retains them as the wiring files — Implementers receive contradictory instructions about which rendering path must be deleted.

## 0002-20261003T221906
- [FIX] /Users/williamcory/smithers/.specs/engineering/ui-components.md:438 — Flow version selection explicitly uses local state without a view patch — This contradicts the application requirement to persist card selections through flows.
- [FIX] /Users/williamcory/smithers/.specs/engineering/spec.md:1205 — File/Diff migration replaces CodeSurface and DiffSurface while card-kinds.md retains them as wiring files — Implementers receive incompatible deletion requirements.
- [FIX] apps/app/src/mainview/cards/SetupCard.tsx:39 — Setup offers a generic fast-model key form instead of the design’s Smithers sign-in and omits coding-model ChatGPT sign-in — J1 cannot follow the model-access choices specified by the design.

## cycle 1 · 20261003T222128 · focus engineering · main 6bdbbae54034
- [FIX] /Users/williamcory/smithers/.specs/engineering/ui-components.md:438 — Flow version selection explicitly requires local state without a view patch — This contradicts the application rule and spec §14.1.2 requiring durable member selections.
- [FIX] /Users/williamcory/smithers/.specs/engineering/spec.md:1205 — File/Diff migration names CodeSurface and DiffSurface as replaced renderers while card-kinds.md retains them as wiring files — Implementers receive incompatible deletion requirements.

## cycle 2 · 20261003T222824 · focus design · main d28b862bc7b5
- [FIX] /Users/williamcory/smithers/.specs/engineering/ui-components.md:438 — Flow version selection explicitly requires React local state without a view patch — This contradicts the application rule requiring durable card selections.
- [FIX] /Users/williamcory/smithers/.specs/design/mock/src/cards/Setup.tsx:224 — The mock requires Smithers sign-in for fast-model access while the landed J1 test forbids “Smithers account” copy — Design and acceptance evidence enforce different onboarding contracts.

## cycle 4 · 20261003T224043 · focus product · main 3316494348f7
- [FIX] /Users/williamcory/smithers/.specs/product/overview.md:44 — The overview assigns exactly one machine to every branch while mvp.md defines `main` as having no machine — Implementers receive conflicting machine-allocation requirements.
- [FIX] /Users/williamcory/smithers/.specs/product/overview.md:33 — The overview calls the product a “forge” — Public documentation violates the repository’s product vocabulary rule.

## cycle 5 · 20261003T224658 · focus engineering · main be3022d37573
- [FIX] /Users/williamcory/smithers/.specs/engineering/ui-components.md:491 — The Run contract requires reshaping RunTraceCard in place while spec.md requires replacing it and the mount introduces RunView — The migration has conflicting implementation and deletion requirements.

## cycle 6 · 20261003T225420 · focus design · main a78752c86340
- [FIX] /Users/williamcory/smithers/.specs/engineering/ui-components.md:491 — The Run contract forbids a new RunView while spec.md requires replacing RunTraceCard and the mount introduces RunView — The migration has conflicting implementation and deletion requirements.

## cycle 7 · 20261003T230046 · focus tickets · main 964cf48fb148
- [FIX] /Users/williamcory/smithers/.specs/engineering/tickets/T-PRC-03.md:16 — T-PRC-03 requires approved CI targets for MANUAL checks while AGENTS.md:140 requires owner-signed manual receipts — Implementers receive incompatible closure-evidence requirements.
- [FIX] /Users/williamcory/smithers/.specs/engineering/tickets/T-PRC-03.md:19 — T-PRC-03 excludes reference-host execution support while AGENTS.md:146 requires authenticated reference-host mappings — Machine-specific acceptance checks lack a consistent evidence path.
- [FIX] /Users/williamcory/smithers/.specs/engineering/spec.md:1205 — File/Diff migration names CodeSurface and DiffSurface as replaced renderers while card-kinds.md:22 retains them as wiring files — Implementers receive incompatible deletion requirements.
- [FIX] /Users/williamcory/smithers/.specs/engineering/ui-components.md:491 — The Run contract forbids a new RunView while spec.md:1205 requires replacing RunTraceCard and the mount introduces RunView — The migration has conflicting implementation requirements.

## cycle 8 · 20261003T230844 · focus product · main 4ca34eab0ca0
- [FIX] /Users/williamcory/smithers/.specs/engineering/tickets/T-PRC-03.md:16 — T-PRC-03 requires approved CI targets for MANUAL checks while AGENTS.md requires owner-signed manual receipts — Implementers receive incompatible closure-evidence requirements.
- [FIX] /Users/williamcory/smithers/.specs/engineering/tickets/T-PRC-03.md:19 — T-PRC-03 excludes reference-host execution support while AGENTS.md requires authenticated reference-host mappings — Machine-specific acceptance checks lack a consistent evidence path.
- [FIX] /Users/williamcory/smithers/.specs/engineering/ui-components.md:491 — The Run contract forbids a new RunView while spec.md requires replacing RunTraceCard and the mount introduces RunView — The migration has conflicting implementation requirements.

## cycle 13 · 20261003T234749 · focus engineering · main 3325c31c2a75
- [FIX] /Users/williamcory/smithers/.specs/engineering/ui-components.md:438 — Flow version selection explicitly uses local state without a view patch — It conflicts with the app’s durable-selection rule.
- [FIX] /Users/williamcory/smithers/.specs/engineering/spec.md:1205 — File/Diff migration replaces CodeSurface and DiffSurface while ui-components.md:445 retains them — Implementers receive incompatible deletion requirements.
- [FIX] /Users/williamcory/smithers/.specs/engineering/ui-components.md:491 — The Run contract forbids a new RunView while spec.md:1205 requires replacing RunTraceCard — The migration has incompatible implementation requirements.
- [FIX] /Users/williamcory/smithers/.specs/engineering/delta.md:49 — Bind changes restart the service while spec.md:1376 requires applying them without restart — J1 address setup has conflicting lifecycle requirements.
- [FIX] /Users/williamcory/smithers/.specs/engineering/tickets/T-PRC-03.md:16 — MANUAL checks require approved CI evidence while AGENTS.md requires owner-signed manual receipts — Manual acceptance has incompatible closure requirements.
- [FIX] /Users/williamcory/smithers/.specs/engineering/tickets/T-PRC-03.md:19 — Reference-host execution support is excluded while AGENTS.md requires authenticated reference-host mappings — Machine-specific checks lack a consistent evidence path.
- [FIX] /Users/williamcory/smithers/.specs/engineering/tickets/T-STK-09.md:60 — The outsider-edit test requires label reversion without distinguishing edits before admission from edits afterward — Implementers cannot determine when frozen admission prevents reversion.
- [FIX] /Users/williamcory/smithers/.specs/product/overview.md:44 — Every branch requires one machine while mvp.md exempts `main` — Implementers receive conflicting allocation requirements.
- [FIX] /Users/williamcory/smithers/.specs/product/overview.md:33 — Public product copy calls Smithers a “forge” — It violates the repository vocabulary rule.

## cycle 14 · 20261003T235433 · focus design · main 56694947944f
- [FIX] /Users/williamcory/smithers/.specs/design/mock/src/parts.tsx:17 — Delegated agents retain the person’s avatar and “via” attribution despite M-34 requiring their own avatar and “for Ben” — The design instructs implementers to reproduce superseded participant identity.
- [FIX] /Users/williamcory/smithers/.specs/design/mock/src/cards/Act.tsx:23 — Another viewer sees the confirmation’s subject and waiting message while card-kinds.md:37 requires that viewer to see nothing — Porting the mock exposes a person-private confirmation.
- [FIX] apps/app/src/mainview/cards/SetupCard.tsx:40 — Model setup exposes `jev` and offers only key input while the design requires Smithers and ChatGPT sign-in doors — J1 cannot follow the specified model-access setup.
- [FIX] /Users/williamcory/smithers/.specs/engineering/ui-components.md:438 — Flow version selection explicitly uses local state without a view patch — It contradicts the app’s durable-selection rule.
- [FIX] /Users/williamcory/smithers/.specs/engineering/spec.md:1205 — File/Diff and Run migration requires replacing rendering paths that ui-components.md:445 and :491 retain — Implementers receive incompatible deletion requirements.

## cycle 15 · 20261004T000152 · focus tickets · main 7f68fd7e0018
- [FIX] /Users/williamcory/smithers/.specs/engineering/tickets/T-PRC-03.md:19 — Reference-host execution support is excluded while AGENTS.md requires authenticated reference-host mappings — Machine-specific acceptance lacks a consistent evidence path.
- [FIX] /Users/williamcory/smithers/.specs/engineering/tickets/T-STK-12.md:60 — The ticket acknowledges that its required C-STK-06 check still specifies removed generation-receipt behavior — Implementers cannot complete the ticket against one consistent acceptance contract.
- [FIX] /Users/williamcory/smithers/.specs/engineering/tickets/T-STK-09.md:60 — The outsider-edit test requires label reversion without limiting it to edits before admission — It conflicts with revision-one admission remaining frozen against subsequent edits.
- [FIX] /Users/williamcory/smithers/.specs/engineering/tickets/README.md:31 — Dark integrations must refuse unavailable authority while the Home and Settings mount substitutes seeded state and writes — J1 and J4 can appear functional without the required production providers.
- [FIX] /Users/williamcory/smithers/.specs/engineering/ui-components.md:438 — Flow version selection explicitly uses React local state without a view patch — It contradicts the app’s durable-selection rule.
- [FIX] /Users/williamcory/smithers/.specs/engineering/ui-components.md:491 — Run must reshape RunTraceCard in place while delta.md requires deleting RunTraceCard and RunsCards — Implementers receive incompatible migration requirements.

## cycle 16 · 20261004T000851 · focus product · main 5df02cab97d4
- [FIX] /Users/williamcory/smithers/.specs/product/overview.md:44 — Every branch requires a machine while mvp.md §3 explicitly gives `main` none — The first home conversation has contradictory machine requirements.
- [FIX] /Users/williamcory/smithers/.specs/product/overview.md:33 — Public product copy calls Smithers a “forge” — It violates the required product vocabulary.
- [FIX] /Users/williamcory/smithers/.specs/engineering/tickets/T-APP-01.md:13 — The Home ticket requires unavailable production providers to leave Home unmounted while the patch substitutes seeded work — J4 has incompatible activation contracts.
- [FIX] /Users/williamcory/smithers/.specs/engineering/tickets/T-STK-12.md:60 — The ticket acknowledges that C-STK-06 still requires removed generation-receipt behavior — Implementers cannot complete one consistent acceptance contract.
- [FIX] /Users/williamcory/smithers/.specs/engineering/tickets/T-STK-09.md:60 — The outsider-edit test requires label reversion without limiting it to edits before admission — It conflicts with freezing admitted revision-one context against later edits.
- [FIX] /Users/williamcory/smithers/.specs/engineering/ui-components.md:491 — Run must reshape RunTraceCard in place while the migration requires deleting it — Implementers receive incompatible replacement requirements.

## cycle 17 · 20261004T001626 · focus engineering · main 03236c73d095
- [FIX] /Users/williamcory/smithers/.specs/engineering/tickets/T-APP-01.md:13 — The ticket requires unavailable Home providers to remain unmounted while the patch mounts seeded work — J4 has incompatible activation contracts.
- [FIX] /Users/williamcory/smithers/.specs/engineering/ui-components.md:445 — File and Diff retain CodeSurface and DiffSurface while delta.md:164 replaces their rendering — Implementers receive incompatible migration requirements.
- [FIX] /Users/williamcory/smithers/.specs/engineering/ui-components.md:491 — Run must reshape RunTraceCard in place while delta.md:164 requires replacing it — Implementers cannot satisfy both cutover contracts.
- [FIX] /Users/williamcory/smithers/.specs/engineering/tickets/T-STK-09.md:60 — The outsider-edit test requires label reversion without restricting it to edits before admission — It conflicts with preserving frozen revision-one context after admission.
- [FIX] /Users/williamcory/smithers/.specs/product/overview.md:44 — Every branch requires a machine while mvp.md §3 exempts `main` — The first Home conversation has contradictory machine requirements.

## cycle 18 · 20261004T002326 · focus design · main 0c7216c8b017
- [FIX] /Users/williamcory/smithers/.specs/design/README.md:66 — Delegated agents use the person’s circle and “via” attribution while M-34 requires their own avatar and “for Ben” — The design directs implementers to restore superseded attribution.
- [FIX] /Users/williamcory/smithers/.specs/design/mock/src/parts.tsx:39 — The mock renders delegated agents with the person’s initials and avatar badge — Its executable reference contradicts M-34 and the corrected app projection.
- [FIX] /Users/williamcory/smithers/.specs/engineering/tickets/T-APP-01.md:13 — Unavailable Home providers must leave Home unmounted while the patch mounts seeded work — J4 has incompatible activation contracts.
- [FIX] /Users/williamcory/smithers/.specs/engineering/ui-components.md:438 — Flow version selection explicitly uses React local state without a view patch — It contradicts durable card selection.
- [FIX] /Users/williamcory/smithers/.specs/engineering/ui-components.md:445 — File and Diff retain CodeSurface and DiffSurface while delta.md requires replacing their rendering — Implementers receive incompatible migration requirements.
- [FIX] /Users/williamcory/smithers/.specs/engineering/ui-components.md:491 — Run must reshape RunTraceCard in place while delta.md requires replacing it — Implementers cannot satisfy both cutover contracts.
- [FIX] /Users/williamcory/smithers/.specs/engineering/delta.md:49 — Bind changes restart the service while spec.md requires applying them without restart — J1 address setup has conflicting lifecycle requirements.
- [FIX] /Users/williamcory/smithers/.specs/engineering/tickets/T-STK-12.md:60 — The ticket acknowledges that C-STK-06 still requires removed generation-receipt behavior — Its acceptance contract remains unreconciled.
- [FIX] /Users/williamcory/smithers/.specs/engineering/tickets/T-STK-09.md:60 — The outsider-edit test requires label reversion without restricting it to edits before admission — It conflicts with frozen revision-one context after admission.
- [FIX] /Users/williamcory/smithers/.specs/product/overview.md:44 — Every branch requires a machine while mvp.md exempts `main` — The first Home conversation has contradictory machine requirements.

## cycle 19 · 20261004T003032 · focus tickets · main 8ed8b2b6267a
- [FIX] /Users/williamcory/smithers/.specs/engineering/tickets/README.md:31 — Dark integrations must refuse unavailable providers while the mount substitutes seeded data and mutations — J1 and J4 can appear functional without production authority.
- [FIX] /Users/williamcory/smithers/.specs/engineering/tickets/T-STK-12.md:60 — The stamped ticket acknowledges that required C-STK-06 still specifies removed generation-receipt behavior — Implementers cannot complete one consistent acceptance contract.
- [FIX] /Users/williamcory/smithers/.specs/engineering/tickets/T-STK-09.md:60 — The outsider-edit test requires label reversion without limiting it to edits before admission — It conflicts with preserving frozen revision-one context after admission.
- [FIX] /Users/williamcory/smithers/.specs/engineering/card-kinds.md:23 — File and Diff retain CodeSurface and DiffSurface while delta.md requires replacing their rendering — Implementers receive incompatible migration requirements.

## cycle 20 · 20261004T003738 · focus product · main dc23bbb7e885
- [FIX] /Users/williamcory/smithers/.specs/product/overview.md:44 — Every branch is assigned a machine while mvp.md §3 explicitly gives `main` none — Implementers receive conflicting rules for the first screen’s branch.
- [FIX] /Users/williamcory/smithers/.specs/product/overview.md:31 — Public product copy calls Smithers a “forge” — The overview violates the required product vocabulary.
- [FIX] /Users/williamcory/smithers/.specs/engineering/tickets/T-APP-01.md:14 — The Home ticket requires unavailable production providers to leave Home unmounted while the patch substitutes seeded work — J4 can appear operational without production authority.
- [FIX] /Users/williamcory/smithers/.specs/engineering/ui-components.md:438 — Flow version selection explicitly uses React local state without a view patch — The component contract contradicts durable card selection.

## cycle 21 · 20261004T004516 · focus engineering · main 6034a7ece83b
- [FIX] /Users/williamcory/smithers/.specs/engineering/tickets/T-APP-01.md:13 — The Home ticket requires unavailable providers to leave Home unmounted while the patch substitutes seeded work — J4 can appear operational without production authority.
- [FIX] /Users/williamcory/smithers/.specs/engineering/ui-components.md:438 — Flow version selection explicitly uses React local state without a view patch — The component contract contradicts the durable card-selection rule.
- [FIX] /Users/williamcory/smithers/.specs/engineering/delta.md:164 — File and Diff must replace CodeSurface and DiffSurface while ui-components.md:445 retains those rendering paths — Implementers receive incompatible cutover requirements.
- [FIX] /Users/williamcory/smithers/.specs/engineering/ui-components.md:491 — Run forbids a new RunView and requires reshaping RunTraceCard while delta.md:164 replaces RunTraceCard — Implementers cannot satisfy both migration contracts.
