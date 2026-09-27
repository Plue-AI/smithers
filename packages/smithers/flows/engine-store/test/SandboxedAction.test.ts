import * as NodePath from "@effect/platform-node/NodePath"
import { opaqueHandlerBody } from "./fixtures/OpaqueHandlerBody.ts"
/**
 * The lane this suite proves: an action body runs in an isolated workspace
 * and returns a result, not a mutation.
 *
 * Before it, `StepBoundary`'s production filesystem layer could not observe
 * writes outside the paths it was told about, so it never set
 * `wholeTreeWritesVerified` — and `ActionPersistence`'s cache-admission gate
 * requires it. The consequence was that NO result recorded under the
 * production composition ever reached the shared cross-run cache; only
 * `StepBoundary.layerTest` ever admitted one. The first test here is exactly
 * the case that was impossible.
 */
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem"
import { describe, expect, it } from "@effect/vitest"
import * as ArtifactStore from "@smthrs/artifacts/ArtifactStore"
import { Action, Flow } from "@smthrs/flow"
import { Jj } from "@smthrs/kernel"
import * as KernelFileSystem from "@smthrs/kernel/FileSystem"
import * as GrantStore from "@smthrs/kernel/GrantStore"
import * as KernelWorkspace from "@smthrs/kernel/Workspace"
import { Node } from "@smthrs/plan"
import * as AtomicFileSystem from "@smthrs/platform-node/AtomicFileSystem"
import { AttemptStore, type Ownership, RunStore } from "@smthrs/run-store"
import { CacheStore } from "@smthrs/step-cache"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as DurableEngineState from "../src/DurableEngineState.ts"
import * as EngineStore from "../src/EngineStore.ts"
import * as ActionPersistence from "../src/internal/ActionPersistence.ts"
import * as JournalRecords from "../src/internal/JournalRecords.ts"
import * as SandboxedExecution from "../src/internal/SandboxedExecution.ts"
import * as StepBoundary from "../src/StepBoundary.ts"
import * as TestStores from "../src/test/TestStores.ts"
import * as WorkspaceSandbox from "../src/WorkspaceSandbox.ts"
import { sha256, withCrypto } from "./Sha256.ts"

const owner: Ownership.OwnerId = { hostId: "sandbox-host", pid: 77, nonce: "sandbox-process" }

const decoder = new TextDecoder()
const encoder = new TextEncoder()

const jjLayer = Layer.succeed(
  Jj.Jj,
  Jj.make({
    snapshot: () => Effect.succeed({ commitId: "sandbox-snapshot" as never, changeId: "sandbox-snapshot" as never }),
    restore: () => Effect.void,
    diff: () => Effect.succeed(""),
    workspaceAdd: () => Effect.void,
    workspaceForget: () => Effect.void,
    status: () => Effect.succeed("")
  })
)

/**
 * The PRODUCTION composition: the filesystem-backed boundary and the
 * filesystem-backed workspace sandbox over a real temporary workspace. No
 * `layerTest` anywhere.
 */
const production = (root: string, sandboxed: boolean) => {
  // The kernel-guarded filesystem rooted at the workspace: declarations are
  // workspace-relative and resolve against `root` on every host operation.
  const host = KernelFileSystem.layer.pipe(
    Layer.provide(AtomicFileSystem.layer),
    Layer.provideMerge(NodePath.layer),
    Layer.provide(KernelWorkspace.layer(root)),
    Layer.provide(GrantStore.layerNoop)
  )
  const artifacts = ArtifactStore.layerFileSystem({ directory: join(root, ".flows/objects") }).pipe(
    Layer.provideMerge(host)
  )
  const boundary = StepBoundary.layer.pipe(Layer.provide(artifacts))
  return Layer.mergeAll(
    boundary,
    jjLayer,
    ...(sandboxed
      ? [
        WorkspaceSandbox.layerFileSystem().pipe(
          Layer.provide(artifacts),
          Layer.provide(KernelWorkspace.layer(root))
        )
      ]
      : [])
  ).pipe(Layer.provideMerge(artifacts))
}

