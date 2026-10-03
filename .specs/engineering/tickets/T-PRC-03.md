# T-PRC-03 Check receipts required to close a ticket

Stage S1 · Size S · Depends on — · Unblocks T-REL-02 · Issue: [#3615](https://github.com/smithersai/smithers/issues/3615)
Spec: spec.md §21.4 · Delta: delta.md (engineering process) · Product: mvp.md §12.1 (acceptance evidence) · Owner: smithers-22
Ready: 2026-10-02 smithers-8a sha256:fb444c464c3e

## Goal

A ticket closes only with a machine-written receipt for every named check, bound to `--landed <sha>`. `scripts/check-run.mjs C-XXX-NN` runs an approved executable mapping on the check’s declared `Runs in` host. It refuses absent, unwritten or unparsable mappings. It writes `.artifacts/checks/<id>/<ts>/receipt.json` with `{version: 1, check, commit, layer, command, exit, started, ended, log_digest}`. `commit` is a full SHA; `exit` is an integer; `started` and `ended` are ISO UTC timestamps; `log_digest` is `sha256:<hex>`. Every `comment --close` variant requires `--landed <sha>` and passing receipts for all ticket checks before any comment, release or close write. `--note` is free text and is never commit evidence. `--force` and omitted `--release` do not bypass evidence. Refusal exits 2 with `action: "evidence-refused"` and per-check `{check, receipt?, reason: missing|coverage|failed|commit|digest}`, distinct from held-claim `action: "refused"`. Check: C-PRC-03.

## Scope

In:
- `scripts/check-run.mjs` (new): map Automation explicitly to an executable command and its declared `Runs in` host. Refuse absent paths, unwritten declarations, unparsable Automation and unavailable declared hosts. Execute with a scrubbed environment: no `GH_TOKEN`, `GITHUB_TOKEN` or `SMITHERS_GITHUB_PROXY`; `~/.config/issue-claim` is unreadable to the check process. Write `log.txt` beside `receipt.json`, hash the completed log and write the version-1 receipt after completion. Publication credentials stay behind `issue-claim.mjs` write(). smithers-22 approves each mapping; no guessed command or prose PASS creates a receipt. Check: C-PRC-03.
- `scripts/issue-claim.mjs`: require `--landed <sha>` for every `comment --close` variant; verify a full SHA that is an ancestor of `origin/main`. Derive required check IDs from the ticket, not caller-supplied coverage. Require each receipt’s `commit` to equal that SHA and verify version, successful integer exit, ISO UTC timestamps and log digest. Resolve receipts and sibling logs under `.artifacts/checks/`; refuse symlinks in either path and `..` components before reading, then verify realpath confinement. Refuse before every issue write with exit 2, `action: "evidence-refused"` and per-check `{check, receipt?, reason: missing|coverage|failed|commit|digest}`. Keep held-claim exit 2 as `action: "refused"`. Reuse the production proxy write path; tests intercept only remote writes. Check: C-PRC-03.
- Completion reports list receipt paths.
- Non-landing closes (product, 2026-10-02 20:07): `comment --close --reason not-planned|duplicate|superseded --note <link>` closes with GitHub's matching `state_reason` and no receipts. It can never close as completed; a completed close keeps the full evidence gate. `--note` is required, and for duplicate or superseded it must link the replacing issue or commit.
- Enforcement (product, 21:5x): on, with no switch. Every completed close needs receipts for all of its checks. Every new check implementation adds its mapping in the same change. Coverage rule (tech lead, 22:16): a NEEDS-OWNER check gets its argv and host from the implementing ticket's landing, and that ticket's close is refused until then; a MANUAL check needs an owner-signed receipt bound to the commit SHA; nothing is waived.

Out:
- Product runtime behavior, check implementations, live-issue closure in tests, claim arbitration changes, release/deploy policy, a hosted evidence service and any receipt bypass. M-29 governs branch machines and does not require this engineering runner to execute on a machine. Check: C-PRC-03.

## Changes

- `scripts/check-run.mjs` (new): map Automation explicitly to an executable command and its declared `Runs in` host. Refuse absent paths, unwritten declarations, unparsable Automation and unavailable declared hosts. Execute with a scrubbed environment: no `GH_TOKEN`, `GITHUB_TOKEN` or `SMITHERS_GITHUB_PROXY`; `~/.config/issue-claim` is unreadable to the check process. Write `log.txt` beside `receipt.json`, hash the completed log and write the version-1 receipt after completion. Publication credentials stay behind `issue-claim.mjs` write(). smithers-22 approves each mapping; no guessed command or prose PASS creates a receipt. Check: C-PRC-03.
- `scripts/issue-claim.mjs`: require `--landed <sha>` for every `comment --close` variant; verify a full SHA that is an ancestor of `origin/main`. Derive required check IDs from the ticket, not caller-supplied coverage. Require each receipt’s `commit` to equal that SHA and verify version, successful integer exit, ISO UTC timestamps and log digest. Resolve receipts and sibling logs under `.artifacts/checks/`; refuse symlinks in either path and `..` components before reading, then verify realpath confinement. Refuse before every issue write with exit 2, `action: "evidence-refused"` and per-check `{check, receipt?, reason: missing|coverage|failed|commit|digest}`. Keep held-claim exit 2 as `action: "refused"`. Reuse the production proxy write path; tests intercept only remote writes. Check: C-PRC-03.
- Before activation, inventory and approve executable mappings for all named checks, including the reported unparsable Automation entries C-REL-01, C-STK-01, C-SPK-03, C-SPK-07, C-GH-01, C-DUR-03, C-UI-08, C-UI-13, C-MCH-05, C-AGT-01, C-AGT-02 and C-MNT-01 through C-MNT-06. Refuse each unmapped entry until its owner supplies a command and declared host. Check: C-PRC-03.

## Tests

- `scripts/check-receipts.test.mjs` (new) runs the production runner on the fixture check’s declared CI host, then production `comment --release --close --landed <sha> --receipt <path>...` against an isolated fixture writer. Exercise `comment --close` without `--release` and with `--force`. Intercept remote writes only. Assert literal `version: 1`, full commit SHA, integer exit, ISO UTC timestamps, `sha256:<hex>`, check IDs, command, layer and write count; independently hash logs and compare times with observed bounds. Complete matching evidence closes exactly once. Check: C-PRC-03.
- Missing, incomplete, failed, wrong-commit and altered-log evidence exits 2 with literal `action: "evidence-refused"` and the per-check reason from `missing|coverage|failed|commit|digest`; assert optional receipt paths when supplied. A held claim returns the distinct `action: "refused"`. Test missing `--landed`, non-full SHA, a non-ancestor of `origin/main`, free-text `--note`, caller-invented coverage, malformed receipt fields, symlink receipts/logs/parents, `..` paths and realpath escape. Every refusal makes zero comment, release and close writes. Check: C-PRC-03.
- Run a credential canary on the declared host; assert all three publication environment variables absent and `~/.config/issue-claim` unreadable. An unavailable host or absent/unwritten/unparsable mapping creates no passing receipt and reaches no write. A failed command produces failed evidence. Fixture documents are parser input; expected policy comes from literal fixtures, never engineering/product Markdown or production code. Check: C-PRC-03.

## Acceptance

- [C-PRC-03](../checks/C-PRC-03.md): every Pass when assertion holds.

## Risks and notes

- Use an isolated fixture issue writer; the check closes no live issue. Before enabling closure enforcement, smithers-22 inventories each named check’s executable Automation mapping and smithers-8a accepts coverage; an unimplemented check remains uncloseable, not waived. This is an operational activation prerequisite, not a dependency on the checks’ implementation tickets.
- Execute mapped engineering automation only on the check’s declared host with the scrubbed environment and unreadable issue-claim configuration. Publication credentials remain behind the trusted writer’s write() boundary. M-29 governs branch machines, not this runner. smithers-3f reviews host selection and receipt/log confinement; smithers-b8 reviews the stable CLI refusal contract. C-PRC-03 proves credential exclusion, path refusal and zero writes on invalid evidence.

## Ready checklist

1. Dependencies: no MVP runtime prerequisite is added. The issue-claim proxy write path and isolated fixture writer supply the base. Approved executable mappings and available declared hosts gate activation; unavailable checks fail closed.
2. Exclusions: check implementation, live-issue testing, claim-policy changes, deploy/release policy and receipt bypasses are explicit.
3. Boundary: C-PRC-03 exercises the production runner and comment --close command variants, intercepting remote writes only, with literal check coverage, commit and refusal expectations.
4. Decisions: smithers-22 accepts executable mappings and commit verification; smithers-8a accepts named-check coverage; smithers-b8 approves CLI/receipt contract; smithers-3f approves execution and path confinement.
5. Owner pre-review: smithers-b8: answered, BLOCKING edits applied (tech lead adopts). smithers-3f: answered, BLOCKING edits applied (tech lead adopts). smithers-22 must accept executable mappings and named-check coverage before activation.
6. Root-input inventory: receipt verification and issue publication are unprivileged. Mapping all named checks can dispatch C-SPK-06 sudo/system-plist setup, C-SPK-08 uid-0 supervisor setup/session handling, and machine bootstrap/layer operations. Those root consumers take the complete inputs listed for T-INS-03/T-TRM-06 and R1–R5 where used. The dispatcher additionally consumes check id, mapping source/approval identity, executable/path/argv/declared host/layer, harness/fixtures, environment/PATH/cwd and bundle identity (main/install-controlled only when explicitly pinned; otherwise branch/member-controlled). Tickets, receipts/logs and caller paths/--landed are branch/member data; main/GitHub ancestry and installed host availability are separate inputs. Root executable, script, plist and toolchain bytes come only from main-pinned or installed-bundle sources; branch-built bytes are forbidden at root. R4 reads the target index only from main, runs toolchain steps as agent, and validates destinations before use. Lands only after T-SEC-01 (R1–R3) and `TestRootLayerInputsValidatedBeforeUse`, `TestRootManagedArtifactInstallUsesApprovedBundleOnly`, `C-PRC-03/root-check-mapping-validation`, `C-SPK-06/root-plist-input-validation`, `C-SPK-06/guest-root-probe-provenance`, `C-SPK-08/root-prototype-install-validation`, `C-SPK-08/root-session-input-validation` pass; may start before. R4 is owned by T-MCH-10’s sec10 follow-up; R5 is owned by T-FLW-01’s follow-up where used. R5 proves artifact bytes come only from the installed bundle/catalog digest, never the branch.

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

#### R5

Inputs: artifact source path/bytes, artifact mapping, executable and env-value paths, helper bytes/digest — **install-controlled** bundle/catalog; existing guest destination/parents — **install-controlled** filesystem, potentially **member-controlled** if writable. Coding binding workspace/actor/repository IDs, repository slug, API/git URLs, fixed workspace/user/socket/version — **install-controlled** server authority, with **GitHub/member-derived** identity/slug data. Destination files, owners/modes/symlinks and helper-check response — guest filesystem/response. Root script/helper/interpreter — **main/install-controlled** plus R1 startup inputs.

