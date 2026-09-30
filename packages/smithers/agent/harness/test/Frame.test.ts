/**
 * The frame's pure phases, judged without a model, a sandbox or an engine.
 *
 * `CellTurn.test.ts` drives these through whole frames; this pins each phase on
 * the inputs that decide it, so a precedence or accounting rule is read off one
 * call rather than inferred from a journal.
 */
import { ModelRequest } from "@smthrs/model"
import * as Evaluator from "@smthrs/model/Evaluator"
import { Effect, Option } from "effect"
import { describe, expect, it } from "vitest"
import * as CellTurn from "../src/CellTurn.ts"
import * as ContextWindow from "../src/ContextWindow.ts"
import * as EngineLike from "../src/EngineLike.ts"
import * as Frame from "../src/internal/frame.ts"
import * as NarrowedCheck from "../src/NarrowedCheck.ts"
import * as Sufficiency from "../src/Sufficiency.ts"

const base = CellTurn.make({
  session: "session-1",
  seat: "anthropic:test-model",
  modelParams: ModelRequest.GenerationParams.make(),
  layers: [],
  capabilityEnvelope: [],
  placement: Option.none(),
  contextWindow: ContextWindow.empty("test-model"),
  maxFrames: 10
})

const state = (changes: Frame.StateChanges = {}): CellTurn.State => new CellTurn.State({ ...base, ...changes })

const tree = (digest: string, complete = true) =>
  Option.some(new EngineLike.Observation({ digest, paths: 3, complete }))

const call = (changes: Partial<Frame.ObservedCall> = {}): Frame.ObservedCall => ({
  flow: "bash",
  ok: true,
  summary: "",
  ordinal: 1,
  mutates: false,
  remote: false,
  signature: "pytest tests",
  subject: "pytest tests",
  at: undefined,
  input: { command: "pytest tests" },
  value: { exitCode: 0 },
  message: undefined,
  invalidProbe: undefined,
  failing: false,
  passing: true,
  ...changes
})

const account = (options: {
  readonly state?: CellTurn.State
  readonly calls?: ReadonlyArray<Frame.ObservedCall>
  readonly opened?: Option.Option<EngineLike.Observation>
  readonly closed?: Option.Option<EngineLike.Observation>
  readonly minted?: ReadonlyArray<string>
}) =>
  Frame.account({
    state: options.state ?? state(),
    calls: options.calls ?? [],
    opened: options.opened ?? Option.none(),
    closed: options.closed ?? Option.none(),
    minted: options.minted ?? [],
    bindings: [],
    captures: []
  })

