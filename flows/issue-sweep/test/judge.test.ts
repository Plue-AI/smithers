/**
 * The triage judge at run level. A judge this host can never use fails the
 * run before any GitHub read or claim; a judge that did not answer requeues
 * each issue it could not read; the sweep's own judge answers even when the
 * host provides another. Every seam is recorded: no GitHub, judge, or agent
 * runs for real.
 */
import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import { FlowEngine } from "@smthrs/engine"
import { Action, Flow, Interpreter, Sleep, WaitFor } from "@smthrs/flow"
import * as Evaluator from "@smthrs/model/Evaluator"
import { Burndown } from "@smthrs/patterns"
import { Cause, Effect, Exit, Layer, Schema } from "effect"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { judging, type SelectSeams, sweepRound } from "../flow.ts"
import { classify, fileCache, probe, type Text, type Triage, type TriageFailed } from "../triage.ts"

interface Issue {
  readonly id: string
  readonly number: number
  readonly title: string
  readonly labels: ReadonlyArray<string>
  readonly updatedAt?: string | undefined
}

const issue = (number: number): Issue => ({
  id: String(number),
  number,
  title: `issue ${number}`,
  labels: [],
  updatedAt: "2026-10-01T23:53:00Z"
})

// What run-11's detached host answered for every reading.
const unconfigured = () =>
  new Evaluator.EvaluatorError({
    code: "unconfigured",
    message: `AI_GATEWAY_API_KEY is not set. Luna is not opted in. ${Evaluator.unconfiguredMessage}`
  })

const unreachable = () => new Evaluator.EvaluatorError({ code: "unreachable", message: "connect ECONNREFUSED" })

/** A judge that answers by the title it reads, and records every title. */
const scriptedJudge = (answer: (title: string) => Evaluator.EvaluatorError | "code-change") => {
  const asked: Array<string> = []
  const layer = Evaluator.layerScripted((request) => {
    const title = (request.state as Text).title
    asked.push(title)
    const answered = answer(title)
    return answered instanceof Evaluator.EvaluatorError ? Effect.fail(answered) : { need: { choice: answered } }
  })
  const judged = Effect.runSync(Effect.service(Evaluator.Evaluator).pipe(Effect.provide(layer)))
  return { asked, layer, classify: judging(judged) }
}

/** The round's seams and members, every call recorded. */
const recorded = (
  t: { after: (fn: () => void) => void },
  read: (text: Text) => Effect.Effect<Triage, TriageFailed>
) => {
  const dir = mkdtempSync(join(tmpdir(), "issue-sweep-judge-"))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const log = {
    read: [] as Array<number>,
    claimed: [] as Array<number>,
    worked: [] as Array<string>,
    released: [] as Array<string>
  }
  const seams: SelectSeams<never, never> = {
    cache: fileCache(join(dir, "triage.json")),
    requalified: () => Effect.succeed(false),
    newestClaim: () => Effect.succeed(undefined),
    read: (_, number) => Effect.sync(() => (log.read.push(number), { title: `#${number}`, body: "", comments: [] })),
    classify: read,
    record: () => Effect.die("every issue here is a code change: no verdict is recorded")
  }
  const options: Burndown.RoundOptions<unknown, Issue, string, TriageFailed | Burndown.Stop, never> = {
    key: "issue-sweep-test",
    concurrency: 2,
    claim: ({ item }) => Effect.sync(() => void log.claimed.push(item.number)),
    work: ({ item, round }) => Effect.sync(() => (log.worked.push(`#${item.number}@${round}`), "changed")),
    release: ({ item, status }) => Effect.sync(() => void log.released.push(`#${item.number}:${status}`))
  }
  return { log, seams, options }
}

// The sweep's lineage over test discovery: a round per handoff, as in flow.ts.
const Discover = Action.make("issue-sweep-test/discover", {
  payload: { input: Schema.Unknown, round: Schema.Number },
  success: Schema.Unknown
})
const Dispatch = Burndown.dispatch("issue-sweep-test/dispatch")
const Rounds = Burndown.make({ name: "issue-sweep-test/rounds", discover: Discover, dispatch: Dispatch, maxRounds: 5 })

let runs = 0

const sweep = (
  backlog: (round: number) => ReadonlyArray<Issue>,
  { options, seams }: Pick<ReturnType<typeof recorded>, "options" | "seams">
) =>
  Effect.runPromiseExit(
    (Rounds.execute({ input: { repo: "o/r" } }, { executionId: `judge-${++runs}` }) as Effect.Effect<
      Burndown.Result,
      unknown,
      any
    >).pipe(
      Effect.provide(
        Layer.mergeAll(
          Interpreter.layer(Rounds),
          Sleep.layer,
          WaitFor.layer,
          Discover.toLayer(({ round }) => Effect.succeed(backlog(round))),
          Dispatch.toLayer((payload) =>
            sweepRound({ ...payload, items: payload.items as ReadonlyArray<Issue> }, options, seams)
          )
        ).pipe(
          Layer.provideMerge(Action.layerImplementations),
          Layer.provideMerge(FlowEngine.layerMemory),
          Layer.provideMerge(NodeCrypto.layer)
        ) as Layer.Layer<any>
      ),
      Effect.scoped
    ) as Effect.Effect<Burndown.Result, unknown>
  )

