import { NodeServices } from "@effect/platform-node"
import { FlowEngine } from "@smthrs/engine"
import { Action, Flow, Interpreter } from "@smthrs/flow"
import * as Evaluator from "@smthrs/model/Evaluator"
import { Effect, FileSystem, Layer, ManagedRuntime, Schema } from "effect"
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test, type TestContext } from "node:test"
import { initialSetup, setupCandidate } from "../../packages/rpc/src/RepositorySetup.ts"
import * as Jj from "../../packages/smithers/flows/jj/src/Jj.ts"
import { NativeCoding, type NativeRevision } from "../coding/native.ts"
import { CodingError } from "../coding/schema.ts"
import { Evaluate, evaluationLayers, ScoreCase } from "../repository/evaluation.ts"
import { CaptureRepository, captureRepository } from "../repository/inspection.ts"
import { FinishJob, Investigate, RunSteps } from "../repository/jobs.ts"
import { type Draft, EvalCase, type JobResult, type RepositoryEvidence, SetupInput } from "../repository/schema.ts"
import { suggestedSetupDraft } from "../repository/setup.ts"

const exporter = process.env.SMITHERS_WORKSPACE_JJ_EXPORT_BINARY
const gate = {
  skip: exporter === undefined ? "Set SMITHERS_WORKSPACE_JJ_EXPORT_BINARY to the native source exporter" : false,
  timeout: 120_000
}
const RunEvaluate = Flow.make("test/RunEvaluate", {
  payload: Evaluate.payloadSchema,
  success: Evaluate.successSchema,
  error: CodingError,
  body: (input) => Evaluate.call(input)
})
const short = (id: string) => id.slice(0, 12)
/** Every row's verdict is Jev's; this fixture is about source selection, so it
 * answers `pass` confidently and lets the recorded facts decide the rest. */
const scoredPass = Evaluator.layerScripted(() => ({
  verdict: { choice: "pass", probabilities: { pass: 0.95, fail: 0.03, review: 0.02 } }
}))
/** A commit id no repository in this fixture holds; its lookup is the blind one. */
const unreachable = "a".repeat(40)
const judged = "The recorded result answers from the captured README."

