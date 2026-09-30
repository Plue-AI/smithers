/**
 * `opRestore` drops every workspace added after the operation it restores, so
 * it compares the workspace lists and restores under one fence. Adding and
 * forgetting workspaces must take the same fence from any workspace of the
 * repository, or an add admitted between the comparison and the restore is
 * silently unregistered (#2555).
 *
 * Every command is a real jj 0.40 command. A shim in front of it only holds a
 * chosen command at the process boundary until the test releases it, so the
 * interleaving is reproducible.
 */
import { afterEach, beforeEach, describe, expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import * as Layer from "effect/Layer"
import * as Schedule from "effect/Schedule"
import { execFileSync } from "node:child_process"
import { existsSync, readFileSync, realpathSync } from "node:fs"
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { isJjError, Jj } from "../src/Jj.ts"
import * as NodeJj from "../src/node/NodeJj.ts"
import { budgeted } from "./budgeted.ts"

const realJj = (() => {
  try {
    return execFileSync("sh", ["-c", "command -v jj"], { encoding: "utf8" }).trim() || undefined
  } catch {
    return undefined
  }
})()

describe.skipIf(realJj === undefined || process.platform === "win32")("NodeJj workspace registration fence", () => {
  let base: string
  let repository: string
  let side: string
  let previous: string | undefined

  const hold = (command: "restore" | "add") => join(base, `hold-${command}`)
  const started = (command: "restore" | "add") => join(base, `started-${command}`)
  const calls = () => readFileSync(join(base, "calls"), "utf8")
  const workspaces = () =>
    execFileSync(realJj!, ["workspace", "list", "-T", "name ++ \"\\n\""], { cwd: repository, encoding: "utf8" })
      .split("\n").filter((line) => line !== "").sort()
  const service = (root: string) => Effect.provide(Jj, budgeted(NodeJj.layerAt(root)))
  const until = (path: string) =>
    Effect.retry(Effect.sync(() => existsSync(path)).pipe(Effect.filterOrFail((ready) => ready)), {
      times: 3_000,
      schedule: Schedule.spaced(10)
    })
  /** Long enough for a fenceless caller to reach the shim and record itself. */
  const settle = Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 500)))

  beforeEach(async () => {
    base = realpathSync(await mkdtemp(join(tmpdir(), "flows-jj-fence-")))
    repository = join(base, "repository")
    side = join(base, "side")
    execFileSync(realJj!, ["git", "init", repository], { stdio: "ignore" })
    execFileSync(realJj!, ["workspace", "add", "--name=side", "--", side], { cwd: repository, stdio: "ignore" })
    execFileSync(realJj!, ["workspace", "add", "--name=gone", "--", join(base, "gone")], {
      cwd: repository,
      stdio: "ignore"
    })
    const shim = join(base, "jj-shim")
    await writeFile(
      shim,
      `#!/bin/sh
base=${JSON.stringify(base)}
printf '%s\\n' "$*" >> "$base/calls"
case "$1 $2" in
  "op restore") : > "$base/started-restore"; while [ -f "$base/hold-restore" ]; do /bin/sleep 0.01; done ;;
  "workspace add") : > "$base/started-add"; while [ -f "$base/hold-add" ]; do /bin/sleep 0.01; done ;;
esac
exec ${JSON.stringify(realJj)} "$@"
`
    )
    await chmod(shim, 0o755)
    await writeFile(join(base, "calls"), "")
    previous = process.env.SMITHERS_JJ_PATH
    process.env.SMITHERS_JJ_PATH = shim
  })

  afterEach(async () => {
    if (previous === undefined) delete process.env.SMITHERS_JJ_PATH
    else process.env.SMITHERS_JJ_PATH = previous
    await rm(base, { recursive: true, force: true })
  })

  it.live("keeps workspaces added or forgotten while a restore holds the fence, from any workspace", () =>
    Effect.gen(function*() {
      const root = yield* service(repository)
      const lane = yield* service(side)
      const snapshot = yield* root.snapshot()
      yield* Effect.promise(() => writeFile(hold("restore"), ""))

      const restoring = yield* Effect.forkChild(root.opRestore!(snapshot.operationId!))
      yield* until(started("restore"))
      const sameService = yield* Effect.forkChild(root.workspaceAdd("late", join(base, "late")))
      const otherLayer = yield* Effect.forkChild(lane.workspaceAdd("later", join(base, "later")))
      const forgetting = yield* Effect.forkChild(lane.workspaceForget("gone"))
      yield* settle

      // Nothing reached jj while the restore was between its check and its write.
      expect(calls()).not.toMatch(/^workspace (add|forget)/m)
      expect(workspaces()).toEqual(["default", "gone", "side"])
      expect(yield* Effect.promise(() => rm(hold("restore")))).toBeUndefined()

      yield* Fiber.join(restoring)
      yield* Fiber.join(sameService)
      yield* Fiber.join(otherLayer)
      yield* Fiber.join(forgetting)
      expect(workspaces()).toEqual(["default", "late", "later", "side"])
      expect(execFileSync(realJj!, ["status"], { cwd: join(base, "late"), encoding: "utf8" })).toContain(
        "Working copy"
      )
      expect(existsSync(join(realpathSync(join(repository, ".jj", "repo")), "smithers.lock"))).toBe(false)
    }))

  it.live("refuses a restore that waited for an add from another workspace", () =>
    Effect.gen(function*() {
      const root = yield* service(repository)
      const lane = yield* service(side)
      const snapshot = yield* root.snapshot()
      yield* Effect.promise(() => writeFile(hold("add"), ""))

      const adding = yield* Effect.forkChild(lane.workspaceAdd("early", join(base, "early")))
      yield* until(started("add"))
      const restoring = yield* Effect.forkChild(root.opRestore!(snapshot.operationId!))
      yield* settle

      // The restore has not compared workspace lists against a half-done add.
      expect(calls()).not.toMatch(/^workspace list/m)
      yield* Effect.promise(() => rm(hold("add")))
      yield* Fiber.join(adding)
      const refused = yield* Effect.flip(Fiber.join(restoring))

      expect(isJjError(refused) && refused.code).toBe("conflict")
      expect(refused.message).toContain("early")
      expect(calls()).not.toMatch(/^op restore/m)
      expect(workspaces()).toEqual(["default", "early", "gone", "side"])
    }))

  it.live("reports an unreadable repository store as a lock failure before running jj", () =>
    Effect.gen(function*() {
      const lane = yield* service(side)
      yield* Effect.promise(() => writeFile(join(side, ".jj", "repo"), "../missing-store\n"))
      const error = yield* Effect.flip(lane.workspaceForget("gone"))
      expect(error).toMatchObject({ module: "NodeJj", method: "workspaceForget" })
      expect(error.message).toContain("repository lock failed")
      expect(calls()).not.toMatch(/^workspace forget/m)
    }))

  it.live("fences registration in-process where no workspace exists", () =>
    Effect.gen(function*() {
      const outside = join(base, "outside")
      yield* Effect.promise(() => mkdir(outside))
      const jj = yield* Effect.provide(Jj, Layer.fresh(budgeted(NodeJj.layerAt(outside))))
      const error = yield* Effect.flip(jj.workspaceAdd("stray", join(base, "stray")))
      expect(error).toMatchObject({ module: "NodeJj", method: "workspaceAdd" })
      expect(calls()).toMatch(/^workspace add/m)
    }))
})
