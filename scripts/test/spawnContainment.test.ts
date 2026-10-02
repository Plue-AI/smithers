import assert from "node:assert/strict"
import { readFileSync, statSync } from "node:fs"
import { join, relative, sep } from "node:path"
import { describe, it } from "node:test"
import * as ts from "typescript"
import { collectSources, fileBindsSpawningModule } from "../../packages/smithers/flows/test/SpawnSpecifiers.ts"
import { readWorkspaceInventory } from "../readWorkspaceInventory.ts"

/**
 * Containment is a property of the `ChildProcessSpawner` SERVICE, not of any
 * call site.
 *
 * A host decides its kill policy once, by decorating that service.
 * `ContainedSpawner` records a prepared supervisor in the `ProcessLedger`
 * before activating its target; every module that resolves the tag inherits
 * that ownership and cleanup policy. A module that reaches for `child_process` (or
 * `cluster`) instead inherits neither: its children outlive a cancel by
 * however long they choose, and a hard-killed host leaves them with nothing
 * recording that they exist, so the next incarnation cannot reap them.
 *
 * No behavioral test can see that. The bypassing module works, its own suite
 * is green, and the only symptom is a process still running on someone's
 * machine after the flow that started it was cancelled. So the bypass is
 * checked for directly, over the whole repository rather than one package:
 * `packages/smithers/agent/std/test/ExecContainment.test.ts` carries the same assertion
 * scoped to `std` alone, where it fails fast during work on that package, and
 * this suite is the universe.
 *
 * Both read `packages/smithers/flows/test/SpawnSpecifiers.ts`, which parses each file
 * and asks the syntax tree. One reader means this gate can never be narrower
 * than the package-local one, and a parser means neither can be defeated by
 * an import's LAYOUT. The three regex readers that came before were each one
 * layout wide, and the last one missed the multi-line import `dprint` itself
 * produces for any import over 120 characters. The reader's fixtures, one
 * file per layout, live beside it in
 * `packages/smithers/flows/test/SpawnSpecifiers.test.ts`.
 *
 * The exceptions are named here with their ownership boundary and limitations, not
 * derived from what happens to be in the tree. The list is checked in both
 * directions, the way the coverage-gate deferral next door is: an unlisted
 * importer fails, and a listed file that no longer imports a process-starting
 * module fails too, so the list expires on its own instead of quietly widening
 * the exemption. The matcher itself is pinned against fixtures, because every
 * spelling it fails to recognize is a bypass that reads as compliance.
 */
