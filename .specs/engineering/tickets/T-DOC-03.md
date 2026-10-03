# T-DOC-03 Replace `docs/mvp/*` with the approved specs (M-12)

Stage R · Size S · Depends on — · Unblocks T-MNT-05 · Issue: [#3591](https://github.com/smithersai/smithers/issues/3591)
Spec: none (process; spec.md is one of the approved documents) · Delta: delta.md §10 (Reshape [R] docs row) · Product: mvp.md M-12, §13 (reconcile standing strategy)
Ready: 2026-10-03 smithers-8a sha256:15d816f20ff3

## Goal
`docs/mvp/` holds no requirement, design or engineering text that competes with `.specs/`, and no file in the repository links to a page this change removes.

## Scope
Lands dark until T-CUT-01: retain each registration page or asset while a current inbound reference remains; land only independent link repairs and tests. Report surviving cut references to smithers-8a for the cut owner to resolve. T-CUT-01 is a landing condition, not a code/schema dependency. Before Will approves engineering and design, retain both superseded banners and their contents; do not publish pointer-only replacements. C-REL-01 tests both blocked states and the approved, reference-free state.

Already on `main` (`0688fd5980`, 2026-10-02): `docs/mvp/PRODUCT.md` is a superseded index of the decision IDs code still cites (D-16 at `:23`), and `AGENTS.md:3-9` names `.specs/product/` as the product contract. This ticket finishes the rest.

In:
- `docs/mvp/ENGINEERING.md` (317 lines) and `docs/mvp/DESIGN.md` (240 lines) carry a "Superseded" banner over the five-job content. Once Will approves `.specs/engineering/` and `.specs/design/`, each becomes a short pointer page like `PRODUCT.md`: the replacement links and the decision IDs code still cites, nothing else. The old text stays reachable through history links, as `PRODUCT.md:9` does.
- `docs/mvp/REGISTRATION.md`, `docs/mvp/research/registration-*` and `docs/mvp/mockups/` describe cut registration and five-job surfaces (mvp.md §8). Delete each only after scanning current repository references, including Markdown links, source comments and asset paths. Current surviving source references include `flows/register-repository/flow.ts:3`, `flows/register-repository/calibration/generate.ts:4`, `flows/register-repository/calibration/select.ts:3`, `packages/rpc/src/Cards.ts:1875` and `apps/app/src/mainview/state/ApprovalDeciders.ts:4`. Registration cards, `RegistrationStatus.tsx`, the registration controller and `flows/entries/repository.ts` are already absent. Removing cut producers belongs to the cut owner; preserve persisted-card decoding. A surviving reference blocks deletion of its target, not independent work here.
- `docs/mvp/implementation/release-20260916.md` stays: `scripts/check-release-evidence-tags.mjs:5,49` reads it. The rest of `docs/mvp/implementation/` stays as dated evidence unless nothing reads it.
- `docs/mvp/retired-chat-integrations.md`: kept or deleted by the same rule (an inbound reference keeps it).
- Inbound links updated in the same change: `docs/design/shared-workspace-layers.md:278`, `apps/site/docs/UI-DOCS.md:20`, and any remaining link to a deleted file.

Out:
- `AGENTS.md` scope text (landed; further edits belong to T-CUT-01 with Will's sign-off, delta.md §11).
- Moving `.specs/` elsewhere: `AGENTS.md:3-9` fixes `.specs/` as the location.
- Public docs (T-DOC-01); ADR 0002 (T-DOC-02).
- Runtime cuts, card schemas/decoders, registration flows and app UI; replacing docs does not authorize deleting runtime code.
- Normative product, engineering and design edits; new docs pipelines, deployment, mockup regeneration and execution of historical evidence commands.

## Changes
- `docs/mvp/ENGINEERING.md`, `docs/mvp/DESIGN.md` → pointer pages.
- Deletions listed above, each with its inbound references already gone.
- `docs/design/shared-workspace-layers.md`, `apps/site/docs/UI-DOCS.md` → links to `.specs/`.
- Reuse `scripts/mvp-docs.test.mjs` and `//scripts:mvpDocs` (`scripts/PACKAGE.ts:303–318`); extend the existing link fixtures and declare every added document/source scan input in the target. No new test runner or docs pipeline.
- Run `pnpm docs:sync` and `pnpm docs:check`; `smthrs lint //apps/site:supportDocs` because `apps/site/docs/` changes. Edit owning sources and regenerate projections only through existing scripts.

## Tests
- Unit, existing `scripts/mvp-docs.test.mjs`, through `smthrs test //scripts:mvpDocs` (C-REL-01 R repository assertions folded into T-DOC-01): every relative Markdown link in `AGENTS.md`, `docs/**/*.md` and `apps/site/docs/**` resolves; `docs/mvp/` contains only pointer pages and retained evidence with recorded inbound references; every decision ID cited in `apps/`, `packages/` and `flows/` has a row in `PRODUCT.md`. Read documents and source references as input data, never as the oracle for expected behavior. Pin approved replacement destinations, retained evidence paths and decision-index assertions as literal test expectations; do not import spec files or production code to generate them.
- Extend existing temporary-directory fixtures: a surviving source comment, Markdown link or asset path blocks deletion; a missing approval preserves banner/content; approved pointer pages preserve cited IDs and history links; missing files/fragments fail independently. Exercise the same scanner/assertions used on real repository files, with literal expected diagnostics.
- Production docs gates: `pnpm docs:check` and `smthrs lint //apps/site:supportDocs` exit zero after existing sync commands. These drift gates do not replace the repository link/content tests or Will's approval receipt.

## Acceptance
- [C-REL-01](../checks/C-REL-01.md): no link to a removed `docs/mvp` page; the pointer pages name only the approved specs; docs gates pass.

## Risks and notes
- Re-scan references before each deletion; old file counts are not evidence. `RegistrationCard.tsx` and `repositorySetup.test.ts` are already absent. The Markdown-link checker alone cannot detect source-comment and asset-path references.
- Will approves the engineering/design replacements and resolves product conflicts. smithers-8a records approval references/dates, approves evidence retention/deletion inventories and resolves stale cut ownership; an unread file is deleted only after that inventory review. smithers-b8 approves site-source link changes; smithers-38 approves the test-target input contract. Existing owner answers stand; owners review the draft post hoc.
- The approval gate: the pointer pages land only after Will approves the engineering and design specs (M-12). Until then the banners stay.
- Security: all repository tests, generators and docs commands run unprivileged inside a machine, with no sudo, host execution or historical-command replay (§17.3, M-29). No root step is introduced, so there are no root-consumed main or branch inputs. smithers-3f reviews this execution boundary; if machine execution is unavailable, do not run the commands.

## Ready checklist
1. Dependencies: no code/schema call to T-CUT-01; Depends on is empty. Scope keeps referenced targets and unapproved contents intact while independent repairs/tests land dark.
2. Exclusions: runtime cuts/decoders, UI, public docs, ADRs, normative specs, new pipelines, deployment and historical-command execution are explicit.
3. Tests: extend existing //scripts:mvpDocs at its declared boundary and run production docs gates; literal expectations and failure fixtures cover references, approvals, pointers and evidence without a spec/code-derived oracle (C-REL-01).
4. Decisions: Will approves replacements/product conflicts; smithers-8a records approval and decides evidence inventories/cut ownership; smithers-b8 approves site links; smithers-38 approves target inputs.
5. Owner pre-review before implementation (existing answers stand; draft review is post hoc): smithers-b8: Do site links point to retained approved sources? Does this change avoid app/runtime cuts? smithers-38: Does //scripts:mvpDocs declare all scan inputs? Are literal failure fixtures independent of spec/production expectations? smithers-3f: Do every test and generator run unprivileged inside a machine with no root or host fallback?
6. Security: repository execution is machine-only and unprivileged, reviewed by smithers-3f; no root step or root-consumed input exists. Unavailable machine execution blocks commands, not the documentation draft.
