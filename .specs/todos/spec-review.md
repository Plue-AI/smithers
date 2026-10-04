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

## cycle 22 · 20261004T005242 · focus design · main f95d1791854a
- [FIX] /Users/williamcory/smithers/.specs/design/README.md:66 — Delegated agents use the person’s circle and “via” attribution while M-34 requires their own avatar and “for Ben” — The reference directs implementers to reproduce superseded identity.
- [FIX] /Users/williamcory/smithers/.specs/design/mock/src/parts.tsx:39 — Delegated agents retain the person’s initials and avatar badge — The executable mock contradicts the participant identity contract.
- [FIX] /Users/williamcory/smithers/.specs/design/mock/src/cards/Act.tsx:23 — Another viewer sees the confirmation subject and waiting message while card-kinds.md requires that viewer to see nothing — Porting the mock exposes private confirmations.
- [FIX] /Users/williamcory/smithers/.specs/engineering/tickets/T-APP-01.md:13 — The ticket requires unavailable Home providers to leave Home unmounted while landed commit 8b042a777042 explicitly restores seeded fallback — J4 has incompatible activation contracts.
- [FIX] /Users/williamcory/smithers/.specs/engineering/ui-components.md:438 — Flow version selection explicitly uses React local state without a view patch — The contract contradicts durable card selection.
- [FIX] /Users/williamcory/smithers/.specs/engineering/delta.md:164 — File, Diff and Run must replace rendering paths that ui-components.md retains — Implementers receive incompatible deletion requirements.

## cycle 23 · 20261004T005934 · focus tickets · main 8a5e537f457c
- [FIX] /Users/williamcory/smithers/.specs/engineering/tickets/T-PRC-03.md:16 — MANUAL checks require approved CI evidence while AGENTS.md requires owner-signed manual receipts — A valid manual qualification cannot satisfy both closure contracts.
- [FIX] /Users/williamcory/smithers/.specs/engineering/tickets/T-PRC-03.md:19 — Reference-host execution support is excluded while AGENTS.md requires authenticated reference-host mappings — Required Mac qualification evidence lacks a compatible activation path.
- [FIX] /Users/williamcory/smithers/.specs/engineering/tickets/T-STK-12.md:60 — The stamped ticket acknowledges that its required C-STK-06 still demands removed generation-receipt behavior — Implementers cannot complete the ticket against its declared acceptance contract.
- [FIX] /Users/williamcory/smithers/.specs/engineering/tickets/T-STK-09.md:60 — Outsider-edit coverage requires label reversion without limiting the edit to before admission — The test can require reverting a label after revision 1 has already been frozen.
- [FIX] /Users/williamcory/smithers/.specs/engineering/tickets/T-DOC-02.md:15 — The architecture ticket assigns a machine to every branch without exempting `main` — It contradicts the product vocabulary’s machine-free `main`.
- [FIX] /Users/williamcory/smithers/.specs/engineering/tickets/T-APP-01.md:13 — Unavailable Home providers must leave Home unmounted while the live mount substitutes seeded work — J4 has incompatible activation contracts.
- [FIX] /Users/williamcory/smithers/.specs/engineering/delta.md:164 — File, Diff and Run rendering paths must be replaced while ui-components.md retains them — Implementers receive incompatible deletion requirements.

## cycle 24 · 20261004T010635 · focus product · main a32634d1d55f
- [FIX] /Users/williamcory/smithers/.specs/product/overview.md:44 — The overview assigns every branch a machine while mvp.md §3 explicitly gives `main` none — Implementers receive conflicting requirements for the team’s home.
- [FIX] /Users/williamcory/smithers/.specs/product/overview.md:24 — Product documentation exposes “Jev” while mvp.md §6.5 requires the visible name “Decisions” — Setup terminology contradicts the product vocabulary.
- [FIX] /Users/williamcory/smithers/.specs/product/overview.md:31 — The overview calls the product a “forge” — Public product copy violates the prescribed vocabulary.
- [FIX] /Users/williamcory/smithers/.specs/product/mvp.md:785 — Appendix B permits external agents to invoke search inside its explicitly browser-only section — The complete registry cannot produce an unambiguous actor allowlist.
- [FIX] /Users/williamcory/smithers/.specs/product/mvp.md:688 — Appendix A includes TODO Stop and Resume without corresponding entries in Appendix B’s complete flow registry — Required J4 controls are excluded by the rule that unlisted flows do not ship.
- [FIX] /Users/williamcory/smithers/.specs/engineering/tickets/T-PRC-03.md:19 — Reference-host execution support is excluded while AGENTS.md requires authenticated reference-host mappings — Required Mac qualification lacks a compatible activation path.

## cycle 25 · 20261004T011404 · focus engineering · main 7b24fed73f10
- [FIX] /Users/williamcory/smithers/.specs/engineering/delta.md:164 — File, Diff and Run rendering paths must be replaced while ui-components.md retains them — Implementers receive incompatible cutover requirements.
- [FIX] /Users/williamcory/smithers/.specs/engineering/overview.md:12 — The architecture assigns every branch a machine without exempting `main` — It contradicts the product’s machine-free team home.

## cycle 26 · 20261004T012049 · focus design · main 2aa955e6d9da
- [FIX] /Users/williamcory/smithers/.specs/design/mock/src/cards/Confirm.tsx:22 — Merge eligibility checks running checks but ignores failed checks and absent evidence — The reference presents Merge before revision-bound passing evidence exists.
- [FIX] /Users/williamcory/smithers/.specs/design/mock/src/cards/Confirm.tsx:47 — On GitHub and Cancel have neither handlers nor mock dispatch targets — The reference provides dead confirmation controls.
- [FIX] /Users/williamcory/smithers/.specs/design/mock/src/Rail.tsx:144 — Another viewer’s timeline includes the confirmation target and waiting attribution — It contradicts card-kinds.md’s requirement that other viewers see nothing.
- [FIX] /Users/williamcory/smithers/.specs/design/README.md:66 — Delegated agents use the person’s circle and “via” attribution — It contradicts M-34’s own-agent avatar and “for Ben” identity.
- [FIX] /Users/williamcory/smithers/.specs/design/mock/src/parts.tsx:39 — Delegated agents retain the person’s initials and avatar badge — The executable reference reproduces superseded identity.
- [FIX] /Users/williamcory/smithers/.specs/design/mock/src/cards/Act.tsx:23 — Another viewer sees the confirmation subject and waiting message — Porting the reference violates confirmation privacy.
- [FIX] /Users/williamcory/smithers/.specs/engineering/delta.md:164 — File, Diff and Run must replace rendering paths that ui-components.md retains — Implementers receive incompatible cutover requirements.

## cycle 27 · 20261004T012730 · focus tickets · main 2fb0e722355b
- [FIX] /Users/williamcory/smithers/.specs/engineering/tickets/T-FLW-11.md:59 — The ticket explicitly retains engine verify/review launches while acknowledging that product §6.12 and Appendix C require one durable run — J2 implementation and release acceptance have incompatible run contracts pending Will’s reconciliation.
- [FIX] /Users/williamcory/smithers/.specs/engineering/tickets/T-STK-12.md:60 — The stamped ticket acknowledges that required C-STK-06 still demands removed generation-receipt behavior — Implementers cannot complete its declared acceptance contract.
- [FIX] /Users/williamcory/smithers/.specs/engineering/tickets/T-STK-09.md:60 — Outsider-edit coverage requires label reversion without limiting the edit to before admission — The test can require reverting a label after revision 1 has been frozen.
- [FIX] /Users/williamcory/smithers/.specs/engineering/tickets/T-DOC-02.md:15 — The architecture ticket assigns one machine per branch without exempting `main` — It contradicts the product’s machine-free team home.

## cycle 28 · 20261004T013421 · focus product · main 6ebbcc9c2d28
- [FIX] /Users/williamcory/smithers/.specs/product/overview.md:44 — The overview assigns every branch a machine while mvp.md §3 gives `main` none — Implementers receive conflicting requirements for the team home.
- [FIX] /Users/williamcory/smithers/.specs/product/overview.md:24 — Product documentation exposes “Jev” while mvp.md §6.5 requires “Decisions” — Visible terminology contradicts the product vocabulary.
- [FIX] /Users/williamcory/smithers/.specs/product/overview.md:31 — The overview calls the product a “forge” — Product copy violates the prescribed vocabulary.
- [FIX] /Users/williamcory/smithers/.specs/product/mvp.md:785 — Appendix B permits external agents to invoke search inside its explicitly browser-only section — The registry cannot yield an unambiguous actor allowlist.

## cycle 29 · 20261004T014049 · focus engineering · main f6361773afab
- [FIX] /Users/williamcory/smithers/.specs/engineering/ui-components.md:438 — Flow version selection explicitly uses React local state without a view patch — The contract contradicts the durable card-selection rule.
- [FIX] /Users/williamcory/smithers/.specs/engineering/delta.md:164 — File, Diff and Run replace rendering paths that ui-components.md retains or reshapes in place — Implementers receive incompatible cutover requirements.
- [FIX] /Users/williamcory/smithers/.specs/engineering/overview.md:12 — The architecture assigns every branch a machine without exempting `main` — It contradicts the machine-free team home.

## cycle 30 · 20261004T014731 · focus design · main e81a2e6ef8c7
- [FIX] /Users/williamcory/smithers/.specs/design/mock/src/cards/Confirm.tsx:22 — Merge eligibility ignores failed local checks and absent evidence — The reference enables Merge without revision-bound passing evidence.
- [FIX] /Users/williamcory/smithers/.specs/design/mock/src/cards/Confirm.tsx:47 — On GitHub and Cancel have neither handlers nor mock dispatch targets — The reference supplies dead confirmation controls.
- [FIX] /Users/williamcory/smithers/.specs/design/mock/src/cards/Act.tsx:23 — Another viewer sees the confirmation subject and waiting attribution — The reference contradicts card-kinds.md’s requirement that other viewers see nothing.
- [FIX] /Users/williamcory/smithers/.specs/design/mock/src/Rail.tsx:144 — Another viewer’s timeline exposes the confirmation target and waiting attribution — Hiding the confirmation body alone cannot satisfy confirmation privacy.
- [FIX] /Users/williamcory/smithers/.specs/design/README.md:66 — Delegated agents use the person’s circle and “via” attribution — The design contradicts M-34’s own-agent avatar and “for Ben” identity.
- [FIX] /Users/williamcory/smithers/.specs/design/mock/src/parts.tsx:39 — Delegated agents retain the person’s initials and avatar badge — The executable reference reproduces superseded participant identity.
- [FIX] /Users/williamcory/smithers/.specs/engineering/delta.md:164 — File, Diff and Run must replace rendering paths that ui-components.md retains or reshapes in place — Implementers receive incompatible cutover requirements.

## cycle 31 · 20261004T015425 · focus tickets · main c920b2878f78
- [FIX] /Users/williamcory/smithers/.specs/engineering/tickets/T-FLW-11.md:59 — The ticket retains engine verify/review launches while acknowledging the product's one-durable-run requirement — J2 implementation and release acceptance remain incompatible pending Will's reconciliation.
- [FIX] /Users/williamcory/smithers/.specs/engineering/tickets/T-DOC-02.md:15 — The architecture ticket assigns one machine per branch without exempting `main` — It contradicts the product's machine-free team home.

