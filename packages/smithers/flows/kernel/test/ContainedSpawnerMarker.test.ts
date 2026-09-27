import { describe, expect, it } from "@effect/vitest"
import { Effect, Layer, Path } from "effect"
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import { runInNewContext } from "node:vm"
import * as GuardedSpawner from "../src/ChildProcessSpawner.ts"
import * as ContainedSpawner from "../src/ContainedSpawner.ts"
import { GrantStore } from "../src/GrantStore.ts"
import * as ProcessLedger from "../src/ProcessLedger.ts"
import * as Workspace from "../src/Workspace.ts"

const lifecycle: ContainedSpawner.Lifecycle = (command, spawn) =>
  Effect.map(spawn(command), (handle) => ({ handle, activate: Effect.void, settled: Effect.succeed(true) }))

const grants = GrantStore.of({
  check: () => Effect.void,
  reply: () => Effect.void,
  list: Effect.succeed([]),
  grantEnvelope: () => Effect.void
})

describe("contained service contract", () => {
  for (const owned of [true, false]) {
    for (const guarded of [true, false]) {
      it.effect(`requires a lifecycle and preserves it through permissions (owned=${owned}, guarded=${guarded})`, () =>
        Effect.gen(function*() {
          const spawner = yield* ChildProcessSpawner
          expect(ContainedSpawner.isContained(spawner)).toBe(owned)
          // An arbitrary replacement is not the same trusted composition.
          expect(ContainedSpawner.isContained({ ...spawner })).toBe(false)
        }).pipe(
          Effect.provide(
            guarded ? GuardedSpawner.layer.pipe(Layer.provide([Workspace.layerNoop, Path.layer])) : Layer.empty
          ),
          Effect.provide(ContainedSpawner.layer({}, owned ? lifecycle : undefined)),
          Effect.provide(GuardedSpawner.layerNoop()),
          Effect.provide(ProcessLedger.layerMemory({ hostId: "containment-marker", ownerPid: 1 })),
          Effect.provideService(GrantStore, grants)
        ))
    }
  }

  it("recognizes the shared registry key from another JavaScript context", () => {
    const spawner = GuardedSpawner.makeNoop()
    // Separate ESM/CJS module copies also share this registry, unlike a local
    // WeakSet or a newly allocated Symbol. No build output is required here.
    runInNewContext(
      "Object.defineProperty(spawner, Symbol.for(\"@smthrs/kernel/ContainedSpawner/Lifecycle/v1\"), { value: true })",
      { spawner }
    )
    expect(ContainedSpawner.isContained(spawner)).toBe(true)
  })

  it("does not invoke marker accessors or infer ownership from an inherited property", () => {
    const spawner = GuardedSpawner.makeNoop()
    let invoked = false
    Object.defineProperty(spawner, Symbol.for("@smthrs/kernel/ContainedSpawner/Lifecycle/v1"), {
      get: () => {
        invoked = true
        return true
      }
    })
    expect(ContainedSpawner.isContained(spawner)).toBe(false)
    expect(ContainedSpawner.isContained(Object.create(spawner))).toBe(false)
    expect(invoked).toBe(false)
  })
})
