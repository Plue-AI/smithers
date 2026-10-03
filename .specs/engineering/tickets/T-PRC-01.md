# T-PRC-01 Declared-input existence in //:targetIndex and the drift set at landing

Stage S1 · Size S · Depends on — · Unblocks — · Issue: [#3613](https://github.com/smithersai/smithers/issues/3613)
Spec: spec.md §21.2 · Delta: delta.md (engineering process) · Product: mvp.md §12.1 (acceptance evidence) · Owner: smithers-38 + smithers-22
Ready: 2026-10-03 smithers-8a sha256:edd311e8bfd2

## Goal

Declared inputs must exist when `//:targetIndex` resolves `Smithers.file()`, `paths:` and `workflows:` declarations, including supported globs and brace expansion. Actionlint already takes a declared workflow list; validate that list. Check: C-PRC-01. Landing runs `smthrs lint '//:driftCi' '//:targetIndex' '//:ci' '//scripts:trackedHygiene' '//scripts:conflictMarkers'` locally and refuses push on failure. The per-SHA, non-cancelling drift status is required on main and includes `//:ci`; the long CI remains advisory until its existing repair is green.

## Ownership

Owners: smithers-22 (landing gate) and smithers-38 (`@smthrs/targets`, build-cli). smithers-38 pre-reviews before start and signs off public exports under §21.1; smithers-3f approves CI and branch-protection configuration; smithers-22 accepts landing-gate coverage; smithers-8a resolves seam ownership. Gate test: rename one declared path to a missing file and assert `smthrs lint //:targetIndex` exits non-zero. Required-status configuration needs repository-admin access before activation; enable enforcement only after the updated drift job passes on a clean commit.

## Scope

In:
- `packages/smithers/build/build-cli/src/internal/PackagePlanner.ts`: put the existence gate in the TargetIndex check executor at `withTargetIndex`, using existing `Input.expandGlob` and `Input.digestFile` for file, paths and workflows declarations. Preserve glob, brace-expansion and ignore rules. The typed error names each absent declared path, its target label and `metadata.sourceFile`. Do not require a PACKAGE.ts line or export private SourceSite metadata. Check: C-PRC-01.
- `PACKAGE.ts`: `Actionlint({workflows})` takes its list from the declared `workflows:` set (not a directory listing), and the target index declares those inputs, so the result is cache-correct; repair missing declarations in owning PACKAGE.ts files (inventory the current missing declarations; smithers-3f pre-reviews infrastructure fixes).
- Reshape `scripts/commit.mjs` (existing production landing entry point): execute the five-target drift set before either VCS push path and preserve rejection output, including with `--no-test`. Update its existing help text with the mandatory gate behavior; do not add a separate LAND.md.
- `PACKAGE.ts` owns the generated `.github/workflows/drift.yml`: add //:ci there and regenerate the workflow; retain per-SHA non-cancelling concurrency. smithers-3f verifies the required-status setting on main after a clean per-SHA run.

- Lands dark until T-SEC-01: leave privileged CI setup and required-status activation disabled until its R1–R3 receipts pass and smithers-3f accepts `C-PRC-01/root-ci-setup-input-validation`. An unavailable or unvalidated setup refuses gate execution and push; it never falls back to branch-selected root commands. This is an activation condition, not a code/schema dependency. Local unprivileged engineering gates do not call T-SEC-01 code. Check: C-PRC-01.

Out:
- Product runtime behavior, long-CI repair or required-status promotion, changes to Input.ts, public planner semantics or Metadata exports, new input syntax or glob semantics, ignoring missing declarations, and blanket known-red exemptions. No new landing command replaces the existing commit entry point. No new hygiene checker, landing guide or parallel test harness. Guest R1–R3 hardening stays in T-SEC-01; R4 recipe work and R5 artifact work stay with their existing owners.

## Changes

- Reuse `//scripts:trackedHygiene` in `scripts/PACKAGE.ts` and `scripts/check-tracked-hygiene.mjs`; repair its declared inputs rather than add another checker. The five-target landing set must resolve all five labels. Check: C-PRC-01.
- Reshape the existing TargetIndex executor, commit entry point and drift generator listed in Scope. Keep `Input.ts`, public planner semantics and Metadata exports unchanged. Check: C-PRC-01.
- Run indexing and all five gates unprivileged in the invoking engineering checkout's process, with no install or publication credentials available to gate children (§21.4a). Keep publication credentials at the final push seam. Use the same boundary locally and on ubuntu-latest CI. Require `Per-commit drift` only after the security activation conditions in Scope, a clean per-SHA run and repository-settings verification. Check: C-PRC-01.

## Tests

C-PRC-01 (folded steps and assertions):
1. Index a valid fixture, then rename a declared input without changing its declaration.
2. Exercise file, paths, workflows, glob, brace-expansion and ignore-rule fixtures through production `smthrs lint //:targetIndex`, which reaches `withTargetIndex`; direct helper tests are supplemental. Verify `Input.expandGlob` returns `[]` for a missing static prefix and `Input.digestFile` returns `undefined` for a missing file outside the TargetIndex check. Verify Actionlint consumes its declared workflow list.
3. Attempt landing with stale workflow input, generated drift, tracked temporary-path leakage and a conflict marker.
4. Resolve and execute all five target labels, including `//scripts:trackedHygiene`; the temporary-path fixture must fail that target. Run the gates in the invoking checkout's process for local landing and ubuntu-latest CI, with no install credentials.
5. Refuse unavailable or unvalidated privileged CI setup and assert zero gate and push attempts. Assert gate children cannot read GH_TOKEN, GITHUB_TOKEN, SMITHERS_GITHUB_PROXY or ~/.config/issue-claim. Read main required-status settings through the repository settings API and verify the literal per-SHA status name; generated YAML alone is insufficient.
6. Land a clean fixture and inspect the per-SHA drift configuration and repository-settings read API. Verify the required context is `Per-commit drift` after a clean per-SHA run.

Pass when:
- The TargetIndex check rejects missing declarations with the absent path, target label and `metadata.sourceFile`; valid declarations pass. Input.ts, public planner semantics and Metadata exports remain unchanged. Errors do not require a PACKAGE.ts line. Actionlint consumes its declared workflow list.
- Every drift failure prevents push; a clean fixture reaches the push seam after all five gates pass.
- Drift includes //:ci, never cancels another SHA and requires `Per-commit drift` on main after a clean per-SHA run.
- All five labels resolve. trackedHygiene rejects tracked temporary-path leakage. Local and CI gates run in the invoking checkout's process with no install credentials.

Fail when:
- A defective fixture reaches the push or close seam.
- A valid fixture fails, or prose PASS claims replace observed output.


- C-PRC-01 resolves and executes every label in the five-target set, including the declared trackedHygiene target. Run the production gates in local and ubuntu-latest fixture checkout processes with install credentials absent. A temporary-path fixture fails trackedHygiene and reaches no push; a clean fixture passes all five gates. Assert the literal required context `Per-commit drift` through the repository-settings read API; retain the clean per-SHA run before enabling enforcement.

- Integration: extend existing `scripts/commit.test.mjs`, `scripts/ci/drift-job.test.mjs` and `packages/smithers/build/build-cli/test/TargetIndexExecution.test.ts`; no parallel process-gate harness is needed. Invoke production `smthrs lint //:targetIndex` and `scripts/commit.mjs --push --test true` (also `--push --no-test` with a literal reason) in an isolated fixture checkout, for both supported VCS paths. Execute the five local gates; intercept only remote publication at the final push seam. Literal fixtures cover file, paths, workflows, glob, braces, ignored inputs, stale generated files, temporary-path leakage and conflict markers. Each failing gate yields nonzero and zero push attempts; a clean fixture reaches exactly one push after all five gates. Expected paths, statuses, gate order and workflow fields are committed literals, never parsed from spec/product Markdown or copied from implementation output. Verify the configured required status through the repository settings read API; workflow YAML alone does not prove enforcement.

- C-PRC-01 verifies missing static-prefix expansion remains `[]` and missing-file digestion remains `undefined` outside the TargetIndex check. The check rejects missing declarations with the absent path, target label and `metadata.sourceFile`, without a PACKAGE.ts line or new Metadata export. Actionlint consumes its declared workflow list.

- `C-PRC-01/root-ci-setup-input-validation`: extend `scripts/ci/drift-job.test.mjs` to exercise the generated job's production setup dispatch on a disposable ubuntu-latest runner, not just parse YAML. Mutate branch workflow/package setup argv, PATH, shell startup/import environment, executable paths and apt configuration; each hostile fixture is refused before any root canary, gate or push. A main-pinned positive control performs the approved setup before checkout or branch dependency actions. Expected commands, source identities and canary bytes are committed literals. Root never executes branch-built bytes. smithers-3f accepts the observed refusal and positive-control receipts before activation.

## Acceptance

- [C-PRC-01](../checks/C-PRC-01.md): every Pass when assertion holds.

## Risks and notes

- Do not gate landing on the long CI job. Keep existing repair ownership for unrelated reds. Gates run in the invoking checkout's process, with no install credentials. smithers-3f reviews credential isolation; smithers-38 reviews declaration loading. C-PRC-01 proves that a gate failure prevents push.

## Security preconditions and root inputs

Engineering gate execution uses the owner-adopted invoking-checkout boundary and the engineering runner exception in §21.4a; it carries no install credentials. Product flows, checks, terminals and services still execute only inside branch machines under M-29 and §1.3. This ticket adds no product host-execution path. smithers-3f accepts credential isolation and privileged setup provenance; smithers-38 accepts declaration loading. Check: C-PRC-01.

The existing drift job's root steps are `sudo apt-get update`, `sudo apt-get install` and `sudo sysctl`. Move trusted setup before branch checkout and dependency actions. Every accepted privileged executable, script and command comes from reviewed main-pinned workflow/setup bytes or the approved runner image. Branch-built bytes are forbidden at root. `C-PRC-01/root-ci-setup-input-validation` proves validation before use of any branch-sourced data; until it passes, privileged setup stays disabled. Inputs for those steps:

- Workflow shell, argv, package list, sysctl key/value, action pins, job env, cwd, shell startup settings and generated PACKAGE.ts declaration: **main** for accepted setup, **branch** on a PR today. Branch declarations are hostile data and cannot choose privileged commands. Main-pinned setup provenance is verified independently of the branch-generated YAML.
- `sudo`, shell, apt-get and sysctl executable bytes and paths; PATH/HOME, loader/import/startup env, uid/groups, sudo policy, working directory and filesystem ancestors: **approved runner/main-pinned setup**. Prior checkout/manifests/actions, action PATH/state files and retained filesystem/cache contents can be **branch-derived**; refuse those influences before root use. SHA-pinned action bytes come from **GitHub** at the approved **main** pins, not PR-selected pins.
- Apt config, hooks, sources, keyrings, proxy and package-selection settings: **approved runner/main-pinned setup**; indexes, signatures, packages, dependency metadata and maintainer-script bytes: **approved upstream** network responses authenticated by those trusted sources/keyrings. Any branch-modified apt setting, hook, destination or source is refused before update/install.
- `/proc/sys/kernel/apparmor_restrict_unprivileged_userns`, its existence/value, kernel/filesystem responses and destination ancestors: **approved runner** state; branch processes can alter observed state if allowed to run first, so setup precedes all branch execution. Branch-supplied sysctl keys, values and paths are refused.

Guest root steps R1–R5 are not changed or executed by this ticket's engineering gate process; their implementation and inventories stay with their owning tickets.

## Ready checklist

1. Dependencies: Depends on —; existing resolver, TargetIndex, commit entry point and trackedHygiene need no new code/schema ticket. Scope lands privileged CI dark until T-SEC-01 and the named setup validation pass; unavailable setup refuses execution and push. Admin access, a clean per-SHA run and verified settings gate enforcement. Check: C-PRC-01.
2. Exclusions: Scope excludes product runtime, long-CI repair/promotion, new input/glob semantics, public planner/Metadata changes, missing-input exemptions, duplicate hygiene/landing/test surfaces and guest R1–R5 implementation.
3. Boundary: existing integration suites invoke production lint, commit --push and generated CI setup dispatch; only final remote publication is intercepted. Expected paths, statuses, order, identities and canaries are committed literals; no expectations come from spec files or runtime implementation output. Check: C-PRC-01.
4. Decisions: smithers-38 accepts input semantics and any public export diff under §21.1; smithers-b8 accepts CLI error/help behavior; smithers-3f accepts security, CI and protection settings; smithers-22 accepts gate coverage and activation; smithers-8a resolves ownership seams. No ADR is added.
5. Owner pre-review: smithers-3f and smithers-38 answers remain adopted, with BLOCKING edits applied; owners review post hoc under the parallel-build directive. smithers-3f: Does trusted setup precede all branch influence? Do root-input refusal fixtures and credential isolation cover local and CI gates? smithers-38: Does the TargetIndex-only gate preserve Input.ts and planner semantics? Are errors limited to absent path, label and metadata.sourceFile? smithers-b8: Are missing-path errors and help actionable through production lint/commit? Do both publication paths enforce the gates with --no-test? Check: C-PRC-01.
6. Security: §21.4a authorizes the adopted engineering runner boundary; M-29 still confines product repository execution to machines. The root inventory names each setup input and its source; branch data blocks activation until root-ci-setup-input-validation passes, and branch-built root code remains forbidden. smithers-3f reviews the boundary and signs off the receipts. Check: C-PRC-01.
