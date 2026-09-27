import { NodeServices } from "@effect/platform-node"
import { FlowRuntime } from "@smthrs/flow"
import { Effect, FileSystem, Layer, Schema } from "effect"
import assert from "node:assert/strict"
import { test } from "node:test"
import { initialSetup, setupCandidate } from "../../packages/rpc/src/RepositorySetup.ts"
import * as Jj from "../../packages/smithers/flows/jj/src/Jj.ts"
import { NativeCoding } from "../coding/native.ts"
import { executionLayers } from "../repository/execution.ts"
import { ValidateReply } from "../repository/jobs.ts"
import { JobInput, JobResult } from "../repository/schema.ts"
import { makeHostJudge } from "./fixtures/scripted-judge.ts"

const json = (value: unknown): Schema.Json => JSON.parse(JSON.stringify(value))
const author = { id: 1, login: "reporter" }

const job = (source: "github" | "smithers-cloud") => {
  const setup = initialSetup("example/repo", "issues", "maintainer")
  const input = Schema.decodeUnknownSync(JobInput)({
    repo: setup.repo,
    job: setup.job,
    revision: setup.revision,
    digest: setupCandidate(setup),
    sourceRevision: "a".repeat(40),
    configuration: json(setup.draft),
    event: {
      source,
      type: "issues",
      action: "opened",
      deliveryKey: "delivery:42",
      issueNumber: 42,
      payload: { issue: { number: 42, title: "Greeting", body: "Which greeting?", user: author } }
    }
  })
  const previous = Schema.decodeUnknownSync(JobResult)({
    repo: input.repo,
    job: input.job,
    revision: input.revision,
    digest: input.digest,
    sourceRevision: input.sourceRevision,
    eventKey: input.event.deliveryKey,
    status: "needs-author",
    results: [],
    publicActions: []
  })
  return { input, previous }
}

const reply = (source: string, comment: Record<string, unknown>) =>
  json({
    source,
    type: "issue_comment",
    action: "created",
    deliveryKey: `reply:${String(comment.id)}`,
    issueNumber: 42,
    payload: { comment }
  })

/** Runs the ValidateReply implementation `executionLayers` registers. */
const validate = (source: "github" | "smithers-cloud", comment: Record<string, unknown>) => {
  const handlers = new Map<string, (payload: unknown) => { execute: Effect.Effect<unknown, unknown, never> }>()
  const runtime = {
    register: (declared: any, action: any) => Effect.sync(() => handlers.set(declared._tag, action)),
    execute: () => Effect.die("validation executes nothing")
  }
  return Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    yield* Layer.build(
      executionLayers(
        { evaluator: makeHostJudge().layer, repositoryPath: "/nonexistent", fs, environment: {} } as never
      ).pipe(
        Layer.provide([
          Layer.succeed(FlowRuntime.FlowRuntime, runtime as never),
          Layer.succeed(Jj.Jj, undefined as never),
          Layer.succeed(NativeCoding, undefined as never)
        ])
      )
    )
    const handler = handlers.get("repository/validate-author-reply")
    if (!handler) return yield* Effect.die("repository/validate-author-reply has no implementation")
    const { input, previous } = job(source)
    return yield* handler(
      Schema.decodeUnknownSync(ValidateReply.payloadSchema)({ input, reply: reply(source, comment), previous })
    ).execute.pipe(
      Effect.provideService(FlowRuntime.FlowRuntime, runtime as never),
      Effect.provideService(FlowRuntime.FlowInstance, { executionId: "job-root" } as never)
    )
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer), Effect.runPromise)
}

// The backend decides whether a comment is a maintainer's own text and stamps
// that decision on it; the reply check reads only the stamp.
for (const source of ["github", "smithers-cloud"] as const) {
  test(`a ${source} reply continues the job only with the backend's maintainer stamp`, async () => {
    const stamped = await validate(source, {
      id: 7,
      body: "Release 1.4.",
      user: { id: 9, login: "maintainer" },
      smithers_text_by_maintainer: true
    })
    assert.notEqual(stamped, null, "a maintainer's stamped reply continues")

    // GitHub names the author's standing, not who wrote the text, so the
    // association alone is not trust.
    assert.equal(
      await validate(source, {
        id: 8,
        body: "Release 1.4.",
        user: { id: 9, login: "maintainer" },
        author_association: "MEMBER"
      }),
      null
    )
    // A native run credential and chat sync write as the owner's user id, so
    // the author's identity is not proof either.
    assert.equal(await validate(source, { id: 9, body: "Release 1.4.", user: author }), null)
    assert.equal(
      await validate(source, { id: 10, body: "Release 1.4.", user: author, smithers_text_by_maintainer: false }),
      null
    )
  })
}
