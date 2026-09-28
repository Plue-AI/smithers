/**
 * The spending ceiling a flow declares, from its frontmatter to the refusal.
 *
 * `layerExecutor` hands `Budget.layerFromEnvelope` to `AgentSession`, which
 * builds one budget per run out of the approved card's envelope. That made the
 * enforcement real everywhere except where it mattered: `durableFlow` filled
 * every discovered flow's envelope with a hardcoded `budget: {}`, so the layer
 * bound nothing on the shipped CLI however carefully a flow declared its
 * ceilings. The declaration had nowhere to live either, because
 * `Descriptor.FlowDescriptor` had no budget field at all.
 *
 * These cases walk the whole path with nothing stubbed: a real project
 * directory, the real registry scanning it, the real durable control runtime
 * planning against `.flows/control.db`, and the real budget the composition
 * builds from the envelope that plan carries. The refusal is checked on the
 * policy the envelope produced rather than on numbers this file states, which
 * is the half that was broken: a passing assertion here is a flow whose
 * declared ceiling reaches the seam that enforces it.
 *
 * The accumulator these cases use is the budget's out-of-run tally. Keying by
 * execution id, journal recovery, and the latch belong to the budget itself
 * and are covered in `packages/smithers/agent/test/Budget.test.ts`; what is untried here
 * is whether the policy it enforces carries the numbers the flow declared.
 */
import { NodeHttpClient } from "@effect/platform-node"
import { MockAgent } from "@effect/platform-node/Undici"
import * as Budget from "@smthrs/agent/Budget"
import * as ScriptedJudge from "@smthrs/agent/ScriptedJudge"
import { Control as ControlService, ControlSchema } from "@smthrs/control"
import * as GrantStore from "@smthrs/kernel/GrantStore"
import * as RequestExecutor from "@smthrs/model/RequestExecutor"
import { Effect, Layer, Schedule, Schema, Stream } from "effect"
import * as HttpClient from "effect/unstable/http/HttpClient"
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import * as Application from "../src/Application.ts"
import * as NodeControl from "../src/NodeControl.ts"

/** One discovered markdown flow, with whatever budget the case declares. */
const skill = (declaration: ReadonlyArray<string>): string =>
  [
    "---",
    "description: Reviews a proposed change.",
    ...declaration,
    "---",
    "",
    "# Review",
    ""
  ].join("\n")

/**
 * Scans a project holding that one flow and plans it, returning the envelope
 * the control plane approved.
 *
 * Every layer is the production one: `layerRegistry` discovers under the
 * guarded platform, and `engineDurable` opens the real SQLite control database
 * and registers what the registry found.
 */
const plannedEnvelope = async (
  declaration: ReadonlyArray<string>,
  budget?: ControlSchema.Envelope["budget"]
) => {
  const project = await mkdtemp(join(tmpdir(), "flows-cli-budget-"))
  try {
    await mkdir(join(project, "flows", "review"), { recursive: true })
    await writeFile(join(project, "flows", "review", "SKILL.md"), skill(declaration))
    const registry = NodeControl.layerRegistry(project)
    const engine = NodeControl.engineDurable(project, registry)
    return await Effect.runPromise(
      Effect.gen(function*() {
        const control = yield* ControlService.Control
        const card = yield* control.plan({ flowId: "review", input: {}, ...(budget === undefined ? {} : { budget }) })
        return card.envelope
      }).pipe(
        Effect.provide(Application.layer({}, registry, engine) as Layer.Layer<ControlService.Control>),
        Effect.scoped,
        Effect.orDie
      )
    )
  } finally {
    await rm(project, { recursive: true, force: true })
  }
}

/**
 * Spends one call of `tokens` under the budget the composition builds from an
 * envelope, then asks whether the next call may be made.
 *
 * The projection is the point: a budget refuses BEFORE a call, costing the
 * largest call the run has made, so one recorded call of 900 against a 1,000
 * token ceiling is already over.
 */
const verdictAfterSpending = (envelope: Parameters<typeof Budget.layerFromEnvelope>[0], tokens: number) =>
  Effect.runPromise(
    Effect.gen(function*() {
      const budget = yield* Budget.current
      yield* budget.record("review/model-call-1", { totalTokens: tokens })
      // `check` takes the step key that keys per-step counting; this helper
      // asks the envelope-wide question, which is what `undefined` means.
      return yield* budget.check(undefined)
    }).pipe(
      Effect.provide(Budget.layerFromEnvelope(envelope)),
      Effect.scoped,
      Effect.orDie
    )
  )

