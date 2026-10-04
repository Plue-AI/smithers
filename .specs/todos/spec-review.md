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
