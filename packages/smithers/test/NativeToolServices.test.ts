/**
 * The standard tool bindings close over exactly the host services they
 * declare (#2930). `FlowBinding.provide` lays a binding's context over the
 * calling run's, so any registration service captured with it would shadow
 * the one the tool call runs under.
 */
import * as NodePath from "@effect/platform-node/NodePath"
import { FlowRuntime } from "@smthrs/flow"
import type * as Cell from "@smthrs/harness/Cell"
import * as FlowBinding from "@smthrs/harness/FlowBinding"
import * as Journal from "@smthrs/journal/Journal"
import * as KernelChildProcessSpawner from "@smthrs/kernel/ChildProcessSpawner"
import * as Evaluator from "@smthrs/model/Evaluator"
import { NotificationQueue } from "@smthrs/notifications"
import * as Read from "@smthrs/std/Read"
import { Context, Effect, FileSystem, Layer, Option, Path, Scope } from "effect"
import { describe, expect, it } from "vitest"
import { toolServices } from "../src/internal/NativeEquipment.ts"

const registrationJournal = { owner: "registration" } as unknown as Journal.Service
const callJournal = { owner: "call" } as unknown as Journal.Service

// What a native host's registration phase holds beside the tool services.
const registration = Layer.mergeAll(
  FileSystem.layerNoop({}),
  NodePath.layer,
  KernelChildProcessSpawner.layerNoop(),
  Evaluator.layerUnavailable(),
  Layer.succeed(Journal.Journal)(registrationJournal),
  Layer.succeed(FlowRuntime.FlowRuntime)({} as never),
  Layer.succeed(NotificationQueue.NotificationQueue)({} as never)
)

const captured = () => Effect.runPromise(Effect.scoped(toolServices.pipe(Effect.provide(registration))))

const keys = (context: Context.Context<never>) => [...context.mapUnsafe.keys()].sort()

const call = {
  flowName: "read",
  input: { path: "a.txt" },
  capabilities: [],
  effects: Read.effects,
  placement: Option.none(),
  identity: { session: "s", frame: 0, cell: "c", ordinal: 0, declaration: "d", layers: [] }
} as unknown as Cell.Call

describe("native tool services", () => {
  it("picks each context to its declared services", async () => {
    const services = await captured()
    expect(keys(services.filesystem as Context.Context<never>)).toEqual(
      [FileSystem.FileSystem.key, Path.Path.key].sort()
    )
    expect(keys(services.shell as Context.Context<never>)).toEqual(
      [KernelChildProcessSpawner.ChildProcessSpawner.key, Path.Path.key].sort()
    )
    expect(keys(services.judge as Context.Context<never>)).toEqual([Evaluator.Evaluator.key])
    for (const context of [services.filesystem, services.shell, services.judge]) {
      const any = context as Context.Context<unknown>
      expect(Option.isNone(Context.getOption(any, Journal.Journal))).toBe(true)
      expect(Option.isNone(Context.getOption(any, FlowRuntime.FlowRuntime))).toBe(true)
      expect(Option.isNone(Context.getOption(any, NotificationQueue.NotificationQueue))).toBe(true)
      expect(Option.isNone(Context.getOption(any, Scope.Scope))).toBe(true)
    }
  })

  it("leaves the calling run's services visible to a bound tool", async () => {
    const services = await captured()
    const seen: Array<unknown> = []
    const binding = FlowBinding.provide(
      FlowBinding.make({
        flow: Read.flow,
        handler: () =>
          Effect.gen(function*() {
            yield* FileSystem.FileSystem
            seen.push(Option.getOrUndefined(yield* Effect.serviceOption(Journal.Journal)))
            return { content: "", startLine: 1, endLine: 0, totalLines: 0, truncated: false }
          })
      }),
      services.filesystem
    )
    const result = await Effect.runPromise(binding.run(call).pipe(Effect.provideService(Journal.Journal, callJournal)))
    expect(result.outcome).toBe("success")
    expect(seen).toEqual([callJournal])
  })
})
