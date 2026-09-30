/**
 * Completion intent at the measured-tree boundary. These are unit tests with
 * explicit classifier answers: no live model, transport, or host is claimed.
 * The TUI host suite independently exercises the actual public run boundary.
 */
import { ModelRequest } from "@smthrs/model"
import * as Evaluator from "@smthrs/model/Evaluator"
import { Effect, Layer, Option } from "effect"
import { describe, expect, it } from "vitest"
import * as CellTurn from "../src/CellTurn.ts"
import * as CompletionClaim from "../src/CompletionClaim.ts"
import * as ContextWindow from "../src/ContextWindow.ts"
import * as EngineLike from "../src/EngineLike.ts"
import * as Frame from "../src/internal/frame.ts"
import * as NarrowedCheck from "../src/NarrowedCheck.ts"

const observation = (digest: string) => Option.some(new EngineLike.Observation({ digest, paths: 2, complete: true }))
const stateFor = (task: string, changes: Frame.StateChanges = {}) =>
  new CellTurn.State({
    ...CellTurn.make({
      session: "completion-intent-unit",
      seat: "anthropic:unit-fixture",
      modelParams: ModelRequest.GenerationParams.make(),
      layers: [],
      capabilityEnvelope: [],
      placement: Option.none(),
      contextWindow: ContextWindow.make({
        modelId: "unit-fixture",
        segments: [{
          kind: "instructions",
          zone: "prefix",
          content: [ModelRequest.SystemPart.make({ text: `The task for this run:\n\n${task}` })]
        }]
      }),
      maxFrames: 8,
      readOnlyCap: 0
    }),
    openingDigest: "unchanged-tree",
    ...changes
  })

const readFile: Frame.ObservedCall = {
  flow: "filesystem.read",
  ok: true,
  summary: "",
  ordinal: 1,
  mutates: false,
  remote: false,
  signature: "read-factory",
  subject: "read-factory",
  at: undefined,
  input: { path: ".smithers/FACTORY.ts" },
  value: { text: "S.Home.App({ flow: \"issue.implement\", title: \"Fix an issue\" })" },
  message: undefined,
  invalidProbe: undefined,
  failing: false,
  passing: false
}

const facts = (
  changes: Partial<Record<keyof CompletionClaim.Probabilities, number>> = {}
): Record<keyof CompletionClaim.Probabilities, number> => ({
  complete: 0.99,
  overclaims: 0.01,
  invented: 0.01,
  requiresWorkspaceChange: 0.01,
  reportsLimitation: 0.01,
  ...changes
})
const evaluator = (probabilities = facts()) => {
  const asked: Array<Evaluator.Request> = []
  const layer = Evaluator.layerScripted((request) => {
    asked.push(request)
    return Object.fromEntries(Object.entries(probabilities).map(([id, probability]) => [id, { probability }]))
  })
  return { layer, asked }
}
const judge = (state: CellTurn.State, claim: string, layer: Layer.Layer<Evaluator.Evaluator>, options: {
  calls?: ReadonlyArray<Frame.ObservedCall>
  closed?: string
  source?: string
  read?: typeof CompletionClaim.read
} = {}) =>
  Frame.judgeCompletion(
    state,
    Frame.account({
      state,
      calls: options.calls ?? [],
      opened: observation("unchanged-tree"),
      closed: observation(options.closed ?? "unchanged-tree"),
      minted: [],
      bindings: [],
      captures: [],
      ...(options.source === undefined ? {} : { source: options.source })
    }),
    state.contextWindow,
    claim,
    options.read
  ).pipe(Effect.provide(layer))

