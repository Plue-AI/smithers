import { NodeCrypto, NodeServices } from "@effect/platform-node"
import { FlowEngine } from "@smthrs/engine"
import { Action, Interpreter } from "@smthrs/flow"
import * as Evaluator from "@smthrs/model/Evaluator"
import { Effect, Exit, Layer, ManagedRuntime, Schema } from "effect"
import assert from "node:assert/strict"
import { once } from "node:events"
import { createServer } from "node:http"
import { test } from "node:test"
import Learning, {
  Binding,
  evidence,
  layer as learningLayer,
  learn,
  machineBinding,
  Output,
  type Snapshot
} from "../learning/flow.ts"

const text = "Run lint before review to catch unused imports."
const snapshot: Snapshot = {
  repository: "smithers/canary",
  todo: 7,
  run: "learning-7",
  state: "merged",
  change: "https://github.com/smithers/canary/pull/41",
  commit: "abc123",
  attempts: ["attempt-1", "attempt-2"],
  journal: [
    { seq: 1, eventType: "control.agent.model-settled", payload: { text } },
    {
      seq: 2,
      eventType: "control.agent.steering-drained",
      payload: { messages: [{ role: "user", text: "Use the existing retry helper because it already backs off." }] }
    }
  ],
  outcomes: [3, 4, 5, 6, 7].map((todo) => ({
    todo,
    failures: [3, 5, 7].includes(todo) ? [{ signature: "check:lint@review", text }] : []
  }))
}
const evaluator = Evaluator.layerScripted(() => ({ durable_0: { probability: 0 }, issue_0: { probability: 1 } }))

test("failure evidence counts TODOs once and bounds the history", () => {
  assert.deepEqual(evidence(snapshot.outcomes), [{
    signature: "check:lint@review",
    todos: [3, 5, 7],
    count: "3 of the last 5"
  }])
  assert.deepEqual(evidence([...snapshot.outcomes].reverse()), [{
    signature: "check:lint@review",
    todos: [3, 5, 7],
    count: "3 of the last 5"
  }])
  assert.deepEqual(
    evidence([{
      todo: 7,
      failures: [{ signature: "check:lint@review", text }, { signature: "check:lint@review", text }]
    }]),
    [{ signature: "check:lint@review", todos: [7], count: "1 of the last 1" }]
  )
  assert.deepEqual(
    evidence(
      Array.from(
        { length: 21 },
        (_, i) => ({ todo: i + 1, failures: i === 0 ? [{ signature: "check:lint@review", text }] : [] })
      )
    ),
    []
  )
})

test("learning returns cited decisions and evidence; identical inputs have the same signature", async () => {
  const output = await Effect.runPromise(learn(snapshot).pipe(Effect.provide(evaluator)))
  assert.deepEqual(Schema.decodeUnknownSync(Output)(output), {
    repository: "smithers/canary",
    todo: 7,
    run: "learning-7",
    pages: [{
      title: "T7 decisions",
      body:
        "Change: https://github.com/smithers/canary/pull/41\nCommit: https://github.com/smithers/canary/commit/abc123\nRun: attempt-1\nRun: attempt-2\n- Use the existing retry helper because it already backs off. (learning learning-7, evidence seq 2)"
    }],
    proposals: [{
      signature: "check:lint@review",
      title: text,
      evidence: ["3 of the last 5 failed check:lint@review"],
      todos: [3, 5, 7],
      prompt:
        "Change flows/todo/flow.ts to require lint as a fast required check for every planned change before review; start from the built-in composition when no override exists.",
      diff:
        "--- a/flows/todo/flow.ts\n+++ b/flows/todo/flow.ts\n@@ -34,1 +34,4 @@\n-      Node.andThen(Request.call(input)),\n+      Node.andThen(Request.call({\n+        ...input,\n+        prompt: `${input.prompt}\\nRequire lint as a fast required check for every planned change before review.`\n+      })),"
    }]
  })
  assert.deepEqual(await Effect.runPromise(learn(snapshot).pipe(Effect.provide(evaluator))), output)
})

