/**
 * The `ControlLive` contract, as a suite any `ControlRuntime` must pass.
 *
 * The in-memory runtime and the durable one are two implementations of one
 * port, so the interesting assertions belong to neither. They live here and are
 * run against both — an adapter that only satisfies its own tests is how a
 * port silently forks into two behaviours.
 */
import { Journal, JournalEvent } from "@smthrs/journal"
import { NotificationQueue } from "@smthrs/notifications"
import { Cause, Effect, Exit, Fiber, type Layer, Stream } from "effect"
import { describe, expect, it } from "vitest"
import { type ApprovalInput, Control } from "../src/Control.ts"
import {
  AlreadyResolved,
  ClaimLost,
  EnvelopeMismatch,
  InvalidInput,
  LaunchFailed,
  PersistenceError,
  PlanDenied,
  PlanDigestMismatch,
  PlanNotFound,
  RunNotFound
} from "../src/ControlError.ts"
import * as ControlExecutor from "../src/ControlExecutor.ts"
import { ControlRuntime } from "../src/ControlRuntime.ts"
import type { Envelope, PlanCard, Principal, Receipt } from "../src/ControlSchema.ts"
import { park } from "./Park.ts"

/** Every service a contract test may reach for. */
export type Stack =
  | Control
  | ControlRuntime
  | Journal.Journal
  | NotificationQueue.NotificationQueue

/**
 * Builds a complete Control stack. It is a function so every test gets a fresh
 * database, and it takes an executor so the launch-acceptance test can observe
 * a real one.
 */
export type Harness = (executor?: ControlExecutor.Service | undefined) => Layer.Layer<Stack>

const approval = (
  card: PlanCard,
  idempotencyKey: string,
  envelope: Envelope = card.envelope
): ApprovalInput => ({
  target: {
    _tag: "Plan",
    planId: card.planId,
    digest: card.digest,
    envelope
  },
  scope: card.approval.scope,
  idempotencyKey
})

const start = Effect.gen(function*() {
  const control = yield* Control
  const runtime = yield* ControlRuntime
  const card = yield* control.plan({
    flowId: "system/test",
    input: { suite: "control" }
  })
  yield* control.approve(approval(card, `approve:${card.planId}`))
  const receipt = yield* control.run({
    _tag: "Plan",
    planId: card.planId,
    digest: card.digest,
    envelope: card.envelope,
    idempotencyKey: `run:${card.planId}`
  })
  if (receipt._tag !== "Accepted" || receipt.runId === undefined) {
    return yield* Effect.die("expected an accepted run")
  }
  // The default contract executor declines, so Control.run releases the
  // launch fence. Most contract cases exercise an owning runtime; reclaim the
  // accepted run here and leave the release itself to its dedicated case.
  yield* runtime.resume(receipt.runId)
  return { card, runId: receipt.runId }
})

/**
 * Registers the shared contract against one runtime.
 *
 * @param name the runtime under test, used as the describe block's title
 * @param harness builds a fresh Control stack per test
 */
