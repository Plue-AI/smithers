import { Fault, FlowRuntime } from "@smthrs/flow"
import * as Evaluator from "@smthrs/model/Evaluator"
import { Effect, Layer, Schema } from "effect"
import assert from "node:assert/strict"
import { test } from "node:test"
import * as Journal from "../../packages/smithers/flows/journal/src/Journal.ts"
import { CodingError } from "../coding/schema.ts"
import { intakeScreenedEvent, maximumStateBytes, maximumStates, screenEvent } from "../repository/intake.ts"
import type { JobInput } from "../repository/schema.ts"

const repo = "example/repo"
const encoder = new TextEncoder()
const encodedBytes = (value: unknown) => encoder.encode(JSON.stringify(value)).length
const event = (payload: unknown): JobInput["event"] => ({
  source: "smithers-cloud",
  type: "issues",
  action: "opened",
  deliveryKey: "delivery-bounds",
  issueNumber: 7,
  payload: payload as Schema.Json
})

const evaluator = () => {
  const states: Array<Record<string, unknown>> = []
  const layer = Evaluator.layerScripted((request) => {
    states.push(request.state as Record<string, unknown>)
    return {
      injection: { probability: 0.01 },
      kind: { choice: "bug", probabilities: { bug: 0.8 } },
      urgency: { score: 0 }
    }
  })
  return { layer, states }
}

const screen = (payload: unknown, layer: Layer.Layer<Evaluator.Evaluator>) =>
  Effect.runPromise(screenEvent({ repo, event: event(payload), payload }).pipe(Effect.provide(layer)))

const failedScreen = (payload: unknown, layer: Layer.Layer<Evaluator.Evaluator>) =>
  Effect.runPromise(Effect.result(screenEvent({ repo, event: event(payload), payload }).pipe(Effect.provide(layer))))

const recordedScreen = async (payload: unknown, layer: Layer.Layer<Evaluator.Evaluator>) => {
  const records: Array<{ readonly eventType: string; readonly payload: Record<string, unknown> }> = []
  const journal = Layer.succeed(Journal.Journal, {
    emitLossy: (input: any) =>
      Effect.sync(() => {
        records.push({ eventType: input.eventType, payload: input.payload })
        return { _tag: "Accepted" }
      })
  } as never)
  const result = await Effect.runPromise(Effect.result(
    screenEvent({ repo, event: event(payload), payload }).pipe(
      Effect.provide(layer),
      Effect.provide(journal),
      Effect.provideService(FlowRuntime.FlowInstance, { executionId: "job-root" } as never)
    )
  ))
  assert.equal(records.length, 1)
  assert.equal(records[0]!.eventType, intakeScreenedEvent)
  return { result, receipt: records[0]!.payload }
}

const commentState = (body: string) => ({ repo, source: "comment", title: "", body, author: "" })
const issueState = (body: string) => ({ repo, source: "issue", title: "bug", body, author: "reporter" })
const bodyAtEncodedBytes = (target: number, prefix = "") => {
  const base = encodedBytes(commentState(prefix))
  assert.ok(base <= target)
  return prefix + "x".repeat(target - base)
}

test("the classifier limits are exactly 32768 JSON bytes and 64 texts", () => {
  assert.equal(maximumStateBytes, 32768)
  assert.equal(maximumStates, 64)
})

test("a complete JSON state at exactly 32 KiB is screened and accounted for", async () => {
  const body = bodyAtEncodedBytes(maximumStateBytes)
  const payload = { comment: { body } }
  const judge = evaluator()
  const { result, receipt } = await recordedScreen(payload, judge.layer)
  assert.equal(result._tag, "Success")
  assert.equal(encodedBytes(commentState(body)), maximumStateBytes)
  assert.equal(judge.states.length, 1)
  assert.ok(JSON.stringify(judge.states[0]) === JSON.stringify(commentState(body)), "the full state reaches Jev")
  if (result._tag === "Success") assert.equal(result.success.payload, payload)
  assert.deepEqual(receipt.coverage, {
    totalTexts: 1,
    screenedTexts: 1,
    texts: [{ id: "comment", stateBytes: maximumStateBytes, screened: true }]
  })
})

