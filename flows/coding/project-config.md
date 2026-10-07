# Configuring the workspace coding host

The self-hosted install stores default checks, wiki pages and model seats in
`install_settings` when Source becomes ready. It reads only pinned-main data;
it never commits generated configuration to the repository.

At host admission, fields from `main:.smithers/coding-project.json` replace
stored fields. `seats` merges by role. The merged snapshot is retained for the
TODO attempt and transported as data to the unprivileged guest, which writes
an exclusive private JSON file and loads it through `SMITHERS_CODING_PROJECT`.
Restart recovery keeps that snapshot; a new attempt takes the current main
configuration. No repository-selected path participates in the write.

A standalone host loads `<root>/.smithers/coding-project.json`, or the explicit
`SMITHERS_CODING_PROJECT` file. Missing, malformed and unknown fields in an
explicit file refuse startup. Configuration is read once before construction.

Both the config filename and optional `wikiOutput` resolve relative to `--root`; absolute
paths are accepted. The output may point at the separate wiki repository. JSON
is limited to 256 KiB of actual streamed bytes. Unknown properties are refused,
including nested page/check properties. Wiki page IDs and check IDs must be
unique; related page IDs must be present. The existing wiki recipe still owns
source path admission, publication and semantic verification.

```json
{
  "wiki": false,
  "implementation": "coding/implementation",
  "checks": [{
    "id": "types",
    "target": "types",
    "flow": "checks/types",
    "tier": "fast",
    "required": true
  }],
  "historyLimit": 100,
  "maxMemoryBytes": 49152
}
```

The install enables Wiki with an overview, architecture and up to eight
package pages, published in the guest-owned `/var/tmp/smithers/wiki`. Install-generated `PageSpec` entries use `sourceDirectory`;
the guest expands public source files at each refresh and renders source-linked
exports through the existing review and publication pipeline. Symlinked
directories, private inputs and inventories over 256 entries refuse. Explicit
repository pages retain their existing document and input semantics.

The example names must identify real registered implementation/check flows in
that repository. This file does not define shell commands or accept claimed
flow digests; the existing catalog supplies verified execution identities.
`reviewer` identifies the semantic review policy, not a provider credential or
a claim that review already passed. Page entries use the existing wiki
`PageSpec`; check entries use the existing `Check` without `flowDigest`.
`conflictAttempts` accepts integers from 0 through 8; an explicit 0 is preserved.
`historyLimit` is optional (1–100, default 100). `maxMemoryBytes` is optional
(1024–92160, default 49152). A project with no adequate required checks still
fails the existing planning/validation policy; the loader invents none.

## Built-in configuration

The install consumes the machine detector's package manager and file evidence.
It stores package scripts `test`, `lint`, `typecheck`, `build`, then the first
language test (`go test ./...`, `cargo test`, or `pytest`). A pnpm repository's
scripts run as `pnpm test` and `pnpm lint`. Each becomes a required built-in
check body `{argv, cwd: ".", timeoutMs: 1800000}`. Planning requires one check.

Without a detected command the install registers `checks/build-only`. An
absent executable build command fails with `check_configuration` and
"no checks detected"; it cannot record a pass. The configured check is part
of every candidate's checks, including rebased candidates.

Every built-in model role starts at `auto`. Owner model access remains in
`agent:<role>` settings. Repository role keys replace stored seat keys without
replacing the remaining roles. The install does not inject
`SMITHERS_CODING_SEATS`.

## Landing

`landing` selects how `coding/vibe` lands on a host that has no provisioned
repository binding: `"fast-forward"` runs the declared checks on the cleaned
tip merged onto `main` as one commit and moves `main` to it, or evicts it with
the reason; `"pull-request"` pushes that commit to `origin` as
`smithers/landing-<request>`, opens its GitHub pull request with `gh`, waits
for the required checks and squash-merges unless branch protection keeps it
open. A host with the provisioned binding lands through the backend and
ignores this key. See [finalization.md](finalization.md).

## Seats

