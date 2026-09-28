# smithers build design

This document describes the implementation that ships today. Proposed work is
kept in an explicit limitations section; it is never presented as a current
guarantee.

## 1. Design posture

smithers build borrows four disciplines from Bazel:

1. Analysis is separate from execution. A rule body records a graph and must
   not inspect the filesystem to decide what graph to return.
2. Declared inputs and dependency keys determine content identity.
3. A cache is an optimization. Corrupt, absent, or unreachable cache state may
   cost work but may not produce another action's answer or fail an otherwise
   valid run.
4. Publication is atomic and first-writer-safe. Readers see either the old
   complete value or the new complete value, never a partial file.

The implementation does not yet have Bazel's sandbox. It therefore does not
claim that effects declarations prove hermetic execution, and it does not admit
install actions to a shared engine cache. Being explicit about that difference
is part of the design: a weak observation is not relabelled as a hard boundary.

## 2. Authoring and analysis

A `PACKAGE.ts` file is an executable TypeScript module. Named target exports are
indexed under path-derived labels. Importing another target value creates a
dependency edge; attributes never contain label strings.

Rule construction is pure. Inputs such as `file()`, `glob()`, and `gitDiff()`
are declarations, not reads. Workspace discovery expands them later and stores
the matched path list and content digests in the plan. The planner computes a
target key from:

- canonical rule/attribute body material;
- expanded input declarations, paths, and digests;
- dependency keys;
- resolved layer identities and capabilities.

Before cache admission and after execution, the executor re-expands declared
inputs and compares exact path/digest snapshots. This closes the ordinary
plan-to-execution race. A final change between the last comparison and a tool's
own syscall remains impossible to close portably without a snapshotting or
descriptor-relative sandbox.

`PACKAGE.ts` evaluation is a trust boundary, not a sandbox boundary. A repository
module can run any code available to the user. The CLI never pretends that
temporarily clearing `process.env` makes it safe; credentials are withheld at
the child-process edge, where the guarantee is enforceable.

## 3. Execution

Targets run dependency-first with bounded parallelism. A target failure blocks
only its transitive dependents. Unrelated targets keep running, every in-flight
target is awaited, and the summary preserves plan order.

Each target gets a fresh in-memory flows runtime. Targets created by one rule
share a flow tag, so registering several in one runtime would alias their
bodies. Per-target runtimes make the declaration identity unambiguous.

The shared exec action spawns an argv directly, never through a shell. It uses
an explicit workspace-relative working directory, bounded output capture,
streaming UTF-8 decoding, process-group cancellation on POSIX, and a single
settlement path for spawn, stream, exit, and signal failures.

A green return is not sufficient for success. Rules with declared outputs must
return the expected output manifest, and the executor verifies those files on
disk before reporting or caching the result. Cache hits are subjected to the
same output verification.

## 4. Action tiers and filesystem boundaries

An action declaration has a retry tier and an effects boundary.

| Tier           | Current planner behavior                                        |
| -------------- | --------------------------------------------------------------- |
| `sealed`       | Content-keyable; shared reuse requires proven cache eligibility |
| `compensable`  | Plannable; run-local execution with a restorable pre-image      |
| `irreversible` | Plannable; run-local execution, no blind retries                |

| Boundary   | Meaning                                                              |
| ---------- | -------------------------------------------------------------------- |
| `hard`     | Declared reads/writes are asserted complete                          |
| `expected` | Declarations are expectations; deviations are observable, not proofs |

Cross-run engine admission requires both a `sealed` tier and a `hard`
boundary. The normal executor does not provide release/publication action
layers. Those rules therefore fail with `unresolved_action` instead of running
through a cache-oriented execution path. The explicit install link layer uses
an irreversible tier because its ignored files are not snapshot-restorable.

## 5. Dependency installation

Installation is one flow of three actions in a single round:

```text
Measure({}) -> Fetch[manager]({ content }) -> Link({ content, store })
```

The split keeps planning pure, and the flow runs in one round. The manager is a
plan-time declaration carried in the payload, so the body selects exactly one
manager-specific action and lockfile declaration without measuring anything
first.

This used to be two trampoline rounds. The package-manager service is a
runtime layer, so a pure body could not branch on it, and round one existed
only to turn the wired manager's identity into ordinary payload. Declaring the
manager in PACKAGE.ts removes the reason for the trampoline.