## cycle 33 · 20261004T020726 · focus engineering · main c920b2878f78
- [FIX] /Users/williamcory/smithers/.specs/engineering/overview.md:12 — The architecture assigns every branch a machine without exempting `main` — It contradicts the product's machine-free team home.

## cycle 34 · 20261004T021344 · focus design · main c920b2878f78
- [FIX] /Users/williamcory/smithers/.specs/design/mock/src/cards/Act.tsx:23 — Another viewer sees the confirmation subject and waiting attribution — The reference contradicts card-kinds.md:37’s requirement that other viewers see nothing.

## cycle 35 · 20261004T022022 · focus tickets · main c920b2878f78
- [FIX] /Users/williamcory/smithers/.specs/engineering/tickets/T-FLW-11.md:59 — The ticket retains engine verify/review launches while acknowledging the product’s one-durable-run requirement — J2 implementation and release acceptance remain incompatible pending Will’s reconciliation.

## cycle 36 · 20261004T022700 · focus product · main c920b2878f78
- [FIX] /Users/williamcory/smithers/.specs/product/overview.md:44 — The overview assigns every branch a machine while mvp.md:67 explicitly gives `main` none — Implementers receive conflicting requirements for the team home.
- [FIX] /Users/williamcory/smithers/.specs/product/overview.md:24 — Product documentation exposes “Jev” while mvp.md:340 requires the visible name “Decisions” — Setup terminology contradicts the product vocabulary.
- [FIX] /Users/williamcory/smithers/.specs/product/overview.md:31 — The overview calls the product a “forge” — Product documentation violates the prescribed vocabulary.

## cycle 37 · 20261004T023338 · focus engineering · main c920b2878f78
- [FIX] /Users/williamcory/smithers/.specs/engineering/delta.md:164 — File, Diff and Run replace rendering paths that ui-components.md:445 and :491 retain or reshape in place — Implementers receive incompatible cutover requirements.

## cycle 41 · 20261004T025934 · focus engineering · main c920b2878f78
- [FIX] /Users/williamcory/smithers/.specs/engineering/delta.md:164 — File, Diff, and Run replace rendering paths that ui-components.md:445 and :491 and card-kinds.md:22 and :23 retain or reshape in place — Implementers receive incompatible cutover requirements.

## cycle 42 · 20261004T030552 · focus design · main c920b2878f78
- [FIX] /Users/williamcory/smithers/.specs/engineering/delta.md:164 — Run replaces `RunTraceCard.tsx` while ui-components.md:491 and card-kinds.md:23 require reshaping it in place — Implementers receive incompatible cutover requirements.

## cycle 43 · 20261004T031244 · focus tickets · main c920b2878f78
- [FIX] /Users/williamcory/smithers/.specs/engineering/tickets/T-PRC-03.md:16 — MANUAL checks remain uncloseable until approved CI evidence exists while AGENTS.md requires owner-signed manual receipts — Manual qualification cannot satisfy both closure contracts.
- [FIX] /Users/williamcory/smithers/.specs/engineering/tickets/T-PRC-03.md:19 — The ticket excludes reference-host execution support while AGENTS.md requires authenticated reference-host mappings — Required Mac qualification lacks a compatible evidence path.
- [FIX] /Users/williamcory/smithers/.specs/engineering/tickets/T-STK-12.md:60 — The stamped ticket acknowledges that required C-STK-06 still demands removed generation-receipt behavior — Its implementation and acceptance contracts remain incompatible.
- [FIX] /Users/williamcory/smithers/.specs/engineering/tickets/T-STK-09.md:60 — Outsider-edit coverage requires label reversion without limiting the edit to before admission — The test can require reverting an already-admitted label despite frozen revision 1.
- [FIX] /Users/williamcory/smithers/.specs/engineering/tickets/T-DOC-02.md:15 — The architecture ticket assigns one machine per branch without exempting `main` — It contradicts mvp.md:67’s machine-free team home.
- [FIX] /Users/williamcory/smithers/.specs/engineering/delta.md:164 — Run replaces `RunTraceCard.tsx` while card-kinds.md:23 requires reshaping it in place — Implementers receive incompatible cutover requirements.
- [FIX] /Users/williamcory/smithers/.specs/engineering/tickets/T-FLW-01.md:18 — The ticket assigns `stack.propose` to T-FLW-11 while T-FLW-11.md:27 assigns its dispatch to T-STK-12 — The catalog ticket points implementers to the wrong owner for proposal authorization.

## cycle 44 · 20261004T031926 · focus product · main c920b2878f78
- [FIX] /Users/williamcory/smithers/.specs/product/overview.md:24 — Product documentation exposes “Jev” while J1 and §6.5 require “Decisions” — Setup terminology contradicts the product vocabulary.

## cycle 45 · 20261004T032552 · focus engineering · main c920b2878f78
- [FIX] /Users/williamcory/smithers/.specs/engineering/spec.md:1205 — File, Diff, and Run replace rendering paths that ui-components.md:445 and :491 and card-kinds.md:22 and :23 retain or reshape in place — Implementers receive incompatible cutover requirements.

## cycle 46 · 20261004T033224 · focus design · main c920b2878f78
- [FIX] /Users/williamcory/smithers/.specs/engineering/spec.md:1205 — File, Diff, and Run replace rendering paths that ui-components.md and card-kinds.md retain or reshape in place — Implementers receive incompatible cutover requirements.

## cycle 47 · 20261004T033906 · focus tickets · main c920b2878f78
- [FIX] /Users/williamcory/smithers/.specs/engineering/tickets/T-PRC-03.md:16 — MANUAL checks require approved CI evidence while AGENTS.md requires owner-signed manual receipts — Manual qualification cannot satisfy both closure contracts.
- [FIX] /Users/williamcory/smithers/.specs/engineering/tickets/T-STK-12.md:60 — The stamped ticket acknowledges that required C-STK-06 still demands removed generation-receipt behavior — Implementation and acceptance remain incompatible.
- [FIX] /Users/williamcory/smithers/.specs/engineering/tickets/T-FLW-01.md:19 — The ticket assigns `stack.propose` to T-FLW-11 while T-FLW-11 assigns its dispatch to T-STK-12 — Implementers receive conflicting ownership for proposal dispatch.

## cycle 49 · 20261004T035208 · focus engineering · main c920b2878f78
- [FIX] /Users/williamcory/smithers/.specs/engineering/overview.md:12 — The architecture assigns every branch a machine while product/mvp.md:67 explicitly gives `main` none — Implementers receive conflicting requirements for the team home.
- [FIX] /Users/williamcory/smithers/.specs/engineering/ui-components.md:438 — Flow version selection explicitly uses React local state without a view patch — Reload cannot preserve the selection as required by the application rules.
- [FIX] /Users/williamcory/smithers/.specs/engineering/delta.md:164 — Cutover must fold existing Containers into card files while card-kinds.md:9 explicitly accepts landed Containers as those card files — The deletion contract requires an unnecessary migration that the component contract excludes.

## cycle 50 · 20261004T035839 · focus design · main c920b2878f78
- [FIX] /Users/williamcory/smithers/.specs/engineering/ui-components.md:438 — Flow version selection explicitly uses React local state without a view patch — Reload cannot preserve the selection as required by application rules.
- [FIX] /Users/williamcory/smithers/.specs/engineering/delta.md:164 — Cutover folds existing Containers into separate card files while card-kinds.md:9 accepts landed Containers as those card files — Implementers receive incompatible migration requirements.

## cycle 51 · 20261004T040507 · focus tickets · main c920b2878f78
- [FIX] /Users/williamcory/smithers/.specs/engineering/tickets/T-GH-09.md:14 — Outbound recovery requires accepted-generation receipts from T-STK-12 while T-STK-12 explicitly excludes that subsystem — J2 publication recovery depends on a provider its owning ticket will not supply.
- [FIX] /Users/williamcory/smithers/.specs/engineering/tickets/T-FLW-01.md:19 — The ticket assigns `stack.propose` to T-FLW-11 while T-FLW-11:27 assigns its dispatch to T-STK-12 — Implementers receive conflicting ownership for proposal dispatch.

## cycle 52 · 20261004T041221 · focus product · main c920b2878f78
- [FIX] /Users/williamcory/smithers/.specs/product/overview.md:24 — The overview exposes “Jev” while J1 and §6.5 require “Decisions” — Product documentation contradicts the required visible vocabulary.
- [FIX] /Users/williamcory/smithers/.specs/product/overview.md:31 — The overview calls the product a “forge” — Product copy violates the repository’s prescribed vocabulary.
- [FIX] /Users/williamcory/smithers/.specs/product/mvp.md:785 — Appendix B permits external agents to invoke search inside its explicitly browser-only section — The registry gives conflicting actor permissions.

## cycle 53 · 20261004T041832 · focus engineering · main c920b2878f78
- [FIX] /Users/williamcory/smithers/.specs/engineering/overview.md:12 — The architecture assigns every branch a machine while product/mvp.md:67 exempts `main` — Implementers receive conflicting requirements for the team home.
- [FIX] /Users/williamcory/smithers/.specs/engineering/overview.md:82 — E-19 retains separate engine verification and review launches while T-FLW-11.md:59 acknowledges the product requires one durable run — J2 release acceptance remains incompatible with the engineering composition.

## cycle 55 · 20261004T043130 · focus tickets · main c920b2878f78
- [FIX] /Users/williamcory/smithers/.specs/engineering/tickets/T-GH-09.md:14 — Outbound recovery requires accepted-generation receipts from T-STK-12 while T-STK-12:23 excludes immutable acceptance receipts — J2 recovery depends on evidence its owning ticket will not supply.
- [FIX] /Users/williamcory/smithers/.specs/engineering/tickets/T-STK-12.md:60 — The stamped ticket acknowledges that required C-STK-06 still demands removed generation-receipt behavior — Implementation and completion requirements remain incompatible.
- [FIX] /Users/williamcory/smithers/.specs/engineering/tickets/T-FLW-01.md:19 — The ticket assigns `stack.propose` to T-FLW-11 while T-FLW-11:27 assigns reserved proposal dispatch to T-STK-12 — Implementers receive conflicting ownership for proposal authorization.
- [FIX] /Users/williamcory/smithers/.specs/engineering/tickets/T-FLW-11.md:59 — The ticket retains engine verify/review launches while acknowledging the product’s one-durable-run requirement — J2 release acceptance remains incompatible pending Will’s reconciliation.
- [FIX] /Users/williamcory/smithers/.specs/engineering/tickets/T-PRC-03.md:16 — MANUAL entries require approved CI evidence while AGENTS.md requires owner-signed manual receipts — Manual qualification cannot satisfy both closure contracts.
- [FIX] /Users/williamcory/smithers/.specs/engineering/delta.md:164 — Cutover folds landed Containers into separate card files while card-kinds.md:9 accepts those Containers as the card files — Implementers receive incompatible migration requirements.

## cycle 56 · 20261004T043813 · focus product · main c920b2878f78
- [FIX] /Users/williamcory/smithers/.specs/product/overview.md:44 — The overview assigns every branch a machine while mvp.md:67 exempts `main` — Implementers receive conflicting requirements for the team home.
- [FIX] /Users/williamcory/smithers/.specs/product/overview.md:24 — The overview exposes “Jev” while J1 and §6.5 require “Decisions” — Setup terminology contradicts the visible product vocabulary.

