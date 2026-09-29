import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import { FlowEngine } from "@smthrs/engine"
import * as DurableEngineState from "@smthrs/engine-store/DurableEngineState"
import { Journal } from "@smthrs/journal"
import * as Model from "@smthrs/model/Model"
import { ModelError } from "@smthrs/model/ModelError"
import { RunStore } from "@smthrs/run-store"
import { Context, Deferred, Effect, Fiber, Layer, Option, Scope, Stream } from "effect"
import { TestClock } from "effect/testing"
import { spawn } from "node:child_process"
import { once } from "node:events"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import * as SqlTimeTravelStore from "../../flows/time-travel/src/SqlTimeTravelStore.ts"
import * as TimeTravel from "../../flows/time-travel/src/TimeTravel.ts"
import {
  answer,
  cell,
  facts,
  incarnation,
  Parallel,
  records,
  Single,
  stores,
  Twice
} from "./fixtures/step-trace-stack.ts"

/** What `run` provides: the SQLite stores, crypto, and a scope. */
type Provided =
  | Layer.Success<ReturnType<typeof stores>>
  | Layer.Success<typeof NodeCrypto.layer>
  | Scope.Scope

const run = <A, E>(effect: Effect.Effect<A, E, Provided>) =>
  Effect.runPromise(
    Effect.scoped(effect).pipe(Effect.provide(stores(":memory:")), Effect.provide(NodeCrypto.layer))
  )

class Unprovided extends Context.Service<Unprovided, { readonly value: string }>()("test/agent/StepTrace/Unprovided") {}

/** Never called; tsc checks it (#2704). */
const unprovidedServiceProbe = () => {
  // @ts-expect-error run provides the stores and crypto, not Unprovided
  run(Effect.map(Unprovided, (service) => service.value))
  run(Effect.map(Journal.Journal, (journal) => journal))
}

describe("agent step checkpoints on the real SQLite engine", () => {
  it("has no trace without installation, and checkpoints a settled step before returning", async () => {
    for (const trace of [false, true]) {
      await run(Effect.gen(function*() {
        const wiring = yield* incarnation(Model.make({ stream: () => answer() }), { trace })
        expect(yield* Single.execute({ input: "done" }, { executionId: "single" }).pipe(Effect.provide(wiring))).toBe(
          "done"
        )
        const saved = yield* facts("single")
        expect(saved.length > 0).toBe(trace)
        if (trace) expect(saved.some((fact) => fact.payload.eventType === "control.agent.resolved")).toBe(true)
      }))
    }
  }, 60_000)

  it("shows committed facts while the next provider call remains unresolved", async () => {
    await run(Effect.gen(function*() {
      const reached = yield* Deferred.make<void>()
      let calls = 0
      const model = Model.make({
        stream: () =>
          Stream.unwrap(Effect.gen(function*() {
            calls++
            if (calls === 1) return cell("console.log(\"first frame\")")
            yield* Deferred.succeed(reached, undefined)
            return yield* Effect.never
          }))
      })
      const wiring = yield* incarnation(model)
      const fiber = yield* Single.execute({ input: "two frames" }, { executionId: "live" }).pipe(
        Effect.provide(wiring),
        Effect.forkScoped
      )
      yield* Deferred.await(reached)
      expect(fiber.pollUnsafe()).toBeUndefined()
      const saved = yield* facts("live")
      expect(saved.length).toBeGreaterThan(0)
      const runs = yield* RunStore.RunStore
      expect((yield* runs.get("live")).status).toBe("running")
      // An independent durable write completes while the provider is held.
      yield* runs.create("unrelated", "{}")
      expect((yield* runs.get("unrelated")).runId).toBe("unrelated")
      yield* Fiber.interrupt(fiber)
    }))
  }, 60_000)

  it("keeps repeated and concurrent calls of the same declaration separate", async () => {
    await run(Effect.gen(function*() {
      let calls = 0
      const wiring = yield* incarnation(Model.make({
        stream: () =>
          Stream.suspend(() => {
            calls++
            return answer()
          })
      }))
      yield* Twice.execute({ input: "identical" }, { executionId: "twice" }).pipe(Effect.provide(wiring))
      const repeated = yield* facts("twice")
      expect(new Set(repeated.map((row) => row.payload.step.stepId)).size).toBe(2)
      // This agent action has no hard file boundary, so distinct invocations
      // cannot reuse a shared result merely because their payloads match.
      expect(calls).toBe(2)
      yield* Parallel.execute({}, { executionId: "parallel" }).pipe(Effect.provide(wiring))
      const concurrent = yield* facts("parallel")
      expect(new Set(concurrent.map((row) => row.payload.step.stepId)).size).toBe(2)
      expect(calls).toBe(4)
      for (const rows of [repeated, concurrent]) {
        for (const stepId of new Set(rows.map((row) => row.payload.step.stepId))) {
          const owned = rows.filter((row) => row.payload.step.stepId === stepId)
          expect(owned.some((row) => row.payload.eventType === "control.agent.resolved")).toBe(true)
        }
      }
    }))
  }, 60_000)

  it("parks a quota refusal and resumes with separate retry coordinates", async () => {
    await run(
      Effect.gen(function*() {
        let calls = 0
        const wiring = yield* incarnation(
          Model.make({
            stream: () =>
              Stream.suspend(() => {
                calls++
                return calls === 1
                  ? Stream.fail(
                    new ModelError({
                      code: "rate_limited",
                      message: "capacity",
                      retryAfterMillis: 3000,
                      httpStatus: 429
                    })
                  )
                  : answer()
              })
          }),
          { quota: true }
        )
        const fiber = yield* Single.execute({ input: "quota" }, { executionId: "quota" }).pipe(
          Effect.provide(wiring),
          Effect.forkScoped
        )
        const state = yield* DurableEngineState.DurableEngineState
        let parked = false
        for (let i = 0; i < 1000; i++) {
          if ((yield* state.waitingRuns({ reason: "quota" })).length > 0) {
            parked = true
            break
          }
          yield* Effect.yieldNow
        }
        expect(parked).toBe(true)
        const before = yield* facts("quota")
        expect(before.length).toBeGreaterThan(0)
        for (let i = 0; i < 20 && fiber.pollUnsafe() === undefined; i++) yield* TestClock.adjust("1 second")
        expect(yield* Fiber.join(fiber)).toBe("done")
        const after = yield* facts("quota")
        expect(new Set(after.map((row) => row.payload.step.retry))).toEqual(new Set([1, 2]))
        expect(after.filter((row) => row.payload.step.retry === 1)).toEqual(before)
        expect(calls).toBe(2)
      }).pipe(Effect.provide(TestClock.layer()))
    )
  }, 180_000)
})