/** One repository host, plus a commit id that only a replaced workspace ever held. */
async function fixture(t: TestContext, mode: "snapshot" | "immutable") {
  const temporary = await realpath(await mkdtemp(join(tmpdir(), "repository-eval-source-")))
  t.after(() => rm(temporary, { recursive: true, force: true }))
  const root = join(temporary, "repo"), replaced = join(temporary, "replaced"), blind = join(temporary, "blind")
  for (const path of [root, replaced]) {
    execFileSync("jj", ["git", "init", path], { stdio: "pipe" })
    execFileSync("jj", ["-R", path, "config", "set", "--repo", "user.name", "Eval source test"], { stdio: "pipe" })
    execFileSync("jj", ["-R", path, "config", "set", "--repo", "user.email", "eval-source@example.invalid"], {
      stdio: "pipe"
    })
  }
  // A jj that exits non-zero is a lookup that could not answer, never a proven absence.
  await mkdir(blind)
  await writeFile(join(blind, "jj"), "#!/bin/sh\nexit 1\n", { mode: 0o755 })
  const jj = (path: string, ...args: string[]) =>
    execFileSync("jj", ["-R", path, ...args], { stdio: "pipe" }).toString()
  const commit = (path: string) =>
    jj(path, "log", "--ignore-working-copy", "-r", "@", "--no-graph", "-T", "commit_id").trim()
  await writeFile(join(root, "README.md"), "# canary-sandbox\n\n## Purpose\nA disposable fixture.\n")
  jj(root, "status")
  const pinned = commit(root)
  await writeFile(
    join(root, "README.md"),
    "# canary-sandbox\n\n## Purpose\nA disposable fixture for testing Smithers in production.\n"
  )
  jj(root, "status")
  await writeFile(join(replaced, "README.md"), "# another workspace\n")
  jj(replaced, "status")
  const stranger = commit(replaced)
  const at = () =>
    JSON.parse(jj(root, "--ignore-working-copy", "op", "log", "-n", "1", "--no-graph", "-T", "json(self)")).id as string
  const revision = (): Extract<NativeRevision, { kind: "resolved" }> => {
    const value = JSON.parse(jj(root, "--ignore-working-copy", "log", "-r", "@", "--no-graph", "-T", "json(self)"))
    const tree = JSON.parse(execFileSync(exporter!, [root, value.commit_id, temporary], { stdio: "pipe" }).toString())
    return {
      kind: "resolved",
      changeId: tree.changeId,
      commitId: tree.commitId,
      treeId: tree.treeId,
      operationId: at(),
      parentCommitIds: value.parents
    }
  }
  const fs = await Effect.runPromise(FileSystem.FileSystem.pipe(Effect.provide(NodeServices.layer)))
  const options = {
    repositoryPath: root,
    fs,
    exporterPath: exporter,
    environment: { PATH: process.env.PATH!, HOME: temporary }
  }
  const native: NativeCoding["Service"] = {
    sourcePublication: "cloud",
    read: () =>
      Effect.sync(() => ({
        status: "read" as const,
        operationId: at(),
        head: revision(),
        revisions: [],
        capabilities: []
      })),
    apply: () => Effect.die("editing mutations are forbidden"),
    publishOriginalSource: () => Effect.die("unexpected publication"),
    createSource: () => Effect.die("unexpected source creation")
  }
  // Immutable capture never snapshots, so every other jj method fails by default.
  const snapshots: string[] = []
  const owned = Layer.merge(
    Layer.succeed(NativeCoding, native),
    Jj.layerNoop({
      snapshot: (message) =>
        Effect.sync(() => {
          snapshots.push(message ?? "")
          const current = revision()
          return { commitId: current.commitId, changeId: current.changeId }
        })
    })
  )
    .pipe(Layer.provideMerge(NodeServices.layer))
  return {
    root,
    pinned,
    stranger,
    options,
    owned,
    snapshots,
    mode,
    unanswerable: { ...options, environment: { ...options.environment, PATH: blind } }
  }
}

interface Case {
  readonly id: string
  readonly sourceRevision: string
  readonly event: Schema.Json
}
const storedSetup = (job: "issues" | "review" | "ci", cases: readonly (typeof EvalCase.Type)[]): SetupInput => {
  const setup = initialSetup("example/repo", job, "maintainer")
  setup.draft.cases = cases.map((test) => ({ ...test }))
  return Schema.decodeUnknownSync(SetupInput)({
    requestId: "eval-source",
    repo: setup.repo,
    job: setup.job,
    operation: "evaluate",
    revision: setup.revision,
    digest: setupCandidate(setup),
    draft: setup.draft
  })
}
const setupFor = (job: "issues" | "review" | "ci", cases: readonly Case[]): SetupInput =>
  storedSetup(
    job,
    cases.map((test) => ({
      id: test.id,
      name: test.id,
      required: true,
      expected: "The investigation answers from the captured README.",
      input: JSON.stringify({
        event: test.event,
        sourceRevision: test.sourceRevision,
        assertions: [{ path: "/results/0/output/classification", equals: "question" }]
      })
    }))
  )
const json = (value: unknown) => value as Schema.Json
const issueEvent = json({
  source: "smithers-cloud",
  type: "issues",
  action: "opened",
  deliveryKey: "seed",
  issueNumber: 53,
  payload: { issue: { title: "What is this repository for?", body: "The README is short. A cited answer is enough." } }
})
const ciEvent = json({
  source: "smithers-cloud",
  type: "manual",
  action: "manual:checks",
  manualStep: "checks",
  deliveryKey: "seed",
  payload: { prompt: "Run the repository checks" }
})
/** What the review and CI steps actually check: the commit the event calls the
 * work under review. `checks.ts` refuses any other source for it. A captured PR
 * event carries the head and base the host read and no pull request number,
 * which is the shape every walk-run-3 case persisted. */