## cycle 57 · 20261004T044442 · focus engineering · main c920b2878f78
- [FIX] /Users/williamcory/smithers/.specs/engineering/overview.md:82 — E-19 retains engine verification and review launches while T-FLW-11.md:59 acknowledges the product requires one durable run — J2 implementation and release acceptance remain incompatible.
- [FIX] /Users/williamcory/smithers/.specs/engineering/ui-components.md:438 — Flow version selection explicitly uses React local state without a view patch — The contract contradicts persisted card selection.
- [FIX] /Users/williamcory/smithers/.specs/engineering/spec.md:1205 — File, Diff, and Run replace rendering paths that ui-components.md:445 and :491 and card-kinds.md:22 and :23 retain or reshape in place — Implementers receive incompatible deletion requirements.

## cycle 59 · 20261004T045814 · focus tickets · main c920b2878f78
- [FIX] /Users/williamcory/smithers/.specs/engineering/tickets/T-FLW-01.md:19 — The ticket assigns `stack.propose` to T-FLW-11 while T-STK-12:13 owns its reserved dispatch — Implementers receive conflicting ownership for proposal authorization.

## cycle 60 · 20261004T050453 · focus product · main c920b2878f78
- [FIX] /Users/williamcory/smithers/.specs/product/overview.md:24 — The overview exposes “Jev” while J1 and §6.5 require “Decisions” — Setup terminology contradicts the prescribed product vocabulary.
- [FIX] /Users/williamcory/smithers/.specs/product/overview.md:31 — The overview calls the product a “forge” — Product documentation violates the repository’s vocabulary rule.
- [FIX] /Users/williamcory/smithers/.specs/product/mvp.md:785 — Appendix B permits external agents to invoke search inside its explicitly browser-only section — The registry gives contradictory actor permissions.

## cycle 61 · 20261004T051148 · focus engineering · main c920b2878f78
- [FIX] /Users/williamcory/smithers/.specs/engineering/spec.md:1205 — Run replaces `RunTraceCard` while ui-components.md:491 and card-kinds.md:23 require reshaping it in place — Implementers receive incompatible deletion requirements.
- [FIX] /Users/williamcory/smithers/.specs/engineering/tickets/T-APP-01.md:13 — Unavailable Home providers must leave Home unmounted while HomeContainer.tsx:109 substitutes seeded work — The live mount violates the ticket’s activation contract.

## cycle 64 · 20261004T053200 · focus product · main c920b2878f78
- [FIX] /Users/williamcory/smithers/.specs/product/overview.md:24 — The overview exposes “Jev” while J1 and §6.5 require “Decisions” — Setup terminology contradicts the prescribed visible vocabulary.

## cycle 65 · 20261004T053806 · focus engineering · main c920b2878f78
- [FIX] /Users/williamcory/smithers/.specs/engineering/overview.md:12 — The architecture gives every branch a machine while product/mvp.md:67 exempts `main` — J4 implementers receive conflicting requirements for the team home.
- [FIX] /Users/williamcory/smithers/.specs/engineering/ui-components.md:438 — Flow version selection explicitly uses React local state without a view patch — The contract contradicts the application’s persisted-selection rule.
- [FIX] /Users/williamcory/smithers/.specs/engineering/spec.md:1205 — Run replaces RunTraceCard while ui-components.md:491 and card-kinds.md:23 require reshaping it in place — Implementers receive incompatible deletion requirements.
- [FIX] /Users/williamcory/smithers/.specs/engineering/overview.md:75 — E-19 retains separate engine verification and review launches while T-FLW-11.md:59 acknowledges the product requires one durable run — J2 implementation and release acceptance remain incompatible.

## cycle 66 · 20261004T054434 · focus design · main c920b2878f78
- [FIX] /Users/williamcory/smithers/.specs/design/mock/src/cards/Act.tsx:23 — Another viewer sees the confirmation subject and waiting attribution — The reference violates card-kinds.md’s requirement that other viewers see nothing.
- [FIX] /Users/williamcory/smithers/.specs/design/mock/src/Rail.tsx:144 — Another viewer’s timeline exposes the confirmation target and waiting attribution — Hiding the confirmation body alone cannot preserve confirmation privacy.
- [FIX] /Users/williamcory/smithers/.specs/design/mock/src/cards/Confirm.tsx:42 — The stale-approval message contains fifteen words with populated revisions — The reference violates its twelve-word card-line limit.

## cycle 67 · 20261004T055130 · focus tickets · main c920b2878f78
- [FIX] /Users/williamcory/smithers/.specs/engineering/tickets/T-GH-09.md:14 — Outbound recovery requires accepted-generation receipts from T-STK-12 while T-STK-12.md:23 excludes immutable acceptance receipts — J2 recovery depends on evidence its owning ticket will not supply.
- [FIX] /Users/williamcory/smithers/.specs/engineering/tickets/T-STK-12.md:60 — The stamped ticket acknowledges that required C-STK-06 still demands removed generation-receipt behavior — Its implementation and completion contracts remain incompatible.
- [FIX] /Users/williamcory/smithers/.specs/engineering/tickets/T-FLW-01.md:19 — The ticket assigns `stack.propose` to T-FLW-11 while T-STK-12.md:13 owns its reserved dispatch — Implementers receive conflicting ownership for proposal authorization.

## cycle 68 · 20261004T055814 · focus product · main c920b2878f78
- [FIX] /Users/williamcory/smithers/.specs/product/overview.md:44 — The overview assigns every branch a machine while mvp.md:67 exempts `main` — J4 implementers receive conflicting requirements for the team home.
- [FIX] /Users/williamcory/smithers/.specs/product/overview.md:24 — The overview exposes “Jev” while J1 and §6.5 require “Decisions” — Setup terminology contradicts the required visible vocabulary.

## cycle 69 · 20261004T060436 · focus engineering · main c920b2878f78
- [FIX] /Users/williamcory/smithers/.specs/engineering/overview.md:12 — The architecture assigns every branch a machine while product/mvp.md exempts `main` — J4 implementers receive conflicting requirements for the team home.
- [FIX] /Users/williamcory/smithers/.specs/engineering/overview.md:75 — E-19 retains separate engine verification and review launches while T-FLW-11.md:59 acknowledges the product requires one durable run — J2 implementation and release acceptance remain incompatible pending Will’s reconciliation.

## cycle 70 · 20261004T061114 · focus design · main c920b2878f78
- [FIX] /Users/williamcory/smithers/.specs/design/mock/src/cards/Confirm.tsx:47 — On GitHub and Cancel have neither handlers nor mock dispatch targets — J2’s reference supplies dead confirmation controls.
- [FIX] /Users/williamcory/smithers/.specs/design/README.md:66 — Delegated agents use the person’s circle and “via” attribution — The reference contradicts M-34’s own-agent avatar and “for Ben” identity.

## cycle 71 · 20261004T061809 · focus tickets · main c920b2878f78
- [FIX] /Users/williamcory/smithers/.specs/engineering/tickets/T-STK-12.md:60 — The stamped ticket acknowledges that required C-STK-06 still demands removed generation-receipt behavior — Implementation and completion contracts remain incompatible.

## cycle 72 · 20261004T062447 · focus product · main c920b2878f78
- [FIX] /Users/williamcory/smithers/.specs/product/overview.md:44 — The overview assigns every branch a machine while mvp.md §3 explicitly gives `main` none — J4 implementers receive conflicting requirements for the team home.
- [FIX] /Users/williamcory/smithers/.specs/product/overview.md:24 — The overview exposes “Jev” while J1 and §6.5 require “Decisions” — Setup terminology contradicts the required product vocabulary.

## cycle 73 · 20261004T063110 · focus engineering · main c920b2878f78
- [FIX] /Users/williamcory/smithers/.specs/engineering/overview.md:75 — E-19 retains engine verification and review launches while T-FLW-11 acknowledges the product requires one durable run — J2 implementation and release acceptance remain incompatible pending Will’s reconciliation.

## cycle 74 · 20261004T063752 · focus design · main c920b2878f78
- [FIX] /Users/williamcory/smithers/.specs/design/mock/src/cards/Confirm.tsx:22 — Merge eligibility ignores failed local checks and treats absent evidence as not checking — The reference offers Merge without revision-bound passing evidence.
- [FIX] /Users/williamcory/smithers/.specs/design/mock/src/cards/Confirm.tsx:47 — On GitHub and Cancel have neither handlers nor mock dispatch targets — The reference cannot demonstrate either required press.
- [FIX] /Users/williamcory/smithers/.specs/design/mock/src/cards/Act.tsx:23 — Another viewer sees the confirmation subject and waiting attribution — The reference contradicts the private-confirmation contract.
- [FIX] /Users/williamcory/smithers/.specs/design/mock/src/Rail.tsx:144 — Another viewer’s timeline exposes the confirmation target and waiting attribution — Hiding the card alone cannot preserve confirmation privacy.
- [FIX] /Users/williamcory/smithers/.specs/design/README.md:66 — Delegated agents use the person’s circle and “via” attribution — The design directs implementers away from M-34’s own-avatar and “for Ben” identity.
- [FIX] /Users/williamcory/smithers/.specs/design/mock/src/parts.tsx:39 — Delegated agents retain the person’s initials and avatar badge — J4 presence cannot distinguish the delegate through its own avatar.
- [FIX] /Users/williamcory/smithers/.specs/design/mock/src/cards/Confirm.tsx:42 — The stale-approval message contains fifteen words with populated revisions — The reference violates the twelve-word card-line limit.
- [FIX] /Users/williamcory/smithers/.specs/design/mock/src/mock.css:891 — The journey selector uses a hard-coded focus outline instead of `--ring-border` — Its keyboard focus bypasses the required palette token.
- [FIX] /Users/williamcory/smithers/.specs/engineering/delta.md:164 — Cutover folds landed Containers into separate card files while card-kinds.md accepts those Containers as the card files — Implementers receive incompatible migration requirements.
- [FIX] /Users/williamcory/smithers/.specs/engineering/spec.md:1205 — Run replaces RunTraceCard while ui-components.md requires reshaping it in place — Implementers receive incompatible deletion requirements.

## cycle 75 · 20261004T064427 · focus tickets · main c920b2878f78
- [FIX] /Users/williamcory/smithers/.specs/engineering/tickets/T-PRC-03.md:16 — MANUAL entries require an approved CI target while AGENTS.md requires owner-signed manual receipts — Manual qualification cannot satisfy both closure contracts.
- [FIX] /Users/williamcory/smithers/.specs/engineering/tickets/T-PRC-03.md:19 — Reference-host execution support is excluded while AGENTS.md requires authenticated reference-host mappings — Required Mac qualification lacks a compatible execution path.
- [FIX] /Users/williamcory/smithers/.specs/engineering/tickets/T-DOC-02.md:15 — E-03 assigns one machine per branch without exempting `main` — The architecture contradicts the product’s machine-free team home.
- [FIX] /Users/williamcory/smithers/.specs/engineering/spec.md:1205 — Run replaces RunTraceCard while ui-components.md:491 requires reshaping it in place — Implementers receive incompatible deletion requirements.

