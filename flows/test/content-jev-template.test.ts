import * as EventSink from "@smthrs/agent/EventSink"
import * as ScriptedJudge from "@smthrs/agent/ScriptedJudge"
import { Action, HumanTask, Interpreter } from "@smthrs/flow"
import * as NodeRuntime from "@smthrs/flows/NodeRuntime"
import * as Evaluator from "@smthrs/model/Evaluator"
import { Effect, Exit, Layer } from "effect"
import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { test, type TestContext } from "node:test"
import ReleaseContent from "../release-content/flow.ts"
import {
  chooseTemplate,
  MAX_STATE_BYTES,
  ReleaseTemplate,
  TEMPLATE_CONFIDENCE,
  templateClassifier,
  templates,
  templateState
} from "../release-content/jev-template.ts"
import * as Content from "../release-content/workflow.ts"
import { contentInput } from "../release-support/input.ts"
import { actionLayers } from "../release-support/operations.ts"
import { agentLayers } from "../release-support/runtime.ts"
import { type Analysis, type Evidence, Outline } from "../release-support/schema.ts"
import { analysis, evidence, repository, scriptedSeats } from "./fixtures.ts"

/** A scripted Jev that names one narrative with one confidence, with the rest
 * of the distribution spread over the three it did not name. */
const answers = (template: ReleaseTemplate, confidence: number) => {
  const rest = (1 - confidence) / (templates.length - 1)
  return {
    template: {
      choice: template,
      probabilities: Object.fromEntries(templates.map((name) => [name, name === template ? confidence : rest]))
    }
  }
}
const scriptedJev = (template: ReleaseTemplate, confidence: number) =>
  Evaluator.layerScripted(() => answers(template, confidence))

/** The completion fixture reads the evidence independently of the template probe. */
const scriptedCompletion = ScriptedJudge.layer

test("the classifier asks one closed question over the four narratives and nothing else", () => {
  assert.equal(templateClassifier.id, "release/template")
  assert.deepEqual(Object.keys(templateClassifier.questions), ["template"])
  const question = templateClassifier.questions.template
  assert.equal(question.type, "choice")
  assert.deepEqual(Object.keys((question as { criteria: Record<string, string> }).criteria), [
    "feature deep dive",
    "migration guide",
    "reliability report",
    "release roundup"
  ])
  assert.deepEqual([...templates], Object.keys((question as { criteria: Record<string, string> }).criteria))
})

test("the state carries the claim ledger and the release's own evidence", () => {
  const input = contentInput({ notes: "Explain the 0.x to 1.0 migration." }, evidence.version)
  const state = templateState(input, evidence, analysis)
  assert.equal(state.version, evidence.version)
  assert.match(state.notes, /0\.x to 1\.0 migration/)
  assert.match(state.ledger, /Approvals resume after restart/)
  assert.match(state.ledger, /approval/)
  assert.match(state.evidence, /fix: resume approval/)
  assert.match(state.evidence, /src\/approval\.ts/)
})

test("a release too large for one state is clipped, not dropped", () => {
  const huge = "x".repeat(200_000)
  const bigEvidence: Evidence = { ...evidence, commits: huge, changes: huge, documents: huge }
  const bigAnalysis: Analysis = {
    ...analysis,
    summary: huge,
    claims: Array.from({ length: 400 }, (_, index) => ({ id: `claim-${index}`, text: huge, sources: ["README.md"] }))
  }
  const input = contentInput({ notes: "y".repeat(40_000) }, evidence.version)
  const state = templateState(input, bigEvidence, bigAnalysis)
  assert.ok(
    new TextEncoder().encode(JSON.stringify(state)).length <= MAX_STATE_BYTES,
    "one state stays inside the 32 KiB an evaluation may carry"
  )
  assert.ok(
    state.ledger.length > 0 && state.evidence.length > 0,
    "clipping keeps a ledger and evidence to judge, it does not empty them"
  )
})

test("a confident answer is the pick, exactly as Jev gave it", async () => {
  const input = contentInput({}, evidence.version)
  const picked = await Effect.runPromise(
    chooseTemplate(input, evidence, analysis)
      .pipe(Effect.provide(scriptedJev("migration guide", 0.9)))
  )
  assert.deepEqual(picked, { template: "migration guide", confidence: 0.9 })
  const floor = await Effect.runPromise(
    chooseTemplate(input, evidence, analysis)
      .pipe(Effect.provide(scriptedJev("feature deep dive", TEMPLATE_CONFIDENCE)))
  )
  assert.equal(floor.template, "feature deep dive", "the floor itself is decisive")
})

test("an answer below the floor fails the step and names the candidates instead of defaulting", async () => {
  assert.equal(TEMPLATE_CONFIDENCE, 0.8)
  const input = contentInput({}, evidence.version)
  const failure = await Effect.runPromise(Effect.flip(
    chooseTemplate(input, evidence, analysis)
      .pipe(Effect.provide(scriptedJev("release roundup", 0.5)))
  ))
  assert.equal(failure._tag, "ReleaseError")
  assert.equal(failure.step, "pick-template")
  assert.match(failure.message, /release roundup/)
  assert.match(failure.message, /0\.5/)
  assert.match(failure.message, /0\.8/)
  for (const name of templates) assert.ok(failure.message.includes(name), `${name} is named in the refusal`)
})