test("an oversized issue suffix is refused before evaluation", async () => {
  const marker = "END_OF_UNSCREENED_ISSUE"
  const bytesWithoutBody = encodedBytes(issueState(""))
  const body = "x".repeat(maximumStateBytes + 1 - bytesWithoutBody - marker.length) + marker
  const payload = { issue: { title: "bug", body, user: { login: "reporter" } } }
  const judge = evaluator()
  const { result, receipt } = await recordedScreen(payload, judge.layer)
  assert.equal(encodedBytes(issueState(body)), maximumStateBytes + 1)
  assert.ok(body.endsWith(marker))
  assert.equal(result._tag, "Failure")
  if (result._tag === "Failure") {
    assert.ok(result.failure instanceof CodingError)
    assert.equal(result.failure.code, "invalid_request")
    assert.equal(Fault.of(result.failure).class, "user")
    assert.match(result.failure.message, /incomplete screening/)
  }
  assert.deepEqual(judge.states, [])
  assert.deepEqual(receipt.coverage, {
    totalTexts: 1,
    screenedTexts: 0,
    texts: [{ id: "issue", stateBytes: maximumStateBytes + 1, screened: false }]
  })
})

test("one encoded byte over 32 KiB fails before the evaluator sees a clipped state", async () => {
  const body = bodyAtEncodedBytes(maximumStateBytes + 1)
  const judge = evaluator()
  const { result, receipt } = await recordedScreen({ comment: { body } }, judge.layer)
  assert.equal(result._tag, "Failure")
  if (result._tag === "Failure") {
    assert.ok(result.failure instanceof CodingError)
    assert.equal(result.failure.code, "invalid_request")
    assert.equal(Fault.of(result.failure).class, "user")
    assert.match(result.failure.message, /incomplete screening/)
  }
  assert.deepEqual(judge.states, [])
  assert.equal(receipt.action, "failed")
  assert.deepEqual(receipt.coverage, {
    totalTexts: 1,
    screenedTexts: 0,
    texts: [{ id: "comment", stateBytes: maximumStateBytes + 1, screened: false }]
  })
})

test("title and author are passed in full when their complete state fits", async () => {
  const title = "t".repeat(1_001)
  const author = "a".repeat(201)
  const payload = { issue: { title, body: "repro", user: { login: author } } }
  const judge = evaluator()
  const screened = await screen(payload, judge.layer)
  assert.equal(screened.screening.action, "proceed")
  assert.equal(judge.states.length, 1)
  assert.equal(judge.states[0]!.title, title)
  assert.equal(judge.states[0]!.author, author)
  assert.ok(JSON.stringify(judge.states[0]) === JSON.stringify({ repo, source: "issue", title, body: "repro", author }))
  assert.equal(screened.payload, payload)
})

test("escaped JSON and Unicode count toward the exact state boundary", async () => {
  const prefix = "😀\"\\\n"
  const body = bodyAtEncodedBytes(maximumStateBytes, prefix)
  const judge = evaluator()
  const screened = await screen({ comment: { body } }, judge.layer)
  assert.equal(encodedBytes(commentState(body)), maximumStateBytes)
  assert.equal(screened.screening.action, "proceed")
  assert.equal(judge.states.length, 1)
  assert.ok(
    JSON.stringify(judge.states[0]) === JSON.stringify(commentState(body)),
    "JSON escaping is counted without clipping"
  )

  const tooLarge = `${body}\"`
  const rejected = evaluator()
  const failure = await failedScreen({ comment: { body: tooLarge } }, rejected.layer)
  assert.equal(encodedBytes(commentState(tooLarge)), maximumStateBytes + 2)
  assert.equal(failure._tag, "Failure")
  if (failure._tag === "Failure") {
    assert.ok(failure.failure instanceof CodingError)
    assert.equal(failure.failure.code, "invalid_request")
    assert.equal(Fault.of(failure.failure).class, "user")
    assert.match(failure.failure.message, /incomplete screening/)
  }
  assert.deepEqual(rejected.states, [])
})

