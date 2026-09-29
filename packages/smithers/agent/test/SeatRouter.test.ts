/**
 * Jev answers the routing graph's edge questions and the system variant in
 * one call, the graph picks the seats, and a declared seat asks nothing.
 */
import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import { FlowEngine } from "@smthrs/engine"
import * as StepBoundary from "@smthrs/engine-store/StepBoundary"
import * as WorkspaceSandbox from "@smthrs/engine-store/WorkspaceSandbox"
import { Action, Flow, Interpreter } from "@smthrs/flow"
import * as NodeRuntime from "@smthrs/flows/NodeRuntime"
import * as AgentEvent from "@smthrs/harness/AgentEvent"
import * as Jj from "@smthrs/jj"
import * as Evaluator from "@smthrs/model/Evaluator"
import * as AtomicFileSystem from "@smthrs/platform-node/AtomicFileSystem"
import { Deferred, Effect, Exit, Fiber, Layer, ManagedRuntime, Schema } from "effect"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import * as Seat from "../src/Seat.ts"
import * as SeatRouter from "../src/SeatRouter.ts"

type Size = SeatRouter.Answers["size"]
type Clarity = SeatRouter.Answers["clarity"]

const everySeat = ["luna", "sol", "astra", "opus", "fable", "sonnet", "kimi"] as const
const phases = ["plan", "implement", "review", "ui", "tool", "other"] as const
const sizes = ["trivial", "simple", "middle", "important"] as const
const clarities = ["clear", "unknowns"] as const

/**
 * The maintainer's routing graph of 2026-09-28, one row per clause, read top
 * down: the first row that matches picks. `*` matches anything.
 */
const graph: ReadonlyArray<
  readonly [
    phase: SeatRouter.Phase,
    size: Size | "*",
    clarity: Clarity | "*",
    binary: boolean | "*",
    pick: string
  ]
> = [
  // Trivial plan: no plan; Sonnet researches only.
  ["plan", "trivial", "*", "*", "sonnet"],
  // Simple plan: Opus.
  ["plan", "simple", "*", "*", "opus"],
  // Middle plan: Fable.
  ["plan", "middle", "*", "*", "fable"],
  // Important/complex plan: Opus + Fable + Astra in parallel; Fable merges.
  ["plan", "important", "*", "*", "panel"],
  // Implementation: Fable for the ~1% most important/architected code.
  ["implement", "important", "unknowns", "*", "fable"],
  // Opus if unknown unknowns / design decisions / risk / importance.
  ["implement", "*", "unknowns", "*", "opus"],
  ["implement", "important", "*", "*", "opus"],
  // Sonnet if the approach is clear. Writing code is never Luna.
  ["implement", "*", "*", "*", "sonnet"],
  // Review: Opus for simple; the panel for complex/important.
  ["review", "important", "*", "*", "panel"],
  ["review", "*", "*", "*", "opus"],
  // UI: Opus.
  ["ui", "*", "*", "*", "opus"],
  // Binary, low-risk, tool-calling: Luna if trivial, Sonnet if it needs more intelligence.
  ["tool", "trivial", "clear", true, "luna"],
  ["tool", "*", "clear", true, "sonnet"],
  // Unlisted: Opus.
  ["tool", "*", "*", "*", "opus"],
  ["other", "*", "*", "*", "opus"]
]

const expected = (answers: SeatRouter.Answers): SeatRouter.Planned => {
  const row = graph.find(([phase, size, clarity, binary]) =>
    phase === answers.phase && (size === "*" || size === answers.size) &&
    (clarity === "*" || clarity === answers.clarity) && (binary === "*" || binary === answers.binary)
  )!
  const pick = row[4]
  return pick === "panel"
    ? { seat: "fable", panel: { seats: ["opus", "fable", "astra"], merger: "fable" } }
    : { seat: pick as SeatRouter.GraphSeat }
}

const everyAnswer: ReadonlyArray<SeatRouter.Answers> = phases.flatMap((phase) =>
  sizes.flatMap((size) =>
    clarities.flatMap((clarity) => [true, false].map((binary) => ({ phase, size, clarity, binary })))
  )
)

