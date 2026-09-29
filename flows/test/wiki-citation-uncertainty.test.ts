import { NodeServices } from "@effect/platform-node"
import { FlowEngine } from "@smthrs/engine"
import { Action, Interpreter } from "@smthrs/flow"
import * as Evaluator from "@smthrs/model/Evaluator"
import { Effect, Layer } from "effect"
import assert from "node:assert/strict"
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test, type TestContext } from "node:test"
import Wiki from "../wiki/flow.ts"
import { checkCitations } from "../wiki/jev-citations.ts"
import { operations } from "../wiki/operations.ts"
import type { Pool } from "../wiki/reuse.ts"
import { actionLayers } from "../wiki/runtime.ts"
import type { PageSpec, Review } from "../wiki/schema.ts"
import { ReviewPage } from "../wiki/workflow.ts"

type Choice = "supports" | "contradicts" | "unrelated"
const answer = (choice: Choice, confidence: number) => {
  const other = (1 - confidence) / 2
  return {
    support: {
      choice,
      probabilities: {
        supports: choice === "supports" ? confidence : other,
        contradicts: choice === "contradicts" ? confidence : other,
        unrelated: choice === "unrelated" ? confidence : other
      }
    }
  }
}

const fixture = async (t: TestContext, sections = 1) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "smithers-wiki-uncertain-")))
  t.after(() => rm(root, { recursive: true, force: true }))
  await mkdir(join(root, "src"))
  await writeFile(join(root, "src/answer.ts"), "export const answer = 42\n")
  await writeFile(
    join(root, "page.md"),
    sections === 1
      ? "# Answer\n\nThe answer is 42.\n"
      : "# Answer\n\nThe answer is 42.\n\n## Export\n\nThe answer is exported.\n"
  )
  const spec: PageSpec = {
    id: "answer",
    title: "Answer",
    purpose: "Find the answer.",
    kind: "current",
    document: "page.md",
    inputs: ["src/answer.ts"],
    related: []
  }
  const output = join(root, "output")
  const evidence = await Effect.runPromise(
    operations({ root, output }).collect(spec).pipe(Effect.provide(NodeServices.layer))
  )
  const review: Review = {
    sections: evidence.sections.map((section) => ({
      id: section.id,
      verdict: "supported",
      explanation: "The exported constant supports this section.",
      citations: [{ path: "src/answer.ts", line: 1, quote: "export const answer = 42" }]
    }))
  }
  return { root, output, spec, evidence, review }
}

const execute = async (
  t: TestContext,
  decisions: ReadonlyArray<readonly [Choice, number]>,
  sections = 1,
  verdicts?: ReadonlyArray<Review["sections"][number]["verdict"]>
) => {
  const f = await fixture(t, sections)
  if (verdicts) {
    f.review = {
      sections: f.review.sections.map((section, index) => ({
        ...section,
        verdict: verdicts[index] ?? section.verdict
      }))
    }
  }
  let citationCalls = 0
  const reviewerCalls: Array<{ correction: string | undefined; review: Review }> = []
  const judge = Evaluator.layerScripted(() => {
    const decision = decisions[citationCalls++]
    assert.ok(decision, "every citation needs a scripted answer")
    return answer(...decision)
  })
  const layer = Layer.mergeAll(
    actionLayers({ root: f.root, output: f.output, evaluator: judge }),
    Interpreter.layer(Wiki),
    ReviewPage.toLayer(({ correction }) =>
      Effect.sync(() => {
        reviewerCalls.push({ correction, review: f.review })
        return f.review
      })
    )
  ).pipe(
    Layer.provideMerge(Action.layerImplementations),
    Layer.provideMerge(FlowEngine.layerMemory),
    Layer.provideMerge(NodeServices.layer)
  )
  const result = await Effect.runPromiseExit(Effect.scoped(
    Wiki.execute({ pages: [f.spec], mode: "verified", reviewer: "scripted-test" }, {
      executionId: `wiki-citation-${Math.random().toString(36).slice(2)}`
    }).pipe(Effect.provide(layer))
  ))
  const snapshot = await readFile(join(f.output, "current.json"), "utf8").then(JSON.parse, () => null)
  const check = await Effect.runPromise(
    checkCitations(f.evidence, f.review).pipe(
      Effect.provide(Evaluator.layerScripted((request) => {
        const index = f.evidence.sections.findIndex((section) =>
          String((request.state as { claim?: string }).claim).includes(section.markdown.split("\n").at(-1) ?? "")
        )
        return answer(...decisions[Math.max(0, index)]!)
      }))
    )
  )
  return { ...f, result, snapshot, check, citationCalls, reviewerCalls }
}

