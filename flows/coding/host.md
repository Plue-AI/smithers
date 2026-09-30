# Configured coding host

`host.ts` is this repository's private deployment recipe. It composes the existing native Control host, executable catalog, `AgentAction`, QuickJS sandbox, packaged JJ helper and immutable command checks. It is not a public coding service, database, gateway extension or second executor.

The same Effect composition runs on Node and Bun. The concrete adapters supply filesystem, path, subprocess containment, crypto, SQLite, model transport and HTTP. No Node sidecar is required on Bun. Runtime-specific imports stay at the executable boundary; repository workflows do not select a runtime.

The `coding/implement` role must map to a seat alias (`luna`, `sol`, ...) or an explicit `provider:model` through the existing `SeatResolver`; the project's `seats` map may route any role. Workspace/user provider configuration supplies authentication. The host does not copy platform seat credentials into the workspace process. Set `SMITHERS_CODING_IMPLEMENT_MODEL` to pin the model. When it is unset, the deployment entry queries the configured account pool at `GET <pool>/routes` on each host start, choosing `chatgpt` → `openai:gpt-6-luna`, limited to `SMITHERS_ACCOUNT_POOL_PROVIDERS`. Claude subscriptions run only through the user's own Claude Code; the backend offers no Anthropic pool route or subscription bearer credential. Direct Anthropic model API calls use `ANTHROPIC_API_KEY`. When no pool model is available, the host uses the provisioned `SMITHERS_CODING_FALLBACK_MODEL` platform default, if present. Without either, startup is refused; a blank or invalid explicit pin remains refused without fallback. Accounts connected after workspace boot are therefore available at the next unpinned host start. The owning `SMITHERS_GATEWAY_ID` is required; the existing `SMITHERS_API_KEY` authenticates the gateway. These are operator configuration, never fields accepted from a plan.

The private deployment entry passes that same operator credential to the existing
native control composition. The recipe explicitly selects its existing gateway approval
delegation as well as authenticating HTTP. Programmatic composition can supply
the existing `Application.Config.approvalAuthority` for a narrower policy; it
takes precedence. Startup requires a nonempty credential or an explicitly supplied
authority even on loopback: local check processes must not inherit unrestricted
operator approval merely because HTTP authentication was omitted. These are
private host options, not new control APIs, and do not change ordinary CLI
`ControlBridge` delegation policy. The native request acceptance exercises
plan, approve, run and steer through real bearer-authenticated HTTP; its local
watch only collects the resulting journal evidence. Its explicit Plan/once-only
authority also proves that run/remembered scope requests are refused over HTTP.

The executable accepts the existing command shape:

```sh
smithers-coding-host serve --root /home/developer/workspace --host 0.0.0.0 --port 7331 --listen
```

The host reads `<root>/.smithers/coding-project.json` by default for
`coding/request`; `SMITHERS_CODING_PROJECT` overrides that path. Cloud uses
this host-side lookup, so the backend does not pass a project path. With the
provisioned landing binding and reserved `SMITHERS_JJHUB_TOKEN` and
`SMITHERS_JJHUB_API_URL`, the same launch also registers `coding/vibe`; so
does a project `landing` of `fast-forward` or `pull-request` on a host without
that binding, landing with `jj`, `git` and `gh` from `PATH`
(see [finalization.md](finalization.md)).
With a project it also registers `factory/Todo`, which routes each stack request (a TODO) on Jev before it is planned (see [todo.ts](todo.ts)), and `coding/verify`, which the mythical stack runs
on rebased candidates, and `coding/wiki` when the project enables its wiki: the stack
runs it after every fold to refresh and review the declared pages.
These routes ship as host built-ins beside `coding` and `coding/implementation`,
so a repository needs only its project file and never a `flows/coding/` tree; a
repository's own flow of the same name wins.
See [project-config.md](project-config.md) for missing and invalid file behavior.

`--help` and `--version` work before opening the repository or resolving provider credentials. The same `Serve.refuse` policy requires a credential and explicit `--listen` for a non-loopback bind. The Plue service owns its workspace lifetime lock and process scope.

## Host state directory

`--root` is a live JJ working copy, and the durable layers put `control.db`,
`engine.db` and their `-wal`/`-shm` companions under a `.flows/` directory of
whatever root they are given. JJ auto-tracks new files, so an in-root `.flows/`
made every engine write an edit to the code the host was planning against:
`jj status` reported `A .flows/control.db`, the working-copy tree digest moved,
and on 2026-09-15 `coding/PreparePlan` failed three seconds after start with
`{"_tag":"coding/Error","code":"stale_revision","message":"Native code changed
during planning or clarification; gather and plan again"}`.

Host state therefore resolves outside the working copy. `--state-dir <path>`, or
`SMITHERS_CODING_STATE_DIR`, names it; a relative path resolves from `--root`.
Nothing named means `<parent of root>/.smithers-coding-state/<basename of root>`,
so `--root /home/developer/workspace` keeps its databases in
`/home/developer/.smithers-coding-state/workspace/.flows/`. A root with no parent
of its own falls back to `$XDG_STATE_HOME/smithers/coding/<hash of root>`. The
directory is created `0700` before any layer opens a database, and the
provisioner needs no flag change to get the new location.

