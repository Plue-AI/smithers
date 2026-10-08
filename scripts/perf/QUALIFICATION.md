# Qualification publication

The composed owner-session `GET /api/install/metrics` authenticates qualification
before publishing it. It does not execute checks or approve their mappings.
The nine lifecycle/root/broker receipts and `smithers-3f` inventory review remain
prerequisites. Performance receipts still come from `scripts/check-run.mjs`.

The reference-host reviewer delivers a JSON data file to
`$STATE/machine-qualification.json` on the install. The packaged launcher already
sets `SMITHERS_DATA_ROOT` to this state directory. A directly launched backend can
select a different data file with `SMITHERS_MACHINE_QUALIFICATION_FILE`; this
changes only where bytes are read. The envelope has exactly
`key_id`, `payload` and `signature`. `payload` is the compact JSON qualification
object described in `docs/api/openapi/install.yaml`; `signature` is standard
base64 of an Ed25519 signature over those exact payload bytes. It is data only.
The file must be regular, at most 1 MiB, and must not be a symlink.

A main-reviewed entry in `approvedQualificationAuthorities` in
`packages/backend/internal/services/install_qualification.go` binds that key ID
to the reviewer's public key and reference Mac's uppercase IOPlatformUUID.
No key or host is approved yet. Approval requires an owner-reviewed main change;
settings, request headers, benchmark flags and this file cannot grant authority.
The key holder attests the retained authenticated execution receipts and review,
including their digests and complete path inventory. Never sign fixture results.
Remove the authority in main to revoke it.

The install independently checks its running executable through
`installbundle.OpenRunning`, its manifest digest, revision and local
IOPlatformUUID. This contract uses the immutable bundle revision as
`install_version`; set `SMITHERS_PERF_INSTALL_VERSION` to that revision for the
benchmark. `origin` must equal the router-validated public origin from the saved install Address without a
trailing slash (falling back to process configuration outside HTTP) and must be a remote HTTP(S) origin. An upgrade, relocation to a
different Mac, changed origin or bundle requires a new matching qualification.

Every failure returns `machine_qualification.status = unavailable`, while the
owner can still read the ordinary metrics. Publication never sets
`LiveCodeDocuments`, adds a broker receipt, starts a machine or changes root
inputs. The signed record covers provenance and review; measured performance
budgets require separate reference-host runs.
