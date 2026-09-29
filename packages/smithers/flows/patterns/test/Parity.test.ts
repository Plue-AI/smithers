/**
 * Every dual-form pattern's declared flow and its `run` Effect settle to the
 * same outcome on the same scripted members.
 *
 * The table below is the one place a pattern's two engines are compared. The
 * gate at the bottom fails for any exported namespace that has both forms and
 * no row here, so a new dual-form pattern cannot ship without parity cases.
 *
 * Run-only options (Kanban `until`/`maxIterations`, DriftDetector `alertIf`)
 * have no declared counterpart; their rows use the shared option set only and
 * `OptionsParity.test.ts` names the asymmetry.
 */
import { Graph } from "@smthrs/flow"
import { describe, expect, it } from "vitest"
import * as CheckSuite from "../src/CheckSuite.ts"
import * as Debate from "../src/Debate.ts"
import * as DelegationChain from "../src/DelegationChain.ts"
import * as DriftDetector from "../src/DriftDetector.ts"
import * as Escalation from "../src/Escalation.ts"
import * as Patterns from "../src/index.ts"
import * as Intervene from "../src/Intervene.ts"
import * as Kanban from "../src/Kanban.ts"
import * as Loop from "../src/Loop.ts"
import * as MapReduce from "../src/MapReduce.ts"
import * as MergeQueue from "../src/MergeQueue.ts"
import * as Optimizer from "../src/Optimizer.ts"
import * as Panel from "../src/Panel.ts"
import * as ReviewLoop from "../src/ReviewLoop.ts"
import * as Runbook from "../src/Runbook.ts"
import * as Saga from "../src/Saga.ts"
import * as ScanFixVerify from "../src/ScanFixVerify.ts"
import * as Sidecar from "../src/Sidecar.ts"
import * as Supervisor from "../src/Supervisor.ts"
import * as Trellis from "../src/Trellis.ts"
import * as TryCatchFinally from "../src/TryCatchFinally.ts"
import { approval, check, fail, flow, type Pattern, roles, scripted, settleRun } from "./Parity.ts"

const drift: Pattern<{ readonly alerts: boolean }> = {
  make: (members, { alerts }) =>
    DriftDetector.make({
      capture: members.capture!,
      compare: members.compare!,
      ...(alerts ? { alert: members.alert! } : {}),
      baseline: { version: 1 }
    }),
  run: (effects, input, { alerts }) =>
    DriftDetector.run(input, {
      capture: effects.capture!,
      compare: effects.compare!,
      ...(alerts ? { alert: effects.alert! } : {}),
      baseline: { version: 1 }
    }),
  cases: [true, false].flatMap((moved) =>
    [true, false].map((alerts) => ({
      name: `drift-${moved}-alerts-${alerts}`,
      input: "config",
      options: { alerts },
      script: {
        capture: ({ input }: { readonly input: string }) => ({ version: moved ? 2 : 1, of: input }),
        compare: ({ snapshot }: { readonly snapshot: { readonly version: number } }) => ({
          drifted: snapshot.version !== 1
        }),
        alert: ({ comparison }: { readonly comparison: unknown }) => ({ paged: comparison })
      },
      expected: {
        snapshot: { version: moved ? 2 : 1, of: "config" },
        comparison: { drifted: moved },
        drifted: moved,
        ...(moved && alerts ? { alert: { paged: { drifted: true } } } : {})
      },
      ordered: true
    }))
  )
}

interface OptimizerCase {
  readonly targetScore?: number
  readonly maxIterations: number
  readonly onMaxReached?: "fail" | "return-last"
}

const scores = (values: ReadonlyArray<number>) => ({
  generate: ({ iteration }: { readonly iteration: number }) => `candidate-${iteration}`,
  evaluate: ({ iteration }: { readonly iteration: number }) => ({
    score: values[iteration - 1]!,
    feedback: `feedback-${iteration}`
  })
})