describe("agent checkpoint process recovery", () => {
  it("retains a committed prefix after actual SIGKILL and resumes on a new full EngineStore", async () => {
    const directory = await mkdtemp(join(tmpdir(), "step-trace-kill-"))
    const filename = join(directory, "engine.sqlite")
    const runId = "killed-trace"
    const child = spawn(process.execPath, [
      fileURLToPath(new URL("./fixtures/step-trace-child.ts", import.meta.url)),
      filename,
      runId
    ], {
      env: { PATH: process.env.PATH, TMPDIR: process.env.TMPDIR, LANG: "C.UTF-8" },
      stdio: ["ignore", "pipe", "pipe"]
    })
    let stderr = ""
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk)
    })
    try {
      const marker = await new Promise<{ facts: number }>((resolve, reject) => {
        let stdout = ""
        const timer = setTimeout(
          () => reject(new Error(`child did not reach pending provider: ${stderr} ${stdout}`)),
          120_000
        )
        child.once("exit", (code) => {
          clearTimeout(timer)
          reject(new Error(`child exited ${code}: ${stderr}`))
        })
        child.stdout.on("data", (chunk) => {
          stdout += String(chunk)
          for (const line of stdout.split("\n")) {
            if (!line.startsWith("{\"status\":\"provider-pending\"")) continue
            clearTimeout(timer)
            resolve(JSON.parse(line))
          }
        })
      })
      expect(marker.facts).toBeGreaterThan(0)
      const exited = once(child, "exit")
      child.kill("SIGKILL")
      const [, signal] = await exited
      expect(signal).toBe("SIGKILL")
      let resumedCalls = 0
      await Effect.runPromise(
        Effect.scoped(Effect.gen(function*() {
          const runs = yield* RunStore.RunStore
          const abandoned = yield* runs.get(runId)
          expect(abandoned.status).toBe("running")
          expect(abandoned.owner?.pid).toBe(child.pid)
          yield* TestClock.setTime((abandoned.heartbeatAtMs ?? 0) + 120_000)
          const prefix = yield* facts(runId)
          expect(prefix.length).toBe(marker.facts)
          // The process died with its second provider call open. What that
          // call was asked is already committed, because the request's fact is
          // its own checkpoint inside the step and not a row some writer was
          // going to flush: there is nothing between settle and flush to lose.
          const requestsOf = (rows: typeof prefix) =>
            rows.filter((row) => row.payload.eventType === "control.agent.model-requested")
          const asked = requestsOf(prefix).map((row) => row.payload.payload as Record<string, unknown>)
          expect(asked).toMatchObject([
            { frame: 0, attempt: 1, prefixCount: 0 },
            { frame: 1, attempt: 1 }
          ])
          // The step's facts are written against each other the way a prompt
          // run's rows are: the second call's fact holds what it added past
          // everything the first sent, realm note included, and the teaching
          // both calls ran under is stored once.
          expect(asked[1]!.prefixCount).toBe((asked[0]!.messages as ReadonlyArray<unknown>).length)
          expect(asked.map((payload) => Object.hasOwn(payload, "system"))).toEqual([true, false])
          const wiring = yield* incarnation(Model.make({
            stream: () =>
              Stream.suspend(() => {
                resumedCalls++
                return answer()
              })
          }))
          expect(yield* Single.execute({ input: "two frames" }, { executionId: runId }).pipe(Effect.provide(wiring)))
            .toBe("done")
          const after = yield* facts(runId)
          expect(after.slice(0, prefix.length)).toEqual(prefix)
          expect(new Set(after.map((row) => `${row.sourceId}:${row.sourceSeq}`)).size).toBe(after.length)
          // The resumed process replays frame zero and re-opens frame one, and
          // republishes neither request: one fact per model call, still.
          expect(requestsOf(after)).toEqual(requestsOf(prefix))
          const decisions = after.filter((row) => row.payload.eventType === "control.agent.decision-settled")
          expect(decisions.map((row) => row.payload.payload)).toMatchObject([{ frame: 1 }])
          expect((yield* runs.get(runId)).status).toBe("completed")
          expect(resumedCalls).toBe(1)
        })).pipe(Effect.provide(stores(filename)), Effect.provide(NodeCrypto.layer), Effect.provide(TestClock.layer()))
      )
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        const exited = once(child, "exit")
        child.kill("SIGKILL")
        await exited
      }
      await rm(directory, { recursive: true, force: true })
    }
  }, 180_000)
})

