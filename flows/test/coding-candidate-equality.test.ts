import { NodeServices } from "@effect/platform-node"
import { FlowEngine } from "@smthrs/engine"
import { DurableEngineState } from "@smthrs/engine-store"
import { Action } from "@smthrs/flow"
import * as RunStore from "@smthrs/run-store/RunStore"
import { Cause, Effect, FileSystem, Layer } from "effect"
import assert from "node:assert/strict"
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import * as MemoryStore from "../../packages/smithers/agent/memory/src/MemoryStore.ts"
import { checkDelegate, checkLayers } from "../coding/checks.ts"
import { correctionLayers, CorrectPlan } from "../coding/correction.ts"
import { NativeCoding } from "../coding/native.ts"
import { CodingError } from "../coding/schema.ts"
import { Implement, policyLayers, RunCheck } from "../coding/workflow.ts"

const engineLayer = <A, E, R>(layer: Layer.Layer<A, E, R>) =>
  layer.pipe(
    Layer.provideMerge(Action.layerImplementations),
    Layer.provideMerge(FlowEngine.layerMemory)
  )

// Real filesystem and command subprocesses; the exporter is a protocol fixture.
// This does not qualify the reference-host microVM/NativeCoding acceptance gate.
for (
  const mode of [
    "read",
    "write",
    "external-cache-read",
    "external-cache-write",
    "delete",
    "chmod",
    "symlink",
    "symlink-identical",
    "directory-symlink",
    "directory-symlink-outside",
    "multiple-writes",
    "nonzero-write",
    "remove-root",
    "timeout-write"
  ] as const
) {
  test(`packaged command action ${mode}: only unchanged candidate files verify`, async (t) => {
    const temporary = await mkdtemp(join(tmpdir(), "candidate-equality-"))
    t.after(() => rm(temporary, { recursive: true, force: true }))
    const repositoryPath = join(temporary, "repo")
    await mkdir(repositoryPath)
    const outside = join(temporary, "outside")
    await writeFile(outside, "outside canary")
    const exporterPath = join(temporary, "exporter")
    const revision = {
      changeId: "k".repeat(32),
      commitId: "a".repeat(40),
      treeId: "b".repeat(40),
      operationId: "c".repeat(64),
      parentCommitIds: []
    }
    await writeFile(
      exporterPath,
      `#!/bin/sh
mkdir "$3/tree"
mkdir "$3/tree/tracked"
printf 'candidate bytes' > "$3/tree/source.txt"
printf 'nested bytes' > "$3/tree/tracked/nested.txt"
ln -s source.txt "$3/tree/alias.txt"
printf '{"commitId":"${revision.commitId}","changeId":"${revision.changeId}","treeId":"${revision.treeId}","path":"%s/tree","fileCount":3}' "$3"
`
    )
    await chmod(exporterPath, 0o755)
    const commands = {
      read: "cat alias.txt; printf build > generated.txt",
      write: "printf formatted > source.txt",
      "external-cache-read": "cat alias.txt; printf build > generated.txt",
      "external-cache-write": "printf formatted > source.txt",
      delete: "rm source.txt",
      chmod: "chmod +x source.txt",
      symlink: `rm source.txt; ln -s '${outside}' source.txt`,
      "symlink-identical": "cp source.txt generated.txt; rm alias.txt; ln -s generated.txt alias.txt",
      "directory-symlink": "mv tracked generated; ln -s generated tracked",
      "directory-symlink-outside": `rm -rf tracked; ln -s '${temporary}' tracked`,
      "multiple-writes": "printf nested-edit > tracked/nested.txt; printf formatted > source.txt",
      "nonzero-write": "printf formatted > source.txt; exit 7",
      "remove-root": "rm -rf ../tree",
      "timeout-write": "printf formatted > source.txt; sleep 30"
    }
    const invocation = {
      flow: "checks/literal",
      prompt: JSON.stringify({
        argv: ["/bin/sh", "-c", commands[mode]],
        cwd: ".",
        timeoutMs: mode === "timeout-write" ? 500 : 10000
      }),
      model: null,
      placement: null,
      placementOptions: null,
      capabilities: ["*"],
      flows: ["coding/CommandCheck"],
      input: {
        implementation: {
          change: "candidate",
          parent: revision,
          atoms: [revision],
          head: revision,
          reads: [],
          writes: ["source.txt"]
        },
        check: {
          id: "literal",
          target: ".",
          flow: "checks/literal",
          flowDigest: "literal-digest",
          tier: "fast",
          required: true
        }
      }
    }
    const sourceDirectory = mode.startsWith("external-cache-") ? join(temporary, "install-source") : undefined
    const fs = await Effect.runPromise(FileSystem.FileSystem.pipe(Effect.provide(NodeServices.layer)))
    const outcome = await Effect.runPromise(
      checkDelegate.execute(invocation, { executionId: `equality-${mode}` }).pipe(
        Effect.result,
        Effect.scoped,
        Effect.provide(
          engineLayer(
            checkLayers({ repositoryPath, exporterPath, sourceDirectory, fs, environment: { PATH: "/usr/bin:/bin" } })
              .pipe(Layer.provide(NodeServices.layer))
          ).pipe(Layer.provideMerge(NodeServices.layer))
        )
      )
    )
    const cache = sourceDirectory ?? join(repositoryPath, ".jj", "smithers-checks")
    if (sourceDirectory !== undefined) {
      assert.deepEqual(await readdir(repositoryPath), [], "retention must not depend on checkout storage")
    }
    if (mode === "read" || mode === "external-cache-read") {
      assert.equal(outcome._tag, "Success")
      if (outcome._tag === "Success") {
        assert.equal(outcome.success.status, "passed")
        assert.equal(outcome.success.treeId, revision.treeId)
      }
      assert.deepEqual(await readdir(cache), [])
    } else {
      assert.equal(outcome._tag, "Failure")
      if (outcome._tag !== "Failure") return
      assert.ok(outcome.failure instanceof CodingError)
      assert.equal(outcome.failure.code, "check_modified_tree")
      const retained = outcome.failure.message.split("output retained at ")[1]!
      assert.ok(retained.startsWith(join(cache, "modified-")))
      assert.equal((await readdir(cache)).length, 1, "only the retained output survives scoped cleanup")
      const evidence = JSON.parse(await readFile(join(retained, "..", "failure.json"), "utf8"))
      assert.equal(evidence.code, "check_modified_tree")
      assert.equal(evidence.checkId, "literal")
      assert.deepEqual(
        evidence.changedPaths,
        mode === "remove-root" || mode === "multiple-writes"
          ? mode === "remove-root"
            ? ["alias.txt", "source.txt", "tracked/nested.txt"]
            : ["source.txt", "tracked/nested.txt"]
          : mode.startsWith("directory-symlink")
          ? ["tracked/nested.txt"]
          : mode === "symlink-identical"
          ? ["alias.txt"]
          : ["source.txt"]
      )
      if (mode === "remove-root") assert.deepEqual(await readdir(retained), [])
      if (
        mode === "write" || mode === "external-cache-write" || mode === "nonzero-write" || mode === "timeout-write" ||
        mode === "multiple-writes"
      ) {
        assert.equal(await readFile(join(retained, "source.txt"), "utf8"), "formatted")
      }
      if (mode === "directory-symlink") {
        assert.equal(await readFile(join(retained, "generated", "nested.txt"), "utf8"), "nested bytes")
      }
      if (mode === "multiple-writes") {
        assert.equal(await readFile(join(retained, "tracked", "nested.txt"), "utf8"), "nested-edit")
      }
    }
    assert.equal(await readFile(outside, "utf8"), "outside canary")
  })
}

