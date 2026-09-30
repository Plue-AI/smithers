/**
 * `Run.Fork` and `Run.Verify`: the gateway forwards each to the history host
 * the composition supplies, answers `Unavailable` without one, and carries the
 * host's refusal and report over the wire unchanged.
 */
import { describe, expect, it } from "@effect/vitest"
import { Control, type Service as ControlService } from "@smthrs/control/Control"
import { layerNoopAuth } from "@smthrs/control/ControlRpcs"
import { Effect, Layer, Schema, type Scope } from "effect"
import { RpcTest } from "effect/unstable/rpc"
import { GatewayRpcs } from "../src/GatewayRpcs.ts"
import * as GatewayServer from "../src/GatewayServer.ts"
import { Projections, type Service as ProjectionsService } from "../src/Projections.ts"
import * as RunHistory from "../src/RunHistory.ts"

const principal = { id: "gateway-test", kind: "test", stampedAt: 1 }

const handlers = Layer.merge(GatewayServer.layerHandlers, layerNoopAuth(principal)).pipe(
  Layer.provideMerge(Layer.mergeAll(
    Layer.succeed(Control)({} as ControlService),
    Layer.succeed(Projections)({} as ProjectionsService)
  ))
)

const client = (history?: RunHistory.Service) =>
  RpcTest.makeClient(GatewayRpcs).pipe(
    Effect.provide(history === undefined ? handlers : handlers.pipe(
      Layer.provide(Layer.succeed(RunHistory.RunHistory)(history))
    ))
  )

const test = <E>(title: string, body: () => Effect.Effect<void, E, Scope.Scope>) =>
  it(title, () => Effect.runPromise(Effect.scoped(body())))

const report: RunHistory.VerifyReport = {
  runId: "run-1",
  verdict: "divergent",
  replayed: [{ stepKeyDigest: "a", action: "verify/first", node: "n1" }],
  executes: { stepKeyDigest: "c", action: "verify/renamed" },
  notReplayed: [{ stepKeyDigest: "b", action: "verify/second" }]
}

describe("Run.Fork and Run.Verify", () => {
  test("answer Unavailable from a gateway composed without a history host", () =>
    Effect.gen(function*() {
      const rpc = yield* client()
      const forked = yield* Effect.flip(rpc["Run.Fork"]({ runId: "run-1", at: 3 }))
      const verified = yield* Effect.flip(rpc["Run.Verify"]({ runId: "run-1" }))
      for (const failure of [forked, verified]) {
        expect(failure).toMatchObject({ _tag: "/control/Unavailable", feature: "run history" })
      }
    }))

  test("forward the fork address and edit and return the parked child", () =>
    Effect.gen(function*() {
      const seen: Array<RunHistory.ForkInput> = []
      const rpc = yield* client({
        fork: (input) =>
          Effect.sync(() => {
            seen.push(input)
            return { runId: "run-1-fork", parentRunId: input.runId, status: "parked" as const }
          }),
        verify: () => Effect.die("unused")
      })
      const edit = { stepKeyDigest: "b", result: { text: "edited" } }
      const forked = yield* rpc["Run.Fork"]({ runId: "run-1", at: 3, lineage: "main", step: edit })
      expect(forked).toEqual({ runId: "run-1-fork", parentRunId: "run-1", status: "parked" })
      expect(seen).toEqual([{ runId: "run-1", at: 3, lineage: "main", step: edit }])
    }))

  test("return the verification report whole, divergent or not", () =>
    Effect.gen(function*() {
      const rpc = yield* client({ fork: () => Effect.die("unused"), verify: () => Effect.succeed(report) })
      expect(yield* rpc["Run.Verify"]({ runId: "run-1" })).toEqual(report)
    }))

  test("carry the host's refusal code and sentence", () =>
    Effect.gen(function*() {
      const refused = new RunHistory.HistoryRefused({ code: "history_missing", message: "No execution history" })
      const rpc = yield* client({ fork: () => Effect.fail(refused), verify: () => Effect.fail(refused) })
      for (const failure of [
        yield* Effect.flip(rpc["Run.Fork"]({ runId: "run-1", at: 0 })),
        yield* Effect.flip(rpc["Run.Verify"]({ runId: "run-1" }))
      ]) {
        expect(failure).toBeInstanceOf(RunHistory.HistoryRefused)
        expect(failure).toMatchObject({ code: "history_missing", message: "No execution history" })
      }
    }))

  it("refuses a malformed address before any host sees it", () => {
    const decode = Schema.decodeUnknownResult(RunHistory.ForkInput)
    expect(decode({ runId: "run-1", at: -1 })._tag).toBe("Failure")
    expect(decode({ runId: "run-1", at: 1.5 })._tag).toBe("Failure")
    expect(decode({ runId: "", at: 0 })._tag).toBe("Failure")
    expect(decode({ runId: "run-1", at: 0, step: { stepKeyDigest: "", result: 1 } })._tag).toBe("Failure")
    expect(decode({ runId: "run-1", at: 0 })._tag).toBe("Success")
    expect(Schema.decodeUnknownResult(RunHistory.VerifyInput)({ runId: "" })._tag).toBe("Failure")
  })
})