test("Wiki.execute treats .79 citation support as uncertain, keeps review receipts, and writes needs-changes", async (t) => {
  const run = await execute(t, [["supports", 0.79]])
  assert.equal(run.citationCalls, 1)
  assert.equal(run.reviewerCalls[0]?.review.sections[0]?.verdict, "supported")
  assert.deepEqual(run.reviewerCalls, [{ correction: undefined, review: run.review }])
  assert.equal(run.check.verdict, "uncertain")
  assert.deepEqual(run.check.citations.map((c) => [c.choice, c.confidence, c.outcome]), [[
    "supports",
    0.79,
    "uncertain"
  ]])
  assert.equal(run.result._tag, "Failure", "uncertain evidence must not satisfy verified mode")
  assert.equal(run.snapshot?.verification, "needs-changes")
  assert.equal(run.snapshot?.pages[0].verification.status, "needs-changes")
  assert.equal(run.snapshot?.pages[0].verification.review.sections[0].verdict, "uncertain")
  assert.match(
    run.snapshot?.pages[0].verification.review.sections[0].explanation,
    /Citation check uncertain: src\/answer\.ts:1 \(supports, confidence 0\.79\)/
  )
  assert.deepEqual(
    run.reviewerCalls[0]?.review,
    run.review,
    "the raw reviewer receipt must retain its original supported verdict"
  )
  assert.equal(await stat(join(run.output, "current.json")).then(() => true, () => false), true)
})

test("Wiki.execute accepts support exactly at .8 and at .95", async (t) => {
  for (const confidence of [0.8, 0.95]) {
    await t.test(String(confidence), async (sub) => {
      const run = await execute(sub, [["supports", confidence]])
      assert.equal(run.result._tag, "Success", JSON.stringify(run.result))
      assert.equal(run.result.value.verification, "verified")
      assert.equal(run.snapshot?.verification, "verified")
      assert.equal(run.snapshot?.pages[0].verification.status, "verified")
      assert.deepEqual(run.snapshot?.pages[0].verification.review, run.review)
      assert.equal(run.check.citations[0]?.outcome, "supported")
    })
  }
})

test("Wiki.execute still refuses a confidently unrelated citation without writing a snapshot", async (t) => {
  const run = await execute(t, [["unrelated", 0.95]])
  assert.equal(run.check.verdict, "unsupported")
  assert.equal(run.result._tag, "Failure")
  assert.match(JSON.stringify(run.result), /does not support/)
  assert.equal(run.snapshot, null)
  assert.deepEqual(run.reviewerCalls, [{ correction: undefined, review: run.review }])
})

test("mixed sections keep uncertain and unsupported semantic citation receipts distinct", async (t) => {
  const run = await execute(t, [["supports", 0.79], ["unrelated", 0.95]], 2)
  assert.equal(run.citationCalls, 2)
  assert.deepEqual(run.check.citations.map((c) => [c.outcome, c.choice, c.confidence]), [
    ["uncertain", "supports", 0.79],
    ["unsupported", "unrelated", 0.95]
  ])
  assert.equal(run.check.verdict, "unsupported")
  assert.equal(run.result._tag, "Failure")
  assert.equal(run.snapshot, null)
  assert.deepEqual(run.reviewerCalls, [{ correction: undefined, review: run.review }])
})

test("citation uncertainty preserves other semantic section assessments", async (t) => {
  for (const verdict of ["supported", "uncertain", "unsupported"] as const) {
    await t.test(verdict, async (sub) => {
      const run = await execute(sub, [["supports", 0.79], ["supports", 0.95]], 2, ["supported", verdict])
      assert.equal(run.result._tag, "Failure")
      assert.equal(run.snapshot?.verification, "needs-changes")
      assert.deepEqual(
        run.snapshot?.pages[0].verification.review.sections.map(
          (section: { verdict: string }) => section.verdict
        ),
        ["uncertain", verdict]
      )
      assert.deepEqual(run.snapshot?.pages[0].verification.review.sections[1], run.review.sections[1])
      assert.deepEqual(run.reviewerCalls[0]?.review.sections.map((section) => section.verdict), ["supported", verdict])
      assert.deepEqual(run.check.citations.map((c) => c.outcome), ["uncertain", "supported"])
    })
  }
})

