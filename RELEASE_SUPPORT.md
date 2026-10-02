# Library release and compatibility policy

The public packages currently form one `1.0.0-rc.1` candidate. An RC is not a
stable 1.0 compatibility or long-term support commitment. Publish it to `next`
only after the release workflow passes for the exact commit on `main`. Builds
and tests from another revision, a dirty checkout, or another dependency graph
do not certify that candidate.

## Public API scope

All explicit, non-null package export paths are public. Paths under `internal/`
are private. A root export and a subpath export of the same service must resolve
to the same runtime identity. These categories explain intended use, rather than
claiming equal production maturity across the catalog:

| Category | Packages and entrypoints |
| --- | --- |
| Application authoring and operation | `@smthrs/cli`, `@smthrs/flows`, `@smthrs/flow`, `@smthrs/agent`, `@smthrs/std`, `@smthrs/build`, `@smthrs/build-cli`, implemented `@smthrs/targets` rules |
| Advanced integration contracts | `@smthrs/artifacts`, `@smthrs/canonical`, `@smthrs/capability`, `@smthrs/control`, `@smthrs/core`, `@smthrs/crypto`, `@smthrs/database`, `@smthrs/engine`, `@smthrs/engine-store`, `@smthrs/errors`, `@smthrs/evals`, `@smthrs/gateway`, `@smthrs/harness`, `@smthrs/integrations`, `@smthrs/jj`, `@smthrs/journal`, `@smthrs/kernel`, `@smthrs/keys`, `@smthrs/mcp`, `@smthrs/memory`, `@smthrs/model`, `@smthrs/notifications`, `@smthrs/observability`, `@smthrs/patterns`, `@smthrs/plan`, `@smthrs/platform-node`, `@smthrs/plugin`, `@smthrs/registry`, `@smthrs/run-store`, `@smthrs/sandbox`, `@smthrs/scorers`, `@smthrs/step-cache`, `@smthrs/sync`, `@smthrs/testing`, `@smthrs/time-travel`, `@smthrs/triggers` |
| Preview hosts | `@smthrs/platform-browser`, `@smthrs/platform-bun`, and `@smthrs/flows/BunRuntime`; each requires its own host acceptance evidence |
| Migration only | `@smthrs/migrate` and the `smthrs` deprecation package |
| Unsupported execution | `Npm.Publish`, `Changesets.Publish`, `Github.Release`, `Github.Pages`, `Git.Pr`, `Github.Pr`, `Npm.Downstream`; declarations exist, but the package executor always refuses these operations |

Advanced integrations must follow the owning package's composition, resource
ownership and persistence contracts. Importability alone does not prove that a
host provides the capabilities an adapter needs. In particular, construct the
filesystem artifact store on the trusted persistence host before decorating
workflow filesystem services with the permission kernel. Native `layerHost`
already makes this separation. See the [artifact host contract](packages/smithers/flows/artifacts/README.md).

## Runtime and dependency support

The required release platform is Linux. The release workflow exercises Node
26.4.0 as its certified floor with npm and pnpm consumers.
The `engines` lower bound is not certification of every later Node release.
macOS checks are advisory. Hardened native filesystem confinement requires a
trusted Python interpreter and descriptor-relative POSIX operations; Windows
does not provide that adapter's confinement contract. Browser and Bun support
must be claimed per capability, not inferred from the native Node tests.

Effect and its RC adapters are one compatibility unit, currently
`4.0.0-rc.115`. Keep exact application pins and commit the application's lockfile.
Upstream adapters contain transitive version ranges; a direct Effect pin alone
does not prevent an incompatible newer adapter from being selected. For
reproducible fresh resolutions, constrain the entire Effect family using the
application package manager's overrides, following this repository's
`package.json` (npm/Bun) or `pnpm-workspace.yaml` (pnpm). Re-run the minimal
consumer profiles whenever an adapter or lockfile changes. Overrides in this
repository do not propagate into a customer's application.

Dual-module packages ship separate ESM and CommonJS declarations. The installed
consumer gate checks `.mts` and `.cts` clients under TypeScript `Node16` and
`NodeNext`; explicitly ESM-only subpaths remain ESM-only. The gate uses
`skipLibCheck` for upstream declarations, so it does not certify every type in
every transitive dependency.

