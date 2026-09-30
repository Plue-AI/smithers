/**
 * The supervisor, driven through the loop that offers to it.
 *
 * Every case runs the real controller against a recorded model, a scripted
 * engine and a scripted evaluator; nothing reaches a network. The scripted
 * evaluator tells the two classifiers apart by their questions: a request
 * carrying `complete` is the completion brake, which every case answers
 * confidently so the run can finish, and a request carrying `thrashing` is
 * the supervisor, which each case scripts for itself. A request carrying
 * `unnecessary_0` is a relevance reading, which the recalled rows go through.
 *
 * The rule the cases pin: the loop never waits for the supervisor, the
 * supervisor is asked and answers off the hot path, a reading past its
 * threshold is delivered once at the next boundary and only when steering is
 * armed, a reading nobody could take nudges nothing and reports no level,
 * a replayed run re-delivers what it recorded without asking again, memory
 * is written only for what Jev accepted, and a recalled row is shown once
 * unless relevance withholds it.
 *
 * The steering source in the delivery cases WAITS for the supervisor to
 * settle before it drains. That is the test harness holding the boundary
 * open so the assertion is about what the boundary delivers rather than
 * about scheduler luck; the loop under test still never awaits the fiber,
 * which the first case proves with an evaluator that never answers.
 */
import { ModelRequest } from "@smthrs/model"
import * as Classifier from "@smthrs/model/Classifier"
import * as Evaluator from "@smthrs/model/Evaluator"
import * as Descriptor from "@smthrs/registry/Descriptor"
import { Deferred, Effect, Layer, Option, Result, Schema, Stream } from "effect"
import { describe, expect, it } from "vitest"
import * as AgentEvent from "../src/AgentEvent.ts"
import * as CallLedger from "../src/CallLedger.ts"
import * as CellTurn from "../src/CellTurn.ts"
import * as ContextWindow from "../src/ContextWindow.ts"
import * as EngineLike from "../src/EngineLike.ts"
import { HarnessError } from "../src/HarnessError.ts"
import * as Supervision from "../src/internal/supervision.ts"
import * as Monitor from "../src/Monitor.ts"
import * as QuickJSSandbox from "../src/QuickJSSandbox.ts"
import type * as Relevance from "../src/Relevance.ts"
import * as Steering from "../src/Steering.ts"
import * as Supervisor from "../src/Supervisor.ts"
import { descriptor, emits, of, prose, run } from "./fixtures/cellTurn.ts"
import * as ScriptedEngine from "./fixtures/scriptedEngine.ts"
import * as ScriptedModel from "./fixtures/scriptedModel.ts"

const task = "Fix the off-by-one in add()."

const window = ContextWindow.make({
  modelId: "test-model",
  segments: [
    { kind: "system", zone: "prefix", content: [ModelRequest.SystemPart.make({ text: "cell contract" })] },
    {
      kind: "instructions",
      zone: "prefix",
      content: [ModelRequest.SystemPart.make({ text: `The task for this run:\n\n${task}` })]
    },
    { kind: "transcript", zone: "tail", content: [ModelRequest.Message.user("start")] }
  ]
})

const state = (maxFrames: number, revalidations?: number) =>
  CellTurn.make({
    revalidations,
    session: "session-1",
    seat: "anthropic:test-model",
    modelParams: ModelRequest.GenerationParams.make(),
    layers: [],
    capabilityEnvelope: [],
    placement: Option.none(),
    contextWindow: window,
    maxFrames,
    repeatCap: 0,
    narrowingCap: 0,
    unmovedCap: 0,
    unresolvedCap: 0
  })

/** The completion brake's confident answer, so every run can finish. */
const confident = {
  complete: { probability: 0.99 },
  overclaims: { probability: 0.01 },
  invented: { probability: 0.01 }
}

/** A calm supervisor answer. */
const calm = (
  overrides: Readonly<Record<string, Evaluator.ScriptedAnswer>> = {}
): Readonly<Record<string, Evaluator.ScriptedAnswer>> => ({
  thrashing: { probability: 0.05 },
  on_target: { probability: 0.95 },
  suspect: { probability: 0.05 },
  outdated_context: { probability: 0.05 },
  irrelevant_context: { probability: 0.05 },
  frustrated: { score: 0 },
  anxious: { score: 0 },
  scared: { score: 0 },
  confused: { score: 0 },
  confident: { score: 2 },
  needs_help: { choice: "none" },
  ...overrides
})

const isSupervisor = (request: Evaluator.Request): boolean => Object.hasOwn(request.questions, "thrashing")

/** Every monitor question a supervisor request carries, answered far below any threshold. */
const quietMonitors = (request: Evaluator.Request): Readonly<Record<string, Evaluator.ScriptedAnswer>> =>
  Object.fromEntries(
    Object.keys(request.questions)
      .filter((key) => key.startsWith(Supervisor.monitorPrefix))
      .map((key) => [key, { probability: 0.05 }] as const)
  )

const isRelevance = (request: Evaluator.Request): boolean => Object.hasOwn(request.questions, "unnecessary_0")

const isMarks = (request: Evaluator.Request): boolean => Object.hasOwn(request.questions, "remove_0")

const itemsOf = (request: Evaluator.Request): ReadonlyArray<Relevance.Item> =>
  (request.state as { readonly items: ReadonlyArray<Relevance.Item> }).items

/**
 * An evaluator that answers the completion brake from `brake` (at once when
 * omitted), the supervisor from `answer`, each relevance item at the
 * probability `unnecessary` gives it, or with `unnecessary` when it is a
 * failure, and every compaction mark low. It records every supervisor
 * request, every relevance request over memory rows and every marks request.
 */
const scripted = (
  answer: (request: Evaluator.Request, ordinal: number) =>
    | Readonly<Record<string, Evaluator.ScriptedAnswer>>
    | Effect.Effect<Readonly<Record<string, Evaluator.ScriptedAnswer>>, Evaluator.EvaluatorError>,
  unnecessary: ((item: Relevance.Item) => number) | Evaluator.EvaluatorError = () => 0.1,
  brake: (ordinal: number) => Readonly<Record<string, Evaluator.ScriptedAnswer>> = () => confident
) => {
  const contacted: Array<Evaluator.Request> = []
  const relevance: Array<Evaluator.Request> = []
  const marks: Array<Evaluator.Request> = []
  let completions = 0
  const layer = Evaluator.layerScripted((request) => {
    if (isMarks(request)) {
      marks.push(request)
      return Object.fromEntries(Object.keys(request.questions).map((key) => [key, { probability: 0.1 }] as const))
    }
    if (isRelevance(request)) {
      const items = itemsOf(request)
      if (items.every((item) => item.kind === "memory")) relevance.push(request)
      return typeof unnecessary === "function"
        ? Object.fromEntries(items.map((item, index) => [`unnecessary_${index}`, { probability: unnecessary(item) }]))
        : Effect.fail(unnecessary)
    }
    if (!isSupervisor(request)) return brake(completions++)
    contacted.push(request)
    const declined = quietMonitors(request)
    const scripted = answer(request, contacted.length - 1)
    return Effect.isEffect(scripted)
      ? Effect.map(scripted, (answers) => ({ ...declined, ...answers }))
      : { ...declined, ...scripted }
  })
  return { layer, contacted, relevance, marks }
}

/** A bound memory that recalls the first `limit` of `rows` on every reading and records any write. */
const recalling = (rows: ReadonlyArray<Supervisor.Recalled>) => {
  const remembered: Array<string> = []
  const memory: Supervisor.Memory = {
    bound: true,
    recall: (_, limit) => Effect.succeed(rows.slice(0, limit)),
    remember: (text) => Effect.sync(() => void remembered.push(text))
  }
  return { memory, remembered }
}

const tests = { key: "tests", text: "Tests run with `python -m pytest -q`." }
const layout = { key: "layout", text: "Sources live under src/." }

/** Every row key each boundary delivered, one list per boundary that delivered any. */
const shownBy = (events: ReadonlyArray<AgentEvent.AgentEvent>): ReadonlyArray<ReadonlyArray<string>> =>
  of(events, "steering-drained").flatMap((event) => event.memory === undefined ? [] : [event.memory])

/** What one frame's reading journaled, in order: decisions by classifier, the rest by tag. */
const readingOf = (events: ReadonlyArray<AgentEvent.AgentEvent>, frame: number): ReadonlyArray<string> =>
  events.flatMap((event) => {
    switch (event._tag) {
      case "decision-settled":
        return event.frame === frame ? [event.classifier] : []
      case "relevance-settled":
      case "decision-unjudged":
      case "supervisor-settled":
      case "supervisor-unjudged":
        return event.frame === frame ? [event._tag] : []
      default:
        return []
    }
  })

const textsOf = (messages: ReadonlyArray<ModelRequest.Message>): ReadonlyArray<string> =>
  messages.flatMap((message) => message.content.flatMap((part) => part.type === "text" ? [part.text] : []))

/** A steering source that drains nothing and, when told to, waits first. */
const steeringAfter = (wait: (boundary: string) => Effect.Effect<void>): Layer.Layer<Steering.Source> =>
  Steering.layer({
    read: () => Effect.succeed(Steering.empty()),
    drain: (input) =>
      wait(input.boundary).pipe(Effect.as({
        inserts: [],
        seatChanges: [],
        remaining: Steering.empty(),
        queued: false,
        duplicate: false
      }))
  })

/**
 * Holds each frame's boundary open until the supervisor has settled or
 * failed its reading of the frame BEFORE it, observed off the event stream:
 * a frame is offered by its own live boundary, so the earliest boundary that
 * can deliver its reading is the next one. The wait is the test's, not the
 * loop's: the loop under test still never awaits the fiber, which the first
 * case proves with an evaluator that never answers.
 */
const untilRead = (from = 0) => {
  const gates = new Map<number, Deferred.Deferred<void>>()
  // What the observer saw, which is the durable record: the stream a test
  // collects may lag the fiber's publish, and a run that ends right after a
  // reading settles can end before that publish lands. Supervisor events are
  // asserted here; loop events are asserted on the stream as everywhere else.
  const seen: Array<AgentEvent.AgentEvent> = []
  const gate = (frame: number) => {
    const held = gates.get(frame)
    if (held !== undefined) return held
    const made = Effect.runSync(Deferred.make<void>())
    gates.set(frame, made)
    return made
  }
  return {
    seen,
    observer: (event: AgentEvent.AgentEvent) =>
      Effect.suspend(() => {
        seen.push(event)
        return event._tag === "supervisor-settled" || event._tag === "supervisor-unjudged"
          ? Effect.asVoid(Deferred.succeed(gate(event.frame), undefined))
          : Effect.void
      }),
    steering: steeringAfter((boundary) => {
      const frame = Number(boundary.split(":")[0])
      return frame === from ? Effect.void : Deferred.await(gate(frame - 1))
    })
  }
}