const prEvent = (head: string, base: string) =>
  json({
    source: "github",
    type: "pull_request",
    action: "opened",
    deliveryKey: "seed",
    payload: {
      pull_request: {
        title: "Change the greeting",
        body: "Inspect README.md",
        base: { sha: base },
        head: { sha: head }
      }
    }
  })
/** A live GitHub delivery names its pull request, so retention can ask for its refs. */
const numberedPrEvent = (head: string, base: string) =>
  json({
    source: "github",
    type: "pull_request",
    action: "opened",
    deliveryKey: "seed",
    payload: {
      pull_request: {
        number: 2,
        title: "Change the greeting",
        body: "Inspect README.md",
        base: { sha: base },
        head: { sha: head }
      }
    }
  })
const ciPrEvent = (head: string) =>
  json({
    source: "smithers-cloud",
    type: "manual",
    action: "manual:checks",
    manualStep: "checks",
    deliveryKey: "seed",
    payload: { prompt: "Run the repository checks", candidateCommitId: head }
  })
/** The two cases the walk-run-3 host persisted, verbatim from its terminal receipts
 * (`.artifacts/mvp-canary-walk-20260917/B3-21-state-evals-terminal.json` and
 * `B3-22-…`). Each names that inspection's own captured commit as its pin AND as
 * its event's candidate, and neither carries a pull request number. */
const walkCase = {
  review: {
    id: "review-open-canary-pr",
    name: "Review the open canary summary PR against its base",
    required: true,
    expected:
      "The review step runs on the open pull request 'Canary: read-only repository summary' and compares the head revision against the correct base. The repository is a documentation-only canary fixture whose README describes opening the repo in Smithers, requesting a small change via Chat, and reviewing changes in the cloud before landing. A correct run grounds every finding in the actual changed files: it reports concrete findings with code evidence if the diff introduces a problem, and explicitly reports no findings for a clean change rather than inventing issues. It must not modify files, and its summary identifies what was reviewed and the verdict reached.",
    input:
      "{\"event\":{\"source\":\"github\",\"type\":\"pull_request\",\"action\":\"opened\",\"deliveryKey\":\"[REDACTED]\",\"payload\":{\"pull_request\":{\"title\":\"Canary: read-only repository summary\",\"body\":\"Durable production fixture. The Multi concierge should mention this open pull request in its repository update.\",\"base\":{\"sha\":\"fb8c7b08f0d0feb5887cabbec5650e28dae2e6c1\"},\"head\":{\"sha\":\"989b1f1c0c4c153d3917d89de00f2caee95292d0\"}}}},\"sourceRevision\":\"989b1f1c0c4c153d3917d89de00f2caee95292d0\",\"assertions\":[{\"path\":\"/results/0/stepId\",\"equals\":\"review\"},{\"path\":\"/results/0/status\",\"equals\":\"completed\"}]}"
  },
  ci: {
    id: "ci-pr2-no-checks-honest-report",
    name: "Checks step on open PR #2 completes and reports honestly that the repository defines no checks",
    required: true,
    expected:
      "The checks step runs for this pull request against the captured revision. The repository tree contains only README.md and defines no CI workflows, build manifests, or test scripts, so the step completes successfully and its summary states plainly that no repository checks exist, naming what it searched for (workflow files, manifests, scripts) and where. It does not fabricate a pass, does not error, does not install toolchains, and does not modify any file. The report-only documentation-grounding AI check may attach findings about Markdown changes but never gates the result.",
    input:
      "{\"event\":{\"source\":\"github\",\"type\":\"pull_request\",\"action\":\"opened\",\"deliveryKey\":\"[REDACTED]\",\"payload\":{\"pull_request\":{\"title\":\"Canary: read-only repository summary\",\"body\":\"Durable production fixture. The Multi concierge should mention this open pull request in its repository update.\",\"base\":{\"sha\":\"fb8c7b08f0d0feb5887cabbec5650e28dae2e6c1\"},\"head\":{\"sha\":\"f4d4814e64ec741c153a6163e6cac16c02691db6\"}}}},\"sourceRevision\":\"f4d4814e64ec741c153a6163e6cac16c02691db6\",\"assertions\":[{\"path\":\"/results/0/stepId\",\"equals\":\"checks\"},{\"path\":\"/results/0/status\",\"equals\":\"completed\"}]}"
  }
} satisfies Record<"review" | "ci", typeof EvalCase.Type>
const walkPin = { review: "989b1f1c0c4c153d3917d89de00f2caee95292d0", ci: "f4d4814e64ec741c153a6163e6cac16c02691db6" }
/** Everything an inspection may propose. The host keeps the maintainer's decisions,
 * and an existing case is the inspection's own to re-pin. */
