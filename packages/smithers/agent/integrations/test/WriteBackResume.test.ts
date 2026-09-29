/**
 * Crash-then-resume for every durable GitHub and Linear write-back action.
 *
 * Each case runs one action on the production SQLite engine. The fake
 * provider applies the write and never answers it, and the test disposes the
 * runtime while the step is in flight: the process died after the side effect
 * and before the journal learned of it. A fresh runtime over the same database
 * then resumes the run. The engine re-dispatches the step because it carries an
 * idempotency key, and the provider must end up with the side effect exactly
 * once.
 */
import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem"
import { Action, Flow, FlowRuntime, Interpreter } from "@smthrs/flow"
import { EngineStore, Kernel } from "@smthrs/flows"
import * as NodeRuntime from "@smthrs/flows/NodeRuntime"
import { Effect, Layer, ManagedRuntime, type Schema } from "effect"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, expect, it } from "vitest"
import * as GitHubActions from "../src/github/Actions.ts"
import * as GitHubClient from "../src/github/GitHubClient.ts"
import * as LinearActions from "../src/linear/Actions.ts"
import * as LinearClient from "../src/linear/LinearClient.ts"
import { type FakeGitHub, startGitHub } from "./GitHubFake.ts"
import { type FakeLinear, startLinear } from "./LinearFake.ts"

const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

type PureSchema = { readonly DecodingServices: never; readonly EncodingServices: never }

/**
 * Starts the run, crashes it once `held` resolves, and resumes it on a fresh
 * runtime over the same database.
 */
const crashThenResume = async <
  Tag extends string,
  Payload extends Flow.AnyStructSchema & PureSchema,
  Success extends Schema.Top & PureSchema,
  Error extends Schema.Top & PureSchema,
  Client
>(
  declaration: Action.Declared<Tag, Payload, Success, Error>,
  implementation: Layer.Layer<Action.Requirement<Tag>, never, Client | FlowRuntime.FlowRuntime>,
  client: Layer.Layer<Client>,
  payload: Payload["Type"],
  held: Promise<void>
): Promise<Success["Type"]> => {
  const root = mkdtempSync(join(tmpdir(), "write-back-resume-"))
  cleanups.push(async () => rmSync(root, { recursive: true, force: true }))
  const flow = Flow.make(`${declaration.name}/resume-flow`, {
    payload: declaration.payloadSchema,
    success: declaration.successSchema,
    error: declaration.errorSchema,
    body: (input) => declaration.call(input as never)
  })
  const registration = Interpreter.layer(flow).pipe(
    Layer.provideMerge(implementation),
    Layer.provideMerge(Action.layerImplementations)
  )
  // External irreversible actions snapshot no checkout; the SQL journal and
  // attempt storage are the production composition.
  const host = Layer.mergeAll(
    client,
    NodeCrypto.layer,
    NodeFileSystem.layer,
    Layer.succeed(
      Kernel.Jj.Jj,
      Kernel.Jj.make({
        snapshot: () => Effect.die("unexpected snapshot"),
        restore: () => Effect.void,
        diff: () => Effect.succeed(""),
        workspaceAdd: () => Effect.void,
        workspaceForget: () => Effect.void,
        status: () => Effect.succeed("")
      })
    )
  )
  const boot = () =>
    ManagedRuntime.make(
      NodeRuntime.layer(
        {
          filename: join(root, "engine.sqlite"),
          workspaceRoot: root,
          owner: { hostId: "write-back-resume" },
          // Incarnations are sequential and the crashed one is gone.
          isAlive: () => Effect.succeed(false)
        },
        EngineStore.StepBoundary.layerTest(),
        Layer.effect(
          EngineStore.WorkspaceSandbox.WorkspaceSandbox,
          EngineStore.WorkspaceSandbox.makeMemory().pipe(Effect.map((sandbox) => sandbox.service))
        ),
        registration
      ).pipe(Layer.provide(host))
    )
  const execute = FlowRuntime.FlowRuntime.pipe(
    Effect.flatMap((engine) => engine.execute(flow, { executionId: "resumed-run", payload }))
  )
  const crashed = boot()
  const first = crashed.runPromise(execute).then(() => "settled", () => "interrupted")
  await held
  await crashed.dispose()
  expect(await first).toBe("interrupted")
  const resumed = boot()
  try {
    return await resumed.runPromise(execute)
  } finally {
    await resumed.dispose()
  }
}

