# T-PRC-03 Check receipts required to close a ticket; one check runner

Stage S1 · Size S · Depends on — · Unblocks T-MCH-01, T-REL-02 · Issue: [#3615](https://github.com/smithersai/smithers/issues/3615)
Spec: spec.md §21.4 · Product: mvp.md §12.1 (acceptance evidence) · Owner: smithers-22
Rescoped by the minimal-code synthesis, 2026-10-03 (v2 ruling 3; v1 §6 host-profile readers). #3663 is re-scoped to this ticket.

## Goal
A ticket closes only with a machine-written receipt for every named check, bound to `--landed <sha>`, and one check runner writes those receipts. A receipt is `.artifacts/checks/<id>/<ts>/receipt.json` with `{version: 1, check, commit, layer, command, exit, started, ended, log_digest}`; `commit` is a full SHA, `exit` an integer, times ISO UTC, `log_digest` `sha256:<hex>`. A receipt records CI's own result for the check's target at the landed SHA; it executes nothing locally.

## Scope
In:
- One runner, `scripts/check-run.mjs` (landed a109c5d0c). It maps Automation through `scripts/check-commands.json` to an approved smthrs target on CI, reads the check and mapping with `git show` at the required `--landed <sha>`, and records CI's own result. Argv mappings are not executable; map the check to a smthrs target. Absent, unwritten or unparsable mappings and non-CI hosts refuse.
- `scripts/issue-claim.mjs` close gate through `scripts/check-evidence.mjs` (`issue-claim.mjs:42`): every `comment --close` variant needs `--landed <sha>`, a full SHA that is an ancestor of `origin/main`, and passing receipts for the check IDs derived from the ticket. Receipts and logs resolve under `.artifacts/checks/` with no symlinks, no `..` and realpath confinement. Refusal exits 2 with `action: "evidence-refused"` and per-check `{check, receipt?, reason: missing|coverage|failed|commit|digest}`, distinct from held-claim `action: "refused"`. `--force` and `--note` never bypass evidence.
- Non-landing closes: `--reason not-planned|duplicate|superseded --note <link>` close with GitHub's `state_reason` and no receipts, never as completed.
- Enforcement is on with no switch. Each new check implementation adds its mapping in the same change; a NEEDS-OWNER check is uncloseable until mapped; a MANUAL check needs an owner-signed receipt bound to the SHA.

Out: product runtime, check implementations, live-issue closure in tests, claim arbitration, release policy, a hosted evidence service, any bypass.

## Changes
- Reuse `scripts/check-run.mjs`, `scripts/check-evidence.mjs`, `scripts/check-receipts.test.mjs`, `scripts/check-commands.json` and the `issue-claim.mjs` proxy write path.
- Duplicate runner, qualifier, obligation manifest and targets removed. Proposed bindings, including Playwright population contracts, are retained as unapproved `pendingBinding` data in `scripts/check-commands.json`.
- Duplicate host-profile and ops-health-line parsing removed. Checks needing host facts read `/api/install` (T-INS-06); the Go host profile is the one reader.
- Inventory and approve mappings for every named check, including the unparsable entries C-REL-01, C-STK-01, C-SPK-03, C-SPK-07, C-GH-01, C-DUR-03, C-UI-08, C-UI-13, C-MCH-05, C-AGT-01, C-AGT-02 and C-MNT-01 through C-MNT-06. smithers-22 approves each mapping.

## Tests

C-PRC-03 (folded steps and assertions):
1. Write target receipts as the runner would. Inspect version-1 receipt fields and independently recompute the log digest. Re-read CI through isolated transport with real results artifact zips.
2. Invoke the runner with absent, unwritten and unparsable Automation and an unavailable declared host. Verify failed CI label results.
3. Attempt close with no receipts, incomplete coverage, failed exit, different commit and altered log, using --release, omitted --release and --force variants. Assert exit 2 and zero comment, release or close writes.
4. Test missing --landed, non-full SHA, non-ancestor of origin/main, free-text --note, invented coverage, symlink receipts/logs/parent directories, .. components and realpath escape. Required check IDs come from the ticket.
5. Refuse argv mappings even with CI=true; assert no receipt and no issue writes. Require --landed and approved target mappings without command or paths.
6. Close using passing receipts for every named ticket check with receipt.commit equal to --landed <sha>, verified as an ancestor of origin/main. Repeat without --release and with --force. Test a held claim separately.

Pass when:
- Literal receipt fields are `{version: 1, check, commit, layer, command, exit, started, ended, log_digest}`: full commit SHA, integer exit, ISO UTC timestamps and `sha256:<hex>`. Values match observed command, layer, time bounds and independently hashed logs.
- The runner records CI results only and executes no mapped argv. Closure re-reads CI for the issue repository. Publication credentials remain behind issue-claim write().
- Absent, unwritten or unparsable Automation and unavailable hosts create no passing receipt. Failed CI label results remain failed evidence.
- Invalid evidence exits 2 with `action: "evidence-refused"` and per-check `{check, receipt?, reason: missing|coverage|failed|commit|digest}` before comment, release or close writes. Held claims retain `action: "refused"`.
- Landed ancestry, exact receipt.commit, ticket-derived coverage and receipt/log path confinement are enforced. Symlinks and .. are refused. Complete passing evidence permits exactly one close.

Fail when:
- A defective fixture reaches the push or close seam.
- A valid fixture fails, or prose PASS claims replace observed output.

- `scripts/check-receipts.test.mjs` writes fixture target receipts, verifies CI artifact reads through the production gate, then `comment --release --close --landed <sha> --receipt <path>...` against an isolated fixture writer, intercepting remote writes only. Literal receipt fields; independent log hash; one close for complete evidence.
- Missing, incomplete, failed, wrong-commit and altered-log evidence; missing `--landed`, non-full SHA, non-ancestor, free-text `--note`, invented coverage, symlinks, `..` and realpath escape: each exits 2 with its literal reason and zero writes.
- Argv mappings refuse without execution. A receipt citing a CI check run at a different SHA is refused with `commit`.
- `git ls-files scripts/checks` lists no runner, and no script imports one.

## Acceptance
- [C-PRC-03](../checks/C-PRC-03.md): every Pass when assertion holds.

## Risks and notes
- Use an isolated fixture writer; the check closes no live issue. Before enforcement, smithers-22 inventories mappings and smithers-8a accepts coverage; an unimplemented check stays uncloseable, not waived.
- Root inputs: receipt verification and issue publication are unprivileged. Recording a check dispatches no setup or machine operations; it reads CI results for a target. C-SPK-06 sudo/system-plist setup, C-SPK-08 uid-0 supervisor setup/session handling, and machine bootstrap/layer operations remain owned by their targets. Those root consumers take the complete inputs listed for T-INS-03/T-TRM-06 and R1–R5 where used. The recorder consumes check id, main-pinned mapping source/approval identity, target/declared host/layer, landed SHA and CI run/artifact identity. Tickets, receipts/logs and caller paths/--landed are branch/member data; main/GitHub ancestry and installed host availability are separate inputs. Root executable, script, plist and toolchain bytes come only from main-pinned or installed-bundle sources; branch-built bytes are forbidden at root. R4 reads the target index only from main, runs toolchain steps as agent, and validates destinations before use. Lands only after T-SEC-01 (R1–R3) and `TestRootLayerInputsValidatedBeforeUse`, `TestRootManagedArtifactInstallUsesApprovedBundleOnly`, `C-PRC-03/root-check-mapping-validation`, `C-SPK-06/root-plist-input-validation`, `C-SPK-06/guest-root-probe-provenance`, `C-SPK-08/root-prototype-install-validation`, `C-SPK-08/root-session-input-validation` pass; may start before. R4 is owned by T-MCH-10’s sec10 follow-up; R5 is owned by T-FLW-01’s follow-up where used. R5 proves artifact bytes come only from the installed bundle/catalog digest, never the branch.

## Root-input inventory (kept from the 2026-10-02 review)

The following audited inputs include hostile refusal fixtures. They do not authorize branch-built bytes at root. The adopted source restrictions above govern accepted inputs.

### R1

Inputs:

- Helper bytes and expected digest, fixed `/opt/smithers/guest` destination and install script — **main**, embedded into the **install-controlled** backend.
- `msb` executable/path, host child environment/PATH/HOME, machine identifier, deadlines — **install-controlled** runtime configuration/state; executable provenance must remain bundle-controlled.
- Guest image or layer/snapshot, `/bin/sh`, `python3`, `sha256sum`, `cut`, `mkdir`, `cat`, `mv`, executable search paths, Python startup/import paths and existing helper/temporary-file/parent entries — **install-controlled** base; snapshots/cache/environment can contain **branch-derived** and **member-controlled** entries. Digest comparison alone does not validate parent ownership, symlinks, interpreter provenance or startup imports.
- OCI image pull/metadata/blob responses — **install-controlled** pinned image selection, upstream registry responses; retained snapshot data — **install-controlled** state with **branch/member-derived** contents where applicable.

### R2

Inputs:

- Setup argv (login, UID, directories), fixed HOME_LINKS/GO_SETTINGS, helper source — **main** constants today; future member login/UID bindings — **install-controlled** DB allocations derived from **GitHub/member** identities, not arbitrary user argv.
- `/etc/passwd`/group account entries, `useradd`, shell, existing home path and account UID/GID — **install-controlled** image/account state.
- `/opt/smithers/env.json`: all keys/values, including PATH, PYTHONPATH, Go settings, tool-cache targets — generated from **main** code and **branch-derived** toolchain selection; file ownership and immutability are separate inputs.
- `/var/cache/smithers/home` names/entries, cache directories, existing `.cache`, `.config`, `.config/go`, `.config/go/env`, all ancestor/leaf symlinks and directory metadata — **branch-derived** dependency output and **member-controlled** retained home state.
- Kernel/filesystem responses to mkdir/stat/open/chown/chmod and symlink operations — **install-controlled** guest OS; which object they address can be **member-controlled**.

### R3

Inputs:

- JSON request id, argv, env, cwd, root, user and stdin mode; operation/path/content/mode/read limit for fs — **main/install-controlled** envelope and fixed identity fields, with **branch/member-controlled** argv, environment values, relative paths, file bytes and existing symlink graph. Capture metadata and command results are **branch/member-controlled** outputs.
- `/opt/smithers/env.json`, helper/interpreter startup environment, passwd/group records and guest directory state — sources as R1/R2.
- Host-generated exec IDs; kill/kill-all names, child directories, cgroup.procs/kill/events and their observed state — **main/install-controlled** IDs and kernel cgroup state; a guest command influences process population. Any selectable path/name must be validated against the fixed subtree.
- Relay/probe port, fixed host.microsandbox.internal bridge destination, ws relay-port metadata — **main/install-controlled**; bytes flowing over relay/TCP and associated peer responses — **member/branch-controlled** or authenticated host data, depending on channel.
- Fork/wait/signal/exit observations, filesystem resolution and network responses — **install-controlled** kernel responses influenced by member processes/network traffic.

### R4

Inputs by privileged substep:

- Prepare boot/bootstrap: base OCI image, parent/newest same-family snapshot, owner/holder/repository/name/key labels, CPU/memory/disk/timeout/budget, net-rule allowlist — **install-controlled** configuration/state; recipe key, network destinations and selected tools are **branch-derived**. Image and snapshot contents include upstream OS and prior **branch-derived** outputs. R1/R2 also apply.
- Toolchain root recipe: `.smithers/target-index.json` Environment.Toolchain download versions/URLs/SHA256, Rust channel/components/targets, PostgreSQL major, destinations; or detected language/version evidence from repository manifests and version files — **branch**. Bundled `toolchains.json`, detector and script templates — **main/install-controlled**. `.smithers/machine.json` package additions — **main**, explicitly pinned by resolver. Downloads/archive entries/install scripts/tool `--version` output, Rust dist metadata/artifacts, apt package indexes/packages/maintainer scripts and PGDG key — upstream network responses, **branch-selected** for indexed download URLs/pins, otherwise **install-controlled** approved upstreams. GitHub-hosted release responses are **GitHub**, selected by the branch where index supplies the URL. `/etc/os-release`, apt sources/keyrings, root temp dirs and existing executable/filesystem state — **install-controlled** image/snapshot, including prior branch outputs. Every env.json key/value and root subprocess environment is consumed; fixed overrides are HOME=/root, TMPDIR=/var/tmp, DEBIAN_FRONTEND=noninteractive, system PATH, empty PYTHONPATH; other base_environment values remain inputs.
- Root input plant: all declared input path names and bytes (package/lock/workspace manifests, Go/Cargo inputs, selected tool entry/source files, dprint config, Python/requirements/pyproject inputs as selected by recipe); `tarFiles` regular-entry metadata, generated tar bytes; fixed destination/cache path and UID/GID, existing prepare directory/ancestors — **branch** files/names, **main** tar construction/script/UID, **install-controlled** snapshot paths with prior **branch-derived** cache content. This root step consumes file bytes even though later dependency installers run as agent.
- Root browser system install: Playwright selection/version triggering shipped apt script — **branch**; fixed package argv — **main**; apt sources/signatures/indexes/packages/scripts — **install-controlled** image/upstream network. It is separate from the unprivileged browser installer.
- Marker/sync and offline verification: serialized schema/kind/key/name/parent/repository/inventory/creation record, marker path, existing marker/temp/parent files and snapshot — **install-controlled** record with **branch-derived** recipe identity and output; script/destination — **main**. Reading a matching marker verifies identity, not trust of all layer contents.

### R5

Inputs: artifact source path/bytes, artifact mapping, executable and env-value paths, helper bytes/digest — **install-controlled** bundle/catalog; existing guest destination/parents — **install-controlled** filesystem, potentially **member-controlled** if writable. Coding binding workspace/actor/repository IDs, repository slug, API/git URLs, fixed workspace/user/socket/version — **install-controlled** server authority, with **GitHub/member-derived** identity/slug data. Destination files, owners/modes/symlinks and helper-check response — guest filesystem/response. Root script/helper/interpreter — **main/install-controlled** plus R1 startup inputs.