test("no proposal without failure evidence or Jev acceptance; empty transcript writes no page", async () => {
  const withoutFailures = { ...snapshot, outcomes: [] }
  assert.deepEqual((await Effect.runPromise(learn(withoutFailures).pipe(Effect.provide(evaluator)))).proposals, [])
  const refused = Evaluator.layerScripted(() => ({ durable_0: { probability: 1 }, issue_0: { probability: 0 } }))
  assert.deepEqual((await Effect.runPromise(learn(snapshot).pipe(Effect.provide(refused)))).proposals, [])
  const empty = await Effect.runPromise(learn({ ...snapshot, journal: [] }).pipe(Effect.provide(evaluator)))
  assert.deepEqual(empty.pages, [])
  assert.deepEqual(empty.proposals, [])
})

test("unmerged, duplicated or oversized history and unavailable judgment fail without output", async () => {
  for (
    const invalid of [{ ...snapshot, state: "working" }, {
      ...snapshot,
      outcomes: [snapshot.outcomes[0]!, snapshot.outcomes[0]!]
    }, { ...snapshot, outcomes: Array.from({ length: 21 }, (_, i) => ({ todo: i + 1, failures: [] })) }]
  ) {
    assert.ok(Exit.isFailure(await Effect.runPromiseExit(learn(invalid as Snapshot).pipe(Effect.provide(evaluator)))))
  }
  const failing = Evaluator.layerScripted(() =>
    Effect.fail(new Evaluator.EvaluatorError({ code: "unreachable", message: "offline" }))
  )
  assert.ok(Exit.isFailure(await Effect.runPromiseExit(learn(snapshot).pipe(Effect.provide(failing)))))
})

test("typed learning output retains an optional proposed diff as data", () => {
  const output = Schema.decodeUnknownSync(Output)({
    repository: "smithers/canary",
    todo: 7,
    run: "learning-7",
    pages: [],
    proposals: [{
      signature: "check:lint@review",
      title: "Run lint",
      evidence: ["3 of the last 5 failed lint at review"],
      todos: [3, 5, 7],
      prompt: "Run lint before review",
      diff: "+$(touch /root/learning-canary)"
    }]
  })
  assert.equal(output.proposals[0]!.diff, "+$(touch /root/learning-canary)")
})

test("guest Binding reads only its runtime run, refuses mismatches and cancels unresolved reads", async () => {
  let status = 200, body = JSON.stringify(snapshot), calls = 0, hold = false
  const server = createServer((request, response) => {
    calls++
    assert.equal(request.url, "/api/gateways/learning-host/learning/learning-7/evidence")
    assert.equal(request.headers.authorization, "Bearer host-secret")
    if (hold) return
    response.writeHead(status, { "Content-Type": "application/json" })
    response.end(body)
  })
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  const address = server.address()
  assert.ok(address && typeof address !== "string")
  const options = { origin: `http://127.0.0.1:${address.port}`, host: "learning-host", credential: "host-secret" }
  const read = (configured: Parameters<typeof machineBinding>[0] = options, execution = "learning-7") =>
    Effect.gen(function*() {
      return yield* (yield* Binding).read(7, execution)
    }).pipe(Effect.provide(machineBinding(configured)))
  try {
    assert.deepEqual(await Effect.runPromise(read()), snapshot)
    let resolved = ""
    assert.deepEqual(
      await Effect.runPromise(read({
        ...options,
        resolveRun: (execution) =>
          Effect.sync(() => {
            resolved = execution
            return "learning-7"
          })
      }, "catalog-child")),
      snapshot
    )
    assert.equal(resolved, "catalog-child")
    const runtime = ManagedRuntime.make(
      Layer.mergeAll(
        Interpreter.layer(Learning),
        learningLayer.pipe(Layer.provide(Layer.merge(machineBinding(options), evaluator)))
      ).pipe(
        Layer.provideMerge(Action.layerImplementations),
        Layer.provideMerge(FlowEngine.layerMemory),
        Layer.provideMerge(NodeCrypto.layer),
        Layer.provideMerge(NodeServices.layer)
      )
    )
    try {
      const learned = await runtime.runPromise(Learning.execute({ todo: 7 }, { executionId: "learning-7" }))
      assert.equal(learned.pages[0]!.title, "T7 decisions")
      assert.equal(learned.proposals[0]!.signature, "check:lint@review")
      assert.ok(learned.pages[0]!.body.includes("because it already backs off"))
      const beforeReplay = calls
      assert.deepEqual(await runtime.runPromise(Learning.execute({ todo: 7 }, { executionId: "learning-7" })), learned)
      assert.equal(calls, beforeReplay)
    } finally {
      await runtime.dispose()
    }

    for (
      const invalid of [{ ...snapshot, todo: 8 }, { ...snapshot, run: "another-run" }, {
        ...snapshot,
        state: "working"
      }]
    ) {
      body = JSON.stringify(invalid)
      assert.ok(Exit.isFailure(await Effect.runPromiseExit(read())))
    }
    status = 403
    assert.ok(Exit.isFailure(await Effect.runPromiseExit(read())))
    status = 200
    body = "x".repeat(2 * 1024 * 1024 + 1)
    assert.ok(Exit.isFailure(await Effect.runPromiseExit(read())))
    const before = calls
    assert.ok(Exit.isFailure(await Effect.runPromiseExit(read({ ...options, credential: "" }))))
    assert.ok(Exit.isFailure(await Effect.runPromiseExit(read({ ...options, origin: "file:///tmp/learning" }))))
    assert.equal(calls, before)
    hold = true
    assert.ok(Exit.isFailure(await Effect.runPromiseExit(read().pipe(Effect.timeout("100 millis")))))
  } finally {
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  }
})

