# T-DOC-03 Replace `docs/mvp/*` with the approved specs (M-12)

Stage R · Size S · Depends on T-CUT-01 · Unblocks — · Issue: to file
Spec: none (process; spec.md is one of the approved documents) · Delta: delta.md §10 (Replace row) · Product: mvp.md M-12, §13 (reconcile standing strategy)

## Goal
`docs/mvp/` holds no requirement, design or engineering text that competes with `.specs/`, and no file in the repository links to a page this change removes.

## Scope
Already on `main` (`0688fd5980`, 2026-10-02): `docs/mvp/PRODUCT.md` is a superseded index of the decision IDs code still cites (D-16 at `:23`), and `AGENTS.md:3-9` names `.specs/product/` as the product contract. This ticket finishes the rest.

In:
- `docs/mvp/ENGINEERING.md` (317 lines) and `docs/mvp/DESIGN.md` (240 lines) carry a "Superseded" banner over the five-job content. Once Will approves `.specs/engineering/` and `.specs/design/`, each becomes a short pointer page like `PRODUCT.md`: the replacement links and the decision IDs code still cites, nothing else. The old text stays reachable through history links, as `PRODUCT.md:9` does.
- `docs/mvp/REGISTRATION.md`, `docs/mvp/research/registration-*` and `docs/mvp/mockups/` describe the cut registration and five-job surfaces (mvp.md §8). Delete them once their only inbound references are gone: `flows/register-repository/*`, `packages/rpc/src/Cards.ts:1855`, `apps/app/src/mainview/cards/Registration*`, `apps/app/src/mainview/RegistrationStatus.tsx:8`, `apps/app/src/mainview/state/ApprovalDeciders.ts:4`, `apps/app/src/mainview/state/controller/registration.ts:2`, `apps/app/src/mainview/flows/entries/repository.ts:3`, all deleted or edited by T-CUT-01. If any reference survives T-CUT-01, it is a T-CUT-01 defect, not a reason to keep the page.
- `docs/mvp/implementation/release-20260916.md` stays: `scripts/check-release-evidence-tags.mjs:5,49` reads it. The rest of `docs/mvp/implementation/` stays as dated evidence unless nothing reads it.
- `docs/mvp/retired-chat-integrations.md`: kept or deleted by the same rule (an inbound reference keeps it).
- Inbound links updated in the same change: `docs/design/shared-workspace-layers.md:278`, `apps/site/docs/UI-DOCS.md:20`, and any remaining link to a deleted file.

Out:
- `AGENTS.md` scope text (landed; further edits belong to T-CUT-01 with Will's sign-off, delta.md §11).
- Moving `.specs/` elsewhere: `AGENTS.md:3-9` fixes `.specs/` as the location.
- Public docs (T-DOC-01); ADR 0002 (T-DOC-02).

## Changes
- `docs/mvp/ENGINEERING.md`, `docs/mvp/DESIGN.md` → pointer pages.
- Deletions listed above, each with its inbound references already gone.
- `docs/design/shared-workspace-layers.md`, `apps/site/docs/UI-DOCS.md` → links to `.specs/`.
- Run `pnpm docs:sync` and `pnpm docs:check`; `smthrs lint //apps/site:supportDocs` because `apps/site/docs/` changes.

## Tests
- unit `scripts/mvp-docs.test.mjs` (new, shared with T-DOC-02 and C-REL-01): every relative Markdown link in `AGENTS.md`, `docs/**/*.md` and `apps/site/docs/**` resolves; `docs/mvp/` contains only the pointer pages and the evidence files that something reads; every decision ID cited in source (`rg "D-[0-9]+[a-z]?"` over `apps/`, `packages/`, `flows/`) has a row in `docs/mvp/PRODUCT.md`.

## Acceptance
- [C-REL-01](../checks/C-REL-01.md): no link to a removed `docs/mvp` page; the pointer pages name only the approved specs; docs gates pass.

## Risks and notes
- Deleting `REGISTRATION.md` and the registration research needs T-CUT-01 first, since twelve source files cite them. Observation: the link test fails on `apps/app/src/mainview/cards/RegistrationCard.tsx:2` if T-CUT-01 has not landed.
- `apps/app/src/mainview/state/controller/repositorySetup.test.ts:2203` cites `docs/mvp/ENGINEERING.md`; T-CUT-01 deletes the file with the five-job setup.
- The approval gate: the pointer pages land only after Will approves the engineering and design specs (M-12). Until then the banners stay.