describe("a declared flow budget", () => {
  it("reaches the approved envelope through the real CLI composition", async () => {
    const envelope = await plannedEnvelope(["budget:", "  tokens: 1000", "  milliseconds: 60000"])

    // Before the descriptor carried a budget this read `{}` for every flow in
    // every project, which is what left `Budget.layerFromEnvelope` binding
    // nothing.
    expect(envelope.budget).toEqual({ tokens: 1000, milliseconds: 60000 })
  })

  it("refuses the call that would overspend it", async () => {
    const envelope = await plannedEnvelope(["budget:", "  tokens: 1000"])
    const verdict = await verdictAfterSpending(envelope, 900)

    expect(verdict._tag).toBe("refuse")
    if (verdict._tag !== "refuse") return
    // The ceiling the refusal names is the flow's own declaration, carried
    // whole: nothing in this file told the budget what 1,000 was.
    expect(verdict.exceeded.scope).toBe("tokens")
    expect(verdict.exceeded.max).toBe(1000)
    expect(verdict.exceeded.used).toBe(900)
    expect(verdict.exceeded.next).toBe(900)
    expect(verdict.failure).toBeInstanceOf(Budget.BudgetExceeded)
  })

  it("leaves a flow that declares none unbounded", async () => {
    const envelope = await plannedEnvelope([])

    // Absent stays absent rather than becoming a zero ceiling, so every flow
    // written before budgets existed runs exactly as it did.
    expect(envelope.budget).toEqual({})
    expect(await verdictAfterSpending(envelope, 10_000_000)).toEqual({ _tag: "proceed" })
  })

  it("ignores a malformed declaration instead of refusing every call", async () => {
    // A budget has no conservative reading: the conservative number is zero,
    // and a zero ceiling would report a typo as a spending decision. Discovery
    // warns and drops it, so the flow runs unbounded.
    const envelope = await plannedEnvelope(["budget:", "  tokens: soon"])

    expect(envelope.budget).toEqual({})
  })
})

describe("a budget's onExceeded choice", () => {
  it("reaches the approved envelope and the policy from frontmatter", async () => {
    const envelope = await plannedEnvelope(["budget:", "  tokens: 1000", "  onExceeded: park"])

    expect(envelope.budget).toEqual({ tokens: 1000, onExceeded: "park" })
    // The composition's default is `fail`; the approved choice wins over it.
    const policy = Budget.policyFromEnvelope(envelope, { onExceeded: "fail" })
    expect(policy.tokens).toEqual({ max: 1000, onExceeded: "park" })
  })

  it("drops an unknown choice and keeps the ceiling", async () => {
    const envelope = await plannedEnvelope(["budget:", "  tokens: 1000", "  onExceeded: sulk"])

    expect(envelope.budget).toEqual({ tokens: 1000 })
  })

  it("lets a planner replace the declared budget, as flow start's flags do", async () => {
    const envelope = await plannedEnvelope(["budget:", "  tokens: 1000", "  milliseconds: 60000"], {
      tokens: 50,
      onExceeded: "park"
    })

    expect(envelope.budget).toEqual({ tokens: 50, milliseconds: 60000, onExceeded: "park" })
  })
})

/** One OpenAI Responses stream whose only output is `text`, reporting `tokens` spent. */
const sse = (text: string, tokens: number): string =>
  [
    `data: ${JSON.stringify({ type: "response.output_text.delta", item_id: "msg_1", delta: text })}`,
    "",
    `data: ${JSON.stringify({ type: "response.output_text.done", item_id: "msg_1" })}`,
    "",
    `data: ${
      JSON.stringify({
        type: "response.completed",
        response: {
          id: "resp_budget",
          usage: { input_tokens: tokens / 2, output_tokens: tokens / 2, total_tokens: tokens }
        }
      })
    }`,
    "",
    ""
  ].join("\n")

/**
 * Runs `review`, declared at 30 tokens with `onExceeded: park`, on the shipped
 * executor until it parks, answers the park with `decision`, and follows the
 * run to its end. Every call costs 20 tokens: the first frame fits and does not
 * finish, and the second is projected at 20 + 20 and parks.
 */