const threeFrames = [emits(`console.log("one")`), emits(`console.log("two")`), emits(`ctx.done("done")`)]

/** `frames - 1` cells that print, then a completion. */
const framesOf = (frames: number) => [
  ...Array.from({ length: frames - 1 }, (_, index) => emits(`console.log(${index})`)),
  emits(`ctx.done("done")`)
]

/** How many texts carrying `needle` each sealed request held, in frame order. */
const carrying = (engine: ScriptedEngine.Fixture, needle: string): ReadonlyArray<number> =>
  engine.recorder.sealStep.map((step) => textsOf(step.request.messages).filter((text) => text.includes(needle)).length)

/** The monitor each boundary delivered, in order. */
const deliveredBy = (events: ReadonlyArray<AgentEvent.AgentEvent>): ReadonlyArray<string> =>
  of(events, "steering-drained").flatMap((event) => event.monitor === undefined ? [] : [event.monitor])

/** What each boundary withheld, one list per boundary. */
const withheldBy = (events: ReadonlyArray<AgentEvent.AgentEvent>) =>
  of(events, "steering-drained").map((event) => event.suppressed ?? [])

/** The paranoid mood's evidence: confident strong, beside a bounced completion in the frames. */
const paranoid = () => calm()

/** The completion brake bounces the first completion as an unsupported claim and stands the rest. */
const bouncedFirst = (ordinal: number): Readonly<Record<string, Evaluator.ScriptedAnswer>> =>
  ordinal === 0
    ? { complete: { probability: 0.4 }, overclaims: { probability: 0.9 }, invented: { probability: 0.6 } }
    : confident

/** A bounced completion, then prints, then one that stands: the frames paranoid reads. */
const bouncedRun = (frames: number) => [
  emits(`ctx.done("done")`),
  ...Array.from({ length: frames - 2 }, (_, index) => emits(`console.log(${index})`)),
  emits(`ctx.done("done")`)
]

/** The legacy nudge, unchanged, for a thrashing reading of a first frame that changed nothing. */
const legacyNudge = "Supervisor: a reading of this run's last 1 frames, through frame 0, finds it repeating itself " +
  "(thrashing 0.90). Evidence at frame 0: 1 consecutive frames changed nothing; 0 frames changed the workspace. " +
  "Before the next call, state in one sentence which mechanism you now believe is wrong and which single call " +
  "would show it; then make that call. Do not re-run a check over an unchanged tree, and do not edit a test to " +
  "make it pass."

