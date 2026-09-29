import { afterAll, beforeAll, describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { execFile, execFileSync } from "node:child_process"
import { chmodSync, existsSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { hostname, tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import { isJjError, Jj, type Snapshot } from "../src/Jj.ts"
import * as NodeJj from "../src/node/NodeJj.ts"
import { budgeted } from "./budgeted.ts"

const jjInstalled = (() => {
  try {
    execFileSync("jj", ["--version"], { stdio: "ignore" })
    return true
  } catch {
    return false
  }
})()

const execFilePromise = promisify(execFile)

// On CI the real-binary suite is the only thing exercising the actual jj
// contract — the scripted-fake suite already keeps coverage green — so a
// silent skip would let a behavioural regression against real jj merge
// unnoticed (issue #163). Locally the skip stays quiet; on CI it fails loud.
describe.runIf(Boolean(process.env.CI) && !jjInstalled)("NodeJj (CI guard)", () => {
  it("fails loudly when CI has no jj on PATH", () => {
    throw new Error(
      "jj is not installed on this CI runner, so the real-binary NodeJj suite "
        + "silently skipped. Install jj in .github/workflows/ci.yml (see the "
        + "'Install jj' step) — do not let this suite no-op on CI."
    )
  })
})

/**
 * `NodeJj` spawns `jj` in `process.cwd()`, so every case runs against a real
 * throwaway repository that this suite chdirs into.
 */
// Every operation waits for the spawned process to close; elapsed time is not
// part of the contract, and the package-wide `testTimeout` budgets for the
// jj-lock contention several of these suites create for each other.
describe.skipIf(!jjInstalled)("NodeJj", () => {
  let repository: string
  let previousCwd: string
  let editorDirectory: string
  let editorMarker: string

  const run = <A, E>(effect: Effect.Effect<A, E, Jj>) => Effect.provide(effect, budgeted(NodeJj.layer))
  /** Closes the working copy as a named change and returns its commit id. */
  const commitWorkingCopy = (message: string) => {
    execFileSync("jj", ["commit", `--message=${message}`], { cwd: repository, stdio: "ignore" })
    return execFileSync("jj", ["log", "--no-graph", "-r", "@-", "-T", "commit_id"], {
      cwd: repository,
      encoding: "utf8"
    })
  }

  beforeAll(async () => {
    previousCwd = process.cwd()
    repository = await mkdtemp(join(tmpdir(), "flows-node-jj-"))
    execFileSync("jj", ["git", "init", repository], { stdio: "ignore" })

    // The editor is a MARKER rather than the `true` that used to stand here.
    // `jj describe` with no `-m` starts `$JJ_EDITOR` (`nano` when unset) even
    // with stdout on a pipe and stdin on `/dev/null`, so `true` hid a real
    // interactive child behind a program that exits immediately. Recording the
    // fact instead lets a case assert that no jj this layer runs ever starts
    // one, which is the bound `NodeJj.layer`'s own documentation claims.
    editorDirectory = await mkdtemp(join(tmpdir(), "flows-node-jj-editor-"))
    editorMarker = join(editorDirectory, "editor-ran")
    const editor = join(editorDirectory, "editor")
    writeFileSync(editor, `#!/bin/sh\necho "editor-ran pid=$$" > ${editorMarker}\n`)
    chmodSync(editor, 0o755)
    process.env.JJ_EDITOR = editor

    process.chdir(repository)
  })

  afterAll(async () => {
    process.chdir(previousCwd)
    await rm(repository, { recursive: true, force: true })
    await rm(editorDirectory, { recursive: true, force: true })
  })

  it.effect("snapshots the working copy and restores a file back out of it", () =>
    Effect.gen(function*() {
      const file = join(repository, "note.txt")
      yield* Effect.promise(() => writeFile(file, "first\n"))

      const first = yield* run(Effect.flatMap(Jj, (jj) => jj.snapshot("first commit")))
      expect(first.changeId).toMatch(/^[k-z]+$/)
      expect(first.commitId).toMatch(/^[0-9a-f]{40}$/)

      yield* Effect.promise(() => writeFile(file, "second\n"))
      const second = yield* run(Effect.flatMap(Jj, (jj) => jj.snapshot("second commit")))

      const diff = yield* run(Effect.flatMap(Jj, (jj) => jj.diff(first.commitId, second.commitId)))
      expect(diff).toContain("note.txt")
      expect(diff).toContain("+second")

      yield* run(Effect.flatMap(Jj, (jj) => jj.restore(first.commitId)))
      expect(readFileSync(file, "utf8")).toBe("first\n")

      const status = yield* run(Effect.flatMap(Jj, (jj) => jj.status()))
      expect(status).toContain("Working copy")
    }))

  it.effect("quickstart compares immutable snapshots and restores the first tree", () =>
    Effect.gen(function*() {
      const guide = readFileSync(new URL("../docs/quickstart.md", import.meta.url), "utf8")
      const snippet = guide.match(/```ts\n([\s\S]*?)\n```/)?.[1]
      expect(snippet).toContain("jj.diff(first.commitId, second.commitId)")
      const code = snippet!.replace(
        "const repository = process.cwd()",
        `const repository = ${JSON.stringify(repository)}`
      )
      const { stdout } = yield* Effect.promise(() =>
        execFilePromise("node", ["--input-type=module", "-e", code], { cwd: previousCwd })
      )
      expect(stdout).toContain("-first")
      expect(stdout).toContain("+second")
      expect(stdout).toContain("note.txt is now: first")
      expect(readFileSync(join(repository, "note.txt"), "utf8")).toBe("first\n")
    }))

  it.effect("captures attempts without closing, describing, or committing a change", () =>
    Effect.gen(function*() {
      const description = "operator's work\n\nKeep these notes.\n"
      execFileSync("jj", ["describe", `--message=${description}`], { cwd: repository, stdio: "ignore" })
      const jjText = (...args: ReadonlyArray<string>) =>
        execFileSync("jj", [...args], { cwd: repository, encoding: "utf8" })
      const changeBefore = jjText("log", "--no-graph", "-r", "@", "-T", "change_id.short()").trim()
      const commitsBefore = jjText("log", "--no-graph", "-r", "all()", "-T", "change_id ++ \"\\n\"")
      const file = join(repository, "attempts.txt")
      const snapshots: Array<Snapshot> = []
      for (let attempt = 1; attempt <= 3; attempt++) {
        yield* Effect.promise(() => writeFile(file, `attempt ${attempt}\n`))
        snapshots.push(
          yield* run(Effect.flatMap(Jj, (jj) => jj.snapshot(`smithers action digest attempt ${attempt}`)))
        )
      }

      expect(jjText("log", "--no-graph", "-r", "@", "-T", "change_id.short()").trim()).toBe(changeBefore)
      expect(jjText("log", "--no-graph", "-r", "@", "-T", "description")).toBe(description)
      expect(jjText("log", "--no-graph", "-r", "all()", "-T", "change_id ++ \"\\n\"")).toBe(commitsBefore)
      expect(jjText("log", "--no-graph", "-r", "all()", "-T", "description")).not.toContain("smithers action")
      expect(new Set(snapshots.map((snapshot) => snapshot.changeId))).toEqual(new Set([changeBefore]))
      expect(new Set(snapshots.map((snapshot) => snapshot.commitId)).size).toBe(3)
      for (const snapshot of snapshots) expect(snapshot.operationId).toMatch(/^[0-9a-f]{128}$/)
      expect(snapshots.at(-1)!.operationId).toBe(jjText("op", "log", "-n1", "--no-graph", "-T", "id"))

      yield* run(Effect.flatMap(Jj, (jj) => jj.restore(snapshots[0]!.commitId)))
      expect(readFileSync(file, "utf8")).toBe("attempt 1\n")
    }))

  it.effect("restores a moved bookmark from a snapshot's operation", () =>
    Effect.gen(function*() {
      const jjText = (...args: ReadonlyArray<string>) =>
        execFileSync("jj", [...args], { cwd: repository, encoding: "utf8" })
      const file = join(repository, "operation.txt")
      yield* Effect.promise(() => writeFile(file, "before\n"))
      jjText("bookmark", "set", "op-restore", "-r", "@", "--allow-backwards")
      const target = jjText("log", "--no-graph", "-r", "op-restore", "-T", "commit_id")
      const snapshot = yield* run(Effect.flatMap(Jj, (jj) => jj.snapshot()))

      yield* Effect.promise(() => writeFile(file, "after\n"))
      jjText("bookmark", "set", "op-restore", "-r", "root()", "--allow-backwards")
      expect(jjText("log", "--no-graph", "-r", "op-restore", "-T", "commit_id")).not.toBe(target)

      yield* run(Effect.flatMap(Jj, (jj) => jj.opRestore!(snapshot.operationId!)))

      expect(jjText("log", "--no-graph", "-r", "op-restore", "-T", "commit_id")).toBe(target)
      expect(readFileSync(file, "utf8")).toBe("before\n")
    }))

  it.effect("refuses to restore an operation that predates another workspace", () =>
    Effect.gen(function*() {
      const snapshot = yield* run(Effect.flatMap(Jj, (jj) => jj.snapshot()))
      const lane = join(repository, "..", `later-${process.pid}`)
      yield* run(Effect.flatMap(Jj, (jj) => jj.workspaceAdd("later", lane)))

      const refused = yield* run(Effect.flip(Effect.flatMap(Jj, (jj) => jj.opRestore!(snapshot.operationId!))))

      expect(isJjError(refused) && refused.code).toBe("conflict")
      expect(refused.message).toContain("later")
      expect(execFileSync("jj", ["workspace", "list"], { cwd: repository, encoding: "utf8" })).toContain("later")
      yield* run(Effect.flatMap(Jj, (jj) => jj.workspaceForget("later")))
      yield* Effect.promise(() => rm(lane, { recursive: true, force: true }))
    }))

  it.effect("refuses an operation id that is not hex without spawning jj, and one jj does not know", () =>
    Effect.gen(function*() {
      const flag = yield* run(Effect.flip(Effect.flatMap(Jj, (jj) => jj.opRestore!("--what=repo"))))
      expect(flag).toMatchObject({ code: "invalid_ref", command: "jj op restore" })
      const unknown = yield* run(Effect.flip(Effect.flatMap(Jj, (jj) => jj.opRestore!("abcdef00"))))
      expect(isJjError(unknown) && unknown.code).toBe("invalid_ref")
    }))

  it.effect("captures and restores a new 2 MiB artifact", () =>
    Effect.gen(function*() {
      const file = join(repository, "large-artifact.bin")
      const contents = Buffer.alloc(2 * 1024 * 1024, 0x61)
      yield* Effect.promise(() => writeFile(file, contents))
      const { commitId } = yield* run(Effect.flatMap(Jj, (jj) => jj.snapshot("large artifact")))
      yield* Effect.promise(() => rm(file))
      yield* run(Effect.flatMap(Jj, (jj) => jj.restore(commitId)))
      expect(readFileSync(file).equals(contents)).toBe(true)
    }))

  for (const operation of ["restore", "diff", "status", "workspaceAdd"] as const) {
    it.effect(`${operation} snapshots a new 2 MiB artifact`, () =>
      Effect.acquireUseRelease(
        Effect.promise(async () => {
          const target = await mkdtemp(join(tmpdir(), "flows-jj-large-"))
          execFileSync("jj", ["git", "init", target], { stdio: "ignore" })
          await writeFile(join(target, "artifact.bin"), Buffer.alloc(2 * 1024 * 1024, 0x61))
          return target
        }),
        (target) =>
          Effect.gen(function*() {
            const jj = yield* Effect.provide(Jj, budgeted(NodeJj.layerAt(target)))
            switch (operation) {
              case "restore":
                yield* jj.restore("@-")
                expect(existsSync(join(target, "artifact.bin"))).toBe(false)
                break
              case "diff":
                expect(yield* jj.diff("@-", "@")).toContain("artifact.bin")
                break
              case "status":
                expect(yield* jj.status()).toContain("artifact.bin")
                break
              case "workspaceAdd":
                yield* jj.workspaceAdd("large", join(target, "lane"))
                expect(existsSync(join(target, "lane", ".jj"))).toBe(true)
                yield* jj.workspaceForget("large")
                break
            }
          }),
        (target) => Effect.promise(() => rm(target, { recursive: true, force: true }))
      ))
  }

  it.effect("snapshots without a message when none is supplied", () =>
    Effect.gen(function*() {
      yield* Effect.promise(() => writeFile(join(repository, "unnamed.txt"), "x\n"))
      const { changeId, commitId } = yield* run(Effect.flatMap(Jj, (jj) => jj.snapshot()))

      expect(changeId).not.toBe("")
      const log = execFileSync("jj", ["log", "-r", commitId, "--no-graph", "-T", "change_id.short()"], {
        cwd: repository,
        encoding: "utf8"
      })
      expect(log.trim()).toBe(changeId)
    }))

  it.effect("snapshots without a message without starting an editor", () =>
    Effect.gen(function*() {
      // `NodeJj.layer` starts its children outside any host spawner, and the
      // bound that makes that acceptable is that every command is short-lived
      // and starts no long-lived child of its own. An editor is the exact
      // opposite: `jj describe` with no `-m` runs `$JJ_EDITOR` and waits for
      // it, so a `snapshot()` with no message would hold an interactive
      // process that no `ProcessLedger` knows about and no cancel deadline
      // covers. The marker editor makes that observable instead of a hang.
      rmSync(editorMarker, { force: true })
      yield* Effect.promise(() => writeFile(join(repository, "no-editor.txt"), "x\n"))

      yield* run(Effect.flatMap(Jj, (jj) => jj.snapshot()))

      expect(existsSync(editorMarker)).toBe(false)
    }))

  it.live("serializes concurrent snapshots in one process and keeps both restorable", () =>
    Effect.acquireUseRelease(
      Effect.promise(async () => {
        const target = await mkdtemp(join(tmpdir(), "flows-node-jj-concurrent-"))
        execFileSync("jj", ["git", "init", target], { stdio: "ignore" })
        await writeFile(join(target, "shared.txt"), "one state\n")
        return target
      }),
      (target) =>
        Effect.gen(function*() {
          const snapshots = yield* Effect.gen(function*() {
            const jj = yield* Jj
            return yield* Effect.all(
              [jj.snapshot("fiber one"), jj.snapshot("fiber two")],
              { concurrency: "unbounded" }
            )
          }).pipe(Effect.provide(budgeted(NodeJj.layerAt(target))))

          // Serialized captures of one tree name one working-copy commit; a
          // race would have left divergent working-copy commits.
          expect(snapshots[0].commitId).toBe(snapshots[1].commitId)

          yield* Effect.gen(function*() {
            const jj = yield* Jj
            yield* jj.restore(snapshots[0].commitId)
            yield* jj.restore(snapshots[1].commitId)
          }).pipe(Effect.provide(budgeted(NodeJj.layerAt(target))))
        }),
      (target) => Effect.promise(() => rm(target, { recursive: true, force: true }))
    ))

  it.live("serializes snapshots across Node processes and keeps both restorable", () =>
    Effect.acquireUseRelease(
      Effect.promise(async () => {
        const target = await mkdtemp(join(tmpdir(), "flows-node-jj-processes-"))
        execFileSync("jj", ["git", "init", target], { stdio: "ignore" })
        await writeFile(join(target, "shared.txt"), "one state\n")
        return target
      }),
      (target) =>
        Effect.gen(function*() {
          const contract = new URL("../src/Jj.ts", import.meta.url).href
          const adapter = new URL("../src/node/NodeJj.ts", import.meta.url).href
          const worker = `
            import * as Effect from "effect/Effect"
            import { Jj } from ${JSON.stringify(contract)}
            import * as NodeJj from ${JSON.stringify(adapter)}
            const result = await Effect.runPromise(
              Effect.flatMap(Jj, (jj) => jj.snapshot(process.argv[2])).pipe(
                Effect.provide(NodeJj.layerAt(process.argv[1]))
              )
            )
            process.stdout.write(JSON.stringify(result))
          `
          const invoke = (message: string) =>
            Effect.promise(() =>
              execFilePromise(
                process.execPath,
                ["--experimental-strip-types", "--input-type=module", "--eval", worker, target, message],
                { cwd: import.meta.dirname, encoding: "utf8" }
              )
            )

          yield* Effect.promise(async () => {
            await mkdir(join(target, ".jj", "smithers.lock"))
            await writeFile(join(target, ".jj", "smithers.lock", `${hostname()}-2147483647-dead`), "")
          })
          const outputs = yield* Effect.all(Array.from({ length: 4 }, (_, i) => invoke(`process ${i}`)), {
            concurrency: "unbounded"
          })
          const snapshots = outputs.map(({ stdout }) => JSON.parse(stdout) as { readonly commitId: string })

          expect(new Set(snapshots.map((snapshot) => snapshot.commitId)).size).toBe(1)

          yield* Effect.gen(function*() {
            const jj = yield* Jj
            for (const snapshot of snapshots) {
              yield* jj.restore(snapshot.commitId)
              expect(readFileSync(join(target, "shared.txt"), "utf8")).toBe("one state\n")
            }
          }).pipe(Effect.provide(budgeted(NodeJj.layerAt(target))))
        }),
      (target) => Effect.promise(() => rm(target, { recursive: true, force: true }))
    ))

  it.live("recovers a repository lock left by a dead process", () =>
    Effect.acquireUseRelease(
      Effect.promise(async () => {
        const target = await mkdtemp(join(tmpdir(), "flows-node-jj-stale-lock-"))
        execFileSync("jj", ["git", "init", target], { stdio: "ignore" })
        await mkdir(join(target, ".jj", "smithers.lock"))
        await writeFile(join(target, ".jj", "smithers.lock", `${hostname()}-2147483647-dead`), "")
        return target
      }),
      (target) =>
        Effect.gen(function*() {
          const snapshot = yield* Effect.flatMap(Jj, (jj) => jj.snapshot("after stale lock")).pipe(
            Effect.provide(budgeted(NodeJj.layerAt(target)))
          )

          expect(snapshot.changeId).not.toBe("")
          expect(existsSync(join(target, ".jj", "smithers.lock"))).toBe(false)
        }),
      (target) => Effect.promise(() => rm(target, { recursive: true, force: true }))
    ))

  it.effect("keeps a bound layer in its repository when process.cwd points elsewhere", () =>
    Effect.acquireUseRelease(
      Effect.promise(async () => {
        const target = await mkdtemp(join(tmpdir(), "flows-node-jj-bound-"))
        execFileSync("jj", ["git", "init", target], { stdio: "ignore" })
        return target
      }),
      (target) =>
        Effect.gen(function*() {
          yield* Effect.promise(() => writeFile(join(repository, "caller-only.txt"), "caller\n"))
          yield* Effect.promise(() => writeFile(join(target, "target-only.txt"), "target\n"))
          // `--ignore-working-copy` reads the last recorded capture without
          // making one, so only the bound layer's snapshot can move it.
          const current = (cwd: string) =>
            execFileSync("jj", ["log", "--ignore-working-copy", "-r", "@", "--no-graph", "-T", "commit_id"], {
              cwd,
              encoding: "utf8"
            }).trim()
          const callerBefore = current(repository)
          const targetBefore = current(target)

          const snapshot = yield* Effect.flatMap(Jj, (jj) => jj.snapshot("bound target")).pipe(
            Effect.provide(budgeted(NodeJj.layerAt(target)))
          )

          expect(current(repository)).toBe(callerBefore)
          expect(current(target)).not.toBe(targetBefore)
          expect(snapshot.commitId).toBe(current(target))
        }),
      (target) => Effect.promise(() => rm(target, { recursive: true, force: true }))
    ))

  it.effect("resolves a relative lane path against the bound root, not the caller's directory", () =>
    Effect.acquireUseRelease(
      Effect.promise(async () => {
        const target = await mkdtemp(join(tmpdir(), "flows-node-jj-relative-"))
        execFileSync("jj", ["git", "init", target], { stdio: "ignore" })
        return target
      }),
      (target) =>
        Effect.gen(function*() {
          // Binding moves what a relative path means. `layer` would create the
          // lane under `process.cwd()`, which is `repository` here, so the same
          // call builds the lane in two different places depending on the layer.
          const lane = `relative-lane-${process.pid}`

          yield* Effect.flatMap(Jj, (jj) => jj.workspaceAdd("relative", lane)).pipe(
            Effect.provide(budgeted(NodeJj.layerAt(target)))
          )

          expect(existsSync(join(target, lane))).toBe(true)
          expect(existsSync(join(repository, lane))).toBe(false)

          yield* Effect.flatMap(Jj, (jj) => jj.workspaceForget("relative")).pipe(
            Effect.provide(budgeted(NodeJj.layerAt(target)))
          )
        }),
      (target) => Effect.promise(() => rm(target, { recursive: true, force: true }))
    ))

  it.effect("adds and forgets a named workspace lane", () =>
    Effect.gen(function*() {
      const lane = join(repository, "..", `lane-${process.pid}`)
      yield* run(Effect.flatMap(Jj, (jj) => jj.workspaceAdd("lane", lane)))
      expect(existsSync(lane)).toBe(true)

      const workspaces = execFileSync("jj", ["workspace", "list"], { cwd: repository, encoding: "utf8" })
      expect(workspaces).toContain("lane")

      yield* run(Effect.flatMap(Jj, (jj) => jj.workspaceForget("lane")))
      expect(execFileSync("jj", ["workspace", "list"], { cwd: repository, encoding: "utf8" }))
        .not.toContain("lane:")
      yield* Effect.promise(() => rm(lane, { recursive: true, force: true }))
    }))

  it.effect("pins a new workspace lane at the requested revision", () =>
    Effect.gen(function*() {
      const file = join(repository, "pinned.txt")
      yield* Effect.promise(() => writeFile(file, "first\n"))
      const { commitId } = yield* run(Effect.flatMap(Jj, (jj) => jj.snapshot("pinned base")))
      yield* Effect.promise(() => writeFile(file, "second\n"))
      yield* run(Effect.flatMap(Jj, (jj) => jj.snapshot("after base")))

      const lane = join(repository, "..", `pinned-${process.pid}`)
      yield* run(Effect.flatMap(Jj, (jj) => jj.workspaceAdd("pinned", lane, commitId)))
      expect(readFileSync(join(lane, "pinned.txt"), "utf8")).toBe("first\n")
      // The captured commit is an earlier version of this workspace's `@`;
      // the lane must not revive it beside `@` as a divergent change.
      expect(execFileSync("jj", ["log", "--no-graph", "-r", "divergent()", "-T", "change_id"], {
        cwd: repository,
        encoding: "utf8"
      })).toBe("")

      yield* run(Effect.flatMap(Jj, (jj) => jj.workspaceForget("pinned")))
      yield* Effect.promise(() => rm(lane, { recursive: true, force: true }))
    }))

  it.effect("classifies an empty workspace revision as `invalid_ref` without spawning jj", () =>
    Effect.gen(function*() {
      const lane = join(repository, "..", `empty-revision-${process.pid}`)
      const failure = yield* run(Effect.flip(Effect.flatMap(Jj, (jj) => jj.workspaceAdd("empty", lane, ""))))

      // `workspaceAdd` also carries `PlatformError` from the guarded
      // implementation's path canonicalization, so the code is only readable
      // after the failure is narrowed to jj's own.
      expect(isJjError(failure) && failure.code).toBe("invalid_ref")
      expect(failure.message).toContain("jj workspaceAdd")
      expect(existsSync(lane)).toBe(false)
    }))

  it.effect("classifies an unknown revision as `invalid_ref`", () =>
    Effect.gen(function*() {
      const error = yield* run(Effect.flip(Effect.flatMap(Jj, (jj) => jj.restore("nosuchchangeid"))))

      expect(error.code).toBe("invalid_ref")
      expect(error.message).toContain("jj restore")
    }))

  it.effect("classifies a malformed revset as `invalid_ref`, agreeing with BrowserJj", () =>
    Effect.gen(function*() {
      // "Failed to parse revset: Syntax error" — the browser layer resolves the
      // same string to invalid_ref, and the code is durable identity in
      // journals, so the two layers must agree.
      const error = yield* run(Effect.flip(Effect.flatMap(Jj, (jj) => jj.diff("@@@bad", "@"))))

      expect(error.code).toBe("invalid_ref")
      expect(error.message).toContain("jj diff")
    }))

  it.effect("classifies an empty revision as `invalid_ref` without spawning jj", () =>
    Effect.gen(function*() {
      const error = yield* run(Effect.flip(Effect.flatMap(Jj, (jj) => jj.restore(""))))

      expect(error.code).toBe("invalid_ref")
      expect(error.message).toBe("jj restore: empty revision string")
    }))

  it.effect("classifies an unrecognized failure as `unknown`", () =>
    Effect.gen(function*() {
      // Running outside any repository is jj's plain "There is no jj repo"
      // error, which matches none of the classified vocabularies.
      const outside = yield* Effect.promise(() => mkdtemp(join(tmpdir(), "flows-node-jj-norepo-")))
      process.chdir(outside)
      try {
        const error = yield* run(Effect.flip(Effect.flatMap(Jj, (jj) => jj.status())))
        expect(error.code).toBe("unknown")
        expect(error.message).toContain("jj status")
      } finally {
        process.chdir(repository)
        yield* Effect.promise(() => rm(outside, { recursive: true, force: true }))
      }
    }))

  it.effect("answers the repository root from a directory inside it", () =>
    Effect.gen(function*() {
      const nested = join(repository, "deep", "nest")
      yield* Effect.promise(() => mkdir(nested, { recursive: true }))

      const root = yield* run(Effect.flatMap(Jj, (jj) => jj.root!(nested)))

      // `realpath` because a temp directory on macOS is reached through a
      // symlink and jj answers with the resolved path.
      expect(root).toBe(realpathSync(repository))
    }))

  it.effect("undoes one change and reports the paths it touched", () =>
    Effect.gen(function*() {
      const file = join(repository, "revert-me.txt")
      commitWorkingCopy("before revert-me")
      yield* Effect.promise(() => writeFile(file, "unwanted\n"))
      const changeId = commitWorkingCopy("add revert-me")
      yield* Effect.promise(() => writeFile(join(repository, "keep.txt"), "kept\n"))
      commitWorkingCopy("add keep")

      const result = yield* run(Effect.flatMap(Jj, (jj) => jj.revert!(changeId)))

      expect(result.reverted).toEqual(["revert-me.txt"])
      // The revert is in the WORKING COPY, not parked somewhere else in the
      // graph: the reverted file is gone and the later change survived.
      expect(existsSync(file)).toBe(false)
      expect(existsSync(join(repository, "keep.txt"))).toBe(true)
    }))

  it.effect("classifies an empty revert revision as `invalid_ref` without spawning jj", () =>
    Effect.gen(function*() {
      const error = yield* run(Effect.flip(Effect.flatMap(Jj, (jj) => jj.revert!(""))))

      expect(error.code).toBe("invalid_ref")
      expect(error.message).toContain("jj revert")
    }))

  it.effect("reports `not_installed` when `jj` is not on PATH, and says how to fix it", () =>
    Effect.gen(function*() {
      const path = process.env.PATH
      const override = process.env.SMITHERS_JJ_PATH
      process.env.PATH = join(repository, "empty-bin")
      delete process.env.SMITHERS_JJ_PATH
      try {
        const error = yield* Effect.flip(run(Jj))
        expect(error.code).toBe("not_installed")
        // The resolver already knows why nothing was found, so the failure says
        // it rather than leaving an operator to run `doctor` for the same fact.
        expect(error.message).toBe(
          "jj: No jj on PATH. Install jj (https://jj-vcs.github.io) or set SMITHERS_JJ_PATH."
        )
        expect(error).toMatchObject({ module: "NodeJj", method: "version", command: "jj --version" })
        // The spawn failure travels on `cause` as data that survives a journal
        // round-trip, rather than as a live `Error` that stringifies to `{}`.
        expect(error.cause).toMatchObject({ code: "ENOENT" })
      } finally {
        process.env.PATH = path
        if (override !== undefined) process.env.SMITHERS_JJ_PATH = override
      }
    }))

  it.effect("answers the repository root for a FILE inside it, not only a directory", () =>
    Effect.gen(function*() {
      // The contract calls `from` "a lane directory or a file an agent named",
      // and `spawn` throws ENOTDIR synchronously for a file `cwd` — a defect
      // rather than a `JjError` — so the file is resolved to its directory.
      const file = join(repository, "named-by-an-agent.txt")
      yield* Effect.promise(() => writeFile(file, "x\n"))

      expect(yield* run(Effect.flatMap(Jj, (jj) => jj.root!(file)))).toBe(realpathSync(repository))
    }))

  it.effect("forwards a lane name and path that begin with a hyphen as positionals", () =>
    Effect.gen(function*() {
      // Without the `--` terminator clap reads `-dash-lane` as a jj flag, so
      // "a workspace name is opaque argv" was only true for names that do not
      // look like options.
      const name = "-dash-lane"
      const lane = "-dash-lane-dir"
      const laneAt = join(repository, lane)

      yield* run(Effect.flatMap(Jj, (jj) => jj.workspaceAdd(name, lane)))
      expect(existsSync(laneAt)).toBe(true)
      expect(execFileSync("jj", ["workspace", "list"], { cwd: repository, encoding: "utf8" })).toContain(name)

      yield* run(Effect.flatMap(Jj, (jj) => jj.workspaceForget(name)))
      expect(execFileSync("jj", ["workspace", "list"], { cwd: repository, encoding: "utf8" })).not.toContain(name)
      yield* Effect.promise(() => rm(laneAt, { recursive: true, force: true }))
    }))

  it.effect("reports reverted paths byte for byte, including leading and trailing spaces", () =>
    Effect.gen(function*() {
      // `jj diff --name-only` emits raw unquoted bytes, so trimming each line
      // reported paths that do not exist on disk.
      const lead = join(repository, " lead.txt")
      const trail = join(repository, "trail .txt")
      // Close whatever earlier cases left in the working copy, so the change
      // under test touches exactly the two spacey names.
      commitWorkingCopy("before spacey")
      yield* Effect.promise(() => writeFile(lead, "a\n"))
      yield* Effect.promise(() => writeFile(trail, "b\n"))
      const changeId = commitWorkingCopy("spacey names")
      yield* Effect.promise(() => writeFile(join(repository, "after-spacey.txt"), "c\n"))
      commitWorkingCopy("after spacey")

      const result = yield* run(Effect.flatMap(Jj, (jj) => jj.revert!(changeId)))

      expect([...result.reverted].sort()).toEqual([" lead.txt", "trail .txt"])
      expect(existsSync(lead)).toBe(false)
      expect(existsSync(trail)).toBe(false)
    }))
})
