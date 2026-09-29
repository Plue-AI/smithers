/**
 * The GitHub write-back actions, executed through the real flow runtime
 * against a stateful fake GitHub on a real socket.
 *
 * Each case runs one action as the body of a flow on `FlowEngine.layerMemory`,
 * so the payload decodes, the idempotency key is computed, the engine's retry
 * policy applies and the result crosses the journal's schema. The recovery
 * cases are the reason the actions exist: a write GitHub applied but whose
 * answer was lost is repeated, and the repeat finds its own work.
 */
import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import { FlowEngine } from "@smthrs/engine"
import { Action, Flow, Interpreter } from "@smthrs/flow"
import { Effect, Layer, type Schema } from "effect"
import { afterEach, describe, expect, it } from "vitest"
import { IntegrationFailure } from "../src/core/ActionFailure.ts"
import * as Actions from "../src/github/Actions.ts"
import * as GitHubClient from "../src/github/GitHubClient.ts"
import { type FakeGitHub, startGitHub } from "./GitHubFake.ts"

let github: FakeGitHub | undefined

afterEach(async () => {
  await github?.fixture.close()
  github = undefined
})

type GitHubTag = Layer.Success<typeof Actions.layer> extends Action.Requirement<infer Tag> ? Tag : never
type PureSchema = { readonly DecodingServices: never; readonly EncodingServices: never }

const runAction = <
  Tag extends GitHubTag,
  Payload extends Flow.AnyStructSchema & PureSchema,
  Success extends Schema.Top & PureSchema,
  Error extends Schema.Top & PureSchema
>(
  declaration: Action.Declared<Tag, Payload, Success, Error>,
  payload: Payload["~type.make.in"]
): Promise<Success["Type"]> => {
  const flow = Flow.make(`${declaration.name}/test-flow`, {
    payload: declaration.payloadSchema,
    success: declaration.successSchema,
    error: declaration.errorSchema,
    // The cast is on the payload value only (decoded Type vs planned make-in); R is untouched.
    body: (input) => declaration.call(input as never)
  })
  const clientLayer = GitHubClient.layer({ token: "t", apiBaseUrl: (github as FakeGitHub).fixture.origin }, {})
  const implementation = Actions.layer as Layer.Layer<
    Action.Requirement<Tag>,
    never,
    Layer.Services<typeof Actions.layer>
  >
  const layer = Layer.mergeAll(implementation, Interpreter.layer(flow)).pipe(
    Layer.provideMerge(Action.layerImplementations),
    Layer.provideMerge(Layer.mergeAll(FlowEngine.layerMemory, clientLayer, NodeCrypto.layer))
  )
  return Effect.runPromise(
    flow.execute(payload, { executionId: `run-${declaration.name}-${Math.random()}` }).pipe(
      Effect.provide(layer),
      Effect.scoped
    )
  )
}

const rejected = async (promise: Promise<unknown>): Promise<any> => {
  const failure: any = await promise.then(() => undefined, (error: unknown) => error)
  return failure?.cause?.error ?? failure?.error ?? failure
}

const SHA = "a".repeat(40)

describe("AddLabels", () => {
  it("adds only the labels the issue lacks, comparing names without case", async () => {
    github = await startGitHub()
    github.labels = ["Bug"]
    const added = await runAction(Actions.AddLabels, {
      owner: "o",
      repo: "r",
      issueNumber: 7,
      labels: ["bug", "triage", "triage"]
    })
    expect(added).toEqual({ added: ["triage"], labels: ["Bug", "triage"] })
    expect(github.writes()).toEqual(["POST /repos/o/r/issues/7/labels"])
    expect(JSON.parse(github.fixture.requests[1]?.body ?? "{}")).toEqual({ labels: ["triage"] })
  })

  it("writes nothing when every label is already there", async () => {
    github = await startGitHub()
    github.labels = ["bug"]
    const added = await runAction(Actions.AddLabels, { owner: "o", repo: "r", issueNumber: 7, labels: ["BUG"] })
    expect(added).toEqual({ added: [], labels: ["bug"] })
    expect(github.writes()).toEqual([])
  })

  it("repeats a POST whose answer was lost, and the repeat finds the labels", async () => {
    github = await startGitHub()
    github.lose = true
    const added = await runAction(Actions.AddLabels, { owner: "o", repo: "r", issueNumber: 7, labels: ["triage"] })
    expect(added).toEqual({ added: [], labels: ["triage"] })
    expect(github.writes()).toEqual(["POST /repos/o/r/issues/7/labels"])
    expect(github.labels).toEqual(["triage"])
  })

  it("keys the step by what it adds", () => {
    const key = Actions.AddLabels.idempotencyKey as (payload: unknown) => unknown
    expect(key({ owner: "o", repo: "r", issueNumber: 7, labels: ["a"] })).toEqual({
      action: "integrations/github/add-labels",
      owner: "o",
      repo: "r",
      issueNumber: 7,
      labels: ["a"]
    })
    expect(Actions.AddLabels.tier).toBe("irreversible")
    expect(Actions.retryPolicy.maxAttempts).toBe(3)
  })
})