## cycle 76 · 20261004T065132 · focus product · main c920b2878f78
- [FIX] /Users/williamcory/smithers/.specs/product/overview.md:44 — The overview assigns every branch a machine while mvp.md:67 gives `main` none — Implementers receive conflicting requirements for J4’s team home.
- [FIX] /Users/williamcory/smithers/.specs/product/mvp.md:785 — Browser-only search entries explicitly allow external agents despite the section’s prohibition — The registry gives contradictory actor permissions.
- [FIX] /Users/williamcory/smithers/.specs/product/mvp.md:688 — Appendix A requires TODO Stop and Resume without corresponding entries in Appendix B’s complete registry — Required controls conflict with the rule that unlisted flows do not ship.
- [FIX] /Users/williamcory/smithers/.specs/engineering/tickets/T-APP-01.md:13 — Unavailable Home providers must leave Home unmounted while the live mount substitutes seeded work — J4 has incompatible activation behavior.

## cycle 77 · 20261004T065805 · focus engineering · main c920b2878f78
- [FIX] /Users/williamcory/smithers/.specs/engineering/overview.md:12 — The architecture assigns every branch a machine while product/mvp.md:67 exempts `main` — J4 implementers receive conflicting requirements for the team home.
- [FIX] /Users/williamcory/smithers/.specs/engineering/ui-components.md:438 — Flow version selection explicitly uses React local state without a view patch — The contract contradicts the application’s durable card-selection rule.
- [FIX] /Users/williamcory/smithers/.specs/engineering/tickets/T-APP-01.md:13 — Unavailable Home providers must leave Home unmounted while HomeContainer.tsx:109 substitutes seeded work — J4 has incompatible activation behavior.

## cycle 78 · 20261004T070440 · focus design · main c920b2878f78
- [FIX] /Users/williamcory/smithers/.specs/design/mock/src/cards/Act.tsx:23 — Another viewer sees the confirmation subject and waiting attribution — This contradicts card-kinds.md:37’s requirement that other viewers see nothing.
- [FIX] /Users/williamcory/smithers/.specs/design/mock/src/Rail.tsx:144 — Another viewer’s timeline exposes the confirmation target and waiting attribution — Hiding only the card would still violate confirmation privacy.
- [FIX] /Users/williamcory/smithers/.specs/design/mock/src/parts.tsx:39 — Delegated agents retain the person’s initials and avatar badge — The executable mock reproduces the superseded participant identity.
- [FIX] /Users/williamcory/smithers/.specs/design/mock/src/cards/Confirm.tsx:42 — The stale-approval message contains fifteen words with populated revisions — It exceeds the design’s twelve-word card-line limit.
- [FIX] /Users/williamcory/smithers/.specs/design/mock/src/mock.css:891 — The journey selector uses a hard-coded focus outline — It contradicts README.md:120’s required `--ring-border`.
- [FIX] /Users/williamcory/smithers/.specs/engineering/spec.md:1205 — Run replaces `RunTraceCard` while ui-components.md:491 requires reshaping it in place — Implementers receive incompatible deletion requirements.

## cycle 79 · 20261004T071104 · focus tickets · main c920b2878f78
- [FIX] /Users/williamcory/smithers/.specs/engineering/tickets/T-GH-09.md:14 — Outbound recovery requires accepted-generation receipts from T-STK-12 while that ticket excludes immutable acceptance receipts — Recovery depends on an explicitly unavailable provider contract.
- [FIX] /Users/williamcory/smithers/.specs/engineering/tickets/T-STK-12.md:60 — The stamped ticket acknowledges that required C-STK-06 still demands removed generation-receipt behavior — Implementation cannot satisfy its declared completion checks.
- [FIX] /Users/williamcory/smithers/.specs/engineering/tickets/T-FLW-01.md:19 — The ticket assigns `stack.propose` to T-FLW-11 while T-FLW-11 assigns reserved proposal dispatch to T-STK-12 — Implementers receive conflicting ownership for proposal authorization.
- [FIX] /Users/williamcory/smithers/.specs/engineering/tickets/T-APP-01.md:13 — Unavailable Home providers must leave Home unmounted while the live mount substitutes seeded work — J4 violates the ticket’s fail-closed activation contract.

## cycle 80 · 20261004T071805 · focus product · main c920b2878f78
- [FIX] /Users/williamcory/smithers/.specs/product/overview.md:24 — The overview exposes “Jev” while J1 and §6.5 require “Decisions” — Setup terminology contradicts the product vocabulary.
- [FIX] /Users/williamcory/smithers/.specs/product/mvp.md:688 — Appendix A requires TODO Stop and Resume without explicitly mapping either command in Appendix B — The complete registry does not establish the required TODO control doors.

## cycle 81 · 20261004T072438 · focus engineering · main c920b2878f78
- [FIX] /Users/williamcory/smithers/.specs/engineering/delta.md:164 — Cutover folds HomeContainer into another card file while card-kinds.md:15 and T-APP-01.md:12 designate HomeContainer as the card file — Implementers receive incompatible migration requirements.
- [FIX] /Users/williamcory/smithers/.specs/engineering/delta.md:164 — Run replaces RunTraceCard while ui-components.md:491 requires reshaping it in place — Implementers cannot satisfy both deletion contracts.
- [FIX] /Users/williamcory/smithers/.specs/engineering/overview.md:12 — The architecture assigns exactly one machine to a branch without exempting `main` — It contradicts the product’s machine-free team home.
- [FIX] /Users/williamcory/smithers/.specs/engineering/tickets/T-FLW-11.md:59 — The ticket retains engine verify/review launches while acknowledging the product’s one-durable-run requirement — Release still depends on an unresolved execution contract.

## cycle 82 · 20261004T073105 · focus design · main c920b2878f78
- [FIX] /Users/williamcory/smithers/.specs/design/mock/src/cards/Act.tsx:23 — Another viewer sees the confirmation subject and waiting attribution while card-kinds.md:37 requires that viewer to see nothing — Porting the reference exposes private confirmations.
- [FIX] /Users/williamcory/smithers/.specs/design/mock/src/Rail.tsx:144 — Another viewer’s timeline includes the private confirmation target and waiting attribution — Hiding only the card body cannot satisfy confirmation privacy.
- [FIX] /Users/williamcory/smithers/.specs/design/README.md:66 — Delegated agents use the person’s circle and “via” attribution instead of M-34’s own-agent avatar and “for Ben” identity — The design directs implementers to reproduce superseded identity.
- [FIX] /Users/williamcory/smithers/.specs/design/mock/src/parts.tsx:39 — Delegated agents retain the person’s initials and avatar badge — The executable reference reproduces the superseded identity contract.
- [FIX] /Users/williamcory/smithers/.specs/engineering/delta.md:164 — Cutover folds HomeContainer into another card file while card-kinds.md:15 designates HomeContainer as the card file — Implementers receive incompatible migration requirements.

## cycle 83 · 20261004T073748 · focus tickets · main c920b2878f78
- [FIX] /Users/williamcory/smithers/.specs/engineering/tickets/T-GH-09.md:14 — Outbound recovery requires accepted-generation receipts from T-STK-12 while that ticket explicitly excludes immutable acceptance receipts — Recovery depends on a provider contract its owning ticket will not implement.
- [FIX] /Users/williamcory/smithers/.specs/engineering/tickets/T-STK-12.md:60 — The stamped ticket acknowledges that required C-STK-06 still demands removed generation-receipt behavior — Its declared acceptance contract remains incompatible with its implementation scope.
- [FIX] /Users/williamcory/smithers/.specs/engineering/tickets/T-FLW-01.md:19 — The ticket assigns `stack.propose` to T-FLW-11 while T-FLW-11:27 assigns reserved proposal dispatch to T-STK-12 — The catalog integration names conflicting implementation owners.
- [FIX] /Users/williamcory/smithers/.specs/engineering/tickets/T-PRC-03.md:19 — Reference-host execution support is excluded while AGENTS.md requires authenticated reference-host mappings — Required Mac qualification lacks a compatible mapping activation path.
- [FIX] /Users/williamcory/smithers/.specs/engineering/tickets/T-STK-09.md:60 — Outsider-edit coverage requires label reversion without limiting the edit to before admission — The test can contradict the frozen revision-one contract after admission.
- [FIX] /Users/williamcory/smithers/.specs/engineering/tickets/T-DOC-02.md:15 — The architecture ticket assigns one machine per branch without exempting `main` — It contradicts the product’s machine-free `main`.

## cycle 84 · 20261004T074436 · focus product · main c920b2878f78
- [FIX] /Users/williamcory/smithers/.specs/product/overview.md:44 — The overview assigns every branch a machine while mvp.md:67 gives `main` none — J4 implementers receive conflicting requirements for the team home.
- [FIX] /Users/williamcory/smithers/.specs/product/overview.md:24 — The overview exposes “Jev” while J1 requires “Decisions” — Setup terminology contradicts the required visible vocabulary.
- [FIX] /Users/williamcory/smithers/.specs/product/mvp.md:785 — Appendix B permits external agents to invoke palette search inside its browser-only section — The registry gives contradictory actor permissions.

## cycle 85 · 20261004T075129 · focus engineering · main c920b2878f78
- [FIX] /Users/williamcory/smithers/.specs/engineering/overview.md:12 — The architecture assigns every branch exactly one machine while product/mvp.md exempts `main` — J4 implementers receive conflicting requirements for the team home.
- [FIX] /Users/williamcory/smithers/.specs/engineering/delta.md:164 — Cutover folds HomeContainer into another card file while card-kinds.md and T-APP-01 designate HomeContainer as the card file — Implementers receive incompatible migration requirements.
- [FIX] /Users/williamcory/smithers/.specs/engineering/spec.md:1205 — Run replaces RunTraceCard while ui-components.md:491 requires reshaping it in place — Implementers cannot satisfy both deletion contracts.
- [FIX] /Users/williamcory/smithers/.specs/engineering/delta.md:164 — File and Diff replace CodeSurface and DiffSurface while ui-components.md:445 retains those rendering paths — Implementers receive incompatible cutover requirements.
- [FIX] /Users/williamcory/smithers/.specs/engineering/tickets/T-APP-01.md:13 — Unavailable Home providers must leave Home unmounted while the live mount substitutes seeded work — J4 violates the ticket’s activation contract.
- [FIX] /Users/williamcory/smithers/.specs/engineering/overview.md:75 — E-19 retains engine verify/review launches while T-FLW-11:59 acknowledges the product requires one durable run — J2 release acceptance depends on an unresolved execution contract.

## cycle 86 · 20261004T075823 · focus design · main c920b2878f78
- [FIX] /Users/williamcory/smithers/.specs/design/mock/src/Rail.tsx:144 — Another viewer’s timeline reveals the private confirmation target and waiting attribution — Hiding only its controls cannot satisfy confirmation privacy.
- [FIX] /Users/williamcory/smithers/.specs/design/mock/src/parts.tsx:39 — Delegated agents retain the person’s initials and avatar badge — The executable reference reproduces the identity presentation M-34 replaced.
- [FIX] /Users/williamcory/smithers/.specs/engineering/delta.md:164 — Cutover folds HomeContainer into another card file while T-APP-01 designates HomeContainer as the card file — Implementers receive incompatible migration requirements.
- [FIX] /Users/williamcory/smithers/.specs/engineering/spec.md:1205 — Run replaces RunTraceCard while ui-components.md requires reshaping it in place — Implementers cannot satisfy both deletion contracts.
- [FIX] /Users/williamcory/smithers/.specs/engineering/delta.md:164 — File and Diff replace CodeSurface and DiffSurface while ui-components.md retains those paths — Implementers receive incompatible cutover requirements.