const optimizer: Pattern<OptimizerCase> = {
  make: (members, options) => Optimizer.make({ generate: members.generate!, evaluate: members.evaluate!, ...options }),
  run: (effects, input, options) =>
    Optimizer.run(input, { generate: effects.generate!, evaluate: effects.evaluate!, ...options }),
  cases: [
    {
      name: "optimizer-target",
      input: "prompt",
      options: { targetScore: 0.9, maxIterations: 3, onMaxReached: "fail" },
      script: scores([1, 0, 0]),
      expected: {
        best: { candidate: "candidate-1", score: 1, feedback: "feedback-1", iteration: 1 },
        iterations: 1,
        converged: true
      },
      ordered: true
    },
    {
      name: "optimizer-best-not-last",
      input: "prompt",
      options: { maxIterations: 3 },
      script: scores([0.2, 0.7, 0.4]),
      expected: {
        best: { candidate: "candidate-2", score: 0.7, feedback: "feedback-2", iteration: 2 },
        iterations: 3,
        converged: false
      },
      ordered: true
    },
    {
      name: "optimizer-exhausted",
      input: "prompt",
      options: { targetScore: 0.9, maxIterations: 2, onMaxReached: "fail" },
      script: scores([0.2, 0.7]),
      expected: {
        failed: { code: "exhausted", message: "Optimizer reached its bound of 2 iterations below 0.9" }
      }
    },
    {
      name: "optimizer-member-fails",
      input: "prompt",
      options: { maxIterations: 3 },
      script: { ...scores([0.1, 0.2, 0.3]), evaluate: () => fail({ code: "judge_down", message: "judge down" }) },
      expected: { failed: { code: "judge_down", message: "judge down" } }
    }
  ]
}

const debate: Pattern<{ readonly rounds: number }> = {
  make: (m, { rounds }) => Debate.make({ proponent: m.proponent!, opponent: m.opponent!, judge: m.judge!, rounds }),
  run: (e, input, { rounds }) =>
    Debate.run(input, { proponent: e.proponent!, opponent: e.opponent!, judge: e.judge!, rounds }),
  cases: [1, 2].map((rounds) => ({
    name: `debate-${rounds}`,
    input: "topic",
    options: { rounds },
    script: {
      proponent: ({ transcript }: { readonly transcript: ReadonlyArray<unknown> }) => `p${transcript.length}`,
      opponent: ({ proponent }: { readonly proponent: string }) => `o:${proponent}`,
      judge: ({ transcript }: { readonly transcript: unknown }) => ({ verdict: transcript })
    },
    expected: {
      verdict: Array.from({ length: rounds }, (_, index) => ({ proponent: `p${index}`, opponent: `o:p${index}` }))
    },
    ordered: true
  }))
}

const panelScript = {
  a: ({ prompt }: { readonly prompt: string }) => `a:${prompt}`,
  b: ({ prompt }: { readonly prompt: string }) => `b:${prompt}`,
  moderator: ({ opinions }: { readonly opinions: unknown }) => ({ summary: opinions })
}

const panel: Pattern<{ readonly concurrency?: number }> = {
  make: (m, options) => Panel.make({ panelists: { a: m.a!, b: m.b! }, moderator: m.moderator!, ...options }),
  run: (e, input, options) =>
    Panel.run(input, { panelists: { a: e.a!, b: e.b! }, moderator: e.moderator!, ...options }),
  cases: [
    {
      name: "panel-unbounded",
      input: { prompt: "q" },
      options: {},
      script: panelScript,
      expected: { summary: { a: "a:q", b: "b:q" } }
    },
    {
      name: "panel-bounded",
      input: { prompt: "q" },
      options: { concurrency: 1 },
      script: panelScript,
      expected: { summary: { a: "a:q", b: "b:q" } }
    },
    {
      name: "panel-panelist-fails",
      input: { prompt: "q" },
      options: {},
      script: { ...panelScript, b: () => fail({ code: "seat_down", message: "b down" }) },
      expected: { failed: { code: "seat_down", message: "b down" } }
    }
  ]
}

const mapReduceScript = {
  map: ({ shard }: { readonly shard: number }) => shard * 10,
  reduce: ({ mapped }: { readonly mapped: ReadonlyArray<number> }) => ({ total: mapped.reduce((a, b) => a + b, 0) })
}

const mapReduce: Pattern<{ readonly concurrency: number; readonly onEmpty: MapReduce.OnEmpty }> = {
  make: (m, options) => MapReduce.make({ map: m.map!, reduce: m.reduce!, ...options }),
  run: (e, input, options) => MapReduce.run(input, { map: e.map!, reduce: e.reduce!, ...options }),
  cases: [
    {
      name: "mapreduce-shards",
      payload: { shards: [1, 2, 3] },
      input: { shards: [1, 2, 3] },
      options: { concurrency: 2, onEmpty: "fail" },
      script: mapReduceScript,
      expected: { total: 60 }
    },
    ...(["reduce", "succeed", "fail"] as const).map((onEmpty) => ({
      name: `mapreduce-empty-${onEmpty}`,
      payload: { shards: [] },
      input: { shards: [] },
      options: { concurrency: 1, onEmpty },
      script: mapReduceScript
    }))
  ]
}