describe("completion without a workspace mutation", () => {
  it.each([
    {
      task: "Which file defines the home apps?",
      claim: "The home apps are defined in .smithers/FACTORY.ts.",
      calls: [readFile]
    },
    { task: "Reply with only A.", claim: "A", calls: [] },
    {
      task: "Does this inspected file need changing?",
      claim: "No change is needed in the inspected file.",
      calls: [readFile]
    }
  ])("retains the correct answer to $task on an unchanged tree", async ({ task, claim, calls }) => {
    const fixture = evaluator()
    const result = await Effect.runPromise(judge(stateFor(task), claim, fixture.layer, { calls }))
    expect(result.demand).toBeUndefined()
    expect(result.unproven).toBeUndefined()
    expect(fixture.asked).toHaveLength(1)
    expect(fixture.asked[0]?.state).toMatchObject({
      task: `The task for this run:\n\n${task}`,
      claim,
      treeMoved: false
    })
    expect(result.decision?.acted).toBe(true)
    expect(result.decision?.answers).toMatchObject({
      requiresWorkspaceChange: { kind: "boolean", p: 0.01 },
      reportsLimitation: { kind: "boolean", p: 0.01 }
    })
  })

  it("retains an explicit incomplete report as a typed failure without another model frame", async () => {
    const task = "Update the config, but do not request permissions you do not have."
    const claim = "I could not update the config because write access was denied. No files were changed."
    const fixture = evaluator(facts({ complete: 0.01, reportsLimitation: 0.99 }))
    const result = await Effect.runPromise(judge(stateFor(task), claim, fixture.layer))
    expect(result.demand).toBeUndefined()
    expect(result.unproven).toMatchObject({ code: "completion_incomplete", message: claim })
    expect(result.observed).toMatchObject({ _tag: "claim-demanded", complete: 0.01, demanded: false, refused: false })
    expect(result.decision?.acted).toBe(true)
    expect(fixture.asked).toHaveLength(1)
  })

  it.each([
    { label: "frame budget exhausted", changes: { maxFrames: 1 } },
    { label: "claim demand cap exhausted", changes: { claimDemands: 3, unmovedDemands: 1 } }
  ])("retains typed incomplete failure when $label", async ({ changes }) => {
    const fixture = evaluator(facts({ complete: 0.01, reportsLimitation: 0.99 }))
    const result = await Effect.runPromise(
      judge(stateFor("Inspect the file.", changes), "I could not finish inspecting the file.", fixture.layer)
    )
    expect(result.demand).toBeUndefined()
    expect(result.unproven).toMatchObject({
      code: "completion_incomplete",
      message: "I could not finish inspecting the file."
    })
    expect(result.observed).toMatchObject({ demanded: false, refused: false })
    expect(result.decision?.acted).toBe(true)
    expect(fixture.asked).toHaveLength(1)
  })

  it.each([0.1, 0.1001, 0.5, 0.99])(
    "keeps the edit guard conservative at workspace-change probability %s",
    async (probability) => {
      const fixture = evaluator(facts({ requiresWorkspaceChange: probability }))
      const result = await Effect.runPromise(judge(stateFor("Fix the bug."), "Fixed the bug.", fixture.layer))
      expect(result.demand?.event._tag).toBe(
        probability <= CompletionClaim.noWorkspaceChangeAt ? undefined : "unmoved-demanded"
      )
      expect(fixture.asked).toHaveLength(1)
      if (probability > CompletionClaim.noWorkspaceChangeAt) {
        expect(result.demand?.spent).toEqual({ unmovedDemands: 1 })
        expect(result.decision).toMatchObject({ classifier: "completion/claim", acted: false })
      }
    }
  )

  it("retains the edit guard when a custom reader supplied no intent fact", async () => {
    let reads = 0
    const result = await Effect.runPromise(
      judge(stateFor("Fix the bug."), "Fixed the bug.", Evaluator.layerUnavailable(), {
        read: () => {
          reads++
          return Effect.succeed({ complete: 0.99, overclaims: 0.01, invented: 0.01, latencyMs: 1 })
        }
      })
    )
    expect(reads).toBe(1)
    expect(result.demand?.event._tag).toBe("unmoved-demanded")
    expect(result.decision).toBeUndefined()
  })

  it.each([0, 3])(
    "retains the legacy soft policy for a custom reader without limitation evidence at claim demand count %s",
    async (claimDemands) => {
      let reads = 0
      const result = await Effect.runPromise(
        judge(stateFor("Inspect the file.", { claimDemands }), "A thin answer.", Evaluator.layerUnavailable(), {
          read: () => {
            reads++
            return Effect.succeed({
              complete: 0.01,
              overclaims: 0.01,
              invented: 0.01,
              requiresWorkspaceChange: 0.01,
              latencyMs: 1
            })
          }
        })
      )
      expect(result.demand?.event._tag).toBe(claimDemands === 0 ? "claim-demanded" : undefined)
      expect(result.unproven).toBeUndefined()
      expect(reads).toBe(1)
    }
  )
})