A state directory that resolves inside `--root` is refused at startup by name,
including one an operator passes explicitly. `SMITHERS_CODING_STATE_IN_ROOT=1`
is the documented opt-in back to the pre-fix `<root>/.flows` layout, for a local
single-repository run whose ignore file already covers `.flows/`. Only the
databases move: the flow registry, the grant store, checks and every change atom
still work under `--root`.

Node model requests honor `HTTP_PROXY`, `HTTPS_PROXY` and `NO_PROXY` (lowercase
forms take precedence), including after a transport pool rebuild. An unconfigured
host retains its direct Undici agent. Workspace deployments can therefore use
Plue's existing proxy-bound repository secrets: the guest holds a named
placeholder while the egress proxy substitutes the credential only for the
configured host/header. For example, `SMITHERS_CODING_IMPLEMENT_MODEL=cerebras:qwen-3.8-27b`
uses `CEREBRAS_API_KEY`, bound to host `api.cerebras.ai` and header `authorization`.
Assign that credential through the repository's agent-environment secret route;
do not put its value in ordinary environment variables or the setup script.

`node flows/test/canary-coding-setup.mjs /tmp/canary-coding-setup` prepares a
self-contained setup script for the documented canary fixture. It registers the
real coding/request flow and Markdown checks without installing packages in the
workspace. Its acceptance test deliberately fails the initial README until the
requested Purpose section exists, and rejects broken relative Markdown links.
These checks validate documentation, not an application test suite. The generated
project configuration is selected with
`SMITHERS_CODING_PROJECT=.smithers/coding-project.json`.

`coding-plan/v1` is advertised only after the configured catalog includes `coding` and `coding/implementation` with their expected native delegates, and the packaged helper verifies the repository's provisioned native binding. Conflicted JJ state refuses startup. The gateway reports the existing protocol version and workspace hash, plus the owning gateway row ID. The ordinary CLI does not advertise this capability.

Providing the private `planning` operator configuration also enables
[`coding/request`](request.md) and its `coding-request/v1` health capability.
This composes source/native-history preparation, source admission and correction.
It returns their recorded `Plan` and product outcome through the normal Control
operations. `coding/prototype` is a separate disposable POC entry; a real fix
never requires it. Wiki generation and semantic review register only with
`planning.wiki: true`, which also requires its page, output and reviewer metadata.
The same verified catalog is injected into those action layers before they
register. Planning, prototype and wiki review receive their configured
`planningModel`, `pocModel` and `wikiModel`, each falling back to the explicit
implementation model, through the existing seat resolver. All these model roles
use the evidence-only authority recipe. When Wiki is enabled, its required `reviewer` policy,
and selected wiki model participate in review reuse identity. The same identity
includes the running host's review task: a digest of the wiki review policy
sources (`policySources` in `flows/wiki/reuse.ts`). Source mode reads them
beside its own module; the deployment bundler computes the same digest and
embeds it in the artifact. Nothing else in the host build is covered, so a host
deploy that leaves the review task alone keeps prior reviews reusable. It does
not read the target repository to identify the running host. Target source captures
still independently invalidate affected pages, and reused reviews still pass
the current assessor. Source hosts must restart after their recipe changes.

The configured wiki output must resolve outside the canonical source workspace,
including outside `.flows`. Relative operator paths are resolved from the source
root; use a sibling or separate wiki directory. Existing parent symlinks are
resolved before any write, dangling links are refused, and the resulting
canonical path is bound to the host. This prevents generated publication from
being included in a later JJ implementation snapshot. Project JSON and direct
private host composition apply the same check.

Catalog imports need the existing trusted host filesystem to load verified declaration bytes through a temporary sibling module. Deterministic wiki publication and memory verification also use that injected host filesystem for the operator's configured paths, with the owning wiki's canonical source/output and semantic checks. The model receives captured evidence only. Resulting agent registrations use the original guarded context. Immutable checks separately capture the trusted filesystem only for host-owned scratch creation and cleanup; their processes retain the contained, guarded spawner. Agent file tools retain their workspace guards.

Every native handler traverses recorded parent edges to its one active, approved Control root. It receives the existing `AgentAction.Host` with that root's approved capability envelope, along with the shared budget and quota policy. Construction-time services grant no execution authority. The real standard tool catalog is shared with `AgentSession`.

Steering uses `Notifications.make` over the captured Control notification queue. It is addressed to the approved root, including after a cold descendant resume. Drain boundaries combine the native execution ID with the agent's frame boundary, so two descendants cannot accidentally replay each other's drain. Native usage and execution evidence remain in the native journal; Control lifecycle and steering remain in their existing stores.

