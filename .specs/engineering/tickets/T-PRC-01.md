# T-PRC-01 Declared-input existence in //:targetIndex and the drift set at landing

Stage S1 · Size S · Depends on — · Unblocks T-REL-02 · Issue: [#3613](https://github.com/smithersai/smithers/issues/3613)
Spec: spec.md §21.2 · Delta: delta.md (engineering process) · Product: mvp.md §12.1 (acceptance evidence) · Owner: smithers-38 + smithers-22

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

C-PRC-01 (folded steps and assertions):
1. Index a valid fixture, then rename a declared input without changing its declaration.
2. Exercise file, paths, workflows, glob, brace-expansion and ignore-rule fixtures through `withTargetIndex`. Verify `Input.expandGlob` returns `[]` for a missing static prefix and `Input.digestFile` returns `undefined` for a missing file outside the TargetIndex check. Verify Actionlint consumes its declared workflow list.
3. Attempt landing with stale workflow input, generated drift, tracked temporary-path leakage and a conflict marker.
4. Resolve and execute all five target labels, including `//scripts:trackedHygiene`; the temporary-path fixture must fail that target. Run the gates in the invoking checkout's process for local landing and ubuntu-latest CI, with no install credentials.
5. Refuse machine execution and assert zero push attempts. Read main required-status settings through the repository settings API and verify the literal per-SHA status name; generated YAML alone is insufficient.
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
6. Root-input inventory: local lint/index/landing gates run unprivileged. The generated drift CI runs root sudo apt update/install and sysctl. Inputs are workflow shell/argv/job/env and generated PACKAGE.ts package declaration (main on main push, branch on PR); preceding branch manifests/actions' PATH/state effects; SHA-pinned action code (GitHub); sudo/apt/sysctl binaries, runner environment, apt config/sources/keyrings/proxy/index/package/maintainer-script responses, and proc/sysctl state (install-controlled approved runner/upstream, branch-controlled where modified). Root executable, script, plist and toolchain bytes come only from main-pinned or installed-bundle sources; branch-built bytes are forbidden at root. R4 reads the target index only from main, runs toolchain steps as agent, and validates destinations before use. Privileged CI setup executes only main-pinned trusted workflow/wrapper bytes; branch workflow and package declarations are hostile data and cannot select root commands. Lands only after T-SEC-01 (R1–R3) and `C-PRC-01/root-ci-setup-input-validation` pass; may start before. R4 is owned by T-MCH-10’s sec10 follow-up; R5 is owned by T-FLW-01’s follow-up where used. R5 proves artifact bytes come only from the installed bundle/catalog digest, never the branch.

### Criterion 6 root-input inventory

The following audited inputs include hostile refusal fixtures. They do not authorize branch-built bytes at root. The adopted source restrictions above govern accepted inputs.

#### R1

Inputs:

- Helper bytes and expected digest, fixed `/opt/smithers/guest` destination and install script — **main**, embedded into the **install-controlled** backend.
- `msb` executable/path, host child environment/PATH/HOME, machine identifier, deadlines — **install-controlled** runtime configuration/state; executable provenance must remain bundle-controlled.
- Guest image or layer/snapshot, `/bin/sh`, `python3`, `sha256sum`, `cut`, `mkdir`, `cat`, `mv`, executable search paths, Python startup/import paths and existing helper/temporary-file/parent entries — **install-controlled** base; snapshots/cache/environment can contain **branch-derived** and **member-controlled** entries. Digest comparison alone does not validate parent ownership, symlinks, interpreter provenance or startup imports.
- OCI image pull/metadata/blob responses — **install-controlled** pinned image selection, upstream registry responses; retained snapshot data — **install-controlled** state with **branch/member-derived** contents where applicable.

#### R2

Inputs:

- Setup argv (login, UID, directories), fixed HOME_LINKS/GO_SETTINGS, helper source — **main** constants today; future member login/UID bindings — **install-controlled** DB allocations derived from **GitHub/member** identities, not arbitrary user argv.
- `/etc/passwd`/group account entries, `useradd`, shell, existing home path and account UID/GID — **install-controlled** image/account state.
- `/opt/smithers/env.json`: all keys/values, including PATH, PYTHONPATH, Go settings, tool-cache targets — generated from **main** code and **branch-derived** toolchain selection; file ownership and immutability are separate inputs.
- `/var/cache/smithers/home` names/entries, cache directories, existing `.cache`, `.config`, `.config/go`, `.config/go/env`, all ancestor/leaf symlinks and directory metadata — **branch-derived** dependency output and **member-controlled** retained home state.
- Kernel/filesystem responses to mkdir/stat/open/chown/chmod and symlink operations — **install-controlled** guest OS; which object they address can be **member-controlled**.

#### R3

Inputs:

- JSON request id, argv, env, cwd, root, user and stdin mode; operation/path/content/mode/read limit for fs — **main/install-controlled** envelope and fixed identity fields, with **branch/member-controlled** argv, environment values, relative paths, file bytes and existing symlink graph. Capture metadata and command results are **branch/member-controlled** outputs.
- `/opt/smithers/env.json`, helper/interpreter startup environment, passwd/group records and guest directory state — sources as R1/R2.
- Host-generated exec IDs; kill/kill-all names, child directories, cgroup.procs/kill/events and their observed state — **main/install-controlled** IDs and kernel cgroup state; a guest command influences process population. Any selectable path/name must be validated against the fixed subtree.
- Relay/probe port, fixed host.microsandbox.internal bridge destination, ws relay-port metadata — **main/install-controlled**; bytes flowing over relay/TCP and associated peer responses — **member/branch-controlled** or authenticated host data, depending on channel.
- Fork/wait/signal/exit observations, filesystem resolution and network responses — **install-controlled** kernel responses influenced by member processes/network traffic.

#### R4

Inputs by privileged substep:

- Prepare boot/bootstrap: base OCI image, parent/newest same-family snapshot, owner/holder/repository/name/key labels, CPU/memory/disk/timeout/budget, net-rule allowlist — **install-controlled** configuration/state; recipe key, network destinations and selected tools are **branch-derived**. Image and snapshot contents include upstream OS and prior **branch-derived** outputs. R1/R2 also apply.
- Toolchain root recipe: `.smithers/target-index.json` Environment.Toolchain download versions/URLs/SHA256, Rust channel/components/targets, PostgreSQL major, destinations; or detected language/version evidence from repository manifests and version files — **branch**. Bundled `toolchains.json`, detector and script templates — **main/install-controlled**. `.smithers/machine.json` package additions — **main**, explicitly pinned by resolver. Downloads/archive entries/install scripts/tool `--version` output, Rust dist metadata/artifacts, apt package indexes/packages/maintainer scripts and PGDG key — upstream network responses, **branch-selected** for indexed download URLs/pins, otherwise **install-controlled** approved upstreams. GitHub-hosted release responses are **GitHub**, selected by the branch where index supplies the URL. `/etc/os-release`, apt sources/keyrings, root temp dirs and existing executable/filesystem state — **install-controlled** image/snapshot, including prior branch outputs. Every env.json key/value and root subprocess environment is consumed; fixed overrides are HOME=/root, TMPDIR=/var/tmp, DEBIAN_FRONTEND=noninteractive, system PATH, empty PYTHONPATH; other base_environment values remain inputs.
- Root input plant: all declared input path names and bytes (package/lock/workspace manifests, Go/Cargo inputs, selected tool entry/source files, dprint config, Python/requirements/pyproject inputs as selected by recipe); `tarFiles` regular-entry metadata, generated tar bytes; fixed destination/cache path and UID/GID, existing prepare directory/ancestors — **branch** files/names, **main** tar construction/script/UID, **install-controlled** snapshot paths with prior **branch-derived** cache content. This root step consumes file bytes even though later dependency installers run as agent.
- Root browser system install: Playwright selection/version triggering shipped apt script — **branch**; fixed package argv — **main**; apt sources/signatures/indexes/packages/scripts — **install-controlled** image/upstream network. It is separate from the unprivileged browser installer.
- Marker/sync and offline verification: serialized schema/kind/key/name/parent/repository/inventory/creation record, marker path, existing marker/temp/parent files and snapshot — **install-controlled** record with **branch-derived** recipe identity and output; script/destination — **main**. Reading a matching marker verifies identity, not trust of all layer contents.