const everySubset: ReadonlyArray<ReadonlyArray<string>> = Array.from(
  { length: 2 ** everySeat.length },
  (_, mask) => everySeat.filter((_, index) => (mask & (1 << index)) !== 0)
)

describe("SeatRouter.plan", () => {
  it("routes all 96 answer combinations as the graph says", () => {
    expect(everyAnswer).toHaveLength(6 * 4 * 2 * 2)
    for (const answers of everyAnswer) {
      expect({ answers, planned: SeatRouter.plan(answers) }).toEqual({ answers, planned: expected(answers) })
    }
  })

  it("never writes code on Luna, and gives Luna only trivial binary work", () => {
    for (const answers of everyAnswer) {
      const { panel, seat } = SeatRouter.plan(answers)
      const all = [seat, ...(panel?.seats ?? [])]
      if (answers.phase === "implement") expect(all).not.toContain("luna")
      if (all.includes("luna")) {
        expect(answers).toMatchObject({ phase: "tool", size: "trivial", clarity: "clear", binary: true })
      }
      if (panel !== undefined) expect(panel.merger).toBe(seat)
    }
  })
})

describe("SeatRouter.backupsOf", () => {
  it("fails Fable over to Astra, Opus to Sol (Kimi then Sol for UI), Kimi to none, the rest to Kimi", () => {
    expect(SeatRouter.backupsOf("fable", "plan")).toEqual(["astra"])
    expect(SeatRouter.backupsOf("opus", "implement")).toEqual(["sol"])
    expect(SeatRouter.backupsOf("opus", "ui")).toEqual(["kimi", "sol"])
    expect(SeatRouter.backupsOf("kimi", "other")).toEqual([])
    for (const seat of ["sonnet", "luna", "sol", "astra"] as const) {
      expect(SeatRouter.backupsOf(seat, "tool")).toEqual(["kimi"])
    }
  })

  it("never fails a seat over to itself", () => {
    for (const phase of phases) {
      for (const seat of SeatRouter.seats) expect(SeatRouter.backupsOf(seat, phase)).not.toContain(seat)
    }
  })
})