describe("UpsertComment", () => {
  const payload = { owner: "o", repo: "r", issueNumber: 7, key: "run-1", body: "Working" }

  it("posts the comment under its hidden key", async () => {
    github = await startGitHub()
    const sticky = await runAction(Actions.UpsertComment, payload)
    expect(sticky).toMatchObject({ outcome: "created", id: 100 })
    expect(github.comments.map((comment) => comment.body)).toEqual(["<!-- smithers:key=run-1 -->\nWorking"])
  })

  it("edits the same comment on the next upsert, and leaves it when unchanged", async () => {
    github = await startGitHub()
    await runAction(Actions.UpsertComment, payload)
    const updated = await runAction(Actions.UpsertComment, { ...payload, body: "Done" })
    expect(updated).toMatchObject({ outcome: "updated", id: 100 })
    const unchanged = await runAction(Actions.UpsertComment, { ...payload, body: "Done" })
    expect(unchanged).toEqual({ id: 100, url: github.comments[0]?.url, outcome: "unchanged" })
    expect(github.comments).toHaveLength(1)
    expect(github.writes()).toEqual(["POST /repos/o/r/issues/7/comments", "PATCH /repos/o/r/issues/comments/100"])
  })

  it("keeps separate comments for separate keys, and ignores a key quoted mid-comment", async () => {
    github = await startGitHub()
    github.comments.push({ id: 5, url: "u5", body: "see <!-- smithers:key=run-1 -->" })
    await runAction(Actions.UpsertComment, payload)
    await runAction(Actions.UpsertComment, { ...payload, key: "run-2" })
    expect(github.comments).toHaveLength(3)
    expect(github.comments[0]?.body).toBe("see <!-- smithers:key=run-1 -->")
  })

  it("replays a lost POST as a find of the same sticky comment", async () => {
    github = await startGitHub()
    github.lose = true
    const sticky = await runAction(Actions.UpsertComment, payload)
    expect(sticky.outcome).toBe("unchanged")
    expect(github.writes()).toEqual(["POST /repos/o/r/issues/7/comments"])
    expect(github.comments).toHaveLength(1)
  })

  it("refuses to post when the thread is longer than it will search", async () => {
    github = await startGitHub()
    github.endlessComments = true
    const failure = await rejected(runAction(Actions.UpsertComment, payload))
    expect(failure).toBeInstanceOf(IntegrationFailure)
    expect(failure.message).toContain("more comments than 10 pages")
    expect(github.writes()).toEqual([])
  })

  it("refuses a key that could break out of the marker", async () => {
    github = await startGitHub()
    const failure = await rejected(runAction(Actions.UpsertComment, { ...payload, key: "a -->" }))
    expect(failure).toBeDefined()
    expect(github.fixture.requests).toHaveLength(0)
  })
})

