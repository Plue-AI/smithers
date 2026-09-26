import { NodeServices } from "@effect/platform-node"
import { FlowEngine } from "@smthrs/engine"
import { Action, Interpreter } from "@smthrs/flow"
import * as Evaluator from "@smthrs/model/Evaluator"
import { Effect, Layer } from "effect"
import assert from "node:assert/strict"
import { mkdir, mkdtemp, realpath, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test, type TestContext } from "node:test"
import { MAX_STATES } from "../repository/jev-checks.ts"
import Wiki from "../wiki/flow.ts"
import {
  checkCitations,
  citationClassifier,
  citationRequests,
  citationVerdicts,
  MAX_STATE_BYTES,
  UNSUPPORTED_CONFIDENCE
} from "../wiki/jev-citations.ts"
import { operations } from "../wiki/operations.ts"
import { actionLayers } from "../wiki/runtime.ts"
import type { Evidence, PageSpec, Review } from "../wiki/schema.ts"
import { ReviewPage } from "../wiki/workflow.ts"

const run = <A, E>(
  effect: Effect.Effect<
    A,
    E,
    import("effect/FileSystem").FileSystem | import("effect/Path").Path | import("effect/Crypto").Crypto
  >
) => Effect.runPromise(effect.pipe(Effect.provide(NodeServices.layer)))

const fixture = async (t: TestContext) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "smithers-wiki-jev-")))
  t.after(() => rm(root, { recursive: true, force: true }))
  await mkdir(join(root, "src"))
  await writeFile(join(root, "page.md"), "# A small page\n\nThe answer is 42.\n")
  await writeFile(join(root, "src/answer.ts"), "export const answer = 42\n")
  const spec: PageSpec = {
    id: "answer",
    title: "Answer",
    purpose: "Find the answer.",
    kind: "current",
    document: "page.md",
    inputs: ["src/answer.ts"],
    related: []
  }
  const output = join(root, "output"), ops = operations({ root, output })
  return { root, output, spec, ops }
}

/** The review the fixture's reviewer returns: one section, one exact citation. */
const supported = (evidence: Evidence): Review => ({
  sections: evidence.sections.map((section) => ({
    id: section.id,
    verdict: "supported" as const,
    explanation: "The exported constant supports the explanation.",
    citations: [{ path: "src/answer.ts", line: 1, quote: "export const answer = 42" }]
  }))
})

/** A scripted choice with an explicit distribution, so `confidence` is the
 * number the test names rather than the one-hot 1 a bare choice decodes to. */
const answer = (choice: "supports" | "contradicts" | "unrelated", confidence: number) => {
  const rest = (1 - confidence) / 2
  return {
    support: {
      choice,
      probabilities: {
        supports: choice === "supports" ? confidence : rest,
        contradicts: choice === "contradicts" ? confidence : rest,
        unrelated: choice === "unrelated" ? confidence : rest
      }
    }
  }
}

test("one state per claim and citation, carrying the claim and the cited source excerpt", async (t) => {
  const f = await fixture(t), evidence = await run(f.ops.collect(f.spec))
  const requests = citationRequests(evidence, supported(evidence))
  assert.equal(requests.length, 1)
  const [only] = requests
  assert.equal(only!.section, "section-1")
  assert.equal(only!.path, "src/answer.ts")
  assert.equal(only!.line, 1)
  assert.equal(only!.quote, "export const answer = 42")
  assert.match(only!.state.claim, /The answer is 42\./)
  assert.equal(only!.state.source.path, "src/answer.ts")
  assert.match(only!.state.source.excerpt, /1 \| export const answer = 42/)
  assert.ok(
    new TextEncoder().encode(JSON.stringify(only!.state)).length <= MAX_STATE_BYTES,
    "a state stays inside the 32 KiB one evaluation may carry"
  )
  assert.equal(citationRequests(evidence, { sections: [] }).length, 0)
})