describe("SeatRouter.fit", () => {
  it("keeps only available seats, promoting the first available backup", () => {
    for (const answers of everyAnswer) {
      const planned = SeatRouter.plan(answers)
      for (const available of everySubset) {
        const routed = SeatRouter.fit(planned, answers.phase, available)
        const chain = [planned.seat, ...SeatRouter.backupsOf(planned.seat, answers.phase)]
          .filter((id) => available.includes(id))
        if (chain.length === 0) {
          expect(routed).toBeUndefined()
          continue
        }
        expect(routed).toBeDefined()
        // Every chain that lands on `seat` keeps its backups, in panel order, once each.
        const landing = (seat: string) => [
          ...new Set(
            (planned.panel?.seats ?? [])
              .map((each) =>
                [each, ...SeatRouter.backupsOf(each, answers.phase)].filter((id) => available.includes(id))
              )
              .filter((landed) => landed[0] === seat)
              .flatMap((landed) => landed.slice(1))
          )
        ]
        const landed = new Set(
          (planned.panel?.seats ?? []).flatMap((each) =>
            [each, ...SeatRouter.backupsOf(each, answers.phase)].filter((id) => available.includes(id)).slice(0, 1)
          )
        )
        if (planned.panel !== undefined && landed.size === 1) {
          // A panel reduced to one member is that member's chain.
          expect(routed).toEqual({ seat: chain[0], backups: landing(chain[0]!) })
          continue
        }
        expect(routed!.seat).toBe(chain[0])
        expect(routed!.backups).toEqual(chain.slice(1))
        expect(routed!.backups).not.toContain(routed!.seat)
        if (routed!.panel === undefined) continue
        const members = routed!.panel.seats.map((member) => member.seat)
        expect(routed!.panel.merger).toBe(routed!.seat)
        expect(new Set(members).size).toBe(members.length)
        expect(members.length).toBeGreaterThanOrEqual(2)
        for (const member of routed!.panel.seats) {
          expect([member.seat, ...member.backups].every((id) => available.includes(id))).toBe(true)
          // Its landing chains' backups, less every seat on the panel.
          expect(member.backups).toEqual(landing(member.seat).filter((id) => !members.includes(id)))
        }
      }
    }
  })

  it("routes a panel over every seat, and a panel reduced to one member to that member's chain", () => {
    const planned = SeatRouter.plan({ phase: "plan", size: "important", clarity: "clear", binary: false })
    expect(SeatRouter.fit(planned, "plan", everySeat)).toEqual({
      seat: "fable",
      backups: ["astra"],
      panel: {
        seats: [
          { seat: "opus", backups: ["sol"] },
          // Astra answers on the panel, so Fable does not fail over to it.
          { seat: "fable", backups: [] },
          { seat: "astra", backups: ["kimi"] }
        ],
        merger: "fable"
      }
    })
    // Fable and Astra both land on Astra; with Opus gone the panel is Astra alone, with Astra's backup.
    expect(SeatRouter.fit(planned, "plan", ["astra"])).toEqual({ seat: "astra", backups: [] })
    expect(SeatRouter.fit(planned, "plan", ["astra", "kimi"])).toEqual({ seat: "astra", backups: ["kimi"] })
    // With Fable gone, its chain lands on Astra; the Astra member keeps Astra's own backup, Kimi.
    expect(SeatRouter.fit(planned, "plan", ["opus", "astra", "kimi"])).toEqual({
      seat: "astra",
      backups: [],
      panel: { seats: [{ seat: "opus", backups: [] }, { seat: "astra", backups: ["kimi"] }], merger: "astra" }
    })
  })

  it("routes a panel with no member available to the merger's chain alone", () => {
    // A caller's pick whose panel does not seat its merger: with every member
    // chain gone, the merger answers by itself rather than dropping the route.
    const planned: SeatRouter.Planned = { seat: "opus", panel: { seats: ["fable"], merger: "opus" } }
    expect(SeatRouter.fit(planned, "plan", ["opus", "sol"])).toEqual({ seat: "opus", backups: ["sol"] })
    expect(SeatRouter.fit(planned, "plan", ["sol"])).toEqual({ seat: "sol", backups: [] })
    expect(SeatRouter.fit(planned, "plan", ["kimi"])).toBeUndefined()
  })
})

const state: SeatRouter.State = {
  task: "Rename the helper.",
  flow: "agent",
  description: "The coding agent.",
  capabilities: ["fs.read", "fs.write"]
}

const catalog = (
  offered: ReadonlyArray<string>,
  variants: ReadonlyArray<SeatRouter.Variant> = SeatRouter.defaultVariants
) => SeatRouter.layer({ candidates: Effect.succeed(offered), variants })

/** A clear, simple implementation whose success is not binary: Sonnet's. */
const edges: Readonly<Record<string, Evaluator.ScriptedAnswer>> = {
  phase: { choice: "implement" },
  size: { choice: "simple" },
  clarity: { choice: "clear" },
  binary: { probability: 0.1 }
}

const answering = (
  requests: Array<Evaluator.Request>,
  answers: Readonly<Record<string, Evaluator.ScriptedAnswer>> = { ...edges, system: { choice: "investigate" } }
) =>
  Evaluator.layerScripted((request) => {
    requests.push(request)
    return Object.fromEntries(Object.entries(answers).filter(([id]) => id in request.questions))
  })

const throwing = Evaluator.layerScripted(() => {
  throw new Error("Jev must not be asked")
})

const auto = (input: Partial<SeatRouter.Input> = {}) => SeatRouter.route({ declared: Seat.auto, state, ...input })

const run = <A, E>(effect: Effect.Effect<A, E, SeatRouter.Catalog>, layer: Layer.Layer<SeatRouter.Catalog>) =>
  Effect.runPromise(Effect.exit(effect.pipe(Effect.provide(layer))))

