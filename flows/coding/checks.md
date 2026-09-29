# Checks against immutable source

`checks.ts` is a private repository recipe. It registers `coding/CommandCheck`
with the existing executable catalog and `checkLayers(options)` with the
existing native action table. There is no additional executor or database.

## Pin a registered command

A project check is an ordinary discovered Markdown flow. Its verified body
contains the command declaration as its first nonempty line, for example:

```md
---
description: Verify the generated schema matches its declarations.
flows: ["coding/CommandCheck"]
capabilities: ["fs:read:**", "proc:spawn:node scripts/check-schema.mjs *"]
---

{"argv":["node","scripts/check-schema.mjs"],"cwd":".","timeoutMs":30000}
```

The plan names this flow and its existing `Descriptor.executionDigest`. Changing
the command changes that digest. The lowered Invocation carries the verified
body into the action payload, so the command also participates in its durable
step key. The implementation/check input and existing `checkInputDigest` bind the
result to the precise revision and check declaration.
The invocation also carries the registry's rendered resource context. Changes to
that context change the action payload; exact receipt matching still binds
validation to the recorded implementation and check input.
The registry appends a resource trailer and encoded arguments; the recipe reads
only that first JSON declaration line, so appended input cannot replace it.

## Export immutable source

The action asks the host environment's `smithers-jj-export` helper (by default
`/usr/local/bin/smithers-jj-export`) to materialize the full commit ID in
a new temporary directory. It verifies the returned commit, tree and JJ change
IDs before running the command. The host must supply the intended read-only
exporter implementation; returned identity checks alone do not establish that an
arbitrary configured binary honors that contract. The command runs from its
exported source, while the acceptance fixture asserts
that the owning JJ operation remains unchanged. Arbitrary command confinement
still belongs to the host. Slow checks can read their original source while a
later atom is being edited. A new descendant revision gets a
different check input; an earlier receipt cannot validate it.
The recipe permits links that resolve inside the export, and refuses dangling
links or links into the live checkout or anywhere else outside it before a
checker starts. This prevents a committed dependency link from silently reading
mutable source. Commands still need the host's execution confinement.

## Run with explicit host policy

The command runs with literal argv, a contained relative working directory, a
bounded timeout, and a host-supplied build environment. It does not inherit the
gateway's environment by default. Dependency installation and runtime selection
belong to the project's declared command and existing toolchain; this recipe
does not borrow mutable `node_modules` from the editing checkout.
This repository's `scripts/ci/coding-check.sh` gives each frozen Bun install
120 seconds, terminates a stalled installer, and retries it once. Other install
failures retain their exit status; tests start only after installation succeeds.
`SMITHERS_CHECK_INSTALL_TIMEOUT` can select a different GNU timeout duration
for an operator or a bootstrap test. Coreutils is supplied by the workspace base.
Each check starts in a fresh export, so `scripts/ci/check-cache.mjs` carries
target results between them: it seeds the export's `.flows/cache` from
`$HOME/.cache/smithers-checks/cache` (or `SMITHERS_CHECK_CACHE_DIR`) before the
run and saves new entries after it, pass or fail. The partition is named by the
bytes of Node, Bun, JJ and the native exporter, the tools the target key does
not fully bind. A rebased revision therefore replays every cacheable target
whose content key is unchanged, and runs the rest; there is no separate
diff-based selection. Bun's package cache lives beside it, so a replayed check
does not download its dependencies again. This cache is evidence for one
workspace VM: check code runs as the same user and could write it. Remote
build-cache credentials are not forwarded to checks.
The example requires an explicit host `environment.PATH` containing `node`;
without a supplied PATH the command must name an absolute executable. Tools
that need HOME, a package cache or other build settings receive those explicitly.

## Retain measured receipts

Actual process exit zero produces a passing receipt. A nonzero exit produces a
failed receipt and finding for its current owning Change. Invalid exports,
missing executables, timeouts and unavailable cleanup fail execution instead of
inventing validation evidence. Output is drained and a bounded prefix is stored
in the existing receipt, with truncation disclosed.

## Close scratch after contained processes

