/**
 * The in-memory `ControlRuntime` at the edges the shared contract does not
 * reach: refusals, the idempotency seams, and every state a released fence
 * leaves behind.
 */
import { Deferred, Effect, Exit } from "effect"
import { describe, expect, it, vi } from "vitest"
import {
  AlreadyResolved,
  ClaimLost,
  EnvelopeMismatch,
  FlowNotFound,
  InvalidInput,
  PersistenceError,
  PlanDenied,
  PlanDigestMismatch,
  PlanNotFound,
  RunNotFound
} from "../src/ControlError.ts"
import {
  ControlRuntime,
  type IdPage,
  type IdPageRequest,
  type MemoryOptions,
  type Service
} from "../src/ControlRuntime.ts"
import type { Envelope, Principal } from "../src/ControlSchema.ts"
import { delegateApproval } from "./ApprovalFixtures.ts"
import { memoryRuntime } from "./TestStack.ts"

const envelope: Envelope = { capabilities: [], flows: [], budget: {} }
const principal: Principal = { id: "operator", kind: "test", stampedAt: 0 }

const withRuntime = <A, E>(
  use: (runtime: Service) => Effect.Effect<A, E>,
  options?: MemoryOptions
): Promise<A> =>
  Effect.runPromise(
    Effect.gen(function*() {
      const runtime = yield* ControlRuntime
      return yield* use(runtime)
    }).pipe(
      Effect.provide(memoryRuntime({ approvalAuthority: delegateApproval(principal), ...options })),
      Effect.scoped,
      Effect.orDie
    )
  )

/** Plans, approves, and launches one run through the port itself. */
const start = (runtime: Service) =>
  Effect.gen(function*() {
    const { card } = yield* runtime.plan({ flowId: "system/test", input: { suite: "memory" } })
    const token = yield* runtime.lookupApproval(card.approval.target)
    yield* runtime.installBulkGrant(token, card.envelope, "run")
    yield* runtime.resolveApproval(token, "approved", principal)
    const launched = yield* runtime.launch(card.planId, card.digest, card.envelope)
    if (launched._tag !== "Started") return yield* Effect.die("expected a started run")
    return { card, run: launched.run }
  })