const failure = (exit: Exit.Exit<SeatRouter.Decision, Seat.SeatUnrouted>) => {
  expect(Exit.isFailure(exit)).toBe(true)
  return Exit.isFailure(exit) ? exit.cause.reasons.find((reason) => reason._tag === "Fail")?.error : undefined
}

describe("SeatRouter.route", () => {
  it("asks Jev the edge questions and the variant in one call", async () => {
    const requests: Array<Evaluator.Request> = []
    const long = "x".repeat(20_000)
    const exit = await run(
      auto({ state: { ...state, task: long } }).pipe(
        Effect.provide(answering(requests))
      ),
      catalog(everySeat)
    )
    expect(requests).toHaveLength(1)
    const [request] = requests
    expect(Object.keys(request!.questions)).toEqual(["phase", "size", "clarity", "binary", "system"])
    expect(request!.questions.system!.instructions).toBe(SeatRouter.systemInstructions)
    // `route` sends the task as `Judgement.task` carries it; callers pass it whole.
    const sent = request!.state as { readonly task: string }
    expect(sent.task.length).toBeLessThan(long.length)
    expect(Exit.isSuccess(exit)).toBe(true)
    const decision = Exit.isSuccess(exit) ? exit.value : undefined
    expect(decision).toMatchObject({
      seat: "sonnet",
      backups: ["kimi"],
      variant: "investigate",
      decidedBy: "jev",
      answers: { phase: "implement", size: "simple", clarity: "clear", binary: false },
      candidates: [...everySeat],
      asked: {
        classifier: "seat/route",
        digest: SeatRouter.classifierFor(SeatRouter.defaultVariants, false).digest
      }
    })
    expect(decision).not.toHaveProperty("panel")
    expect(Schema.decodeUnknownSync(SeatRouter.DecisionSchema)(decision)).toEqual(decision)
  })

  it("does not ask a pinned phase, and routes a panel", async () => {
    const requests: Array<Evaluator.Request> = []
    const exit = await run(
      auto({ phase: "review" }).pipe(
        Effect.provide(answering(requests, { ...edges, size: { choice: "important" }, system: { choice: "review" } }))
      ),
      catalog(everySeat)
    )
    expect(Object.keys(requests[0]!.questions)).toEqual(["size", "clarity", "binary", "system"])
    const decision = Exit.isSuccess(exit) ? exit.value : undefined
    expect(decision).toMatchObject({
      seat: "fable",
      backups: ["astra"],
      panel: {
        seats: [
          { seat: "opus", backups: ["sol"] },
          { seat: "fable", backups: [] },
          { seat: "astra", backups: ["kimi"] }
        ],
        merger: "fable"
      },
      variant: "review",
      answers: { phase: "review", size: "important" }
    })
    expect(Schema.decodeUnknownSync(SeatRouter.DecisionSchema)(decision)).toEqual(decision)
  })

  it("routes a caller that does not fan out to the panel's merger alone", async () => {
    const exit = await run(
      auto({ phase: "review", panel: false }).pipe(
        Effect.provide(answering([], { ...edges, size: { choice: "important" }, system: { choice: "review" } }))
      ),
      catalog(everySeat)
    )
    const decision = Exit.isSuccess(exit) ? exit.value : undefined
    expect(decision).toMatchObject({
      seat: "fable",
      backups: ["astra"],
      answers: { phase: "review", size: "important" }
    })
    expect(decision).not.toHaveProperty("panel")
    expect(SeatRouter.events(decision!, { scope: "s", modelId: "m" })[0]).not.toHaveProperty("panel")
  })

  it("asks no variant over one variant or none", async () => {
    for (const [variants, variant] of [[[SeatRouter.defaultVariants[0]!], "change"], [[], null]] as const) {
      const requests: Array<Evaluator.Request> = []
      const exit = await run(auto().pipe(Effect.provide(answering(requests))), catalog(everySeat, variants))
      expect(requests.map((request) => Object.keys(request.questions))).toEqual([
        ["phase", "size", "clarity", "binary"]
      ])
      expect(Exit.isSuccess(exit) && exit.value).toMatchObject({ seat: "sonnet", variant, decidedBy: "jev" })
    }
  })

  it("starts on the first available backup when the graph's seat is unavailable", async () => {
    const exit = await run(
      auto().pipe(
        Effect.provide(answering([], { ...edges, clarity: { choice: "unknowns" }, system: { choice: "change" } }))
      ),
      catalog(["sol", "kimi"])
    )
    expect(Exit.isSuccess(exit) && exit.value).toMatchObject({ seat: "sol", backups: [], candidates: ["sol", "kimi"] })
  })

  it("keeps a declared seat and asks nothing", async () => {
    const exit = await run(
      SeatRouter.route({ declared: "anthropic:claude-sonnet-5", state }).pipe(Effect.provide(throwing)),
      catalog(everySeat)
    )
    expect(Exit.isSuccess(exit) && exit.value).toEqual({
      seat: "anthropic:claude-sonnet-5",
      backups: [],
      variant: null,
      decidedBy: "declared",
      answers: null,
      latencyMs: 0,
      candidates: [],
      asked: null
    })
  })

  it("refuses an empty catalog, one without the graph's seats, and one it cannot list", async () => {
    const cases = [
      [catalog([]), throwing, "no_candidates"],
      // Sonnet fails over to Kimi only; Luna runs neither.
      [catalog(["luna"]), answering([]), "no_candidates"],
      [
        SeatRouter.layer({
          candidates: Effect.fail(new Seat.SeatUnresolved({ seat: "auto", message: "No seat resolver is configured" })),
          variants: []
        }),
        throwing,
        "unconfigured"
      ]
    ] as const
    for (const [layer, judge, reason] of cases) {
      const error = failure(await run(auto().pipe(Effect.provide(judge)), layer))
      expect(error).toBeInstanceOf(Seat.SeatUnrouted)
      expect(error).toMatchObject({ seat: "auto", reason })
    }
  })

  it("fails typed when Jev cannot answer, and never picks a seat", async () => {
    const cases = [
      [Evaluator.layerUnavailable(), "unreachable"],
      [Layer.empty, "unconfigured"],
      [answering([], { ...edges, phase: { choice: "gpt-9" }, system: { choice: "change" } }), "invalid_answer"]
    ] as const
    for (const [judge, reason] of cases) {
      const error = failure(
        await run(auto().pipe(Effect.provide(judge as Layer.Layer<never>)), catalog(everySeat))
      )
      expect(error).toMatchObject({ _tag: "@smthrs/agent/Seat/SeatUnrouted", seat: "auto", reason })
    }
  })
})