describe("child-process containment conformance", () => {
  const { packagesDir, manifests } = readWorkspaceInventory()

  /**
   * Native spawner implementations and explicit callers outside a contained
   * host. An exemption does not grant that caller a host-ledger guarantee.
   *
   * Keys are `<package>/<path under the package>` with POSIX separators.
   */
  const allowed = new Map<string, string>([
    [
      "smithers/flows/jj/src/node/NodeJj.ts",
      "The self-spawning `layer`, for a program that has no spawner to offer. "
      + "Bounded: every command is short-lived, writes to a pipe so jj starts no pager, "
      + "opens no editor (`snapshot` passes `-m` or runs no `describe`, because "
      + "`jj describe` without `-m` starts `$JJ_EDITOR` and waits for it), "
      + "and is held by the handle the invocation started, so a cancel signals it "
      + "(`packages/smithers/flows/jj/test/NodeJjLifetime.test.ts`, `packages/smithers/flows/jj/test/NodeJj.test.ts`). "
      + "A host that wants the process GROUP contained composes `layerSpawner` instead, "
      + "which is what `NodeHost.layerContained` does."
    ],
    [
      "smithers/flows/platform-node/src/internal/AtomicFileSystemTransport.ts",
      "The atomic-operation helper. It CANNOT route through the spawner: `NodeHost` builds "
      + "`NodeChildProcessSpawner.layer` over `AtomicFileSystem.layer`, so routing it would "
      + "close a layer cycle. Bounded instead: `complete()` calls `cleanup()`, which SIGKILLs, "
      + "on every settle path and on interruption, and the helper is one `python3 -I` syscall batch."
    ],
    [
      "smithers/flows/platform-node/src/ProcessReaper.ts",
      "Native process-table probes and Windows taskkill inside the reaper itself. "
      + "POSIX identity probes have a 5-second timeout and cleanup snapshots a 500-ms timeout; "
      + "the Windows fallback has no explicit timeout and is outside the RC support matrix. "
      + "Routing these through the spawner being recovered would close a layer cycle."
    ],
    [
      "smithers/flows/platform-node/src/internal/PipedProcess.ts",
      "The private native standard-command adapter beneath `ProcessReaper.layerSpawner`. "
      + "It cannot recursively invoke the spawner it implements. The contained POSIX path "
      + "prepares a supervisor, records that owner before target activation, and delegates "
      + "group cleanup to that live owner. The adapter retains native pipe errors and owns "
      + "its direct child's finalizer. Real Node/Bun, CLI, build and sandbox tests exercise "
      + "this boundary; the package export map denies direct access to internal modules."
    ],
    [
      "testing/src/ProcessTable.ts",
      "Test-support process-table probe; spawns only `ps` with fixed arguments and a bounded 64 MiB maxBuffer."
    ],
    [
      "smithers/src/commands/Tui.ts",
      "Interactive CLI hand-off to the Bun terminal host, outside a durable flow. "
      + "Inherits the foreground terminal and awaits its direct child's exit status; "
      + "Ctrl+C belongs to that child. Tui.test.ts verifies argv, launch refusal and status. "
      + "This launcher has no durable process ledger or hard-kill recovery guarantee; "
      + "flow execution inside the TUI composes its own host."
    ],
    [
      "smithers/src/commands/Open.ts",
      "`smthrs open`: an interactive CLI hand-off outside a durable flow. It reads the "
      + "checkout's remote with `git`/`jj` (piped, no timeout) and then launches the installed "
      + "app with `open -a` or the checkout's `pnpm dev` in the foreground terminal, awaiting "
      + "the direct child's exit status; Ctrl+C belongs to that child. Open.test.ts drives a "
      + "scripted host. No durable process ledger or hard-kill recovery guarantee."
    ],
    [
      "smithers/src/Providers.ts",
      "Claude Code seat detection runs the installed `claude auth status` from PATH to "
      + "read its sign-in: fixed arguments, no shell, a 15-second timeout, memoized per "
      + "executable and login variables, outside a durable flow. No durable process "
      + "ledger or hard-kill recovery guarantee."
    ],
    [
      "smithers/src/Agents.ts",
      "`smthrs mcp` Codex registration runs the installed `codex mcp add` and "
      + "`codex mcp list --json` from PATH to write and verify the Smithers entry: fixed "
      + "arguments, no shell, a 15-second timeout, a 1 MiB output cap and an isolated "
      + "HOME and CODEX_HOME, outside a durable flow. CodexMcpRegistration.test.ts drives "
      + "a scripted codex and the installed one when present. No durable process ledger "
      + "or hard-kill recovery guarantee."
    ],
    [
      "smithers/src/ExecutionEnvironment.ts",
      "`smthrs environment exec`: an interactive CLI hand-off outside a durable flow. It "
      + "runs the operator's command locally or through `ssh` with inherited terminal I/O "
      + "and awaits the direct child's exit status. A non-terminal local run starts its own "
      + "process group, and cancellation sends that group SIGTERM, then SIGKILL after 500 ms "
      + "and again on exit; a remote command has SSH's connection lifecycle. "
      + "ExecutionEnvironment.test.ts and ExecutionEnvironmentSsh.integration.test.ts cover "
      + "both. No durable process ledger or hard-kill recovery guarantee."
    ],
    [
      "smithers/src/Detached.ts",
      "`smithers up -d`, the one launcher whose child must OUTLIVE the process that "
      + "started it. Routing it through the host spawner would kill the engine on the "
      + "launcher's scope release, which is the opposite of what the verb means. Bounded "
      + "instead: the child is spawned `detached: true` into its own process group and "
      + "`unref`ed, the launcher signals that whole group with `terminate()` when the child "
      + "misses its admission deadline, and the child is itself a `smithers` engine that "
      + "composes the contained host, so everything IT spawns is inside the ledger and the "
      + "kill deadline (`packages/smithers/test/Detached.test.ts`)."
    ],
    [
      "smithers/flows/platform-node/src/internal/WindowsProcessJob.ts",
      "The Windows job guardian `ProcessSupervisor` attaches to a target before it activates. "
      + "It is part of the contained spawner, so it cannot route through that spawner. Bounded: "
      + "the trusted helper runs with an empty environment and no shell, its unframed status is "
      + "capped at 4 KiB, readiness is awaited under the supervisor's startup deadline, and "
      + "closing its control pipe, including host death, terminates the job."
    ],
    [
      "smithers/flows/platform-node/src/ProcessSandbox.ts",
      "The shared process sandbox on macOS reads the developer directory with "
      + "`/usr/bin/xcode-select -p` when `DEVELOPER_DIR` is unset: a fixed absolute program, "
      + "fixed arguments and a 2-second timeout, outside a durable host."
    ],
    [
      "smithers/build/build-cli/src/GitHooks.ts",
      "Build CLI hook installation resolves the Git hooks directory outside a durable host. "
      + "Its git rev-parse probe has a 10-second timeout and a 64-KiB output limit."
    ],
    ...[
      "GoExec.ts",
      "NixExec.ts",
      "PackageTree.ts",
      "RepoResolution.ts"
    ].map((file): [string, string] => [
      `smithers/build/build-cli/src/${file}`,
      "Repository discovery, planning and bootstrap tooling in the public build CLI. "
      + "These native helpers run outside the durable host and retain command-specific "
      + "output, cancellation and timeout policies; some commands have no timeout. "
      + "This exemption does not promise durable process-ledger recovery. Target execution "
      + "and service supervision instead use the contained platform adapter."
    ])
  ])

  const isDirectory = (path: string) => {
    try {
      return statSync(path).isDirectory()
    } catch {
      return false
    }
  }

  /**
   * Every source module under `packages/<name>/src`.
   *
   * The universe is derived from the packages directory rather than from a
   * list, so a package added tomorrow is covered without anyone remembering
   * to add it here, and it spans every extension a module in this repository
   * can be written in rather than `.ts` alone.
   */
  const sources: Array<{ readonly id: string; readonly path: string }> = []
  for (const { name } of manifests) {
    const root = join(packagesDir, name, "src")
    if (!isDirectory(root)) continue
    for (const path of collectSources(root)) {
      sources.push({ id: `${name}/${relative(join(packagesDir, name), path).split(sep).join("/")}`, path })
    }
  }

  const importers = sources
    .filter(({ path }) => fileBindsSpawningModule(path))
    .map(({ id }) => id)
    .sort()

  it("scans a universe that could actually contain a bypass", () => {
    // Guards the guard: a broken walk or a renamed directory would make every
    // assertion below pass over nothing. The extension assertions are the
    // widened universe stated as a requirement, so narrowing the walk back to
    // `.ts` fails here rather than silently un-scanning the 86 `.tsx`
    // components and two `.js` entry points it used to skip.
    assert.ok(sources.length > 900)
    assert.ok((sources.map(({ id }) => id))!.includes("smithers/agent/std/src/internal/Exec.ts"))
    assert.equal(sources.some(({ id }) => id.endsWith(".tsx")), true)
    assert.equal(sources.some(({ id }) => id.endsWith(".js")), true)
  })

  it("starts child processes only through the host's spawner", () => {
    // An unlisted importer is a module whose children are outside the kill
    // deadline and outside the ledger. If it belongs there, add it above with
    // its ownership boundary and limitations; the reason is the review, not the entry.
    assert.deepEqual(importers.filter((id) => !allowed.has(id)), [])
  })

  // Parses every workspace source into a TypeScript AST, so the cost is
  // allocation bound and scales with the machine. Measured at 995 ms on an idle
  // developer machine and 38.3 s on a two-core hosted runner sharing itself
  // with eleven other test files, which overran the 30 s package default. The
  // budget clears the observed cost three times over and still bounds a hang.
  it("never reads a secret declaration directly from an environment", { timeout: 120_000 }, () => {
    const reads: Array<string> = []
    for (const source of sources) {
      const file = ts.createSourceFile(
        source.path,
        readFileSync(source.path, "utf8"),
        ts.ScriptTarget.Latest,
        true,
        source.path.endsWith(".tsx")
          ? ts.ScriptKind.TSX
          : source.path.endsWith(".jsx")
          ? ts.ScriptKind.JSX
          : source.path.endsWith(".js")
          ? ts.ScriptKind.JS
          : ts.ScriptKind.TS
      )
      const visit = (node: ts.Node): void => {
        if (
          ts.isElementAccessExpression(node) && node.argumentExpression !== undefined &&
          ts.isPropertyAccessExpression(node.argumentExpression) && node.argumentExpression.name.text === "env"
        ) {
          const parent = node.parent
          const isWrite = ts.isBinaryExpression(parent) && parent.left === node &&
            parent.operatorToken.kind === ts.SyntaxKind.EqualsToken
          if (!isWrite) {
            const line = file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1
            reads.push(`${source.id}:${line}`)
          }
        }
        ts.forEachChild(node, visit)
      }
      visit(file)
    }
    // A value lookup belongs in SecretProxy's private vault reader at the
    // instant it constructs the outbound request. Indexing any environment
    // with `secret.env` recreates eager resolution in a job or planner.
    assert.deepEqual(reads, [])
  })

  for (const entry of [...allowed.keys()].map((id) => ({ id }))) {
    it(`${entry.id} still needs its containment exemption`, () => {
      const { id } = entry

      // Self-expiring, like the coverage-gate deferral next door: a file that
      // stopped spawning directly, or moved, must leave the list rather than
      // sit there pre-approving whatever takes its place at that path.
      assert.ok(importers.includes(id))
    })
  }
})