### 5.1 Measured content, declared identity

`Measure` reports content and only content:

- the manager lockfile path and SHA-256 digest;
- the project `.npmrc` path and digest, or `null`.

Manager identity, manager version, and platform are not content. They are the
identity of two services and come from them: `PackageManager` answers for which
manager and which version the workspace requires, and `Runtime` answers for the
interpreter and the platform. Each holds the host to the declared version
through its own `verify`.

Lockfiles, manifests, and `.npmrc` are read through bounded,
descriptor-stable, exact-UTF-8 readers. Before fetch and before link, the
implementation checks the provided layer for internal consistency, its lockfile
name and store directory against what its own manager name implies, and both
declared versions against the host. Link additionally recomputes the store
manifest from the measured content and refuses a store fetched for anything
else. A mismatch fails with `environment_mismatch` rather than using a key
minted for a different world.

Checking the _declared_ manager against the provided layer is deliberately not
done here. `d191c9dfcf` removed that guard because nothing installed it, and
because the check belongs at whatever composition root wires a layer against a
declaration rather than inside a sealed action that receives only the layer.

Literal credentials in `.npmrc` are refused. Environment placeholders are
allowed only as the whole value of a registry-scoped credential setting
(`//host/:_authToken`, `_auth`, `_password`, `username`) whose host is on the
operator's `credentialHosts` list (default `registry.npmjs.org`; the build CLI
reads `SMITHERS_NPM_CREDENTIAL_HOSTS`), because the repository writes that host.
`.npmrc` is parsed the way pnpm's `ini` decoder parses it (`\r` line breaks,
`JSON.parse` for quoted values), because any divergence hides a setting. While
a credential is forwarded, project proxy, TLS, and CA settings and non-https
registries are refused, and fetch and link pin those settings on the command
line to the operator's values, the only source that outranks
`pnpm-workspace.yaml` in pnpm 10.
Process-control variable names are refused. pnpm hooks are pinned to the measured default hook file
(`.pnpmfile.mjs`, else `.pnpmfile.cjs`)
(`--pnpmfile`, `--global-pnpmfile=`), or disabled with `--ignore-pnpmfile`.
Only the hook file's own bytes are digested; modules it imports run
undigested and do not move the store manifest. Child commands receive an
allowlisted environment snapshot with user/global npm configuration disabled;
the complete host environment is never inherited.

### 5.2 Fetch and link boundaries

| Action                                   | Tier           | Boundary   | Cross-run admitted |
| ---------------------------------------- | -------------- | ---------- | ------------------ |
| `smithers-build/install/measure`         | `sealed`       | `expected` | No                 |
| `smithers-build/install/fetch/{manager}` | `sealed`       | `expected` | No                 |
| `smithers-build/install/link`            | `irreversible` | `expected` | No                 |

Fetch declares `.flows/store/<manager>` as a `TreeArtifact` output and returns
a `StoreManifest` digest over canonical environment identity. The current
package-manager process, however, opens files itself from an absolute project
root. The parent can verify a lockfile before and after the command but cannot
freeze the path while the child opens it. A hard boundary would therefore be a
false claim, so the tree is not replayed from a shared engine cache.

Link materializes host-local `node_modules`. Each new run reconciles it; a
completed durable attempt replays within its existing run. Ordinary snapshots
omit ignored dependency trees, so claiming compensation would promise a
rollback they cannot perform. Link is `irreversible`, not `sealed`, and has no
automatic retry or uncertain-crash recovery contract. A manager's hidden
lockfile or modules manifest describes intended topology but cannot prove that
every installed file still exists and is unmodified. The returned link digest
combines the store identity, root package manifest, and manager evidence for
diagnostics; it is not a freshness marker that skips reconciliation.

### 5.3 Manager support

| Manager | Status      | Fetch/link behavior                                                             |
| ------- | ----------- | ------------------------------------------------------------------------------- |
| pnpm    | Implemented | `pnpm fetch`, then offline frozen `pnpm install`, both with scripts disabled    |
| Bun     | Unsupported | No documented fetch-only plus offline-link pair strong enough for this contract |

`PackageManager.Name` is `pnpm | bun` and nothing else, so npm and Yarn are not
unsupported selections: no declaration can name one. The Bun row is the only
unsupported selection, and it is a deliberate typed service rather than a
missing provider. It answers every operation with
`PackageManagerError { code: "unsupported" }`.

