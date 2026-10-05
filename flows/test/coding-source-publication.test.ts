import { NodeServices } from "@effect/platform-node"
import { Effect, Layer, Sink, Stream } from "effect"
import { ChildProcessSpawner } from "effect/unstable/process"
import assert from "node:assert/strict"
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import * as Jj from "../../packages/smithers/flows/jj/src/Jj.ts"
import {
  NativeCoding,
  NativeCodingError,
  nativeLayer,
  NativeTransport,
  requestIdFor,
  type SourcePublication
} from "../coding/native.ts"
import type { Plan } from "../coding/schema.ts"
import { admitSource } from "../coding/source-admission.ts"

const revision = {
  kind: "resolved" as const,
  changeId: "k".repeat(32),
  commitId: "a".repeat(40),
  treeId: "b".repeat(40),
  operationId: "c".repeat(128),
  parentCommitIds: ["0".repeat(40)]
}
const requestId = requestIdFor("request-execution", "publish-original")
const workspaceId = "0f8fad5b-d9cb-469f-a165-70867728950e"
const receipt: SourcePublication = {
  status: "retained",
  requestId,
  workspaceId,
  repositoryId: 200,
  ref: `refs/smithers/workspaces/${workspaceId}/sources/${revision.commitId}`,
  source: {
    changeId: revision.changeId,
    commitId: revision.commitId,
    treeId: revision.treeId,
    parentCommitIds: revision.parentCommitIds
  }
}
const plan: Plan = {
  prompt: "Add a feature",
  memoryRevision: "wiki@source",
  base: revision,
  observedHead: revision,
  changes: [{
    id: "feature",
    title: "Feature",
    intent: "Add a feature",
    implementation: "coding/atoms",
    implementationDigest: "sha256:atoms",
    atoms: [{
      changeId: null,
      message: "✨ feat: feature",
      intent: "Add a feature",
      reads: [],
      writes: ["feature.ts"]
    }],
    checks: ["fast", "slow"].map((tier) => ({
      id: tier,
      target: tier,
      flow: tier,
      flowDigest: `sha256:${tier}`,
      tier: tier as "fast" | "slow",
      required: true
    }))
  }]
}

test("cloud admission retains before any snapshot, then refuses source movement; local capability never claims an ACK", async () => {
  for (const mode of ["cloud", "unavailable", "moved", "local-only"] as const) {
    const calls: string[] = []
    let snapshots = 0
    const native = Layer.succeed(NativeCoding, {
      sourcePublication: mode === "local-only" ? "local-only" : "cloud",
      read: () =>
        Effect.sync(() => {
          calls.push("read")
          const head = mode === "moved" && snapshots > 0 ? { ...revision, commitId: "d".repeat(40) } : revision
          return { status: "read" as const, operationId: head.operationId, head, revisions: [head] }
        }),
      apply: () => Effect.die("admission must not implement a change"),
      publishOriginalSource: (request) =>
        Effect.gen(function*() {
          calls.push("publish")
          assert.equal(snapshots, 0)
          assert.deepEqual(request, { requestId, source: revision })
          if (mode === "unavailable") {
            return yield* new NativeCodingError({ code: "source_publication_unavailable", message: "No cloud ACK" })
          }
          return receipt
        })
    })
    const runtime = Layer.merge(
      native,
      Jj.layerNoop({
        snapshot: () =>
          Effect.sync(() => {
            calls.push("snapshot")
            snapshots++
            return { commitId: revision.commitId, changeId: revision.changeId }
          })
      })
    )
    const result = await Effect.runPromise(Effect.result(admitSource(plan, requestId)).pipe(Effect.provide(runtime)))
    if (mode === "cloud" || mode === "local-only") {
      assert.equal(result._tag, "Success")
      assert.deepEqual(calls, mode === "cloud" ? ["read", "publish", "snapshot", "read"] : ["read", "snapshot", "read"])
    } else {
      assert.equal(result._tag, "Failure")
      if (result._tag === "Failure") {
        assert.equal(result.failure.code, mode === "unavailable" ? "unavailable" : "stale_revision")
      }
      if (mode === "unavailable") assert.deepEqual(calls, ["read", "publish"])
    }
  }
})