## cycle 87 · 20261004T080515 · focus tickets · main c920b2878f78
- [FIX] /Users/williamcory/smithers/.specs/engineering/tickets/T-GH-09.md:14 — Outbound recovery requires accepted-generation receipts that T-STK-12.md:23 explicitly excludes — The provider contract cannot be fulfilled as written.
- [FIX] /Users/williamcory/smithers/.specs/engineering/tickets/T-STK-12.md:60 — The ready-stamped ticket acknowledges that required C-STK-06 still demands removed generation-receipt behavior — Completion remains blocked by incompatible acceptance requirements.
- [FIX] /Users/williamcory/smithers/.specs/engineering/tickets/T-FLW-01.md:19 — The ticket assigns `stack.propose` to T-FLW-11 while T-FLW-11 assigns reserved dispatch to T-STK-12 — Implementers receive conflicting ownership for a publication boundary.
- [FIX] /Users/williamcory/smithers/.specs/engineering/tickets/T-PRC-03.md:16 — MANUAL entries require approved CI evidence while AGENTS.md requires owner-signed manual receipts — Required manual checks have incompatible closure contracts.
- [FIX] /Users/williamcory/smithers/.specs/engineering/tickets/T-PRC-03.md:19 — Reference-host execution support is excluded while AGENTS.md requires authenticated reference-host mappings — Required host evidence lacks a supported completion path.
- [FIX] /Users/williamcory/smithers/.specs/engineering/tickets/T-FLW-11.md:76 — The ticket retains engine verify/review launches while acknowledging the product requires one durable run — J2 release acceptance requires an unresolved product reconciliation.

## cycle 88 · 20261004T081217 · focus product · main c920b2878f78
- [FIX] /Users/williamcory/smithers/.specs/product/overview.md:44 — The overview assigns every branch a machine while mvp.md:67 explicitly gives `main` none — Implementers receive conflicting requirements for the team’s home.
- [FIX] /Users/williamcory/smithers/.specs/product/overview.md:24 — The overview exposes “Jev” while J1 requires “Decisions” — Setup terminology contradicts the prescribed visible name.
- [FIX] /Users/williamcory/smithers/.specs/product/overview.md:31 — The overview calls the product a “forge” — Product documentation violates the vocabulary rule.
- [FIX] /Users/williamcory/smithers/.specs/product/mvp.md:785 — Appendix B permits external agents to invoke palette search inside its browser-only section — The registry contradicts the explicit prohibition on external agents invoking UI-only flows.

## cycle 89 · 20261004T081908 · focus engineering · main c920b2878f78
- [FIX] /Users/williamcory/smithers/.specs/engineering/overview.md:12 — The architecture assigns every branch exactly one machine while product/mvp.md exempts `main` — Implementers receive conflicting topology requirements for the team’s home.
- [FIX] /Users/williamcory/smithers/.specs/engineering/ui-components.md:438 — Flow version selection explicitly uses React local state without a view patch — The component contract contradicts durable card-selection rules.
- [FIX] /Users/williamcory/smithers/.specs/engineering/delta.md:164 — Cutover folds HomeContainer into another card file while card-kinds.md designates HomeContainer as the card file — Implementers receive incompatible migration requirements.
- [FIX] /Users/williamcory/smithers/.specs/engineering/delta.md:164 — Run replaces RunTraceCard while ui-components.md requires reshaping it in place — Implementers receive conflicting instructions about deleting the existing card.
- [FIX] /Users/williamcory/smithers/.specs/engineering/overview.md:75 — E-19 retains engine verify/review launches while T-FLW-11 acknowledges the product requires one durable run — J2 acceptance depends on an unresolved execution contract.

## cycle 90 · 20261004T082549 · focus design · main c920b2878f78
- [FIX] /Users/williamcory/smithers/.specs/design/mock/src/cards/Act.tsx:23 — Another viewer sees the confirmation subject and waiting attribution — This contradicts card-kinds.md’s requirement that other viewers see nothing.
- [FIX] /Users/williamcory/smithers/.specs/design/mock/src/Rail.tsx:144 — Another viewer’s timeline reveals the private confirmation target and waiting attribution — Hiding the confirmation button does not preserve confirmation privacy.
- [FIX] /Users/williamcory/smithers/.specs/engineering/delta.md:164 — Run replaces RunTraceCard while ui-components.md requires reshaping it in place — Implementers receive conflicting deletion requirements.

## cycle 91 · 20261004T083243 · focus tickets · main c920b2878f78
- [FIX] /Users/williamcory/smithers/.specs/engineering/tickets/T-GH-09.md:14 — Outbound recovery requires accepted-generation receipts from T-STK-12 while that ticket explicitly excludes immutable acceptance receipts — The required publication provider has no compatible implementation contract.
- [FIX] /Users/williamcory/smithers/.specs/engineering/tickets/T-STK-12.md:60 — The ready-stamped ticket acknowledges that required C-STK-06 still demands removed generation-receipt behavior — Implementers cannot satisfy the stated completion gate.
- [FIX] /Users/williamcory/smithers/.specs/engineering/tickets/T-FLW-01.md:19 — `stack.propose` implementation is assigned to T-FLW-11 while T-FLW-11 assigns reserved dispatch to T-STK-12 — Ticket ownership directs implementers to different delivery contracts.
- [FIX] /Users/williamcory/smithers/.specs/engineering/tickets/T-PRC-03.md:16 — MANUAL checks require approved CI evidence while AGENTS.md requires owner-signed manual receipts — Valid manual qualification cannot satisfy both closure contracts.
- [FIX] /Users/williamcory/smithers/.specs/engineering/tickets/T-FLW-11.md:59 — The ticket retains separate engine launches while acknowledging the product requires one durable run — J2 execution and recovery remain governed by incompatible requirements.

## cycle 92 · 20261004T083903 · focus product · main c920b2878f78
- [FIX] /Users/williamcory/smithers/.specs/product/overview.md:44 — The overview assigns every branch a machine while mvp.md:67 explicitly gives `main` none — J4 implementers receive conflicting topology requirements.
- [FIX] /Users/williamcory/smithers/.specs/product/overview.md:24 — The overview exposes “Jev” while mvp.md requires the visible name “Decisions” — J1 setup terminology contradicts the product vocabulary.
- [FIX] /Users/williamcory/smithers/.specs/product/mvp.md:785 — Appendix B permits external agents to invoke palette search inside its explicitly browser-only section — The registry contradicts its prohibition on external agents invoking UI-only flows.

## cycle 93 · 20261004T084502 · focus engineering · main c920b2878f78
- [FIX] /Users/williamcory/smithers/.specs/engineering/delta.md:164 — Cutover requires folding HomeContainer into another card file while T-APP-01 explicitly retains HomeContainer as the card file — Implementers receive incompatible migration instructions.
- [FIX] /Users/williamcory/smithers/.specs/engineering/ui-components.md:438 — Flow version selection explicitly uses React local state without a view patch — The contract violates durable card-selection rules.
- [FIX] /Users/williamcory/smithers/.specs/engineering/ui-components.md:491 — Run must reshape RunTraceCard in place while delta.md requires replacing it — The two contracts disagree on the required deletion.
- [FIX] /Users/williamcory/smithers/.specs/engineering/overview.md:12 — Every branch receives exactly one machine without exempting `main` — The architecture conflicts with the product’s machine-free team home.
- [FIX] /Users/williamcory/smithers/.specs/engineering/tickets/T-FLW-11.md:59 — The ticket acknowledges that retained engine launches contradict the product’s one-durable-run requirement — J2 implementation proceeds against an unresolved release contract.
- [FIX] /Users/williamcory/smithers/.specs/engineering/tickets/T-STK-12.md:60 — The ticket retains C-STK-06 while acknowledging its superseded generation-receipt assertions — Completion cannot be judged consistently.

## cycle 94 · 20261004T085135 · focus design · main c920b2878f78
- [FIX] /Users/williamcory/smithers/.specs/design/mock/src/cards/Confirm.tsx:22 — Merge treats missing evidence and failed local checks as not checking — The reference enables Merge without proving every check passed.
- [FIX] /Users/williamcory/smithers/.specs/design/mock/src/cards/Confirm.tsx:47 — On GitHub and Cancel have neither handlers nor mock dispatch targets — The reference supplies dead review controls.
- [FIX] /Users/williamcory/smithers/.specs/design/mock/src/cards/Act.tsx:19 — Another viewer receives the pending confirmation’s subject and waiting attribution — The mock violates the private confirmation contract.
- [FIX] /Users/williamcory/smithers/.specs/design/mock/src/Rail.tsx:144 — Another viewer’s timeline exposes the pending confirmation target and requester — Hiding the card alone cannot preserve confirmation privacy.
- [FIX] /Users/williamcory/smithers/.specs/design/README.md:66 — Delegated agents use the person’s circle and “via” attribution — The reference contradicts M-34’s separate agent identity.
- [FIX] /Users/williamcory/smithers/.specs/design/mock/src/parts.tsx:39 — Delegated agents retain the person’s initials and avatar badge — The executable reference reproduces the superseded identity design.
- [FIX] /Users/williamcory/smithers/.specs/engineering/delta.md:164 — Cutover folds HomeContainer into another card file while T-APP-01 retains HomeContainer as the card file — Implementers receive incompatible migration instructions.
- [FIX] /Users/williamcory/smithers/.specs/engineering/ui-components.md:438 — Flow version selection explicitly uses React local state without a view patch — The component contract violates durable card-selection rules.
- [FIX] /Users/williamcory/smithers/.specs/engineering/ui-components.md:491 — Run must reshape RunTraceCard in place while delta.md requires replacing it — The contracts disagree on the required deletion.

## cycle 95 · 20261004T085741 · focus tickets · main c920b2878f78
- [FIX] /Users/williamcory/smithers/.specs/engineering/tickets/T-GH-09.md:14 — Recovery requires accepted-generation receipts that T-STK-12 explicitly excludes — GitHub sends depend on evidence their designated provider will never supply.
- [FIX] /Users/williamcory/smithers/.specs/engineering/tickets/T-FLW-11.md:59 — The ready-stamped ticket retains separate engine launches while acknowledging the product requires one durable run — Stop, Resume, and steer implementers receive incompatible run-lifetime contracts.
- [FIX] /Users/williamcory/smithers/.specs/engineering/tickets/T-STK-12.md:60 — The ready-stamped ticket acknowledges that required C-STK-06 still demands removed generation-receipt behavior — Implementing its declared scope cannot satisfy its closure gate.
- [FIX] /Users/williamcory/smithers/.specs/engineering/tickets/T-FLW-01.md:19 — `stack.propose` is assigned to T-FLW-11 while T-FLW-11 assigns reserved dispatch to T-STK-12 — The catalog ticket identifies the wrong integration owner.
- [FIX] /Users/williamcory/smithers/.specs/engineering/tickets/T-DOC-02.md:15 — The ADR ticket requires one machine per branch without exempting `main` as mvp.md does — Accepting that wording preserves a conflicting deployment contract.
- [FIX] /Users/williamcory/smithers/.specs/engineering/delta.md:164 — Cutover folds HomeContainer into another card file while T-APP-01 and card-kinds.md retain HomeContainer as the card file — Implementers receive incompatible migration instructions.

## cycle 96 · 20261004T090448 · focus product · main c920b2878f78
- [FIX] /Users/williamcory/smithers/.specs/product/mvp.md:785 — Appendix B permits external agents to invoke palette search inside its explicitly browser-only section — The complete registry gives contradictory actor permissions.