const inspection = (existing: Draft): Parameters<typeof suggestedSetupDraft>[1] => ({
  checks: existing.checks,
  cases: [{
    id: "suggested",
    name: "Suggested",
    required: true,
    expected: "The reply cites the captured README.",
    input: {
      sourceRevision: "b".repeat(40),
      assertions: [{ path: "/results/0/status", equals: "completed" }],
      event: {
        source: "smithers-cloud",
        type: "issues",
        action: "opened",
        deliveryKey: "seed",
        payload: { issue: { title: "What is this repository for?", body: "The README is short." } }
      }
    }
  }],
  replies: existing.replies,
  landing: existing.landing,
  scope: existing.scope,
  label: existing.label,
  schedule: existing.schedule,
  choreEvent: existing.choreEvent,
  budgetMinutes: existing.budgetMinutes,
  connectIssues: existing.connectIssues,
  trialTitle: existing.trialTitle,
  trialBody: existing.trialBody
})

/** The production wiring is `"snapshot"`; `"immutable"` is the captured-source path. */
async function harness(t: TestContext, mode: "snapshot" | "immutable") {
  const f = await fixture(t, mode), captured: string[] = [], executed: string[] = [], refused = new Set<string>()
  const runtime = ManagedRuntime.make(
    Layer.mergeAll(
      evaluationLayers({ evaluator: scoredPass }),
      Interpreter.layer(Investigate),
      Interpreter.layer(RunEvaluate),
      CaptureRepository.toLayer((input) => {
        if (input.sourceRevision !== undefined) captured.push(input.sourceRevision)
        return input.sourceRevision !== undefined && refused.has(input.sourceRevision)
          ? Effect.fail(
            new CodingError({ code: "stale_revision", message: "Source changed during repository inspection; retry" })
          )
          : captureRepository(input.sourceRevision === unreachable ? f.unanswerable : f.options, input, mode)
      }),
      RunSteps.toLayer(({ input }) =>
        Effect.sync(() => {
          executed.push(input.sourceRevision)
          return {
            [input.configuration.steps[0]!.id]: {
              stepId: input.configuration.steps[0]!.id,
              status: "completed" as const,
              summary: "The README states the purpose.",
              evidence: [`source:${input.sourceRevision}`],
              output: json({ classification: "question" }),
              executionId: `${input.event.deliveryKey}-step`
            }
          }
        })
      ),
      FinishJob.toLayer(({ input, results }) =>
        Effect.succeed(
          {
            repo: input.repo,
            job: input.job,
            revision: input.revision,
            digest: input.digest,
            sourceRevision: input.sourceRevision,
            eventKey: input.event.deliveryKey,
            status: "completed" as const,
            results: Object.values(results),
            publicActions: []
          } satisfies JobResult
        )
      ),
      ScoreCase.toLayer(() => Effect.succeed({ reason: judged, evidenceIds: [1] }))
    ).pipe(
      Layer.provide(f.owned),
      Layer.provideMerge(Action.layerImplementations),
      Layer.provideMerge(FlowEngine.layerMemory),
      Layer.provideMerge(NodeServices.layer)
    )
  )
  t.after(() => runtime.dispose())
  const evidence: RepositoryEvidence = await Effect.runPromise(
    captureRepository(f.options, { repo: "example/repo", prompt: "README.md" }, mode)
      .pipe(Effect.provide(f.owned))
  )
  assert.equal(f.snapshots.length > 0, mode === "snapshot", "only snapshot capture snapshots the working copy")
  const run = (setup: SetupInput, executionId: string) =>
    runtime.runPromise(
      RunEvaluate.execute({ setup, evidence, deadlineAt: Date.now() + 120_000 }, { executionId }).pipe(Effect.scoped),
      { signal: t.signal }
    )
  const evaluate = (job: "issues" | "review" | "ci", cases: readonly Case[], executionId: string) =>
    run(setupFor(job, cases), executionId)
  const replay = (job: "issues" | "review" | "ci", cases: readonly (typeof EvalCase.Type)[], executionId: string) =>
    run(storedSetup(job, cases), executionId)
  const capture = (payload: typeof CaptureRepository.payloadSchema.Type, options = f.options) =>
    Effect.runPromise(captureRepository(options, payload, mode).pipe(Effect.provide(f.owned), Effect.result))
  return { ...f, captured, executed, refused, evidence, evaluate, replay, capture }
}