const gitHub = async (): Promise<[FakeGitHub, Layer.Layer<GitHubClient.GitHubClient>]> => {
  const github = await startGitHub()
  cleanups.push(() => github.fixture.close())
  github.hold = true
  return [github, Layer.orDie(GitHubClient.layer({ token: "t", apiBaseUrl: github.fixture.origin }, {}))]
}

const linearFake = async (): Promise<[FakeLinear, Layer.Layer<LinearClient.LinearClient>]> => {
  const linear = await startLinear()
  cleanups.push(() => linear.fixture.close())
  linear.hold = true
  return [linear, Layer.orDie(LinearClient.layer({ apiKey: "lin_api_fixture", apiBaseUrl: linear.fixture.origin }, {}))]
}

it("add-labels resumes to one label", async () => {
  const [github, client] = await gitHub()
  const result = await crashThenResume(
    GitHubActions.AddLabels,
    GitHubActions.layerAddLabels,
    client,
    { owner: "o", repo: "r", issueNumber: 7, labels: ["triage"] },
    github.held
  )
  expect(result).toEqual({ added: [], labels: ["triage"] })
  expect(github.labels).toEqual(["triage"])
  expect(github.writes()).toEqual(["POST /repos/o/r/issues/7/labels"])
})

it("upsert-comment resumes to one sticky comment", async () => {
  const [github, client] = await gitHub()
  const result = await crashThenResume(
    GitHubActions.UpsertComment,
    GitHubActions.layerUpsertComment,
    client,
    { owner: "o", repo: "r", issueNumber: 7, key: "run-1", body: "Working" },
    github.held
  )
  expect(result.outcome).toBe("unchanged")
  expect(github.comments.map((comment) => comment.body)).toEqual(["<!-- smithers:key=run-1 -->\nWorking"])
  expect(github.writes()).toEqual(["POST /repos/o/r/issues/7/comments"])
})

it("check-run resumes to one check run", async () => {
  const [github, client] = await gitHub()
  const result = await crashThenResume(
    GitHubActions.CheckRun,
    GitHubActions.layerCheckRun,
    client,
    { owner: "o", repo: "r", headSha: "b".repeat(40), name: "smithers", key: "run-1", status: "in_progress" },
    github.held
  )
  expect(result).toMatchObject({ created: false, status: "in_progress" })
  expect(github.checkRuns).toHaveLength(1)
  expect(github.writes().filter((write) => write.startsWith("POST"))).toEqual(["POST /repos/o/r/check-runs"])
})

it("link-pr resumes to one closing reference", async () => {
  const [github, client] = await gitHub()
  github.pullBody = "Parser fix."
  const result = await crashThenResume(
    GitHubActions.LinkPullRequest,
    GitHubActions.layerLinkPullRequest,
    client,
    { owner: "o", repo: "r", pullNumber: 9, issueNumber: 7 },
    github.held
  )
  expect(result.updated).toBe(false)
  expect(github.pullBody).toBe("Parser fix.\n\nCloses #7")
  expect(github.writes()).toEqual(["PATCH /repos/o/r/pulls/9"])
})

it("linear update-issue resumes to the same issue", async () => {
  const [linear, client] = await linearFake()
  const result = await crashThenResume(
    LinearActions.UpdateIssue,
    LinearActions.layerUpdateIssue,
    client,
    { issue: "ENG-1", title: "Renamed" },
    linear.held
  )
  expect(result.title).toBe("Renamed")
  expect(linear.issue.title).toBe("Renamed")
})

it("linear comment-on-issue resumes to one comment", async () => {
  const [linear, client] = await linearFake()
  const result = await crashThenResume(
    LinearActions.CommentOnIssue,
    LinearActions.layerCommentOnIssue,
    client,
    { issue: "ENG-1", body: "Fixed" },
    linear.held
  )
  expect(result.created).toBe(false)
  expect(linear.issue.comments).toEqual([{ id: result.id, body: "Fixed" }])
  expect(linear.mutations()).toEqual(["CommentCreate"])
})