describe("preserving evidence and refusal", () => {
  it("returns an answer about an earlier failure when that answer completes the current request", async () => {
    const fixture = evaluator(facts({ complete: 0.99, reportsLimitation: 0.99 }))
    const result = await Effect.runPromise(
      judge(
        stateFor("Why did the previous run fail?"),
        "The previous run failed because write access was denied.",
        fixture.layer
      )
    )
    expect(result.demand).toBeUndefined()
    expect(result.unproven).toBeUndefined()
    expect(fixture.asked).toHaveLength(1)
  })

  it("keeps a supported partial edit and its incomplete report as a typed failure", async () => {
    const claim = "Updated the config. I could not finish the integration because credentials are missing."
    const fixture = evaluator(facts({ complete: 0.01, reportsLimitation: 0.99, requiresWorkspaceChange: 0.99 }))
    const result = await Effect.runPromise(
      judge(stateFor("Update the config and integration."), claim, fixture.layer, { closed: "changed-tree" })
    )
    expect(result.demand).toBeUndefined()
    expect(result.unproven).toMatchObject({ code: "completion_incomplete", message: claim })
    expect(result.decision?.acted).toBe(true)
    expect(fixture.asked).toHaveLength(1)
  })

  it("retains the physical guard for a claimed partial edit with no mutation evidence", async () => {
    const fixture = evaluator(facts({ complete: 0.01, reportsLimitation: 0.99, requiresWorkspaceChange: 0.99 }))
    const result = await Effect.runPromise(
      judge(
        stateFor("Update the config and integration."),
        "Updated the config. Could not finish the integration.",
        fixture.layer
      )
    )
    expect(result.demand?.event._tag).toBe("unmoved-demanded")
    expect(result.unproven).toBeUndefined()
    expect(fixture.asked).toHaveLength(1)
  })

  it("refuses a fabricated edit claim after its allowed demands instead of restoring the answer", async () => {
    const fixture = evaluator(facts({ requiresWorkspaceChange: 0.99, overclaims: 0.99, invented: 0.99 }))
    const result = await Effect.runPromise(judge(
      stateFor("Fix the bug.", {
        unmovedDemands: 1,
        claimDemands: 3
      }),
      "Fixed the bug.",
      fixture.layer
    ))
    expect(result.demand).toBeUndefined()
    expect(result.unproven?.code).toBe("claim_unproven")
    expect(result.observed).toMatchObject({ refused: true })
  })

  it.each(["physical", "remote"])("accepts an honest completed edit with %s mutation evidence", async (kind) => {
    const fixture = evaluator(facts({ requiresWorkspaceChange: 0.99 }))
    const result = await Effect.runPromise(
      judge(
        stateFor("Fix the bug.", kind === "remote" ? { remoteMutations: 1 } : {}),
        "Fixed the bug.",
        fixture.layer,
        { closed: kind === "physical" ? "changed-tree" : "unchanged-tree" }
      )
    )
    expect(result.demand).toBeUndefined()
    expect(result.unproven).toBeUndefined()
    expect(fixture.asked[0]?.state).toMatchObject({ treeMoved: true })
  })

  it.each(["overclaims", "invented"] as const)("an incomplete report cannot bypass the %s fact", async (fact) => {
    const fixture = evaluator(facts({ complete: 0.01, reportsLimitation: 0.99, [fact]: 0.99 }))
    const result = await Effect.runPromise(judge(stateFor("Inspect the file."), "I could not finish.", fixture.layer))
    expect(result.demand?.event._tag).toBe("claim-demanded")
    expect(result.demand?.spent).toEqual({ claimDemands: 1 })
  })

  it("still fails explicit unfinished work after an overclaiming demand cap is exhausted", async () => {
    const claim = "I could not finish the requested change."
    const fixture = evaluator(facts({ complete: 0.01, reportsLimitation: 0.99, overclaims: 0.99 }))
    const result = await Effect.runPromise(
      judge(stateFor("Make the change.", { claimDemands: 3 }), claim, fixture.layer)
    )
    expect(result.demand).toBeUndefined()
    expect(result.unproven).toMatchObject({ code: "completion_incomplete", message: claim })
    expect(fixture.asked).toHaveLength(1)
  })

  it.each([0.8999, 0.9])(
    "only a confident limitation report suppresses incomplete bounce at %s",
    async (probability) => {
      const fixture = evaluator(facts({ complete: 0.01, reportsLimitation: probability }))
      const result = await Effect.runPromise(judge(stateFor("Inspect the file."), "I could not finish.", fixture.layer))
      expect(result.demand?.event._tag).toBe(probability >= CompletionClaim.limitationAt ? undefined : "claim-demanded")
    }
  )

  it.each(["unavailable", "abstained"])(
    "fails once with typed completion_unjudged when the evaluator is %s",
    async (mode) => {
      let requests = 0
      const layer = mode === "unavailable" ? Evaluator.layerUnavailable() : Evaluator.layerScripted(() => {
        requests++
        return {}
      })
      const result = await Effect.runPromise(Effect.result(judge(stateFor("Reply with A."), "A", layer)))
      expect(result._tag).toBe("Failure")
      if (result._tag === "Failure") expect(result.failure.code).toBe("completion_unjudged")
      expect(requests).toBe(mode === "abstained" ? 1 : 0)
    }
  )
})

