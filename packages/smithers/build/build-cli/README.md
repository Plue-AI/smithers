# smithers-build CLI

Release candidate scope, host requirements and compatibility review are defined in the [library support policy](https://github.com/smithersai/smithers/blob/main/RELEASE_SUPPORT.md).

**Documentation:** https://smithers.sh/docs/reference/api/build-cli/

`smithers-build` executes target graphs. A verb selects a set of targets by
label or pattern, the CLI plans them, consults a content-addressed cache, and
runs whatever is missing. Targets declare inputs, outputs, and permissions;
they never contain per-command scripts.

```sh
smithers-build install --workspace /path/to/smithers
smithers-build ci //packages/...
smithers-build test //packages/smithers/flows/flow:test
smithers-build lint //packages/smithers/flows/flow:lint
smithers-build query 'deps(//packages/smithers/flows/flow:lib)'
smithers-build graph //packages/... --mermaid
smithers-build //packages/smithers/flows/flow:lint          # the bare-label form
```

Verbs execute by default. `--plan` prints the inert plan instead, `--no-cache`
bypasses cache reads, and `--jobs` bounds concurrency. `install` runs the
install Flow under the declared package manager.

The CLI loads `.smithers/WORKSPACE.ts` (or a root `WORKSPACE.ts`) and every
`PACKAGE.ts` in the tree. The workspace declaration names the shared services:
runtimes, package managers, toolchains, sandbox mechanisms, and caching. Each
package exports exactly one `S.Package({ targets })`, selected through
Bazel-style labels.

Not on npm yet; see [Installation](https://smithers.sh/docs/installation/).

Agent edit application and write-set rollback require trusted, coordinated
workspace writers throughout capture, apply, commit, and rollback. Filesystem checks
are path-based, not descriptor-anchored isolation against concurrent path
replacement. Candidate publication replaces the file inode, preserves ordinary
permission bits (`0777`), and clears setuid, setgid, and sticky bits. Rollback
restores recorded permissions with the original bytes without modifying existing
hard-link aliases. Clean tracked bytes are restored from the Git index.

## Documentation

The API reference is at https://smithers.sh/docs/reference/api/build-cli/;
the full documentation lives in
[`docs/`](./docs/README.md):

- [Installation](./docs/installation.md) and
  [Quickstart](./docs/quickstart.md).
- [Declaration loading](./docs/concepts/declaration-loading.md): shared runtime
  dependencies, conflict diagnostics, module formats, and evaluation lifetime.
- [Commands](./docs/cli.md): every command, argument, option, exit code, and
  environment variable.
- Concepts: [the invocation pipeline](./docs/concepts/invocation.md),
  [workspace discovery](./docs/concepts/discovery.md),
  [output and renderers](./docs/concepts/output.md),
  [caching](./docs/concepts/caching.md), and
  [target execution](./docs/concepts/execution.md).
- [Rule contracts and ownership](./docs/concepts/rule-contracts.md): the
  declaration boundary, shared execution services, and staged family extraction.
- Guides: [selecting targets](./docs/guides/select-targets.md),
  [inspecting a workspace](./docs/guides/inspect-a-workspace.md),
  [remote caching](./docs/guides/share-a-remote-cache.md),
  [scaffolding an app](./docs/guides/scaffold-an-app.md), and
  [embedding the CLI](./docs/guides/embed-the-cli.md).
- [Troubleshooting](./docs/troubleshooting.md) and the
  [API reference](./docs/api.md).

The API reference is derived from the JSDoc on the exported declarations in
`src/`; the package's lint configuration requires a description, a
`@category`, and a `@since` on each one.

## Testing

Run `pnpm run check`, `pnpm run test --run`, and `pnpm run coverage --run`
under a supported Node version. The suite uses one Vitest worker by default.
Append `--fsModuleCache` to reuse transforms between runs. Coverage floors
remain enabled. Execution tests start real child CLIs and create temporary
repositories outside this checkout, so cold process startup is part of their
wall-clock cost.

The Git fixtures require a working `git` executable. Tests that intentionally
remove other tools from PATH retain only that executable; a forwarding wrapper
that needs other PATH entries is not sufficient. If a local operator policy
permits real Git in temporary test repositories, select that test environment
for the Vitest process without changing the policy or using Git on this checkout.

For macOS cgo verification, put the selected Xcode toolchain's actual `bin`
directory ahead of `/usr/bin` on the test process's PATH and set `SDKROOT` to
the selected SDK. Resolve them with `xcrun --find cc` and `xcrun --show-sdk-path`
before running the suite. Apple's `/usr/bin/cc` launcher tries to cache tool
discovery in the per-user global temp directory; confinement denies those
`xcrun_db` writes and can make every compilation repeat expensive Xcode lookup.
Using the real compiler preserves the sandbox and the existing test deadlines.

Docker integration tests require a responsive daemon, cached Alpine images or
registry access, and a buildx builder supporting OCI export. `docker info`
alone does not establish that containers can start within the service readiness
deadline. Diagnose container startup delays before changing readiness budgets.
The real Codex envelope smoke is opt-in with `SMTHRS_CODEX_SMOKE=1`; it requires
an authenticated `codex` CLI and makes a model request.