describe("SeatRouter.classifierFor", () => {
  it("is stable for one set of variants and pin, and changes with either", () => {
    const first = SeatRouter.classifierFor(SeatRouter.defaultVariants, false)
    expect(SeatRouter.classifierFor([...SeatRouter.defaultVariants], false)).toBe(first)
    expect(SeatRouter.classifierFor(SeatRouter.defaultVariants, true).digest).not.toBe(first.digest)
    const edited = SeatRouter.classifierFor(
      [{ ...SeatRouter.defaultVariants[0]!, description: "Edit files." }, ...SeatRouter.defaultVariants.slice(1)],
      false
    )
    expect(edited.digest).not.toBe(first.digest)
    expect(first.id).toBe("seat/route")
  })
})

describe("SeatRouter.defaultVariants", () => {
  it("teaches each kind of work in one or two sentences", () => {
    expect(SeatRouter.defaultVariants).toEqual([
      {
        id: "change",
        description: "Change the workspace.",
        system: [
          "Edit the workspace to do what the task asks.",
          "Prove the change with a check whose result is recorded before you finish."
        ]
      },
      {
        id: "investigate",
        description: "Find something out without changing anything.",
        system: ["Read what the task needs and cite the files and lines you rely on.", "Change nothing."]
      },
      {
        id: "answer",
        description: "Reply to a question.",
        system: ["Reply only: the task needs an answer, not a change."]
      },
      {
        id: "review",
        description: "Judge a given diff.",
        system: ["Judge the diff you were given and cite each problem where it is.", "Make no edits."]
      }
    ])
  })

  it("reads a variant's text", () => {
    expect(SeatRouter.variantText(SeatRouter.defaultVariants, "answer")).toEqual([
      "Reply only: the task needs an answer, not a change."
    ])
    expect(SeatRouter.variantText(SeatRouter.defaultVariants, null)).toEqual([])
    expect(SeatRouter.variantText(SeatRouter.defaultVariants, "unknown")).toBeUndefined()
  })
})