describe("Supervisor", () => {
  it("never waits for the supervisor: a run completes its frames while the evaluator never answers", async () => {
    const { contacted, layer } = scripted(() => Effect.never)
    const started = Date.now()
    const { events, failure } = await run({
      state: state(3),
      script: threeFrames,
      evaluator: layer,
      // A host's boundary does real work; a few milliseconds of it is what
      // lets the fiber be scheduled at all, and nothing here waits for it.
      steering: steeringAfter(() => Effect.sleep("5 millis"))
    })
    expect(failure).toBeUndefined()
    expect(of(events, "resolved")).toHaveLength(1)
    expect(of(events, "turn-closed")).toHaveLength(3)
    // Contacted, so the fiber ran; never settled, so the one reading in
    // flight at the end is journaled as interrupted and nothing else is.
    expect(contacted.length).toBeGreaterThanOrEqual(1)
    expect(of(events, "supervisor-settled")).toEqual([])
    expect(of(events, "supervisor-unjudged").map((event) => event.reason)).toEqual(["interrupted"])
    expect(Date.now() - started).toBeLessThan(4_000)
  })

  it("fires on every frame it reaches and is contacted with the snapshot the frame closed on", async () => {
    const seen: Array<Evaluator.Request> = []
    const read = untilRead()
    const { contacted, layer } = scripted((request) => {
      seen.push(request)
      return calm({
        frustrated: { score: 2 },
        anxious: { score: 1 },
        scared: { score: 0 },
        confused: { score: 1 },
        confident: { score: 0 },
        needs_help: { choice: "stuck" }
      })
    })
    const { events, failure } = await run({
      state: state(3),
      script: threeFrames,
      evaluator: layer,
      ...read
    })
    expect(failure).toBeUndefined()
    expect(contacted.length).toBeGreaterThanOrEqual(1)
    const first = seen[0]!
    const snapshot = Schema.decodeUnknownSync(Supervisor.Snapshot)(first.state)
    expect(snapshot.task).toContain(task)
    expect(snapshot.frames.map((frame) => frame.frame)).toEqual([0])
    expect(snapshot.frames[0]?.cell).toContain(`console.log("one")`)
    expect(snapshot.frames[0]?.transition).toBe("continue")
    expect(snapshot.signals.frame).toBe(0)
    expect(snapshot.signals.readOnlyFrames).toBe(1)
    expect(Object.keys(first.state as object)).not.toContain("recalled")
    // The eleven fixed questions and no others: the supervisor asks nothing about memory.
    expect(Object.keys(first.state as object)).not.toContain("candidates")
    expect(Object.keys(first.questions)).toEqual([
      "thrashing",
      "on_target",
      "suspect",
      "outdated_context",
      "irrelevant_context",
      "frustrated",
      "anxious",
      "scared",
      "confused",
      "confident",
      "needs_help"
    ])
    const settled = of(read.seen, "supervisor-settled")
    expect(settled.length).toBeGreaterThanOrEqual(1)
    expect(settled[0]).toMatchObject({
      scope: "session-1",
      frame: 0,
      thrashing: 0.05,
      onTarget: 0.95,
      suspect: 0.05,
      frustrated: "strong",
      anxious: "mild",
      scared: "none",
      confused: "mild",
      confident: "none",
      needsHelp: "stuck",
      // A strong frustration crosses the step_back mood; unjudged, nothing is handed on.
      crossed: true,
      nudged: false
    })
    expect(settled[0]?.monitors).toEqual([
      { id: "supervisor", kind: "lint", p: 0, crossed: false },
      { id: "paranoid", kind: "mood", p: 0, crossed: false },
      { id: "careful", kind: "mood", p: 0, crossed: false },
      { id: "step_back", kind: "mood", p: 1, crossed: true },
      { id: "clarify", kind: "mood", p: 0, crossed: false }
    ])
    // The full record beside it, under the supervisor's own classifier id.
    const decisions = of(read.seen, "decision-settled").filter((event) => event.classifier === "supervisor/turn")
    expect(decisions.length).toBeGreaterThanOrEqual(1)
    expect(decisions[0]?.answers["needs_help"]).toMatchObject({ kind: "choice", value: "stuck" })
    expect(decisions[0]?.acted).toBe(false)
  })

  it("delivers exactly one nudge at the next boundary when a reading crosses and steering is armed", async () => {
    const read = untilRead()
    const { contacted, layer } = scripted((_, ordinal) =>
      ordinal === 0 ? calm({ thrashing: { probability: 0.9 } }) : calm()
    )
    const { engine, events, failure } = await run({
      state: state(4),
      script: [
        emits(`console.log("a")`),
        emits(`console.log("b")`),
        emits(`console.log("c")`),
        emits(`ctx.done("done")`)
      ],
      evaluator: layer,
      ...read,
      judged: true
    })
    expect(failure).toBeUndefined()
    expect(contacted.length).toBeGreaterThanOrEqual(2)
    expect(of(events, "steering-drained").flatMap((event) => event.messages)).toEqual([])
    const drained = of(events, "steering-drained").flatMap((event) => event.supervisor ?? [])
    const texts = drained.flatMap((message) =>
      message.content.flatMap((part) => part.type === "text" ? [part.text] : [])
    )
    expect(of(events, "discipline-armed")[0]).toMatchObject({ judged: true })
    expect(of(events, "discipline-armed")[0]).not.toHaveProperty("supervisorSteer")
    expect(texts).toEqual([legacyNudge])
    expect(deliveredBy(events)).toEqual(["supervisor"])
    // Frame 0 is offered by its own boundary and read during frame 1, so the
    // boundary closing frame 1 delivers it and frame 2 is the first to read it.
    const requests = engine.recorder.sealStep.map((step) =>
      step.request.messages.flatMap((message) =>
        message.content.flatMap((part) => part.type === "text" && part.text.includes("Supervisor") ? [part.text] : [])
      ).length
    )
    expect(requests[0]).toBe(0)
    expect(requests[1]).toBe(0)
    expect(requests[2]).toBe(1)
    expect(of(read.seen, "supervisor-settled")[0]).toMatchObject({ frame: 0, crossed: true, nudged: true })
    // The calm readings after it nudged nothing.
    expect(of(read.seen, "supervisor-settled").slice(1).every((event) => !event.nudged)).toBe(true)
  })

  it("journals a crossed reading and delivers nothing while steering is off", async () => {
    const read = untilRead()
    const { layer } = scripted(() => calm({ thrashing: { probability: 0.9 }, on_target: { probability: 0.1 } }))
    const { events } = await run({
      state: state(3),
      script: threeFrames,
      evaluator: layer,
      ...read
    })
    const armed = of(events, "discipline-armed")[0]
    expect(armed?.supervisorSteer).toBeUndefined()
    // An unjudged journal carries no `judged` key, so its bytes are unchanged.
    expect(armed !== undefined && "judged" in armed).toBe(false)
    expect(of(events, "steering-drained").flatMap((event) => event.messages)).toEqual([])
    expect(of(events, "steering-drained").every((event) => event.supervisor === undefined)).toBe(true)
    expect(deliveredBy(events)).toEqual([])
    expect(withheldBy(events).flat()).toEqual([])
    const settled = of(read.seen, "supervisor-settled")[0]
    expect(settled).toMatchObject({ crossed: true, nudged: false })
    expect(settled?.monitors).toContainEqual({ id: "supervisor", kind: "lint", p: 1, crossed: true })
  })

  describe("monitors", () => {
    it("delivers a mood once its streak holds, and withholds the next crossing for its cooldown", async () => {
      const read = untilRead()
      const { layer } = scripted(paranoid, () => 0.1, bouncedFirst)
      const { engine, events, failure } = await run({
        state: state(7),
        script: bouncedRun(7),
        evaluator: layer,
        ...read,
        judged: true,
        monitors: Monitor.moods()
      })
      expect(failure).toBeUndefined()
      expect(of(events, "discipline-armed")[0]?.monitors?.map((monitor) => monitor.id)).toEqual([
        "paranoid",
        "careful",
        "step_back",
        "clarify"
      ])
      // Frame 0's completion is bounced, and its reading — frames carry the
      // refused `complete` — is taken at frame 1's boundary and starts the
      // streak; frame 1's, taken at frame 2's, completes it, so frame 3 is
      // the first request to read it, and every later one reads it once. The
      // bounced frame ages out of the window after frame 2's reading, so the
      // later readings stop crossing.
      expect(carrying(engine, Monitor.paranoidText)).toEqual([0, 0, 0, 1, 1, 1, 1])
      expect(deliveredBy(events)).toEqual(["paranoid"])
      expect(withheldBy(events)).toEqual([
        [],
        [{ id: "paranoid", reason: "streak" }],
        [],
        [{ id: "paranoid", reason: "cooldown" }],
        [],
        [],
        []
      ])
      const settled = of(read.seen, "supervisor-settled")
      expect(settled[0]?.monitors).toContainEqual({ id: "paranoid", kind: "mood", p: 1, crossed: true })
      expect(settled[0]).toMatchObject({ crossed: true, nudged: true })
      expect(settled[3]?.monitors).toContainEqual({ id: "paranoid", kind: "mood", p: 0, crossed: false })
    })

    it("gives the one slot to the lint and withholds a mood crossing beside it", async () => {
      const read = untilRead()
      const { layer } = scripted(() => calm({ thrashing: { probability: 0.9 }, scared: { score: 2 } }))
      const { events, failure } = await run({
        state: state(4),
        script: framesOf(4),
        evaluator: layer,
        ...read,
        judged: true
      })
      expect(failure).toBeUndefined()
      expect(deliveredBy(events)).toEqual(["supervisor", "supervisor"])
      expect(withheldBy(events)).toEqual([
        [],
        [{ id: "careful", reason: "streak" }],
        [{ id: "careful", reason: "slot" }],
        []
      ])
    })

    it("asks a questioned monitor in the one reading and delivers what it says", async () => {
      const read = untilRead()
      const noTestEdits = Monitor.make({
        _tag: "Questioned",
        id: "no_test_edits",
        kind: "lint",
        question: Classifier.boolean({
          instructions: "Did the newest frames edit a test?",
          criteria: { true: "a test file was edited", false: "no test file was edited" }
        }),
        say: () => "Leave the tests alone."
      })
      const { contacted, layer } = scripted((_, ordinal) =>
        ordinal === 0 ? calm({ monitor_no_test_edits: { probability: 0.9 } }) : calm()
      )
      const { engine, events, failure } = await run({
        state: state(4),
        script: framesOf(4),
        evaluator: layer,
        ...read,
        judged: true,
        monitors: [noTestEdits]
      })
      expect(failure).toBeUndefined()
      expect(Object.keys(contacted[0]!.questions)).toContain("monitor_no_test_edits")
      expect(carrying(engine, "Leave the tests alone.")).toEqual([0, 0, 1, 1])
      expect(deliveredBy(events)).toEqual(["no_test_edits"])
      const settled = of(read.seen, "supervisor-settled")
      expect(settled[0]?.monitors).toEqual([{ id: "no_test_edits", kind: "lint", p: 0.9, crossed: true }])
      expect(settled[1]?.monitors).toEqual([{ id: "no_test_edits", kind: "lint", p: 0.05, crossed: false }])
    })

    const skill = (name: string) =>
      new Descriptor.FlowDescriptor({
        ...descriptor(name),
        body: new Descriptor.BodyRefMarkdown({ path: `/skills/${name}/SKILL.md`, baseDirectory: `/skills/${name}` })
      })
    const checklist = skill("review-checklist")
    const skillQuestion = "monitor_skill_review_checklist"
    const reminder = "Read skill `review-checklist` first"
    /** Answers `id` at `p` whenever the request asks it. */
    const answering = (id: string, p: number) => (request: Evaluator.Request) =>
      calm(Object.hasOwn(request.questions, id) ? { [id]: { probability: p } } : {})
    const snapshotOf = (request: Evaluator.Request) => Schema.decodeUnknownSync(Supervisor.Snapshot)(request.state)

    it("reminds a never-called skill once and never again", async () => {
      const read = untilRead()
      const { contacted, layer } = scripted(answering(skillQuestion, 0.9))
      const { engine, events, failure } = await run({
        state: state(9),
        script: framesOf(9),
        flows: [descriptor("read"), checklist],
        evaluator: layer,
        ...read,
        judged: true
      })
      expect(failure).toBeUndefined()
      expect(contacted.every((request) => Object.hasOwn(request.questions, skillQuestion))).toBe(true)
      expect(snapshotOf(contacted[0]!).skills.map((offered) => offered.path)).toEqual([
        "/skills/review-checklist/SKILL.md"
      ])
      expect(carrying(engine, reminder)).toEqual([0, 0, 1, 1, 1, 1, 1, 1, 1])
      expect(deliveredBy(events)).toEqual(["skill_review_checklist"])
      expect(withheldBy(events).flat()).toContainEqual({ id: "skill_review_checklist", reason: "limit" })
    })

    it("stops asking about a skill once the cell has called it", async () => {
      const read = untilRead()
      const { contacted, layer } = scripted(answering(skillQuestion, 0.9))
      const { events, failure } = await run({
        state: state(3),
        script: [
          emits(`await ctx.call("review-checklist", { args: "" })`),
          emits(`console.log("two")`),
          emits(`ctx.done("done")`)
        ],
        calls: [{ _tag: "Success", value: "Check the diff." }],
        flows: [descriptor("read"), checklist],
        evaluator: layer,
        ...read,
        judged: true
      })
      expect(failure).toBeUndefined()
      expect(contacted.length).toBeGreaterThanOrEqual(1)
      expect(contacted.some((request) => Object.hasOwn(request.questions, skillQuestion))).toBe(false)
      expect(snapshotOf(contacted[0]!)).toMatchObject({ skills: [], called: ["review-checklist"] })
      expect(deliveredBy(events)).toEqual([])
    })

    it("stops asking about a skill whose path the cell has read", async () => {
      // #2028: the reminder says to `ctx.call("read", { path })`, and that
      // call settles against the `read` flow, not the skill's name — the
      // exclusion has to read the ledger's subjects, not only its flows.
      const read = untilRead()
      const { contacted, layer } = scripted(answering(skillQuestion, 0.9))
      const { events, failure } = await run({
        state: state(3),
        script: [
          emits(`await ctx.call("read", { path: "/skills/review-checklist/SKILL.md" })`),
          emits(`console.log("two")`),
          emits(`ctx.done("done")`)
        ],
        calls: [{ _tag: "Success", value: "Check the diff." }],
        flows: [descriptor("read"), checklist],
        evaluator: layer,
        ...read,
        judged: true
      })
      expect(failure).toBeUndefined()
      expect(contacted.length).toBeGreaterThanOrEqual(1)
      expect(contacted.some((request) => Object.hasOwn(request.questions, skillQuestion))).toBe(false)
      expect(snapshotOf(contacted[0]!)).toMatchObject({ skills: [], called: ["read"] })
      expect(deliveredBy(events)).toEqual([])
    })

    it("reads the exclusion off a clipped subject too, without hiding a skill nobody read", () => {
      const longPath = `/skills/${"deep/".repeat(40)}SKILL.md`
      const deep = new Descriptor.FlowDescriptor({
        ...descriptor("deep-skill"),
        body: new Descriptor.BodyRefMarkdown({ path: longPath, baseDirectory: "/skills/deep" })
      })
      const entry = CallLedger.entry(1, { flow: "read", input: { path: longPath }, ok: true, value: "body" })
      expect(entry.subject.length).toBeLessThan(longPath.length)
      const offered = Supervision.catalog([descriptor("read"), deep, checklist], [entry])
      expect(offered.skills.map((skill) => skill.path)).toEqual(["/skills/review-checklist/SKILL.md"])
      expect(offered.called).toEqual(["read"])
    })

    it("asks about no skill when the catalog has no read flow", async () => {
      const read = untilRead()
      const { contacted, layer } = scripted(answering(skillQuestion, 0.9))
      const { events, failure } = await run({
        state: state(3),
        script: threeFrames,
        flows: [checklist],
        evaluator: layer,
        ...read,
        judged: true
      })
      expect(failure).toBeUndefined()
      expect(contacted.length).toBeGreaterThanOrEqual(1)
      expect(contacted.flatMap((request) => Object.keys(request.questions)).filter((id) => id.includes("skill")))
        .toEqual([])
      expect(snapshotOf(contacted[0]!)).toMatchObject({ skills: [], jevAvailable: false })
      expect(deliveredBy(events)).toEqual([])
    })

    it("offers the first skills by name and journals the cap", async () => {
      const read = untilRead()
      const { contacted, layer } = scripted(() => calm())
      const names = Array.from({ length: 13 }, (_, index) => `skill-${String(index).padStart(2, "0")}`)
      const { failure } = await run({
        state: state(3),
        script: framesOf(3),
        flows: [descriptor("read"), ...[...names.slice(7), ...names.slice(0, 7)].reverse().map(skill)],
        evaluator: layer,
        ...read,
        judged: true
      })
      expect(failure).toBeUndefined()
      const asked = Object.keys(contacted[0]!.questions).filter((id) => id.startsWith("monitor_skill_"))
      expect(asked).toHaveLength(Supervisor.skillLimit)
      expect(snapshotOf(contacted[0]!).skills.map((offered) => offered.name)).toEqual(names.slice(0, 12))
      const settled = of(read.seen, "supervisor-settled")
      expect(settled[0]?.skillsCapped).toBe(true)
      expect(settled[0]?.monitors?.filter((row) => row.kind === "skill")).toHaveLength(12)
    })

    it.each([[0.9, ["use_jev"]], [0.3, []]] as const)(
      "asks use_jev only with jev in the catalog; at %s it delivers %j",
      async (p, delivered) => {
        const read = untilRead()
        const { contacted, layer } = scripted(answering("monitor_use_jev", p))
        const { engine, events, failure } = await run({
          state: state(5),
          script: framesOf(5),
          flows: [descriptor("jev")],
          evaluator: layer,
          ...read,
          judged: true
        })
        expect(failure).toBeUndefined()
        expect(contacted.every((request) => Object.hasOwn(request.questions, "monitor_use_jev"))).toBe(true)
        expect(deliveredBy(events)).toEqual(delivered)
        expect(carrying(engine, Monitor.useJevText).some((count) => count > 0)).toBe(delivered.length > 0)
      }
    )

    it("never asks use_jev without jev in the catalog", async () => {
      const read = untilRead()
      const { contacted, layer } = scripted(answering("monitor_use_jev", 0.9))
      const { events } = await run({ state: state(3), script: threeFrames, evaluator: layer, ...read, judged: true })
      expect(contacted.length).toBeGreaterThanOrEqual(1)
      expect(contacted.some((request) => Object.hasOwn(request.questions, "monitor_use_jev"))).toBe(false)
      expect(deliveredBy(events)).toEqual([])
    })

    it("gates nothing and leaves the ledger alone when no reading could be taken", async () => {
      const read = untilRead()
      const records = new Map<string, unknown>()
      const { events } = await run({
        state: state(3),
        script: threeFrames,
        evaluator: Evaluator.layerUnavailable(),
        ...read,
        judged: true,
        records
      })
      expect(of(read.seen, "supervisor-unjudged").length).toBeGreaterThanOrEqual(1)
      expect(of(events, "steering-drained").length).toBeGreaterThanOrEqual(2)
      expect(deliveredBy(events)).toEqual([])
      expect(withheldBy(events).flat()).toEqual([])
      const drains = [...records.entries()].filter(([key]) => key.startsWith("steering-drain"))
      expect(drains.length).toBeGreaterThanOrEqual(2)
      for (const [, record] of drains) expect(record).not.toHaveProperty("monitorLedger")
    })
  })

  it("journals a typed unjudged reading and inserts nothing when the evaluator fails", async () => {
    const read = untilRead()
    const { contacted, layer } = scripted(() =>
      Effect.fail(new Evaluator.EvaluatorError({ code: "refused", status: 503, message: "gateway down" }))
    )
    const { events, failure } = await run({
      state: state(3),
      script: threeFrames,
      evaluator: layer,
      ...read,
      judged: true
    })
    expect(failure).toBeUndefined()
    expect(contacted.length).toBeGreaterThanOrEqual(1)
    const unjudged = of(read.seen, "supervisor-unjudged")
    expect(unjudged.length).toBeGreaterThanOrEqual(1)
    expect(unjudged[0]).toMatchObject({ scope: "session-1", frame: 0, reason: "refused", detail: "gateway down" })
    // No level, no word, no default: a failed reading is not a calm one.
    expect(of(read.seen, "supervisor-settled")).toEqual([])
    expect(of(read.seen, "decision-settled").filter((event) => event.classifier === "supervisor/turn")).toEqual([])
    expect(of(events, "steering-drained").flatMap((event) => event.messages)).toEqual([])
  })

  it("charges what a failed supervisor reading paid, and journals it on the unjudged row (#3010)", async () => {
    const read = untilRead()
    const usage = { inputTokens: 60, outputTokens: 3, modelId: "judge" }
    const { layer } = scripted(() =>
      Effect.fail(new Evaluator.EvaluatorError({ code: "invalid_answer", message: "bad", usage }))
    )
    const { engine, failure } = await run({
      state: state(3),
      script: threeFrames,
      evaluator: layer,
      ...read,
      judged: true
    })
    expect(failure).toBeUndefined()
    const unjudged = of(read.seen, "supervisor-unjudged")
    expect(unjudged[0]).toMatchObject({ frame: 0, reason: "invalid_answer", usage: [usage] })
    const paid = engine.recorder.paid.filter((entry) => entry.name === "supervisor").map((entry) => entry.usage)
    expect(paid[0]).toEqual([{ usage: { inputTokens: 60, outputTokens: 3 }, modelId: "judge" }])
  })

  it("names the missing host when no evaluator is bound at all", async () => {
    const read = untilRead()
    const { events } = await run({
      state: state(3),
      script: threeFrames,
      evaluator: Evaluator.layerUnavailable(),
      ...read
    })
    // `layerUnavailable` answers every request `unreachable`, the supervisor's included.
    expect(of(read.seen, "supervisor-unjudged")[0]?.reason).toBe("unreachable")
  })

  describe("a host without a judge (#2163)", () => {
    const unconfigured = new Evaluator.EvaluatorError({ code: "unconfigured", message: "No judge is set up" })
    const refused = new Evaluator.EvaluatorError({ code: "refused", status: 503, message: "gateway down" })
    /** Answers the supervisor's nth request from `script`, and holds each boundary until the one before was asked. */
    const judged = (script: ReadonlyArray<Evaluator.EvaluatorError | "calm">) => {
      const asked = script.map(() => Effect.runSync(Deferred.make<void>()))
      const seen: Array<AgentEvent.AgentEvent> = []
      const { contacted, layer } = scripted((_, ordinal) => {
        if (asked[ordinal] !== undefined) Effect.runSync(Deferred.succeed(asked[ordinal], undefined))
        const answer = script[ordinal] ?? "calm"
        return answer === "calm" ? calm() : Effect.fail(answer)
      })
      return {
        contacted,
        seen,
        evaluator: layer,
        observer: (event: AgentEvent.AgentEvent) => Effect.sync(() => void seen.push(event)),
        steering: steeringAfter((boundary) => {
          const frame = Number(boundary.split(":")[0])
          const held = asked[frame - 1]
          return frame === 0 || held === undefined ? Effect.void : Deferred.await(held)
        })
      }
    }
    const frames = (count: number) => [
      ...Array.from({ length: count - 1 }, (_, index) => emits(`console.log(${index})`)),
      emits(`ctx.done("done")`)
    ]
    /** Each frame's unjudged reason or `settled`, for the frames the script covers. */
    const readings = (seen: ReadonlyArray<AgentEvent.AgentEvent>, count: number) =>
      Array.from(
        { length: count },
        (_, frame) =>
          seen.flatMap((event) =>
            event._tag === "supervisor-unjudged" && event.frame === frame
              ? [event.reason]
              : event._tag === "supervisor-settled" && event.frame === frame
              ? ["settled"]
              : []
          ).join(",")
      )

    it("journals a missing judge once per streak, not once per frame", async () => {
      const probe = judged([unconfigured, unconfigured, unconfigured])
      const { failure } = await run({ state: state(5), script: frames(5), ...probe, judged: true })
      expect(failure).toBeUndefined()
      // Every frame still asks, so a judge connected mid-run is used at once.
      expect(probe.contacted).toHaveLength(3)
      expect(readings(probe.seen, 3)).toEqual(["unconfigured", "", ""])
      expect(of(probe.seen, "supervisor-unjudged")).toHaveLength(1)
    })

    it("uses a judge connected mid-run, and says so again when it goes missing", async () => {
      const probe = judged([unconfigured, "calm", unconfigured])
      await run({ state: state(5), script: frames(5), ...probe, judged: true })
      expect(readings(probe.seen, 3)).toEqual(["unconfigured", "settled", "unconfigured"])
    })

    it("journals every failure of a judge that is set up, and a missing judge after one", async () => {
      const failing = judged([refused, refused, unconfigured])
      await run({ state: state(5), script: frames(5), ...failing, judged: true })
      expect(readings(failing.seen, 3)).toEqual(["refused", "refused", "unconfigured"])
      const between = judged([unconfigured, refused, unconfigured])
      await run({ state: state(5), script: frames(5), ...between, judged: true })
      expect(readings(between.seen, 3)).toEqual(["unconfigured", "refused", "unconfigured"])
    })
  })

  it("writes nothing to memory and shows each recalled row relevance keeps once", async () => {
    const { memory, remembered } = recalling([tests, layout])
    const read = untilRead()
    const { contacted, layer, relevance } = scripted(
      () => calm(),
      (item) => item.id === "tests" ? 0.95 : 0.3
    )
    const prose: ScriptedModel.Step = {
      events: [
        { type: "text-start", id: "t" },
        {
          type: "text-delta",
          id: "t",
          text:
            "The suite is invoked through tox, never pytest directly.\n\nNext I will edit add().\n\n```cell\nconsole.log(\"one\")\n```"
        },
        { type: "text-end", id: "t" },
        { type: "settle", stopReason: "stop" }
      ].map((event) => event as never)
    }
    const { engine, events, failure } = await run({
      // A frame to spare, so the completing boundary waits for frame 2's reading.
      state: state(5),
      script: [prose, emits(`console.log("two")`), emits(`console.log("three")`), emits(`ctx.done("done")`)],
      evaluator: layer,
      ...read,
      judged: true,
      // Nothing for the run-start relevance reading, so every relevance row is the supervisor's.
      pinned: ["fs/list"],
      memory
    })
    expect(failure).toBeUndefined()
    const first = contacted[0]!
    const snapshot = Schema.decodeUnknownSync(Supervisor.Snapshot)(first.state)
    expect(Object.keys(first.questions).filter((key) => /_\d+$/.test(key))).toEqual([])
    // The transcript is mined at run end by `@smthrs/agent`, never by a reading.
    expect(remembered).toEqual([])
    // Rows are asked about by relevance, never by the supervisor, and a row
    // once shown is never asked about again.
    expect(Object.keys(relevance[0]!.questions)).toEqual(["unnecessary_0", "unnecessary_1"])
    expect(relevance.map((request) => itemsOf(request).map((item) => item.id))).toEqual([
      ["tests", "layout"],
      ["tests", "layout"],
      ["tests"]
    ])
    expect(itemsOf(relevance[0]!)[0]).toMatchObject({ kind: "memory", text: tests.text })
    expect((relevance[0]!.state as { readonly context: Relevance.Context }).context).toEqual({
      task: snapshot.task,
      recent: "The suite is invoked through tox, never pytest directly.\n\nNext I will edit add()."
    })
    // Withheld at 0.95, kept at 0.3; delivered at the boundary after frame 0's
    // reading, and not again after frame 1's reading recalled it once more.
    expect(shownBy(events)).toEqual([["layout"]])
    expect(of(events, "steering-drained").flatMap((event) => textsOf(event.supervisor ?? []))).toEqual([
      Supervisor.recalledInsert(layout)
    ])
    const last = engine.recorder.sealStep.at(-1)!.request.messages
    expect(textsOf(last).filter((text) => text.includes(layout.text))).toHaveLength(1)
    const settled = of(read.seen, "supervisor-settled")
    expect(settled[0]).toMatchObject({ nudged: false })
    expect(settled[0]).not.toHaveProperty("remembered")
    expect(of(read.seen, "relevance-settled")[0]).toMatchObject({
      source: "supervisor",
      frame: 0,
      kept: [{ kind: "memory", id: "layout", p: 0.3 }],
      withheld: [{ kind: "memory", id: "tests", p: 0.95 }]
    })
    // The supervisor's decision, the memory decision and settlement, then the verdict.
    expect(
      readingOf(read.seen, 0)
    ).toEqual([
      "supervisor/turn",
      "relevance/unnecessary",
      "relevance-settled",
      "compaction/marks",
      "supervisor-settled"
    ])
  })

  it("recalls past the rows already shown, so later readings surface new ones", async () => {
    const rows = Array.from(
      { length: Supervisor.recalledLimit + 2 },
      (_, n) => ({ key: `row-${n}`, text: `fact ${n}` })
    )
    const { memory } = recalling(rows)
    const read = untilRead()
    const { layer } = scripted(() => calm(), () => 0.3)
    const { events, failure } = await run({
      state: state(7),
      script: framesOf(6),
      evaluator: layer,
      ...read,
      judged: true,
      pinned: ["fs/list"],
      memory
    })
    expect(failure).toBeUndefined()
    expect(shownBy(events)).toEqual([
      rows.slice(0, Supervisor.recalledLimit).map((row) => row.key),
      rows.slice(Supervisor.recalledLimit).map((row) => row.key)
    ])
  })

  it("journals the memory reading and delivers nothing when the host holds no real judge", async () => {
    const { memory } = recalling([layout])
    const read = untilRead()
    const { layer, relevance } = scripted(() => calm())
    const { events, failure } = await run({ state: state(3), script: threeFrames, evaluator: layer, ...read, memory })
    expect(failure).toBeUndefined()
    expect(relevance.length).toBeGreaterThanOrEqual(1)
    expect(of(read.seen, "relevance-settled")[0]).toMatchObject({ source: "supervisor", kept: [{ id: "layout" }] })
    expect(
      of(events, "steering-drained").every((event) => event.supervisor === undefined && event.memory === undefined)
    )
      .toBe(true)
  })

  it("shows every recalled row when relevance cannot answer, and still settles the reading", async () => {
    const { memory } = recalling([tests, layout])
    const read = untilRead()
    const { contacted, layer } = scripted(
      () => calm(),
      new Evaluator.EvaluatorError({ code: "unreachable", message: "down" })
    )
    const { events, failure } = await run({
      state: state(3),
      script: threeFrames,
      evaluator: layer,
      ...read,
      judged: true,
      pinned: ["fs/list"],
      memory
    })
    expect(failure).toBeUndefined()
    expect(contacted.length).toBeGreaterThanOrEqual(1)
    expect(of(read.seen, "decision-unjudged")[0]).toMatchObject({
      scope: "session-1",
      frame: 0,
      classifier: "relevance/unnecessary",
      reason: "unreachable",
      items: 2
    })
    expect(of(read.seen, "relevance-settled")).toEqual([])
    expect(of(read.seen, "supervisor-settled")[0]).toMatchObject({ frame: 0 })
    expect(shownBy(events)).toEqual([["tests", "layout"]])
  })

  it("shows the recalled rows relevance keeps when the supervisor cannot answer", async () => {
    const { memory } = recalling([layout])
    const read = untilRead()
    const { layer } = scripted(() => Effect.fail(new Evaluator.EvaluatorError({ code: "refused", message: "no" })))
    const { events, failure } = await run({
      state: state(3),
      script: threeFrames,
      evaluator: layer,
      ...read,
      judged: true,
      pinned: ["fs/list"],
      memory
    })
    expect(failure).toBeUndefined()
    expect(of(read.seen, "supervisor-unjudged")[0]).toMatchObject({ frame: 0, reason: "refused" })
    expect(
      readingOf(read.seen, 0)
    ).toEqual(["relevance/unnecessary", "relevance-settled", "compaction/marks", "supervisor-unjudged"])
    expect(shownBy(events)).toEqual([["layout"]])
  })

  describe("replay", () => {
    /** A scripted engine whose recorded boundaries persist across attempts. */
    const journaled = (fixture: ScriptedEngine.Fixture, records: Map<string, unknown>) =>
      EngineLike.layer(EngineLike.make({
        ...fixture.engine,
        record: (boundary) => {
          const key = `${boundary.name}\u0000${boundary.identity.frame}\u0000${boundary.identity.boundary}`
          const held = records.get(key)
          if (held !== undefined) {
            return Effect.fromResult(Schema.decodeUnknownResult(boundary.success)(held)).pipe(
              Effect.mapError((cause) => new HarnessError({ code: "engine_failed", message: "did not decode", cause }))
            )
          }
          const encode = Schema.encodeUnknownSync(
            boundary.success as unknown as Schema.Schema<unknown> & { readonly "EncodingServices": never }
          )
          return boundary.execute.pipe(Effect.tap((value) => Effect.sync(() => records.set(key, encode(value)))))
        }
      }))

    const attempt = async (
      records: Map<string, unknown>,
      evaluator: Layer.Layer<Evaluator.Evaluator>,
      read: ReturnType<typeof untilRead>,
      memory: Supervisor.Memory = Supervisor.memoryNone,
      from: CellTurn.State = state(3)
    ) => {
      const model = ScriptedModel.make([
        emits(`console.log("a")`),
        emits(`console.log("b")`),
        emits(`ctx.done("done")`)
      ])
      const events: Array<AgentEvent.AgentEvent> = []
      const engine = ScriptedEngine.make(model.model)
      await CellTurn.run({
        state: from,
        flows: [descriptor("fs/list")],
        judged: true
      })
        .pipe(
          Stream.runForEach((event) => Effect.sync(() => events.push(event))),
          Effect.provide(journaled(engine, records)),
          Effect.provide(QuickJSSandbox.layer),
          Effect.provide(read.steering),
          Effect.provideService(AgentEvent.Observer, read.observer),
          Effect.provideService(Supervisor.Memory, memory),
          Effect.provide(evaluator),
          Effect.runPromise
        )
      return { events, engine }
    }

    it("re-delivers the recorded nudge and makes zero supervisor calls", async () => {
      const records = new Map<string, unknown>()
      const first = scripted((_, ordinal) => ordinal === 0 ? calm({ thrashing: { probability: 0.9 } }) : calm())
      const originalRead = untilRead()
      const original = await attempt(records, first.layer, originalRead)
      expect(first.contacted.length).toBeGreaterThanOrEqual(1)
      expect([...records.keys()].filter((key) => key.startsWith("supervisor")).length).toBeGreaterThanOrEqual(1)

      const again = scripted(() => Effect.fail(new Evaluator.EvaluatorError({ code: "unreachable", message: "asked" })))
      // Every boundary replays, so no frame is offered: nothing to wait for, nothing asked.
      const replayRead = untilRead()
      const replay = await attempt(records, again.layer, replayRead)
      expect(again.contacted).toEqual([])
      const inserts = (events: ReadonlyArray<AgentEvent.AgentEvent>) =>
        of(events, "steering-drained").map((event) =>
          [...event.messages, ...(event.supervisor ?? [])].flatMap((message) =>
            message.content.flatMap((part) => part.type === "text" ? [part.text] : [])
          )
        )
      expect(inserts(replay.events)).toEqual(inserts(original.events))
      expect(inserts(replay.events).flat().filter((text) => text.includes("Supervisor"))).toHaveLength(1)
      // A replayed frame is not read again, and its recorded reading is not
      // re-published either: the journal already holds it.
      expect(of(replayRead.seen, "supervisor-settled")).toEqual([])
      expect(of(replayRead.seen, "supervisor-unjudged")).toEqual([])
      expect(of(originalRead.seen, "supervisor-settled").length).toBeGreaterThanOrEqual(1)
      // The replayed frames read the nudge exactly where the original did.
      expect(replay.engine.recorder.sealStep.map((step) => step.request.messages.length))
        .toEqual(original.engine.recorder.sealStep.map((step) => step.request.messages.length))
    })

    it("replays the rows it showed without asking again, and a resumed state never re-asks one", async () => {
      const records = new Map<string, unknown>()
      const { memory } = recalling([layout])
      const first = scripted(() => calm(), () => 0.3)
      const original = await attempt(records, first.layer, untilRead(), memory)
      expect(first.relevance.length).toBeGreaterThanOrEqual(1)
      expect(shownBy(original.events)).toEqual([["layout"]])

      const again = scripted(() => calm(), () => 0.3)
      const replay = await attempt(records, again.layer, untilRead(), memory)
      expect(again.relevance).toEqual([])
      expect(shownBy(replay.events)).toEqual(shownBy(original.events))

      // The state a checkpoint after that delivery holds, through its codec.
      const resumed = Schema.decodeUnknownSync(CellTurn.State)(
        Schema.encodeUnknownSync(CellTurn.State)(
          new CellTurn.State({ ...state(3), memoryShown: shownBy(original.events).flat() })
        )
      )
      expect(resumed.memoryShown).toEqual(["layout"])
      const fresh = scripted(() => calm(), () => 0.3)
      const live = await attempt(new Map(), fresh.layer, untilRead(), memory, resumed)
      expect(fresh.contacted.length).toBeGreaterThanOrEqual(1)
      expect(fresh.relevance).toEqual([])
      expect(shownBy(live.events)).toEqual([])
    })

    it("replays a monitor's delivery without asking again, and a resumed state keeps its cooldown", async () => {
      const records = new Map<string, unknown>()
      const armed = { judged: true, monitors: Monitor.moods(), script: bouncedRun(4) } as const
      const first = scripted(paranoid, () => 0.1, bouncedFirst)
      const original = await run({ ...armed, state: state(4), evaluator: first.layer, ...untilRead(), records })
      expect(original.failure).toBeUndefined()
      expect(deliveredBy(original.events)).toEqual(["paranoid"])

      // Every boundary replays: nothing is asked and the delivery is the recorded one.
      const again = scripted(() => Effect.fail(new Evaluator.EvaluatorError({ code: "unreachable", message: "asked" })))
      const replay = await run({ ...armed, state: state(4), evaluator: again.layer, ...untilRead(), records })
      expect(again.contacted).toEqual([])
      expect(deliveredBy(replay.events)).toEqual(["paranoid"])
      expect(carrying(replay.engine, Monitor.paranoidText)).toEqual(carrying(original.engine, Monitor.paranoidText))
      expect(carrying(replay.engine, Monitor.paranoidText)).toEqual([0, 0, 0, 1])

      // The state a checkpoint after the delivering boundary holds, through its codec.
      const key = [...records.keys()].find((held) => held.startsWith("steering-drain\u0000session-1\u00002\u0000"))!
      const drained = Schema.decodeUnknownSync(Steering.DrainRecord)(records.get(key))
      expect(drained.monitor).toBe("paranoid")
      const resumed = Schema.decodeUnknownSync(CellTurn.State)(
        Schema.encodeUnknownSync(CellTurn.State)(
          new CellTurn.State({ ...state(6), frame: 3, monitorLedger: drained.monitorLedger! })
        )
      )
      expect(resumed.monitorLedger["paranoid"]).toEqual({ streak: 2, delivered: 1, lastFrame: 2 })
      const fresh = scripted(paranoid, () => 0.1, bouncedFirst)
      const live = await run({
        ...armed,
        script: bouncedRun(3),
        state: resumed,
        evaluator: fresh.layer,
        ...untilRead(3)
      })
      expect(live.failure).toBeUndefined()
      expect(fresh.contacted.length).toBeGreaterThanOrEqual(1)
      expect(deliveredBy(live.events)).toEqual([])
      expect(withheldBy(live.events)).toContainEqual([{ id: "paranoid", reason: "cooldown" }])
    })

    it("decodes a state written before the monitor ledger existed as having delivered nothing", () => {
      const { monitorLedger: _, ...encoded } = Schema.encodeUnknownSync(CellTurn.State)(state(3)) as Record<
        string,
        unknown
      >
      expect(Schema.decodeUnknownSync(CellTurn.State)(encoded).monitorLedger).toEqual({})
    })

    it("decodes a state written before the shown set existed as having shown nothing", () => {
      const { memoryShown: _, ...encoded } = Schema.encodeUnknownSync(CellTurn.State)(state(3)) as Record<
        string,
        unknown
      >
      expect(Schema.decodeUnknownSync(CellTurn.State)(encoded).memoryShown).toEqual([])
    })
  })

  describe("handle", () => {
    const open = (
      evaluator: Layer.Layer<Evaluator.Evaluator>,
      memory: Supervisor.Memory = Supervisor.memoryNone,
      monitors: ReadonlyArray<Monitor.Monitor> = Monitor.defaults()
    ) =>
      Effect.gen(function*() {
        const model = ScriptedModel.make([])
        const engine = ScriptedEngine.make(model.model)
        const events: Array<AgentEvent.AgentEvent> = []
        const handle = yield* Supervision.open({
          session: "session-1",
          engine: engine.engine,
          emit: (event) => Effect.sync(() => void events.push(event)),
          monitors,
          deliver: true
        })
        return { handle, events }
      }).pipe(Effect.provide(evaluator), Effect.provideService(Supervisor.Memory, memory))

    const offer = (
      frame: number,
      shown: ReadonlyArray<string> = [],
      unmarked: Supervision.Offer["unmarked"] = []
    ): Supervision.Offer => ({
      frame,
      digest: `cell-${frame}`,
      current: { frame, cell: "console.log(1)", prose: "", printed: "1", transition: "continue", mutated: false },
      snapshot: {
        task,
        signals: {
          frame,
          maxFrames: 10,
          readOnlyFrames: frame + 1,
          repeatFrames: 0,
          mutations: 0,
          remoteMutations: 0,
          treeMoved: false,
          paths: 0,
          checksRun: 0,
          checksFailing: 0,
          failuresUnanswered: 0,
          callsFailed: 0,
          callsSettled: 0,
          narrowingDemands: 0,
          unmovedDemands: 0,
          unresolvedDemands: 0,
          claimDemands: 0,
          sufficiencyStated: false
        },
        skills: [],
        called: [],
        jevAvailable: false
      },
      shown,
      recent: "",
      skillsCapped: false,
      unmarked,
      failing: []
    })

    const delivering = { ledger: {}, shown: [], deliver: true } as const
    const empty = { messages: [], memory: [], suppressed: [], marks: [], compact: [] }

    it("keeps only the newest snapshot while a reading is in flight", async () => {
      const release = Effect.runSync(Deferred.make<void>())
      const { contacted, layer } = scripted(() =>
        Deferred.await(release).pipe(Effect.as(calm({ thrashing: { probability: 0.9 } })))
      )
      await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
        const { events, handle } = yield* open(layer)
        yield* handle.offer(offer(0))
        // Let the fiber take frame 0 and block on it, then slide two more in.
        yield* Effect.sleep("10 millis")
        yield* handle.offer(offer(1))
        yield* handle.offer(offer(2))
        yield* Deferred.succeed(release, undefined)
        yield* Effect.sleep("50 millis")
        expect(contacted.map((request) => (request.state as { signals: { frame: number } }).signals.frame)).toEqual([
          0,
          2
        ])
        expect(events.filter((event) => event._tag === "supervisor-settled").map((event) => event.frame)).toEqual([
          0,
          2
        ])
      })))
    })

    it("hands a verdict to the boundary of its own frame or the next, and drops it after that", async () => {
      const { layer } = scripted(() => calm({ thrashing: { probability: 0.9 } }))
      await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
        const { handle } = yield* open(layer)
        yield* handle.offer(offer(3))
        yield* Effect.sleep("20 millis")
        expect((yield* handle.take(3, delivering)).messages).toHaveLength(1)
        // Taken once: the same boundary asked again gets nothing.
        expect(yield* handle.take(3, delivering)).toEqual(empty)
        yield* handle.offer(offer(4))
        yield* Effect.sleep("20 millis")
        expect((yield* handle.take(5, delivering)).messages).toHaveLength(1)
        yield* handle.offer(offer(5))
        yield* Effect.sleep("20 millis")
        // A boundary two frames on is stale, and the stale verdict is dropped, not held.
        expect((yield* handle.take(7, delivering)).messages).toEqual([])
        expect((yield* handle.take(6, delivering)).messages).toEqual([])
      })))
    })

    it("marks each segment once, keeps marks a later reading posts, and hands them to a stale boundary", async () => {
      const { layer, marks } = scripted(() => calm())
      const segment = (digest: string) => ({
        digest,
        item: { tokens: 10, cell: `cell ${digest}`, prose: "", observed: "" }
      })
      await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
        const { events, handle } = yield* open(layer)
        yield* handle.offer(offer(0, [], [segment("a")]))
        yield* Effect.sleep("20 millis")
        yield* handle.offer(offer(1, [], [segment("a"), segment("b")]))
        yield* Effect.sleep("20 millis")
        // Frame 1's reading replaced frame 0's, which no boundary took, and
        // kept its marks; `a` was not asked about twice.
        expect(marks.map((request) => (request.state as { readonly items: ReadonlyArray<{ cell: string }> }).items))
          .toEqual([[expect.objectContaining({ cell: "cell a" })], [expect.objectContaining({ cell: "cell b" })]])
        const stale = yield* handle.take(4, delivering)
        expect(stale).toEqual({
          ...empty,
          marks: [{ digest: "a", remove: 0.1, keep: 0.1 }, { digest: "b", remove: 0.1, keep: 0.1 }]
        })
        expect(events.filter((event) => event._tag === "decision-settled" && event.classifier === "compaction/marks"))
          .toHaveLength(2)
      })))
    })

    it("journals decision-unjudged for marks Jev could not answer, and hands the boundary none", async () => {
      const failing = Evaluator.layerScripted((request) =>
        isMarks(request)
          ? Effect.fail(new Evaluator.EvaluatorError({ code: "timeout", message: "late" }))
          : isSupervisor(request)
          ? calm()
          : confident
      )
      await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
        const { events, handle } = yield* open(failing)
        yield* handle.offer(offer(0, [], [{ digest: "a", item: { tokens: 1, cell: "", prose: "", observed: "" } }]))
        yield* Effect.sleep("20 millis")
        expect((yield* handle.take(0, delivering)).marks).toEqual([])
        expect(events.filter((event) => event._tag === "decision-unjudged")).toEqual([
          expect.objectContaining({ classifier: "compaction/marks", reason: "timeout", items: 1 })
        ])
      })))
    })

    it("keeps the transport's usage on the reading and the event", async () => {
      // A transport that answers calm and reports what the answer cost.
      const typed = (answers: Readonly<Record<string, Evaluator.ScriptedAnswer>>): Evaluator.RawAnswers =>
        Object.fromEntries(
          Object.entries(answers).map(([id, answer]) => [
            id,
            "probability" in answer
              ? { type: "boolean", probability: answer.probability }
              : "choice" in answer
              ? { type: "choice", choice: answer.choice }
              : { type: "score", score: answer.score }
          ])
        ) as Evaluator.RawAnswers
      const metered = Layer.succeed(Evaluator.Evaluator)(
        Evaluator.Evaluator.of({
          evaluate: () =>
            Effect.succeed({ answers: typed(calm()), latencyMs: 7, usage: { inputTokens: 321, outputTokens: 12 } })
        })
      )
      await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
        const { events, handle } = yield* open(metered)
        yield* handle.offer(offer(0))
        yield* Effect.sleep("20 millis")
        const settled = events.find((event) => event._tag === "supervisor-settled")
        expect(settled).toMatchObject({ frame: 0, usage: { inputTokens: 321, outputTokens: 12 } })
        // The decision row stays as it was journaled before `Judgement`: usage
        // is priced from `supervisor-settled`, so it is never on both.
        const decision = events.find((event) => event._tag === "decision-settled")
        expect(decision).toBeDefined()
        expect(decision).not.toHaveProperty("usage")
      })))
    })

    it("logs a reading it could not record and keeps serving the next one", async () => {
      const { contacted, layer } = scripted(() => calm())
      let refusals = 0
      await Effect.runPromise(Effect.scoped(
        Effect.gen(function*() {
          const model = ScriptedModel.make([])
          const engine = ScriptedEngine.make(model.model)
          const events: Array<AgentEvent.AgentEvent> = []
          const handle = yield* Supervision.open({
            session: "session-1",
            engine: {
              ...engine.engine,
              record: (boundary) =>
                boundary.identity.frame === 0
                  ? Effect.suspend(() => {
                    refusals += 1
                    return Effect.fail(new HarnessError({ code: "engine_failed", message: "journal closed" }))
                  })
                  : boundary.execute
            },
            emit: (event) => Effect.sync(() => void events.push(event)),
            monitors: Monitor.defaults(),
            deliver: true
          })
          yield* handle.offer(offer(0))
          yield* Effect.sleep("20 millis")
          yield* handle.offer(offer(1))
          yield* Effect.sleep("20 millis")
          // The refused frame journaled nothing and delivered nothing; the next one was read as usual.
          expect(refusals).toBe(1)
          expect(events.map((event) => [event._tag, "frame" in event ? event.frame : -1])).toEqual([
            ["decision-settled", 1],
            ["supervisor-settled", 1]
          ])
          expect(yield* handle.take(2, delivering)).toMatchObject(empty)
        }).pipe(Effect.provide(layer))
      ))
      expect(contacted).toHaveLength(1)
    })

    it("recalls only when a memory is bound and asks relevance nothing when nothing was recalled", async () => {
      const { contacted, layer, relevance } = scripted(() => calm())
      await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
        const { events, handle } = yield* open(layer)
        yield* handle.offer(offer(0))
        yield* Effect.sleep("20 millis")
        expect(contacted).toHaveLength(1)
        expect(relevance).toEqual([])
        expect(events.map((event) => event._tag)).toEqual(["decision-settled", "supervisor-settled"])
      })))
    })

    it("never asks about a row shown by the offer, and drops at the boundary a row shown since", async () => {
      const { layer, relevance } = scripted(() => calm(), () => 0.2)
      const { memory } = recalling([tests, layout])
      await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
        const { handle } = yield* open(layer, memory)
        yield* handle.offer(offer(0, ["tests"]))
        yield* Effect.sleep("20 millis")
        expect(relevance.map((request) => itemsOf(request).map((item) => item.id))).toEqual([["layout"]])
        expect(yield* handle.take(1, { ledger: {}, shown: ["tests", "layout"], deliver: true })).toMatchObject({
          messages: [],
          memory: []
        })
        yield* handle.offer(offer(1))
        yield* Effect.sleep("20 millis")
        // Undelivered while no real judge is held, and taken all the same.
        expect(yield* handle.take(2, { ledger: {}, shown: [], deliver: false })).toEqual(empty)
        expect(yield* handle.take(2, delivering)).toEqual(empty)
        yield* handle.offer(offer(2))
        yield* Effect.sleep("20 millis")
        const taken = yield* handle.take(3, { ledger: {}, shown: ["tests"], deliver: true })
        expect(taken.memory).toEqual(["layout"])
        expect(textsOf(taken.messages)).toEqual([Supervisor.recalledInsert(layout)])
      })))
    })

    it("puts the nudge ahead of the memory it delivers", async () => {
      const { layer } = scripted(() => calm({ thrashing: { probability: 0.9 } }), () => 0.2)
      const { memory } = recalling([layout])
      await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
        const { handle } = yield* open(layer, memory)
        yield* handle.offer(offer(0))
        yield* Effect.sleep("20 millis")
        const taken = yield* handle.take(1, delivering)
        expect(taken.memory).toEqual(["layout"])
        const texts = textsOf(taken.messages)
        expect(texts).toHaveLength(2)
        expect(texts[0]).toContain("Supervisor")
        expect(texts[1]).toBe(Supervisor.recalledInsert(layout))
      })))
    })
  })

  describe("read", () => {
    const snapshot: Supervisor.Snapshot = {
      task,
      frames: [],
      signals: {
        frame: 0,
        maxFrames: 1,
        readOnlyFrames: 0,
        repeatFrames: 0,
        mutations: 0,
        remoteMutations: 0,
        treeMoved: false,
        paths: 0,
        checksRun: 0,
        checksFailing: 0,
        failuresUnanswered: 0,
        callsFailed: 0,
        callsSettled: 0,
        narrowingDemands: 0,
        unmovedDemands: 0,
        unresolvedDemands: 0,
        claimDemands: 0,
        sufficiencyStated: false
      },
      skills: [],
      called: [],
      jevAvailable: false
    }

    it("names the host that bound no evaluator, without asking anything", async () => {
      // The requirement is satisfied by the type and delivered by nothing: the
      // one case the compiler cannot rule out, so the reading says so itself.
      const result = await Effect.runPromise(Effect.result(Supervisor.read(snapshot, {})))
      expect(result).toEqual(Result.fail({ reason: "unconfigured", detail: "No evaluator is installed on this host" }))
    })

    it("adds each monitor question after the fixed ones, and declares again when one asks otherwise", () => {
      const question = (instructions: string) =>
        Classifier.boolean({ instructions, criteria: { true: "yes", false: "no" } })
      const one = question("One?")
      const held = Supervisor.classifierFor({ monitor_x: one })
      expect(Supervisor.classifierFor({ monitor_x: one })).toBe(held)
      expect(Object.keys(held.questions).at(-1)).toBe("monitor_x")
      const other = Supervisor.classifierFor({ monitor_x: question("Two?") })
      expect(other).not.toBe(held)
      expect(other.digest).not.toBe(held.digest)
      expect(Supervisor.classifierFor({})).toBe(Supervisor.classifier)
      expect(Object.keys(Supervisor.classifier.questions)).toHaveLength(11)
    })
  })

  describe("memory port", () => {
    it("recalls nothing and writes nothing when nothing is bound", async () => {
      expect(Supervisor.memoryNone.bound).toBe(false)
      expect(await Effect.runPromise(Supervisor.memoryNone.recall("anything", 3))).toEqual([])
      expect(await Effect.runPromise(Supervisor.memoryNone.remember("anything"))).toBeUndefined()
      expect(await Effect.runPromise(Effect.map(Supervisor.Memory, (memory) => memory.bound))).toBe(false)
    })

    it("the idle handle drops offers and hands every boundary nothing", async () => {
      await Effect.runPromise(Supervision.none.offer({
        frame: 0,
        digest: "c",
        current: { frame: 0, cell: "", prose: "", printed: "", transition: "continue", mutated: false },
        snapshot: {
          task,
          signals: {
            frame: 0,
            maxFrames: 1,
            readOnlyFrames: 0,
            repeatFrames: 0,
            mutations: 0,
            remoteMutations: 0,
            treeMoved: false,
            paths: 0,
            checksRun: 0,
            checksFailing: 0,
            failuresUnanswered: 0,
            callsFailed: 0,
            callsSettled: 0,
            narrowingDemands: 0,
            unmovedDemands: 0,
            unresolvedDemands: 0,
            claimDemands: 0,
            sufficiencyStated: false
          },
          skills: [],
          called: [],
          jevAvailable: false
        },
        shown: [],
        recent: "",
        skillsCapped: false,
        unmarked: [],
        failing: []
      }))
      expect(await Effect.runPromise(Supervision.none.take(0, { ledger: {}, shown: [], deliver: true }))).toEqual({
        messages: [],
        memory: [],
        suppressed: [],
        marks: [],
        compact: []
      })
    })
  })

  describe("text", () => {
    it("clips a frame's prints to their newest bytes and says so", () => {
      expect(Supervisor.tail("short")).toBe("short")
      const long = "x".repeat(Supervisor.frameBytes + 10)
      const clipped = Supervisor.tail(long)
      expect(clipped.startsWith("[… older bytes elided]\n")).toBe(true)
      expect(clipped.endsWith("x".repeat(Supervisor.frameBytes))).toBe(true)
    })

    it("strips a fenced cell from the model's prose", () => {
      expect(Supervisor.prose("Plan.\n\n```cell\nctx.done(1)\n```\n\nAfter.")).toBe("Plan.\n\n\n\nAfter.")
      expect(Supervisor.prose("```typescript\nlet x = 1")).toBe("")
    })
  })

  describe("judge", () => {
    const reading = (overrides: Partial<Supervisor.Reading> = {}): Supervisor.Reading => ({
      thrashing: 0.1,
      onTarget: 0.9,
      suspect: 0.1,
      outdatedContext: 0.1,
      irrelevantContext: 0.1,
      emotions: { frustrated: "none", anxious: "none", scared: "none", confused: "none", confident: "strong" },
      needsHelp: "none",
      monitors: {},
      latencyMs: 1,
      asked: { digest: "d", questions: {}, state: null, answers: {} },
      ...overrides
    })
    const snapshot: Supervisor.Snapshot = {
      task,
      frames: [],
      signals: {
        frame: 2,
        maxFrames: 10,
        readOnlyFrames: 0,
        repeatFrames: 2,
        mutations: 1,
        remoteMutations: 0,
        treeMoved: true,
        paths: 3,
        checksRun: 1,
        checksFailing: 1,
        failuresUnanswered: 1,
        callsFailed: 0,
        callsSettled: 4,
        narrowingDemands: 0,
        unmovedDemands: 0,
        unresolvedDemands: 0,
        claimDemands: 0,
        sufficiencyStated: false
      },
      skills: [],
      called: [],
      jevAvailable: false
    }

    it("crosses on any of the three thresholds and names the counts behind it", () => {
      expect(Supervisor.crosses(reading())).toBe(false)
      for (const crossed of [{ thrashing: 0.5 }, { onTarget: 0.5 }, { suspect: 0.5 }] as const) {
        expect(Supervisor.crosses(reading(crossed))).toBe(true)
        const text = Supervisor.nudge(snapshot, reading(crossed))
        expect(text).toContain("1 check last reported failing")
        expect(text).toContain("2 consecutive frames repeated earlier calls")
      }
    })

    it("compacts instead of nudging on outdated or irrelevant context", () => {
      expect(Supervisor.compacting(reading())).toEqual([])
      for (
        const [obsolete, fired] of [
          [{ outdatedContext: 0.9 }, ["outdated_context"]],
          [{ irrelevantContext: 0.9 }, ["irrelevant_context"]],
          [{ outdatedContext: 0.5, irrelevantContext: 0.5 }, ["outdated_context", "irrelevant_context"]],
          [{ outdatedContext: 0.49, irrelevantContext: 0.49 }, []]
        ] as const
      ) {
        expect(Supervisor.crosses(reading(obsolete))).toBe(false)
        expect(Supervisor.compacting(reading(obsolete))).toEqual(fired)
      }
      const both = reading({ thrashing: 0.9, outdatedContext: 0.9 })
      expect(Supervisor.crosses(both)).toBe(true)
      expect(Supervisor.compacting(both)).toEqual(["outdated_context"])
      const text = Supervisor.nudge(snapshot, both)
      expect(text).toContain("thrashing 0.90")
      expect(text).not.toContain("context")
      expect(text).not.toMatch(/compact/i)
    })

    it("names the frame its counts describe", () => {
      const text = Supervisor.nudge(snapshot, reading({ thrashing: 0.9 }))
      expect(text).toContain("Evidence at frame 2:")
      expect(text).toContain("through frame 2")
    })

    it("decides crossing by one shared rule that names each trigger", () => {
      const cases: ReadonlyArray<readonly [Partial<Supervisor.Reading>, ReadonlyArray<Supervisor.Trigger>]> = [
        [{}, []],
        [{ thrashing: 0.5 }, ["thrashing"]],
        [{ thrashing: 0.49 }, []],
        [{ onTarget: 0.5 }, ["off_target"]],
        [{ onTarget: 0.51 }, []],
        [{ suspect: 0.5 }, ["suspect"]],
        [{ outdatedContext: 0.5 }, ["outdated_context"]],
        [{ irrelevantContext: 0.5 }, ["irrelevant_context"]],
        [{ thrashing: 0.9, irrelevantContext: 0.9 }, ["thrashing", "irrelevant_context"]]
      ]
      for (const [overrides, fired] of cases) {
        const read = reading(overrides)
        expect(Supervisor.triggered(read)).toEqual(fired)
        expect(Supervisor.crosses(read)).toBe(fired.some((name) => !name.endsWith("_context")))
        expect(Supervisor.compacting(read)).toEqual(fired.filter((name) => name.endsWith("_context")))
      }
      expect(Object.keys(Supervisor.triggers)).toEqual([
        "thrashing",
        "off_target",
        "suspect",
        "outdated_context",
        "irrelevant_context"
      ])
    })

    it("names only the evidence the counts hold", () => {
      const quiet: Supervisor.Snapshot = {
        ...snapshot,
        signals: {
          ...snapshot.signals,
          repeatFrames: 0,
          checksFailing: 0,
          failuresUnanswered: 0,
          callsFailed: 0,
          readOnlyFrames: 3,
          mutations: 0
        }
      }
      const text = Supervisor.nudge(quiet, reading({ thrashing: 0.7, onTarget: 0.2, suspect: 0.6 }))
      expect(text).toContain("thrashing 0.70")
      expect(text).toContain("on target 0.20")
      expect(text).toContain("suspect 0.60")
      expect(text).toContain("3 consecutive frames changed nothing; 0 frames changed the workspace")
      expect(text).not.toContain("failing")
      expect(text).not.toContain("repeated")
      expect(text).not.toContain("calls failed")
      const plural = Supervisor.nudge(
        { ...snapshot, signals: { ...snapshot.signals, checksFailing: 2, failuresUnanswered: 2, callsFailed: 1 } },
        reading({ thrashing: 0.9 })
      )
      expect(plural).toContain("2 checks last reported failing")
      expect(plural).toContain("2 failing checks never answered by a pass")
      expect(plural).toContain("1 of 4 calls failed")
      expect(plural).toContain("1 frame changed the workspace")
    })

    it("needs_help never crosses on its own", () => {
      expect(Supervisor.crosses(reading({ needsHelp: "risky_action" }))).toBe(false)
    })
  })
})