test("an evaluator Jev cannot reach fails the step typed, naming the transport", async () => {
  const input = contentInput({}, evidence.version)
  const unreachable = await Effect.runPromise(Effect.flip(
    chooseTemplate(input, evidence, analysis)
      .pipe(Effect.provide(Evaluator.layerUnavailable()))
  ))
  assert.equal(unreachable._tag, "ReleaseError")
  assert.equal(unreachable.step, "pick-template")
  assert.match(unreachable.message, /unreachable/)
  const refused = await Effect.runPromise(Effect.flip(
    chooseTemplate(input, evidence, analysis).pipe(Effect.provide(
      Evaluator.layerScripted(() =>
        Effect.fail(new Evaluator.EvaluatorError({ code: "refused", message: "scripted refusal" }))
      )
    ))
  ))
  assert.match(refused.message, /refused/)
  assert.match(refused.message, /scripted refusal/)
})

test("the writer's own output has no narrative field to write", () => {
  assert.deepEqual(Object.keys(Outline.fields), ["angle", "outline"])
  assert.equal(Content.OutlineTemplate.payloadSchema.fields.template, ReleaseTemplate)
})

/** The published flow with a scripted writer and a scripted Jev, so the branch
 * under test is the one a real run takes. A dry run previews and never parks. */
const runContent = async (t: TestContext, evaluator: Layer.Layer<Evaluator.Evaluator>, executionId: string) => {
  const fixture = await repository(t)
  const counts: Record<string, number> = {}
  const prompts: string[] = []
  const armed: Array<boolean | undefined> = []
  const sink = Layer.succeed(EventSink.EventSink)(EventSink.make({
    emit: (event) => Effect.sync(() => event._tag === "discipline-armed" && armed.push(event.judged))
  }))
  const input = contentInput({ from: "v0.35.0", channels: { blog: false, thread: false } }, fixture.evidence.version)
  const host = NodeRuntime.layerHost(
    {
      filename: join(fixture.root, ".flows", "engine.db"),
      workspaceRoot: fixture.root,
      owner: { hostId: "release-jev-template-test" },
      signals: []
    },
    Layer.mergeAll(
      actionLayers({ root: fixture.root, evaluator }),
      // The writer seat's own completion is judged by the harness brake, which
      // never falls back. Its judge is a separate layer from the one under test
      // here, so a scripted Jev that only answers `template` cannot be mistaken
      // for a gateway outage at the seat.
      agentLayers(scriptedSeats(counts, { prompts }), 250_000, scriptedCompletion),
      HumanTask.layer,
      Interpreter.layer(ReleaseContent)
    ).pipe(Layer.provideMerge(Action.layerImplementations), Layer.provideMerge(sink))
  )
  const exit = await Effect.runPromise(Effect.scoped(Effect.exit(
    ReleaseContent.execute(input, { executionId }).pipe(Effect.provide(host))
  )))
  const brief = Exit.isSuccess(exit)
    ? (JSON.parse(await readFile(join(fixture.root, exit.value.artifact.directory, "bundle.json"), "utf8")) as {
      brief: { template: string; angle: string }
    }).brief
    : undefined
  return { exit, counts, prompts, brief, armed }
}

for (const template of ["migration guide", "release roundup"] as const) {
  test(`Jev's ${template} reaches the writer's prompt and the brief`, { timeout: 90_000 }, async (t) => {
    const { exit, prompts, brief, armed } = await runContent(
      t,
      scriptedJev(template, 0.95),
      `jev-template-${template.split(" ")[0]}`
    )
    assert.equal(exit._tag, "Success", JSON.stringify(exit))
    assert.ok(armed.length > 0 && armed.every((judged) => judged === true), "every writer step arms judged discipline")
    const asked = prompts.filter((prompt) => prompt.includes("this release calls for"))
    assert.equal(asked.length, 1, "the writer is asked to outline exactly once")
    assert.match(asked[0]!, new RegExp(template))
    assert.equal(brief?.template, template, "the brief carries Jev's narrative, not the writer's")
  })
}

test("a Jev outage fails the run and the writer is never asked to outline", { timeout: 90_000 }, async (t) => {
  const { exit, counts, prompts } = await runContent(
    t,
    Evaluator.layerScripted(
      () => Effect.fail(new Evaluator.EvaluatorError({ code: "timeout", message: "the gateway did not answer" }))
    ),
    "jev-template-outage"
  )
  assert.equal(exit._tag, "Failure")
  assert.match(JSON.stringify(exit), /timeout/)
  assert.match(JSON.stringify(exit), /the gateway did not answer/)
  assert.equal(counts.analyze, 1, "the ledger is built before the narrative is chosen")
  assert.equal(counts["outline-template"], undefined, "a Jev failure is never handed to the writer seat")
  assert.deepEqual(prompts.filter((prompt) => prompt.includes("this release calls for")), [])
})