const checkScript = {
  lint: () => ({ ok: true }),
  types: () => ({ ok: false }),
  test: () => fail({ code: "test_crashed", message: "test crashed" })
}

const checkSuite: Pattern<{ readonly strategy: CheckSuite.Strategy; readonly continueOnFail: boolean }> = {
  make: (m, options) =>
    CheckSuite.make({ checks: { lint: m.lint!, types: m.types!, test: m.test! }, concurrency: 2, ...options }),
  run: (e, input, options) =>
    CheckSuite.run(input, { checks: { lint: e.lint!, types: e.types!, test: e.test! }, concurrency: 2, ...options }),
  cases: [
    ...(["all-pass", "majority", "any-pass"] as const).map((strategy) => ({
      name: `checksuite-tolerant-${strategy}`,
      input: "head",
      options: { strategy, continueOnFail: true },
      script: checkScript
    })),
    {
      name: "checksuite-fail-fast",
      input: "head",
      options: { strategy: "all-pass", continueOnFail: false },
      script: checkScript,
      expected: { failed: { code: "test_crashed", message: "test crashed" } }
    },
    {
      name: "checksuite-all-pass",
      input: "head",
      options: { strategy: "all-pass", continueOnFail: false },
      script: { ...checkScript, types: () => ({ ok: true }), test: () => true },
      expected: { passed: ["lint", "types", "test"], failed: [], errors: {}, strategy: "all-pass", verdict: true }
    }
  ]
}

const reviewScript = (approveAt: string) => ({
  produce: () => "draft-0",
  review: ({ output }: { readonly output: string }) => ({ approved: output === approveAt, of: output }),
  revise: ({ round }: { readonly round: number }) => `draft-${round}`
})

const reviewLoop: Pattern<{ readonly maxRounds: number }> = {
  make: (m, { maxRounds }) => ReviewLoop.make({ produce: m.produce!, review: m.review!, revise: m.revise!, maxRounds }),
  run: (e, input, { maxRounds }) =>
    ReviewLoop.run(input, {
      produce: (value) => e.produce!({ input: value }),
      review: (output, round) => e.review!({ output, round }),
      revise: e.revise!,
      maxRounds
    }),
  cases: [
    {
      name: "reviewloop-approved",
      input: "brief",
      options: { maxRounds: 3 },
      script: reviewScript("draft-2"),
      expected: { _tag: "Approved", output: "draft-2" },
      ordered: true
    },
    {
      name: "reviewloop-exhausted",
      input: "brief",
      options: { maxRounds: 2 },
      script: reviewScript("draft-9"),
      expected: { _tag: "Exhausted", output: "draft-1", review: { approved: false, of: "draft-1" } },
      ordered: true
    }
  ]
}

interface EscalationCase {
  readonly accept: boolean
  readonly fallback: boolean
  readonly escalateIf: boolean
}

const escalation: Pattern<EscalationCase> = {
  make: (m, o) =>
    Escalation.make({
      rungs: [o.escalateIf ? { flow: m.cheap!, escalateIf: m.escalateIf! } : m.cheap!, m.strong!],
      ...(o.accept ? { accept: m.accept! } : {}),
      ...(o.fallback ? { fallback: m.human! } : {})
    }),
  run: (e, input, o) =>
    Escalation.run(input, {
      rungs: [
        o.escalateIf
          ? {
            run: (value: unknown) => e.cheap!({ input: value }),
            escalateIf: (result: unknown, level: number) => e.escalateIf!({ result, level })
          }
          : (value: unknown) => e.cheap!({ input: value }),
        (value: unknown) => e.strong!({ input: value })
      ],
      ...(o.accept ? { accept: (result: unknown) => e.accept!({ result }) } : {}),
      ...(o.fallback ? { fallback: (value: unknown) => e.human!({ input: value }) } : {})
    }),
  cases: [
    ...[true, false].flatMap((strongOk) =>
      [true, false].flatMap((accept) =>
        [true, false].map((fallback) => ({
          name: `escalation-strong-${strongOk}-accept-${accept}-fallback-${fallback}`,
          input: "ticket",
          options: { accept, fallback, escalateIf: false },
          script: {
            cheap: () => ({ ok: false, by: "cheap" }),
            strong: () => ({ ok: strongOk, by: "strong" }),
            accept: ({ result }: { readonly result: { readonly ok: boolean } }) => result.ok,
            human: () => ({ ok: true, by: "human" })
          }
        }))
      )
    ),
    ...[true, false].map((settle) => ({
      name: `escalation-escalateif-${settle}`,
      input: "ticket",
      options: { accept: true, fallback: false, escalateIf: true },
      script: {
        cheap: () => ({ ok: false, by: "cheap" }),
        strong: () => ({ ok: true, by: "strong" }),
        escalateIf: () => !settle,
        accept: () => true
      }
    }))
  ]
}