const workspace = () => mkdtempSync(join(tmpdir(), "flows-sandbox-"))

const seed = (root: string, files: Readonly<Record<string, string>>) =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    for (const [path, content] of Object.entries(files)) {
      yield* fs.makeDirectory(join(root, path, ".."), { recursive: true })
      yield* fs.writeFileString(join(root, path), content)
    }
  }).pipe(Effect.provide(NodeFileSystem.layer), Effect.orDie)

const hostText = (root: string, path: string) =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    return (yield* fs.exists(join(root, path))) ? yield* fs.readFileString(join(root, path)) : undefined
  }).pipe(Effect.provide(NodeFileSystem.layer), Effect.orDie)

const activate = (runId: string) =>
  Effect.gen(function*() {
    const runs = yield* RunStore.RunStore
    yield* runs.create(runId, "{}")
    const row = yield* runs.get(runId)
    const snapshot = { status: row.status, owner: row.owner, heartbeatAtMs: row.heartbeatAtMs }
    const claim = yield* runs.claim(runId, snapshot, owner, 1)
    if (claim._tag !== "Claimed") return yield* Effect.die(new Error("claim lost"))
    const activated = yield* runs.activate(runId, owner, claim.claimedAtMs, snapshot)
    if (activated._tag !== "Activated") return yield* Effect.die(new Error("activation lost"))
  })

const dispatch = (
  runId: string,
  key: string,
  metadata: ActionPersistence.BoundaryMetadata,
  execute: () => Effect.Effect<unknown, unknown>
) =>
  ActionPersistence.make({ runId, owner, sourceId: `sandbox-${runId}`, execute })({
    action: {},
    attempt: 1,
    key,
    tier: "sealed",
    metadata
  })

/**
 * The engine's encoded action effect is opaque (`Effect<unknown, unknown>`):
 * the services a body reads are resolved from whatever context it runs in,
 * which is precisely the seam the sandbox re-seeds. These helpers reproduce
 * that erasure rather than pretending the requirement is visible here.
 */
const body = <A, R>(effect: Effect.Effect<A, never, R>): Effect.Effect<unknown, unknown, never> =>
  effect as unknown as Effect.Effect<unknown, unknown, never>

/** An ordinary action body: it knows nothing about sandboxes. */
const renderer = (input: string, output: string) =>
  body(
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const content = yield* fs.readFileString(input)
      yield* fs.writeFileString(output, `${content}!`)
      return { rendered: content.length }
    }).pipe(Effect.orDie)
  )