`seats` maps a role id to a seat alias (`sol`, `luna`, `opus`, `sonnet`,
`fable`, `kimi`, `qwen`), an explicit `provider:model`, or `auto`, for example
`{"coding/implement": "auto", "coding/plan": "opus"}`. A declared role wins over
the `SMITHERS_CODING_*_MODEL` defaults; `SMITHERS_CODING_SEATS` (a JSON object of
the same shape) is the operator's override over both. The seat's provider picks
the subscription the workspace binds: `openai:` the ChatGPT connection,
`anthropic:` the Claude connection, directly or through the account pool.

`auto` routes the role by the routing graph (`@smthrs/agent/SeatRouter`): Jev
reads each step's prompt once, the graph picks the seat and its backups from
the seats the host can run, and the run journals the route. A built-in role
routes as its phase: `coding/implement`, `coding/poc`, `repository/author` and
`flow/author` as implementation, `coding/plan` as planning, `coding/review`,
`wiki/reviewer` and `repository/evaluator` as review, and `repository/research`
as other work; `coding/dispatch` and a repository's own role leave the phase to
Jev. When `coding/implement` is `auto` and nothing names `coding/review`, the
review routes by the graph too. This repository routes every coding role this
way.

`jev` is refused as a seat: Jev answers classifier questions through the host
evaluator, as in the `coding/JevCheck` lint check, and never runs an agent turn.
The evaluator asks Jev through the AI Gateway and asks GPT-6 Luna only when Jev
is unconfigured, unreachable, times out, or stays unavailable through its
retries. An invalid
verdict fails the check.

```sh
SMITHERS_CODING_PROJECT=/etc/smithers/project.json \
SMITHERS_CODING_IMPLEMENT_MODEL=provider:implementation-model \
SMITHERS_CODING_PLAN_MODEL=provider:planning-model \
SMITHERS_CODING_POC_MODEL=provider:prototype-model \
SMITHERS_CODING_WIKI_MODEL=provider:wiki-review-model \
SMITHERS_CODING_REVIEW_MODEL=provider:review-model \
smithers-coding-host serve --root /home/developer/workspace
```

`SMITHERS_CODING_IMPLEMENT_MODEL` pins the implementation model. When it is unset,
the host picks a default from the connected account pool at startup (see
[host.md](host.md)), then uses the provisioned platform fallback, if present.
Without either, startup is refused.

The optional plan, POC and wiki
variables select the existing logical seats `coding/plan`, `coding/poc` and
`wiki/reviewer`. When omitted, the host explicitly uses the implementation model
for that role, unless the project's `seats` names it. The review variable
selects `coding/review`, the seat every `coding/ReviewCheck` lens runs on; when
omitted, the host picks the first seat alias on a provider other than the
effective implementer's, so a change is never reviewed only by the model that
wrote it. Every selection must be a
seat alias or a `provider:model`; this configuration
does not add credentials or a broker. Existing workspace/user provider setup
supplies authentication. Deployment still supplies the owning
`SMITHERS_GATEWAY_ID`, gateway `SMITHERS_API_KEY`, and existing binding/single-host
lock. `PATH` remains the explicit environment for declared check executables.

The loader adds no public package API, service, database or gateway payload.
Its private `ProjectConfig` is the existing memory configuration plus the wiki
reviewer identity. Operator data is never accepted from model output or a
gateway request. Startup diagnostics identify the invalid contract without
printing the JSON contents.

This Smithers repository declares its own configuration in
`.smithers/coding-project.json`: the policy and runtime checks are required
fast gates; native Node/Bun and deployment bundle Node/Bun run as required slow
checks; lint is advisory; and the `pages` array is the one wiki page catalog, which the Cloud
refresh and `flows/wiki/main.ts` both read. The ordinary `checks/*`
declarations contain only target invocations, not copied test lists. The host
must provide `smithers-build`, the declared toolchain, native helpers and build
cache through its existing command environment. An immutable source export does
not borrow the editing checkout's node_modules. Cold toolchain/bootstrap cost
may make the blocking target slow; its label is policy, not a latency receipt.
The configuration carries no provider credentials or private Ops data.