## cycle 97 · 20261004T091044 · focus engineering · main c920b2878f78
- [FIX] /Users/williamcory/smithers/.specs/engineering/overview.md:12 — Every branch receives exactly one machine while product/mvp.md:67 gives `main` none — The architecture contradicts the team’s prescribed Home topology.
- [FIX] /Users/williamcory/smithers/.specs/engineering/ui-components.md:438 — Flow version selection explicitly uses React local state without emitting a view patch — The component contract violates durable card-selection rules.
- [FIX] /Users/williamcory/smithers/.specs/engineering/delta.md:164 — Cutover folds HomeContainer into another card file while T-APP-01:12 requires that existing file as the card container — Implementers receive incompatible mounting instructions.
- [FIX] /Users/williamcory/smithers/.specs/engineering/delta.md:164 — Run replaces RunTraceCard while ui-components.md:491 requires reshaping it in place — The migration contracts disagree about the retained rendering path.
- [FIX] /Users/williamcory/smithers/.specs/engineering/overview.md:75 — E-19 retains separate engine verify/review launches while T-FLW-11:59 acknowledges the product requires one durable run — J2 implementation cannot satisfy both execution contracts.
- [FIX] /Users/williamcory/smithers/.specs/engineering/tickets/T-PRC-03.md:16 — MANUAL checks require approved CI evidence while AGENTS.md requires owner-signed manual receipts — Manual qualification has incompatible completion requirements.
- [FIX] /Users/williamcory/smithers/.specs/engineering/tickets/T-PRC-03.md:19 — Reference-host execution support is excluded while AGENTS.md requires authenticated reference-host mappings — Required Mac qualification lacks a compatible execution contract.
- [FIX] /Users/williamcory/smithers/.specs/engineering/spec.md:1539 — The check runner executes Automation locally while T-PRC-03:9 says it executes nothing locally — The normative spec and implementing ticket prescribe different evidence mechanisms.

## cycle 98 · 20261004T091706 · focus design · main c920b2878f78
- [FIX] /Users/williamcory/smithers/.specs/design/mock/src/cards/Confirm.tsx:22 — Merge eligibility ignores failed local checks and treats absent evidence as not checking — The reference offers Merge without proving every check passed.
- [FIX] /Users/williamcory/smithers/.specs/design/mock/src/cards/Act.tsx:19 — Another viewer receives the confirmation subject and waiting attribution — The mock contradicts card-kinds.md’s private confirmation contract.
- [FIX] /Users/williamcory/smithers/.specs/design/mock/src/Rail.tsx:144 — Another viewer’s timeline exposes the confirmation target and requester — Hiding the card alone cannot preserve confirmation privacy.
- [FIX] /Users/williamcory/smithers/.specs/engineering/delta.md:164 — Cutover folds HomeContainer into another card file while T-APP-01 retains HomeContainer — Implementers receive incompatible mounting instructions.
- [FIX] /Users/williamcory/smithers/.specs/engineering/delta.md:164 — Run replaces RunTraceCard while ui-components.md requires reshaping it in place — Implementers receive incompatible migration instructions.

## cycle 99 · 20261004T092347 · focus tickets · main ed943677e27e
- [FIX] /Users/williamcory/smithers/.specs/engineering/tickets/T-GH-09.md:14 — Outbound recovery requires accepted-generation receipts that T-STK-12 explicitly excludes — The two tickets cannot supply and consume the same provider contract.
- [FIX] /Users/williamcory/smithers/.specs/engineering/tickets/T-STK-12.md:60 — The ready-stamped ticket acknowledges that required C-STK-06 still demands removed generation-receipt behavior — Completion remains dependent on an unreconciled acceptance contract.
- [FIX] /Users/williamcory/smithers/.specs/engineering/tickets/T-FLW-01.md:19 — `stack.propose` is assigned to T-FLW-11 while T-FLW-11 assigns reserved dispatch to T-STK-12 — Implementers receive conflicting ownership instructions.
- [FIX] /Users/williamcory/smithers/.specs/engineering/tickets/T-PRC-03.md:19 — Reference-host execution support is excluded while AGENTS.md requires authenticated reference-host mappings — Required Mac qualification lacks a compatible evidence path.
- [FIX] /Users/williamcory/smithers/.specs/engineering/tickets/T-DOC-02.md:15 — The ADR ticket requires one machine per branch without exempting `main` — It contradicts the product’s machine-free team home.
- [FIX] /Users/williamcory/smithers/.specs/engineering/ui-components.md:438 — Flow version selection explicitly uses React local state without a view patch — The contract contradicts durable card-selection rules.

## cycle 100 · 20261004T093034 · focus product · main 812991e4cbee
- [FIX] /Users/williamcory/smithers/.specs/product/overview.md:44 — The overview assigns every branch a machine while mvp.md §3 gives main none — The first team home has conflicting infrastructure requirements.
- [FIX] /Users/williamcory/smithers/.specs/product/overview.md:24 — The overview exposes Jev while mvp.md §6.5 requires the visible name Decisions — Product documentation prescribes conflicting terminology.
- [FIX] /Users/williamcory/smithers/.specs/product/overview.md:31 — The overview names the product a forge — Its public copy violates the repository’s product vocabulary.
- [FIX] /Users/williamcory/smithers/.specs/product/mvp.md:785 — Appendix B permits external agents to invoke search flows inside its browser-only section — It contradicts §3.1’s prohibition on external-agent UI-only flows.

## cycle 101 · 20261004T093920 · focus engineering · main 95ba422211ed
- [FIX] /Users/williamcory/smithers/.specs/engineering/overview.md:12 — The overview assigns every branch exactly one machine without exempting main — It conflicts with the product’s machine-free team Home.
- [FIX] /Users/williamcory/smithers/.specs/engineering/delta.md:164 — Cutover folds HomeContainer into another card file while card-kinds.md and T-APP-01 retain HomeContainer — Implementers receive incompatible ownership and deletion instructions.
- [FIX] /Users/williamcory/smithers/.specs/engineering/delta.md:164 — Run replaces RunTraceCard while ui-components.md requires reshaping RunTraceCard in place — The migration has contradictory preservation requirements.
- [FIX] /Users/williamcory/smithers/.specs/engineering/ui-components.md:438 — Flow version selection explicitly uses React local state without emitting a view patch — The contract violates the binding persisted-card-state rule.
- [FIX] /Users/williamcory/smithers/.specs/engineering/tickets/T-PRC-03.md:16 — MANUAL checks require approved CI evidence and reject an owner signature alone — This contradicts AGENTS.md’s owner-signed manual receipt requirement.
- [FIX] /Users/williamcory/smithers/.specs/engineering/tickets/T-PRC-03.md:19 — Reference-host execution support is excluded while delta.md permits reference-host receipts — Required host evidence has no consistent qualification path.
- [FIX] /Users/williamcory/smithers/.specs/engineering/tickets/T-STK-12.md:60 — The ready-stamped ticket acknowledges that C-STK-06 still requires removed generation-receipt behavior — Its completion gate cannot qualify the specified implementation.
- [FIX] /Users/williamcory/smithers/.specs/engineering/tickets/T-FLW-11.md:59 — The ticket defers reconciliation between the product’s one durable run and retained verify/review launches — First-TODO execution still has an explicitly unresolved product contract.

## cycle 102 · 20261004T094815 · focus design · main 245e7740664e
- [FIX] /Users/williamcory/smithers/.specs/design/mock/src/cards/Confirm.tsx:22 — Confirm ignores failed local checks and treats missing evidence as not checking — It enables Merge in states that the TODO card blocks.
- [FIX] /Users/williamcory/smithers/.specs/design/mock/src/cards/Confirm.tsx:47 — On GitHub and Cancel have neither handlers nor mock dispatch targets — The reference leaves required confirmation presses without behavior.
- [FIX] /Users/williamcory/smithers/.specs/design/mock/src/cards/Act.tsx:23 — Another viewer receives the confirmation subject and waiting attribution — The reference contradicts card-kinds.md’s private-confirmation contract.
- [FIX] /Users/williamcory/smithers/.specs/design/mock/src/Rail.tsx:144 — Another viewer’s timeline exposes the confirmation target and requester — Hiding the confirmation body alone cannot preserve privacy.
- [FIX] /Users/williamcory/smithers/.specs/design/README.md:66 — Delegated agents use the person’s circle and “via” attribution while M-34 requires their own avatar and “for Ben” — The design directs implementers to reproduce superseded identity.
- [FIX] /Users/williamcory/smithers/.specs/design/mock/src/parts.tsx:39 — Delegated agents retain the person’s initials and avatar badge — The executable reference contradicts the participant identity contract.
- [FIX] /Users/williamcory/smithers/.specs/design/mock/src/cards/Confirm.tsx:42 — The stale-approval message exceeds twelve words — The reference violates its own card-copy limit.
- [FIX] /Users/williamcory/smithers/.specs/engineering/delta.md:164 — Cutover folds HomeContainer into another file and replaces RunTraceCard while card-kinds.md retains both — Implementers receive incompatible ownership and deletion instructions.
- [FIX] /Users/williamcory/smithers/.specs/engineering/tickets/T-FLW-11.md:59 — The ticket retains separate verify/review launches while acknowledging the product’s one-durable-run requirement — J2 still lacks a reconciled execution contract.

## cycle 103 · 20261004T095555 · focus tickets · main c3625568b93c
- [FIX] /Users/williamcory/smithers/.specs/engineering/tickets/T-PRC-03.md:16 — MANUAL checks require approved CI evidence and reject an owner signature alone — This contradicts AGENTS.md’s owner-signed manual receipt contract.
- [FIX] /Users/williamcory/smithers/.specs/engineering/tickets/T-PRC-03.md:19 — Reference-host execution support is excluded — Required authenticated Mac qualification mappings have no compatible implementation path.
- [FIX] /Users/williamcory/smithers/.specs/engineering/tickets/T-STK-12.md:60 — The ready-stamped ticket acknowledges that required C-STK-06 still demands removed generation-receipt behavior — Its declared acceptance contract cannot qualify the prescribed implementation.
- [FIX] /Users/williamcory/smithers/.specs/engineering/tickets/T-GH-09.md:14 — Outbound recovery requires accepted-generation receipts from T-STK-12 while that ticket excludes immutable acceptance receipts — The dependency cannot supply the contract needed to enable GitHub writes.
- [FIX] /Users/williamcory/smithers/.specs/engineering/tickets/T-FLW-11.md:59 — The ticket retains separate verify/review launches while deferring reconciliation with the product’s one durable run — J2 still has incompatible execution contracts.
- [FIX] /Users/williamcory/smithers/.specs/engineering/tickets/T-STK-09.md:60 — Outsider-edit coverage requires label reversion without limiting the edit to before admission — It can demand reversion after revision 1 has already been frozen.
- [FIX] /Users/williamcory/smithers/.specs/engineering/tickets/T-DOC-02.md:15 — The ADR ticket assigns one machine per branch without exempting main — It contradicts the product vocabulary’s machine-free main.
- [FIX] /Users/williamcory/smithers/.specs/engineering/delta.md:164 — Cutover folds HomeContainer into another file and replaces RunTraceCard while the component contracts retain them — Implementers receive incompatible ownership and deletion instructions.
- [FIX] /Users/williamcory/smithers/.specs/engineering/ui-components.md:438 — Flow version selection explicitly uses React local state without emitting a view patch — The contract contradicts persisted card selection.