describe("sealed actions under the production composition", () => {
  it.effect("admits a hard-boundary result to the shared cache — impossible before this lane", () =>
    Effect.gen(function*() {
      const root = workspace()
      const key = "sandbox/admitted"
      const metadata: ActionPersistence.BoundaryMetadata = {
        readSet: [{ path: "src/in.txt", digest: sha256("hello") }],
        writeSet: ["out/result.txt"],
        boundaryMode: "hard"
      }
      const program = Effect.gen(function*() {
        yield* seed(root, { "src/in.txt": "hello" })
        const cache = yield* CacheStore.CacheStore
        const attempts = yield* AttemptStore.AttemptStore
        yield* activate("sandbox-admit")
        const result = yield* dispatch(
          "sandbox-admit",
          key,
          metadata,
          () => renderer(join(root, "src/in.txt"), join(root, "out/result.txt"))
        ).pipe(Effect.provide(production(root, true)))
        const entry = yield* cache.get(sha256(key))
        const row = yield* attempts.get({ runId: "sandbox-admit", stepKeyDigest: sha256(key), attempt: 1 })
        return { entry, result, row }
      }).pipe(Effect.provide(TestStores.layer()))

      const { entry, result, row } = yield* withCrypto(program)
      expect(result).toEqual({ rendered: 5 })
      // THE HEADLINE: a production-composed sealed action is in the shared
      // cross-run cache, with honest whole-tree evidence behind it.
      expect(Option.isSome(entry)).toBe(true)
      expect(Option.isSome(entry) ? (entry.value.meta as { boundary?: unknown }).boundary : undefined)
        .toMatchObject({ wholeTreeWritesVerified: true })
      expect(Option.isSome(row) ? row.value.state : undefined).toBe("succeeded")
      // The copy-back is on the host, and the file is exactly what the isolated
      // body produced.
      expect(yield* withCrypto(hostText(root, "out/result.txt"))).toBe("hello!")
    }))

  it.effect("records no shared entry under the same composition without a sandbox", () =>
    Effect.gen(function*() {
      const root = workspace()
      const key = "sandbox/unsandboxed"
      const metadata: ActionPersistence.BoundaryMetadata = {
        readSet: [{ path: "src/in.txt", digest: sha256("hello") }],
        writeSet: ["out/result.txt"],
        boundaryMode: "hard"
      }
      const program = Effect.gen(function*() {
        // The unsandboxed body writes straight to the host, so its output
        // directory has to exist first — the copy-back that creates one is
        // exactly what this composition does not have.
        yield* seed(root, { "out/.keep": "", "src/in.txt": "hello" })
        const cache = yield* CacheStore.CacheStore
        yield* activate("sandbox-none")
        yield* dispatch(
          "sandbox-none",
          key,
          metadata,
          () => renderer(join(root, "src/in.txt"), join(root, "out/result.txt"))
        ).pipe(Effect.provide(production(root, false)))
        return yield* cache.get(sha256(key))
      }).pipe(Effect.provide(TestStores.layer()))

      // The pre-existing behaviour, kept honest rather than papered over: the
      // filesystem boundary alone cannot claim whole-tree verification, so its
      // result stays run-local.
      expect(Option.isNone(yield* withCrypto(program))).toBe(true)
    }))

  it.effect("leaves the host untouched and journals nothing applied when the declaration is violated", () =>
    Effect.gen(function*() {
      const root = workspace()
      const key = "sandbox/violation"
      const metadata: ActionPersistence.BoundaryMetadata = {
        readSet: [{ path: join(root, "src/in.txt"), digest: sha256("hello") }],
        writeSet: [join(root, "out/declared.txt")],
        boundaryMode: "hard"
      }
      const program = Effect.gen(function*() {
        yield* seed(root, { "src/in.txt": "hello" })
        const attempts = yield* AttemptStore.AttemptStore
        yield* activate("sandbox-violation")
        const failure = yield* Effect.flip(
          dispatch("sandbox-violation", key, metadata, () =>
            body(
              Effect.gen(function*() {
                const fs = yield* FileSystem.FileSystem
                yield* fs.writeFileString(join(root, "out/surprise.txt"), "undeclared")
                return null
              }).pipe(Effect.orDie)
            )).pipe(Effect.provide(production(root, true)))
        )
        const row = yield* attempts.get({ runId: "sandbox-violation", stepKeyDigest: sha256(key), attempt: 1 })
        const records = (yield* JournalRecords.entries("sandbox-violation", undefined, 100)).entries
        return { failure, records, row }
      }).pipe(Effect.provide(TestStores.layer()))

      const { failure, records, row } = yield* withCrypto(program)
      expect(failure).toMatchObject({
        _tag: "@smthrs/engine-store/UndeclaredWrite",
        paths: ["out/surprise.txt"]
      })
      // The row records the violation so a crash-replay re-emits it, and the
      // journal carries the hard-violation record.
      expect(Option.isSome(row) ? (row.value.meta as { hardViolation?: true }).hardViolation : undefined).toBe(true)
      expect(records.some((record) => record.eventType === "flows.engine.hard-violation")).toBe(true)
      // NOTHING REACHED THE HOST. The candidate write never existed outside the
      // transaction, and no copy-back was journalled.
      expect(yield* withCrypto(hostText(root, "out/surprise.txt"))).toBeUndefined()
      expect(records.some((record) => record.eventType === "flows.engine.copy-back-settled")).toBe(false)
    }))

  it.effect("journals the captured bundle and the settled copy-back, and dispatches queued effects once", () =>
    Effect.gen(function*() {
      const root = workspace()
      const key = "sandbox/effects"
      const dispatched: Array<WorkspaceSandbox.QueuedEffect> = []
      const metadata: ActionPersistence.BoundaryMetadata = {
        readSet: [],
        writeSet: [join(root, "out/result.txt")],
        boundaryMode: "hard"
      }
      const program = Effect.gen(function*() {
        yield* activate("sandbox-effects")
        yield* dispatch("sandbox-effects", key, metadata, () =>
          body(
            Effect.gen(function*() {
              const inner = yield* WorkspaceSandbox.Workspace
              yield* inner.writeFile("out/result.txt", encoder.encode("done"))
              yield* inner.queueEffect({ protocol: "chat/v1", idempotencyKey: "reply-1", payload: { n: 1 } })
              // The same idempotency key queued twice must reach the world once.
              yield* inner.queueEffect({ protocol: "chat/v1", idempotencyKey: "reply-1", payload: { n: 2 } })
              yield* inner.queueEffect({ protocol: "chat/v1", idempotencyKey: "reply-2", payload: { n: 3 } })
              return null
            }).pipe(Effect.orDie)
          )).pipe(
            Effect.provide(
              WorkspaceSandbox.layerDispatcher({
                dispatch: (effect) =>
                  Effect.sync(() => {
                    // Proof the dispatch stage runs after copy-back, never
                    // inside the transaction.
                    dispatched.push(effect)
                  })
              })
            ),
            Effect.provide(production(root, true))
          )
        return (yield* JournalRecords.entries("sandbox-effects", undefined, 100)).entries
      }).pipe(Effect.provide(TestStores.layer()))

      const records = yield* withCrypto(program)
      const captured = records.find((record) => record.eventType === "flows.engine.diff-bundle-captured")
      const settled = records.find((record) => record.eventType === "flows.engine.copy-back-settled")
      expect(captured?.payload).toMatchObject({ changedPaths: ["out/result.txt"], deviations: [] })
      expect(settled).toBeDefined()
      const payload = settled!.payload as { readonly queued: unknown; readonly dispatched: unknown }
      expect(payload).toMatchObject({
        rebases: 0,
        queued: ["reply-1", "reply-2"],
        dispatched: ["reply-1", "reply-2"]
      })
      expect(payload.dispatched).toEqual(payload.queued)
      expect(dispatched.map((effect) => effect.idempotencyKey)).toEqual(["reply-1", "reply-2"])
      expect(dispatched[0]?.payload).toEqual({ n: 1 })
      expect(yield* withCrypto(hostText(root, "out/result.txt"))).toBe("done")
    }))

  it.effect("journals what a transaction queued and sends nothing when no dispatcher is composed", () =>
    Effect.gen(function*() {
      const root = workspace()
      const key = "sandbox/undispatched"
      const metadata: ActionPersistence.BoundaryMetadata = {
        readSet: [],
        writeSet: [join(root, "out/result.txt")],
        boundaryMode: "hard"
      }
      const program = Effect.gen(function*() {
        yield* activate("sandbox-undispatched")
        yield* dispatch("sandbox-undispatched", key, metadata, () =>
          body(
            Effect.gen(function*() {
              const inner = yield* WorkspaceSandbox.Workspace
              yield* inner.writeFile("out/result.txt", encoder.encode("done"))
              yield* inner.queueEffect({ protocol: "chat/v1", idempotencyKey: "reply-1", payload: {} })
              yield* inner.queueEffect({ protocol: "chat/v1", idempotencyKey: "reply-2", payload: {} })
              return null
            }).pipe(Effect.orDie)
          )).pipe(Effect.provide(production(root, true)))
        return (yield* JournalRecords.entries("sandbox-undispatched", undefined, 100)).entries
      }).pipe(Effect.provide(TestStores.layer()))

      const records = yield* withCrypto(program)
      // Visible, not silent: the outbox is journalled even with no delivery
      // stage composed, so an undelivered effect is a recorded fact.
      expect(records.find((record) => record.eventType === "flows.engine.copy-back-settled")?.payload)
        .toMatchObject({ queued: ["reply-1", "reply-2"], dispatched: [] })
      expect(yield* withCrypto(hostText(root, "out/result.txt"))).toBe("done")
    }))

  it.effect("journals a whole-tree deviation in expected mode instead of failing", () =>
    Effect.gen(function*() {
      const root = workspace()
      const key = "sandbox/expected"
      const metadata: ActionPersistence.BoundaryMetadata = {
        readSet: [],
        writeSet: [join(root, "out/declared.txt")],
        boundaryMode: "expected"
      }
      const program = Effect.gen(function*() {
        const cache = yield* CacheStore.CacheStore
        yield* activate("sandbox-expected")
        yield* dispatch("sandbox-expected", key, metadata, () =>
          body(
            Effect.gen(function*() {
              const fs = yield* FileSystem.FileSystem
              yield* fs.writeFileString(join(root, "out/surprise.txt"), "deviating")
              return null
            }).pipe(Effect.orDie)
          )).pipe(Effect.provide(production(root, true)))
        const records = (yield* JournalRecords.entries("sandbox-expected", undefined, 100)).entries
        return { entry: yield* cache.get(sha256(key)), records }
      }).pipe(Effect.provide(TestStores.layer()))

      const { entry, records } = yield* withCrypto(program)
      const deviation = records.find((record) => record.eventType === "flows.engine.expected-set-deviation")
      // The declared-read scan `StepBoundary.settle` performs would never have
      // seen this path; the whole-tree diff does.
      expect(deviation?.payload).toMatchObject({ paths: ["out/surprise.txt"] })
      // A deviating result is applied but never shared.
      expect(Option.isNone(entry)).toBe(true)
      expect(yield* withCrypto(hostText(root, "out/surprise.txt"))).toBe("deviating")
    }))
})