interface LoopCase {
  readonly until: boolean
  readonly maxIterations: number
  readonly onMaxReached?: Loop.OnMaxReached
}

const loopScript = (doneAt: number) => ({
  body: ({ iteration }: { readonly iteration: number }) => ({ done: iteration === doneAt, n: iteration }),
  until: ({ value }: { readonly value: { readonly n: number } }) => value.n === doneAt
})

const loop: Pattern<LoopCase> = {
  make: (m, { until, ...o }) => Loop.make({ body: m.body!, ...(until ? { until: m.until! } : {}), ...o }),
  run: (e, input, { until, ...o }) => Loop.run(input, { body: e.body!, ...(until ? { until: e.until! } : {}), ...o }),
  cases: [true, false].flatMap((until) => [
    {
      name: `loop-until-${until}-settles`,
      input: "task",
      options: { until, maxIterations: 3 },
      script: loopScript(2),
      expected: { value: { done: true, n: 2 }, iterations: 2, exhausted: false },
      ordered: true
    },
    {
      name: `loop-until-${until}-return-last`,
      input: "task",
      options: { until, maxIterations: 2 },
      script: loopScript(9),
      expected: { value: { done: false, n: 2 }, iterations: 2, exhausted: true },
      ordered: true
    },
    {
      name: `loop-until-${until}-fail`,
      input: "task",
      options: { until, maxIterations: 2, onMaxReached: "fail" as const },
      script: loopScript(9),
      expected: { failed: { code: "exhausted", message: "Loop reached its bound of 2 iterations unsatisfied" } },
      ordered: true
    }
  ])
}

const interveneScript = (approval: unknown) => ({
  read: () => ({ files: 2 }),
  propose: ({ context }: { readonly context: unknown }) => ({ change: context }),
  apply: ({ proposal }: { readonly proposal: unknown }) => ({ applied: proposal }),
  report: ({ applied, dryRun }: { readonly applied?: unknown; readonly dryRun: boolean }) => ({
    applied: applied ?? null,
    dryRun
  }),
  approval: () => approval
})

const intervene: Pattern<{ readonly dryRun: boolean; readonly gated: boolean }> = {
  make: (m, { dryRun, gated }) =>
    Intervene.make({
      read: m.read!,
      propose: m.propose!,
      apply: flow("apply"),
      report: m.report!,
      dryRun,
      ...(gated ? { approval: approval("approval") } : {})
    }),
  run: (e, input, { dryRun, gated }) =>
    Intervene.run(input, {
      read: e.read!,
      propose: e.propose!,
      apply: e.apply!,
      report: e.report!,
      dryRun,
      ...(gated ? { approval: e.approval! } : {})
    }),
  cases: [
    ...[true, false].map((dryRun) => ({
      name: `intervene-dry-${dryRun}`,
      input: "repo",
      options: { dryRun, gated: false },
      script: interveneScript("approved"),
      ordered: true
    })),
    {
      name: "intervene-approved",
      input: "repo",
      options: { dryRun: false, gated: true },
      script: interveneScript("approved"),
      expected: { applied: { applied: { change: { files: 2 } } }, dryRun: false },
      ordered: true
    }
  ]
}

interface SagaCase {
  readonly onFailure: Saga.OnFailure
}

const sagaScript = (failing: string | undefined, undoFails: string | undefined) => ({
  a: () => "a-done",
  b: () => failing === "b" ? fail({ code: "b_failed", message: "b failed" }) : "b-done",
  c: () => failing === "c" ? fail({ code: "c_failed", message: "c failed" }) : "c-done",
  undoA: () => undoFails === "a" ? fail({ code: "undo_a", message: "undo a failed" }) : "a-undone",
  undoB: () => "b-undone",
  undoC: () => "c-undone"
})

