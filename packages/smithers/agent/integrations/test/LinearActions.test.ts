/**
 * The Linear update and comment actions, executed through the real flow
 * runtime against a stateful fake Linear on a real socket.
 */
import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import { FlowEngine } from "@smthrs/engine"
import { Action, Flow, Interpreter } from "@smthrs/flow"
import { Effect, Layer, type Schema } from "effect"
import { afterEach, describe, expect, it } from "vitest"
import { IntegrationFailure } from "../src/core/ActionFailure.ts"
import * as Actions from "../src/linear/Actions.ts"
import * as LinearClient from "../src/linear/LinearClient.ts"
import { type FakeLinear, startLinear } from "./LinearFake.ts"

let linear: FakeLinear | undefined

afterEach(async () => {
  await linear?.fixture.close()
  linear = undefined
})

type LinearTag = Layer.Success<typeof Actions.layer> extends Action.Requirement<infer Tag> ? Tag : never
type PureSchema = { readonly DecodingServices: never; readonly EncodingServices: never }

const runAction = <
  Tag extends LinearTag,
  Payload extends Flow.AnyStructSchema & PureSchema,
  Success extends Schema.Top & PureSchema,
  Error extends Schema.Top & PureSchema
>(
  declaration: Action.Declared<Tag, Payload, Success, Error>,
  payload: Payload["~type.make.in"],
  executionId = `run-${declaration.name}-${Math.random()}`
): Promise<Success["Type"]> => {
  const flow = Flow.make(`${declaration.name}/test-flow`, {
    payload: declaration.payloadSchema,
    success: declaration.successSchema,
    error: declaration.errorSchema,
    // The cast is on the payload value only (decoded Type vs planned make-in); R is untouched.
    body: (input) => declaration.call(input as never)
  })
  const clientLayer = LinearClient.layer({
    apiKey: "lin_api_fixture",
    apiBaseUrl: (linear as FakeLinear).fixture.origin
  }, {})
  const implementation = Actions.layer as Layer.Layer<
    Action.Requirement<Tag>,
    never,
    Layer.Services<typeof Actions.layer>
  >
  const layer = Layer.mergeAll(implementation, Interpreter.layer(flow)).pipe(
    Layer.provideMerge(Action.layerImplementations),
    Layer.provideMerge(Layer.mergeAll(FlowEngine.layerMemory, clientLayer, NodeCrypto.layer))
  )
  return Effect.runPromise(flow.execute(payload, { executionId }).pipe(Effect.provide(layer), Effect.scoped))
}

const rejected = async (promise: Promise<unknown>): Promise<any> => {
  const failure: any = await promise.then(() => undefined, (error: unknown) => error)
  return failure?.cause?.error ?? failure?.error ?? failure
}

describe("UpdateIssue", () => {
  it("resolves the identifier and sets only the fields given", async () => {
    linear = await startLinear()
    const updated = await runAction(Actions.UpdateIssue, { issue: "ENG-1", title: "Parser v2", priority: "high" })
    expect(updated).toEqual({
      id: linear.issue.id,
      identifier: "ENG-1",
      title: "Parser v2",
      url: "https://linear.test/ENG-1"
    })
    expect(linear.issue).toMatchObject({ title: "Parser v2", priority: 2 })
    const update = linear.fixture.requests.map((request) => JSON.parse(request.body)).find((body) =>
      body.query.includes("issueUpdate")
    )
    expect(update.variables).toEqual({ id: linear.issue.id, input: { title: "Parser v2", priority: 2 } })
  })

  it("repeats an update whose answer was lost and leaves the same issue", async () => {
    linear = await startLinear()
    linear.lose = true
    const updated = await runAction(Actions.UpdateIssue, { issue: linear.issue.id, title: "Renamed" })
    expect(updated.title).toBe("Renamed")
    expect(linear.mutations()).toEqual(["IssueUpdate", "IssueUpdate"])
  })

  it("keys the step by the fields it sets", () => {
    const key = Actions.UpdateIssue.idempotencyKey as (payload: unknown) => unknown
    expect(key({ issue: "ENG-1", priority: 2 })).toEqual({
      action: "integrations/linear/update-issue",
      issue: "ENG-1",
      priority: 2
    })
    expect(Actions.UpdateIssue.tier).toBe("irreversible")
  })

  it("refuses a priority outside Linear's scale before any request", async () => {
    linear = await startLinear()
    await expect(runAction(Actions.UpdateIssue, { issue: "ENG-1", priority: 9 as never })).rejects.toBeDefined()
    expect(linear.fixture.requests).toHaveLength(0)
  })
})

describe("CommentOnIssue", () => {
  it("posts once under the UUID its step names", async () => {
    linear = await startLinear()
    const comment = await runAction(Actions.CommentOnIssue, { issue: "ENG-1", body: "Fixed in abc" })
    expect(comment).toMatchObject({ issueId: linear.issue.id, body: "Fixed in abc", created: true })
    expect(comment.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    expect(linear.issue.comments).toEqual([{ id: comment.id, body: "Fixed in abc" }])
    const create = JSON.parse(linear.fixture.requests[1]?.body ?? "{}")
    expect(create.variables.input).toEqual({ id: comment.id, issueId: linear.issue.id, body: "Fixed in abc" })
  })

  it("repeats a comment whose answer was lost and finds it instead of posting again", async () => {
    linear = await startLinear()
    linear.lose = true
    const comment = await runAction(Actions.CommentOnIssue, { issue: "ENG-1", body: "hello" })
    expect(comment.created).toBe(false)
    expect(linear.issue.comments).toHaveLength(1)
    expect(linear.mutations()).toEqual(["CommentCreate"])
  })

  it("posts a separate comment for a separate run", async () => {
    linear = await startLinear()
    const first = await runAction(Actions.CommentOnIssue, { issue: "ENG-1", body: "same" }, "run-a")
    const second = await runAction(Actions.CommentOnIssue, { issue: "ENG-1", body: "same" }, "run-b")
    expect(first.id).not.toBe(second.id)
    expect(linear.issue.comments).toHaveLength(2)
  })

  it("fails without posting when the issue does not exist", async () => {
    linear = await startLinear()
    const failure = await rejected(runAction(Actions.CommentOnIssue, { issue: "ENG-404", body: "x" }))
    expect(failure).toBeInstanceOf(IntegrationFailure)
    expect(failure.reason).toBe("decode-failed")
    expect(failure.message).toContain("ENG-404")
    expect(linear.mutations()).toEqual([])
  })

  it("derives a stable version-4 shaped UUID from a key", () => {
    const id = Actions.commentId("k")
    expect(Actions.commentId("k")).toBe(id)
    expect(Actions.commentId("k2")).not.toBe(id)
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  })
})