const stopOf = (exit: Exit.Exit<unknown, unknown>): Burndown.Stop => {
  assert.ok(Exit.isFailure(exit), "expected the run to fail")
  const found = Cause.findErrorOption(exit.cause)
  assert.equal(found._tag, "Some", Cause.pretty(exit.cause))
  const error = (found as { readonly value: unknown }).value
  assert.ok(error instanceof Burndown.Stop, Cause.pretty(exit.cause))
  return error
}

test("an unconfigured judge fails the run before any GitHub read or claim", async (t) => {
  const judge = scriptedJudge(() => unconfigured())
  const round = recorded(t, judge.classify)

  const stop = stopOf(await sweep(() => [issue(1), issue(2)], round))

  assert.match(stop.message, /unconfigured: AI_GATEWAY_API_KEY is not set\. Luna is not opted in\./)
  assert.deepEqual(judge.asked, [probe.title])
  assert.deepEqual(round.log, { read: [], claimed: [], worked: [], released: [] })
})

test("a judge that turns unusable after the preflight stops the round before any claim", async (t) => {
  const judge = scriptedJudge((title) => title === probe.title ? "code-change" : unconfigured())
  const round = recorded(t, judge.classify)

  const stop = stopOf(await sweep(() => [issue(1), issue(2)], round))

  assert.match(stop.message, /unconfigured/)
  assert.deepEqual(round.log.claimed, [])
  assert.deepEqual(round.log.worked, [])
})

test("an unreachable judge requeues each issue it could not read, and a later round works them", async (t) => {
  let outage = true
  const judge = scriptedJudge(() => outage ? unreachable() : "code-change")
  const round = recorded(t, judge.classify)

  const exit = await sweep((index) => {
    if (index > 0) outage = false
    return [issue(1), issue(2)]
  }, round)

  assert.ok(Exit.isSuccess(exit), Exit.isFailure(exit) ? Cause.pretty(exit.cause) : "")
  assert.deepEqual(exit.value, {
    rows: [
      { id: "1", status: "landed", detail: "", requeues: 1 },
      { id: "2", status: "landed", detail: "", requeues: 1 }
    ],
    rounds: 3,
    stopped: "drained"
  })
  // Round 0: the preflight and both readings found no judge, so nothing was
  // claimed and no issue was skipped. Round 1 read and worked both.
  assert.deepEqual(judge.asked, [probe.title, "#1", "#2", probe.title, "#1", "#2", probe.title])
  assert.deepEqual(round.log.claimed.toSorted(), [1, 2])
  assert.deepEqual(round.log.worked.toSorted(), ["#1@1", "#2@1"])
})

test("the sweep's own judge answers triage, not the Evaluator the host provides", async () => {
  // The flow's judge opts in to Luna; the host's, built from a detached
  // host's environment, is unconfigured, as on run-11.
  const flowJudge = Evaluator.layerScripted(() => ({ need: { choice: "operator" } }))
  const hostJudge = Evaluator.layerScripted(() => Effect.fail(unconfigured()))
  const Ask = Action.make("issue-sweep-test/ask", {
    payload: { title: Schema.String },
    success: Schema.String,
    nondeterministic: true
  })
  const Asking = Flow.make("issue-sweep-test/asking", {
    payload: { title: Schema.String },
    success: Schema.String,
    body: (input) => Ask.call(input)
  })
  const ask = (read: (text: Text) => Effect.Effect<Triage, TriageFailed, any>) => () =>
    read({ title: "t", body: "", comments: [] }).pipe(
      Effect.map((triaged) => triaged.need as string),
      Effect.catch((failed) => Effect.succeed(failed.message))
    )
  const answer = (implementation: Layer.Layer<any, never, any>) =>
    Effect.runPromise(
      (Asking.execute({ title: "t" }, { executionId: `asking-${++runs}` }) as Effect.Effect<string, never, any>).pipe(
        Effect.provide(
          Layer.mergeAll(Interpreter.layer(Asking), implementation).pipe(
            Layer.provideMerge(Action.layerImplementations),
            Layer.provideMerge(FlowEngine.layerMemory),
            Layer.provideMerge(NodeCrypto.layer)
          ) as Layer.Layer<any>
        ),
        Effect.provide(hostJudge),
        Effect.scoped
      ) as Effect.Effect<string>
    )

  // Provided to the layer only, the flow's judge loses to the host's.
  assert.match(await answer(Ask.toLayer(ask(classify)).pipe(Layer.provide(flowJudge))), /unconfigured/)
  // Bound at the call, as the dispatch binds it, the flow's judge answers.
  const bound = Layer.unwrap(
    Effect.map(Effect.service(Evaluator.Evaluator), (judged) => Ask.toLayer(ask(judging(judged))))
  ).pipe(Layer.provide(flowJudge))
  assert.equal(await answer(bound), "operator")
})
