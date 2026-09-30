import { describe, expect, it } from "bun:test"
import { Effect } from "effect"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as Estimate from "../src/estimate.ts"
import * as Flows from "../src/flows.ts"
import * as Improve from "../src/improve.ts"
import * as Runtime from "../src/runtime.ts"
import type * as Session from "../src/session.ts"
import type * as Workspace from "../src/workspace.ts"

const minute = 60_000
const scratch = () => mkdtempSync(join(tmpdir(), "tui-estimate-"))

/** A worker transcript: a prompt, `calls` model calls of `tokens` each, and an outcome `ms` later. */
const worker = (dir: string, name: string, text: string, ms: number, tokens: number, calls = 2): string => {
  const file = join(dir, `${name}.jsonl`)
  const records: Array<Session.Record> = [
    { type: "session", version: 1, id: name, cwd: dir, createdAt: 0 },
    { type: "user", at: 1_000, text },
    ...Array.from({ length: calls }, (_, index): Session.Record => ({
      type: "event",
      at: 1_000 + index,
      event: {
        _tag: "model-settled",
        usage: { inputTokens: tokens - 10, outputTokens: 10, totalTokens: tokens },
        durationMillis: 5
      } as never
    })),
    { type: "outcome", at: 1_000 + ms, prompt: text, outcome: { _tag: "done", answer: "ok" } }
  ]
  writeFileSync(file, records.map((record) => JSON.stringify(record)).join("\n") + "\n")
  return file
}

const tab = (file: string, patch: Partial<Workspace.Tab> = {}): Workspace.Tab => ({
  id: "fix",
  title: "Fix scroll",
  prompt: "Fix scrolling up in the transcript",
  seat: "openai:gpt-6-sol",
  file,
  status: "running",
  startedAt: 0,
  ...patch,
  depth: patch.depth ?? 0
})

describe("Improve.Ledger", () => {
  it("records a prediction, scores its observation, and rebuilds both from the file", () => {
    const file = join(scratch(), "evals", "loop.jsonl")
    const ledger = new Improve.Ledger(file)
    const prediction = ledger.predict({
      id: "a",
      kind: "flow",
      key: "flow:deploy",
      method: "history",
      subject: "deploy",
      at: 0,
      raw: { ms: 10 * minute }
    })
    expect(prediction.value).toEqual({ ms: 10 * minute })
    const scored = ledger.observe({
      id: "a",
      kind: "flow",
      key: "flow:deploy",
      subject: "deploy",
      at: 1,
      outcome: "done",
      actual: { ms: 25 * minute }
    })
    expect(scored?.ratio.ms).toBeCloseTo(2.5)
    expect(scored?.inside.ms).toBe(false)

    const reloaded = new Improve.Ledger(file)
    expect(reloaded.scored()).toHaveLength(1)
    expect(reloaded.prediction("a")?.raw).toEqual({ ms: 10 * minute })
    // One prediction and one observation per id: a repeat returns the first.
    expect(reloaded.predict({ ...prediction, raw: { ms: 1 } }).raw).toEqual({ ms: 10 * minute })
    expect(reloaded.observe({ ...scored!.observation, actual: { ms: 1 } })).toBeUndefined()
    expect(new Improve.Ledger(file).scored()).toHaveLength(1)
  })

  it("does not score failed or cancelled work, but keeps it on record", () => {
    const ledger = new Improve.Ledger(undefined)
    ledger.predict({ id: "a", kind: "flow", key: "k", method: "history", subject: "s", at: 0, raw: { ms: 10 } })
    expect(
      ledger.observe({ id: "a", kind: "flow", key: "k", subject: "s", at: 1, outcome: "failed", actual: { ms: 3 } })
    )
      .toBeUndefined()
    expect(ledger.observations()).toHaveLength(1)
    expect(ledger.scored()).toHaveLength(0)
  })

  it("learns a bias from raw errors and widens the interval from the residuals", () => {
    const ledger = new Improve.Ledger(undefined)
    // The raw predictor is consistently half the truth.
    for (let index = 0; index < 6; index++) {
      const id = `p${index}`
      ledger.predict({
        id,
        kind: "delegate",
        key: "delegate",
        method: "model",
        subject: id,
        at: index,
        raw: { ms: 10 }
      })
      ledger.observe({
        id,
        kind: "delegate",
        key: "delegate",
        subject: id,
        at: index,
        outcome: "done",
        actual: { ms: 20 * (index % 2 === 0 ? 0.8 : 1.25) }
      })
    }
    const stats = ledger.stats((prediction) => prediction.method === "model", ["ms"])
    expect(stats.n).toBe(6)
    expect(stats.bias.ms).toBeCloseTo(20 / 10, 0)
    const next = ledger.predict({
      id: "next",
      kind: "delegate",
      key: "delegate",
      method: "model",
      subject: "n",
      at: 9,
      raw: { ms: 10 }
    })
    expect(next.value.ms).toBeGreaterThan(18)
    expect(next.value.ms).toBeLessThan(22)
    expect(next.low.ms!).toBeLessThan(next.value.ms!)
    expect(next.high.ms!).toBeGreaterThan(next.value.ms!)
    // Another method's history does not calibrate this one.
    const other = ledger.predict({
      id: "h",
      kind: "delegate",
      key: "delegate",
      method: "history",
      subject: "h",
      at: 9,
      raw: { ms: 10 }
    })
    expect(other.value.ms).toBe(10)
  })
})

