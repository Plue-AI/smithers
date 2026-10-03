# T-PRC-01 Declared-input existence in //:targetIndex and the drift set at landing

Stage S1 · Size S · Depends on — · Unblocks T-REL-02 · Issue: [#3613](https://github.com/smithersai/smithers/issues/3613)
Spec: spec.md §21.2 · Delta: delta.md (engineering process) · Product: mvp.md §12.1 (acceptance evidence) · Owner: smithers-38 + smithers-22
Ready: 2026-10-02 smithers-8a sha256:9f5227535ccf

## Goal

Declared inputs must exist when `//:targetIndex` resolves `Smithers.file()`, `paths:` and `workflows:` declarations, including supported globs and brace expansion. Actionlint already takes a declared workflow list; validate that list. Check: C-PRC-01. Landing runs `smthrs lint '//:driftCi' '//:targetIndex' '//:ci' '//scripts:trackedHygiene' '//scripts:conflictMarkers'` locally and refuses push on failure. The per-SHA, non-cancelling drift status is required on main and includes `//:ci`; the long CI remains advisory until its existing repair is green.

## Ownership

Owners: smithers-22 (landing gate) and smithers-38 (`@smthrs/targets`, build-cli). smithers-38 pre-reviews before start and signs off public exports under §21.1; smithers-3f approves CI and branch-protection configuration; smithers-22 accepts landing-gate coverage; smithers-8a resolves seam ownership. Gate test: rename one declared path to a missing file and assert `smthrs lint //:targetIndex` exits non-zero. Required-status configuration needs repository-admin access before activation; enable enforcement only after the updated drift job passes on a clean commit.

## Scope

In:
- `packages/smithers/build/build-cli/src/internal/PackagePlanner.ts`: put the existence gate in the TargetIndex check executor at `withTargetIndex`, using existing `Input.expandGlob` and `Input.digestFile` for file, paths and workflows declarations. Preserve glob, brace-expansion and ignore rules. The typed error names each absent declared path, its target label and `metadata.sourceFile`. Do not require a PACKAGE.ts line or export private SourceSite metadata. Check: C-PRC-01.
- `PACKAGE.ts`: `Actionlint({workflows})` takes its list from the declared `workflows:` set (not a directory listing), and the target index declares those inputs, so the result is cache-correct; repair missing declarations in owning PACKAGE.ts files (inventory the current missing declarations; smithers-3f pre-reviews infrastructure fixes).
- `scripts/commit.mjs` (existing production landing entry point) and LAND.md (new): execute the five-target drift set before either VCS push path and preserve rejection output.
- `PACKAGE.ts` owns the generated `.github/workflows/drift.yml`: add //:ci there and regenerate the workflow; retain per-SHA non-cancelling concurrency. smithers-3f verifies the required-status setting on main after a clean per-SHA run.

Out:
- Product runtime behavior, long-CI repair or required-status promotion, changes to Input.ts, public planner semantics or Metadata exports, new input syntax or glob semantics, ignoring missing declarations, and blanket known-red exemptions. No new landing command replaces the existing commit entry point.

## Changes

- Declare `//scripts:trackedHygiene` in `scripts/PACKAGE.ts` with the tracked temporary-path leakage checker and its declared inputs. The five-target landing set must resolve all five labels. Check: C-PRC-01.
- Run indexing and all five gates in the invoking checkout's process, with no install credentials. Use the same process boundary in local landing and ubuntu-latest CI. Require the status context `Per-commit drift`, not the job id `drift`, only after a clean per-SHA run and repository-settings verification. Check: C-PRC-01.

- `packages/smithers/build/build-cli/src/internal/PackagePlanner.ts`: put the existence gate in the TargetIndex check executor at `withTargetIndex`, using existing `Input.expandGlob` and `Input.digestFile` for file, paths and workflows declarations. Preserve glob, brace-expansion and ignore rules. The typed error names each absent declared path, its target label and `metadata.sourceFile`. Do not require a PACKAGE.ts line or export private SourceSite metadata. Check: C-PRC-01.
- `PACKAGE.ts`: `Actionlint({workflows})` takes its list from the declared `workflows:` set (not a directory listing), and the target index declares those inputs, so the result is cache-correct; repair missing declarations in owning PACKAGE.ts files (inventory the current missing declarations; smithers-3f pre-reviews infrastructure fixes).
- `scripts/commit.mjs` (existing production landing entry point) and LAND.md (new): execute the five-target drift set before either VCS push path and preserve rejection output.
- `PACKAGE.ts` owns the generated `.github/workflows/drift.yml`: add //:ci there and regenerate the workflow; retain per-SHA non-cancelling concurrency. smithers-3f verifies the required-status setting on main after a clean per-SHA run.

## Tests

- C-PRC-01 resolves and executes every label in the five-target set, including the declared trackedHygiene target. Run the production gates in local and ubuntu-latest fixture checkout processes with install credentials absent. A temporary-path fixture fails trackedHygiene and reaches no push; a clean fixture passes all five gates. Assert the literal required context `Per-commit drift` through the repository-settings read API; retain the clean per-SHA run before enabling enforcement.

- Integration: `scripts/check-process-gates.test.mjs` (new) invokes production `smthrs lint //:targetIndex` and `scripts/commit.mjs --push` in an isolated fixture checkout, for both supported VCS paths. Execute the five local gates; intercept only remote publication at the final push seam. Literal fixtures cover file, paths, workflows, glob, braces, ignored inputs, stale generated files, temporary-path leakage and conflict markers. Each failing gate yields nonzero and zero push attempts; a clean fixture reaches exactly one push after all five gates. Expected paths, statuses, gate order and workflow fields are committed literals, never parsed from spec/product Markdown or copied from implementation output. Verify the configured required status through the repository settings read API; workflow YAML alone does not prove enforcement.

- C-PRC-01 verifies missing static-prefix expansion remains `[]` and missing-file digestion remains `undefined` outside the TargetIndex check. The check rejects missing declarations with the absent path, target label and `metadata.sourceFile`, without a PACKAGE.ts line or new Metadata export. Actionlint consumes its declared workflow list.

## Acceptance

- [C-PRC-01](../checks/C-PRC-01.md): every Pass when assertion holds.

## Risks and notes

- Do not gate landing on the long CI job. Keep existing repair ownership for unrelated reds. Gates run in the invoking checkout's process, with no install credentials. smithers-3f reviews credential isolation; smithers-38 reviews declaration loading. C-PRC-01 proves that a gate failure prevents push.

## Ready checklist

1. Dependencies: no MVP runtime ticket is required; existing input resolver, target index and commit entry point supply the base. Declare trackedHygiene, pin gate tools and obtain admin access to required-status settings before enforcement. Gates run in the invoking checkout's process, with no install credentials. Check: C-PRC-01.
2. Exclusions: runtime changes, long-CI repair/promotion, new glob semantics, missing-input exemptions and a new landing command are explicit.
3. Boundary: C-PRC-01 invokes production lint and commit --push, intercepts remote publication only, uses literal refusal fixtures and verifies required-status settings independently.
4. Decisions: smithers-38 approves input semantics and public exports; smithers-3f approves CI/protection settings; smithers-22 accepts gate coverage; smithers-8a resolves ownership seams.
5. Owner pre-review before start: smithers-3f: answered, BLOCKING edits applied (tech lead adopts). Declare trackedHygiene and run gates in the invoking checkout's process, with no install credentials. smithers-38: answered, BLOCKING edits applied (tech lead adopts). Preserve Input.ts and public planner semantics; validate existence in `withTargetIndex` using existing Input functions and report label plus `metadata.sourceFile`; smithers-b8 reviews CLI missing-path errors. Check: C-PRC-01.
6. Security: gates run in the invoking checkout's process, with no install credentials. smithers-3f reviews credential isolation and publication refusal; smithers-38 reviews declaration loading. C-PRC-01 tests each gate failure before push.

