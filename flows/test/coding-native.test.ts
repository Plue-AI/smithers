import { NodeCrypto, NodeServices } from "@effect/platform-node"
import { FlowEngine } from "@smthrs/engine"
import { Action, Flow, Interpreter } from "@smthrs/flow"
import { Effect, Layer, ManagedRuntime, Redacted, Schema } from "effect"
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test, type TestContext } from "node:test"
import {
  NativeCoding,
  NativeCodingError,
  nativeLayer,
  NativeTransport,
  type Operation,
  requestIdFor,
  StackCandidate
} from "../coding/native.ts"
import { CodingError } from "../coding/schema.ts"
import { Candidate, stackBaseLayer } from "../coding/stack.ts"

test("native invocation UUIDs remain stable across retry and differ between durable actions", () => {
  const first = requestIdFor("execution-1", "create/database")
  assert.match(first, /^[a-f0-9]{8}-[a-f0-9]{4}-8[a-f0-9]{3}-a[a-f0-9]{3}-[a-f0-9]{12}$/)
  assert.equal(requestIdFor("execution-1", "create/database"), first)
  assert.notEqual(requestIdFor("execution-1", "create/server"), first)
  assert.notEqual(requestIdFor("execution-2", "create/database"), first)
})

const helper = process.env.SMITHERS_WORKSPACE_JJ_EXPORT_BINARY
test("native file patches cannot bypass the unavailable atomic provider", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "coding-native-file-gate-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const target = join(root, "a.txt")
  await writeFile(target, "original\n")
  const sentinel = join(root, "helper")
  // A real subprocess would leave this marker if the policy dispatched it.
  await writeFile(sentinel, "#!/bin/sh\nprintf ran > dispatched\nexit 1\n", { mode: 0o700 })
  const layer = nativeLayer({ repositoryPath: root, helperPath: sentinel }).pipe(Layer.provide(NodeServices.layer))
  const operationId = "a".repeat(128)
  const operation: Operation = {
    operation: "apply_files",
    requestId: requestIdFor("unqualified", "patch"),
    expectedOperationId: operationId,
    target: {
      changeId: "z".repeat(32),
      commitId: "b".repeat(40),
      treeId: "c".repeat(40),
      operationId,
      parentCommitIds: ["d".repeat(40)]
    },
    files: [{ path: "a.txt", beforeDigest: "e".repeat(64), content: "replacement\n" }]
  }
  const failure = await Effect.runPromise(
    Effect.flatMap(NativeCoding, (native) => Effect.flip(native.apply(operation))).pipe(Effect.provide(layer))
  )
  assert.equal(await readFile(target, "utf8"), "original\n")
  assert.deepEqual((await readdir(root)).sort(), ["a.txt", "helper"])
  assert.equal(failure.code, "host_unavailable")
  assert.match(failure.message, /atomic file mutation provider unavailable/i)
})

test("packaged helper accepts a native change and replays its JJ receipt", {
  skip: helper === undefined ? "Build the workspace helper and set SMITHERS_WORKSPACE_JJ_EXPORT_BINARY" : false,
  timeout: 120_000
}, async (t) => {
  assert.ok(helper)
  const temporary = await mkdtemp(join(tmpdir(), "coding-native-helper-"))
  t.after(() => rm(temporary, { recursive: true, force: true }))
  const repo = join(temporary, "repo")
  execFileSync("jj", ["git", "init", repo], { stdio: "pipe" })
  const layer = nativeLayer({ repositoryPath: repo, helperPath: helper, sourcePublication: "local-only" }).pipe(
    Layer.provide(NodeServices.layer)
  )
  const run = <A, E>(f: (native: NativeCoding["Service"]) => Effect.Effect<A, E>) =>
    Effect.runPromise(Effect.flatMap(NativeCoding, f).pipe(Effect.provide(layer)))
  const before = await run((native) => native.read())
  assert.equal(before.head.kind, "resolved")
  if (before.head.kind !== "resolved") return
  const request: Operation = {
    operation: "create",
    requestId: requestIdFor("acceptance", "first"),
    expectedOperationId: before.operationId,
    target: before.head,
    description: "first change"
  }
  const accepted = await run((native) => native.apply(request))
  assert.equal(accepted.status, "accepted")
  if (accepted.status !== "accepted") return
  assert.equal(accepted.parentOperationId, before.operationId)
  assert.equal(accepted.revision.description?.trim(), "first change")
  const replay = await run((native) => native.apply(request))
  assert.equal(replay.status, "accepted")
  if (replay.status === "accepted") {
    assert.equal(replay.replayed, true)
    assert.equal(replay.operationId, accepted.operationId)
  }
  const duplicate = await run((native) => Effect.result(native.apply({ ...request, description: "changed" })))
  assert.equal(duplicate._tag, "Failure")
  if (duplicate._tag === "Failure") assert.equal(duplicate.failure.code, "request_conflict")
})