const saga: Pattern<SagaCase> = {
  make: (m, o) =>
    Saga.make({
      steps: [
        { id: "a", action: m.a!, compensation: m.undoA! },
        { id: "b", action: m.b!, compensation: m.undoB! },
        { id: "c", action: m.c!, compensation: m.undoC! }
      ],
      ...o
    }),
  run: (e, input, o) =>
    Saga.run(input, {
      steps: [
        { id: "a", action: e.a!, compensation: e.undoA! },
        { id: "b", action: e.b!, compensation: e.undoB! },
        { id: "c", action: e.c!, compensation: e.undoC! }
      ],
      ...o
    }),
  cases: (["compensate", "compensate-and-fail", "fail"] as const).flatMap((onFailure) => [
    {
      name: `saga-${onFailure}-completes`,
      input: "order",
      options: { onFailure },
      script: sagaScript(undefined, undefined),
      expected: { _tag: "Completed", values: { a: "a-done", b: "b-done", c: "c-done" } }
    },
    {
      name: `saga-${onFailure}-c-fails`,
      input: "order",
      options: { onFailure },
      script: sagaScript("c", undefined)
    },
    {
      name: `saga-${onFailure}-undo-fails`,
      input: "order",
      options: { onFailure },
      script: sagaScript("c", "a")
    }
  ])
}

interface TryCase {
  readonly handles: boolean
  readonly finalizes: boolean
}

const tryScript = (tryFails: boolean, catchFails: boolean, finallyFails: boolean) => ({
  try: () => tryFails ? fail({ code: "try_failed", message: "try failed" }) : "tried",
  catch: ({ error }: { readonly error: unknown }) =>
    catchFails ? fail({ code: "catch_failed", message: "catch failed" }) : { recovered: error },
  finally: () => finallyFails ? fail({ code: "finally_failed", message: "finally failed" }) : "cleaned"
})

const tryCatchFinally: Pattern<TryCase> = {
  make: (m, o) =>
    TryCatchFinally.make({
      try: m.try!,
      ...(o.handles ? { catch: m.catch! } : {}),
      ...(o.finalizes ? { finally: m.finally! } : {})
    }),
  run: (e, input, o) =>
    TryCatchFinally.run(input, {
      try: e.try!,
      ...(o.handles ? { catch: (error: unknown, value: unknown) => e.catch!({ error, input: value }) } : {}),
      ...(o.finalizes ? { finally: (value: unknown) => e.finally!({ input: value }) } : {})
    }),
  cases: [true, false].flatMap((tryFails) =>
    [true, false].flatMap((handles) =>
      [true, false].flatMap((finallyFails) => ({
        name: `try-fails-${tryFails}-handles-${handles}-finally-fails-${finallyFails}`,
        input: { prompt: "x" },
        options: { handles, finalizes: true },
        script: tryScript(tryFails, false, finallyFails)
      }))
    )
  )
}

const sidecarScript = (shadowFails: boolean) => ({
  primary: ({ prompt }: { readonly prompt: string }) => `primary:${prompt}`,
  shadow: ({ prompt }: { readonly prompt: string }) =>
    shadowFails ? fail({ code: "shadow_down", message: "shadow down" }) : `shadow:${prompt}`,
  score: () => ({ primary: 0.5, shadow: 0.75 })
})

const sidecar: Pattern<{ readonly scores: boolean }> = {
  make: (m, { scores }) =>
    Sidecar.make({ primary: m.primary!, shadow: m.shadow!, ...(scores ? { score: m.score! } : {}) }),
  run: (e, input, { scores }) =>
    Sidecar.run(input, { primary: e.primary!, shadow: e.shadow!, ...(scores ? { score: e.score! } : {}) }),
  cases: [true, false].flatMap((scores) => [
    {
      name: `sidecar-scores-${scores}`,
      input: { prompt: "x" },
      options: { scores },
      script: sidecarScript(false)
    },
    {
      name: `sidecar-scores-${scores}-shadow-fails`,
      input: { prompt: "x" },
      options: { scores },
      script: sidecarScript(true),
      diverges: "a quarantined shadow carries its typed error when declared and its whole Cause in run",
      expected: { primary: "primary:x", shadow: { quarantined: true, cause: expect.anything() } },
      declared: {
        primary: "primary:x",
        shadow: { quarantined: true, error: { code: "shadow_down", message: "shadow down" } }
      }
    }
  ])
}

interface QueueCase {
  readonly concurrency: number
  readonly failurePolicy: MergeQueue.FailurePolicy
}

const queueScript = (failing: string | undefined) =>
  Object.fromEntries(
    ["m1", "m2", "m3"].map((id) => [
      id,
      ({ position }: { readonly position: number }) =>
        id === failing ? fail({ code: `${id}_conflict`, message: `${id} conflicts` }) : { merged: id, position }
    ])
  )