test("64 texts are all screened; a 65th text fails the event instead of disappearing", async () => {
  const issue = { title: "bug", body: "reported issue", user: { login: "reporter" } }
  const first64 = {
    issue,
    authorReplies: Array.from({ length: maximumStates - 1 }, (_, index) => ({ body: `reply ${index}` }))
  }
  const within = evaluator()
  const screened = await screen(first64, within.layer)
  assert.equal(within.states.length, maximumStates)
  assert.equal(screened.screening.answers.length, maximumStates)
  assert.equal(screened.screening.answers[0]?.id, "issue")
  assert.equal(screened.screening.answers.at(-1)?.id, `authorReplies.${maximumStates - 2}`)

  const extra = { issue, authorReplies: [...first64.authorReplies, { body: "last reply must not pass unscreened" }] }
  const overflow = evaluator()
  const { result, receipt } = await recordedScreen(extra, overflow.layer)
  assert.equal(result._tag, "Failure")
  if (result._tag === "Failure") {
    assert.ok(result.failure instanceof CodingError)
    assert.equal(result.failure.code, "invalid_request")
    assert.equal(Fault.of(result.failure).class, "user")
    assert.match(result.failure.message, /incomplete screening/)
  }
  assert.deepEqual(overflow.states, [])
  assert.equal(receipt.action, "failed")
  const coverage = receipt.coverage as {
    totalTexts: number
    screenedTexts: number
    texts: Array<{ id: string; stateBytes: number; screened: boolean }>
  }
  assert.equal(coverage.totalTexts, maximumStates + 1)
  assert.equal(coverage.screenedTexts, 0)
  assert.deepEqual(coverage.texts.map((text) => text.id), [
    "issue",
    ...Array.from({ length: maximumStates }, (_, index) => `authorReplies.${index}`)
  ])
  assert.deepEqual(coverage.texts.map((text) => text.screened), Array(maximumStates + 1).fill(false))
})

test("a partial evaluator failure records exactly which texts were screened", async () => {
  let calls = 0
  const layer = Evaluator.layerScripted(() => {
    if (calls++ === 0) {
      return {
        injection: { probability: 0.01 },
        kind: { choice: "bug", probabilities: { bug: 0.8 } },
        urgency: { score: 0 }
      }
    }
    return Effect.fail(new Evaluator.EvaluatorError({ code: "timeout", message: "gateway timed out" }))
  })
  const issue = { title: "bug", body: "reported issue", user: { login: "reporter" } }
  const comment = { body: "more detail" }
  const { result, receipt } = await recordedScreen({ issue, comment }, layer)
  assert.equal(calls, 2)
  assert.equal(result._tag, "Failure")
  if (result._tag === "Failure") {
    assert.ok(result.failure instanceof CodingError)
    assert.equal(result.failure.code, "unavailable")
    assert.equal(Fault.of(result.failure).class, "dependency")
  }
  assert.equal(receipt.action, "failed")
  assert.deepEqual(receipt.coverage, {
    totalTexts: 2,
    screenedTexts: 1,
    texts: [
      { id: "issue", stateBytes: encodedBytes(issueState(issue.body)), screened: true },
      { id: "comment", stateBytes: encodedBytes(commentState(comment.body)), screened: false }
    ]
  })
})

test("oversized PR title, author, or repository fails without an evaluator or journal", async () => {
  const cases = [
    { repo, payload: { pull_request: { title: "p".repeat(maximumStateBytes), body: "repro" } } },
    { repo, payload: { issue: { title: "bug", body: "repro", user: { login: "a".repeat(maximumStateBytes) } } } },
    { repo: "r".repeat(maximumStateBytes), payload: { comment: { body: "repro" } } }
  ]
  for (const candidate of cases) {
    const result = await Effect.runPromise(Effect.result(
      screenEvent({ repo: candidate.repo, event: event(candidate.payload), payload: candidate.payload }).pipe(
        Effect.provide(Evaluator.layerUnavailable())
      )
    ))
    assert.equal(result._tag, "Failure")
    if (result._tag === "Failure") {
      assert.ok(result.failure instanceof CodingError)
      assert.equal(result.failure.code, "invalid_request")
      assert.equal(Fault.of(result.failure).class, "user")
      assert.match(result.failure.message, /incomplete screening/)
    }
  }
})