/**
 * `EngineStore.make` resolves services once and re-provides them onto the
 * engine's fiber, which does not carry the store's layer context. The sandbox
 * and its dispatch stage have to travel the same way or an action would
 * silently run unsandboxed under a composition that declared one.
 */
describe("EngineStore composition", () => {
  const SandboxFlow = Flow.make("SandboxedAction/Flow", {
    payload: {},
    success: Schema.String,
    body: opaqueHandlerBody
  })

  it.effect("carries the sandbox and the dispatch stage onto the engine's own fiber", () =>
    Effect.gen(function*() {
      const delivered: Array<string> = []
      let dispatches = 0
      const sealed = Action.make({
        name: "sandboxed",
        success: Schema.String,
        tier: "sealed",
        idempotencyKey: "engine-store-sandboxed-v1",
        metadata: { readSet: [], writeSet: ["out.txt"], boundaryMode: "hard" },
        execute: Effect.gen(function*() {
          dispatches++
          const inner = yield* WorkspaceSandbox.Workspace
          yield* inner.writeFile("out.txt", encoder.encode("produced"))
          yield* inner.queueEffect({ protocol: "chat/v1", idempotencyKey: `send-${dispatches}`, payload: {} })
          return "sandboxed-result"
        }).pipe(Effect.orDie)
      })

      const sandbox = Layer.effect(
        WorkspaceSandbox.WorkspaceSandbox,
        Effect.map(WorkspaceSandbox.makeMemory(), (memory) => memory.service)
      )
      const program = Effect.scoped(Effect.gen(function*() {
        const engine = yield* EngineStore.make({
          owner: { hostId: "sandbox-composition" },
          journalSource: "sandbox-composition",
          isAlive: () => Effect.succeed(false)
        })
        yield* engine.register(SandboxFlow, () => sealed as unknown as Effect.Effect<string, never, never>)
        return yield* engine.execute(SandboxFlow, {
          executionId: "composed-a",
          payload: {},
          discard: false
        })
      })).pipe(
        Effect.provide(
          Layer.mergeAll(
            TestStores.layer(),
            StepBoundary.layerTest({ wholeTreeWriteDetection: false }),
            jjLayer,
            Layer.succeed(DurableEngineState.DurableEngineState, DurableEngineState.makeMemory()),
            sandbox,
            WorkspaceSandbox.layerDispatcher({
              dispatch: (effect) => Effect.sync(() => void delivered.push(effect.idempotencyKey))
            })
          )
        )
      )

      expect(yield* withCrypto(program)).toBe("sandboxed-result")
      // The body reached the transaction's `Workspace` service, so the sandbox
      // travelled; the dispatcher received the queued effect, so the stage did.
      expect(dispatches).toBe(1)
      expect(delivered).toEqual(["send-1"])
    }))
})