test("Effect native publication validates exact receipts and sends only source identity to the provisioned adapter", async (t) => {
  const temporary = await mkdtemp(join(tmpdir(), "coding-publication-adapter-"))
  t.after(() => rm(temporary, { recursive: true, force: true }))
  const adapter = join(temporary, "adapter.mjs"), recorded = join(temporary, "request.json")
  const platform = process.versions.bun ? (await import("@effect/platform-bun/BunServices")).layer : NodeServices.layer
  for (const mode of ["accepted", "missing", "wrong-tree", "wrong-ref", "wrong-request", "local-only"] as const) {
    const output = mode === "missing" ? { status: "retained" } : {
      ...receipt,
      ...(mode === "wrong-ref" ? { ref: "refs/heads/main" } : {}),
      ...(mode === "wrong-request" ? { requestId: requestIdFor("other", "publish") } : {}),
      source: { ...receipt.source, ...(mode === "wrong-tree" ? { treeId: "d".repeat(40) } : {}) }
    }
    await writeFile(
      adapter,
      `#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
const request = JSON.parse(readFileSync(0, "utf8"));
writeFileSync(${JSON.stringify(recorded)}, JSON.stringify(request));
process.stdout.write(${JSON.stringify(JSON.stringify(output))});
`
    )
    await chmod(adapter, 0o755)
    const native = nativeLayer({
      repositoryPath: temporary,
      helperPath: adapter,
      sourcePublication: mode === "local-only" ? "local-only" : "cloud"
    }).pipe(Layer.provide(platform))
    const result = await Effect.runPromise(
      Effect.flatMap(
        NativeCoding,
        (service) => Effect.result(service.publishOriginalSource({ requestId, source: revision }))
      ).pipe(Effect.provide(native))
    )
    if (mode === "accepted") {
      assert.equal(result._tag, "Success")
      if (result._tag === "Success") assert.deepEqual(result.success, receipt)
      assert.deepEqual(JSON.parse(await readFile(recorded, "utf8")), {
        operation: "publish_source",
        requestId,
        source: revision,
        repositoryPath: temporary
      })
    } else {
      assert.equal(result._tag, "Failure")
      if (result._tag === "Failure") {
        assert.equal(
          result.failure.code,
          mode === "local-only" ? "source_publication_unavailable" : "source_publication_invalid_ack"
        )
      }
    }
  }
})

/** A spawner that records each helper operation it starts and answers with the helper's busy envelope. */
const recordingSpawner = (name: string, calls: Array<string>) =>
  ChildProcessSpawner.make((command) =>
    Effect.gen(function*() {
      if (command._tag !== "StandardCommand" || !Stream.isStream(command.options.stdin)) {
        return yield* Effect.die("the native helper is one command with its request on stdin")
      }
      const stdin = command.options.stdin as Stream.Stream<Uint8Array>
      const request = JSON.parse(yield* Stream.mkString(Stream.decodeText(stdin))) as { readonly operation: string }
      calls.push(`${name}:${request.operation}`)
      const envelope = JSON.stringify({ error: { code: "workspace_busy", message: `${name} spawner answered` } })
      return ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(1),
        exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(1)),
        isRunning: Effect.succeed(false),
        kill: () => Effect.void,
        stdin: Sink.drain,
        stdout: Stream.make(new TextEncoder().encode(envelope)),
        stderr: Stream.empty,
        all: Stream.empty,
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
        unref: Effect.succeed(Effect.void)
      })
    })
  )

test("read, source creation, import and publication run on the host's NativeTransport spawner; edits stay guarded", async () => {
  const imported = "e".repeat(40)
  const operations = (native: NativeCoding["Service"]): ReadonlyArray<Effect.Effect<unknown, NativeCodingError>> => [
    native.read(),
    native.apply({
      operation: "create",
      requestId: requestIdFor("transport", "create"),
      expectedOperationId: revision.operationId,
      target: revision,
      description: "change"
    }),
    native.apply({
      operation: "apply_files",
      requestId: requestIdFor("transport", "apply"),
      expectedOperationId: revision.operationId,
      target: revision,
      files: [{ path: "file.ts", beforeDigest: null, content: "export {}\n" }]
    }),
    native.createSource!({
      requestId: requestIdFor("transport", "create-source"),
      expectedOperationId: revision.operationId,
      base: revision,
      description: "source",
      files: [{ path: "file.ts", beforeDigest: null, content: "export {}\n" }]
    }),
    native.importSource!({
      requestId: requestIdFor("transport", "import"),
      commits: [{ commitId: imported, ref: `refs/smithers/workspaces/${workspaceId}/sources/${imported}` }]
    }),
    native.publishOriginalSource({ requestId, source: revision })
  ]
  const run = async (transport: boolean) => {
    const calls: Array<string> = []
    const spawner = (name: string) =>
      Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, recordingSpawner(name, calls))
    const native = nativeLayer({ repositoryPath: "/workspace", helperPath: "/helper", sourcePublication: "cloud" })
    // The host's wiring: the raw platform spawner becomes NativeTransport; the run's guarded one stays the spawner.
    const layer = transport
      ? native.pipe(Layer.provide(NativeTransport.layerFrom(spawner("raw"))), Layer.provide(spawner("guarded")))
      : native.pipe(Layer.provide(spawner("guarded")))
    const results = await Effect.runPromise(
      Effect.flatMap(NativeCoding, (service) => Effect.all(operations(service).map((effect) => Effect.result(effect))))
        .pipe(Effect.provide(layer))
    )
    // Every operation reached a helper process and carried its answer back.
    for (const result of results) {
      assert.equal(result._tag, "Failure")
      if (result._tag === "Failure") assert.equal(result.failure.code, "workspace_busy")
    }
    return calls
  }
  assert.deepEqual(await run(true), [
    "raw:read",
    "guarded:create",
    "guarded:apply_files",
    "raw:create_source",
    "raw:import_source",
    "raw:publish_source"
  ])
  assert.deepEqual(
    await run(false),
    ["read", "create", "apply_files", "create_source", "import_source", "publish_source"].map((op) => `guarded:${op}`),
    "without NativeTransport every operation uses the run's guarded spawner"
  )
})