test("a huge claim and a huge source are clipped so the state still fits", async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "smithers-wiki-jev-big-")))
  t.after(() => rm(root, { recursive: true, force: true }))
  // Lines long enough that the excerpt window alone overruns one state, and a
  // claim long enough to overrun it on its own.
  const long = Array.from({ length: 20 }, (_, index) => `const big${index} = ${"x".repeat(1600)}`).join("\n") + "\n"
  await writeFile(join(root, "big.ts"), long)
  await writeFile(join(root, "page.md"), `# Big\n\n${"The page repeats itself. ".repeat(560)}\n`)
  const spec: PageSpec = {
    id: "big",
    title: "Big",
    purpose: "Be large.",
    kind: "current",
    document: "page.md",
    inputs: ["big.ts"],
    related: []
  }
  const evidence = await run(operations({ root, output: join(root, "out") }).collect(spec))
  const review: Review = {
    sections: evidence.sections.map((section) => ({
      id: section.id,
      verdict: "supported" as const,
      explanation: "Large.",
      citations: [{ path: "big.ts", line: 10, quote: "const big9 = " }]
    }))
  }
  const requests = citationRequests(evidence, review)
  assert.equal(requests.length, 1)
  for (const request of requests) {
    assert.ok(
      new TextEncoder().encode(JSON.stringify(request.state)).length <= MAX_STATE_BYTES,
      `state for ${request.section} exceeds ${MAX_STATE_BYTES} bytes`
    )
    assert.ok(
      request.state.claim.length > 0 && request.state.source.excerpt.length > 0,
      "clipping keeps a claim and an excerpt to judge, it does not empty them"
    )
  }
})

test("seventy citations are judged in two batches and every one is answered", async (t) => {
  const f = await fixture(t), evidence = await run(f.ops.collect(f.spec))
  const review: Review = {
    sections: evidence.sections.map((section) => ({
      id: section.id,
      verdict: "supported" as const,
      explanation: "Seventy exact citations onto the same line.",
      citations: Array.from(
        { length: 70 },
        () => ({ path: "src/answer.ts", line: 1, quote: "export const answer = 42" })
      )
    }))
  }
  assert.equal(MAX_STATES, 64)
  assert.equal(citationRequests(evidence, review).length, 70)
  let calls = 0
  const page = await Effect.runPromise(
    checkCitations(evidence, review).pipe(
      Effect.provide(Evaluator.layerScripted(() => {
        calls++
        return answer("supports", 0.95)
      }))
    )
  )
  assert.equal(calls, 70, "no citation is dropped between the batches")
  assert.equal(page.verdict, "supported")
  assert.equal(page.citations.length, 70)
})

test("a confident supports is supported, a confident contradicts or unrelated is unsupported, anything unsure is uncertain", async (t) => {
  const f = await fixture(t), evidence = await run(f.ops.collect(f.spec))
  const [request] = citationRequests(evidence, supported(evidence))
  const outcome = (choice: "supports" | "contradicts" | "unrelated", confidence: number) =>
    citationVerdicts([request!], [{
      support: {
        value: choice,
        confidence,
        probabilities: { supports: 0, contradicts: 0, unrelated: 0, [choice]: confidence }
      }
    }]).citations[0]!.outcome
  assert.equal(UNSUPPORTED_CONFIDENCE, 0.8)
  assert.equal(outcome("supports", 0.95), "supported")
  assert.equal(outcome("supports", 0.8), "supported")
  assert.equal(outcome("unrelated", 0.9), "unsupported")
  assert.equal(outcome("contradicts", 0.8), "unsupported")
  assert.equal(outcome("contradicts", 0.6), "uncertain", "an unsure answer is never an unsupported verdict")
  assert.equal(outcome("supports", 0.79), "uncertain", "an unsure answer is never a supported verdict either")
})

test("a page is unsupported when any citation is, uncertain only when none is unsupported", async (t) => {
  const f = await fixture(t), evidence = await run(f.ops.collect(f.spec))
  const review: Review = {
    sections: evidence.sections.map((section) => ({
      ...supported(evidence).sections[0]!,
      id: section.id,
      citations: [{ path: "src/answer.ts", line: 1, quote: "export const answer = 42" }, {
        path: "src/answer.ts",
        line: 1,
        quote: "answer = 42"
      }]
    }))
  }
  const both = (first: ReturnType<typeof answer>["support"], second: ReturnType<typeof answer>["support"]) => {
    let index = 0
    return Effect.runPromise(
      checkCitations(evidence, review).pipe(Effect.provide(
        Evaluator.layerScripted(() => ({ support: (index++ === 0 ? first : second) }))
      ))
    )
  }
  assert.equal((await both(answer("supports", 0.95).support, answer("supports", 0.9).support)).verdict, "supported")
  assert.equal((await both(answer("supports", 0.95).support, answer("contradicts", 0.6).support)).verdict, "uncertain")
  const unsupported = await both(answer("supports", 0.6).support, answer("unrelated", 0.9).support)
  assert.equal(unsupported.verdict, "unsupported", "one unsupported citation outranks every uncertain one")
  assert.deepEqual(unsupported.citations.map((citation) => citation.outcome), ["uncertain", "unsupported"])
})