## cycle 104 · 20261004T100248 · focus product · main 28f6b69ef424
- [FIX] /Users/williamcory/smithers/.specs/product/overview.md:44 — Every branch is assigned exactly one machine without exempting main — This contradicts mvp.md’s machine-free main.
- [FIX] /Users/williamcory/smithers/.specs/engineering/tickets/T-PRC-03.md:19 — Reference-host execution support is excluded — Required authenticated Mac qualification mappings lack a compatible implementation path.
- [FIX] /Users/williamcory/smithers/.specs/engineering/tickets/T-STK-12.md:60 — The ready-stamped ticket retains acceptance cases it acknowledges require removed generation receipts — Its prescribed implementation cannot satisfy the declared qualification contract.
- [FIX] /Users/williamcory/smithers/.specs/engineering/tickets/T-GH-09.md:14 — Outbound recovery depends on accepted-generation receipts excluded by T-STK-12 — The dependency cannot supply the contract required to enable GitHub writes.
- [FIX] /Users/williamcory/smithers/.specs/engineering/tickets/T-FLW-11.md:59 — Separate verify/review launches remain prescribed while reconciliation with the product’s one durable run is deferred — J2 has incompatible execution contracts.
- [FIX] /Users/williamcory/smithers/.specs/engineering/tickets/T-STK-09.md:60 — Outsider-edit coverage requires label reversion without limiting the edit to before admission — It can demand reversion after the TODO’s prompt revision is frozen.
- [FIX] /Users/williamcory/smithers/.specs/engineering/tickets/T-DOC-02.md:15 — The ADR ticket assigns one machine per branch without exempting main — It propagates the contradiction with the product vocabulary.
- [FIX] /Users/williamcory/smithers/.specs/engineering/delta.md:164 — Cutover deletes HomeContainer and replaces RunTraceCard while card-kinds.md retains both — Implementers receive incompatible ownership and deletion instructions.

## cycle 105 · 20261004T101011 · focus engineering · main 641a30708f19
- [FIX] /Users/williamcory/smithers/.specs/engineering/overview.md:12 — Every branch receives exactly one machine without exempting main — This contradicts the product’s machine-free team home.
- [FIX] /Users/williamcory/smithers/.specs/engineering/tickets/T-STK-12.md:60 — The ready-stamped ticket retains acceptance cases it acknowledges require removed generation receipts — Its implementation cannot satisfy the declared qualification contract.

## cycle 106 · 20261004T101705 · focus design · main 2b969bdc1348
- [FIX] /Users/williamcory/smithers/.specs/design/mock/src/cards/Confirm.tsx:22 — Merge eligibility excludes running checks but does not reject failed checks or absent evidence — The mock enables Merge in states its own revision-bound evidence contract forbids.
- [FIX] /Users/williamcory/smithers/.specs/design/mock/src/journeys/j2.ts:178 — The TODO Merge press directly marks the item merged without opening Review & merge — J2 contradicts the design’s prescribed personal confirmation card.
- [FIX] /Users/williamcory/smithers/.specs/design/mock/src/cards/Confirm.tsx:42 — The stale-approval message contains more than twelve words — The reference card violates the design’s card-line limit.
- [FIX] /Users/williamcory/smithers/.specs/engineering/ui-components.md:438 — Flow version selection explicitly uses React local state without a view patch — Porting that contract violates persisted card selection.
- [FIX] /Users/williamcory/smithers/.specs/engineering/tickets/T-FLW-11.md:59 — Separate verify/review launches remain prescribed while reconciliation with one durable run is deferred — J2 retains incompatible execution contracts.

## cycle 107 · 20261004T102324 · focus tickets · main 2b969bdc1348
- [FIX] /Users/williamcory/smithers/.specs/engineering/tickets/T-STK-12.md:60 — The Ready ticket retains required acceptance cases it acknowledges depend on removed generation receipts — Its implementation cannot satisfy its declared qualification contract.
- [FIX] /Users/williamcory/smithers/.specs/engineering/tickets/T-GH-09.md:14 — Outbound recovery requires accepted-generation receipts that T-STK-12 explicitly excludes — The declared provider cannot supply the contract needed to enable GitHub writes.
- [FIX] /Users/williamcory/smithers/.specs/engineering/tickets/T-FLW-11.md:59 — The ticket retains separate verify/review launches while postponing reconciliation with the product’s one durable run — J2 implementers receive incompatible execution contracts.
- [FIX] /Users/williamcory/smithers/.specs/engineering/tickets/T-STK-09.md:60 — Outsider-edit coverage requires label reversion without restricting the edit to before admission — The test can require reversing an already frozen TODO admission.
- [FIX] /Users/williamcory/smithers/.specs/engineering/tickets/T-DOC-02.md:15 — The ADR ticket assigns one machine per branch without exempting main — It contradicts the product’s machine-free main.
- [FIX] /Users/williamcory/smithers/.specs/engineering/tickets/T-PRC-03.md:19 — The closure recorder excludes reference-host execution support — Required authenticated Mac qualification evidence has no supported recording path.
- [FIX] /Users/williamcory/smithers/.specs/engineering/delta.md:164 — Cutover deletes HomeContainer and replaces RunTraceCard while card-kinds.md retains both — Implementers receive contradictory component ownership and deletion instructions.
- [FIX] /Users/williamcory/smithers/.specs/engineering/ui-components.md:438 — Flow version selection uses React local state and emits no view patch — The contract violates persisted card selection.

## cycle 108 · 20261004T103007 · focus product · main 2c6101e04368
- [FIX] /Users/williamcory/smithers/.specs/product/overview.md:44 — The overview assigns every branch exactly one live machine without exempting main — It contradicts mvp.md’s machine-free main.
- [FIX] /Users/williamcory/smithers/.specs/engineering/ui-components.md:438 — Flow version selection explicitly uses React local state without emitting a view patch — The implementation contract violates persisted card selection.
- [FIX] /Users/williamcory/smithers/.specs/engineering/tickets/T-FLW-11.md:59 — Separate verify/review launches remain prescribed while reconciliation with one durable TODO run is deferred — J2 and Appendix B.5 specify an incompatible execution contract.
- [FIX] /Users/williamcory/smithers/.specs/engineering/tickets/T-PRC-03.md:16 — MANUAL checks require approved CI evidence and reject an owner signature alone — The ticket contradicts AGENTS.md’s owner-signed manual receipt contract.

## cycle 109 · 20261004T103648 · focus engineering · main 8acb6d421011
- [FIX] /Users/williamcory/smithers/.specs/engineering/overview.md:12 — Every branch receives exactly one machine without exempting main — The architecture contradicts the product’s machine-free team home.
- [FIX] /Users/williamcory/smithers/.specs/engineering/delta.md:164 — Cutover folds HomeContainer away and replaces RunTraceCard while card-kinds.md retains both — Implementers receive incompatible component ownership and deletion instructions.
- [FIX] /Users/williamcory/smithers/.specs/engineering/tickets/T-FLW-11.md:59 — Separate verify/review launches remain prescribed while reconciliation with one durable TODO run is deferred — J2 retains incompatible execution contracts.

## cycle 110 · 20261004T104327 · focus design · main e0069362e54e
- [FIX] /Users/williamcory/smithers/.specs/design/mock/src/cards/Confirm.tsx:22 — Merge eligibility excludes running checks but does not reject failed checks or absent evidence — The reference enables Merge without its required passing revision-bound evidence.
- [FIX] /Users/williamcory/smithers/.specs/design/mock/src/journeys/j2.ts:156 — The TODO Merge press directly marks the item merged without opening Review & merge — J2 contradicts the design’s required personal confirmation card.
- [FIX] /Users/williamcory/smithers/.specs/design/mock/src/AppFrame.tsx:179 — Event entries are excluded from the transcript while timeline jumps search it for their `data-entry` targets — Event rows and event edge pills cannot navigate to their advertised destination.
- [FIX] /Users/williamcory/smithers/.specs/design/mock/src/Rail.tsx:2 — Rail’s contract says there are no toast notifications while the design README prescribes bottom-left notifications — Implementers receive contradictory notification instructions.

## cycle 111 · 20261004T105029 · focus tickets · main 1ba34fb5c57c
- [FIX] /Users/williamcory/smithers/.specs/engineering/tickets/T-STK-05.md:40 — T-STK-05 prescribes extracting `mythical_items.yaml` while T-STK-06 explicitly forbids creating that OpenAPI source — Parallel implementations receive incompatible ownership instructions for the same TODO API.
- [FIX] /Users/williamcory/smithers/.specs/engineering/tickets/T-STK-05.md:37 — TODO controls require a single run and deletion of verify-run overwrites while T-FLW-11 retains separate verify and review launches — Stop, Resume and Retry lack a consistent execution contract.
- [FIX] /Users/williamcory/smithers/.specs/engineering/tickets/T-STK-12.md:60 — The Ready ticket retains acceptance cases it acknowledges depend on removed generation receipts — Its prescribed implementation cannot satisfy its declared qualification contract.
- [FIX] /Users/williamcory/smithers/.specs/engineering/tickets/T-GH-09.md:14 — Outbound recovery requires accepted-generation receipts explicitly excluded by T-STK-12 — Its declared provider cannot supply the contract needed to enable GitHub writes.
- [FIX] /Users/williamcory/smithers/.specs/engineering/tickets/T-STK-09.md:60 — Outsider-edit coverage requires label reversion without restricting the edit to before admission — The test can demand reversal after revision 1 has frozen.
- [FIX] /Users/williamcory/smithers/.specs/engineering/tickets/T-PRC-03.md:19 — The closure recorder excludes reference-host execution support — Required authenticated Mac qualification evidence lacks a compatible recording path.
- [FIX] /Users/williamcory/smithers/.specs/engineering/tickets/T-FLW-11.md:59 — Separate verify and review launches remain prescribed while reconciliation with one durable TODO run is deferred — J2 retains incompatible execution contracts.

## cycle 112 · 20261004T105740 · focus product · main 24e794f2d323
- [FIX] /Users/williamcory/smithers/.specs/product/overview.md:44 — Every branch receives exactly one machine without exempting main — This contradicts mvp.md’s machine-free main.
- [FIX] /Users/williamcory/smithers/.specs/engineering/tickets/T-STK-05.md:40 — T-STK-05 prescribes extracting `mythical_items.yaml` while T-STK-06 forbids creating that OpenAPI source — Parallel implementations receive incompatible ownership instructions.
- [FIX] /Users/williamcory/smithers/.specs/engineering/tickets/T-FLW-11.md:24 — Separate engine verify and review launches remain prescribed alongside the single TODO composition — J2 and Appendix B.5 require verification and review inside the same durable TODO run.
- [FIX] /Users/williamcory/smithers/.specs/engineering/tickets/T-GH-09.md:14 — Outbound recovery requires accepted-generation receipts excluded by T-STK-12 — The declared provider cannot supply the contract needed to enable GitHub writes.
- [FIX] /Users/williamcory/smithers/.specs/engineering/tickets/T-STK-12.md:60 — The Ready ticket retains acceptance cases it acknowledges depend on removed generation receipts — Its implementation cannot satisfy its declared qualification contract.
- [FIX] /Users/williamcory/smithers/.specs/engineering/delta.md:164 — Cutover folds HomeContainer away and replaces RunTraceCard while card-kinds.md retains both — Implementers receive incompatible ownership and deletion instructions.
- [FIX] /Users/williamcory/smithers/.specs/engineering/ui-components.md:438 — Flow version selection explicitly uses React local state without emitting a view patch — The contract violates persisted card selection.