export const contract = (name: string, harness: Harness): void => {
  const test = <E>(
    title: string,
    body: () => Effect.Effect<void, E, Stack>
  ) =>
    it(title, () =>
      Effect.runPromise(
        body().pipe(
          Effect.provide(harness()),
          Effect.scoped
        )
      ))

  describe(`ControlLive contract (${name})`, () => {
    test("plans, approves, and starts a stored decoded input", () =>
      Effect.gen(function*() {
        const control = yield* Control
        const { card, runId } = yield* start
        const listed = yield* control.list({ _tag: "runs" })

        expect(card.flowId).toBe("system/test")
        expect(listed).toMatchObject({
          _tag: "runs",
          items: [{ runId, planId: card.planId, planDigest: card.digest, status: "accepted" }]
        })
      }))

    test("copies mutable inputs and returned summaries at the persistence boundary", () =>
      Effect.gen(function*() {
        const runtime = yield* ControlRuntime
        const input = { nested: { value: "stored" } }
        const { card } = yield* runtime.plan({ flowId: "system/test", input })
        input.nested.value = "mutated after plan"

        const token = yield* runtime.lookupApproval(card.approval.target)
        yield* runtime.resolveApproval(token, "approved", yield* runtime.stampPrincipal())
        const launched = yield* runtime.launch(card.planId, card.digest, card.envelope)
        if (launched._tag !== "Started") return yield* Effect.die("expected a started run")
        ;(launched.run as unknown as { status: string }).status = "failed"
        const firstRead = yield* runtime.getRun(launched.run.runId)
        ;(firstRead as unknown as { status: string }).status = "cancelled"

        const storedPlan = yield* runtime.getPlan(card.planId)
        const secondRead = yield* runtime.getRun(launched.run.runId)
        expect(storedPlan.decodedInput).toEqual({ nested: { value: "stored" } })
        expect(firstRead.status).toBe("cancelled")
        expect(secondRead.status).toBe("accepted")
      }))

    test("filters run listings to a matching run identifier", () =>
      Effect.gen(function*() {
        const control = yield* Control
        const { runId } = yield* start
        const listed = yield* control.list({ _tag: "runs", filters: { runId } })

        expect(listed).toMatchObject({ _tag: "runs", items: [{ runId }] })
      }))

    test("returns an empty run listing for a missing run identifier", () =>
      Effect.gen(function*() {
        const control = yield* Control
        yield* start
        const listed = yield* control.list({ _tag: "runs", filters: { runId: "missing-run" } })

        expect(listed).toEqual({ _tag: "runs", items: [] })
      }))

    test("emits a complete approval payload and parks until it is resolved", () =>
      Effect.gen(function*() {
        const control = yield* Control
        const card = yield* control.plan({
          flowId: "system/test",
          input: { suite: "gated" },
          idempotencyKey: "plan:gated"
        })
        const pending = yield* control.run({
          _tag: "Plan",
          planId: card.planId,
          digest: card.digest,
          envelope: card.envelope,
          idempotencyKey: card.approval.idempotencyKey
        })
        yield* control.approve(card.approval)
        const started = yield* control.run({
          _tag: "Plan",
          planId: card.planId,
          digest: card.digest,
          envelope: card.envelope,
          idempotencyKey: card.approval.idempotencyKey
        })

        expect(card.approval).toEqual({
          target: {
            _tag: "Plan",
            planId: card.planId,
            digest: card.digest,
            envelope: card.envelope
          },
          scope: "run",
          idempotencyKey: "plan:gated"
        })
        expect(pending).toEqual({
          _tag: "Parked",
          receiptId: "plan:gated",
          planId: card.planId,
          status: "waiting-approval"
        })
        expect(started).toMatchObject({ _tag: "Accepted", receiptId: "plan:gated" })
      }))

    test("parks every launch of an undecided plan under one key, then launches it once approved", () =>
      Effect.gen(function*() {
        const control = yield* Control
        const card = yield* control.plan({ flowId: "system/test", input: { suite: "release" } })
        const attempt = () =>
          control.run({
            _tag: "Plan",
            planId: card.planId,
            digest: card.digest,
            envelope: card.envelope,
            idempotencyKey: "run:release"
          })
        const first = yield* attempt()
        const second = yield* attempt()
        yield* control.approve(approval(card, "approve:release"))
        const started = yield* attempt()

        expect(first._tag).toBe("Parked")
        // A parked launch records no receipt, so its run-key claim is released
        // with it: a repeat while the plan is still undecided parks again
        // rather than dying on a key row nobody will ever settle.
        expect(second._tag).toBe("Parked")
        expect(started).toMatchObject({ _tag: "Accepted", receiptId: "run:release" })
      }))

    test("claims a run key before launch and converges a second claim on the recorded receipt", () =>
      Effect.gen(function*() {
        const runtime = yield* ControlRuntime
        const key = "run:claim-contract"
        const fingerprint = "fingerprint-a"

        expect(yield* runtime.claimRunKey(key, fingerprint)).toEqual({ _tag: "Claimed" })
        // Inside the winner's window there is no receipt to converge on yet.
        const unsettled = yield* runtime.claimRunKey(key, fingerprint).pipe(Effect.flip)
        expect(unsettled).toBeInstanceOf(PersistenceError)
        // A key claimed for another intent is the plan verb's own refusal.
        const collided = yield* runtime.claimRunKey(key, "fingerprint-b").pipe(Effect.flip)
        expect(collided).toBeInstanceOf(InvalidInput)

        const receipt: Receipt = { _tag: "Accepted", receiptId: key, runId: "run-1" }
        yield* runtime.recordMutation(key, fingerprint, receipt)
        // Once the winner has settled, the loser of the claim race gets the
        // winner's receipt — the same convergence a losing planner gets.
        expect(yield* runtime.claimRunKey(key, fingerprint)).toEqual({ _tag: "Raced", receipt })

        yield* runtime.releaseRunKey(key)
        expect(yield* runtime.claimRunKey(key, fingerprint)).toEqual({ _tag: "Claimed" })
      }))

    test("refuses a resume delegation a settled run can never take up", () =>
      Effect.gen(function*() {
        const runtime = yield* ControlRuntime
        const settled = yield* start
        const standing = yield* start
        yield* runtime.interrupt(settled.runId)

        const refused = yield* runtime.requestResume(settled.runId).pipe(Effect.flip)
        const sequence = yield* runtime.requestResume(standing.runId)
        const pending = yield* runtime.pendingResumes

        // The refusal is typed and records nothing: the standing delegation is
        // the only one any host's poll can see.
        expect(refused).toBeInstanceOf(InvalidInput)
        expect((refused as InvalidInput).issue).toContain("cancelled")
        expect(pending.map((entry) => entry.runId)).toEqual([standing.runId])
        expect(pending[0]?.sequence).toBe(sequence)
      }))

    test("rejects a digest mismatch", () =>
      Effect.gen(function*() {
        const control = yield* Control
        const card = yield* control.plan({ flowId: "system/test", input: {} })
        const error = yield* control.approve({
          ...approval(card, "approve:digest"),
          target: { ...approval(card, "unused").target, digest: "wrong" }
        }).pipe(Effect.flip)

        expect(error).toBeInstanceOf(PlanDigestMismatch)
      }))

    test("exposes missing runtime state as typed failures", () =>
      Effect.gen(function*() {
        const runtime = yield* ControlRuntime
        const plan = yield* runtime.getPlan("missing").pipe(Effect.flip)
        const run = yield* runtime.getRun("missing").pipe(Effect.flip)
        const fence = yield* runtime.claimFence("missing").pipe(Effect.flip)
        const signal = yield* runtime.deliverSignal("missing", { name: "missing", payload: null }).pipe(Effect.flip)

        expect(plan).toBeInstanceOf(PlanNotFound)
        expect((plan as PlanNotFound).code).toBe("plan_not_found")
        expect((plan as PlanNotFound).planId).toBe("missing")
        expect(run).toBeInstanceOf(RunNotFound)
        expect(fence).toBeInstanceOf(RunNotFound)
        expect(signal).toBeInstanceOf(RunNotFound)
      }))

    test("distinguishes a denied plan from a lost run claim", () =>
      Effect.gen(function*() {
        const runtime = yield* ControlRuntime
        const { card } = yield* runtime.plan({ flowId: "system/test", input: { suite: "denied" } })
        const token = yield* runtime.lookupApproval(card.approval.target)
        yield* runtime.resolveApproval(token, "denied", yield* runtime.stampPrincipal())
        const denied = yield* runtime.launch(card.planId, card.digest, card.envelope).pipe(Effect.flip)

        expect(denied).toBeInstanceOf(PlanDenied)
        expect((denied as PlanDenied).code).toBe("plan_denied")
        expect((denied as PlanDenied).planId).toBe(card.planId)
      }))

    test("rejects an envelope mismatch", () =>
      Effect.gen(function*() {
        const control = yield* Control
        const card = yield* control.plan({ flowId: "system/test", input: {} })
        const error = yield* control.approve(approval(card, "approve:envelope", {
          ...card.envelope,
          capabilities: ["fs:write"]
        })).pipe(Effect.flip)

        expect(error).toBeInstanceOf(EnvelopeMismatch)
      }))

    test("resolves approval exactly once and distinguishes replay from conflict", () =>
      Effect.gen(function*() {
        const control = yield* Control
        const card = yield* control.plan({ flowId: "system/test", input: {} })
        const input = approval(card, "approve:once")
        const first = yield* control.approve(input)
        const replay = yield* control.approve(input)
        const conflict = yield* control.deny(approval(card, "deny:after-approve")).pipe(Effect.flip)

        expect(first._tag).toBe("Accepted")
        expect(replay._tag).toBe("AlreadyApplied")
        expect(conflict).toBeInstanceOf(AlreadyResolved)
      }))

    test("commits the whole envelope as one grant with the approved decision", () =>
      Effect.gen(function*() {
        const control = yield* Control
        const runtime = yield* ControlRuntime
        const card = yield* control.plan({ flowId: "system/test", input: { suite: "grants" } })
        yield* control.approve(approval(card, "approve:grants"))
        const grants = yield* runtime.grants

        expect(grants).toMatchObject([{ tokenId: card.planId, scope: "run", envelope: card.envelope }])
      }))

    test("bounds the runtime run query and isolates its returned summaries", () =>
      Effect.gen(function*() {
        const runtime = yield* ControlRuntime
        expect(yield* runtime.queryRuns({ limit: 1 })).toEqual({ items: [] })
        for (const limit of [0, -1, 1.5, 501, Number.NaN, Infinity]) {
          expect(yield* Effect.flip(runtime.queryRuns({ limit }))).toBeInstanceOf(InvalidInput)
        }
        const { runId } = yield* start
        const first = yield* runtime.queryRuns({ limit: 1 })
        expect(first.items.map((run) => run.runId)).toEqual([runId])
        expect(first.nextCursor).toBeUndefined()
        Object.assign(first.items[0]!, { flowId: "mutated" })
        expect((yield* runtime.getRun(runId)).flowId).toBe("system/test")
        expect(yield* runtime.queryRuns({ limit: 1, filters: { lineageId: "missing" } })).toEqual({ items: [] })
        expect(yield* runtime.queryRuns({ limit: 1, filters: { parentRunId: "missing" } })).toEqual({ items: [] })
      }))

    test("exposes NotificationQueue as the only steering queue", () =>
      Effect.gen(function*() {
        const runtime = yield* ControlRuntime
        expect(runtime).not.toHaveProperty("enqueueSteer")
        expect(runtime).not.toHaveProperty("drainSteering")
      }))

    test("queues steering until a turn-boundary drain", () =>
      Effect.gen(function*() {
        const control = yield* Control
        const notifications = yield* NotificationQueue.NotificationQueue
        const { runId } = yield* start
        const principal: Principal = { id: "operator", kind: "test", stampedAt: 1 }
        yield* control.steer({
          runId,
          message: {
            messageId: "steer-1",
            runId,
            body: "change course",
            principal,
            createdAt: 1
          },
          idempotencyKey: "steer:key"
        })

        const first = yield* notifications.drain({
          runId,
          targetLineageId: runId,
          boundary: `${runId}/turn-1`,
          wouldIdle: false
        })
        const second = yield* notifications.drain({
          runId,
          targetLineageId: runId,
          boundary: `${runId}/turn-2`,
          wouldIdle: false
        })
        expect(first.notifications).toMatchObject([{
          id: "steer-1",
          delivery: "steer",
          targetLineageId: runId,
          provenance: { sourceActor: "test:operator" },
          payload: { body: "change course" }
        }])
        expect(second.notifications).toEqual([])
      }))

    test("drains queued steering exactly once at a turn boundary", () =>
      Effect.gen(function*() {
        const control = yield* Control
        const notifications = yield* NotificationQueue.NotificationQueue
        const { runId } = yield* start
        const principal: Principal = { id: "operator", kind: "test", stampedAt: 1 }
        for (const [messageId, body] of [["steer-a", "first"], ["steer-b", "second"]] as const) {
          yield* control.steer({
            runId,
            message: { messageId, runId, body, principal, createdAt: 1 },
            idempotencyKey: messageId
          })
        }
        const drained = yield* notifications.drain({
          runId,
          targetLineageId: runId,
          boundary: `${runId}/turn-1`,
          wouldIdle: false
        })
        const again = yield* notifications.drain({
          runId,
          targetLineageId: runId,
          boundary: `${runId}/turn-2`,
          wouldIdle: false
        })
        expect(drained.notifications.map((message) => message.id)).toEqual(["steer-a", "steer-b"])
        expect(again.notifications).toEqual([])
      }))

    test("registers an in-run approval token that approve turns into a grant", () =>
      Effect.gen(function*() {
        const control = yield* Control
        const runtime = yield* ControlRuntime
        const { runId } = yield* start
        const envelope: Envelope = { capabilities: [], flows: ["ask"], budget: {} }
        const target = { _tag: "Node" as const, runId, requestId: "ask-1", digest: "ask-digest", envelope }

        // Registration is idempotent: every parked attempt re-registers.
        const first = yield* runtime.registerApproval(target)
        const again = yield* runtime.registerApproval(target)
        expect(first).toEqual({ tokenId: "ask-1", target, _tag: "Pending" })
        expect(again).toEqual(first)

        // A target that disagrees with what was registered is refused, exactly
        // as lookupApproval refuses it.
        const mismatched = yield* Effect.flip(runtime.registerApproval({ ...target, digest: "other" }))
        expect(mismatched).toBeInstanceOf(PlanDigestMismatch)

        // The public approve verb resolves the registered token and installs
        // the grant a resumed attempt reads its decision from.
        yield* control.approve({ target, scope: "run", idempotencyKey: "approve:ask-1" })
        const resolved = yield* runtime.registerApproval(target)
        expect(resolved._tag).toBe("Approved")
        const grants = yield* runtime.grants
        expect(grants.some((grant) => grant.tokenId === "ask-1")).toBe(true)
      }))

    test("refuses to register an in-run approval against an unknown run", () =>
      Effect.gen(function*() {
        const runtime = yield* ControlRuntime
        const missing = yield* Effect.flip(runtime.registerApproval({
          _tag: "Node",
          runId: "run-unknown",
          requestId: "ask-x",
          digest: "ask-digest",
          envelope: { capabilities: [], flows: [], budget: {} }
        }))
        expect(missing).toBeInstanceOf(RunNotFound)
      }))

    /**
     * A launch the executor could not take must leave no run to chase.
     *
     * The run row is created before the executor is consulted, and the
     * executor's refusal fails the mutation. Where the run row and the control
     * journal share one database the whole mutation rolls back and no run
     * survives, which is the answer this contract wants. Where they do not —
     * the CLI keeps runs in `control.db` and journals control events into
     * `engine.db` — the row outlived the rollback, and rc.0 left it `accepted`
     * under an owner with pid 0: `smithers status` answered "unlaunched"
     * forever and only `smithers cancel` could end it. So the contract is stated over what
     * survives: whatever run the refusal leaves behind is terminal, carries
     * the cause, and is `failed`.
     */
    it("leaves no run behind that its refusal did not settle", async () => {
      const refusal = "Set ANTHROPIC_API_KEY to run the anthropic:claude-sonnet-4-5 seat"
      const executor = ControlExecutor.makeNoop({
        launch: Effect.fn("ContractExecutor.launch")(({ run }) =>
          Effect.fail(new LaunchFailed({ runId: run.runId, message: refusal }))
        )
      })
      await Effect.runPromise(
        Effect.gen(function*() {
          const control = yield* Control
          const runtime = yield* ControlRuntime
          const card = yield* control.plan({ flowId: "system/test", input: { unlaunchable: true } })
          yield* control.approve(approval(card, "approve:unlaunchable"))
          const failure = yield* Effect.flip(control.run({
            _tag: "Plan",
            planId: card.planId,
            digest: card.digest,
            envelope: card.envelope,
            idempotencyKey: "run:unlaunchable"
          }))
          // The caller still reads the refusal it can act on.
          expect(failure).toBeInstanceOf(LaunchFailed)
          expect((failure as LaunchFailed).message).toBe(refusal)

          const listed = yield* control.list({ _tag: "runs" })
          const runs = listed._tag === "runs" ? listed.items : []
          expect(runs.filter((run) => run.status !== "failed")).toEqual([])
          if (runs.length === 0) return
          const runId = runs[0]!.runId
          expect((yield* runtime.getRun(runId)).status).toBe("failed")
          // Why it failed is in the journal, which is what a diagnosis reads.
          const events = yield* Stream.runCollect(control.watch({ runId, follow: false }))
          expect(events.at(-1)?.kind).toBe("control.run.failed")
          expect(events.at(-1)?.payload).toMatchObject({ runId, status: "failed", cause: refusal })
        }).pipe(
          Effect.provide(harness(executor)),
          Effect.scoped
        )
      )
    })

    it("reports running only after a real executor accepts the launch", async () => {
      const invoked: Array<string> = []
      const executor = ControlExecutor.makeNoop({
        launch: Effect.fn("ContractExecutor.launch")(({ run }) =>
          Effect.sync(() => {
            invoked.push(run.runId)
            return "accepted" as const
          })
        )
      })
      await Effect.runPromise(
        Effect.gen(function*() {
          const control = yield* Control
          const card = yield* control.plan({ flowId: "system/test", input: { executor: true } })
          yield* control.approve(approval(card, "approve:executor"))
          const receipt = yield* control.run({
            _tag: "Plan",
            planId: card.planId,
            digest: card.digest,
            envelope: card.envelope,
            idempotencyKey: "run:executor"
          })
          if (receipt._tag !== "Accepted" || receipt.runId === undefined) {
            return yield* Effect.die("expected accepted receipt")
          }
          const events = yield* control.watch({ runId: receipt.runId }).pipe(
            Stream.take(2),
            Stream.runCollect
          )
          expect(invoked).toEqual([receipt.runId])
          expect(events.map((event) => event.kind)).toEqual(["control.run.accepted", "control.run.running"])
          const listed = yield* control.list({ _tag: "runs" })
          expect(listed).toMatchObject({ _tag: "runs", items: [{ runId: receipt.runId, status: "running" }] })
        }).pipe(
          Effect.provide(harness(executor)),
          Effect.scoped
        )
      )
    })

    it("projects engine waits instead of the local coordination status", async () => {
      const executor = ControlExecutor.makeNoop({
        readExecution: () =>
          Effect.succeed({ _tag: "Observed" as const, status: "parked" as const, waitingReason: "timer" })
      })
      await Effect.runPromise(
        Effect.gen(function*() {
          const { runId } = yield* start
          const control = yield* Control
          const runtime = yield* ControlRuntime
          expect((yield* runtime.getRun(runId)).status).toBe("accepted")
          const result = yield* control.list({ _tag: "runs", filters: { runId } })
          expect(result).toMatchObject({
            _tag: "runs",
            items: [{ status: "parked", waitingReason: "timer", executionObservation: "observed" }]
          })
        }).pipe(Effect.provide(harness(executor)), Effect.scoped)
      )
    })

    it("admits the winning signal before delivery and never delivers conflicting payloads", async () => {
      const delivered: Array<ControlExecutor.Signal> = []
      let runtime: import("../src/ControlRuntime.ts").Service | undefined
      const executor = ControlExecutor.makeNoop({
        deliverSignal: (input) =>
          Effect.gen(function*() {
            expect(input.commandId).toBeDefined()
            const admitted = yield* runtime!.signalCommand(input.commandId!)
            expect(admitted?.signal).toEqual(input.signal)
            delivered.push(input)
            return "delivered" as const
          })
      })
      await Effect.runPromise(
        Effect.gen(function*() {
          runtime = yield* ControlRuntime
          const control = yield* Control
          const { runId } = yield* start
          const results = yield* Effect.all(
            [1, 2].map((payload) =>
              control.signal({ runId, signal: { name: "reviewed", payload }, idempotencyKey: "contended" })
            ),
            { concurrency: "unbounded" }
          )
          expect(results.map((receipt) => receipt._tag).sort()).toEqual(["Accepted", "Conflict"])
          expect(delivered).toHaveLength(1)
          const admitted = yield* runtime.signalCommand(delivered[0]!.commandId!)
          expect(admitted?.state).toBe("delivered")
        }).pipe(Effect.provide(harness(executor)), Effect.scoped)
      )
    })

    test("records a signal when no executor can deliver it, without resuming the run", () =>
      Effect.gen(function*() {
        const control = yield* Control
        const runtime = yield* ControlRuntime
        const { runId } = yield* start
        yield* park(runtime, runId)
        yield* control.signal({
          runId,
          signal: { name: "reviewed", payload: { ok: true } },
          idempotencyKey: "signal:key"
        })

        const listed = yield* control.list({ _tag: "runs" })
        const signals = yield* runtime.deliveredSignals(runId)
        expect(listed).toMatchObject({ _tag: "runs", items: [{ runId, status: "parked" }] })
        expect(signals).toEqual([{ name: "reviewed", payload: { ok: true } }])
      }))

    test("commits cancel intent before cleanup can signal another run and write the journal", () =>
      Effect.gen(function*() {
        const control = yield* Control
        const runtime = yield* ControlRuntime
        const journal = yield* Journal.Journal
        const { runId } = yield* start
        const other = yield* start
        let cleanupFinished = false
        let intentCommitted = false
        const owner = yield* Effect.never.pipe(
          Effect.ensuring(
            Effect.gen(function*() {
              const events = yield* control.watch({ runId, follow: false }).pipe(Stream.runCollect)
              intentCommitted = events.some((event) => event.kind === "control.run.cancel-requested")
              yield* control.signal({
                runId: other.runId,
                signal: { name: "cleanup", payload: null },
                idempotencyKey: "cleanup:signal"
              })
              yield* journal.transact(Effect.void)
              cleanupFinished = true
            }).pipe(
              Effect.interruptible,
              Effect.timeout("2 seconds"),
              Effect.ignore
            )
          ),
          Effect.forkChild({ startImmediately: true })
        )
        yield* runtime.registerFiber(runId, owner)
        const receipt = yield* control.cancel({ runId, idempotencyKey: "cancel:cleanup" })
        expect(cleanupFinished).toBe(true)
        expect(intentCommitted).toBe(true)
        expect(receipt).toEqual({ _tag: "Terminal", runId, status: "cancelled" })
        expect(yield* runtime.deliveredSignals(other.runId)).toEqual([{ name: "cleanup", payload: null }])
      }))

    for (const status of ["completed", "failed", "cancelled"] as const) {
      test(`interrupt preserves ${status} reached by a finalizer`, () =>
        Effect.gen(function*() {
          const runtime = yield* ControlRuntime
          const { runId } = yield* start
          const fence = yield* runtime.claimFence(runId)
          const owner = yield* Effect.never.pipe(
            Effect.ensuring(runtime.writeStatus(runId, fence, status).pipe(Effect.orDie)),
            Effect.forkChild({ startImmediately: true })
          )
          yield* runtime.registerFiber(runId, owner)
          expect((yield* runtime.interrupt(runId)).status).toBe(status)
          expect((yield* runtime.getRun(runId)).status).toBe(status)
        }))
    }

    test("interrupt refuses the replacement fence installed by a finalizer", () =>
      Effect.gen(function*() {
        const runtime = yield* ControlRuntime
        const { runId } = yield* start
        const fence = yield* runtime.claimFence(runId)
        const owner = yield* Effect.never.pipe(
          Effect.ensuring(
            Effect.gen(function*() {
              yield* runtime.writeStatus(runId, fence, "parked")
              yield* runtime.resume(runId)
            }).pipe(Effect.orDie)
          ),
          Effect.forkChild({ startImmediately: true })
        )
        yield* runtime.registerFiber(runId, owner)
        expect(yield* runtime.interrupt(runId).pipe(Effect.flip)).toBeInstanceOf(ClaimLost)
        expect(yield* runtime.claimFence(runId)).not.toBe(fence)
        expect((yield* runtime.getRun(runId)).status).toBe("accepted")
      }))

    test("cancels by interrupting the owning Effect fiber", () =>
      Effect.gen(function*() {
        const control = yield* Control
        const runtime = yield* ControlRuntime
        const { runId } = yield* start
        const owner = yield* Effect.never.pipe(Effect.forkChild({ startImmediately: true }))
        yield* runtime.registerFiber(runId, owner)
        const receipt = yield* control.cancel({ runId, idempotencyKey: "cancel:key" })
        const replay = yield* control.cancel({ runId, idempotencyKey: "cancel:key" })
        const exit = yield* Fiber.await(owner)

        expect(receipt).toEqual({ _tag: "Terminal", runId, status: "cancelled" })
        // Retargeted: a second cancel answers from the RUN, not from the
        // recorded receipt. the release policy says a cancel against a
        // terminal run returns the `Terminal` receipt, and the old
        // `AlreadyApplied` replay hid it — which is how the release validation's
        // two non-terminal runs became unreachable by `cancel` and `down`
        // alike. Cancellation is idempotent through the run's terminality,
        // which is the stronger fact.
        expect(replay).toEqual({ _tag: "Terminal", runId, status: "cancelled" })
        expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true)
      }))

    test("releases ownership on a park, claims on resume, and rejects stale fences", () =>
      Effect.gen(function*() {
        const control = yield* Control
        const runtime = yield* ControlRuntime
        const { runId } = yield* start
        const staleFence = yield* runtime.claimFence(runId)
        yield* park(runtime, runId)
        const parkedWrite = yield* runtime.writeStatus(runId, staleFence, "running").pipe(Effect.flip)
        const resumed = yield* control.resume({ runId, idempotencyKey: "resume:fence" })
        const resumedWrite = yield* runtime.writeStatus(runId, staleFence, "completed").pipe(Effect.flip)

        expect(parkedWrite).toBeInstanceOf(ClaimLost)
        expect(resumed._tag).toBe("Accepted")
        expect(resumedWrite).toBeInstanceOf(ClaimLost)
      }))

    test("releases an executor-declined launch while preserving its accepted status", () =>
      Effect.gen(function*() {
        const runtime = yield* ControlRuntime
        const { card } = yield* runtime.plan({ flowId: "system/test", input: { pending: true } })
        const token = yield* runtime.lookupApproval(card.approval.target)
        yield* runtime.resolveApproval(token, "approved", yield* runtime.stampPrincipal())
        const launched = yield* runtime.launch(card.planId, card.digest, card.envelope)
        if (launched._tag !== "Started") return yield* Effect.die("expected a started run")
        const fence = yield* runtime.claimFence(launched.run.runId)
        const malformed = yield* runtime.releasePending(launched.run.runId, "not-a-fence").pipe(Effect.flip)
        const released = yield* runtime.releasePending(launched.run.runId, fence)
        const stale = yield* runtime.writeStatus(launched.run.runId, fence, "running").pipe(Effect.flip)
        const resumed = yield* runtime.resume(launched.run.runId)

        expect(malformed).toBeInstanceOf(ClaimLost)
        expect(released.status).toBe("accepted")
        expect(released.ownerId).toBeUndefined()
        expect(stale).toBeInstanceOf(ClaimLost)
        expect(resumed).toMatchObject({ status: "accepted", ownerId: expect.any(String) })
      }))

    test("lets another process cancel a run after the executor declines it", () =>
      Effect.gen(function*() {
        const control = yield* Control
        const runtime = yield* ControlRuntime
        const card = yield* control.plan({ flowId: "system/test", input: { declined: true } })
        yield* control.approve(approval(card, "approve:declined"))
        const receipt = yield* control.run({
          _tag: "Plan",
          planId: card.planId,
          digest: card.digest,
          envelope: card.envelope,
          idempotencyKey: "run:declined"
        })
        if (receipt._tag !== "Accepted" || receipt.runId === undefined) {
          return yield* Effect.die("expected an accepted run")
        }

        const released = yield* runtime.getRun(receipt.runId)
        const fence = yield* runtime.claimFence(receipt.runId).pipe(Effect.flip)
        const cancelled = yield* control.cancel({ runId: receipt.runId, idempotencyKey: "cancel:declined" })

        expect(released.status).toBe("accepted")
        expect(released.ownerId).toBeUndefined()
        expect(fence).toBeInstanceOf(ClaimLost)
        expect(cancelled).toEqual({ _tag: "Terminal", runId: receipt.runId, status: "cancelled" })
      }))

    test("accepts the fence it is currently holding", () =>
      Effect.gen(function*() {
        const runtime = yield* ControlRuntime
        const { runId } = yield* start
        const fence = yield* runtime.claimFence(runId)
        const running = yield* runtime.writeStatus(runId, fence, "running")
        const completed = yield* runtime.writeStatus(runId, fence, "completed")
        const afterTerminal = yield* runtime.writeStatus(runId, fence, "running").pipe(Effect.flip)

        expect(running.status).toBe("running")
        expect(completed.status).toBe("completed")
        // A terminal run released ownership, so even the winning fence is spent.
        expect(afterTerminal).toBeInstanceOf(ClaimLost)
      }))

    test("resuming a terminal run reports the terminal state rather than reclaiming it", () =>
      Effect.gen(function*() {
        const control = yield* Control
        const runtime = yield* ControlRuntime
        const { runId } = yield* start
        yield* control.cancel({ runId, idempotencyKey: "cancel:terminal" })
        const resumed = yield* runtime.resume(runId)

        expect(resumed.status).toBe("cancelled")
      }))

    test("watch replays after a cursor and then follows the committed tail", () =>
      Effect.gen(function*() {
        const control = yield* Control
        const journal = yield* Journal.Journal
        const { runId } = yield* start
        yield* control.signal({
          runId,
          signal: { name: "before-watch", payload: null },
          idempotencyKey: "signal:before-watch"
        })
        yield* journal.flush

        const events = yield* control.watch({ runId, afterSequence: 0 }).pipe(
          Stream.filter((event) => event.kind === "control.signal.admitted"),
          Stream.take(2),
          Stream.runCollect,
          Effect.forkChild({ startImmediately: true })
        )
        yield* Effect.yieldNow
        yield* control.signal({
          runId,
          signal: { name: "after-watch", payload: null },
          idempotencyKey: "signal:after-watch"
        })
        yield* journal.flush

        expect((yield* Fiber.join(events)).map((event) => event.kind)).toEqual([
          "control.signal.admitted",
          "control.signal.admitted"
        ])
      }))

    test("watch returns a finite durable snapshot when follow is false", () =>
      Effect.gen(function*() {
        const control = yield* Control
        const journal = yield* Journal.Journal
        const { runId } = yield* start
        yield* control.signal({
          runId,
          signal: { name: "snapshot", payload: null },
          idempotencyKey: "signal:snapshot"
        })
        yield* journal.flush

        const events = yield* control.watch({ runId, follow: false }).pipe(
          Stream.runCollect,
          Effect.timeout("1 second")
        )

        expect(events.map((event) => event.kind)).toContain("control.signal.admitted")
      }))

    test("watch selects control's namespace and skips other namespaces in the run stream", () =>
      Effect.gen(function*() {
        const control = yield* Control
        const journal = yield* Journal.Journal
        const { runId } = yield* start
        // The journal reserves other event-type namespaces on the same run —
        // here an ownership transition the run store appends — so a control
        // projection selects its own namespace instead of assuming the stream
        // carries only control events.
        yield* journal.emitDurableUnfenced(
          new JournalEvent.Input({
            runId: JournalEvent.RunId.make(runId),
            sourceId: JournalEvent.SourceId.make("flows/run-store/consensus"),
            eventType: "flows.consensus.claimed",
            payload: { owner: { hostId: "host-x", pid: 1, nonce: "n" }, grantedAtMs: 0 }
          })
        )
        // A control record lands after the foreign one, so a follower can
        // stop at it and prove the foreign entry was neither shown nor a stall.
        yield* control.signal({
          runId,
          signal: { name: "namespaced", payload: null },
          idempotencyKey: "signal:namespaced"
        })
        yield* journal.flush

        const followed = yield* control.watch({ runId }).pipe(
          Stream.takeUntil((event) => event.kind === "control.steer.enqueued"),
          Stream.runCollect
        )
        const snapshot = yield* control.watch({ runId, follow: false }).pipe(
          Stream.runCollect,
          Effect.timeout("1 second")
        )
        for (const events of [followed, snapshot]) {
          expect(events.length).toBeGreaterThan(0)
          expect(events.map((event) => event.kind).every((kind) => !kind.startsWith("flows.consensus."))).toBe(true)
        }
        expect(snapshot.map((event) => event.kind)).toContain("control.steer.enqueued")
      }))

    test("unscoped finite watch includes plan-only journal partitions", () =>
      Effect.gen(function*() {
        const control = yield* Control
        const card = yield* control.plan({ flowId: "system/test", input: { snapshot: "plan-only" } })

        const events = yield* control.watch({ follow: false }).pipe(
          Stream.runCollect,
          Effect.timeout("1 second")
        )

        expect(events).toContainEqual(expect.objectContaining({
          kind: "control.plan.created",
          runId: `plan:${card.planId}`
        }))
        expect((yield* control.list({ _tag: "runs" })).items).toEqual([])
      }))
  })
}