The default queue delivers a root steer to its first consuming boundary and does not broadcast it. When the operator enables `coding/request`, the private queue decorator routes root Messages to that request's coordinator. Model settings and explicit leaf messages keep their existing behavior. The coordinator receives messages before implementation and after correction, then materializes a fresh source-bound plan before another mutation. Each admitted handler binds its verified root source once, avoiding a fresh ancestor walk and disk read on every frame. See [request.md](request.md) and [steering.md](steering.md) for the durable receipts, limits and current final-drain boundary.

The host catalog is pinned for its process lifetime. Deploying a changed executable definition requires restarting the host. A source change after approval explicitly fails the old plan; restarting cannot make that old approval describe the new source. An ordinary host without the configured catalog leaves native module runs parked.

The native acceptance fixture uses a scripted model behind the existing `SeatResolver`, while exercising the actual `AgentAction`, QuickJS cell, guarded write, packaged helper, immutable checks and durable Control/engine journals. This distinguishes executable evidence from an agent's claimed summary. Both required fast and slow checks must inspect the implemented revision before validation succeeds.

## Deployment artifact

`node flows/coding/build.mjs /path/to/smithers-coding-host` uses the repository's existing esbuild dependency to emit one executable ESM file. It fits Plue's current gzip/base64 single-executable staging path. The Node shebang selects the default runtime; `bun smithers-coding-host ...` uses the Bun adapters in the same artifact. A build-only lazy wrapper keeps the Bun SQLite builtin behind the existing dynamic platform import, preventing an eager Node import of `bun:sqlite`. It changes no SQL or gateway protocol.

QuickJS's existing single-file variant is bundled. SQLite remains the runtime's native builtin, and process containment programs remain their existing embedded source. Plue separately provisions JJ, the owning coding configuration and the packaged `smithers-jj-export` workspace helper. Declared repository modules resolve their own project dependencies as usual, except `effect` and the `@smthrs` packages the host runs: their public entry points resolve to the host's bundled instances (`host-modules.ts`, built by `host-modules-build.mjs` from the modules the host evaluates at start), because the host decodes a flow's schemas, graph and errors with its own copies. An entry point of such a package that the host does not run is refused, not loaded as a second copy. This artifact is private deployment composition.

The coding host requires `SMITHERS_WORKSPACE_JJ_EXPORT_BINARY` to name the
packaged helper by an absolute path. Both Node and Bun use that executable for
file eligibility, snapshots and native coding operations.

The configured executable is staged separately from the general Smithers CLI.
Plue's existing `SMITHERS_WORKSPACE_CODING_HOST_BINARY` operator option selects
that artifact; it is installed as `/usr/local/bin/smithers-coding-host`. General
CLI pack setup and interactive commands retain their existing executable.

Engine compensation uses the private `snapshots.ts` configuration of the existing
Jj service. Its opaque preimage is an immutable full commit ID; snapshots never
create or describe another planned JJ change. Privileged snapshot subprocesses
use the existing contained spawner and Control journal process ledger. Standard
agent tools keep their existing guarded spawner and native journal process ledger.

`filesystem.ts` adds native JJ eligibility to the existing guarded standard file
tools. New ignored files, metadata/symlink paths, native snapshot exclusions and
oversized files are refused before final mutation. Existing tracked ignored files
remain editable. Write/Edit/ApplyPatch retain their own parsing and atomic sibling
replacement. A transient Set tracks only exclusive Preserve siblings until final
rename/cleanup; final destinations always receive the native prospective-byte
check. It is not persistent file ownership or memory. As with Preserve itself,
process death can leave an operational sibling; this never makes an ignored user
file an accepted output. Direct streaming/writable handles, recursive mutations,
links and independent permission/timestamp changes are explicitly unsupported in
this coding configuration. Shell commands remain irreversible and are never
advertised as fully compensated file tools. The guard recognizes the provisioned
root and the canonical root returned by the existing guarded filesystem, allowing
Preserve's atomic replacements under OS aliases such as `/var` to `/private/var`.
It never resolves child symlinks independently or relaxes the filesystem boundary.
Native eligibility requests retain the exact provisioned repository path.

The native acceptance test rejects an ignored Write, writes through a `*.tmp`
ignore rule, edits the resulting file, verifies both immutable check tiers, and
asserts one planned JJ atom and matching health identity. Run the same bundle
proof with `node flows/test/coding-host-bundle.mjs` or
`bun flows/test/coding-host-bundle.mjs`, with `PLUE_CODING_ADAPTER_SOURCE` and
`PLUE_JJ_EXPORT_BINARY` pointing to the actual Plue artifacts. It exercises bundled
QuickJS, builtin SQLite and contained processes; `--version` alone is insufficient.

Explicitly enabled Wiki planning also registers the private `coding/WikiCheck` delegate.
Projects opt into continuous semantic backpressure by declaring `checks/wiki`
and including it as a required slow check. Its catalog policy is derived from
the operator's pages and the actual host reviewer. The same derived Registry is
shared by approvals, module authority and executable dispatch. Only this check's
descriptors change; source-authored policy metadata cannot override the host.
The check returns ordinary receipts and owner findings over immutable exports;
it never publishes a competing wiki pointer. Target repositories no longer need
to copy the host's four reviewer source files merely to generate their own wiki.