describe("Estimate", () => {
  it("estimates a repeated flow from its own past runs", () => {
    const estimator = new Estimate.Estimator({ ledger: new Improve.Ledger(undefined) })
    for (const [index, ms] of [10, 12, 14].entries()) {
      estimator.request({ id: `r${index}`, kind: "flow", key: "flow:deploy", subject: "deploy", startedAt: 0 })
      estimator.settle(`r${index}`, { ms: ms * minute }, "done")
    }
    const estimate = estimator.request({ id: "r3", kind: "flow", key: "flow:deploy", subject: "deploy", startedAt: 0 })
    expect(estimate).toMatchObject({ method: "history", basis: 2 })
    expect(estimate?.ms).toBe(12 * minute)
  })

  it("asks the model for a novel task with scored examples and error stats, then records its answer", async () => {
    const prompts: Array<{ system: string; prompt: string }> = []
    const estimator = new Estimate.Estimator({
      ledger: new Improve.Ledger(undefined),
      model: async (request) => {
        prompts.push(request)
        return "```json\n{\"minutes\": 20, \"tokens\": 300000, \"low_minutes\": 10, \"high_minutes\": 40}\n```"
      }
    })
    estimator.request({ id: "old", kind: "delegate", key: "delegate", subject: "Fix the status bug", startedAt: 0 })
    await estimator.idle()
    estimator.settle("old", { ms: 33 * minute, tokens: 446_017 }, "done")

    const changed: Array<number> = []
    estimator.subscribe(() => changed.push(1))
    expect(estimator.request({ id: "new", kind: "delegate", key: "delegate", subject: "Fix scroll up", startedAt: 0 }))
      .toBeUndefined()
    await estimator.idle()
    expect(changed.length).toBeGreaterThan(0)
    expect(estimator.get("new")).toMatchObject({ method: "model", ms: 20 * minute, tokens: 300_000 })
    const last = prompts.at(-1)!
    expect(last.system).toMatch(/reference class/i)
    expect(last.prompt).toContain("Fix scroll up")
    expect(last.prompt).toContain("Fix the status bug")
    expect(last.prompt).toMatch(/estimated 20m, took 33m/)
    expect(last.prompt).toMatch(/actual \/ estimate/)
  })

  it("records an unusable answer as a typed failure, falls back to the class median, and asks once per task", async () => {
    let asked = 0
    const estimator = new Estimate.Estimator({
      ledger: new Improve.Ledger(undefined),
      model: async () => {
        asked++
        return "not json"
      }
    })
    estimator.request({ id: "none", kind: "delegate", key: "delegate", subject: "x", startedAt: 0 })
    await estimator.idle()
    expect(estimator.get("none")).toBeUndefined()
    expect(estimator.ledger.failure("none")).toMatchObject({
      method: "model",
      reason: "unusable-answer",
      message: "not json"
    })
    // Every workspace change reconciles; a failed answer must not call the model again.
    estimator.request({ id: "none", kind: "delegate", key: "delegate", subject: "x", startedAt: 0 })
    await estimator.idle()
    expect(asked).toBe(1)
    estimator.settle("none", { ms: 8 * minute, tokens: 100 }, "done")
    estimator.request({ id: "next", kind: "delegate", key: "delegate", subject: "y", startedAt: 0 })
    await estimator.idle()
    expect(estimator.get("next")).toMatchObject({ method: "class", ms: 8 * minute, tokens: 100 })
    expect(asked).toBe(2)
    // Both failures are on record, and no toast reports them.
    expect(estimator.ledger.failure("next")?.reason).toBe("unusable-answer")
  })

  it("records failed flow and delegated estimates in the ledger", async () => {
    const estimator = new Estimate.Estimator({
      ledger: new Improve.Ledger(undefined),
      model: async () => {
        throw new Error("no key")
      }
    })
    estimator.request({ id: "sum-1", kind: "flow", key: "flow:sum", subject: "sum", startedAt: 0 })
    await estimator.idle()
    // Recorded for the eval log, never toasted over the run's form.
    expect(estimator.ledger.failure("sum-1")).toMatchObject({ kind: "flow", reason: "model-error", message: "no key" })
    estimator.request({ id: "fix", kind: "delegate", key: "delegate", subject: "fix", startedAt: 0 })
    await estimator.idle()
    expect(estimator.ledger.failure("fix")).toMatchObject({
      kind: "delegate",
      reason: "model-error",
      message: "no key"
    })
  })

  it("records a model error with its message, so a class fallback is never mistaken for no model", async () => {
    const file = join(scratch(), "estimates.jsonl")
    const ledger = new Improve.Ledger(file)
    ledger.observe({
      id: "old",
      kind: "delegate",
      key: "delegate",
      subject: "old",
      at: 0,
      outcome: "done",
      actual: { ms: 5 * minute }
    })
    const estimator = new Estimate.Estimator({
      ledger,
      model: async () => {
        throw new Error("The ChatGPT-subscription backend rejects max_output_tokens")
      }
    })
    estimator.request({ id: "new", kind: "delegate", key: "delegate", subject: "new", startedAt: 0 })
    await estimator.idle()
    expect(estimator.get("new")).toMatchObject({ method: "class", ms: 5 * minute })
    const eta = estimator.eta([{ id: "new", title: "new", status: "running", startedAt: 0 }], minute)
    expect(eta.tasks[0]).toMatchObject({
      method: "class",
      failure: "model model-error: The ChatGPT-subscription backend rejects max_output_tokens"
    })
    // A reload keeps the failure and does not ask the failed model again.
    let asked = 0
    const reloaded = new Estimate.Estimator({ ledger: new Improve.Ledger(file), model: async () => (asked++, "{}") })
    expect(reloaded.ledger.failure("new")?.reason).toBe("model-error")
    reloaded.request({ id: "new", kind: "delegate", key: "delegate", subject: "new", startedAt: 0 })
    await reloaded.idle()
    expect(asked).toBe(0)
    // Without a model there is no failure: the class median is the method.
    const plain = new Estimate.Estimator({ ledger: new Improve.Ledger(file) })
    plain.request({ id: "other", kind: "delegate", key: "delegate", subject: "other", startedAt: 0 })
    expect(plain.ledger.failure("other")).toBeUndefined()
  })

  it("says once that the eval log cannot be written, and keeps estimating in memory", () => {
    const blocker = join(scratch(), "file")
    writeFileSync(blocker, "")
    const errors: Array<unknown> = []
    const ledger = new Improve.Ledger(join(blocker, "evals", "estimates.jsonl"), {
      onWriteError: (error) => errors.push(error)
    })
    const estimator = new Estimate.Estimator({ ledger })
    for (const index of [0, 1, 2]) {
      estimator.request({ id: `r${index}`, kind: "flow", key: "flow:deploy", subject: "deploy", startedAt: 0 })
      estimator.settle(`r${index}`, { ms: 10 * minute }, "done")
    }
    expect(errors).toHaveLength(1)
    expect(estimator.request({ id: "r3", kind: "flow", key: "flow:deploy", subject: "deploy", startedAt: 0 }))
      .toMatchObject({ method: "history", ms: 10 * minute })
  })

  it("shows the model the most similar past tasks, and only its own estimates and errors", () => {
    const ledger = new Improve.Ledger(undefined)
    const past = (id: string, subject: string, method: string, ms: number, actual: number, at: number) => {
      ledger.predict({ id, kind: "delegate", key: "delegate", method, subject, at, raw: { ms: ms * minute } })
      ledger.observe({
        id,
        kind: "delegate",
        key: "delegate",
        subject,
        at,
        outcome: "done",
        actual: { ms: actual * minute }
      })
    }
    past("scroll", "Fix transcript scrolling in the TUI", "model", 10, 20, 0)
    // Newer, but about something else: 13 of them push the scroll task out of a most-recent window.
    for (let index = 0; index < 13; index++) past(`d${index}`, `Update docs page ${index}`, "class", 1, 100, 10 + index)
    const text = Estimate.prompt({
      id: "n",
      kind: "delegate",
      key: "delegate",
      subject: "Fix scrolling up in the transcript",
      startedAt: 0
    }, ledger)
    expect(text).toContain("Fix transcript scrolling in the TUI | estimated 10m, took 20m")
    // A class estimate is not the model's, so it is shown as the actual only.
    expect(text).toMatch(/Update docs page \d+ \| took 1h40m/)
    expect(text).not.toMatch(/estimated 1m/)
    // One scored model estimate: 2x low. The class misses (100x) are not the model's error.
    expect(text).toContain("median of 1): time 2.00x")
  })

  it("tracks worker tabs: predicts on request and observes tokens from the transcript on settle", () => {
    const dir = scratch()
    const estimator = new Estimate.Estimator({ ledger: new Improve.Ledger(undefined) })
    const done = worker(dir, "old", "Fix the status bug", 30 * minute, 100_000)
    estimator.tabs([tab(done, { id: "old", status: "done", startedAt: 0, endedAt: 30 * minute })])
    expect(estimator.ledger.observation(`tab:${done}`)?.actual).toEqual({ ms: 30 * minute, tokens: 200_000 })

    const running = join(dir, "running.jsonl")
    estimator.tabs([tab(running, { startedAt: 1_000 })])
    expect(estimator.get(`tab:${running}`)).toMatchObject({ method: "class", ms: 30 * minute, tokens: 200_000 })
  })

  it("measures each turn of a transcript, not the idle time between turns", () => {
    const records: Array<Session.Record> = [
      { type: "user", at: 0, text: "first" },
      { type: "outcome", at: 2 * minute, prompt: "first", outcome: { _tag: "done", answer: "ok" } },
      // An hour idle, then a follow-up.
      { type: "user", at: 62 * minute, text: "second" },
      { type: "outcome", at: 65 * minute, prompt: "second", outcome: { _tag: "done", answer: "ok" } }
    ]
    expect(Estimate.worked(records)).toBe(5 * minute)
    expect(Estimate.worked(records.slice(0, 1))).toBeUndefined()

    const dir = scratch()
    writeFileSync(
      join(dir, "w.jsonl"),
      [{ type: "session", version: 1, id: "w", cwd: dir, createdAt: 0 }, ...records]
        .map((record) => JSON.stringify(record)).join("\n") + "\n"
    )
    const estimator = new Estimate.Estimator({ ledger: new Improve.Ledger(undefined) })
    estimator.seed(dir)
    expect(estimator.ledger.observations()[0]?.actual.ms).toBe(5 * minute)
  })

  it("does not count a queued tab's wait as work, and plans queued ETAs onto free seats", () => {
    const dir = scratch()
    const estimator = new Estimate.Estimator({ ledger: new Improve.Ledger(undefined) })
    // Requested at 0, queued for 20 minutes, worked 10.
    const done = worker(dir, "old", "Old task", 10 * minute, 1_000)
    estimator.tabs([
      tab(done, { id: "old", status: "done", startedAt: 0, launchedAt: 20 * minute, endedAt: 30 * minute })
    ])
    expect(estimator.ledger.observation(`tab:${done}`)?.actual.ms).toBe(10 * minute)

    const tabs = ["a", "b", "c", "d"].map((id, index) =>
      tab(join(dir, `${id}.jsonl`), {
        id,
        startedAt: index,
        ...(id === "d" ? { status: "queued" as const } : { launchedAt: index * minute })
      })
    )
    estimator.tabs(tabs)
    const eta = estimator.eta(Estimate.active(tabs, []), 4 * minute, 3)
    // a, b, c run 10 minutes each from launch at 0, 1, 2; d takes a's seat when it frees in 6 minutes.
    expect(eta.tasks.map((task) => task.remainingMinutes)).toEqual([6, 7, 8, 16])
    expect(eta.tasks[3]).toMatchObject({ id: "d", status: "queued", elapsedMinutes: 0, overdue: false })
    expect(eta.allDoneInMinutes).toBe(16)
  })

  it("plans queued flow runs onto flow seats, apart from worker seats", () => {
    const estimator = new Estimate.Estimator({ ledger: new Improve.Ledger(undefined) })
    estimator.ledger.observe({
      id: "p",
      kind: "flow",
      key: "flow:review",
      subject: "review",
      at: 0,
      outcome: "done",
      actual: { ms: 10 * minute }
    })
    const run = (id: string, status: Flows.Run["status"], launchedAt?: number): Flows.Run => ({
      id,
      flow: "review",
      by: "user",
      input: {},
      requested: "{}",
      status,
      startedAt: 0,
      ...(launchedAt === undefined ? {} : { launchedAt })
    })
    const runs = [run("a", "running", 0), run("b", "running", 0), run("c", "running", 0), run("d", "queued")]
    estimator.flows(runs)
    // A queued worker tab must not take a flow seat.
    const eta = estimator.eta(Estimate.active([], runs), 4 * minute, 3)
    expect(eta.tasks.map((task) => task.remainingMinutes)).toEqual([6, 6, 6, 16])
  })

  it("estimates and scores each attempt of a retried flow run on its own clock", async () => {
    const tick = () => new Promise((resolve) => setTimeout(resolve, 0))
    let settle = (_: Flows.Settled) => {}
    const port: Flows.Port = {
      discover: async () => [{
        name: "review",
        description: "Review",
        modelInvocable: true,
        kind: "module",
        flows: [],
        capabilities: [],
        path: "flows/review/flow.ts"
      }],
      input: async () => undefined,
      body: async () => Promise.reject(new Error("review is a module flow")),
      plan: async () => ({ all: false, raw: {} }),
      start: async () => "run-2",
      resume: async (runId) => ({ runId }),
      watch: () => ({
        done: new Promise((resolve) => {
          settle = resolve
        }),
        close: () => {}
      }),
      events: async () => [],
      cancel: async () => {},
      dispose: async () => {}
    }
    const base = { flow: "review", by: "user" as const, input: {}, requested: "{}" }
    const runs = new Flows.FlowRuns({
      port,
      persist: () => {},
      // A run interrupted by a restart, requested long ago.
      restored: [{ ...base, id: "r1", status: "running", runId: "run-9", startedAt: 1 }]
    })
    const estimator = new Estimate.Estimator({ ledger: new Improve.Ledger(undefined) })
    estimator.ledger.observe({
      id: "past",
      kind: "flow",
      key: "flow:review",
      subject: "review",
      at: 0,
      outcome: "done",
      actual: { ms: 50 }
    })
    estimator.flows(runs.snapshot())
    const first = Estimate.runId(runs.get("r1")!)
    expect(estimator.ledger.observation(first)?.outcome).toBe("failed")

    runs.retry("r1")
    await tick()
    const second = runs.get("r1")!
    expect(second.attempt).toBe(2)
    expect(Estimate.runId(second)).not.toBe(first)
    estimator.flows(runs.snapshot())
    expect(estimator.get(Estimate.runId(second))).toMatchObject({ method: "history" })
    settle({ kind: "done", answer: "ok" })
    await tick()
    estimator.flows(runs.snapshot())
    const scored = estimator.ledger.scored()
    expect(scored.map((each) => each.observation.id)).toEqual([Estimate.runId(second)])
    // Timed from the retry, not from the original request at t=1.
    expect(scored[0]!.observation.actual.ms!).toBeLessThan(5_000)
    await runs.dispose()
  })

  it("seeds delegate history from worker transcripts already on disk", () => {
    const dir = scratch()
    mkdirSync(dir, { recursive: true })
    worker(dir, "a", "First task", 10 * minute, 5_000)
    worker(dir, "b", "Second task", 30 * minute, 5_000)
    const estimator = new Estimate.Estimator({ ledger: new Improve.Ledger(undefined) })
    estimator.seed(dir)
    estimator.seed(dir)
    expect(estimator.ledger.observations()).toHaveLength(2)
    expect(estimator.ledger.observations()[0]?.subject).toMatch(/task/)
  })

  it("answers ETA for every active task, including one past its estimate", () => {
    const estimator = new Estimate.Estimator({ ledger: new Improve.Ledger(undefined) })
    estimator.request({ id: "d0", kind: "flow", key: "flow:deploy", subject: "deploy", startedAt: 0 })
    estimator.settle("d0", { ms: 10 * minute }, "done")
    estimator.request({ id: "a", kind: "flow", key: "flow:deploy", subject: "deploy", startedAt: 0 })
    estimator.request({ id: "b", kind: "flow", key: "flow:deploy", subject: "deploy", startedAt: 0 })
    const eta = estimator.eta([
      { id: "a", title: "deploy", status: "running", startedAt: 6 * minute },
      { id: "b", title: "deploy", status: "running", startedAt: -15 * minute },
      { id: "c", title: "novel", status: "requested", startedAt: 9 * minute }
    ], 10 * minute)
    expect(eta.tasks[0]).toMatchObject({
      id: "a",
      elapsedMinutes: 4,
      estimateMinutes: 10,
      remainingMinutes: 6,
      overdue: false
    })
    expect(eta.tasks[1]).toMatchObject({ id: "b", overdue: true })
    expect(eta.tasks[2]).toMatchObject({ id: "c", estimateMinutes: null })
    expect(eta.allDoneInMinutes).toBeNull()
    // Plain JSON: no undefined, no functions, round-trips exactly.
    expect(JSON.parse(JSON.stringify(eta))).toEqual(eta)
    const known = estimator.eta([{ id: "a", title: "deploy", status: "running", startedAt: 6 * minute }], 10 * minute)
    expect(known.allDoneInMinutes).toBe(6)
  })

  it("labels a running tab with its remaining time and token estimate", () => {
    expect(
      Estimate.label(
        { ms: 11 * minute, tokens: 250_000, lowMs: 0, highMs: 20 * minute, method: "model", basis: 0 },
        0,
        4 * minute
      )
    )
      .toBe("~7m·250k")
    expect(
      Estimate.label({ ms: 11 * minute, lowMs: 0, highMs: 12 * minute, method: "history", basis: 3 }, 0, 30 * minute)
    )
      .toBe("late")
    expect(Estimate.label({ ms: 30_000, lowMs: 0, highMs: 60_000, method: "history", basis: 3 }, 0, 0)).toBe("~30s")
    expect(Estimate.label(undefined, 0, 0)).toBe("")
  })

  it("exposes tab.eta as a runtime flow only with an eta port", async () => {
    const bindings = await Effect.runPromise(
      Runtime.source({
        publish: () => {},
        eta: () => ({ tasks: [], allDoneInMinutes: 0 })
      }).bindings()
    )
    const eta = bindings.find((binding) => binding.descriptor.name === "tab.eta")!
    expect(await Effect.runPromise(eta.run({ input: {} } as Parameters<typeof eta.run>[0]))).toMatchObject({
      outcome: "success",
      value: { tasks: [], allDoneInMinutes: 0 }
    })
    const without = await Effect.runPromise(Runtime.source({ publish: () => {} }).bindings())
    expect(without.some((binding) => binding.descriptor.name === "tab.eta")).toBe(false)
  })
})
