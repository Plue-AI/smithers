/**
 * Workspace and restore behaviour against a real `jj`, carried over from the
 * 0.x `@smthrs/vcs` suites.
 *
 * `NodeJj.test.ts` fixes the ordinary contract of each operation. These are the
 * requirements the old resolver's real-repository suites recorded because
 * somebody was surprised by them: a restore is a tree replacement and not a
 * merge, forgetting a lane nobody added is success rather than an error, a
 * workspace name is opaque argv and never a shell fragment, and a lane whose
 * directory cannot be created fails with the reason instead of leaving half a
 * workspace behind.
 *
 * Dropped from the 0.x set, with reasons: the bundled `jj` platform packages
 * (`jj-build-system`, the bundled branch of `resolve-jj-binary`) have no rc.0
 * counterpart, because rc.0 vendors no `jj` binaries; `find-vcs-root` and
 * `vcs-tooling-status` covered a git resolver and a `SMITHERS_GIT_PATH`
 * override that rc.0 does not have, and their jj half is `Jj.root` plus
 * `resolveJjBinary`, both already covered.
 */
import { afterAll, beforeAll, describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import * as Fiber from "effect/Fiber"
import { execFileSync } from "node:child_process"
import { chmodSync, existsSync, readFileSync } from "node:fs"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { isJjError, Jj } from "../src/Jj.ts"
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

describe.skipIf(!jjInstalled)("NodeJj workspaces and restore", () => {
  let repository: string
  let previousCwd: string

  const run = <A, E>(effect: Effect.Effect<A, E, Jj>) => Effect.provide(effect, budgeted(NodeJj.layer))
  const workspaces = () => execFileSync("jj", ["workspace", "list"], { cwd: repository, encoding: "utf8" })
  const shellEffect = it.effect.skipIf(process.platform === "win32")
  const shellLive = it.live.skipIf(process.platform === "win32")

  beforeAll(async () => {
    previousCwd = process.cwd()
    repository = await mkdtemp(join(tmpdir(), "flows-node-jj-workspace-"))
    execFileSync("jj", ["git", "init", repository], { stdio: "ignore" })
    process.env.JJ_EDITOR = "true"
    process.chdir(repository)
  })

  afterAll(async () => {
    process.chdir(previousCwd)
    await rm(repository, { recursive: true, force: true })
  })

  it.effect("restores the captured tree rather than merging into it", () =>
    Effect.gen(function*() {
      const tracked = join(repository, "tracked.txt")
      yield* Effect.promise(() => writeFile(tracked, "captured\n"))
      const { commitId } = yield* run(Effect.flatMap(Jj, (jj) => jj.snapshot("capture")))

      // An uncommitted edit and a file that did not exist at capture time.
      const added = join(repository, "added-after.txt")
      yield* Effect.promise(() => writeFile(tracked, "edited after capture\n"))
      yield* Effect.promise(() => writeFile(added, "later\n"))

      yield* run(Effect.flatMap(Jj, (jj) => jj.restore(commitId)))

      // Both halves of the 0.x requirement: the edit is overwritten without a
      // rejection, and the later file is removed. A caller that expects a
      // merge loses work here, which is why it is written down.
      expect(readFileSync(tracked, "utf8")).toBe("captured\n")
      expect(existsSync(added)).toBe(false)
    }))

  it.effect("forgets a lane nobody added, because forgetting is idempotent", () =>
    Effect.gen(function*() {
      // The cleanup path runs after failures too, so a forget that failed on an
      // absent lane would turn one error into two.
      yield* run(Effect.flatMap(Jj, (jj) => jj.workspaceForget("never-added")))
      expect(workspaces()).not.toContain("never-added")
    }))

  it.effect("forwards a workspace name as opaque argv", () =>
    Effect.gen(function*() {
      // Separators, a shell metacharacter, a semicolon, spaces, and a
      // non-ASCII character. Nothing here may reach a shell.
      const name = "lane a/b-$c;d é"
      const lane = join(repository, "..", `opaque-${process.pid}`)

      yield* run(Effect.flatMap(Jj, (jj) => jj.workspaceAdd(name, lane)))
      expect(workspaces()).toContain(name)
      expect(existsSync(lane)).toBe(true)

      yield* run(Effect.flatMap(Jj, (jj) => jj.workspaceForget(name)))
      expect(workspaces()).not.toContain(name)
      yield* Effect.promise(() => rm(lane, { recursive: true, force: true }))
    }))

  it.effect("reports the reason a lane directory could not be created", () =>
    Effect.gen(function*() {
      const lane = join(repository, "tracked.txt", "nested")
      const failure = yield* run(Effect.flip(Effect.flatMap(Jj, (jj) => jj.workspaceAdd("unwritable", lane))))

      expect(isJjError(failure) && failure.code).toBe("unknown")
      expect(failure.message).toContain("jj workspaceAdd")
      expect(workspaces()).not.toContain("unwritable")
      expect(existsSync(lane)).toBe(false)
    }))

  it.effect("rejects an ambiguous revset before creating a lane, then accepts the same name", () =>
    Effect.gen(function*() {
      const lane = join(repository, "..", `ambiguous-revset-${process.pid}`)
      const failure = yield* run(Effect.flip(Effect.flatMap(Jj, (jj) => jj.workspaceAdd("ambiguous", lane, "@|@-"))))

      expect(isJjError(failure) && failure.code).toBe("invalid_ref")
      expect(failure.message).toContain("is not a commit id or change id")
      expect(workspaces()).not.toContain("ambiguous:")
      expect(existsSync(lane)).toBe(false)

      yield* run(Effect.flatMap(Jj, (jj) => jj.workspaceAdd("ambiguous", lane, "@")))
      expect(workspaces()).toContain("ambiguous:")
      yield* run(Effect.flatMap(Jj, (jj) => jj.workspaceForget("ambiguous")))
      yield* Effect.promise(() => rm(lane, { recursive: true, force: true }))
    }))

  shellEffect(
    "forgets a new lane when pinning fails and preserves the pin error",
    () =>
      Effect.gen(function*() {
        const shim = join(repository, "..", `jj-pin-failure-${process.pid}.sh`)
        const failedLane = join(repository, "..", `failed-pin-${process.pid}`)
        const retryLane = join(repository, "..", `retry-pin-${process.pid}`)
        const previousBinary = process.env.SMITHERS_JJ_PATH
        // Every successful operation uses real jj. The one-shot restore failure
        // occurs only after real jj has registered the new workspace.
        yield* Effect.promise(() =>
          writeFile(
            shim,
            `#!/bin/sh
if [ "$1" = restore ] && [ -e "$0.fail" ]; then
  rm "$0.fail"
  printf 'pin failed on purpose\\n' >&2
  exit 1
fi
exec jj "$@"
`
          )
        )
        chmodSync(shim, 0o755)
        yield* Effect.promise(() => writeFile(`${shim}.fail`, ""))
        process.env.SMITHERS_JJ_PATH = shim
        try {
          yield* Effect.gen(function*() {
            const jj = yield* Jj
            const failure = yield* Effect.flip(jj.workspaceAdd("failed-pin", failedLane, "@"))

            expect(failure).toMatchObject({
              _tag: "@smthrs/jj/JjError",
              module: "NodeJj",
              method: "workspaceAdd"
            })
            expect(isJjError(failure) && failure.command).toContain("jj restore")
            expect(failure.message).toContain("pin failed on purpose")
            expect(workspaces()).not.toContain("failed-pin:")

            yield* jj.workspaceAdd("failed-pin", retryLane, "@")
            expect(workspaces()).toContain("failed-pin:")
            yield* jj.workspaceForget("failed-pin")
          }).pipe(Effect.provide(budgeted(NodeJj.layerAt(repository))))
        } finally {
          if (previousBinary === undefined) delete process.env.SMITHERS_JJ_PATH
          else process.env.SMITHERS_JJ_PATH = previousBinary
          yield* Effect.promise(() =>
            Promise.all([
              rm(shim, { force: true }),
              rm(`${shim}.fail`, { force: true }),
              rm(failedLane, { recursive: true, force: true }),
              rm(retryLane, { recursive: true, force: true })
            ]).then(() => undefined)
          )
        }
      })
  )

  shellEffect(
    "keeps the pin error when forgetting the failed lane also fails",
    () =>
      Effect.gen(function*() {
        const shim = join(repository, "..", `jj-forget-failure-${process.pid}.sh`)
        const lane = join(repository, "..", `failed-forget-${process.pid}`)
        const previousBinary = process.env.SMITHERS_JJ_PATH
        yield* Effect.promise(() =>
          writeFile(
            shim,
            `#!/bin/sh
if [ "$1" = restore ]; then
  printf 'pin failed on purpose\\n' >&2
  exit 1
fi
if [ "$1" = workspace ] && [ "$2" = forget ]; then
  printf 'forget failed on purpose\\n' >&2
  exit 1
fi
exec jj "$@"
`
          )
        )
        chmodSync(shim, 0o755)
        process.env.SMITHERS_JJ_PATH = shim
        try {
          const failure = yield* Effect.gen(function*() {
            const jj = yield* Jj
            return yield* Effect.flip(jj.workspaceAdd("failed-forget", lane, "@"))
          }).pipe(Effect.provide(budgeted(NodeJj.layerAt(repository))))

          expect(failure).toMatchObject({
            _tag: "@smthrs/jj/JjError",
            module: "NodeJj",
            method: "workspaceAdd"
          })
          expect(isJjError(failure) && failure.command).toContain("jj restore")
          expect(failure.message).toContain("pin failed on purpose")
          expect(failure.message).not.toContain("forget failed on purpose")
          expect(workspaces()).toContain("failed-forget:")
        } finally {
          if (previousBinary === undefined) delete process.env.SMITHERS_JJ_PATH
          else process.env.SMITHERS_JJ_PATH = previousBinary
          execFileSync("jj", ["workspace", "forget", "--", "failed-forget"], { cwd: repository, stdio: "ignore" })
          yield* Effect.promise(() =>
            Promise.all([
              rm(shim, { force: true }),
              rm(lane, { recursive: true, force: true })
            ]).then(() => undefined)
          )
        }
        expect(workspaces()).not.toContain("failed-forget:")
      })
  )

  shellLive(
    "returns the pin error when forgetting stalls",
    () =>
      Effect.gen(function*() {
        const shim = join(repository, "..", `jj-stalled-forget-${process.pid}.sh`)
        const forgetting = `${shim}.forgetting`
        const lane = join(repository, "..", `stalled-forget-${process.pid}`)
        const previousBinary = process.env.SMITHERS_JJ_PATH
        yield* Effect.promise(() =>
          writeFile(
            shim,
            `#!/bin/sh
if [ "$1" = restore ]; then
  printf 'pin failed on purpose\\n' >&2
  exit 1
fi
if [ "$1" = workspace ] && [ "$2" = forget ]; then
  : > "$0.forgetting"
  exec /bin/sleep 12
fi
exec jj "$@"
`
          )
        )
        chmodSync(shim, 0o755)
        process.env.SMITHERS_JJ_PATH = shim
        try {
          const startedAt = Date.now()
          const failure = yield* Effect.gen(function*() {
            const jj = yield* Jj
            return yield* Effect.flip(jj.workspaceAdd("stalled-forget", lane, "@"))
          }).pipe(Effect.provide(budgeted(NodeJj.layerAt(repository))))

          expect(Date.now() - startedAt).toBeLessThan(9_000)
          expect(existsSync(forgetting)).toBe(true)
          expect(failure).toMatchObject({
            _tag: "@smthrs/jj/JjError",
            module: "NodeJj",
            method: "workspaceAdd"
          })
          expect(isJjError(failure) && failure.command).toContain("jj restore")
          expect(failure.message).toContain("pin failed on purpose")
          expect(workspaces()).toContain("stalled-forget:")
        } finally {
          if (previousBinary === undefined) delete process.env.SMITHERS_JJ_PATH
          else process.env.SMITHERS_JJ_PATH = previousBinary
          execFileSync("jj", ["workspace", "forget", "--", "stalled-forget"], { cwd: repository, stdio: "ignore" })
          yield* Effect.promise(() =>
            Promise.all([
              rm(shim, { force: true }),
              rm(forgetting, { force: true }),
              rm(lane, { recursive: true, force: true })
            ]).then(() => undefined)
          )
        }
        expect(workspaces()).not.toContain("stalled-forget:")
      }),
    20_000
  )

  shellLive(
    "interrupts a stalled pin and forgets its registered lane",
    () =>
      Effect.gen(function*() {
        const shim = join(repository, "..", `jj-stalled-pin-${process.pid}.sh`)
        const started = `${shim}.started`
        const lane = join(repository, "..", `stalled-pin-${process.pid}`)
        const previousBinary = process.env.SMITHERS_JJ_PATH
        yield* Effect.promise(() =>
          writeFile(
            shim,
            `#!/bin/sh
if [ "$1" = restore ]; then
  : > "$0.started"
  exec /bin/sleep 8
fi
exec jj "$@"
`
          )
        )
        chmodSync(shim, 0o755)
        process.env.SMITHERS_JJ_PATH = shim
        try {
          yield* Effect.gen(function*() {
            const jj = yield* Jj
            const fiber = yield* Effect.forkChild(jj.workspaceAdd("stalled-pin", lane, "@"), {
              startImmediately: true
            })
            try {
              yield* Effect.promise(async () => {
                const deadline = Date.now() + 5_000
                while (!existsSync(started)) {
                  if (Date.now() > deadline) throw new Error("jj restore never started")
                  await new Promise((resolve) => setTimeout(resolve, 10))
                }
              })
              expect(workspaces()).toContain("stalled-pin:")

              const interruptedAt = Date.now()
              yield* Fiber.interrupt(fiber)
              expect(Date.now() - interruptedAt).toBeLessThan(3_000)
              expect(workspaces()).not.toContain("stalled-pin:")
            } finally {
              yield* Fiber.interrupt(fiber)
            }
          }).pipe(Effect.provide(budgeted(NodeJj.layerAt(repository))))
        } finally {
          if (previousBinary === undefined) delete process.env.SMITHERS_JJ_PATH
          else process.env.SMITHERS_JJ_PATH = previousBinary
          execFileSync("jj", ["workspace", "forget", "--", "stalled-pin"], { cwd: repository, stdio: "ignore" })
          yield* Effect.promise(() =>
            Promise.all([
              rm(shim, { force: true }),
              rm(started, { force: true }),
              rm(lane, { recursive: true, force: true })
            ]).then(() => undefined)
          )
        }
      }),
    30_000
  )
})