describe("Supervisor inserts on the transcript", () => {
  const textOf = (message: ModelRequest.Message): string =>
    message.content.flatMap((part) => part.type === "text" ? [part.text] : []).join("\n")

  /** An evaluator that crosses on frame 0's reading, is calm after it, and records every request. */
  const crossingOnce = () => {
    const supervisor: Array<Evaluator.Request> = []
    const completion: Array<Evaluator.Request> = []
    const layer = Evaluator.layerScripted((request) => {
      if (isMarks(request)) {
        return Object.fromEntries(Object.keys(request.questions).map((key) => [key, { probability: 0.1 }] as const))
      }
      if (!isSupervisor(request)) {
        completion.push(request)
        return confident
      }
      supervisor.push(request)
      return supervisor.length === 1 ? calm({ thrashing: { probability: 0.9 } }) : calm()
    })
    return { layer, supervisor, completion }
  }

  it("keeps a supervisor nudge out of the completion task and later snapshots while the model reads it", async () => {
    const read = untilRead()
    const evaluator = crossingOnce()
    const { engine, events, failure } = await run({
      // A frame to spare, so the completing boundary waits for frame 2's reading.
      state: state(5),
      script: [
        emits(`console.log("a")`),
        emits(`console.log("b")`),
        emits(`console.log("c")`),
        emits(`ctx.done("done")`)
      ],
      evaluator: evaluator.layer,
      ...read,
      judged: true,
      // Nothing for the run-start relevance reading, so every other request
      // is the completion brake's.
      pinned: ["fs/list"]
    })
    expect(failure).toBeUndefined()
    // The model read the nudge.
    const transcript = engine.recorder.sealStep.flatMap((step) => step.request.messages.map(textOf))
    expect(transcript.filter((text) => text.includes("Supervisor"))).not.toEqual([])
    // The drain names it as the supervisor's, not the person's.
    expect(of(events, "steering-drained").flatMap((event) => event.messages)).toEqual([])
    expect(of(events, "steering-drained").flatMap((event) => event.supervisor ?? []).map(textOf).join())
      .toContain("Supervisor")
    // The completion brake's task and every later snapshot's task carry none of it.
    expect(evaluator.completion).toHaveLength(1)
    const claimed = evaluator.completion[0]!.state as { readonly task: string }
    expect(claimed.task).toContain(task)
    expect(claimed.task).not.toContain("Supervisor")
    expect(claimed.task).not.toContain("The person now says")
    expect(evaluator.supervisor.length).toBeGreaterThanOrEqual(3)
    for (const request of evaluator.supervisor) {
      const snapshot = Schema.decodeUnknownSync(Supervisor.Snapshot)(request.state)
      expect(snapshot.task).not.toContain("Supervisor")
    }
  })

  const pathsToTheAsk = [
    { name: "a raised cell", frame: emits(`throw new Error("boom")`), ask: "The cell threw" },
    { name: "a parse rejection", frame: prose("I will think about it first."), ask: "No cell was found" }
  ] as const

  it.each(pathsToTheAsk)("puts a supervisor insert above the ask on $name", async ({ ask, frame }) => {
    // Only frame 1's boundary waits, for frame 0's reading: a rejected frame
    // is never offered, so no later boundary has a reading of its own to wait for.
    const settled = Effect.runSync(Deferred.make<void>())
    const read = {
      observer: (event: AgentEvent.AgentEvent) =>
        event._tag === "supervisor-settled" && event.frame === 0
          ? Effect.asVoid(Deferred.succeed(settled, undefined))
          : Effect.void,
      steering: steeringAfter((boundary) => boundary.startsWith("1:") ? Deferred.await(settled) : Effect.void)
    }
    const evaluator = crossingOnce()
    const { engine, failure } = await run({
      // No in-frame re-ask, so a cell-less answer takes the rejection exit.
      state: state(4, 0),
      script: [emits(`console.log("a")`), frame, emits(`console.log("c")`), emits(`ctx.done("done")`)],
      evaluator: evaluator.layer,
      ...read,
      judged: true
    })
    expect(failure).toBeUndefined()
    // Frame 1's boundary delivers frame 0's reading; frame 2 is the first to read it.
    const messages = engine.recorder.sealStep[2]!.request.messages.map(textOf)
    const lastIndex = (needle: string): number =>
      messages.reduce((found, text, index) => text.includes(needle) ? index : found, -1)
    const nudge = lastIndex("Supervisor")
    const asked = lastIndex(ask)
    expect(nudge).toBeGreaterThanOrEqual(0)
    expect(asked).toBeGreaterThan(nudge)
  })

  it("journals an unreachable reading with the jev flow's masked text, never the transport's own", async () => {
    const read = untilRead()
    const { layer } = scripted(() =>
      Effect.fail(
        new Evaluator.EvaluatorError({
          code: "unreachable",
          message: "connect ECONNREFUSED https://judge.internal.example:8443/v4?token=abc"
        })
      )
    )
    const { failure } = await run({ state: state(3), script: threeFrames, evaluator: layer, ...read })
    expect(failure).toBeUndefined()
    const unjudged = of(read.seen, "supervisor-unjudged")
    expect(unjudged.length).toBeGreaterThanOrEqual(1)
    expect(unjudged[0]).toMatchObject({ reason: "unreachable", detail: Evaluator.unreachableMessage })
    expect(JSON.stringify(unjudged)).not.toContain("judge.internal")
  })

  it("journals a reading still in flight when the run ends as interrupted, within the bound", async () => {
    const { contacted, layer } = scripted(() => Effect.never)
    const started = Date.now()
    const { events, failure } = await run({
      state: state(3),
      script: threeFrames,
      evaluator: layer,
      steering: steeringAfter(() => Effect.sleep("5 millis"))
    })
    const elapsed = Date.now() - started
    expect(failure).toBeUndefined()
    expect(of(events, "resolved")).toHaveLength(1)
    expect(contacted.length).toBeGreaterThanOrEqual(1)
    // Exactly the reading that was asked and never answered, typed, and nothing settled.
    const unjudged = of(events, "supervisor-unjudged")
    expect(unjudged).toHaveLength(1)
    expect(unjudged[0]).toMatchObject({ scope: "session-1", reason: "interrupted" })
    expect(of(events, "supervisor-settled")).toEqual([])
    // The grace is bounded: the run ends however long the reading would have taken.
    expect(elapsed).toBeLessThan(Supervisor.closeGraceMs + 3_000)
  })

  it("lets a reading in flight when the run ends settle inside the grace", async () => {
    const { contacted, layer } = scripted(() => Effect.as(Effect.sleep("150 millis"), calm()))
    const { events, failure } = await run({
      state: state(3),
      script: threeFrames,
      evaluator: layer,
      steering: steeringAfter(() => Effect.sleep("5 millis"))
    })
    expect(failure).toBeUndefined()
    expect(contacted.length).toBeGreaterThanOrEqual(1)
    // Every reading the fiber took settled; none was cut off by the run's end.
    expect(of(events, "supervisor-unjudged")).toEqual([])
    expect(of(events, "supervisor-settled")).toHaveLength(contacted.length)
  })

  it.each([false, true])("stamps every reading with the delivery it ran under (judged: %s)", async (judged) => {
    const read = untilRead()
    const { layer } = scripted(() => calm())
    const { failure } = await run({
      state: state(3),
      script: threeFrames,
      evaluator: layer,
      ...read,
      judged
    })
    expect(failure).toBeUndefined()
    const settled = of(read.seen, "supervisor-settled")
    expect(settled.length).toBeGreaterThanOrEqual(1)
    // `discipline-armed` is written once, at frame 0; a resumed run armed
    // differently is only on the record through the readings it takes.
    expect(settled.map((event) => event.steer)).toEqual(settled.map(() => judged))
  })

  it("journals a typed memory failure for a recall the store refused, and never writes", async () => {
    const memory: Supervisor.Memory = {
      bound: true,
      recall: () => Effect.fail({ detail: "database is locked" }),
      remember: () => Effect.die("the supervisor never writes memory")
    }
    const read = untilRead()
    const { layer } = scripted(() => calm())
    const { failure } = await run({
      state: state(3),
      script: threeFrames,
      evaluator: layer,
      ...read,
      memory
    })
    expect(failure).toBeUndefined()
    const failed = of(read.seen, "supervisor-memory-failed")
    expect(failed.length).toBeGreaterThanOrEqual(1)
    expect(failed.every((event) => event.operation === "recall")).toBe(true)
    expect(failed[0]).toMatchObject({ scope: "session-1", frame: 0, detail: "database is locked" })
    // The reading itself still settles: a memory fault is not a supervisor fault.
    expect(of(read.seen, "supervisor-settled").length).toBeGreaterThanOrEqual(1)
  })
})