// The native host persists the first run in SQLite, then a second engine scope
// asks the incremental flow to reuse it. A raw "supported" reviewer receipt
// must not launder an uncertain citation check into a reusable review.
test("SQLite incremental reuse re-reviews a prior uncertain citation", { timeout: 180_000 }, async (t) => {
  const { execFileSync } = await import("node:child_process")
  const { dirname } = await import("node:path")
  const { fileURLToPath } = await import("node:url")
  const { Capability } = await import("@smthrs/flows")
  const NodeRuntime = await import("@smthrs/flows/NodeRuntime")
  const { IncrementalWiki, policySources, reuseLayers } = await import("../wiki/reuse.ts")
  const f = await fixture(t)
  execFileSync("jj", ["git", "init", f.root], { stdio: "pipe" })
  await writeFile(join(f.root, ".gitignore"), ".flows/\n")
  const sourceRoot = fileURLToPath(new URL("../../", import.meta.url))
  for (const file of policySources) {
    await mkdir(dirname(join(f.root, file)), { recursive: true })
    await writeFile(join(f.root, file), await readFile(join(sourceRoot, file)))
  }
  // Capture the policy so a supported control really is eligible for reuse.
  f.spec = { ...f.spec, inputs: [...f.spec.inputs, ...policySources] }
  f.evidence = await Effect.runPromise(
    operations({ root: f.root, output: f.output }).collect(f.spec).pipe(
      Effect.provide(NodeServices.layer)
    )
  )
  let reviewerCalls = 0, citationCalls = 0
  const judge = Evaluator.layerScripted(() => answer("supports", citationCalls++ === 0 ? 0.79 : 0.95))
  const rule = (action: "fs:read" | "fs:write", resource: string) =>
    new Capability.Permission.Rule({
      effect: "allow",
      pattern: new Capability.Capability.CapabilityPattern({ action, resource })
    })
  const output = join(f.root, ".flows/wiki")
  const host = () =>
    NodeRuntime.layerHost(
      {
        filename: join(f.root, ".flows/engine.db"),
        workspaceRoot: f.root,
        owner: { hostId: "wiki-uncertain-reuse-test" },
        signals: [],
        rules: [[rule("fs:read", f.root), rule("fs:read", `${f.root}/**`), rule("fs:write", `${f.root}/.flows/**`)]]
      },
      Layer.mergeAll(
        actionLayers({ root: f.root, output, evaluator: judge }),
        reuseLayers({ root: f.root, output }),
        Interpreter.layer(Wiki),
        Interpreter.layer(IncrementalWiki),
        ReviewPage.toLayer(() =>
          Effect.sync(() => {
            reviewerCalls++
            return f.review
          })
        )
      ).pipe(Layer.provideMerge(Action.layerImplementations))
    )
  const input = { pages: [f.spec], mode: "verified" as const, reviewer: "scripted-test" }
  const first = await Effect.runPromiseExit(Effect.scoped(
    Wiki.execute(input, { executionId: "wiki-uncertain-original" }).pipe(Effect.provide(host()))
  ))
  assert.equal(first._tag, "Failure")
  assert.equal(reviewerCalls, 1)
  const second = await Effect.runPromise(Effect.scoped(
    IncrementalWiki.execute({ ...input, priorRunId: "wiki-uncertain-original" }, {
      executionId: "wiki-uncertain-incremental"
    }).pipe(Effect.provide(host()))
  ))
  assert.equal(second.verification, "verified")
  assert.equal(reviewerCalls, 2, "uncertain citation evidence requires a new model review")
  assert.equal(citationCalls, 2)
  const snapshot = JSON.parse(await readFile(join(output, "current.json"), "utf8"))
  assert.equal(snapshot.pages[0].verification.provenance.reusedFrom, null)
  const supportedReuse = await Effect.runPromise(Effect.scoped(
    IncrementalWiki.execute({ ...input, priorRunId: "wiki-uncertain-incremental" }, {
      executionId: "wiki-supported-reuse"
    }).pipe(Effect.provide(host()))
  ))
  assert.equal(supportedReuse.verification, "verified")
  assert.equal(reviewerCalls, 2, "supported evidence must reuse the recorded review")
  assert.equal(citationCalls, 3, "reused reviews still have their citations checked")
  const reused = JSON.parse(await readFile(join(output, "current.json"), "utf8"))
  assert.equal(reused.pages[0].verification.provenance.reusedFrom.runId, "wiki-uncertain-incremental")
  const { canonical } = await import("@smthrs/core/Digest")
  const { digest } = await import("../wiki/operations.ts")
  const sectionsDigest = await Effect.runPromise(
    digest(canonical(f.evidence.sections)).pipe(
      Effect.provide(NodeServices.layer)
    )
  )
  const prior = snapshot.pages[0].verification.provenance
  const oldPolicyPool: Pool = {
    policyDigest: "sha256:old-review-policy",
    policySources: prior.policySources,
    candidates: {
      answer: {
        inputDigest: f.evidence.inputDigest,
        contentDigest: f.evidence.contentDigest,
        sectionsDigest,
        review: f.review,
        reviewer: input.reviewer,
        attempt: { runId: "old-policy-run", stepKeyDigest: "old-policy-step", attempt: 0 },
        originRunId: "old-policy-run"
      }
    }
  }
  const third = await Effect.runPromise(Effect.scoped(
    IncrementalWiki.execute({ ...input, pool: oldPolicyPool }, { executionId: "wiki-old-policy-pool" }).pipe(
      Effect.provide(host())
    )
  ))
  assert.equal(third.verification, "verified")
  assert.equal(reviewerCalls, 3, "a pool from an older review policy cannot supply a review")
  const refreshed = JSON.parse(await readFile(join(output, "current.json"), "utf8"))
  assert.equal(refreshed.pages[0].verification.provenance.reusedFrom, null)
})