test("five merges open the recurring lint proposal only with T1, T3 and T5 evidence", async () => {
  const outcomes: Snapshot["outcomes"] = [
    { todo: 1, failures: [{ signature: "check:lint@review", text }] },
    { todo: 2, failures: [] },
    { todo: 3, failures: [{ signature: "check:lint@review", text }] },
    { todo: 4, failures: [] },
    { todo: 5, failures: [{ signature: "check:lint@review", text }] }
  ]
  for (let n = 1; n <= 4; n++) {
    const output = await Effect.runPromise(
      learn({ ...snapshot, todo: n, outcomes: outcomes.slice(0, n) }).pipe(Effect.provide(evaluator))
    )
    assert.deepEqual(output.proposals, [], `T${n} must not open the signature early`)
    assert.equal(output.pages.length, 1)
  }
  const output = await Effect.runPromise(learn({ ...snapshot, todo: 5, outcomes }).pipe(Effect.provide(evaluator)))
  assert.equal(output.proposals.length, 1)
  assert.deepEqual(output.proposals[0]!.evidence, ["3 of the last 5 failed check:lint@review"])
  assert.deepEqual(output.proposals[0]!.todos, [1, 3, 5])
  assert.equal(output.proposals[0]!.signature, "check:lint@review")
  assert.match(output.proposals[0]!.diff!, /\+        prompt:.*Require lint as a fast required check/)
  assert.deepEqual(
    (await Effect.runPromise(
      learn({ ...snapshot, outcomes: outcomes.slice(0, 4).concat({ todo: 5, failures: [] }) }).pipe(
        Effect.provide(evaluator)
      )
    )).proposals,
    []
  )
  // Repeated failures in one TODO do not manufacture three affected TODOs.
  const repeated = outcomes.map((row) => ({
    ...row,
    failures: row.todo === 1 ? Array(3).fill({ signature: "check:lint@review", text }) : []
  }))
  assert.deepEqual(
    (await Effect.runPromise(learn({ ...snapshot, outcomes: repeated }).pipe(Effect.provide(evaluator)))).proposals,
    []
  )
  const earlyThree = outcomes.slice(0, 3).map((row) => ({
    ...row,
    failures: [{ signature: "check:lint@review", text }]
  }))
  assert.deepEqual(
    (await Effect.runPromise(learn({ ...snapshot, outcomes: earlyThree }).pipe(Effect.provide(evaluator)))).proposals,
    []
  )
})

test("other judged failure signatures retain immediate proposals without a lint diff", async () => {
  const output = await Effect.runPromise(
    learn({ ...snapshot, outcomes: [{ todo: 7, failures: [{ signature: "check:typecheck@check", text }] }] }).pipe(
      Effect.provide(evaluator)
    )
  )
  assert.deepEqual(output.proposals, [{
    signature: "check:typecheck@check",
    title: text,
    evidence: ["1 of the last 1 failed check:typecheck@check"],
    todos: [7],
    prompt: text
  }])
})