for (const mode of ["immutable", "snapshot"] as const) {
  test(
    `a held-out case pinned to a commit this host never held still executes and names the substitution, and a real capture failure names its cause (${mode})`,
    gate,
    async (t) => {
      const f = await harness(t, mode), evidence = f.evidence

      const replaced = await f.evaluate("issues", [{
        id: "readme-purpose-question",
        sourceRevision: f.stranger,
        event: issueEvent
      }], "issues-replaced-workspace")
      assert.equal(
        replaced[0]!.status,
        "passed",
        `a case authored in a replaced workspace still runs: ${replaced[0]!.observed}`
      )
      assert.deepEqual(
        replaced[0]!.evidence,
        [`source:${evidence.source.commitId}`],
        "it runs on the source this host captured"
      )
      assert.equal(
        replaced[0]!.observed,
        `${judged} (the case's pinned commit ${short(f.stranger)} was not held by this workspace; scored against ${
          short(evidence.source.commitId)
        })`,
        "the substituted source is named in the row"
      )

      const held = await f.evaluate("issues", [{
        id: "readme-purpose-question",
        sourceRevision: f.pinned,
        event: issueEvent
      }], "issues-pinned")
      assert.equal(held[0]!.status, "passed", held[0]!.observed)
      assert.deepEqual(held[0]!.evidence, [`source:${f.pinned}`], "a pin this host still holds is captured and used")
      assert.equal(held[0]!.observed, judged, "a captured pin reports no substitution")

      // A real PR event names the source under review, so the inspected evidence is
      // reused because it IS the candidate revision, never in spite of naming another.
      for (const [job, event] of [["review", prEvent(evidence.source.commitId, f.pinned)], ["ci", ciEvent]] as const) {
        const current = await f.evaluate(
          job,
          [{ id: `${job}-case`, sourceRevision: evidence.source.commitId, event }],
          `${job}-current`
        )
        assert.equal(current[0]!.status, "passed", current[0]!.observed)
        assert.deepEqual(
          current[0]!.evidence,
          [`source:${evidence.source.commitId}`],
          `${job} reuses the inspected evidence`
        )
      }

      f.refused.add(f.pinned)
      const broken = await f.evaluate("issues", [{
        id: "readme-purpose-question",
        sourceRevision: f.pinned,
        event: issueEvent
      }], "issues-capture-failed")
      assert.equal(broken[0]!.status, "error")
      assert.equal(
        broken[0]!.observed,
        "The held-out source commit could not be captured: stale_revision — Source changed during repository inspection; retry."
      )
      assert.ok(f.captured.includes(f.pinned), "the held pin reaches the capture")

      const fallback = await f.capture({
        repo: "example/repo",
        prompt: "README.md",
        sourceRevision: f.stranger,
        heldOut: true
      })
      assert.equal(fallback._tag, "Success")
      assert.equal(fallback._tag === "Success" ? fallback.success.source.commitId : "", evidence.source.commitId)
      const required = await f.capture({ repo: "example/repo", prompt: "README.md", sourceRevision: f.stranger })
      assert.equal(required._tag, "Failure", "a job's own source revision stays mandatory")
      assert.equal(required._tag === "Failure" ? required.failure.code : "", "invalid_receipt")
    }
  )

  /*
   * Canary walk run 3: the review and CI cases were pinned to a replaced
   * workspace's commit, the substitution scored them against this workspace's
   * source, and every run ended "step review error — The workspace source is not
   * the event's candidate revision". An event that names its own candidate is the
   * one source those steps accept, so an evaluation of it captures that commit.
   */
  test(
    `a review or CI case is evaluated on its event's candidate revision, not on substituted source (${mode})`,
    gate,
    async (t) => {
      const f = await harness(t, mode), source = f.evidence.source.commitId

      for (const [job, event] of [["review", prEvent(f.pinned, source)], ["ci", ciPrEvent(f.pinned)]] as const) {
        const scored = await f.evaluate(
          job,
          [{ id: `${job}-case`, sourceRevision: f.stranger, event }],
          `${job}-candidate`
        )
        assert.equal(scored[0]!.status, "passed", scored[0]!.observed)
        assert.deepEqual(scored[0]!.evidence, [`source:${f.pinned}`], `${job} runs on the commit its event names`)
        assert.equal(f.executed.includes(f.pinned), true, `${job} hands the candidate revision to the production steps`)
        assert.equal(f.executed.includes(source), false, "and never the workspace's own current source")
        assert.equal(
          scored[0]!.observed,
          `${judged} (the case's pinned commit ${short(f.stranger)} was not held by this workspace; scored against ${
            short(f.pinned)
          })`
        )
      }

      const missing = "c".repeat(40)
      const absent = await f.evaluate("review", [{
        id: "review-case",
        sourceRevision: f.pinned,
        event: numberedPrEvent(missing, source)
      }], "review-candidate-absent")
      assert.equal(absent[0]!.status, "error")
      assert.match(
        absent[0]!.observed,
        /^The event's candidate revision cccccccccccc could not be captured: source_unavailable — /
      )
      assert.match(
        absent[0]!.observed,
        /Edit this case to name source this host holds\.$/,
        "no inspection moves a candidate the case did not pin"
      )
      assert.equal(f.executed.includes(source), false, "a candidate this host cannot capture never scores other source")

      // A captured PR event names no pull request, so there is no retain request to
      // make. The capture then stands on what this host holds and names what it does not.
      const unnumbered = await f.evaluate("review", [{
        id: "review-case",
        sourceRevision: missing,
        event: prEvent(missing, source)
      }], "review-candidate-unnumbered")
      assert.equal(unnumbered[0]!.status, "error")
      assert.equal(
        unnumbered[0]!.observed,
        "The event's candidate revision cccccccccccc could not be captured: " +
          "invalid_receipt — The selected source commit is unavailable on this repository host. Inspect again to re-pin this case."
      )
      assert.equal(f.executed.includes(source), false)
    }
  )

  /*
   * The release symptom itself, replayed from the receipts. Both terminal walk-run-3
   * receipts read "step <id> error — The workspace source is not the event's
   * candidate revision", and re-pinning a case is a remedy only if the inspection
   * that authored the pin moves the candidate it wrote in the same event.
   */
  for (const job of ["review", "ci"] as const) {
    test(`the walk-run-3 ${job} case passes once a fresh inspection re-pins it (${mode})`, gate, async (t) => {
      const f = await harness(t, mode), captured = f.evidence.source.commitId, dead = walkPin[job]

      const persisted = await f.replay(job, [walkCase[job]], `${job}-walk-persisted`)
      assert.equal(persisted[0]!.status, "error", "the persisted case names a commit no live workspace holds")
      assert.equal(
        persisted[0]!.observed,
        `The event's candidate revision ${short(dead)} could not be captured: ` +
          "invalid_receipt — The selected source commit is unavailable on this repository host. Inspect again to re-pin this case."
      )
      assert.equal(f.executed.length, 0, "and never scores this workspace's source instead")

      const existing = storedSetup(job, [walkCase[job]]).draft
      const repinned = suggestedSetupDraft(existing, inspection(existing), captured).cases[0]!
      const input = JSON.parse(repinned.input) as {
        sourceRevision: string
        event: { payload: { pull_request: Record<string, { sha: string }> } }
      }
      assert.equal(input.sourceRevision, captured, "the fresh inspection re-pins the case it authored")
      assert.equal(input.event.payload.pull_request.head!.sha, captured, "and moves the candidate that same pin wrote")
      assert.equal(
        input.event.payload.pull_request.base!.sha,
        "fb8c7b08f0d0feb5887cabbec5650e28dae2e6c1",
        "the remote's own base is never rewritten"
      )
      assert.deepEqual(
        input,
        JSON.parse(walkCase[job].input.split(dead).join(captured)),
        "nothing but this inspection's own commit changes"
      )
      assert.deepEqual(
        { ...repinned, input: walkCase[job].input },
        walkCase[job],
        "and no other field of the case moves"
      )

      const evaluated = await f.replay(job, [repinned], `${job}-walk-repinned`)
      assert.equal(evaluated[0]!.status, "passed", evaluated[0]!.observed)
      assert.equal(evaluated[0]!.observed, judged, "a re-pinned case is scored against no substituted source")
      assert.deepEqual(evaluated[0]!.evidence, [`source:${captured}`])
      assert.deepEqual(f.executed, [captured], "the production step runs on the revision the event now names")
    })
  }

  test(
    `a source lookup that cannot answer keeps its own fault class instead of substituting source (${mode})`,
    gate,
    async (t) => {
      const f = await harness(t, mode), ran = f.executed.length

      const unanswered = await f.evaluate("issues", [{
        id: "readme-purpose-question",
        sourceRevision: unreachable,
        event: issueEvent
      }], "issues-lookup-unavailable")
      assert.equal(
        unanswered[0]!.status,
        "error",
        `a lookup that cannot answer is not a proven absence: ${unanswered[0]!.observed}`
      )
      assert.equal(
        unanswered[0]!.observed,
        "The held-out source commit could not be captured: source_unavailable — The native source lookup could not complete."
      )
      assert.equal(f.executed.length, ran, "the case never runs against substituted source when its lookup failed")

      const blind = await f.capture({
        repo: "example/repo",
        prompt: "README.md",
        sourceRevision: unreachable,
        heldOut: true
      }, f.unanswerable)
      assert.equal(blind._tag, "Failure", "a lookup that cannot answer never substitutes source")
      assert.equal(blind._tag === "Failure" ? blind.failure.code : "", "source_unavailable")
      const malformed = await f.capture({
        repo: "example/repo",
        prompt: "README.md",
        sourceRevision: "the-commit-i-remember",
        heldOut: true
      })
      assert.equal(malformed._tag, "Failure", "a malformed pin keeps its own refusal")
      assert.equal(malformed._tag === "Failure" ? malformed.failure.code : "", "source_refused")
    }
  )
}
