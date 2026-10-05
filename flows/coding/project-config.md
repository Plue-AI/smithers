# Configuring the workspace coding host

This is private deployment configuration for `smithers-coding-host`, the separate
workspace executable. The ordinary Smithers CLI keeps its existing commands.
The host uses the same Effect composition and durable engine on Node and Bun.

The host loads `<root>/.smithers/coding-project.json` when it exists and
`SMITHERS_CODING_PROJECT` is unset. Set that variable to an explicit UTF-8 JSON
file to override the default. An absent default uses the built-in
configuration below; an empty, missing, malformed or invalid explicit file refuses
startup. An invalid default also refuses startup and names its path. The file
is read once before host construction through the injected Effect filesystem.
Restart the host to adopt a changed configuration or catalog.

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

Wiki is off by default. Source files, existing project documents and resolved
native JJ history provide planning context without generated artifacts. To
enable Wiki, add `"wiki": true`, an external `wikiOutput`, a `reviewer` identity,
and the non-empty `pages` inventory using the Wiki `PageSpec`. Supplied optional
metadata is still validated while the feature is off. This flag leaves native
history, source identity and validation invariants intact. An explicitly required
`checks/wiki` refuses while Wiki is off; update that operator policy deliberately.
Optional generated-Wiki checks are omitted while the feature is off.

The example names must identify real registered implementation/check flows in
that repository. This file does not define shell commands or accept claimed
flow digests; the existing catalog supplies verified execution identities.
`reviewer` identifies the semantic review policy, not a provider credential or
a claim that review already passed. Page entries use the existing wiki
`PageSpec`; check entries use the existing `Check` without `flowDigest`.
`historyLimit` is optional (1–100, default 100). `maxMemoryBytes` is optional
(1024–92160, default 49152). A project with no adequate required checks still
fails the existing planning/validation policy; the loader invents none.

## Built-in configuration

A repository with no Smithers declarations still serves coding requests
(mvp.md J1.4). With no file, and for each of `implementation` and `checks` a
file omits, the host uses:

- `implementation`: `coding/implementation`.
- `checks`: one required check per command the repository-registration
  detector (`checkCommands`, `flows/register-repository/tree.ts`) finds, in its
  order.
- `wiki`: `false`.

Detection reads only `package.json`, `Makefile`, `Cargo.toml`, `go.mod`,
`pyproject.toml`, `setup.py`, `pytest.ini` and the package-manager lockfiles at
`--root`, and runs nothing. Each detected command becomes the check `<kind>`
(`test`, `lint`, `typecheck` or `build`) on the built-in flow `checks/<kind>`,
which the host writes beside its other built-ins with the body
`{"argv": [...], "cwd": ".", "timeoutMs": 1800000}`. Lint, typecheck and build
are fast checks; test is the slow check. A Go repository gets `go test ./...`,
`go vet ./...` and `go build ./...`; a pnpm repository with `test` and `lint`
scripts gets `pnpm run test` and `pnpm run lint`. A field the file declares,
including an empty `checks`, always wins. Planning takes any number of checks:
a repository with only a `test` script plans with that one slow check, and one
with no detected command plans with none (mvp.md J1.4).

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
