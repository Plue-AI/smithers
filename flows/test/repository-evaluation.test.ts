import * as Digest from "@smthrs/core/Digest"
import { Schema } from "effect"
import assert from "node:assert/strict"
import { test } from "node:test"
import { CodingError } from "../coding/schema.ts"
import { assessScore } from "../repository/evaluation.ts"
import { retainedStepError } from "../repository/jobs.ts"
import type { JobResult } from "../repository/schema.ts"
import { SuggestedCaseInput } from "../repository/setup.ts"

const observedCheck = (policy: "report" | "required", status: "passed" | "failed" | "error"): JobResult => {
  const blocked = policy === "required" && status !== "passed"
  return {
    repo: "example/repo",
    job: "ci",
    revision: 1,
    digest: "a".repeat(64),
    sourceRevision: "b".repeat(40),
    eventKey: "case-check",
    status: blocked ? "partial" : "completed",
    publicActions: [],
    results: [{
      stepId: "checks",
      status: blocked ? "error" : "completed",
      summary: blocked ? "1 required checks blocked" : "Check completed",
      executionId: "actual-check-step",
      evidence: ["execution:actual-ai-check", `source:${"b".repeat(40)}`],
      output: {
        base: "c".repeat(40),
        candidate: "b".repeat(40),
        gate: blocked ? "blocked" : "passed",
        results: [{
          checkId: "observability",
          policy,
          status,
          summary: status === "failed" ? "Handler omits request telemetry" : status,
          executionId: "actual-ai-check",
          evidence: ["execution:actual-ai-check"],
          detail: status === "error" ?
            null
            : {
              verdict: status === "passed" ? "pass" : "fail",
              examinedPaths: ["handler.ts"],
              findings: status === "passed" ?
                []
                : [{ path: "handler.ts", line: 1, message: "Handler omits request telemetry" }]
            }
        }]
      }
    }]
  }
}
const expectedCheck = (observed: JobResult, status: "passed" | "failed" | "error") => ({
  id: "observability-case",
  name: status === "failed" ? "Catch missing telemetry" : "Check telemetry",
  required: true,
  input: JSON.stringify({
    sourceRevision: observed.sourceRevision,
    event: { source: "github", type: "pull_request", action: "opened", deliveryKey: "case-check", payload: {} },
    assertions: [{ path: "/results/0/output/results/0/status", equals: status }]
  }),
  expected: status === "failed" ? "Identify the missing request telemetry with a concrete finding" : `Record ${status}`
})
const checkScore = {
  verdict: "pass" as const,
  reason: "The recorded result matches the expected behavior",
  evidenceIds: [1]
}
const proposedCheck = (
  policy: "report" | "required",
  status: "passed" | "failed" | "error",
  baseline?: "failed" | "error"
) => {
  const observed = observedCheck(policy, status)
  const proposal = [{ path: "handler.ts", beforeDigest: null, content: "export const handler = () => 1\n" }]
  const candidate = `${observed.sourceRevision}+${Digest.digest(Digest.canonical(proposal))}`
  const checked = observed.results[0]!, output = checked.output as Record<string, Schema.Json>
  output.base = observed.sourceRevision
  output.candidate = candidate
  const checks = [checked]
  if (baseline) {
    const measured = observedCheck("required", baseline).results[0]!,
      detail = measured.output as Record<string, Schema.Json>
    detail.base = observed.sourceRevision
    detail.candidate = `${observed.sourceRevision}+${"d".repeat(64)}`
    checks.unshift(measured)
  }
  const result: JobResult = {
    ...observed,
    job: "feature",
    results: [{
      ...checked,
      stepId: "feature",
      output: {
        status: status === "failed" && policy === "required" ? "proposal" : "checked-proposal",
        proposal,
        checks: JSON.parse(JSON.stringify(checks)),
        children: [],
        question: ""
      }
    }]
  }
  const expected = {
    ...expectedCheck(observed, status),
    input: JSON.stringify({
      sourceRevision: observed.sourceRevision,
      event: {
        source: "smithers-cloud",
        type: "manual",
        action: "manual:feature",
        manualStep: "feature",
        deliveryKey: "case-check",
        payload: { prompt: "Add handler" }
      },
      assertions: [{ path: `/results/0/output/checks/${checks.length - 1}/output/results/0/status`, equals: status }]
    })
  }
  return { result, expected }
}

test("nested proposal AI findings can be judged under report and required policies", () => {
  for (const policy of ["report", "required"] as const) {
    for (const status of ["passed", "failed"] as const) {
      const { result, expected } = proposedCheck(policy, status, "failed")
      assert.equal(
        assessScore(expected, result, checkScore).status,
        "passed",
        `${policy} ${status} with a measured regression baseline`
      )
      assert.equal(assessScore(expected, result, { ...checkScore, verdict: "fail" }).status, "failed")
      assert.equal(assessScore(expected, result, { ...checkScore, evidenceIds: [] }).status, "review")
    }
  }
})

