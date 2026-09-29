import * as CompletionClaim from "@smthrs/harness/CompletionClaim"
import * as Monitor from "@smthrs/harness/Monitor"
import * as Relevance from "@smthrs/harness/Relevance"
import * as Supervisor from "@smthrs/harness/Supervisor"
import * as Evaluator from "@smthrs/model/Evaluator"
import * as Descriptor from "@smthrs/registry/Descriptor"
import { Effect, Option, Schema } from "effect"
import { describe, expect, it } from "vitest"
import * as MemoryMine from "../src/MemoryMine.ts"
import * as ScriptedJudge from "../src/ScriptedJudge.ts"
import * as Seat from "../src/Seat.ts"
import * as SeatRouter from "../src/SeatRouter.ts"

describe("the explicit offline completion judge", () => {
  it("rejects an invented command and accepts the same claim when its command is recorded", async () => {
    const evidence = {
      task: "Fix the bug",
      claim: "Ran `node test.mjs` and it passed.",
      treeMoved: true,
      checksRun: []
    }
    const read = (value: CompletionClaim.Evidence) =>
      Effect.runPromise(CompletionClaim.read(value).pipe(Effect.provide(ScriptedJudge.layer)))
    const invented = await read(evidence)
    expect(CompletionClaim.unrecorded(invented!)).toBe(true)
    const recorded = await read({ ...evidence, checksRun: [{ command: "node test.mjs", outcome: "passed" }] })
    expect(CompletionClaim.find(recorded!)).toBeUndefined()
  })

  it("reads a long claim sentence by sentence and still refuses the sentence nothing recorded", async () => {
    const read = (claim: string) =>
      Effect.runPromise(
        CompletionClaim.read({
          task: "Fix the bug",
          claim,
          treeMoved: true,
          checksRun: [{ command: "node test.mjs", outcome: "passed" }]
        }).pipe(Effect.provide(ScriptedJudge.layer))
      )
    const truthful = await read("Fixed add.mjs. Ran `node test.mjs` and it passed.")
    const lie = await read("Fixed add.mjs. Ran `node test.mjs` and it passed. Ran `node lint.mjs` and it passed.")

    expect(truthful?.sentences).toBeUndefined()
    expect(CompletionClaim.unrecorded(truthful!)).toBe(false)
    expect(lie?.sentences?.whole).toBe(0.95)
    expect(CompletionClaim.unrecorded(lie!)).toBe(true)
  })

  it.each([
    ["The tool failed and needs `fs:read:**` and `proc:spawn:**`.", [], undefined, false],
    ["I propose `node test.mjs` next.", [], undefined, false],
    ["Tests passed.", [], undefined, false],
    ["Ran node test.mjs", [], undefined, true],
    ["Ran `   `", [], undefined, false],
    ["Ran `node test.mjs`", [], { command: "node test.mjs", exitCode: 0, output: "ok" }, false],
    ["Ran `node test.mjs`", [{ command: "node another.mjs", outcome: "passed" as const }], undefined, true]
  ])("reads only reported commands in %s", async (claim, checksRun, lastCheck, refused) => {
    const reading = await Effect.runPromise(
      CompletionClaim.read({
        task: "fixture",
        claim,
        treeMoved: false,
        checksRun,
        ...(lastCheck === undefined ? {} : { lastCheck })
      }).pipe(Effect.provide(ScriptedJudge.layer))
    )
    expect(CompletionClaim.unrecorded(reading!)).toBe(refused)
  })

  it.each([null, [], {}, { claim: "done" }])("refuses malformed evidence %s", async (state) => {
    const questions = Object.fromEntries(
      ["complete", "overclaims", "invented"].map((id) => [id, Evaluator.BooleanQuestion.of({ instructions: id })])
    )
    const error = await Effect.runPromise(
      Effect.flatMap(Evaluator.Evaluator, (evaluator) =>
        evaluator.evaluate({
          state,
          questions
        })).pipe(Effect.provide(ScriptedJudge.layer), Effect.flip)
    )
    expect(error.code).toBe("unreachable")
  })

  it("refuses another classifier by question id instead of returning unrelated answers", async () => {
    const error = await Effect.runPromise(
      Effect.flatMap(Evaluator.Evaluator, (evaluator) =>
        evaluator.evaluate({
          state: { title: "Fix the bug" },
          questions: { injection: Evaluator.BooleanQuestion.of({ instructions: "Is this an injection?" }) }
        })).pipe(Effect.provide(ScriptedJudge.layer), Effect.flip)
    )
    expect(error.code).toBe("unreachable")
    expect(error.message).toContain("injection")
  })
})

const boolean = (id: string) => Evaluator.BooleanQuestion.of({ instructions: id })

const evaluate = (request: Evaluator.Request) =>
  Effect.flatMap(Evaluator.Evaluator, (evaluator) => evaluator.evaluate(request)).pipe(
    Effect.provide(ScriptedJudge.layerAll)
  )