const parkedRun = async (
  decision: "approve" | "deny",
  ceiling: { readonly declaration: ReadonlyArray<string>; readonly delayMs: number } = {
    declaration: ["  tokens: 30"],
    delayMs: 0
  }
) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "flows-cli-budget-park-")))
  const agent = new MockAgent()
  try {
    await mkdir(join(root, "flows", "review"), { recursive: true })
    await writeFile(
      join(root, "flows", "review", "flow.mdx"),
      [
        "---",
        "name: review",
        "description: Reviews a proposed change.",
        "model: openai:gpt-4o-mini",
        "budget:",
        ...ceiling.declaration,
        "  onExceeded: park",
        "---",
        "",
        "Review the change.",
        ""
      ].join("\n")
    )
    const bodies: Array<string> = []
    agent.disableNetConnect()
    const reply = agent.get("https://api.openai.com").intercept({ method: "POST", path: "/v1/responses" }).reply(
      200,
      (options) => {
        bodies.push(String(options.body))
        return sse(bodies.length === 1 ? "```cell\nconst looked = 1\n```" : "```cell\nctx.done(\"reviewed\")\n```", 20)
      },
      { headers: { "content-type": "text/event-stream" } }
    )
    // Undici refuses a zero delay, so only a slow provider sets one.
    if (ceiling.delayMs > 0) reply.delay(ceiling.delayMs)
    reply.persist()
    const client = await Effect.runPromise(
      NodeHttpClient.makeUndici.pipe(Effect.provideService(NodeHttpClient.Dispatcher, agent))
    )
    const registry = NodeControl.layerRegistry(root)
    const engine = NodeControl.engineDurable(root, registry)
    const runs = NodeControl.layerExecutor(registry, engine, root, {
      evaluator: ScriptedJudge.layerAll,
      environment: { OPENAI_API_KEY: "test-key" },
      grants: GrantStore.layerNoop,
      requestExecutor: Layer.effect(RequestExecutor.RequestExecutor)(
        RequestExecutor.make.pipe(Effect.provideService(HttpClient.HttpClient, client))
      )
    })
    const layer = Application.layer({ root }, registry, engine, runs) as Layer.Layer<ControlService.Control>
    const observed = await Effect.runPromise(
      Effect.gen(function*() {
        const control = yield* ControlService.Control
        const card = yield* control.plan({ flowId: "review", input: {} })
        yield* control.approve(card.approval)
        const receipt = yield* control.run({
          _tag: "Plan",
          planId: card.planId,
          digest: card.digest,
          envelope: card.envelope,
          idempotencyKey: "budget-park"
        })
        if (receipt._tag !== "Accepted" || receipt.runId === undefined) {
          return yield* Effect.die("expected an accepted run")
        }
        const runId = receipt.runId
        const summary = Effect.map(
          control.list({ _tag: "runs", filters: { runId } }),
          (page) => (page._tag === "runs" ? page.items[0] : undefined)
        )
        const requested = yield* control.watch({ runId, follow: true }).pipe(
          Stream.filter((event) => event.kind === "control.approval.requested"),
          Stream.take(1),
          Stream.runCollect
        )
        // The control event can land before the engine row suspends, so
        // wait for the observed summary itself.
        const parked = yield* summary.pipe(
          Effect.flatMap((run) => run?.status === "parked" ? Effect.succeed(run) : Effect.fail(run)),
          Effect.retry({ schedule: Schedule.spaced("20 millis"), times: 500 }),
          Effect.orDie
        )
        const callsWhileParked = bodies.length
        const approval = Schema.decodeUnknownSync(ControlSchema.ApprovalPayload)(
          (requested[0]!.payload as { readonly payload: unknown }).payload
        )
        yield* decision === "approve" ? control.approve(approval) : control.deny(approval)
        const terminal = new Set(["control.run.completed", "control.run.failed", "control.run.cancelled"])
        // A second request, not a settlement, is what a decision whose
        // identity drifted on resume looks like.
        const events = yield* control.watch({ runId, follow: true, afterSequence: requested[0]!.sequence }).pipe(
          Stream.takeUntil((event) => terminal.has(event.kind) || event.kind === "control.approval.requested"),
          Stream.runCollect
        )
        return { parked, callsWhileParked, approval, last: [...events].at(-1)?.kind, settled: yield* summary }
      }).pipe(Effect.provide(layer), Effect.scoped, Effect.orDie)
    )
    return { ...observed, bodies }
  } finally {
    await agent.close()
    await rm(root, { recursive: true, force: true, maxRetries: 5 })
  }
}

describe("a parked budget", () => {
  it("parks a run at its token ceiling with onExceeded park and resumes after approve raises the budget", async () => {
    const observed = await parkedRun("approve")

    // The run parked on its budget instead of failing, before the second call.
    expect(observed.parked).toMatchObject({ status: "parked", waitingReason: "budget" })
    expect(observed.callsWhileParked).toBe(1)
    // The request proposes the raise an approval grants: spent 20, next 20,
    // plus one more 30-token allowance.
    expect(observed.approval.target._tag).toBe("Node")
    expect(observed.approval.target.envelope.budget).toEqual({ tokens: 70, onExceeded: "park" })
    // Approving it resumed the run under the raised ceiling, and the first
    // frame replayed from the journal rather than calling the provider again.
    expect(observed.last).toBe("control.run.completed")
    expect(observed.settled?.status).toBe("completed")
    expect(observed.bodies.length).toBeGreaterThan(1)
    expect(new Set(observed.bodies).size).toBe(observed.bodies.length)
  }, 60_000)

  it("fails the run when the raise is denied, without calling the provider again", async () => {
    const observed = await parkedRun("deny")

    expect(observed.parked).toMatchObject({ status: "parked", waitingReason: "budget" })
    expect(observed.last).toBe("control.run.failed")
    expect(observed.settled?.status).toBe("failed")
    expect(observed.bodies).toHaveLength(1)
  }, 60_000)

  it("fails a run whose latency raise is denied instead of asking again on resume", async () => {
    // The first response takes 150 ms against a 100 ms ceiling, so the second
    // call parks. The elapsed time keeps growing while parked, and the denial
    // must still answer the request it was made on (#2739).
    const observed = await parkedRun("deny", { declaration: ["  milliseconds: 100"], delayMs: 150 })

    expect(observed.parked).toMatchObject({ status: "parked", waitingReason: "budget" })
    expect(observed.last).toBe("control.run.failed")
    expect(observed.settled?.status).toBe("failed")
    expect(observed.bodies).toHaveLength(1)
  }, 60_000)
})