const mergeQueue: Pattern<QueueCase> = {
  make: (m, o) =>
    MergeQueue.make({
      members: [{ id: "m1", flow: m.m1! }, { id: "m2", flow: m.m2!, priority: 2000 }, { id: "m3", flow: m.m3! }],
      ...o
    }),
  run: (e, input, o) =>
    MergeQueue.run(input, {
      members: [{ id: "m1", run: e.m1! }, { id: "m2", run: e.m2!, priority: 2000 }, { id: "m3", run: e.m3! }],
      ...o
    }),
  cases: [
    { concurrency: 1, failurePolicy: "halt" as const },
    { concurrency: 1, failurePolicy: "quarantine" as const },
    { concurrency: 2, failurePolicy: "quarantine" as const }
  ].flatMap((options) =>
    [undefined, "m1"].map((failing) => ({
      name: `mergequeue-${options.concurrency}-${options.failurePolicy}-failing-${failing}`,
      input: "main",
      options,
      script: queueScript(failing)
    }))
  )
}

interface KanbanCase {
  readonly concurrency: number
  readonly completes: boolean
  readonly ships?: boolean
}

const kanbanItems = [{ id: "a" }, { id: "b" }]

const kanbanScript = (failing: string | undefined) => ({
  build: ({ item }: { readonly item: { readonly id: string } }) =>
    item.id === failing ? fail({ code: "build_failed", message: `${item.id} failed` }) : `built-${item.id}`,
  test: ({ item, previous }: { readonly item: { readonly id: string }; readonly previous: unknown }) => ({
    tested: item.id,
    previous
  }),
  ship: ({ item }: { readonly item: { readonly id: string } }) => `shipped-${item.id}`,
  done: ({ board }: { readonly board: unknown }) => ({ reported: board })
})

const kanban: Pattern<KanbanCase> = {
  make: (m, o) =>
    Kanban.make({
      columns: [
        { name: "build", flow: m.build! },
        { name: "test", flow: m.test! },
        ...(o.ships === true ? [{ name: "ship", flow: m.ship! }] : [])
      ],
      items: kanbanItems,
      concurrency: o.concurrency,
      ...(o.completes ? { onComplete: m.done! } : {})
    }),
  run: (e, _input, o) =>
    Kanban.run(kanbanItems, {
      columns: [
        { name: "build", run: e.build! },
        { name: "test", run: e.test! },
        ...(o.ships === true ? [{ name: "ship", run: e.ship! }] : [])
      ],
      concurrency: o.concurrency,
      ...(o.completes ? { onComplete: e.done! } : {})
    }),
  cases: [
    ...[1, 2].flatMap((concurrency) =>
      [true, false].flatMap((completes) =>
        [undefined, "a"].map((failing) => ({
          name: `kanban-${concurrency}-complete-${completes}-failing-${failing}`,
          input: "board",
          options: { concurrency, completes },
          script: kanbanScript(failing)
        }))
      )
    ),
    {
      name: "kanban-three-columns-rejected-first",
      input: "board",
      options: { concurrency: 2, completes: false, ships: true },
      script: kanbanScript("a"),
      expected: {
        board: { b: { build: "built-b", test: { tested: "b", previous: "built-b" }, ship: "shipped-b" } },
        completed: ["b"],
        failed: [{ id: "a", column: "build", error: { code: "build_failed", message: "a failed" } }],
        iterations: 1
      }
    }
  ]
}

const scanScript = (rounds: ReadonlyArray<ReadonlyArray<string>>) => ({
  scan: ({ iteration }: { readonly iteration: number }) => rounds[iteration - 1] ?? [],
  fix: ({ issue }: { readonly issue: string }) => `fixed ${issue}`,
  verify: ({ fixes, iteration }: { readonly fixes: unknown; readonly iteration: number }) => ({ fixes, iteration })
})

const scanFixVerify: Pattern<{ readonly maxRetries: number }> = {
  make: (m, { maxRetries }) =>
    ScanFixVerify.make({ scan: m.scan!, fix: m.fix!, verify: m.verify!, maxRetries, maxIssues: 3, concurrency: 3 }),
  run: (e, input, { maxRetries }) =>
    ScanFixVerify.run(input, { scan: e.scan!, fix: e.fix!, verify: e.verify!, maxRetries, concurrency: 3 }),
  cases: [
    { name: "sfv-clean-rescan", rounds: [["issue-a"], []] },
    { name: "sfv-clean-first", rounds: [] },
    { name: "sfv-bound", rounds: [["issue-a", "issue-b"], ["issue-b"]] }
  ].map(({ name, rounds }) => ({
    name,
    input: "repo",
    options: { maxRetries: 2 },
    script: scanScript(rounds)
  }))
}

const runbookScript = {
  s1: ({ step }: { readonly step: string }) => `${step}-ok`,
  s2: ({ previous }: { readonly previous: unknown }) => ({ after: previous }),
  s3: ({ elevated }: { readonly elevated?: boolean }) => ({ elevated: elevated ?? null }),
  approve: () => "approved"
}