test("tree-writing check stops the correction flow before a repair or another check", async () => {
  const revision = {
    changeId: "change",
    commitId: "commit",
    treeId: "tree",
    operationId: "operation",
    parentCommitIds: []
  }
  const check = {
    id: "literal",
    target: ".",
    flow: "checks/literal",
    flowDigest: "digest",
    tier: "fast" as const,
    required: true
  }
  const plan = {
    prompt: "Fixture",
    memoryRevision: "fixture",
    base: revision,
    changes: [{
      id: "candidate",
      title: "Candidate",
      intent: "Fixture",
      implementation: "fixture",
      implementationDigest: "0".repeat(64),
      atoms: [{ changeId: null, message: "Fixture", intent: "Fixture", reads: [], writes: [] }],
      checks: [check]
    }]
  }
  let implementations = 0, checks = 0
  const failure = new CodingError({ code: "check_modified_tree", message: "Modified tracked files" })
  const outcome = await Effect.runPromise(
    CorrectPlan.execute({ plan, maxRounds: 8 }, { executionId: "writing-check-no-cycle" }).pipe(
      Effect.exit,
      Effect.scoped,
      Effect.provide(
        engineLayer(
          Layer.mergeAll(
            correctionLayers,
            policyLayers,
            Implement.toLayer(({ parent }) =>
              Effect.sync(() => {
                implementations++
                return { change: "candidate", parent, head: revision, atoms: [revision], reads: [], writes: [] }
              })
            ),
            RunCheck.toLayer(() =>
              Effect.suspend(() => {
                checks++
                return Effect.fail(failure)
              })
            )
          ).pipe(
            Layer.provide(Layer.succeed(NativeCoding, {
              sourcePublication: "local-only",
              read: () => Effect.die("no recapture"),
              apply: () => Effect.die("no repair"),
              publishOriginalSource: () => Effect.die("no publication")
            })),
            Layer.provide(NodeServices.layer),
            Layer.provideMerge(
              Layer.mergeAll(MemoryStore.layerNoop(), RunStore.layerNoop(), DurableEngineState.layerMemory)
            )
          )
        ).pipe(Layer.provideMerge(NodeServices.layer))
      )
    )
  )
  assert.equal(outcome._tag, "Failure")
  if (outcome._tag === "Failure") {
    const reason = outcome.cause.reasons.find(Cause.isFailReason)
    assert.ok(reason?.error instanceof CodingError, Cause.pretty(outcome.cause))
    assert.equal(reason.error.code, "check_modified_tree")
    assert.equal(reason.error.message, "Modified tracked files")
  }
  assert.equal(implementations, 1)
  assert.equal(checks, 1)
})
