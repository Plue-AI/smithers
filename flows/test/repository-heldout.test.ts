import { Schema } from "effect"
import assert from "node:assert/strict"
import { test } from "node:test"
import { initialSetup, setupCandidate } from "../../packages/rpc/src/RepositorySetup.ts"
import { assessScore, evaluatedCandidate } from "../repository/evaluation.ts"
import { JobInput, type JobResult, SetupInput } from "../repository/schema.ts"
import { candidateFiles } from "../repository/setup.ts"

const heldOut = "HELD_OUT_EXPECTATION: cite greeting.mjs and identify hello"
const sourceRevision = "a".repeat(40)
const event = {
  source: "smithers-cloud",
  type: "issues",
  action: "opened",
  deliveryKey: "held-out",
  issueNumber: 4,
  payload: { issue: { number: 4, title: "What greeting is exported?", body: "Inspect greeting.mjs" } }
}
const caseInput = JSON.stringify({
  sourceRevision,
  event,
  assertions: [{ path: "/results/0/output/classification", equals: "question" }]
})
const held = (cases: boolean): SetupInput => {
  const setup = initialSetup("example/repo", "issues", "maintainer")
  setup.draft.cases = cases
    ? [{
      id: "research",
      name: "Held-out question",
      input: caseInput,
      expected: heldOut,
      source: "issue:4",
      required: true
    }]
    : []
  return Schema.decodeUnknownSync(SetupInput)({
    requestId: "setup-request",
    repo: setup.repo,
    job: setup.job,
    operation: "evaluate",
    revision: setup.revision,
    digest: setupCandidate(setup),
    draft: setup.draft
  })
}
const observedQuestion = (classification: string): JobResult => ({
  repo: "example/repo",
  job: "issues",
  revision: 1,
  digest: "e".repeat(64),
  sourceRevision,
  eventKey: "held-out",
  status: "completed",
  publicActions: [],
  results: [{
    stepId: "research",
    status: "completed",
    summary: "The exported greeting is hello.",
    evidence: ["source:greeting.mjs@0123"],
    output: { classification, summary: "The exported greeting is hello." },
    executionId: "actual-research"
  }]
})
const score = {
  verdict: "pass" as const,
  reason: "The recorded result classifies a question and cites the greeting.",
  evidenceIds: [1]
}

test("the committed candidate keeps each public test definition and never its held-out answer", () => {
  const input = held(true), files = candidateFiles(input)
  for (const [name, contents] of Object.entries(files)) {
    assert(!contents.includes("HELD_OUT_EXPECTATION"), `${name} retains the answer`)
    assert(!contents.includes("/results/0/output/classification"), `${name} retains the deterministic answer key`)
  }
  const definitions = [{
    id: "research",
    name: "Held-out question",
    input: JSON.stringify({ event, sourceRevision }),
    required: true
  }]
  assert.deepEqual(input.draft.cases[0]!.input, caseInput)
  assert.deepEqual(JSON.parse(files["evals.json"]!), definitions)
  const candidate = JSON.parse(files["candidate.json"]!)
  assert.deepEqual(candidate.draft.cases, definitions)
  assert.equal(candidate.digest, input.digest)
  const { trialTitle: _title, trialBody: _body, ...configured } = JSON.parse(JSON.stringify(input.draft))
  assert.deepEqual({ ...candidate.draft, cases: input.draft.cases }, configured)
  assert.equal(files["prompt-research.md"], input.draft.steps.find((step) => step.id === "research")!.prompt + "\n")
  assert.deepEqual(candidateFiles(held(true)), files)
})

test("a draft with no cases materialises the same bytes as before the split", () => {
  const input = held(false), files = candidateFiles(input)
  const { trialTitle: _title, trialBody: _body, ...configured } = input.draft
  assert.equal(
    files["candidate.json"],
    JSON.stringify(
      { repo: input.repo, job: input.job, revision: input.revision, digest: input.digest, draft: configured },
      null,
      2
    ) + "\n"
  )
  assert.equal(files["evals.json"], "[]\n")
})

/** Walk run 3, defect B3-N1: `Test issue title` and `Test issue body` are the
 * maintainer's request for one trial run, not the configuration the evals and
 * the trial prove, so refilling them leaves the retained candidate alone. */
test("the trial's own test request is neither the candidate nor its retained bytes", () => {
  const input = held(true)
  const refilled = {
    ...input,
    draft: {
      ...input.draft,
      trialTitle: "[canary] Reproduce the reported crash",
      trialBody: JSON.stringify({ source: "github", number: 2 })
    }
  }
  assert.equal(setupCandidate({ ...refilled, draft: JSON.parse(JSON.stringify(refilled.draft)) }), input.digest)
  assert.deepEqual(candidateFiles(refilled), candidateFiles(input))
  for (const contents of Object.values(candidateFiles(refilled))) {
    assert(!contents.includes("Reproduce the reported crash"))
  }
})

test("the evaluated job receives no case material and still verifies the configuration it carries", () => {
  const input = held(true), candidate = evaluatedCandidate(input)
  const job = Schema.decodeUnknownSync(JobInput)({
    ...candidate,
    sourceRevision,
    event: { ...event, deliveryKey: "eval-key" }
  })
  assert(!JSON.stringify(job).includes("HELD_OUT_EXPECTATION"))
  assert.deepEqual(job.configuration.cases, [])
  assert.deepEqual({ ...job.configuration, cases: input.draft.cases }, input.draft)
  // Re-pinned when the trial's own test request left the candidate.
  assert.equal(input.digest, "ce1f5de8fcbe7154e5ce145a0e8b474e09742e67be8340fce3c82db18093917d")
  assert.equal(job.digest, "5ca740ed1ed3e3a2f15d993d8b80dc972de3fcd8c422553f5eb98fcd1a0396e8")
  assert.doesNotThrow(() =>
    Schema.decodeUnknownSync(JobInput)({
      repo: input.repo,
      job: input.job,
      revision: input.revision,
      digest: input.digest,
      configuration: input.draft,
      sourceRevision,
      event: { ...event, deliveryKey: "live-key" }
    })
  )
})

test("the retained deterministic assertions and the judge's verdict decide the held-out case", () => {
  const input = held(true), test = input.draft.cases[0]!
  assert.equal(test.expected, heldOut)
  assert.equal(assessScore(test, observedQuestion("question"), score).status, "passed")
  assert.equal(assessScore(test, observedQuestion("bug"), score).status, "failed")
  assert.equal(assessScore(test, observedQuestion("question"), { ...score, verdict: "fail" }).status, "failed")
})