The CLI installs both Node and Bun transport adapters because its executable
selects the current native host. Library-only installs keep those host adapters
optional; selecting `@smthrs/gateway/bun/BunGateway` requires the Bun peer.

## Changes from earlier development candidates

The current declaration baseline replaces the earlier, unreleased diagnostic
candidate. The CLI subpaths `evaluation/Cli` and `history/Legacy` have been
replaced by `evaluation/EvalCli` and `history/ExecutionTarget`. New explicit
subpaths include `model/ModelCatalog`, `engine-store/EventTypes`,
`gateway/bun/BunGateway` and `targets/test-support/plan`, each under its owning
`@smthrs/` package.

Custom seat resolvers must supply `Seat.modelId` as well as the declared seat
`id`; it identifies the resolved model in generation and compaction. Native
gateway layers expose the HTTP server and require their documented control,
projection and synchronization services. Applications should provide other
platform services explicitly instead of relying on incidental layer outputs.

Artifact implementations and action errors have moved into smaller modules.
Their existing public barrels retain the exported constructors and service
identities. Private emitted declaration paths are included in the baseline for
type resolution, but are not supported import paths.

Background flow submission does not establish that a run has parked. Before
rewinding a live composition, observe its durable suspended state and stop the
caller's automatic resume loop. Inspection remains read-only. Durable clock
timestamps are integer milliseconds; sampled fractional clocks are normalized
at persistence boundaries, while caller-supplied timestamps remain validated.

## MVP compatibility changes

The approved [MVP scope cut](https://github.com/smithersai/smithers/issues/3385)
removes `@smthrs/create-app`, the build CLI's `CreateApp` export and app generator,
public repository fork/transfer and cross-repository changeset commands, and
non-GitHub provider subpaths from `@smthrs/integrations`. Consumers of those
surfaces must stop importing or invoking them before adopting this candidate.
Existing stored failure codes, schema migrations and internal repository
machinery remain available for historical data and recovery.

Review runs as an ordinary `review` flow through the configured host; its old
standalone worker and command distribution are retired. Native desktop and
Cloud desktop distribution, user-facing time-travel controls, the model lab
and predictive TUI estimates are outside this MVP. Core time-travel, build,
agent, model and memory libraries remain supported authoring surfaces.
`AgentAction` gains an optional fixed or payload-derived timeout, composed
within the existing host action; omitted timeouts preserve existing behavior.

## Reviewing changes before publication

After `node scripts/build-release.mjs`, run
`node scripts/check-api-baseline.mjs`. The baseline includes publication export
maps and every emitted declaration, including private declarations referenced
by public types. It detects drift; it does not determine semantic compatibility.
For a deliberate change, review the declaration diff and consumer examples,
record the compatibility impact in release notes, then explicitly regenerate
with `node scripts/check-api-baseline.mjs --update`. Never update a baseline just
to make a failed release gate green.

Before a stable release, retain immutable databases, journals and artifact
fixtures produced by the previous published tarballs. Record their package
versions and integrity hashes, then test migration, resume of pending waits,
replay and refusal of incompatible histories using the next tarballs. Fixtures
reconstructed entirely from current source do not establish upgrade support.
For the initial RC, distinguish fresh-store/restart evidence from an unproven
upgrade path. Upstream Effect persistence schemas require their own migration
evidence when changing the Effect family.

The rc.112-to-rc.115 comparison preserves the tested plain structural schema
identities, but upstream predicate implementations and annotations changed.
Effect's serialized schema representation also omits the default union mode,
changing sealed action keys. Archived fixtures retain both dependency versions'
material and checksums. Do not
claim transparent resume across that upgrade; finish or archive existing runs
under their original dependency lock and start new runs under this candidate.

Shared build mechanics live in
`packages/repo-targets/scripts/build-library.mjs`. Package scripts should supply
only necessary options or asset handling. Changes to either shared build helper
are declared inputs of the repository's package build targets. Keep real host
composition tests alongside the shared test filesystem: a permissive mock must
not become the only evidence for durability or filesystem confinement.

Large runtime modules should be split along cohesive state transitions or host
adapter boundaries in separate changes with existing contract tests intact.
That structural work is not a substitute for today's fresh-install, lock
contention, crash/restart, permission and public-consumer release gates.