test("nested baseline or candidate execution errors cannot pass even with favorable independent judgment", () => {
  for (const policy of ["report", "required"] as const) {
    const { result, expected } = proposedCheck(policy, "error")
    assert.equal(assessScore(expected, result, checkScore).status, "error", `${policy} candidate error`)
  }
  const { result, expected } = proposedCheck("report", "passed", "error")
  assert.equal(
    assessScore(expected, result, checkScore).status,
    "error",
    "an unavailable regression test cannot hide behind a later passing candidate"
  )
})

test("unavailable checks remain execution errors when they also miss the expected verdict", () => {
  const direct = observedCheck("report", "error")
  assert.equal(assessScore(expectedCheck(direct, "passed"), direct, checkScore).status, "error")
  const { result } = proposedCheck("report", "error")
  const { expected } = proposedCheck("report", "passed")
  assert.equal(
    assessScore(expected, result, checkScore).status,
    "error",
    "the expected pass cannot relabel unavailability as a code finding"
  )
})

test("an honest baseline-only refusal remains judgeable while unrelated parent failures stay errors", () => {
  const { result, expected } = proposedCheck("report", "passed", "failed")
  const output = result.results[0]!.output as Record<string, any>
  output.checks.pop()
  output.status = "proposal"
  const refused: JobResult = {
    ...result,
    status: "needs-maintainer",
    results: [{ ...result.results[0]!, status: "needs-maintainer" }]
  }
  const test = {
    ...expected,
    input: JSON.stringify({
      sourceRevision: result.sourceRevision,
      event: {
        source: "smithers-cloud",
        type: "manual",
        action: "manual:feature",
        manualStep: "feature",
        deliveryKey: "case-check",
        payload: { prompt: "Add handler" }
      },
      assertions: [{ path: "/results/0/status", equals: "needs-maintainer" }]
    })
  }
  assert.equal(assessScore(test, refused, checkScore).status, "passed")
  const clean = proposedCheck("report", "passed")
  const broken: JobResult = { ...clean.result, results: [{ ...clean.result.results[0]!, status: "error" }] }
  assert.equal(
    assessScore(clean.expected, broken, checkScore).status,
    "error",
    "a passing child cannot erase an unrelated parent failure"
  )
})

test("a completed proposal needs its exact final check and cannot substitute malformed or baseline-only output", () => {
  for (const mode of ["malformed", "baseline-only", "wrong-source"] as const) {
    const { result, expected } = proposedCheck("report", "passed", "failed")
    const output = result.results[0]!.output as Record<string, any>
    if (mode === "malformed") output.checks[1].output = { gate: "passed", results: [] }
    if (mode === "baseline-only") output.checks.pop()
    if (mode === "wrong-source") output.checks[1].output.candidate = "f".repeat(40)
    const test = {
      ...expected,
      input: JSON.stringify({
        sourceRevision: result.sourceRevision,
        event: {
          source: "smithers-cloud",
          type: "manual",
          action: "manual:feature",
          manualStep: "feature",
          deliveryKey: "case-check",
          payload: { prompt: "Add handler" }
        },
        assertions: [{ path: "/results/0/status", equals: "completed" }]
      })
    }
    assert.equal(assessScore(test, result, checkScore).status, "error", mode)
  }
})

test("AI-check evals accept correct clean and violation verdicts under both report and required policies", () => {
  for (const policy of ["report", "required"] as const) {
    for (const status of ["passed", "failed"] as const) {
      const observed = observedCheck(policy, status)
      assert.equal(
        assessScore(expectedCheck(observed, status), observed, checkScore).status,
        "passed",
        `${policy} ${status}`
      )
    }
  }
})

test("AI-check execution failures cannot pass evals even when report-only and the judge accepts them", () => {
  for (const policy of ["report", "required"] as const) {
    const observed = observedCheck(policy, "error")
    assert.equal(assessScore(expectedCheck(observed, "error"), observed, checkScore).status, "error", policy)
  }
  const observed = observedCheck("required", "failed")
  const output = observed.results[0]!.output as { results: Array<Record<string, Schema.Json>> }
  output.results.push({
    ...output.results[0]!,
    checkId: "optional-context",
    policy: "report",
    status: "error",
    detail: null
  })
  assert.equal(
    assessScore(expectedCheck(observed, "failed"), observed, checkScore).status,
    "error",
    "a valid violation cannot mask a second unavailable check"
  )
})