describe("account", () => {
  it("lets a complete measurement that held still overrule a failed write's declaration", () => {
    const held = account({
      state: state({ readOnlyFrames: 2 }),
      calls: [call({ ok: false, mutates: true, passing: false })],
      opened: tree("t0"),
      closed: tree("t0")
    })
    expect(held.mutated).toBe(false)
    expect(held.facts.readOnlyFrames).toBe(3)
    expect(held.observed).toMatchObject({ basis: "observed", mutated: false, declaredWrites: 1 })
  })

  it("keeps a failed write's declaration when the measurement cannot contradict it", () => {
    const partial = account({
      state: state({ readOnlyFrames: 2, readOnlyGrace: 3, pendingReadOnlyDemand: { streak: 4, cap: 4 } }),
      calls: [call({ ok: false, mutates: true, passing: false })],
      opened: tree("t0", false),
      closed: tree("t0", false)
    })
    expect(partial.mutated).toBe(true)
    expect(partial.observed.basis).toBe("partial")
    expect(partial.facts).toMatchObject({ readOnlyFrames: 0, readOnlyGrace: 0, mutations: 1 })
    expect("pendingReadOnlyDemand" in partial.facts && partial.facts.pendingReadOnlyDemand === undefined).toBe(true)
    expect(account({ calls: [call({ ok: false, mutates: true })] }).observed.basis).toBe("declared")
  })

  it("counts a write a call measured on a tree the host walk does not cover", () => {
    // The container case, measured 2026-09-22 on Terminal-Bench 4.0: every
    // edit went through `docker exec`, the host tree held still at both ends
    // of every frame, and the run failed `read_only_cap` with the work done.
    // `bash` now fingerprints the container's directory itself and reports
    // the move on the result; the frame counts it as a standing write.
    const written = account({
      state: state({ readOnlyFrames: 3, remoteMutations: 1 }),
      calls: [call({ mutates: true, remote: true, value: { exitCode: 0, mutated: true } })],
      opened: tree("t0"),
      closed: tree("t0")
    })
    expect(written.mutated).toBe(true)
    expect(written.facts.readOnlyFrames).toBe(0)
    expect(written.facts.mutations).toBe(1)
    expect(written.facts.remoteMutations).toBe(2)
    expect(written.observed).toMatchObject({ basis: "observed", mutated: true, declaredWrites: 1 })
    // The host measurement holding still does not contradict a remote write
    // the way it contradicts a failed host write: it never covered that tree.
    const failed = account({
      calls: [call({ ok: false, mutates: true, remote: true })],
      opened: tree("t0"),
      closed: tree("t0")
    })
    expect(failed.mutated).toBe(false)
    expect(failed.facts.remoteMutations).toBe(0)
  })

  it("counts a change nothing declared", () => {
    const moved = account({ state: state({ repeatFrames: 2 }), opened: tree("t0"), closed: tree("t1") })
    expect(moved.mutated).toBe(true)
    expect(moved.workspaceDigest).toBe("t1")
    // No call is no observation: the repeat streak is carried, not cleared.
    expect(moved.facts.repeatFrames).toBe(2)
  })

  it("advances the repeat streak only for a frame that asked nothing new and changed nothing", () => {
    const asked = state({ callSignatures: ["pytest tests"], repeatFrames: 1 })
    expect(account({ state: asked, calls: [call()] }).facts.repeatFrames).toBe(2)
    expect(account({ state: asked, calls: [call({ signature: "pytest other" })] }).facts.repeatFrames).toBe(0)
    expect(account({ state: asked, calls: [call({ mutates: true })] }).facts.repeatFrames).toBe(0)
  })

  it("fixes the opening digest from the first complete opening measurement and never restamps it", () => {
    expect(account({ opened: tree("t0", false), closed: tree("t0") }).facts.openingDigest).toBe("")
    expect(account({ opened: tree("t0"), closed: tree("t1") }).facts.openingDigest).toBe("t0")
    expect(account({ state: state({ openingDigest: "origin" }), opened: tree("t0") }).facts.openingDigest).toBe(
      "origin"
    )
  })

  it("keeps a checkpointed reading out of the live check ledger and in the failure ledger", () => {
    const pinned = account({
      calls: [call({ at: "cp-0-1", failing: true, passing: false })],
      opened: tree("t0"),
      closed: tree("t0")
    })
    expect(pinned.frameChecks).toEqual([])
    expect(pinned.facts.checks).toEqual([])
    expect(pinned.facts.failures.map((failure) => failure.signature)).toEqual(["pytest tests"])
  })

  it("carries the frame's pins and states its invalid probes once", () => {
    const probed = account({
      state: state({ checkpointIds: ["cp-0-1"] }),
      calls: [call({ invalidProbe: { reason: "unknown_test", message: "no such test" } })],
      minted: ["cp-1-1"]
    })
    expect(probed.facts.checkpointIds).toEqual(["cp-0-1", "cp-1-1"])
    expect(probed.probeNotice).toContain("- bash (unknown_test): no such test")
    expect(account({ calls: [call()] }).probeNotice).toBeUndefined()
  })
})

describe("judgeCompletion", () => {
  // Changed and then reverted: the run closes on the tree it opened on, and its
  // only check narrows a broader one taken over a tree in between.
  const broad = NarrowedCheck.check({
    flow: "bash",
    signature: "pytest tests",
    input: { command: "pytest tests" },
    digest: "t-edited",
    passing: true
  })!
  const reverted = (changes: Frame.StateChanges = {}) => state({ openingDigest: "t0", checks: [broad], ...changes })
  const narrow = call({
    signature: "pytest tests -k parser",
    subject: "pytest tests -k parser",
    input: { command: "pytest tests -k parser" }
  })
  // Judged against an evaluator that would fail every request. These four
  // cases are about the deterministic precedence, and the brake that could
  // reach a transport is the sixth: a claim one of the four bounced never
  // gets there, and one none of them bounced has no task text to ask about.
  // `CompletionClaim.test.ts` is where that brake is driven.
  const judge = (judged: CellTurn.State) =>
    Effect.runSync(
      Frame.judgeCompletion(
        judged,
        account({ state: judged, calls: [narrow], opened: tree("t0"), closed: tree("t0") }),
        judged.contextWindow,
        "done"
      ).pipe(Effect.provide(Evaluator.layerUnavailable()))
    )

  it("names a narrowed check on an unmoved tree, and spends only its own cap", () => {
    // An unmoved tree alone is no demand: it waits on the claim brake (#2937).
    const { demand } = judge(reverted())
    expect(demand?.event).toMatchObject({ _tag: "narrowed-demanded", nextFrame: 1 })
    expect(demand?.spent).toEqual({ narrowingDemands: 1 })
  })

  it("demands nothing for an unmoved tree once the narrowing cap is spent", () => {
    expect(judge(reverted({ narrowingDemands: 1 }))).toEqual({
      observed: undefined,
      demand: undefined
    })
  })

  it("demands nothing once every cap it could spend is spent", () => {
    expect(judge(reverted({ unmovedDemands: 1, narrowingDemands: 1 }))).toEqual({
      observed: undefined,
      demand: undefined
    })
  })

  it("demands nothing without a frame to answer in", () => {
    expect(judge(reverted({ frame: 9 })).demand).toBeUndefined()
    // One read-only frame short of twice the cap: the bounce would end the run.
    expect(judge(reverted({ readOnlyCap: 2, readOnlyFrames: 2 })).demand).toBeUndefined()
    // The frame a demand was handed to is not judged again.
    expect(judge(reverted({ frame: 3, demandedFrame: 3 })).demand).toBeUndefined()
  })
})

