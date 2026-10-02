import { Action, Flow, Interpreter } from "@smthrs/flow"
import { Duration, Effect, Layer, Schema, Semaphore } from "effect"
import { existsSync, statfsSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import { HostFailed, run } from "./host.ts"

export const diskFloor = 25 * 1024 ** 3
export const workspaceBytes = 3 * 1024 ** 3
export const statfsFree = () => {
  const home = join(homedir(), ".microsandbox")
  const stats = statfsSync(existsSync(home) ? home : homedir())
  return stats.bavail * stats.bsize
}

export interface DiskOptions {
  readonly freeBytes?: (() => number) | undefined
  readonly minimum?: number | undefined
  readonly interval?: Duration.Input | undefined
  readonly cleanupTimeout?: Duration.Input | undefined
  readonly cleanGo?: Effect.Effect<unknown, unknown> | undefined
  readonly prunePnpm?: Effect.Effect<unknown, unknown> | undefined
  /** Deletes only workspaces with durable settlement and no live holder. */
  readonly reapSettled?: Effect.Effect<unknown, unknown> | undefined
}

let reapSettled: Effect.Effect<unknown, unknown> = Effect.void
export const configureDiskReaper = (reap: Effect.Effect<unknown, unknown>) => {
  reapSettled = reap
}
const turn = Semaphore.makeUnsafe(1)
const bounded = (effect: Effect.Effect<unknown, unknown>, duration: Duration.Input = "2 minutes") =>
  effect.pipe(
    Effect.timeoutOrElse({ duration, orElse: () => Effect.void }),
    Effect.ignore
  )

/** Cleanup once per admission attempt, recheck, then wait without repeating destructive work. */
export const makeDiskGate = (options: DiskOptions = {}) => (reserveBytes = 0) =>
  turn.withPermits(1)(Effect.gen(function*() {
    const probe = options.freeBytes ?? statfsFree
    const required = (options.minimum ?? diskFloor) + reserveBytes
    const free = () =>
      Effect.try({
        try: () => {
          const bytes = probe()
          if (!Number.isFinite(bytes) || bytes < 0) throw new Error("invalid free-space reading")
          return bytes
        },
        catch: (cause) => new HostFailed({ message: `disk probe: ${String(cause)}` })
      })
    const clean = (effect: Effect.Effect<unknown, unknown>) => bounded(effect, options.cleanupTimeout)
    if ((yield* free()) >= required) return
    if (options.cleanGo !== undefined) {
      yield* clean(options.cleanGo)
    } else {
      yield* clean(run("go", ["clean", "-cache"]))
      yield* clean(run("go", ["clean", "-cache"], {
        env: { GOCACHE: join(tmpdir(), "issue-sweep-go-build") }
      }))
    }
    yield* clean(options.prunePnpm ?? run("pnpm", ["store", "prune"]))
    yield* clean(options.reapSettled ?? Effect.suspend(() => reapSettled))
    while ((yield* free()) < required) yield* Effect.sleep(options.interval ?? "30 seconds")
  }))

export const awaitHostDisk = makeDiskGate()
export const EnsureDisk = Action.make("issue-sweep/ensure-disk", {
  payload: Schema.Struct({ reserveBytes: Schema.Number.check(Schema.isGreaterThanOrEqualTo(0)) }),
  success: Schema.Void,
  error: HostFailed,
  nondeterministic: true,
  effects: { reads: ["**"], writes: ["**"], mode: "expected", onConflict: "serialize" }
})
export const DiskAdmission = Flow.make("issue-sweep/disk-admission", {
  description: "Reclaims bounded host caches and waits for safe disk admission.",
  capabilities: [],
  effects: { reads: ["**"], writes: ["**"], mode: "expected", onConflict: "serialize" },
  modelInvocable: false,
  payload: EnsureDisk.payloadSchema,
  success: Schema.Void,
  error: HostFailed,
  body: (input) => EnsureDisk.call(input)
})
export const makeDiskLayer = (gate = awaitHostDisk) =>
  Layer.mergeAll(
    EnsureDisk.toLayer(({ reserveBytes }) => gate(reserveBytes)),
    Interpreter.layer(DiskAdmission)
  )
export const diskLayer = makeDiskLayer()

/** Durable final rows nominate candidates; current ownership must independently prove free. */
export const makeSettledWorkspaceReaper = (options: {
  readonly check: (repo: string, issue: number) => Effect.Effect<boolean, unknown>
  readonly remove: (issue: number) => Effect.Effect<unknown, unknown>
}) => {
  const candidates = new Map<number, string>()
  return {
    remember: (repo: string, rows: ReadonlyArray<{ readonly id: string; readonly status: string }>) => {
      for (const row of rows) {
        const issue = Number(row.id)
        if (!Number.isSafeInteger(issue) || issue <= 0) continue
        if (row.status === "landed" || row.status === "failed") candidates.set(issue, repo)
        else candidates.delete(issue)
      }
    },
    reap: Effect.gen(function*() {
      for (const [issue, repo] of candidates) {
        const free = yield* options.check(repo, issue).pipe(Effect.catch(() => Effect.succeed(false)))
        if (!free || candidates.get(issue) !== repo) continue
        yield* options.remove(issue)
        candidates.delete(issue)
      }
    })
  }
}