const runbook: Pattern<Record<string, never>> = {
  make: (_m) =>
    Runbook.make({
      steps: [
        { id: "s1", flow: flow("s1"), risk: "safe" },
        { id: "s2", flow: flow("s2"), risk: "risky" },
        { id: "s3", flow: flow("s3"), risk: "critical" }
      ],
      approval: approval("approve"),
      onDeny: "fail"
    }),
  run: (e, input) =>
    Runbook.run(input, {
      steps: [
        { id: "s1", run: e.s1!, risk: "safe" },
        { id: "s2", run: e.s2!, risk: "risky" },
        { id: "s3", run: e.s3!, risk: "critical" }
      ],
      approve: e.approve!,
      onDeny: "fail"
    }),
  cases: [{ name: "runbook-approved", input: "deploy", options: {}, script: runbookScript }]
}

const supervisorTasks = [
  { id: "a", workerType: "coder" },
  { id: "b", workerType: "coder" },
  { id: "c", workerType: "tester" }
]

// Reviews by round: a review names the tasks to run again, or says it is done.
const supervisorScript = (reviews: ReadonlyArray<unknown>, failing: string | undefined) => ({
  plan: ({ input }: { readonly input: { readonly tasks: unknown } }) => ({ tasks: input.tasks }),
  coder: ({ task, round }: { readonly task: { readonly id: string }; readonly round: number }) =>
    task.id === failing && round === 1
      ? fail({ code: "worker_failed", message: `${task.id} failed` })
      : `${task.id}-coded-${round}`,
  tester: ({ task, round }: { readonly task: { readonly id: string }; readonly round: number }) =>
    `${task.id}-tested-${round}`,
  review: ({ round, results }: { readonly round: number; readonly results: unknown }) => ({
    ...(reviews[round - 1] as object),
    saw: results
  }),
  finalize: ({ rounds, results }: { readonly rounds: number; readonly results: unknown }) => ({ rounds, results })
})

const supervisor: Pattern<{ readonly maxRounds: number; readonly maxTasks: number; readonly concurrency: number }> = {
  make: (m, o) =>
    Supervisor.make({
      plan: m.plan!,
      workers: { coder: m.coder!, tester: m.tester! },
      review: m.review!,
      finalize: m.finalize!,
      ...o
    }),
  run: (e, input, o) =>
    Supervisor.run(input, {
      plan: (value: unknown) => e.plan!({ input: value }),
      worker: (args) => (args.task.workerType === "coder" ? e.coder! : e.tester!)(args),
      review: e.review!,
      finalize: e.finalize!,
      ...o
    }),
  cases: [1, 2].flatMap((concurrency) => [
    {
      name: `supervisor-${concurrency}-done-first-round`,
      input: { goal: "ship", tasks: supervisorTasks },
      options: { maxRounds: 3, maxTasks: 16, concurrency },
      script: supervisorScript([{ allDone: true }], undefined)
    },
    {
      name: `supervisor-${concurrency}-retries-the-failed-task`,
      input: { goal: "ship", tasks: supervisorTasks },
      options: { maxRounds: 3, maxTasks: 16, concurrency },
      script: supervisorScript([{ allDone: false, retriable: ["a"] }, { allDone: true }], "a")
    },
    {
      name: `supervisor-${concurrency}-exhausted-at-bound`,
      input: { goal: "ship", tasks: supervisorTasks },
      options: { maxRounds: 2, maxTasks: 16, concurrency },
      script: supervisorScript([{ retriable: ["a", "c"] }, { retriable: ["a"] }], undefined)
    },
    {
      name: `supervisor-${concurrency}-nothing-retriable`,
      input: { goal: "ship", tasks: supervisorTasks },
      options: { maxRounds: 3, maxTasks: 16, concurrency },
      script: supervisorScript([{ retriable: ["unknown"] }], "b")
    }
  ])
}

it("durable Supervisor requires input tasks even when the boss plans them", async () => {
  const forms = scripted({
    ...supervisorScript([{ allDone: true }], undefined),
    plan: () => ({ tasks: supervisorTasks })
  })
  const options = { maxRounds: 2, maxTasks: 16, concurrency: 1 }
  const input = { goal: "ship" }
  expect(() =>
    Graph.build(
      Supervisor.make({
        plan: forms.members.plan!,
        workers: { coder: forms.members.coder!, tester: forms.members.tester! },
        review: forms.members.review!,
        finalize: forms.members.finalize!,
        ...options
      }),
      { input }
    )
  ).toThrow(
    expect.objectContaining({ code: "invalid_input", message: "Supervisor input must contain a tasks array" })
  )
  expect(roles(forms.declaredTape)).toEqual([])

  const ran = await settleRun(supervisor.run(forms.effects, input, options))
  expect(ran).toMatchObject({ exhausted: false, rounds: 1 })
  expect(roles(forms.ranTape)).toEqual(["plan", "coder", "coder", "tester", "review", "finalize"])
})

