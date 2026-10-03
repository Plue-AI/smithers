# T-PRC-01 Declared-input existence in //:targetIndex and the drift set at landing

Stage S1 · Size S · Depends on — · Unblocks T-REL-02 · Issue: [#3613](https://github.com/smithersai/smithers/issues/3613)
Spec: spec.md §21.2 · Delta: delta.md (engineering process) · Product: mvp.md §12.1 (acceptance evidence) · Owner: smithers-38 + smithers-22

## Goal

Declared inputs must exist when `//:targetIndex` resolves `Smithers.file()`, `paths:` and `workflows:` declarations, including supported globs and brace expansion. Actionlint discovers workflows from `.github/workflows`. Landing runs `smthrs lint '//:driftCi' '//:targetIndex' '//:ci' '//scripts:trackedHygiene' '//scripts:conflictMarkers'` locally and refuses push on failure. The per-SHA, non-cancelling drift status is required on main and includes `//:ci`; the long CI remains advisory until its existing repair is green.

## Ownership

Owners: smithers-22 (landing gate) and smithers-38 (`@smthrs/targets`, build-cli; reviews the diff before it lands). Gate test: rename one declared path to a missing file and assert `smthrs lint //:targetIndex` exits non-zero.

## Scope

In:
- `packages/smithers/build/targets/src/Input.ts` and index builder: resolve file, paths and workflows declarations with workspace glob, brace-expansion and ignore rules; fail with a typed error that names each absent declared path and its PACKAGE.ts line.
- `PACKAGE.ts`: `Actionlint({workflows})` takes its list from the declared `workflows:` set (not a directory listing), and the target index declares those inputs, so the result is cache-correct; repair missing declarations in owning PACKAGE.ts files (smithers-3f pre-reviews the six fixes).
- `scripts/commit.mjs`, LAND.md and the landing script: execute the five-target drift set before push and preserve rejection output.
- `.github/workflows/drift.yml`: include //:ci, keep per-SHA non-cancelling concurrency and require this status on main.

Out:
- Product runtime behavior and unrelated repairs.

## Changes

- `packages/smithers/build/targets/src/Input.ts` and index builder: resolve file, paths and workflows declarations with workspace glob, brace-expansion and ignore rules; fail with a typed error that names each absent declared path and its PACKAGE.ts line.
- `PACKAGE.ts`: `Actionlint({workflows})` takes its list from the declared `workflows:` set (not a directory listing), and the target index declares those inputs, so the result is cache-correct; repair missing declarations in owning PACKAGE.ts files (smithers-3f pre-reviews the six fixes).
- `scripts/commit.mjs`, LAND.md and the landing script: execute the five-target drift set before push and preserve rejection output.
- `.github/workflows/drift.yml`: include //:ci, keep per-SHA non-cancelling concurrency and require this status on main.

## Tests

- integration: `scripts/check-process-gates.test.mjs` implements C-PRC-01 with positive and refusal fixtures.

## Acceptance

- [C-PRC-01](../checks/C-PRC-01.md): every Pass when assertion holds.

## Risks and notes

- Do not gate landing on the long CI job. Keep existing repair ownership for unrelated reds.