test("expected required violations still need matching assertions, independent judgment and real evidence", () => {
  const observed = observedCheck("required", "failed"), expected = expectedCheck(observed, "failed")
  assert.equal(assessScore(expected, observed, { ...checkScore, verdict: "fail" }).status, "failed")
  assert.equal(assessScore(expected, observed, { ...checkScore, verdict: "review" }).status, "review")
  for (const evidenceIds of [[], [999]]) {
    assert.equal(assessScore(expected, observed, { ...checkScore, evidenceIds }).status, "review")
  }
  assert.equal(assessScore(expectedCheck(observed, "passed"), observed, checkScore).status, "failed")
})

test("policy-failure evaluation exceptions do not admit malformed outcomes or source-capture errors", () => {
  for (const output of [null, { code: "source_unavailable" }, { gate: "blocked", results: [] }]) {
    const original = observedCheck("required", "failed")
    const observed: JobResult = { ...original, results: [{ ...original.results[0]!, output }] }
    const expected = {
      ...expectedCheck(observed, "failed"),
      input: JSON.stringify({
        sourceRevision: observed.sourceRevision,
        event: { source: "github", type: "pull_request", action: "opened", deliveryKey: "case-check", payload: {} },
        assertions: [{ path: "/results/0/status", equals: "error" }]
      })
    }
    assert.equal(assessScore(expected, observed, checkScore).status, "error")
  }
  const observed = observedCheck("required", "failed")
  ;(observed.results[0]!.output as Record<string, unknown>).gate = "passed"
  assert.equal(
    assessScore(expectedCheck(observed, "failed"), observed, checkScore).status,
    "error",
    "a contradictory recorded gate is not an expected policy block"
  )
})

test("eval evidence selects recorded references and cannot turn bad assertions or execution errors into a pass", () => {
  const observed: JobResult = {
    repo: "example/repo",
    job: "issues",
    revision: 1,
    digest: "a".repeat(64),
    sourceRevision: "b".repeat(40),
    eventKey: "case-1",
    status: "completed",
    publicActions: [],
    results: [{
      stepId: "research",
      status: "completed",
      summary: "The greeting is hello",
      evidence: ["source:greeting.mjs@0123"],
      output: { classification: "question" },
      executionId: "actual-step"
    }]
  }
  const expected = {
    id: "case-1",
    name: "Question",
    input: JSON.stringify({
      sourceRevision: observed.sourceRevision,
      event: { source: "smithers-cloud", type: "issues", action: "opened", deliveryKey: "case-1", payload: {} },
      assertions: [{ path: "/results/0/output/classification", equals: "question" }]
    }),
    expected: "Cite the greeting's source",
    required: true
  }
  const score = { verdict: "pass" as const, reason: "The result matches the source", evidenceIds: [1] }
  assert.deepEqual(assessScore(expected, observed, score), {
    status: "passed",
    observed: score.reason,
    evidence: ["source:greeting.mjs@0123"]
  })
  for (const evidenceIds of [[], [-1], [1.5], [99]]) {
    const assessment = assessScore(expected, observed, { ...score, evidenceIds })
    assert.equal(assessment.status, "review")
    assert.deepEqual(assessment.evidence, [])
  }
  assert.equal(
    assessScore(
      expected,
      { ...observed, results: [{ ...observed.results[0]!, output: { classification: "bug" } }] },
      score
    ).status,
    "failed"
  )
  assert.equal(
    assessScore(
      expected,
      { ...observed, status: "error", results: [{ ...observed.results[0]!, status: "error" }] },
      score
    ).status,
    "error"
  )
})

test("authored evals include their task, and retained failures remain valid JSON", () => {
  const input = {
    sourceRevision: "a".repeat(40),
    event: {
      source: "smithers-cloud",
      type: "issues",
      action: "opened",
      deliveryKey: "case-1",
      payload: { issue: { title: "What greeting is exported?", body: "Inspect greeting.mjs" } }
    },
    assertions: [{ path: "/results/0/output/classification", equals: "question" }]
  }
  assert.doesNotThrow(() => Schema.decodeUnknownSync(SuggestedCaseInput)(input))
  assert.throws(() =>
    Schema.decodeUnknownSync(SuggestedCaseInput)({ ...input, event: { ...input.event, payload: {} } })
  )
  assert.throws(() =>
    Schema.decodeUnknownSync(SuggestedCaseInput)({
      ...input,
      assertions: [{ path: "/results/0/output/greeting", equals: "hello" }]
    })
  )
  const failure = new CodingError({ code: "invalid_receipt", message: "A source citation was not captured" })
  assert.deepEqual(Schema.decodeUnknownSync(Schema.Json)(retainedStepError(failure)), {
    _tag: "coding/Error",
    code: "invalid_receipt",
    message: "A source citation was not captured"
  })
  assert.deepEqual(Schema.decodeUnknownSync(Schema.Json)(retainedStepError(new Error("Process unavailable"))), {
    message: "Process unavailable"
  })
  assert.doesNotThrow(() => Schema.decodeUnknownSync(Schema.Json)(retainedStepError(undefined)))
})