The export directory and contained processes use Effect scopes. The recipe relies
on the injected runtime's scoped cleanup contract on success, failure and cancellation. It is a source snapshot, not a security
sandbox: the host must provide its existing process confinement when running
untrusted project commands. FileSystem, Path and ChildProcessSpawner are Effect
dependencies; the recipe does not select Node or Bun.

The private composition supplies its existing trusted `fs` as a service value,
captured before action workspace guards. Export lifecycle and validation of the exported tree use it; the
check process still runs through the action's permission-checked, contained
spawner. Temporary-directory permissions and process confinement are supplied
by the host; this recipe requests separate scoped scratch rather than writing
it into the editing checkout. Process evidence is nondeterministic for cache
purposes; a completed execution still replays its own recorded result.

New private structures are the JSON command declaration (`argv`, `cwd`,
`timeoutMs`) and `CheckHostOptions` (`repositoryPath`, existing host `fs`, optional `exporterPath`
and optional `environment`). The process result is converted into the existing
`Receipt` schema. No public package API or persisted table is added.

## Review wiki prose through the same check protocol

The configured `coding/WikiCheck` delegate shares `immutable-source.ts` with
command checks. It captures the exact implemented source before asynchronous
review, then invokes existing wiki review and assessment actions in the native
runtime. Unsupported or uncertain prose produces ordinary owner findings; an
invalid reviewer receipt refuses the check. It never publishes the wiki current
pointer. The host binds its actual reviewer policy and configured page catalog
to the ordinary check declaration's execution identity. The owning
[semantic-check guide](wiki-check.md) describes the capture and reuse contract.

The deployed coding host explicitly selects `concurrency: 1` to run one revision command check at a time. The permit covers source export, dependency installation, execution, and temporary-tree cleanup, so concurrent check flows do not multiply the workspace VM's memory and disk usage. Each check still records its own immutable-source receipt. Standalone `checkLayers` compositions retain concurrent execution unless they supply this resource limit; owner-feedback checks can therefore cancel unrelated pending checks without waiting for them to finish.

## Lint on Jev

`jev-check.ts` registers `coding/JevCheck`. Its body's first line declares up to
eight rules, `{"rules":[{"id","rule","paths"}]}`. The check reads only the
unified diff between the implementation's immutable parent and head, skips
private repository-job paths, and asks Jev whether each in-scope hunk violates
each rule (the `check/rule` classifier, 0.8/0.2 thresholds). A decisive flag
or an unsure answer fails the receipt with a finding; more than 256 questions
or a diff over 1 MB fails without asking. An unreachable Jev fails the check;
no other model answers in its place. See `flows/checks/lint/flow.mdx`.

## Review on a second provider

`review-check.ts` registers `coding/ReviewCheck`. Its body's first line declares
up to eight lenses, `{"lenses":[{"id","focus"}]}`; `flows/checks/review/flow.mdx`
declares this repository's. The check reads the same immutable parent..head
diff as the Jev check, drops private repository-job paths, and asks one
evidence-only completion per lens on the `coding/review` role, which the host
defaults to a seat on a provider other than the effective implementer's
(`reviewDefault` in `host.ts`; `SMITHERS_CODING_REVIEW_MODEL` or the project's
`seats` pin one). Every lens's findings land on the owning Change and its
commit, so a lens that requests changes fails the receipt; the evidence records
the role, each lens's verdict and its finding count. A diff over 200 KB or one
the check cannot read unambiguously fails without asking any lens. The lenses
change the check's execution digest, so a plan replans when they change.

## Check only the affected targets

The command receives the Change's written paths in `SMITHERS_CHECK_FILES`,
one per line. `checks/affected-lint` (fast) and `checks/affected-test` (slow)
pass them to `smthrs affected` through `scripts/ci/coding-check.sh affected
<verb> <patterns>`, with `.github/ci-known-red.json` as the known-red list. A
Change whose affected target is newly red fails its gate, so `FastGate` stops
the next Change and correction feeds the failure back to the owning one. A
target already on the known-red list is reported but does not fail the check.
A Change that wrote nothing affects no target and passes.