describe("one completion judgment with exact atomic facts", () => {
  it.each(["unresolved", "narrowed"])(
    "still demands the %s check after releasing the unchanged-tree guard",
    async (kind) => {
      const fixture = evaluator()
      const broad = NarrowedCheck.check({
        flow: "bash",
        signature: "pytest tests/parser.py",
        input: { command: "pytest tests/parser.py" },
        digest: kind === "unresolved" ? "unchanged-tree" : "earlier-tree",
        passing: kind !== "unresolved",
        failing: kind === "unresolved",
        stable: true
      })!
      const narrow = {
        ...readFile,
        flow: "bash",
        signature: "pytest tests/parser.py -k parser",
        subject: "pytest tests/parser.py -k parser",
        input: { command: "pytest tests/parser.py -k parser" },
        value: { exitCode: 0 },
        passing: true
      }
      const result = await Effect.runPromise(
        judge(stateFor("Inspect the test results.", { checks: [broad] }), "The filtered check passes.", fixture.layer, {
          calls: [narrow]
        })
      )
      expect(result.demand?.event._tag).toBe(kind === "unresolved" ? "unresolved-demanded" : "narrowed-demanded")
      expect(result.demand?.spent).toEqual(kind === "unresolved" ? { unresolvedDemands: 1 } : { narrowingDemands: 1 })
      expect(fixture.asked).toHaveLength(1)
      expect(result.decision?.acted).toBe(true)
    }
  )

  it("waits for all completion facts before returning a physical demand", async () => {
    let release!: () => void
    let entered!: () => void
    const waiting = new Promise<void>((resolve) => {
      release = resolve
    })
    const started = new Promise<void>((resolve) => {
      entered = resolve
    })
    let requests = 0
    let settled = false
    const layer = Evaluator.layerScripted(() =>
      Effect.promise(async () => {
        requests++
        entered()
        await waiting
        return Object.fromEntries(
          Object.entries(facts({ requiresWorkspaceChange: 0.99 }))
            .map(([id, probability]) => [id, { probability }])
        )
      })
    )
    const result = Effect.runPromise(judge(stateFor("Fix the bug."), "Fixed the bug.", layer))
      .then((value) => {
        settled = true
        return value
      })
    await started
    expect(settled).toBe(false)
    expect(requests).toBe(1)
    release()
    expect((await result).demand?.event._tag).toBe("unmoved-demanded")
    expect(requests).toBe(1)
  })

  it("retains the explicit claimCap zero opt-out without evaluating completion", async () => {
    const fixture = evaluator()
    const result = await Effect.runPromise(
      judge(stateFor("Fix the bug.", { claimCap: 0 }), "Fixed the bug.", fixture.layer)
    )
    expect(result.demand?.event._tag).toBe("unmoved-demanded")
    expect(result.decision).toBeUndefined()
    expect(fixture.asked).toHaveLength(0)
  })

  it("asks intent, limitation and claim questions together before spending the tree guard", async () => {
    const fixture = evaluator(facts({ requiresWorkspaceChange: 0.99 }))
    const state = stateFor("Fix the bug.")
    const result = await Effect.runPromise(judge(state, "Fixed the bug.", fixture.layer))
    expect(fixture.asked).toHaveLength(1)
    expect(Object.keys(fixture.asked[0]!.questions).sort()).toEqual([
      "complete",
      "invented",
      "overclaims",
      "reportsLimitation",
      "requiresWorkspaceChange"
    ])
    expect(result.demand?.event._tag).toBe("unmoved-demanded")
    expect(result.decision?.state).toEqual(fixture.asked[0]?.state)
    expect(Object.keys(result.decision!.answers).sort()).toEqual(Object.keys(fixture.asked[0]!.questions).sort())
    expect(state.unmovedDemands).toBe(0)
    expect(state.claimDemands).toBe(0)
  })

  it("preserves a failed-call demand before any classifier request", async () => {
    const fixture = evaluator()
    const result = await Effect.runPromise(judge(stateFor("Make a change."), "Changed it.", fixture.layer, {
      calls: [{ ...readFile, flow: "filesystem.write", ok: false, message: "Write denied" }],
      source: "await ctx.call(\"filesystem.write\", {}); ctx.done(\"Changed it.\")"
    }))
    expect(result.demand?.event._tag).toBe("failed-call-demanded")
    expect(fixture.asked).toHaveLength(0)
  })
})