describe("discipline", () => {
  const disciplined = (
    judged: CellTurn.State,
    facts: Partial<Frame.Accounting["facts"]>,
    justification?: string
  ) => {
    const accounting = account({ state: judged })
    return Frame.discipline(judged, { ...accounting, facts: { ...accounting.facts, ...facts } }, justification)
  }

  it("issues the read-only demand at the cap and waits for it to be answered", () => {
    const demanded = disciplined(state({ readOnlyCap: 3 }), { readOnlyFrames: 3 })
    expect(demanded.events.map((event) => event._tag)).toEqual(["read-only-demand-issued"])
    expect(demanded.messages).toHaveLength(1)
    expect(demanded.changes).toMatchObject({ pendingReadOnlyDemand: { streak: 3, cap: 3 }, readOnlyGrace: 0 })
  })

  it("sells quiet frames only to a justification that answers a demand", () => {
    const answered = disciplined(
      state({ readOnlyCap: 3, pendingReadOnlyDemand: { streak: 3, cap: 3 } }),
      { readOnlyFrames: 4 },
      "reading the parser"
    )
    expect(answered.events).toEqual([])
    expect(answered.changes).toMatchObject({ readOnlyGrace: 3, pendingReadOnlyDemand: undefined })

    const volunteered = disciplined(state({ readOnlyCap: 3 }), { readOnlyFrames: 3 }, "reading the parser")
    expect(volunteered.events.map((event) => event._tag)).toEqual(["read-only-demand-issued"])
  })

  it("spends grace before demanding again", () => {
    const quiet = disciplined(state({ readOnlyCap: 3, readOnlyGrace: 2 }), { readOnlyFrames: 5 })
    expect(quiet.events).toEqual([])
    expect(quiet.changes.readOnlyGrace).toBe(1)
  })

  it("redirects a repeating run once and restarts the count", () => {
    const repeated = disciplined(state({ repeatCap: 4 }), { repeatFrames: 4 })
    expect(repeated.events.map((event) => event._tag)).toEqual(["repeat-demanded"])
    expect(repeated.changes.repeatFrames).toBe(0)
    expect(disciplined(state({ repeatCap: 0 }), { repeatFrames: 9 }).changes.repeatFrames).toBe(9)
  })

  it("puts the frame's probe notice ahead of every demand", () => {
    const judged = state({ readOnlyCap: 1 })
    const accounting = account({
      state: judged,
      calls: [call({ invalidProbe: { reason: "unknown_test", message: "no such test" } })]
    })
    const { messages } = Frame.discipline(judged, accounting, undefined)
    expect(messages).toHaveLength(2)
    expect(messages[0]).toEqual(ModelRequest.Message.user(accounting.probeNotice!))
  })

  it("states sufficiency once", () => {
    const failed = NarrowedCheck.check({
      flow: "bash",
      signature: "pytest tests",
      input: { command: "pytest tests" },
      digest: "t0",
      failing: true,
      stable: true
    })!
    const judged = state({ failures: Sufficiency.remember([], { frame: [failed], epoch: 0 }), mutations: 1 })
    const passing = account({ state: judged, calls: [call()], opened: tree("t1"), closed: tree("t1") })
    expect(Frame.discipline(judged, passing, undefined).events.map((event) => event._tag)).toEqual([
      "sufficiency-observed"
    ])
    expect(Frame.discipline(new CellTurn.State({ ...judged, sufficiencyStated: true }), passing, undefined).events)
      .toEqual([])
  })
})