describe("copy-back conflict retry", () => {
  const descriptor = { readSet: [], writeSet: ["out.txt"], boundaryMode: "hard" as const }

  const conflictingSandbox = (failures: number) => {
    let materializations = 0
    let executions = 0
    const inner = WorkspaceSandbox.makeMemory()
    return {
      counts: () => ({ executions, materializations }),
      service: Effect.map(inner, (memory) =>
        WorkspaceSandbox.make({
          execute: (execution) => {
            executions = executions + 1
            return memory.service.execute(execution)
          },
          materialize: (accepted) => {
            materializations = materializations + 1
            return materializations <= failures
              ? Effect.fail(
                new WorkspaceSandbox.MaterializationConflict({ paths: ["out.txt"], message: "raced" })
              )
              : memory.service.materialize(accepted)
          }
        }))
    }
  }

  it.effect("re-runs the body from a fresh base and settles once the race is over", () =>
    Effect.gen(function*() {
      const harness = conflictingSandbox(2)
      const program = Effect.gen(function*() {
        const sandbox = yield* harness.service
        return yield* SandboxedExecution.execute({
          sandbox,
          descriptor,
          workflow: Effect.gen(function*() {
            const inner = yield* WorkspaceSandbox.Workspace
            yield* inner.writeFile("out.txt", encoder.encode("value"))
            return "ok"
          })
        })
      })

      const settlement = yield* withCrypto(program)
      expect(settlement.result).toBe("ok")
      expect(settlement.rebases).toBe(2)
      expect(harness.counts()).toEqual({ executions: 3, materializations: 3 })
    }))

  it.effect("surfaces the conflict once the rebase budget is spent", () =>
    Effect.gen(function*() {
      const harness = conflictingSandbox(99)
      const program = Effect.gen(function*() {
        const sandbox = yield* harness.service
        return yield* Effect.flip(SandboxedExecution.execute({
          sandbox,
          descriptor,
          maxRebases: 1,
          workflow: Effect.gen(function*() {
            const inner = yield* WorkspaceSandbox.Workspace
            yield* inner.writeFile("out.txt", encoder.encode("value"))
            return "ok"
          })
        }))
      })

      expect(yield* withCrypto(program)).toMatchObject({ _tag: "@smthrs/engine-store/MaterializationConflict" })
      expect(harness.counts()).toEqual({ executions: 2, materializations: 2 })
    }))

  it.effect("never rebases a copy-back the host itself refused", () =>
    Effect.gen(function*() {
      const program = Effect.gen(function*() {
        const memory = yield* WorkspaceSandbox.makeMemory()
        let materializations = 0
        const sandbox = WorkspaceSandbox.make({
          execute: memory.service.execute,
          materialize: () => {
            materializations = materializations + 1
            return Effect.fail(
              new WorkspaceSandbox.WorkspaceError({ code: "host_unavailable", message: "EIO" })
            )
          }
        })
        const failure = yield* Effect.flip(SandboxedExecution.execute({
          sandbox,
          descriptor,
          workflow: Effect.gen(function*() {
            const inner = yield* WorkspaceSandbox.Workspace
            yield* inner.writeFile("out.txt", encoder.encode("value"))
            return "ok"
          })
        }))
        return { failure, materializations }
      })

      const { failure, materializations } = yield* withCrypto(program)
      expect(failure).toMatchObject({ code: "host_unavailable" })
      expect(materializations).toBe(1)
    }))

  it.effect("keeps a body's own failure as the action's failure", () =>
    Effect.gen(function*() {
      const program = Effect.gen(function*() {
        const memory = yield* WorkspaceSandbox.makeMemory()
        return yield* Effect.flip(SandboxedExecution.execute({
          sandbox: memory.service,
          descriptor,
          workflow: Effect.fail({ _tag: "BusinessError" })
        }))
      })

      expect(yield* withCrypto(program)).toEqual({ _tag: "BusinessError" })
    }))

  it.effect("derives bundle identities canonically across object insertion order", () =>
    Effect.gen(function*() {
      const identity = (initialFiles: Readonly<Record<string, string>>, nextB: string) =>
        Effect.gen(function*() {
          const memory = yield* WorkspaceSandbox.makeMemory(initialFiles)
          const settlement = yield* SandboxedExecution.execute({
            sandbox: memory.service,
            descriptor: { readSet: [], writeSet: ["a.txt", "b.txt"], boundaryMode: "hard" },
            workflow: Effect.gen(function*() {
              const inner = yield* WorkspaceSandbox.Workspace
              yield* inner.writeFile("a.txt", encoder.encode("new-a"))
              yield* inner.writeFile("b.txt", encoder.encode(nextB))
              return null
            })
          })
          return settlement.bundleIdentity
        })
      const forward = { "a.txt": "old-a", "b.txt": "old-b" }
      const reverse: Record<string, string> = {}
      reverse["b.txt"] = "old-b"
      reverse["a.txt"] = "old-a"

      const first = yield* withCrypto(identity(forward, "new-b"))
      const reordered = yield* withCrypto(identity(reverse, "new-b"))
      const changed = yield* withCrypto(identity(forward, "different-b"))
      const removed = yield* withCrypto(Effect.gen(function*() {
        const memory = yield* WorkspaceSandbox.makeMemory({ "a.txt": "old-a" })
        const settlement = yield* SandboxedExecution.execute({
          sandbox: memory.service,
          descriptor: { readSet: [], writeSet: ["a.txt"], boundaryMode: "hard" },
          workflow: Effect.gen(function*() {
            const inner = yield* WorkspaceSandbox.Workspace
            yield* inner.removeFile("a.txt")
            return null
          })
        })
        return settlement.bundleIdentity
      }))

      expect(first).toMatch(/^key1_[0-9a-f]{64}$/)
      expect(reordered).toBe(first)
      expect(changed).not.toBe(first)
      expect(removed).toMatch(/^key1_[0-9a-f]{64}$/)
    }))
})