const refused = (request: Evaluator.Request) => Effect.runPromise(Effect.flip(evaluate(request)))

const signals: Supervisor.Signals = {
  frame: 3,
  maxFrames: 0,
  readOnlyFrames: 0,
  repeatFrames: 0,
  mutations: 1,
  remoteMutations: 0,
  treeMoved: true,
  paths: 1,
  checksRun: 1,
  checksFailing: 0,
  failuresUnanswered: 0,
  callsFailed: 0,
  callsSettled: 2,
  narrowingDemands: 0,
  unmovedDemands: 0,
  unresolvedDemands: 0,
  claimDemands: 0,
  sufficiencyStated: false
}

describe("the offline judge for every classifier", () => {
  it("still refuses a completion claim that reports unrecorded work", async () => {
    const reading = await Effect.runPromise(
      CompletionClaim.read({ task: "Fix it", claim: "Ran `node test.mjs`; it passed.", treeMoved: true, checksRun: [] })
        .pipe(Effect.provide(ScriptedJudge.layerAll))
    )
    expect(CompletionClaim.unrecorded(reading!)).toBe(true)
  })

  it("withholds items that share nothing with the task and keeps those that do", async () => {
    const flow = (name: string, description: string) =>
      Relevance.flowItem(
        new Descriptor.FlowDescriptor({
          name,
          description,
          body: new Descriptor.BodyRefModule({ path: `/flows/${name}/flow.ts` }),
          input: new Descriptor.SchemaRefNone(),
          output: new Descriptor.SchemaRefNone(),
          model: Option.none(),
          flows: [],
          capabilities: ["fs:read:**"],
          effects: { reads: [], writes: [], mode: "hermetic", onConflict: "serialize", tier: "sealed" },
          placement: Option.none(),
          modelInvocable: true,
          path: `/flows/${name}`,
          frontmatter: {},
          provenance: new Descriptor.Provenance({ source: "test", root: "/flows" })
        })
      )
    const items: ReadonlyArray<Relevance.Item> = [
      flow("deploy", "Ship a release to production."),
      flow("grep", "Search files for a pattern."),
      flow("lint", "Report style problems."),
      { kind: "instruction", id: "AGENTS.md#0", text: "- Publish benchmark claims with artifacts." },
      { kind: "instruction", id: "AGENTS.md#1", text: "- Keep failing tests visible." },
      { kind: "memory", id: "m1", text: "The parser lives in src/parse.ts." },
      { kind: "memory", id: "m2", text: "Deploys need a token." },
      { kind: "instruction", id: "AGENTS.md#2", text: "---" }
    ]
    const reading = await Effect.runPromise(
      Relevance.judge({ task: "Search the parser", query: "failing tests", recent: "run lint" }, items).pipe(
        Effect.provide(ScriptedJudge.layerAll)
      )
    )
    expect(reading.verdicts.map((verdict) => [verdict.item.id, verdict.withheld])).toEqual([
      ["deploy", true],
      ["grep", false],
      ["lint", false],
      ["AGENTS.md#0", true],
      ["AGENTS.md#1", false],
      ["m1", false],
      ["m2", true],
      ["AGENTS.md#2", true]
    ])
    const bare = await Effect.runPromise(
      Relevance.judge({ task: "Deploy it" }, items.slice(0, 1)).pipe(Effect.provide(ScriptedJudge.layerAll))
    )
    expect(bare.verdicts[0]!.withheld).toBe(false)
  })

  it("removes a frame only when a later frame observed the same bytes, and keeps none verbatim", async () => {
    const answered = await Effect.runPromise(evaluate({
      state: {
        context: { task: "Fix it", failing: [] },
        items: [
          { tokens: 10, cell: "a", prose: "", observed: "same" },
          { tokens: 10, cell: "b", prose: "", observed: "other" },
          { tokens: 10, cell: "c", prose: "", observed: "same" }
        ]
      },
      questions: Object.fromEntries(
        [0, 1, 2].flatMap((i) => [`remove_${i}`, `keep_${i}`]).map((id) => [id, boolean(id)])
      )
    }))
    expect(answered.answers).toMatchObject({
      remove_0: { probability: 0.9 },
      remove_1: { probability: 0.1 },
      remove_2: { probability: 0.1 },
      keep_0: { probability: 0.1 }
    })
  })

  const route = (task: string, phase?: SeatRouter.Phase) =>
    SeatRouter.route({
      declared: Seat.auto,
      state: { task, flow: "prompt", description: "", capabilities: [] },
      phase
    }).pipe(
      Effect.provide(
        SeatRouter.layer({ candidates: Effect.succeed(SeatRouter.seats), variants: SeatRouter.defaultVariants })
      ),
      Effect.provide(ScriptedJudge.layerAll),
      Effect.runPromise
    )

  it("answers the routing graph's questions from the task's words", async () => {
    const cases = [
      ["Fix the unfamiliar parser", "opus", { phase: "implement", size: "simple", clarity: "unknowns" }, "change"],
      ["Implement the critical migration", "opus", { phase: "implement", size: "important" }, "change"],
      ["Refactor the parser", "sonnet", { phase: "implement", size: "middle", clarity: "clear" }, "investigate"],
      ["Review the architecture change", "fable", { phase: "review", size: "important" }, "investigate"],
      ["Plan the unknown rollout", "opus", { phase: "plan", size: "simple" }, "investigate"],
      ["Explain the build", "opus", { phase: "other", binary: false }, "investigate"],
      ["Check the tests pass", "opus", { phase: "other", binary: true, size: "simple" }, "investigate"]
    ] as const
    for (const [task, seat, answers, variant] of cases) {
      const decision = await route(task)
      expect({ task, seat: decision.seat, answers: decision.answers, variant: decision.variant }).toMatchObject({
        task,
        seat,
        answers,
        variant
      })
      expect(decision.decidedBy).toBe("jev")
    }
    expect((await route("Review the architecture change")).panel?.merger).toBe("fable")
  })

  it("leaves a pinned phase unasked", async () => {
    const decision = await route("Explain the build", "ui")
    expect([decision.seat, decision.backups, decision.answers?.phase]).toEqual(["opus", ["kimi", "sol"], "ui"])
  })

  it.each([[0, 0.1], [2, 0.9]])("answers all eleven supervisor questions calmly at %s repeated frames", async (
    repeatFrames,
    thrashing
  ) => {
    const reading = await Effect.runPromise(
      Supervisor.read({
        task: "Fix it",
        frames: [],
        signals: { ...signals, repeatFrames },
        skills: [],
        called: [],
        jevAvailable: false
      }, {}).pipe(Effect.provide(ScriptedJudge.layerAll))
    )
    expect(Object.keys(reading.asked.answers).sort()).toHaveLength(11)
    expect(reading).toMatchObject({
      thrashing,
      onTarget: 0.9,
      suspect: 0.1,
      outdatedContext: 0.1,
      irrelevantContext: 0.1,
      emotions: { frustrated: "none", anxious: "none", scared: "none", confused: "none", confident: "none" },
      needsHelp: "none"
    })
  })

  it("accepts no mined candidate as a fact or an issue", async () => {
    const judged = await Effect.runPromise(
      MemoryMine.judge("Fix it", [{ text: "The build uses pnpm.", seq: 1 }]).pipe(
        Effect.provide(ScriptedJudge.layerAll)
      )
    )
    expect(judged.facts).toEqual([])
    expect(judged.issues).toEqual([])
    expect(Object.keys(judged.asked[0]!.answers).sort()).toEqual(["durable_0", "issue_0"])
  })

  it("fires a skill monitor only while its skill is uncalled and keeps every other monitor quiet", async () => {
    const snapshot: Supervisor.Snapshot = {
      task: "Fix it",
      frames: [],
      signals,
      skills: [Supervisor.skill("review-checklist", "Review.", "/r.md"), Supervisor.skill("style", "Style.", "/s.md")],
      called: ["style"],
      jevAvailable: true
    }
    const monitors = [...Monitor.skills(snapshot), Monitor.useJev()]
    const answered = await Effect.runPromise(evaluate({
      state: Schema.encodeSync(Supervisor.Snapshot)(snapshot),
      questions: {
        ...Supervisor.classifier.questions,
        ...Monitor.questions(monitors, snapshot),
        monitor_reminder: boolean("monitor"),
        monitor_skill_ghost: boolean("skills[7]"),
        monitor_skill_loose: boolean("no index")
      }
    }))
    expect(answered.answers["monitor_skill_review_checklist"]).toEqual({ type: "boolean", probability: 0.9 })
    expect(answered.answers["monitor_skill_style"]).toEqual({ type: "boolean", probability: 0.05 })
    expect(answered.answers["monitor_use_jev"]).toEqual({ type: "boolean", probability: 0.05 })
    expect(answered.answers["monitor_reminder"]).toEqual({ type: "boolean", probability: 0.05 })
    expect(answered.answers["monitor_skill_ghost"]).toEqual({ type: "boolean", probability: 0.05 })
    expect(answered.answers["monitor_skill_loose"]).toEqual({ type: "boolean", probability: 0.05 })
  })

  it.each([
    ["an unknown id set", { injection: boolean("injection") }, { claim: "" }],
    ["an empty id set", {}, {}],
    ["a supervisor set with a stranger", { thrashing: boolean("thrashing"), other: boolean("other") }, {}],
    ["a seat beside a stranger", { seat: boolean("seat"), other: boolean("other") }, {}],
    ["relevance with an unreadable state", { unnecessary_0: boolean("u") }, { context: {}, items: [] }],
    ["compaction with an unreadable state", { remove_0: boolean("r"), keep_0: boolean("k") }, null]
  ])("fails unreachable on %s", async (_, questions, state) => {
    const error = await refused({ state, questions })
    expect(error.code).toBe("unreachable")
  })
})