describe("SeatRouter.events", () => {
  const at = { scope: "session-1", modelId: "fable-1" }

  it("journals a route with its backups, panel and reading, and a declared seat not at all", async () => {
    const exit = await run(
      auto().pipe(
        Effect.provide(
          Layer.succeed(Evaluator.Evaluator)(Evaluator.Evaluator.of({
            evaluate: () =>
              Effect.succeed({
                answers: {
                  phase: { type: "choice", choice: "plan" },
                  size: { type: "choice", choice: "important" },
                  clarity: { type: "choice", choice: "unknowns" },
                  binary: { type: "boolean", probability: 0.2 },
                  system: { type: "choice", choice: "investigate" }
                },
                usage: { inputTokens: 10, outputTokens: 1 },
                latencyMs: 0
              })
          }))
        )
      ),
      catalog(["opus", "fable", "sol"])
    )
    const decision = Exit.isSuccess(exit) ? exit.value : undefined
    const [routed, settled, ...rest] = SeatRouter.events(decision!, at)
    expect(rest).toEqual([])
    expect(routed).toBeInstanceOf(AgentEvent.SeatRouted)
    expect(routed).toMatchObject({
      scope: "session-1",
      declared: "auto",
      seat: "fable",
      modelId: "fable-1",
      variant: "investigate",
      decidedBy: "jev",
      candidates: ["opus", "fable", "sol"],
      panel: { seats: [{ seat: "opus", backups: ["sol"] }, { seat: "fable", backups: [] }], merger: "fable" }
    })
    expect(routed).not.toHaveProperty("backups")
    expect(
      Schema.decodeUnknownSync(AgentEvent.SeatRouted)(
        Schema.encodeSync(AgentEvent.SeatRouted)(
          routed as AgentEvent.SeatRouted
        )
      )
    ).toEqual(routed)
    expect(settled).toBeInstanceOf(AgentEvent.DecisionSettled)
    expect(settled).toMatchObject({
      scope: "session-1",
      frame: 0,
      classifier: "seat/route",
      acted: true,
      decidedBy: "jev",
      usage: { inputTokens: 10, outputTokens: 1 },
      latencyMs: decision!.latencyMs
    })

    expect(SeatRouter.events(
      {
        seat: "sol",
        backups: [],
        variant: null,
        decidedBy: "declared",
        answers: null,
        latencyMs: 0,
        candidates: [],
        asked: null
      },
      at
    )).toEqual([])
  })
})