describe("cache-hit replay under a sandboxed composition", () => {
  it.effect("re-materializes the recorded outputs instead of re-running the body", () =>
    Effect.gen(function*() {
      const root = workspace()
      const key = "sandbox/replay"
      const metadata: ActionPersistence.BoundaryMetadata = {
        readSet: [{ path: "src/in.txt", digest: sha256("hello") }],
        writeSet: ["out/result.txt"],
        boundaryMode: "hard"
      }
      const program = Effect.gen(function*() {
        yield* seed(root, { "src/in.txt": "hello" })
        let executions = 0
        const run = (runId: string) =>
          Effect.gen(function*() {
            yield* activate(runId)
            return yield* dispatch(runId, key, metadata, () =>
              Effect.sync(() => executions++).pipe(
                Effect.andThen(renderer("src/in.txt", "out/result.txt"))
              )).pipe(Effect.provide(production(root, true)))
          })
        yield* run("sandbox-replay-first")
        // Delete the product. A second run whose inputs still match replays the
        // recorded evidence through the ordinary boundary machinery rather than
        // re-executing: the copy-back's post-state is exactly what `settle`
        // captured, so replay reproduces it.
        yield* Effect.provide(
          Effect.flatMap(FileSystem.FileSystem, (fs) => fs.remove(join(root, "out/result.txt"))),
          NodeFileSystem.layer
        ).pipe(Effect.orDie)
        const replayed = yield* run("sandbox-replay-second")
        return { executions, replayed }
      }).pipe(Effect.provide(TestStores.layer()))

      const { executions, replayed } = yield* withCrypto(program)
      expect(replayed).toEqual({ rendered: 5 })
      expect(executions).toBe(1)
      expect(yield* withCrypto(hostText(root, "out/result.txt"))).toBe("hello!")
    }))
})

