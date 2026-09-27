/**
 * A run admitted by a process that died before its executor took the launch.
 *
 * `Control.run` commits the run row and its idempotency receipt, then hands the
 * run to the executor outside that transaction. A crash in between left the run
 * `accepted` under a dead owner, and the client's retry with the same key only
 * read the recorded receipt back, so nothing ever launched it (#2175).
 */
import { Clock, Effect, Exit, type Layer } from "effect"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, expect, it } from "vitest"
import { Control } from "../src/Control.ts"
import * as ControlExecutor from "../src/ControlExecutor.ts"
import { ControlRuntime } from "../src/ControlRuntime.ts"
import type { PlanCard } from "../src/ControlSchema.ts"
import { durable, type DurableStack, fileBundle } from "./DurableStack.ts"

const directory = mkdtempSync(join(tmpdir(), "flows-control-stranded-"))
afterAll(() => rmSync(directory, { recursive: true, force: true }))

const stack = (filename: string, pid: number, executor: ControlExecutor.Service): Layer.Layer<DurableStack> =>
  durable({
    database: fileBundle(filename),
    owner: { hostId: "stranded-host", pid, nonce: `process-${pid}` },
    // The first process is gone; the second is this one.
    isAlive: (owner) => Effect.succeed(owner.pid === pid),
    executor
  })

const run = <A, E>(layer: Layer.Layer<DurableStack>, body: Effect.Effect<A, E, DurableStack>) =>
  Effect.runPromiseExit(body.pipe(Effect.provide(layer), Effect.scoped))

/** A clock `ms` ahead: the dead owner's heartbeat lease has to lapse before its run can be taken. */
const later = (ms: number) =>
  Effect.map(Effect.clockWith(Effect.succeed), (clock): Clock.Clock => ({
    ...clock,
    currentTimeMillisUnsafe: () => clock.currentTimeMillisUnsafe() + ms,
    currentTimeMillis: Effect.sync(() => clock.currentTimeMillisUnsafe() + ms),
    currentTimeNanosUnsafe: () => clock.currentTimeNanosUnsafe() + BigInt(ms) * 1_000_000n,
    currentTimeNanos: Effect.sync(() => clock.currentTimeNanosUnsafe() + BigInt(ms) * 1_000_000n)
  }))

const admit = Effect.gen(function*() {
  const control = yield* Control
  const card = yield* control.plan({ flowId: "system/test", input: { suite: "stranded" } })
  yield* control.approve({ ...card.approval, idempotencyKey: "approve:stranded" })
  return card
})

const retry = (card: PlanCard) =>
  Effect.gen(function*() {
    const control = yield* Control
    return yield* control.run({
      _tag: "Plan",
      planId: card.planId,
      digest: card.digest,
      envelope: card.envelope,
      idempotencyKey: "run:stranded"
    })
  })

it("relaunches a run whose admitting process died before the launch when the client retries its key", async () => {
  const filename = join(directory, "stranded.sqlite")
  const planned = await run(stack(filename, 101, ControlExecutor.makeNoop()), admit)
  if (!Exit.isSuccess(planned)) throw new Error("plan failed")
  const card = planned.value

  // The host dies between committing the admission and the executor's launch.
  const crashed = await run(
    stack(filename, 101, ControlExecutor.makeNoop({ launch: () => Effect.die("host died") })),
    retry(card)
  )
  expect(Exit.isFailure(crashed)).toBe(true)

  const launched: Array<string> = []
  const retried = await run(
    stack(
      filename,
      202,
      ControlExecutor.makeNoop({
        launch: (input) => Effect.sync(() => launched.push(input.run.runId)).pipe(Effect.as("accepted" as const))
      })
    ),
    Effect.gen(function*() {
      // Before the lease lapses the admitter may still be alive: nothing moves.
      yield* retry(card)
      if (launched.length !== 0) return yield* Effect.die("launched under a fresh lease")
      const clock = yield* later(60_000)
      const receipt = yield* retry(card).pipe(Effect.provideService(Clock.Clock, clock))
      const again = yield* retry(card).pipe(Effect.provideService(Clock.Clock, clock))
      const runtime = yield* ControlRuntime
      if (receipt._tag !== "AlreadyApplied" || receipt.runId === undefined) {
        return yield* Effect.die(JSON.stringify(receipt))
      }
      return { receipt, runId: receipt.runId, again, status: (yield* runtime.getRun(receipt.runId)).status }
    })
  )
  if (!Exit.isSuccess(retried)) throw new Error(String(retried.cause))
  // The retry answers from the recorded receipt, and the run it names starts.
  expect(retried.value.receipt).toMatchObject({ _tag: "AlreadyApplied", receiptId: "run:stranded" })
  expect(retried.value.again).toEqual(retried.value.receipt)
  expect(launched).toEqual([retried.value.runId])
  expect(retried.value.status).toBe("running")
})