test("an evaluator Jev cannot reach fails the step typed, and no LLM is asked instead", async (t) => {
  const f = await fixture(t), evidence = await run(f.ops.collect(f.spec))
  const failure = await Effect.runPromise(Effect.flip(
    checkCitations(evidence, supported(evidence))
      .pipe(Effect.provide(Evaluator.layerUnavailable()))
  ))
  assert.equal(failure._tag, "WikiError")
  assert.equal(failure.code, "citation-check-unavailable")
  assert.match(failure.message, /unreachable/)
  const refused = await Effect.runPromise(Effect.flip(
    checkCitations(evidence, supported(evidence)).pipe(Effect.provide(
      Evaluator.layerScripted(() =>
        Effect.fail(new Evaluator.EvaluatorError({ code: "refused", message: "scripted refusal" }))
      )
    ))
  ))
  assert.equal(refused.code, "citation-check-unavailable")
  assert.match(refused.message, /refused/)
})

test("the classifier asks one closed question with the three verdicts Jev may give", () => {
  assert.equal(citationClassifier.id, "citation/support")
  assert.deepEqual(Object.keys(citationClassifier.questions), ["support"])
  const question = citationClassifier.questions.support
  assert.equal(question.type, "choice")
  assert.deepEqual(Object.keys((question as { criteria: Record<string, string> }).criteria), [
    "supports",
    "contradicts",
    "unrelated"
  ])
})

/** The published flow, with a scripted reviewer and a scripted Jev, so the
 * branch under test is the one a real run takes. */
const runWiki = async (t: TestContext, script: Evaluator.Script, executionId: string) => {
  const f = await fixture(t)
  const reviews: string[] = []
  const corrections: string[] = []
  const layer = Layer.mergeAll(
    actionLayers({ root: f.root, output: f.output, evaluator: Evaluator.layerScripted(script) }),
    Interpreter.layer(Wiki),
    ReviewPage.toLayer(({ evidence, correction }) =>
      Effect.sync(() => {
        reviews.push(evidence.spec.id)
        if (correction !== undefined) corrections.push(correction)
        return supported(evidence)
      })
    )
  ).pipe(
    Layer.provideMerge(Action.layerImplementations),
    Layer.provideMerge(FlowEngine.layerMemory),
    Layer.provideMerge(NodeServices.layer)
  )
  const result = await Effect.runPromiseExit(Effect.scoped(
    Wiki.execute(
      { pages: [f.spec], mode: "verified", reviewer: "scripted-test" },
      { executionId }
    ).pipe(Effect.provide(layer))
  ))
  const published = await stat(join(f.output, "current.json")).then(() => true, () => false)
  return { result, reviews, corrections, published }
}

test("every citation supported publishes exactly as before", async (t) => {
  const { result, reviews, corrections, published } = await runWiki(
    t,
    () => answer("supports", 0.95),
    "wiki-jev-supported"
  )
  assert.equal(result._tag, "Success", JSON.stringify(result))
  assert.equal(result.value.verification, "verified")
  assert.deepEqual(reviews, ["answer"])
  assert.deepEqual(corrections, [])
  assert.ok(published)
})

test("an unsupported citation refuses the page by name and publishes nothing", async (t) => {
  const { result, published } = await runWiki(t, () => answer("unrelated", 0.9), "wiki-jev-unsupported")
  assert.equal(result._tag, "Failure")
  const message = JSON.stringify(result)
  assert.match(message, /does not support/)
  assert.match(message, /answer\/section-1/)
  assert.match(message, /src\/answer\.ts/)
  assert.match(message, /\\"line\\":1/)
  assert.match(message, /\\"choice\\":\\"unrelated\\"/)
  assert.equal(published, false, "a page whose citations do not support its claims is never written")
})

test("a Jev outage fails the run and never spends a second reviewer call", async (t) => {
  const { result, reviews, corrections, published } = await runWiki(
    t,
    () => Effect.fail(new Evaluator.EvaluatorError({ code: "timeout", message: "the gateway did not answer" })),
    "wiki-jev-outage"
  )
  assert.equal(result._tag, "Failure")
  assert.match(JSON.stringify(result), /citation-check-unavailable/)
  assert.deepEqual(reviews, ["answer"], "a Jev failure is never handed back to the reviewer")
  assert.deepEqual(corrections, [])
  assert.equal(published, false)
})
