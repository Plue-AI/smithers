# Bun owning-source coverage

This collector instruments an explicit source roster before Bun runs it. Unimported
entrypoints retain zero hits; type declarations remain as files with zero executable
counters. Babel 7 lowers TypeScript, optional chaining, nullish coalescing and logical
assignment, then Istanbul creates and remaps standard statement, function, branch
and line counters. No production ignore directives are accepted.

Run the qualification suite with Node 26:

```sh
node --test scripts/bun-coverage/{coverage,receipts,run}.test.mjs
```

The CLI takes a JSON array of canonical paths relative to the owning root, a new
receipt directory, and the original Bun arguments:

```sh
node scripts/bun-coverage/run.mjs --root apps/tui --roster roster.json --run /tmp/new-run -- test ./test
```

Do not use this draft as a release coverage gate yet. TUI/app owner wiring and full
qualification remain pending under #2392 and #2290.

## Collection contract

Every process has a registered identity, an atomic startup receipt, and an
independently observed actual exit. Before any owning onLoad returns instrumented
code, it atomically publishes the process's first owning-source load receipt.
A process with an owning load requires an immutable final coverage snapshot.
A terminated process without any owning load contributes only the sealed zero
baseline and is explicitly classified `zero-no-owning-load`; no final snapshot
is invented for it. This rule has no filename/hash/helper exceptions. A Bun test snapshots
in the preload's global `afterAll`; the parent observes its actual exit separately.
An ordinary Bun script snapshots at its exit callback. A failing root command retains
its nonzero status and coverage. An intentionally failing child does not change a
successful parent's status. Missing required, corrupt, duplicate, foreign or mismatched
receipts refuse the report. Source hashes, package versions, lowering options and
static source maps are sealed and rechecked before snapshotting. Parent chains must
reach the registered root without cycles.

Currently qualified child launch boundaries are direct Bun commands through Node
`spawn`/`spawnSync` (including named imports), and Node `execFile` on
the qualified Bun 1.4.2 implementation (which reaches the Bun spawn boundary) and Bun `spawn`/`spawnSync` (argv and
options forms). The wrapper injects documented `--preload` arguments and reserved
collector environment fields while preserving ordinary explicit environment values.
`BUN_OPTIONS` alone was insufficient for direct script launches in the tested Bun
version, so it is not used as evidence of automatic arbitrary-child collection.

Shell interpretation, Node `exec`/`fork`, workers, detached grandchildren,
browsers and native runtimes are not yet qualified. A required owner using those
paths must add a concrete qualification or separate collector before claiming its
child execution is measured. No shell parser or substitute process implementation
is provided. Direct Bun `shell:true` through the replaced default Node child-process API is
explicitly refused. On Bun 1.4.2, named Node shell launches reach the lower Bun
boundary as a shell executable and cannot be recognized without parsing shell
commands; that family remains unqualified. `syncBuiltinESMExports` is not assumed
to repair every Bun named-import binding. Any owning-load process missing completion
(including a hard-killed child) fails closed. Missing startup/actual-exit receipts
or incomplete load publication also fail closed. Bun's actual `137` plus
`SIGKILL` convention is retained; a numeric signal exit is admitted only when
it equals `128 + OS signal number`. A false success `0 + SIGKILL` is refused. On POSIX the owned root gets a
process group; timeout/report refusal kills ordinary descendants in that group.
Explicitly detached descendants need a separate lifetime owner. The Windows
fallback kills the root only and is not qualified as descendant cleanup.

## Counter semantics and limits

Counters are Istanbul's standard counters after the declared lowering pipeline,
not MC/DC coverage. Logical branches count operand evaluation; default parameters
have one default-arm counter. Enums and namespaces retain generated initialization
helpers and their counters. Their generated branches can include synthetic outcomes
that source code cannot independently select; these must be reported rather than
ignored. Other language transformations and collector paths remain unqualified
until exercised by conformance fixtures.

The nested-path control verifies original source lines and start columns with a
changed cwd and relocated root. Istanbul may represent an end column as `Infinity`
(open ended); standard JSON serialization renders that end column as `null`. This
collector does not invent a precise end column. Coverage sources remain canonical
owner-relative paths while execution and `import.meta.url` retain physical paths.

Standard Istanbul merge combines hit counters only after matching source/map
identity. Denominators are not summed across processes. Standard JSON, JSON summary
and LCOV reporters consume the remapped map; integer covered/total values remain
available even when coverage is incomplete.