## cycle 113 · 20261004T110452 · focus engineering · main bdd9ec567239
- [FIX] /Users/williamcory/smithers/.specs/engineering/delta.md:46 — The assembler row excludes bundled PostgreSQL while T-INS-01 and spec.md require it — J1 implementers receive incompatible bundle layouts.
- [FIX] /Users/williamcory/smithers/.specs/engineering/tickets/T-STK-05.md:40 — T-STK-05 prescribes extracting `mythical_items.yaml` while T-STK-06 forbids creating that source — Parallel implementations receive incompatible API ownership instructions.
- [FIX] /Users/williamcory/smithers/.specs/engineering/tickets/T-GH-09.md:14 — Outbound recovery requires accepted-generation receipts excluded by T-STK-12 — Its declared provider cannot supply the contract required to enable GitHub writes.

## cycle 114 · 20261004T111230 · focus design · main 3815000bb5c2
- [FIX] /Users/williamcory/smithers/.specs/design/mock/src/cards/Confirm.tsx:22 — Merge eligibility checks running states but permits failed checks or absent evidence — The reference enables merging without passing revision-bound evidence.
- [FIX] /Users/williamcory/smithers/.specs/design/mock/src/journeys/j2.ts:156 — The TODO Merge press directly marks the item merged without opening Review & merge — J2 bypasses the prescribed personal confirmation.
- [FIX] /Users/williamcory/smithers/.specs/design/mock/src/cards/Confirm.tsx:42 — The stale-approval message contains sixteen words — The reference violates its twelve-word card-line limit.
- [FIX] /Users/williamcory/smithers/.specs/design/mock/src/AppFrame.tsx:153 — Event entries are omitted from transcript elements carrying timeline jump targets — Event timeline rows cannot navigate to their advertised destinations.
- [FIX] /Users/williamcory/smithers/.specs/design/mock/src/Rail.tsx:2 — Rail forbids toast notifications while the design README requires bottom-left notifications — Implementers receive contradictory notification contracts.
- [FIX] /Users/williamcory/smithers/.specs/engineering/card-kinds.md:11 — T-APP-19 deletes Proposal schemas that T-FLW-06 explicitly retains and the learning landing imports — Parallel migrations can break the newly landed container.
- [FIX] /Users/williamcory/smithers/.specs/engineering/ui-components.md:438 — Flow version selection explicitly uses React local state without a view patch — The contract prevents durable per-person selection.
- [FIX] /Users/williamcory/smithers/.specs/engineering/delta.md:164 — Cutover deletes HomeContainer and replaces RunTraceCard while card-kinds.md retains both — The mounting instructions disagree about component ownership and deletion.

## cycle 115 · 20261004T111906 · focus tickets · main 6451c97b21fd
- [FIX] /Users/williamcory/smithers/.specs/engineering/tickets/T-STK-05.md:40 — T-STK-05 requires extracting `mythical_items.yaml` while T-STK-06 forbids creating it — Parallel API migrations receive incompatible ownership instructions.
- [FIX] /Users/williamcory/smithers/.specs/engineering/tickets/T-STK-05.md:37 — T-STK-05 requires one TODO run and removal of verify-run overwrites while T-FLW-11 retains separate engine launches — Control implementers lack a consistent attempt execution contract.
- [FIX] /Users/williamcory/smithers/.specs/engineering/tickets/T-GH-09.md:14 — Outbound recovery requires accepted-generation receipts explicitly excluded by T-STK-12 — Its named provider cannot supply the contract required to enable writes.
- [FIX] /Users/williamcory/smithers/.specs/engineering/tickets/T-STK-12.md:60 — The Ready ticket retains qualification cases it acknowledges require removed generation receipts — Its implementation cannot satisfy its declared completion contract.
- [FIX] /Users/williamcory/smithers/.specs/engineering/tickets/T-STK-09.md:60 — Outsider-edit coverage requires label reversion without restricting the edit to before admission — The test can demand reversal after the admitted prompt revision freezes.
- [FIX] /Users/williamcory/smithers/.specs/engineering/tickets/T-PRC-03.md:19 — The recorder excludes reference-host execution support — Required authenticated Mac qualification evidence lacks a supported recording path.
- [FIX] /Users/williamcory/smithers/.specs/engineering/tickets/T-DOC-02.md:15 — E-03 assigns one machine per branch without exempting main — It contradicts the product’s machine-free main.

## cycle 116 · 20261004T112628 · focus product · main b77f8a22bf37
- [FIX] /Users/williamcory/smithers/.specs/product/overview.md:44 — The overview gives every branch exactly one live machine without exempting main — It contradicts mvp.md’s machine-free team home.
- [FIX] /Users/williamcory/smithers/.specs/engineering/tickets/T-STK-05.md:40 — T-STK-05 requires extracting `mythical_items.yaml` while T-STK-06 forbids creating it — Parallel TODO API migrations receive incompatible source ownership instructions.
- [FIX] /Users/williamcory/smithers/.specs/engineering/tickets/T-FLW-11.md:24 — Verification and review remain separate engine launches despite mvp.md Appendix B.5 requiring steps inside one durable TODO run — J2 and lifecycle controls lack a consistent execution contract.
- [FIX] /Users/williamcory/smithers/.specs/engineering/tickets/T-GH-09.md:14 — Outbound recovery requires accepted-generation receipts explicitly excluded by T-STK-12 — Its named provider cannot supply the contract required to enable GitHub writes.
- [FIX] /Users/williamcory/smithers/.specs/engineering/tickets/T-STK-12.md:60 — The Ready ticket retains required qualification cases it acknowledges depend on removed generation receipts — Completion requires an unresolved change to its acceptance contract.

## cycle 117 · 20261004T113413 · focus engineering · main bbd50216ee49
- [FIX] /Users/williamcory/smithers/.specs/engineering/delta.md:46 — The assembler excludes bundled PostgreSQL while overview.md E-01 requires copying PostgreSQL into the bundle — J1 implementers receive incompatible installation layouts.
- [FIX] /Users/williamcory/smithers/.specs/engineering/delta.md:164 — Cutover removes HomeContainer and replaces RunTraceCard while card-kinds.md retains both — Mounting instructions disagree about component ownership and deletion.
- [FIX] /Users/williamcory/smithers/.specs/engineering/ui-components.md:438 — Flow version selection uses React local state and emits no view patch — The contract violates durable card selection.
- [FIX] /Users/williamcory/smithers/.specs/engineering/tickets/T-STK-05.md:40 — T-STK-05 requires extracting mythical_items.yaml while T-STK-06 forbids creating it — Parallel TODO API migrations receive incompatible ownership instructions.
- [FIX] /Users/williamcory/smithers/.specs/engineering/tickets/T-FLW-11.md:24 — Verification and review remain separate engine launches alongside the single TODO composition — J2 lifecycle controls lack the product’s consistent durable-run contract.
- [FIX] /Users/williamcory/smithers/.specs/engineering/tickets/T-STK-12.md:60 — The Ready ticket retains qualification cases it acknowledges require removed generation receipts — Completion depends on an unresolved acceptance-contract change.

## cycle 118 · 20261004T114059 · focus design · main 9e9493943c19
- [FIX] /Users/williamcory/smithers/.specs/design/mock/src/cards/Confirm.tsx:22 — Merge eligibility permits absent evidence and failed local checks when GitHub totals match — The reference enables merging without its required passing revision-bound evidence.
- [FIX] /Users/williamcory/smithers/.specs/design/mock/src/AppFrame.tsx:153 — Event entries are excluded from transcript elements carrying timeline jump targets — Event timeline navigation cannot reach its advertised destination.
- [FIX] /Users/williamcory/smithers/.specs/design/mock/src/cards/Confirm.tsx:42 — The stale-approval message exceeds twelve words — The reference violates its own card-line limit.
- [FIX] /Users/williamcory/smithers/.specs/engineering/ui-components.md:438 — Flow version selection explicitly uses React local state without emitting a view patch — The contract violates durable card selection.

## cycle 119 · 20261004T114738 · focus tickets · main e37325545f11
- [FIX] /Users/williamcory/smithers/.specs/engineering/tickets/T-STK-05.md:40 — T-STK-05 requires extracting mythical_items.yaml while T-STK-06 explicitly forbids creating it — Concurrent implementers receive incompatible API ownership instructions.
- [FIX] /Users/williamcory/smithers/.specs/engineering/tickets/T-GH-09.md:14 — Outbound recovery requires accepted-generation receipts that T-STK-12 excludes — Its declared dependency cannot supply the authority needed to enable GitHub writes.
- [FIX] /Users/williamcory/smithers/.specs/engineering/tickets/T-STK-12.md:60 — The Ready ticket retains required qualification cases it acknowledges depend on removed generation receipts — Its implementation cannot satisfy its declared completion contract.
- [FIX] /Users/williamcory/smithers/.specs/engineering/tickets/T-FLW-11.md:59 — Separate verification and review launches remain prescribed while reconciliation with the product’s one durable run is postponed — J2 retains incompatible execution contracts.
- [FIX] /Users/williamcory/smithers/.specs/engineering/tickets/T-STK-09.md:60 — Outsider-edit coverage requires label reversion without restricting the edit to before admission — The test can demand reversal after revision 1 is frozen.
- [FIX] /Users/williamcory/smithers/.specs/engineering/tickets/T-PRC-03.md:19 — The closure recorder excludes reference-host execution support — Required authenticated Mac qualification evidence lacks a supported recording path.
- [FIX] /Users/williamcory/smithers/.specs/engineering/tickets/T-DOC-02.md:15 — The ADR ticket assigns one machine per branch without exempting main — It contradicts the product’s machine-free team home.
- [FIX] /Users/williamcory/smithers/.specs/engineering/ui-components.md:437 — Flow version selection explicitly uses React local state without emitting a view patch — The contract violates durable card selection.
- [FIX] /Users/williamcory/smithers/.specs/engineering/delta.md:164 — Cutover deletes HomeContainer and replaces RunTraceCard while card-kinds.md retains both — Implementers receive incompatible component ownership instructions.

## cycle 120 · 20261004T115448 · focus product · main 3ef6808f1b2e
- [FIX] /Users/williamcory/smithers/.specs/product/overview.md:44 — The overview assigns every branch exactly one live machine without exempting main — It contradicts mvp.md’s machine-free team home.
- [FIX] /Users/williamcory/smithers/.specs/engineering/tickets/T-FLW-11.md:59 — Separate verify and review launches remain prescribed while product reconciliation is deferred — J2 and Appendix B.5 require verification and review inside one durable TODO run.
- [FIX] /Users/williamcory/smithers/.specs/engineering/tickets/T-PRC-03.md:19 — Reference-host execution support remains excluded — Required authenticated Mac qualification evidence lacks a supported recording path.
- [FIX] /Users/williamcory/smithers/.specs/engineering/ui-components.md:438 — Flow version selection explicitly uses React local state without emitting a view patch — The component contract violates durable card selection.
- [FIX] /Users/williamcory/smithers/.specs/engineering/delta.md:164 — Cutover folds HomeContainer away and replaces RunTraceCard while card-kinds.md retains both — Implementers receive incompatible component ownership instructions.
