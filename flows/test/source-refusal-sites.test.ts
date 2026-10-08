import { NodeServices } from "@effect/platform-node"
import { Action } from "@smthrs/flow"
import { Effect, FileSystem, Layer } from "effect"
import assert from "node:assert/strict"
import { test } from "node:test"
import { NativeCoding } from "../coding/native.ts"
import { captureStackCandidate, prepareStackBase, proposeStackCandidate } from "../coding/stack.ts"
import { admitVerifySource } from "../coding/verify-schema.ts"
import { hasSourceCommits, sourceRequest } from "../repository/retention.ts"
import type { Event } from "../repository/schema.ts"

const workspaceId = "11111111-1111-4111-8111-111111111111"
const commitId = "a".repeat(40)
const base = { commitId, ref: `refs/smithers/workspaces/${workspaceId}/sources/${commitId}` }
const head = {
  kind: "resolved" as const,
  commitId,
  changeId: "k".repeat(32),
  treeId: "b".repeat(40),
  operationId: "c".repeat(128),
  parentCommitIds: []
}
const unavailable = () => Effect.die("refusal must precede native execution")
const native = {
  sourcePublication: "cloud" as const,
  read: unavailable,
  apply: unavailable,
  publishOriginalSource: unavailable
}

test("stack and verification refuse missing and unresolved imports with distinct sites", async (t) => {
  const logs: unknown[][] = []
  t.mock.method(console, "warn", (...args: unknown[]) => {
    logs.push(args)
  })
  for (const resolved of [false, true]) {
    const provider = Layer.succeed(NativeCoding, {
      ...native,
      ...(resolved ?
        {
          importSource: (request) =>
            Effect.succeed({
              status: "imported" as const,
              requestId: request.requestId,
              workspaceId,
              repositoryId: 1,
              operationId: head.operationId,
              head,
              revisions: []
            })
        } :
        {})
    })
    const cases: ReadonlyArray<
      readonly [Effect.Effect<unknown, { code: string; message: string }, NativeCoding>, string]
    > = [
      [prepareStackBase(base, "run"), resolved ? "stack_import_unresolved" : "stack_import_unavailable"],
      [admitVerifySource(base, [], "run"), resolved ? "verify_import_unresolved" : "verify_import_unavailable"]
    ]
    for (const [effect, reason] of cases) {
      const result = await Effect.runPromise(Effect.result(effect).pipe(Effect.provide(provider)))
      assert.equal(result._tag, "Failure")
      if (result._tag === "Failure") {
        assert.equal(result.failure.code, "source_refused")
        assert.ok(result.failure.message.includes(`source_refused: ${reason}`))
      }
      assert.equal(logs.at(-1)?.[0], `source_refused: ${reason}`)
    }
  }
})

test("candidate and proposal distinguish missing invocation from missing authority", async (t) => {
  const logs: unknown[][] = []
  t.mock.method(console, "warn", (...args: unknown[]) => {
    logs.push(args)
  })
  for (const bound of [false, true]) {
    for (
      const [effect, operation] of [
        [captureStackCandidate("run"), "candidate"],
        [proposeStackCandidate("run", 1), "propose"]
      ] as const
    ) {
      const reason = `stack_${operation}_${bound ? "authority" : "invocation"}_missing`
      const result = await Effect.runPromise(
        Effect.result(effect).pipe(
          Effect.provide(Layer.succeed(NativeCoding, native)),
          Effect.provideService(Action.CurrentInvocationKey, bound ? "node-one" : undefined)
        )
      )
      assert.equal(result._tag, "Failure")
      if (result._tag === "Failure") {
        assert.equal(result.failure.code, "source_refused")
        assert.ok(result.failure.message.includes(reason))
      }
      assert.equal(logs.at(-1)?.[0], `source_refused: ${reason}`)
    }
  }
})

test("event decode and immutable lookup identify their own refusals before any process", async (t) => {
  const logs: unknown[][] = []
  t.mock.method(console, "warn", (...args: unknown[]) => {
    logs.push(args)
  })
  const event: typeof Event.Type = {
    source: "github",
    type: "pull_request",
    action: "opened",
    deliveryKey: "github:delivery",
    issueNumber: 1,
    payload: {}
  }
  const malformed = await Effect.runPromise(Effect.result(sourceRequest(event, { pull_request: { number: 1 } })))
  assert.equal(malformed._tag, "Failure")
  if (malformed._tag === "Failure") assert.equal(malformed.failure.message, "source_refused: event_identity_invalid")
  assert.equal(logs.at(-1)?.[0], "source_refused: event_identity_invalid")
  const unreadable = Object.defineProperty({ ...event, type: "push" }, "payload", {
    get() {
      throw new Error("private-fixture-content")
    }
  })
  const unread = await Effect.runPromise(Effect.result(sourceRequest(unreadable, {})))
  assert.equal(unread._tag, "Failure")
  if (unread._tag === "Failure") assert.equal(unread.failure.message, "source_refused: event_invalid")
  assert.equal(logs.at(-1)?.[0], "source_refused: event_invalid")
  assert.equal(JSON.stringify(logs).includes("private-fixture-content"), false)
  const options = { repositoryPath: "/unused", fs: {} as FileSystem.FileSystem }
  for (
    const [commits, operation] of [[[], head.operationId], [[commitId], "short-operation"], [[
      commitId,
      commitId,
      commitId
    ], head.operationId]] as const
  ) {
    const result = await Effect.runPromise(
      Effect.result(hasSourceCommits(options, commits, operation)).pipe(Effect.provide(NodeServices.layer))
    )
    assert.equal(result._tag, "Failure")
    if (result._tag === "Failure") assert.equal(result.failure.message, "source_refused: lookup_identity_invalid")
    assert.equal(logs.at(-1)?.[0], "source_refused: lookup_identity_invalid")
  }
})
