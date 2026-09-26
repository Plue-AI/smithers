# Coding backpressure targets

`flows/PACKAGE.ts` declares the current coding tests using the existing test
targets. These labels describe test scope, not a claim that a suite is near
instant. Use measured build/typecheck gates for fast backpressure; run suites
that take longer asynchronously.

| Label                     | Scope                                                                                             | Runtime / budget                     |
| ------------------------- | ------------------------------------------------------------------------------------------------- | ------------------------------------ |
| `//flows:codingPolicy`    | Host configuration/seat contracts, test-inventory coverage, missing-native-tool refusal           | Node, existing 10 minute test budget |
| `//flows:coding`          | Linear coding policy with real JJ and SQLite, scripted implementations/checks                     | Node, 10 minutes                     |
| `//flows:codingRuntime`   | Real QuickJS authority refusal and explicit operator configuration/startup                        | Node, 10 minutes                     |
| `//flows:codingConfigBun` | Operator configuration/startup using injected Bun services                                        | Bun, 10 minutes                      |
| `//flows:codingNative`    | Existing native ports, atoms, checks, planning/wiki, correction, POC and configured host fixtures | Node, 45 minutes                     |
| `//flows:codingNativeBun` | The fixtures that select the Bun platform/runtime, including the complete request host            | Bun, 45 minutes                      |
| `//flows:codingBundle`    | Existing deployment bundler acceptance for manual plans and prompt requests                       | Node, 45 minutes                     |
| `//flows:codingBundleBun` | The same two bundled host acceptance cases                                                        | Bun, 45 minutes                      |

The native and bundle labels are slow gates. Their private launcher runs one
existing test file at a time, with a 25 minute child limit in addition to each
fixture's own timeout. The enclosing existing `Shell.Test` also bounds the entire
gate. `Shell.Test` caches a green verdict in `execute` mode, but the JJ binary and
native helper these gates spawn are not key material: only the Node or Bun
runtime is. Coding checks bind those tools through the check cache partition
(`scripts/ci/check-cache.mjs`); a direct `smthrs test` of these labels does not.
Gate output records measured preflight helper SHA256 and JJ version.

`//flows:codingPolicy` and `//flows:codingRuntime` declare `cache: true`. Their
inputs are every Smithers package source, the flows sources and scripts, the
lockfile, and the checked-in project configuration and pages the fixtures read.
A fixture that starts reading another file must declare it, or a rebase can
replay a verdict that file would have changed.

Native gates require a POSIX host with JJ and the packaged Rust helper. The
launcher records the JJ version and uses
`/usr/local/bin/smithers-jj-export` by default. Missing tools refuse the gate
before a test can report a skip.

For a direct local acceptance run, existing fixture variables may point at
explicit artifacts instead:

```sh
SMITHERS_WORKSPACE_JJ_EXPORT_BINARY=/path/to/smithers-jj-export \
node flows/test/coding-native-gate.mjs source
```

Use `bun` for the Bun source matrix, or replace `source` with `bundle` for the
deployable artifact matrix. Atom and correction standalone fixtures currently
hardwire NodeRuntime and run in the Node matrix. The Bun request-host fixture
exercises the production atom/correction composition through Bun injection; the
launcher does not relabel those standalone Node fixtures as Bun evidence.

For bounded launcher acceptance, append an existing source fixture name, for
example `node flows/test/coding-native-gate.mjs source coding-native.test.ts`.
The declared graph gates omit this selector and run the complete relevant list.
An unlisted name or a Node-only fixture selected under Bun refuses before tools
start. A selected run is evidence only for that fixture, never a full gate pass.

The graph declares recipe source, workflow Markdown, test launchers and dependency
configuration as inputs. Existing source-only `Filegroup` dependencies use each
Smithers package's own `cwd` and cover its `src/**`, package manifest and TypeScript
configuration, including control and gateway packages. They preserve package
boundaries and do not trigger package builds. The private directory inventory is
checked against the existing pnpm workspace membership reader; the existing
`pnpmWorkspace` input tracks member manifests and export maps.

The coverage regression refuses a newly added `coding*.test.ts` file that is absent
from both ordinary and native gates. The recipe adds labels and a private launcher,
with no new target type, execution service, database or public library API.