describe("agent checkpoint time travel", () => {
  it("executes a real rewind at the settled agent boundary and preserves its facts on replay", async () => {
    await run(Effect.gen(function*() {
      let calls = 0
      const model = Model.make({
        stream: () =>
          Stream.suspend(() => {
            calls++
            return answer()
          })
      })
      const wiring = yield* incarnation(model, { parkAfter: true })
      const fiber = yield* Single.execute({ input: "rewind" }, { executionId: "rewind-trace" }).pipe(
        Effect.provide(wiring),
        Effect.forkScoped
      )
      const runs = yield* RunStore.RunStore
      for (let i = 0; i < 1000; i++) {
        const row = yield* runs.get("rewind-trace").pipe(Effect.option)
        if (Option.isSome(row) && row.value.status === "suspended") break
        yield* Effect.yieldNow
      }
      expect((yield* runs.get("rewind-trace")).status).toBe("suspended")
      yield* Fiber.interrupt(fiber)
      const before = yield* facts("rewind-trace")
      expect(before.length).toBeGreaterThan(0)
      // The request and the decision are facts of the step like any other, so
      // they sit inside its boundary, survive the rewind below, and are not
      // written again by the replay after it. Each joins to its turn by the
      // scope and frame it carries, which are the step's own.
      for (const kind of ["control.agent.model-requested", "control.agent.decision-settled"]) {
        const rows = before.filter((row) => row.payload.eventType === kind)
        expect(rows).toHaveLength(1)
        expect(rows[0]!.payload.payload).toMatchObject({
          scope: rows[0]!.payload.step.scope,
          frame: rows[0]!.payload.frame
        })
      }
      const all = yield* records("rewind-trace")
      const stepId = before[0]!.payload.step.stepId
      const boundary = all.find((row) =>
        row.eventType.includes("attempt-finished") &&
        (row.payload as { stepKeyDigest?: string }).stepKeyDigest === stepId
      )
      expect(boundary).toBeDefined()
      expect(before.every((row) => row.seq < boundary!.seq)).toBe(true)
      const timeTravel = yield* TimeTravel.make.pipe(Effect.provide(SqlTimeTravelStore.layer))
      const rewound = yield* timeTravel.rewind({
        runId: "rewind-trace",
        frame: { lineageId: FlowEngine.Lineage.root("rewind-trace"), seq: boundary!.seq }
      })
      expect(rewound.archive.archived).toBeGreaterThan(0)
      expect(yield* facts("rewind-trace")).toEqual(before)
      const journal = yield* Journal.Journal
      expect((yield* journal.generation!("rewind-trace" as never)).generation).toBe(1)
      const resumed = yield* incarnation(model)
      expect(yield* Single.execute({ input: "rewind" }, { executionId: "rewind-trace" }).pipe(Effect.provide(resumed)))
        .toBe("done")
      expect(yield* facts("rewind-trace")).toEqual(before)
      expect(calls).toBe(1)
    }))
  }, 60_000)
})

describe("regression: provide-then-cast test helpers erase layer requirements (#2704)", () => {
  it("rejects a body that needs a service run does not provide", () => {
    // The assertion is the `@ts-expect-error` directive on unprovidedServiceProbe.
    expect(unprovidedServiceProbe).toBeTypeOf("function")
  })
})