The store path is fixed at `.flows/store/<manager>`. Consequently the direct
`install` command requires the default `.flows` cache-directory setting.

## 6. Target result cache

The CLI cache stores a target's schema-encoded success value, not an engine
step journal and not output artifacts. Local entries are addressed by the
planner content key under `<cacheDirectory>/cache`.

Every entry boundary is defensive:

- keys are bounded and mapped to safe path segments;
- local files must be stable, single-link regular files beneath the cache root;
- reads are size-bounded and exact UTF-8;
- result objects and output JSON are descriptor-only, structurally bounded,
  cycle-free snapshots;
- timestamps are canonical ISO strings;
- the stored key, rule id, and target label must match the request;
- writes use an exclusive sibling temporary file, file fsync, atomic rename,
  and directory fsync where the platform supports it.

A remote endpoint adds a read-through `/ac` tier. Request and body deadlines
are real races, so a fetch or stream that ignores abort cannot hang the run.
Declared and observed body lengths, byte counts, UTF-8, chunk counts, JSON
shape, envelope key, and server key limits are checked. One remote failure
warns and degrades to local-only. A `409` means first-writer conflict and does
not disable reads.

## 7. Shared cache protocol

Hosted and self-hosted services implement the same routes:

| Route                        | Purpose                                      |
| ---------------------------- | -------------------------------------------- |
| `GET/PUT/DELETE /ac/{key}`   | Action-cache documents and fenced deletion   |
| `GET/PUT/HEAD /cas/{sha256}` | Content-addressed artifacts                  |
| `POST /cas/findMissing`      | Ordered, deduplicated artifact probes        |
| `GET/HEAD /healthz`          | Public storage readiness without cache state |

Authentication uses a bearer verifier; unauthorized responses carry a Bearer
challenge and never reflect credentials. Health is public so container and
platform probes can check readiness without receiving a data credential.

The protocol applies exact paths, content types, UTF-8, key/digest formats,
JSON depth/member/canonical-size limits, request byte/chunk limits, and
route-specific concurrency limits. Refused bodies are cancelled without
waiting for a hostile cancellation promise. Storage return values are treated
as untrusted and validated before they become HTTP responses. Storage failures
are `503`, never false misses.

Action-cache publication is first-writer-wins. Conflict comparison uses the
`result` member only when both `keyDigest` and `result` identify a real envelope;
otherwise it compares the whole document. Canonical rendering sorts object
members and rejects accessors, sparse arrays, cycles, lossy numbers, malformed
Unicode, excessive depth, and excessive width. The first writer's original
JSON is preserved for reads.

Artifacts are published only after their SHA-256 matches the route. The hosted
R2 adapter also requires stored checksum metadata to match before serving a
blob. The absolute artifact ceiling is 16 MiB.

## 8. Deployment durability

The self-hosted service uses Postgres for metadata and artifact bytes. Per-key
advisory locking makes `201`, `200`, and `409` classifications stable through
commit. Eviction functions lock candidates with `SKIP LOCKED` so they do not
race publication.

The hosted service uses D1 for action rows and R2 for artifacts. Migrations
bound existing and future action rows as well as canonical discriminators.
Database and object-store adapters validate row types, sizes, canonical form,
and checksums before serving them.

Deployment state may contain infrastructure credentials even when ordinary CLI
output marks them sensitive. The hosted deploy wrapper always runs bounded,
descriptor-stable redaction after success, failure, or forwarded termination.
Redacted state is published atomically with file and directory durability
barriers.

## 9. Known limitations

1. **No general sandbox.** Effects declarations do not confine arbitrary tools.
2. **No shared install replay.** All install boundaries remain `expected`.
3. **Only pnpm installation.** Bun, the one other manager a declaration can
   name, is refused when an install is configured with it.
4. **Whole-lockfile granularity.** There is no rules_js-style per-package fetch
   graph yet.
5. **Lifecycle scripts disabled.** Arbitrary dependency code needs a separate,
   non-sealed execution model.
6. **Engine remote artifacts not composed by the CLI.** The CLI uses `/ac` for
   target JSON results; embedding hosts must wire engine step/artifact layers.
7. **Irreversible actions gated.** Release mutations require an explicit
   executor with a different retry and approval policy.

Changing any item requires changing the implementation, adversarial tests, and
this document together.
