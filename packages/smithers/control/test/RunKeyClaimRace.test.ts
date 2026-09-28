/**
 * Two `SqlControlRuntime` instances over one database file, claiming one run
 * idempotency key.
 *
 * `RunIdempotencyRace.test.ts` races whole control stacks; this suite pins the
 * seam the race resolves on. Every other verb claims a durable key row before
 * its side effect (`control_plan_keys` for plans), and the run verb was the
 * exception: two processes that both missed the receipt lookup both launched,
 * and the loser's run row outlived the `recordMutation` refusal that followed.
 * `control_run_keys` closes that hole the same way — the claim is the
 * mutation's first write, so the loser learns it lost before a run row exists
 * and converges on the winner's receipt instead.
 */
import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import { Effect, Layer, type Scope } from "effect"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import { InvalidInput, PersistenceError } from "../src/ControlError.ts"
import type { Service as ControlRuntimeService } from "../src/ControlRuntime.ts"
import type { Envelope, Receipt } from "../src/ControlSchema.ts"
import * as SqlControlRuntime from "../src/SqlControlRuntime.ts"
import { fileBundle } from "./DurableStack.ts"

const directory = mkdtempSync(join(tmpdir(), "flows-control-run-key-race-"))

afterAll(() => rmSync(directory, { recursive: true, force: true }))

const envelope: Envelope = { capabilities: [], flows: [], budget: {} }

const flows: ReadonlyArray<SqlControlRuntime.DurableFlow> = [
  { flowId: "system/test", description: "Reserved test system flow", deployClass: false, envelope }
]

/** A fresh durable runtime over the rows at `filename`, with its own connection. */
const makeOver = (filename: string): Effect.Effect<ControlRuntimeService, PersistenceError, Scope.Scope> =>
  Effect.gen(function*() {
    const services = yield* Layer.build(Layer.merge(fileBundle(filename), NodeCrypto.layer))
    return yield* SqlControlRuntime.make({ flows }).pipe(Effect.provide(services))
  })

describe("two SqlControlRuntime instances claiming one run key", () => {
  it("converges the loser on the winner's receipt and launches nothing for it", async () => {
    const filename = join(directory, "race.sqlite")
    const receipt: Receipt = { _tag: "Accepted", receiptId: "run:race", runId: "run-1" }

    const observed = await Effect.runPromise(
      Effect.gen(function*() {
        const winner = yield* makeOver(filename)
        const loser = yield* makeOver(filename)

        expect(yield* winner.claimRunKey("run:race", "fingerprint")).toEqual({ _tag: "Claimed" })
        // Inside the winner's window the loser learns it lost but has no
        // receipt to converge on: a claim without its settlement is reported,
        // never permission to launch a second run.
        const unsettled = yield* Effect.flip(loser.claimRunKey("run:race", "fingerprint"))
        // The key promises one intent; a different fingerprint is the plan
        // verb's own refusal.
        const collided = yield* Effect.flip(loser.claimRunKey("run:race", "another-fingerprint"))

        yield* winner.recordMutation("run:race", "fingerprint", receipt)
        const raced = yield* loser.claimRunKey("run:race", "fingerprint")
        return {
          collided,
          raced,
          runs: yield* Effect.map(loser.queryRuns({ limit: 500 }), (page) => page.items),
          unsettled
        }
      }).pipe(Effect.scoped)
    )

    expect(observed.unsettled).toBeInstanceOf(PersistenceError)
    expect(observed.collided).toBeInstanceOf(InvalidInput)
    // The documented already-settled behavior: the loser gets the WINNER's
    // receipt, exactly as a losing planner gets the winner's card.
    expect(observed.raced).toEqual({ _tag: "Raced", receipt })
    // And exactly zero run rows came from the loser.
    expect(observed.runs).toEqual([])
  })

  it("lets a released claim be claimed again", async () => {
    const filename = join(directory, "release.sqlite")

    const observed = await Effect.runPromise(
      Effect.gen(function*() {
        const first = yield* makeOver(filename)
        const second = yield* makeOver(filename)
        yield* first.claimRunKey("run:release", "fingerprint")
        yield* first.releaseRunKey("run:release")
        // A launch that parked withdraws its claim this way, so the key stays
        // claimable by whichever mutation runs next — over either connection.
        return yield* second.claimRunKey("run:release", "fingerprint")
      }).pipe(Effect.scoped)
    )

    expect(observed).toEqual({ _tag: "Claimed" })
  })
})