const trellisScript = {
  author: () => ({ agent: { goal: "write" } }),
  leaf: ({ path }: { readonly path: string }) => `leaf:${path}`
}

const trellis: Pattern<Record<string, never>> = {
  make: (m) => Trellis.make({ author: m.author!, leaf: m.leaf!, envelope: { fuel: 2, depth: 2, fanout: 2 } }),
  run: (e, input) =>
    Trellis.run((input as { readonly prompt: string }).prompt, {
      author: e.author!,
      leaf: e.leaf!,
      envelope: { fuel: 2, depth: 2, fanout: 2 }
    }),
  cases: [{
    name: "trellis-one-leaf",
    input: { prompt: "notes" },
    options: {},
    script: trellisScript,
    diverges: "the plan is authored at run time, so make declares fuel-many sequenced leaf slots, not the plan",
    expected: { rounds: [{ plan: { agent: { goal: "write" } }, result: "leaf:root" }], remaining: 1 },
    declared: "leaf:slot-1"
  }]
}

const delegationScript = {
  refine: () => ({ goal: "ship" }),
  plan: () => ({ agent: { goal: "write" } }),
  derisk: () => ({ approved: true }),
  weak: ({ tier }: { readonly tier: string }) => `${tier}-output`,
  review: () => ({ approved: true }),
  settle: ({ leaves }: { readonly leaves: unknown }) => ({ settled: leaves })
}

const delegationBounds = { tierOrder: ["weak"], maxDepth: 1, maxDeriskRounds: 1, maxAttempts: 1 }

const delegationChain: Pattern<Record<string, never>> = {
  make: (m) =>
    DelegationChain.make({
      refine: m.refine!,
      plan: m.plan!,
      derisk: m.derisk!,
      execute: { weak: m.weak! },
      review: m.review!,
      settle: m.settle!,
      ...delegationBounds
    }),
  run: (e, input) =>
    DelegationChain.run((input as { readonly prompt: string }).prompt, {
      refine: e.refine!,
      plan: e.plan!,
      derisk: e.derisk!,
      execute: { weak: e.weak! },
      review: e.review!,
      settle: e.settle!,
      ...delegationBounds
    }),
  cases: [{
    name: "delegation-one-leaf",
    input: { prompt: "notes" },
    options: {},
    script: delegationScript,
    diverges: "the plan is authored at run time, so make declares maxDepth tier ladders over the authored plan",
    expected: { settled: ["weak-output"] },
    declared: { settled: "weak-output" }
  }]
}

/** Every dual-form pattern, by the name `src/index.ts` exports it under. */
const table: Readonly<Record<string, Pattern<any>>> = {
  CheckSuite: checkSuite,
  Debate: debate,
  DelegationChain: delegationChain,
  DriftDetector: drift,
  Escalation: escalation,
  Intervene: intervene,
  Kanban: kanban,
  Loop: loop,
  MapReduce: mapReduce,
  MergeQueue: mergeQueue,
  Optimizer: optimizer,
  Panel: panel,
  ReviewLoop: reviewLoop,
  Runbook: runbook,
  Saga: saga,
  ScanFixVerify: scanFixVerify,
  Sidecar: sidecar,
  Supervisor: supervisor,
  Trellis: trellis,
  TryCatchFinally: tryCatchFinally
}

describe("declared and run forms agree", () => {
  for (const [name, pattern] of Object.entries(table)) {
    describe(name, () => {
      for (const scenario of pattern.cases) {
        it(scenario.name, () => check(pattern, scenario))
      }
    })
  }
})

describe("parity coverage", () => {
  it("has a parity row for every exported pattern with both a declared and a run form", () => {
    const dual = Object.entries(Patterns)
      .filter(([, namespace]) => {
        const exports = namespace as Record<string, unknown>
        return typeof exports.run === "function" && typeof exports.make === "function"
      })
      .map(([name]) => name)
      .sort()
    expect(dual.filter((name) => !Object.hasOwn(table, name))).toEqual([])
    expect(Object.keys(table).sort()).toEqual(dual)
  })
})