// These are transport conformance fixtures, not microVM acceptance receipts.
const candidate = { generation: 3, base: "a".repeat(40), head: "b".repeat(40) }
const proposal = { generation: 3, head: "c".repeat(40) }
const requestId = requestIdFor("stack-native", "capture")

const fixture = async (t: TestContext, receipt: unknown) => {
  const root = await mkdtemp(join(tmpdir(), "coding-stack-native-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const helper = join(root, "helper")
  await writeFile(helper, `#!/bin/sh\ncat > request.json\nprintf '%s' '${JSON.stringify(receipt)}'\n`, { mode: 0o700 })
  const layer = (transport: boolean, local = false) =>
    nativeLayer({
      repositoryPath: root,
      helperPath: helper,
      sourcePublication: local ? "local-only" : "cloud"
    }).pipe(Layer.provide(
      transport
        ? Layer.mergeAll(NodeServices.layer, NativeTransport.layerFrom(NodeServices.layer))
        : NodeServices.layer
    ))
  const run = <A, E>(
    transport: boolean,
    call: (native: NativeCoding["Service"]) => Effect.Effect<A, E>,
    local = false
  ) => Effect.runPromise(Effect.flatMap(NativeCoding, call).pipe(Effect.provide(layer(transport, local))))
  return { root, run }
}

test("reserved native providers refuse absent installed transport and draft publication before any subprocess", async (t) => {
  const { root, run } = await fixture(t, candidate)
  for (const [transport, local] of [[false, false], [true, true]] as const) {
    for (
      const operation of [
        (native: NativeCoding["Service"]) => native.stackCandidate!(requestId),
        (native: NativeCoding["Service"]) => native.stackPropose!(requestId, 3)
      ]
    ) {
      const error = await run(transport, (native) => Effect.flip(operation(native)), local)
      assert.equal(error.code, "source_refused")
    }
  }
  assert.deepEqual(await readdir(root), ["helper"])
})

test("reserved native providers validate invocation identity and generation before dispatch", async (t) => {
  const { root, run } = await fixture(t, proposal)
  for (const invalid of ["", "../credential", "not-an-invocation"]) {
    const error = await run(true, (native) => Effect.flip(native.stackCandidate!(invalid)))
    assert.equal(error.code, "invalid_request")
  }
  for (const invalid of [0, -1, 1.5, NaN, Infinity]) {
    const error = await run(true, (native) => Effect.flip(native.stackPropose!(requestId, invalid)))
    assert.equal(error.code, "invalid_request")
  }
  assert.deepEqual(await readdir(root), ["helper"])
})

test("candidate provider sends only invocation identity and installed repository binding", async (t) => {
  const { root, run } = await fixture(t, candidate)
  assert.deepEqual(await run(true, (native) => native.stackCandidate!(requestId)), candidate)
  assert.deepEqual(JSON.parse(await readFile(join(root, "request.json"), "utf8")), {
    operation: "stack.candidate",
    requestId,
    repositoryPath: root
  })
})

test("proposal provider sends its exact generation and rejects another generation", async (t) => {
  const { root, run } = await fixture(t, proposal)
  assert.deepEqual(await run(true, (native) => native.stackPropose!(requestId, 3)), proposal)
  assert.deepEqual(JSON.parse(await readFile(join(root, "request.json"), "utf8")), {
    operation: "stack.propose",
    requestId,
    generation: 3,
    repositoryPath: root
  })
  const error = await run(true, (native) => Effect.flip(native.stackPropose!(requestId, 4)))
  assert.equal(error.code, "invalid_receipt")
})

for (
  const receipt of [
    { generation: 0, base: candidate.base, head: candidate.head },
    { ...candidate, head: "invalid" },
    null
  ]
) {
  test(`candidate provider refuses malformed native receipts: ${JSON.stringify(receipt)}`, async (t) => {
    const { run } = await fixture(t, receipt)
    const error = await run(true, (native) => Effect.flip(native.stackCandidate!(requestId)))
    assert.equal(error.code, "invalid_receipt")
  })
}

test("reserved native providers preserve typed native refusals", async (t) => {
  const { run } = await fixture(t, { error: { code: "source_refused", message: "Current run changed" } })
  const error = await run(true, (native) => Effect.flip(native.stackCandidate!(requestId)))
  assert.equal(error.code, "source_refused")
  assert.equal(error.message, "Current run changed")
})

const packagedHelper = process.env.SMITHERS_STACK_TEST_HELPER ?? helper
test("unprovisioned packaged reserved dispatch refuses through the Action boundary without touching the workspace", {
  skip: packagedHelper === undefined ? "Build smithers-jj-export and set SMITHERS_STACK_TEST_HELPER" : false
}, async (t) => {
  assert.ok(packagedHelper)
  const root = await mkdtemp(join(tmpdir(), "coding-stack-packaged-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const Capture = Flow.make("test/native-stack-capture", {
    payload: {},
    success: StackCandidate,
    error: Schema.Union([CodingError, NativeCodingError]),
    body: () => Candidate.call({})
  })
  const native = nativeLayer({ repositoryPath: root, helperPath: packagedHelper }).pipe(
    Layer.provide(Layer.mergeAll(NodeServices.layer, NativeTransport.layerFrom(NodeServices.layer)))
  )
  const runtime = ManagedRuntime.make(
    Layer.mergeAll(Interpreter.layer(Capture), stackBaseLayer.pipe(Layer.provide(native))).pipe(
      Layer.provideMerge(Action.layerImplementations),
      Layer.provideMerge(FlowEngine.layerMemory),
      Layer.provideMerge(NodeCrypto.layer)
    )
  )
  t.after(() => runtime.dispose())
  const error = await runtime.runPromise(
    Effect.flip(Capture.execute({}, { executionId: "unprovisioned-reserved-dispatch" }))
  )
  assert.ok(error instanceof NativeCodingError)
  assert.equal(error.code, "invalid_request")
  assert.equal(error.message, "Invalid provisioned source publication configuration or native identity")
  assert.deepEqual(await readdir(root), [])
})


test("private native credential reaches only publication and reserved transports", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "coding-native-private-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const helper = join(root, "helper")
  await writeFile(helper, `#!/bin/sh\ncat > request.json\nprintf '%s' "$SMITHERS_NATIVE_REPOSITORY_TOKEN" > credential.txt\nprintf '%s' '${JSON.stringify(candidate)}'\n`, { mode: 0o700 })
  const layer = nativeLayer({ repositoryPath: root, helperPath: helper, sourcePublication: "cloud", nativeRepositoryToken: Redacted.make("fixture-private-token") })
    .pipe(Layer.provide(Layer.mergeAll(NodeServices.layer, NativeTransport.layerFrom(NodeServices.layer))))
  const run = <A, E>(call: (native: NativeCoding["Service"]) => Effect.Effect<A, E>) =>
    Effect.runPromise(Effect.flatMap(NativeCoding, call).pipe(Effect.provide(layer)))
  await run((native) => native.stackCandidate!(requestId))
  assert.equal(await readFile(join(root, "credential.txt"), "utf8"), "fixture-private-token")
  assert.equal((await readFile(join(root, "request.json"), "utf8")).includes("fixture-private-token"), false)
  await run((native) => Effect.result(native.read()))
  assert.equal(await readFile(join(root, "credential.txt"), "utf8"), "")
})