describe("CheckRun", () => {
  const payload = {
    owner: "o",
    repo: "r",
    headSha: SHA,
    name: "smithers",
    key: "run-1",
    status: "in_progress" as const
  }

  it("creates the check run under its external id", async () => {
    github = await startGitHub()
    const receipt = await runAction(Actions.CheckRun, {
      ...payload,
      detailsUrl: "https://smithers.test/runs/1",
      output: { title: "Running", summary: "1 of 3" }
    })
    expect(receipt).toEqual({
      id: 100,
      url: "https://github.test/o/r/runs/101",
      status: "in_progress",
      conclusion: null,
      created: true
    })
    const sent = JSON.parse(github.fixture.requests[1]?.body ?? "{}")
    expect(sent).toEqual({
      name: "smithers",
      external_id: "run-1",
      status: "in_progress",
      details_url: "https://smithers.test/runs/1",
      output: { title: "Running", summary: "1 of 3" },
      head_sha: SHA
    })
    const listing = new URL(github.fixture.requests[0]?.url ?? "", "http://x")
    expect(listing.pathname).toBe(`/repos/o/r/commits/${SHA}/check-runs`)
    expect(Object.fromEntries(listing.searchParams)).toEqual({
      check_name: "smithers",
      filter: "all",
      per_page: "100"
    })
  })

  it("updates the same run to its conclusion", async () => {
    github = await startGitHub()
    await runAction(Actions.CheckRun, { ...payload, status: "queued" })
    const done = await runAction(Actions.CheckRun, { ...payload, status: "completed", conclusion: "success" })
    expect(done).toMatchObject({ id: 100, status: "completed", conclusion: "success", created: false })
    expect(github.checkRuns).toHaveLength(1)
    expect(github.writes()).toEqual(["POST /repos/o/r/check-runs", "PATCH /repos/o/r/check-runs/100"])
    expect(JSON.parse(github.fixture.requests[3]?.body ?? "{}")).toEqual({
      name: "smithers",
      external_id: "run-1",
      status: "completed",
      conclusion: "success"
    })
  })

  it("repeats a lost create as an update of the run it made", async () => {
    github = await startGitHub()
    github.lose = true
    const receipt = await runAction(Actions.CheckRun, {
      owner: "o",
      repo: "r",
      headSha: SHA,
      name: "smithers",
      key: "k"
    })
    expect(receipt.created).toBe(false)
    expect(github.checkRuns).toHaveLength(1)
  })

  it("refuses to create when the listing is incomplete", async () => {
    github = await startGitHub()
    github.truncatedCheckRuns = true
    const failure = await rejected(runAction(Actions.CheckRun, payload))
    expect(failure.message).toContain("more than 100 \"smithers\" check runs")
    expect(github.writes()).toEqual([])
  })

  it("refuses a SHA that is not one", async () => {
    github = await startGitHub()
    await expect(runAction(Actions.CheckRun, { ...payload, headSha: "../x" })).rejects.toBeDefined()
    expect(github.fixture.requests).toHaveLength(0)
  })
})

describe("LinkPullRequest", () => {
  it("adds a closing reference to an empty description", async () => {
    github = await startGitHub()
    const linked = await runAction(Actions.LinkPullRequest, { owner: "o", repo: "r", pullNumber: 9, issueNumber: 7 })
    expect(linked).toEqual({ pullNumber: 9, url: "https://github.test/o/r/pull/9", reference: "#7", updated: true })
    expect(github.pullBody).toBe("Closes #7")
  })

  it("appends a cross-repository reference below an existing description", async () => {
    github = await startGitHub()
    github.pullBody = "Fixes the parser."
    const linked = await runAction(Actions.LinkPullRequest, {
      owner: "o",
      repo: "r",
      pullNumber: 9,
      issueNumber: 7,
      issueOwner: "other",
      issueRepo: "tracker.js"
    })
    expect(linked.reference).toBe("other/tracker.js#7")
    expect(github.pullBody).toBe("Fixes the parser.\n\nCloses other/tracker.js#7")
  })

  it("leaves a description that already closes the issue", async () => {
    github = await startGitHub()
    github.pullBody = "resolved: O/R#7"
    const linked = await runAction(Actions.LinkPullRequest, {
      owner: "o",
      repo: "r",
      pullNumber: 9,
      issueNumber: 7,
      issueOwner: "o",
      issueRepo: "r"
    })
    expect(linked).toMatchObject({ reference: "#7", updated: false })
    expect(github.writes()).toEqual([])
  })

  it("repeats a lost edit and finds the reference it added", async () => {
    github = await startGitHub()
    github.lose = true
    const linked = await runAction(Actions.LinkPullRequest, { owner: "o", repo: "r", pullNumber: 9, issueNumber: 7 })
    expect(linked.updated).toBe(false)
    expect(github.pullBody).toBe("Closes #7")
    expect(github.writes()).toEqual(["PATCH /repos/o/r/pulls/9"])
  })

  it("refuses an issue repository that is not a name", async () => {
    github = await startGitHub()
    const failure = await rejected(
      runAction(Actions.LinkPullRequest, { owner: "o", repo: "r", pullNumber: 9, issueNumber: 7, issueRepo: ".." })
    )
    expect(failure).toBeDefined()
    expect(github.fixture.requests).toHaveLength(0)
  })
})

describe("closesIssue", () => {
  const issue = { owner: "o", repo: "r.js", issueNumber: 7 }
  it.each([
    ["Closes #7", true, true],
    ["fixes o/r.js#7", true, true],
    ["Fixed: #7.", true, true],
    ["closes #70", true, false],
    ["closes #7", false, false],
    ["closes o/rxjs#7", false, false],
    ["closes other/r.js#7", true, false],
    ["see #7", true, false],
    ["preclosed #7", true, false],
    ["RESOLVES o/r.js#7", false, true]
  ])("%j in the same repository %s -> %s", (body, same, expected) => {
    expect(Actions.closesIssue(body, issue, same)).toBe(expected)
  })
})