describe("the transaction is not a security boundary", () => {
  it.effect("says so: a body reaching a service the transaction never seeded is outside it", () =>
    Effect.gen(function*() {
      const program = Effect.gen(function*() {
        const memory = yield* WorkspaceSandbox.makeMemory({ "src/in.txt": "hello" })
        const escaped: Array<string> = []
        const accepted = yield* memory.service.execute({
          descriptor: { readSet: [], writeSet: [], boundaryMode: "hard" },
          // An ambient capability the sandbox does not mediate — a spawned
          // process, a socket — is exactly what `Agent Adapters.md` leaves to a
          // future VM provisioning story. The transaction cannot see it.
          workflow: Effect.sync(() => {
            escaped.push("side effect")
            return null
          })
        })
        return { accepted, escaped }
      })

      const { accepted, escaped } = yield* withCrypto(program)
      expect(accepted._tag).toBe("Accepted")
      expect(escaped).toEqual(["side effect"])
    }))
})

describe("Journal record vocabulary", () => {
  it("names the two copy-back events Forensics requires", () => {
    const options = { runId: "r", lineageId: "r/root", sourceId: "s" }
    expect(JournalRecords.diffBundleCaptured(options, {}).eventType).toBe("flows.engine.diff-bundle-captured")
    expect(JournalRecords.copyBackSettled(options, {}).eventType).toBe("flows.engine.copy-back-settled")
  })
})

describe("decoding a recorded diff bundle", () => {
  it.effect("keeps inline and retained payloads apart", () =>
    Effect.gen(function*() {
      const program = Effect.gen(function*() {
        const memory = yield* WorkspaceSandbox.makeMemory({ "a.txt": "a" })
        const accepted = yield* memory.service.execute({
          descriptor: { readSet: [], writeSet: ["a.txt", "b.txt"], boundaryMode: "hard" },
          workflow: Effect.gen(function*() {
            const inner = yield* WorkspaceSandbox.Workspace
            yield* inner.removeFile("a.txt")
            yield* inner.writeFile("b.txt", encoder.encode("b"))
            return null
          })
        })
        if (accepted._tag !== "Accepted") throw new Error("expected accepted execution")
        return accepted.result.files
      })

      const files = yield* withCrypto(program)
      expect(files.map((change) => [change.path, change.afterDigest === undefined])).toEqual([
        ["a.txt", true],
        ["b.txt", false]
      ])
      expect(decoder.decode(files[1]?.after)).toBe("b")
    }))
})