describe("SeatRouter.durable", () => {
  const input: SeatRouter.Input = { declared: Seat.auto, state }

  it("keys by execution and purpose, not by the catalog", () => {
    const key = { executionId: "run-1", purpose: "root" }
    const action = SeatRouter.durable(input, key)
    expect(action.tier).toBe("sealed")
    expect(action.name).toBe("agent/route-seat")
    expect(action.idempotencyKey).toBe("seat/route:run-1:root")
    expect(SeatRouter.durable({ ...input, state: { ...state, description: "Edited." } }, key).idempotencyKey)
      .toBe(action.idempotencyKey)
  })

  const Picked = Schema.Struct({ seat: Schema.String, variant: Schema.NullOr(Schema.String), decidedBy: Schema.String })

  // The run's start: the step a host routes its seat in.
  const Start = Action.make("agent/test/Start", {
    payload: {},
    success: Picked,
    error: Seat.SeatUnrouted
  })

  const Routing = Flow.make("agent/test/Routing", {
    payload: {},
    success: Picked,
    error: Seat.SeatUnrouted,
    body: () => Start.call({})
  })

  const registration = (judge: Layer.Layer<Evaluator.Evaluator>) =>
    Interpreter.layer(Routing).pipe(
      Layer.provideMerge(
        Start.toLayer(() =>
          SeatRouter.durable(input, { executionId: "run-durable", purpose: "root" }).pipe(
            Effect.map(({ decidedBy, seat, variant }) => ({ seat, variant, decidedBy }))
          )
        )
      ),
      Layer.provideMerge(Layer.mergeAll(catalog(everySeat), judge)),
      Layer.provideMerge(Action.layerImplementations)
    )

  const runtime = (judge: Layer.Layer<Evaluator.Evaluator>) =>
    ManagedRuntime.make(
      registration(judge).pipe(
        Layer.provideMerge(FlowEngine.layerMemory),
        Layer.provideMerge(NodeCrypto.layer)
      )
    )

  it("asks Jev once for two runs of one execution", async () => {
    const requests: Array<Evaluator.Request> = []
    const host = runtime(answering(requests))
    const first = await host.runPromise(Routing.execute({}, { executionId: "run-durable" }))
    const second = await host.runPromise(Routing.execute({}, { executionId: "run-durable" }))
    await host.dispose()
    expect(requests).toHaveLength(1)
    expect(second).toEqual(first)
    expect(first).toMatchObject({ seat: "sonnet", variant: "investigate", decidedBy: "jev" })
  })

  it("re-asks once when the process dies before Jev's answer is recorded", async () => {
    const directory = mkdtempSync(join(tmpdir(), "seat-router-"))
    let calls = 0
    const answered = Deferred.makeUnsafe<void>()
    const judge = Layer.succeed(Evaluator.Evaluator)(Evaluator.Evaluator.of({
      evaluate: () =>
        Effect.suspend(() => {
          calls++
          // The first process is asked, and dies before its answer lands.
          return calls === 1
            ? Effect.andThen(Deferred.succeed(answered, undefined), Effect.never)
            : Effect.succeed({
              answers: {
                phase: { type: "choice", choice: "implement" },
                size: { type: "choice", choice: "simple" },
                clarity: { type: "choice", choice: "clear" },
                binary: { type: "boolean", probability: 0.1 },
                system: { type: "choice", choice: "change" }
              },
              latencyMs: 0
            })
        })
    }))
    const jj = Jj.layerNoop({
      snapshot: () => Effect.succeed({ commitId: "seat-router", changeId: "seat-router" }),
      restore: () => Effect.void,
      diff: () => Effect.succeed("")
    })
    const incarnation = (hostId: string) =>
      NodeRuntime.layer(
        {
          filename: join(directory, "engine.db"),
          workspaceRoot: directory,
          owner: { hostId },
          isAlive: () => Effect.succeed(false)
        },
        StepBoundary.layer,
        WorkspaceSandbox.layerFileSystem(),
        registration(judge)
      ).pipe(Layer.provideMerge(Layer.mergeAll(AtomicFileSystem.layer, NodeCrypto.layer, jj)))
    const execute = Routing.execute({}, { executionId: "run-durable" })
    try {
      await Effect.runPromise(
        Effect.gen(function*() {
          const fiber = yield* Effect.forkChild(execute)
          yield* Deferred.await(answered)
          yield* Fiber.interrupt(fiber)
        }).pipe(Effect.provide(incarnation("first")), Effect.scoped)
      )
      const resumed = await Effect.runPromise(execute.pipe(Effect.provide(incarnation("second")), Effect.scoped))
      const replayed = await Effect.runPromise(execute.pipe(Effect.provide(incarnation("third")), Effect.scoped))
      expect(calls).toBe(2)
      expect(resumed).toEqual({ seat: "sonnet", variant: "change", decidedBy: "jev" })
      expect(replayed).toEqual(resumed)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