describe("ControlRuntime.layerMemory", () => {
  it("refuses to plan a flow the catalog does not carry", async () => {
    const error = await withRuntime((runtime) => Effect.flip(runtime.plan({ flowId: "system/absent", input: {} })))

    expect(error).toBeInstanceOf(FlowNotFound)
    expect((error as FlowNotFound).flowId).toBe("system/absent")
  })

  it("refuses input with no canonical form, whether the fingerprint or the decode sees it first", async () => {
    const observed = await withRuntime((runtime) =>
      Effect.gen(function*() {
        // The fingerprint canonicalizes `{ flowId, input }`, so a non-finite
        // number inside the input fails there first.
        const fingerprint = yield* Effect.flip(runtime.plan({ flowId: "system/test", input: Number.NaN }))
        // `undefined` survives that wrapper — an absent member is dropped —
        // and is refused only when the input itself is canonicalized.
        const decode = yield* Effect.flip(runtime.plan({ flowId: "system/test", input: undefined }))
        return { fingerprint, decode }
      })
    )

    expect(observed.fingerprint).toBeInstanceOf(InvalidInput)
    // Canonical's public contract supplies stable codes and located paths. The
    // control boundary keeps those two fields and drops the rejected value.
    expect((observed.fingerprint as InvalidInput).issue).toBe("$.input: canonical_nan")
    expect(observed.decode).toBeInstanceOf(InvalidInput)
    expect((observed.decode as InvalidInput).issue).toBe("$: canonical_unsupported_value")
  })

  it("lays a planner's budget over the flow's, and keys it into the plan's identity", async () => {
    const observed = await withRuntime((runtime) =>
      Effect.gen(function*() {
        const plain = yield* runtime.plan({ flowId: "system/test", input: {}, idempotencyKey: "plan:budget" })
        const budgeted = yield* runtime.plan({
          flowId: "system/test",
          input: {},
          budget: { tokens: 50, onExceeded: "park" }
        })
        const reused = yield* Effect.flip(runtime.plan({
          flowId: "system/test",
          input: {},
          idempotencyKey: "plan:budget",
          budget: { tokens: 50 }
        }))
        return { plain, budgeted, reused }
      })
    )

    expect(observed.budgeted.card.envelope.budget).toEqual({
      ...observed.plain.card.envelope.budget,
      tokens: 50,
      onExceeded: "park"
    })
    expect(observed.reused).toBeInstanceOf(InvalidInput)
    expect((observed.reused as InvalidInput).issue).toBe("idempotency key plan:budget was used for another plan")
  })

  it("pages plan and run inventories without walking every entry, and ends at the inventory it started with", async () => {
    const total = 600
    const limit = 50
    // Every Map this runtime walks while a page is read, by size. A page that
    // walks a whole inventory holds or visits all of it on every page.
    const walked: Array<number> = []
    const observed = await withRuntime((runtime) =>
      Effect.gen(function*() {
        for (let index = 0; index < total; index++) yield* start(runtime)
        const walk = (page: (request: IdPageRequest) => Effect.Effect<IdPage, unknown>) =>
          Effect.gen(function*() {
            const ids: Array<string> = []
            let cursor: { after?: number; through?: number } = {}
            for (;;) {
              const spies = (["keys", "values", "entries"] as const).map((method) => {
                const original = Map.prototype[method]
                return vi.spyOn(Map.prototype, method).mockImplementation(function(this: Map<unknown, unknown>) {
                  walked.push(this.size)
                  return original.call(this)
                } as never)
              })
              const read = yield* page({ ...cursor, limit }).pipe(Effect.ensuring(Effect.sync(() => {
                for (const spy of spies) spy.mockRestore()
              })))
              ids.push(...read.ids)
              // More work arrives between pages; this walk must not chase it.
              yield* start(runtime)
              if (read.next === undefined) return ids
              cursor = { after: read.next, through: read.through }
            }
          })
        const runs = yield* walk(runtime.pageRunIds)
        const plans = yield* walk(runtime.pagePlanIds)
        return { runs, plans }
      })
    )

    expect(walked.filter((size) => size > limit)).toEqual([])
    expect(observed.runs).toEqual(Array.from({ length: total }, (_, index) => `run-${index + 1}`))
    // Plans are walked after the run walk admitted one launch per run page.
    expect(observed.plans).toHaveLength(total + Math.ceil(total / limit))
    expect(new Set(observed.plans).size).toBe(observed.plans.length)
  })

  it("replays a plan for a repeated idempotency key and refuses a reused one", async () => {
    const observed = await withRuntime((runtime) =>
      Effect.gen(function*() {
        const first = yield* runtime.plan({ flowId: "system/test", input: { a: 1 }, idempotencyKey: "plan:key" })
        const replay = yield* runtime.plan({ flowId: "system/test", input: { a: 1 }, idempotencyKey: "plan:key" })
        // The second ask under one key is a replay of the stored card, and it
        // says so: `Control.plan` checks the journal before repairing a replay.
        const reused = yield* Effect.flip(
          runtime.plan({ flowId: "system/test", input: { a: 2 }, idempotencyKey: "plan:key" })
        )
        const listed = yield* Effect.map(runtime.pagePlanIds({ limit: 500 }), (page) => page.ids)
        return { first, replay, reused, listed }
      })
    )

    expect(observed.first.created).toBe(true)
    expect(observed.replay).toEqual({ card: observed.first.card, created: false })
    expect(observed.reused).toBeInstanceOf(InvalidInput)
    expect((observed.reused as InvalidInput).issue).toBe("idempotency key plan:key was used for another plan")
    // The refused plan allocated nothing: one key, one stored plan.
    expect(observed.listed).toEqual([observed.first.card.planId])
  })

  it.each([false, true])("settles concurrent keyed memory plans (different input: %s)", async (different) => {
    const ready = Deferred.makeUnsafe<void>()
    let arrivals = 0
    const observed = await withRuntime((runtime) =>
      Effect.gen(function*() {
        const outcomes = yield* Effect.all(
          [1, different ? 2 : 1].map((value) =>
            Effect.exit(runtime.plan({ flowId: "race", input: { value }, idempotencyKey: "race:key" }))
          ),
          { concurrency: 2 }
        )
        return { outcomes, ids: yield* Effect.map(runtime.pagePlanIds({ limit: 500 }), (page) => page.ids) }
      }), {
      flows: [{
        flowId: "race",
        description: "Concurrent planning",
        deployClass: false,
        envelope,
        decode: (input) =>
          Effect.gen(function*() {
            if (++arrivals === 2) yield* Deferred.succeed(ready, undefined)
            yield* Deferred.await(ready)
            return input
          })
      }]
    })

    expect(observed.ids).toHaveLength(1)
    const successes = observed.outcomes.filter(Exit.isSuccess).map((exit) => exit.value)
    expect(successes).toHaveLength(different ? 1 : 2)
    expect(successes.filter((outcome) => outcome.created)).toHaveLength(1)
    for (const outcome of successes) expect(outcome.card).toEqual(successes[0]!.card)
    if (different) {
      const failure = observed.outcomes.find(Exit.isFailure)!
      const error = await Effect.runPromise(Effect.flip(failure))
      expect(error).toBeInstanceOf(InvalidInput)
    }
  })

  it("reports a missing approval token against the identifier its target names", async () => {
    const observed = await withRuntime((runtime) =>
      Effect.gen(function*() {
        const plan = yield* Effect.flip(runtime.lookupApproval({
          _tag: "Plan",
          planId: "plan-absent",
          digest: "digest",
          envelope
        }))
        const node = yield* Effect.flip(runtime.lookupApproval({
          _tag: "Node",
          runId: "run-absent",
          requestId: "ask-absent",
          digest: "digest",
          envelope
        }))
        return { plan, node }
      })
    )

    expect(observed.plan).toBeInstanceOf(PlanNotFound)
    expect((observed.plan as PlanNotFound).planId).toBe("plan-absent")
    // A node target names the run, not the request: that is the id an
    // operator can act on.
    expect(observed.node).toBeInstanceOf(RunNotFound)
    expect((observed.node as RunNotFound).runId).toBe("run-absent")
  })

  it("refuses to re-register an in-run approval under a different envelope", async () => {
    const error = await withRuntime((runtime) =>
      Effect.gen(function*() {
        const { run } = yield* start(runtime)
        const target = {
          _tag: "Node" as const,
          runId: run.runId,
          requestId: "ask-1",
          digest: "ask-digest",
          envelope
        }
        yield* runtime.registerApproval(target)
        return yield* Effect.flip(
          runtime.registerApproval({ ...target, envelope: { ...envelope, capabilities: ["fs:write"] } })
        )
      })
    )

    expect(error).toBeInstanceOf(EnvelopeMismatch)
    expect((error as EnvelopeMismatch).planId).toBe("ask-1")
  })

  it("scopes one request id to each run and records who resolved it", async () => {
    const observed = await withRuntime((runtime) =>
      Effect.gen(function*() {
        const firstRun = (yield* start(runtime)).run
        const secondRun = (yield* start(runtime)).run
        const firstTarget = {
          _tag: "Node" as const,
          runId: firstRun.runId,
          requestId: "ask-shared",
          digest: "ask-digest",
          envelope
        }
        const secondTarget = { ...firstTarget, runId: secondRun.runId }
        const first = yield* runtime.registerApproval(firstTarget)
        const second = yield* runtime.registerApproval(secondTarget)

        yield* runtime.resolveApproval(first, "approved", principal)

        return {
          first,
          second,
          firstRunId: firstRun.runId,
          secondRunId: secondRun.runId,
          firstAfter: yield* runtime.registerApproval(firstTarget),
          secondAfter: yield* runtime.registerApproval(secondTarget)
        }
      })
    )

    expect(observed.first.target).toMatchObject({ _tag: "Node", runId: observed.firstRunId })
    expect(observed.firstAfter.target).toMatchObject({ _tag: "Node", runId: observed.firstRunId })
    expect(observed.second.target).toMatchObject({ _tag: "Node", runId: observed.secondRunId })
    expect(observed.secondAfter.target).toMatchObject({ _tag: "Node", runId: observed.secondRunId })
    expect(observed.firstRunId).not.toBe(observed.secondRunId)
    expect(observed.firstAfter).toMatchObject({ _tag: "Approved", decisionPrincipal: principal })
    expect(observed.secondAfter).toMatchObject({ _tag: "Pending" })
    expect(observed.secondAfter).not.toHaveProperty("decisionPrincipal")
  })

  it("keeps colliding plan and node token strings as distinct approvals", async () => {
    const observed = await withRuntime((runtime) =>
      Effect.gen(function*() {
        const { card } = yield* runtime.plan({ flowId: "system/test", input: { collision: true } })
        const { run } = yield* start(runtime)
        const nodeTarget = {
          _tag: "Node" as const,
          runId: run.runId,
          requestId: card.planId,
          digest: card.digest,
          envelope: card.envelope
        }
        const node = yield* runtime.registerApproval(nodeTarget)
        yield* runtime.resolveApproval(node, "approved", principal)

        return {
          plan: yield* runtime.lookupApproval(card.approval.target),
          storedPlan: yield* runtime.getPlan(card.planId),
          node: yield* runtime.registerApproval(nodeTarget)
        }
      })
    )

    expect(observed.plan).toMatchObject({ _tag: "Pending", target: { _tag: "Plan" } })
    expect(observed.storedPlan.decision).toBe("pending")
    expect(observed.node).toMatchObject({ _tag: "Approved", target: { _tag: "Node" } })
  })

  it("still refuses a changed digest for one node approval identity", async () => {
    const error = await withRuntime((runtime) =>
      Effect.gen(function*() {
        const { run } = yield* start(runtime)
        const target = {
          _tag: "Node" as const,
          runId: run.runId,
          requestId: "ask-digest",
          digest: "first",
          envelope
        }
        yield* runtime.registerApproval(target)
        return yield* Effect.flip(runtime.registerApproval({ ...target, digest: "second" }))
      })
    )

    expect(error).toBeInstanceOf(PlanDigestMismatch)
  })

  it("installs one grant per token however often the same token is presented", async () => {
    const grants = await withRuntime((runtime) =>
      Effect.gen(function*() {
        const { card } = yield* start(runtime)
        const token = { tokenId: card.planId, target: card.approval.target, _tag: "Pending" as const }
        // A retried decision presents the same token; a second grant would
        // widen what one approval installed.
        yield* runtime.installBulkGrant(token, { ...envelope, capabilities: ["fs:write"] }, "remembered")
        return yield* runtime.grants
      })
    )

    expect(grants).toMatchObject([{ scope: "run", envelope: { capabilities: [] } }])
  })

  it("resolves a token exactly once and refuses one it never issued", async () => {
    const observed = await withRuntime((runtime) =>
      Effect.gen(function*() {
        const { card } = yield* runtime.plan({ flowId: "system/test", input: {} })
        const token = { tokenId: card.planId, target: card.approval.target, _tag: "Pending" as const }
        yield* runtime.resolveApproval(token, "denied", principal)
        const again = yield* Effect.flip(runtime.resolveApproval(token, "approved", principal))
        const unknown = yield* Effect.flip(
          runtime.resolveApproval({ ...token, tokenId: "token-absent" }, "approved", principal)
        )
        const stored = yield* runtime.getPlan(card.planId)
        return { again, unknown, stored }
      })
    )

    expect(observed.again).toBeInstanceOf(AlreadyResolved)
    expect(observed.unknown).toBeInstanceOf(AlreadyResolved)
    expect((observed.unknown as AlreadyResolved).requestId).toBe("token-absent")
    expect(observed.stored.decision).toBe("denied")
  })

  it("refuses to launch an unknown plan, a mismatched envelope, or a denied decision", async () => {
    const observed = await withRuntime((runtime) =>
      Effect.gen(function*() {
        const missing = yield* Effect.flip(runtime.launch("plan-absent", "digest", envelope))
        const { card } = yield* runtime.plan({ flowId: "system/test", input: {} })
        const widened = yield* Effect.flip(
          runtime.launch(card.planId, card.digest, { ...envelope, capabilities: ["fs:write"] })
        )
        const token = yield* runtime.lookupApproval(card.approval.target)
        yield* runtime.resolveApproval(token, "denied", principal)
        const denied = yield* Effect.flip(runtime.launch(card.planId, card.digest, card.envelope))
        return { card, missing, widened, denied }
      })
    )

    expect(observed.missing).toBeInstanceOf(PlanNotFound)
    expect((observed.missing as PlanNotFound).planId).toBe("plan-absent")
    expect(observed.widened).toBeInstanceOf(EnvelopeMismatch)
    expect(observed.denied).toBeInstanceOf(PlanDenied)
    expect((observed.denied as PlanDenied).planId).toBe(observed.card.planId)
  })

  it("refuses every owner-sensitive operation once a park has released the fence", async () => {
    const observed = await withRuntime((runtime) =>
      Effect.gen(function*() {
        const { run } = yield* start(runtime)
        const fence = yield* runtime.claimFence(run.runId)
        const parked = yield* runtime.writeStatus(run.runId, fence, "parked")
        const again = yield* Effect.flip(runtime.writeStatus(run.runId, fence, "parked"))
        const interrupted = yield* Effect.flip(runtime.interrupt(run.runId))
        const evicted = yield* Effect.flip(runtime.claimFence(run.runId))
        return { parked, again, interrupted, evicted }
      })
    )

    expect(observed.parked.status).toBe("parked")
    expect(observed.parked.ownerId).toBeUndefined()
    expect(observed.again).toBeInstanceOf(ClaimLost)
    expect(observed.interrupted).toBeInstanceOf(ClaimLost)
    expect(observed.evicted).toBeInstanceOf(ClaimLost)
  })

  it.each(["launched", "resumed", "running"] as const)(
    "rejoins an owned %s run without replacing the worker's fence",
    async (state) => {
      await withRuntime((runtime) =>
        Effect.gen(function*() {
          const { run } = yield* start(runtime)
          if (state === "resumed") {
            yield* runtime.releasePending(run.runId, yield* runtime.claimFence(run.runId))
            yield* runtime.resume(run.runId)
          }
          const fence = yield* runtime.claimFence(run.runId)
          if (state === "running") yield* runtime.writeStatus(run.runId, fence, "running")
          const before = yield* runtime.getRun(run.runId)
          const rejoined = yield* runtime.resume(run.runId)
          expect(rejoined).toEqual(before)
          expect(yield* runtime.claimFence(run.runId)).toBe(fence)
          // The original worker can settle even if another caller resumed.
          expect((yield* runtime.writeStatus(run.runId, fence, "completed")).status).toBe("completed")
        })
      )
    }
  )

  it("reports a key reused for a different mutation as a conflict, not a replay", async () => {
    const observed = await withRuntime((runtime) =>
      Effect.gen(function*() {
        yield* runtime.recordMutation("mutation:key", "cancel:run-1", { _tag: "Accepted", receiptId: "r" })
        const replay = yield* runtime.lookupMutation("mutation:key", "cancel:run-1")
        const conflict = yield* runtime.lookupMutation("mutation:key", "cancel:run-2")
        const absent = yield* runtime.lookupMutation("mutation:other", "cancel:run-1")
        return { replay, conflict, absent }
      })
    )

    expect(observed.replay).toEqual({ _tag: "AlreadyApplied", receiptId: "r" })
    expect(observed.conflict).toEqual({
      _tag: "Conflict",
      message: "idempotency key mutation:key was used for another mutation"
    })
    expect(observed.absent).toBeUndefined()
  })

  it("refuses to overwrite a settled key with a different receipt", async () => {
    // The record is the proof one mutation happened once. Letting a second
    // mutation write over it under the same key would replay the wrong receipt
    // to whoever asks next, which is the one thing the key exists to prevent.
    const observed = await withRuntime((runtime) =>
      Effect.gen(function*() {
        yield* runtime.recordMutation("mutation:settled", "cancel:run-1", { _tag: "Accepted", receiptId: "r" })
        const reused = yield* Effect.flip(
          runtime.recordMutation("mutation:settled", "cancel:run-2", { _tag: "Accepted", receiptId: "r" })
        )
        const rewritten = yield* Effect.flip(
          runtime.recordMutation("mutation:settled", "cancel:run-1", { _tag: "Accepted", receiptId: "other" })
        )
        const idempotent = yield* runtime.recordMutation("mutation:settled", "cancel:run-1", {
          _tag: "Accepted",
          receiptId: "r"
        })
        return {
          idempotent,
          replay: yield* runtime.lookupMutation("mutation:settled", "cancel:run-1"),
          reused,
          rewritten
        }
      })
    )

    expect(observed.reused).toBeInstanceOf(PersistenceError)
    expect((observed.reused as PersistenceError).operation).toBe("record a mutation")
    expect(observed.rewritten).toBeInstanceOf(PersistenceError)
    // Re-recording the identical mutation is the retry the key is for, and it
    // leaves the stored receipt exactly where it was.
    expect(observed.idempotent).toBeUndefined()
    expect(observed.replay).toEqual({ _tag: "AlreadyApplied", receiptId: "r" })
  })

  it("refuses a plan input no snapshot can detach, after canonicalizing it", async () => {
    // Canonicalization mirrors `JSON.stringify`, which DROPS a function-valued
    // property, so this input has a canonical form and only `structuredClone`
    // refuses it. The refusal has to be the same typed `InvalidInput` a
    // canonical failure raises rather than a defect escaping the runtime, and
    // it must not carry the host's clone message.
    const error = await withRuntime((runtime) =>
      Effect.flip(runtime.plan({ flowId: "system/test", input: { visit: () => "unclonable" } }))
    )

    expect(error).toBeInstanceOf(InvalidInput)
    expect((error as InvalidInput).issue).toBe("$: canonicalization failed")
  })

  it("answers a settled run's own summary from interrupt rather than ClaimLost", async () => {
    // Terminality is read first. A settled run released its fence on the way
    // out, so the fence check would answer `ClaimLost` about a run that has
    // nothing left to interrupt, which names the wrong problem.
    const observed = await withRuntime((runtime) =>
      Effect.gen(function*() {
        const settled = yield* start(runtime)
        const fence = yield* runtime.claimFence(settled.run.runId)
        yield* runtime.writeStatus(settled.run.runId, fence, "completed")
        return {
          interrupted: yield* runtime.interrupt(settled.run.runId),
          resumed: yield* runtime.resume(settled.run.runId)
        }
      })
    )

    expect(observed.interrupted.status).toBe("completed")
    // The same read on the same reason: restarting a settled run restarts
    // nothing, and it answers with the run rather than a claim failure.
    expect(observed.resumed.status).toBe("completed")
  })

  it("stops offering a resume the run can no longer take up, and keeps one whose cursor moved on", async () => {
    // `pendingResumes` is what a host polls. A settled run is nobody's to
    // restart, and a clear that names an older cursor belongs to a delegation
    // this one already replaced.
    const observed = await withRuntime((runtime) =>
      Effect.gen(function*() {
        const settled = yield* start(runtime)
        const standing = yield* start(runtime)
        yield* runtime.requestResume(settled.run.runId)
        const first = yield* runtime.requestResume(standing.run.runId)
        const second = yield* runtime.requestResume(standing.run.runId)
        const fence = yield* runtime.claimFence(settled.run.runId)
        yield* runtime.writeStatus(settled.run.runId, fence, "cancelled")
        yield* runtime.clearResume(standing.run.runId, first)
        yield* runtime.clearResume("run-that-never-existed", second)
        const stale = yield* runtime.pendingResumes
        yield* runtime.clearResume(standing.run.runId, second)
        return { second, settled: settled.run.runId, stale, taken: yield* runtime.pendingResumes }
      })
    )

    // The cancelled run is gone from the listing; the standing one survived
    // both a stale cursor and an unknown run id.
    expect(observed.stale.map((pending) => pending.runId)).not.toContain(observed.settled)
    expect(observed.stale.map((pending) => pending.sequence)).toEqual([observed.second])
    expect(observed.taken).toEqual([])
  })

  it("stamps a submitted principal over the composition's own, on its own clock", async () => {
    // The submitted identity is the one the server authenticated, and the
    // configured one is the composition's fallback for a caller that named
    // none. A composition default that won would silently rename every
    // authenticated operator to whatever the host was built with.
    const observed = await withRuntime(
      (runtime) =>
        Effect.gen(function*() {
          const submitted = yield* runtime.stampPrincipal({ id: "remote", kind: "bearer", stampedAt: 99 })
          const unnamed = yield* runtime.stampPrincipal()
          return { submitted, unnamed }
        }),
      { principal: { id: "server", kind: "operator" }, now: () => 7 }
    )
    const defaulted = await withRuntime((runtime) => runtime.stampPrincipal())
    const submitted = await withRuntime((runtime) =>
      runtime.stampPrincipal({ id: "cli", kind: "human", stampedAt: 99 })
    )

    expect(observed.submitted).toEqual({ id: "remote", kind: "bearer", stampedAt: 7 })
    expect(observed.unnamed).toEqual({ id: "server", kind: "operator", stampedAt: 7 })
    expect(defaulted).toMatchObject({ id: "memory", kind: "test" })
    // With nothing configured, a submitted identity is accepted but restamped.
    expect(submitted).toMatchObject({ id: "cli", kind: "human" })
    expect(submitted.stampedAt).not.toBe(99)
  })
})
