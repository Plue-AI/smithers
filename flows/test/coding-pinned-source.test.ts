import { NativeCoding, NativeCodingError, type ImportSource, type SourceImport } from "../coding/native.ts"
import { Effect, FileSystem, Layer } from "effect"
import assert from "node:assert/strict"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { preparePinnedFlowSource, withImmutableCommit } from "../coding/immutable-source.ts"

for (const mode of ["valid", "wrong-commit", "outside", "unavailable"] as const) {
  test(`pinned machine source export ${mode} never selects the editable checkout`, async (t) => {
    const temporary = await mkdtemp(join(tmpdir(), "coding-pinned-source-"))
    t.after(() => rm(temporary, { recursive: true, force: true }))
    const branch = join(temporary, "branch"), state = join(temporary, "state")
    await mkdir(branch)
    await writeFile(join(branch, "helper.ts"), "throw \"EDITABLE_BRANCH_CANARY\"")
    await writeFile(join(branch, "pnpm-lock.yaml"), "edited branch lockfile")
    const exporter = join(temporary, "exporter")
    await writeFile(
      exporter,
      `#!/bin/sh
set -eu
${mode === "unavailable" ? "exit 1" : ""}
mkdir -p "$3/source"
printf 'approved helper' > "$3/source/helper.ts"
printf 'original lockfile' > "$3/source/pnpm-lock.yaml"
printf '{"commitId":"${mode === "wrong-commit" ? "b".repeat(40) : "a".repeat(40)}","changeId":"source","treeId":"${
        "c".repeat(40)
      }","path":"%s","fileCount":2}' ${mode === "outside" ? "\"$1\"" : "\"$3/source\""}
`,
      { mode: 0o700 }
    )
    const { platform } = await import("../../packages/smithers/src/internal/NodeControlHost.ts")
    let imports = 0
    const result = await Effect.runPromise(
      Effect.gen(function*() {
        const fs = yield* FileSystem.FileSystem
        return yield* withImmutableCommit(
          {
            repositoryPath: branch,
            fs,
            sourceDirectory: state,
            exporterPath: exporter,
            environment: { PATH: "/usr/bin:/bin" }
          },
          "a".repeat(40),
          (_tree, root) =>
            Effect.gen(function*() {
              imports++
              assert(root.startsWith(state + "/"))
              assert.equal(yield* fs.readFileString(join(root, "helper.ts")), "approved helper")
              assert.equal(yield* fs.readFileString(join(root, "pnpm-lock.yaml")), "original lockfile")
              return root
            })
        )
      }).pipe(Effect.result, Effect.provide(platform.host))
    )
    assert.equal(result._tag, mode === "valid" ? "Success" : "Failure")
    assert.equal(imports, mode === "valid" ? 1 : 0)
  })
}

for (
  const [lockfile, manager, argv] of [
    ["pnpm-lock.yaml", "pnpm", "install --frozen-lockfile"],
    ["package-lock.json", "npm", "ci"],
    ["yarn.lock", "yarn", "install --immutable"],
    ["bun.lock", "bun", "install --frozen-lockfile"],
    ["bun.lockb", "bun", "install --frozen-lockfile"]
  ]
) {
  test(`pinned ${lockfile} dependencies resolve in the source checkout`, async (t) => {
    const temporary = await mkdtemp(join(tmpdir(), "coding-pinned-dependencies-"))
    t.after(() => rm(temporary, { recursive: true, force: true }))
    const source = join(temporary, "source"), binaries = join(temporary, "bin")
    await mkdir(source)
    await mkdir(binaries)
    await writeFile(join(source, lockfile!), "pinned lockfile")
    await writeFile(join(binaries, manager!), "#!/bin/sh\nprintf \"%s\\n%s\" \"$PWD\" \"$*\" > installed\n", {
      mode: 0o700
    })
    const { platform } = await import("../../packages/smithers/src/internal/NodeControlHost.ts")
    const { prepareFlowDependencies } = await import("../coding/immutable-source.ts")
    await Effect.runPromise(
      Effect.gen(function*() {
        const fs = yield* FileSystem.FileSystem
        yield* prepareFlowDependencies({
          repositoryPath: join(temporary, "branch"),
          fs,
          environment: { PATH: binaries + ":/usr/bin:/bin" }
        }, source)
        assert.equal(yield* fs.readFileString(join(source, "installed")), source + "\n" + argv)
        assert.equal(yield* fs.readFileString(join(source, lockfile!)), "pinned lockfile")
      }).pipe(Effect.provide(platform.host))
    )
  })
}

test("a failed pinned dependency install refuses before repository loading", async (t) => {
  const temporary = await mkdtemp(join(tmpdir(), "coding-pinned-dependencies-fail-"))
  t.after(() => rm(temporary, { recursive: true, force: true }))
  await writeFile(join(temporary, "pnpm-lock.yaml"), "pinned lockfile")
  await writeFile(join(temporary, "pnpm"), "#!/bin/sh\nexit 1\n", { mode: 0o700 })
  const { platform } = await import("../../packages/smithers/src/internal/NodeControlHost.ts")
  const { prepareFlowDependencies } = await import("../coding/immutable-source.ts")
  let imports = 0
  const result = await Effect.runPromise(
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      yield* prepareFlowDependencies({
        repositoryPath: temporary,
        fs,
        environment: { PATH: temporary + ":/usr/bin:/bin" }
      }, temporary)
      imports++
    }).pipe(Effect.result, Effect.provide(platform.host))
  )
  assert.equal(result._tag, "Failure")
  assert.equal(imports, 0)
})

test("the repository host admits only its pinned TODO descriptor before loading a body", async (t) => {
  const temporary = await mkdtemp(join(tmpdir(), "coding-pinned-registry-"))
  t.after(() => rm(temporary, { recursive: true, force: true }))
  await mkdir(join(temporary, "flows", "todo"), { recursive: true })
  await writeFile(
    join(temporary, "flows", "todo", "flow.mdx"),
    "---\ndescription: Pinned TODO\n---\nApproved TODO body"
  )
  const { platform } = await import("../../packages/smithers/src/internal/NodeControlHost.ts")
  const Registry = await import("@smthrs/registry/Registry")
  const Discovery = await import("@smthrs/registry/Discovery")
  const Descriptor = await import("@smthrs/registry/Descriptor")
  const { bindRepositoryRegistry } = await import("../repository/registry.ts")
  await Effect.runPromise(
    Effect.gen(function*() {
      const source = yield* Registry.make({
        sources: [{ root: join(temporary, "flows"), source: "project", naming: "path" }]
      }).pipe(Effect.provide(Discovery.layer))
      // Metadata is the input supplied by Active-version admission; expectations
      // below are literal source bytes and loader calls, not digest computation.
      const active = Descriptor.executionDigest(yield* source.get("todo"))!
      let loads = 0
      const measured = Registry.Registry.of({
        ...source,
        loadBody: (name, digest) => {
          loads++
          assert.equal(digest, active)
          return source.loadBody(name, digest)
        }
      })
      const pinned = bindRepositoryRegistry(measured, Registry.makeNoop(), "a".repeat(64), [], active)
      const body = yield* pinned.loadBody("todo", active)
      assert.equal(body._tag, "Prompt")
      if (body._tag === "Prompt") assert.equal(body.text.trim(), "Approved TODO body")
      assert.equal(loads, 1)
      for (
        const registry of [
          bindRepositoryRegistry(measured, Registry.makeNoop(), "a".repeat(64), []),
          bindRepositoryRegistry(measured, Registry.makeNoop(), "a".repeat(64), [], "0".repeat(64))
        ]
      ) {
        const refused = yield* registry.loadBody("todo").pipe(Effect.result)
        assert.equal(refused._tag, "Failure")
        assert.equal(loads, 1, "refusal happens before the source loader")
      }
      const mismatch = yield* pinned.loadBody("todo", "0".repeat(64)).pipe(Effect.result)
      assert.equal(mismatch._tag, "Failure")
      assert.equal(loads, 1, "a plan cannot widen the admitted digest")
    }).pipe(Effect.provide(platform.host))
  )
})

test("an installer cannot replace the approved lockfile before flow imports", async (t) => {
  const temporary = await mkdtemp(join(tmpdir(), "coding-pinned-lockfile-fail-"))
  t.after(() => rm(temporary, { recursive: true, force: true }))
  await writeFile(join(temporary, "pnpm-lock.yaml"), "approved lockfile")
  await writeFile(join(temporary, "pnpm"), "#!/bin/sh\nprintf changed > pnpm-lock.yaml\n", { mode: 0o700 })
  const { platform } = await import("../../packages/smithers/src/internal/NodeControlHost.ts")
  const { prepareFlowDependencies } = await import("../coding/immutable-source.ts")
  let imports = 0
  const result = await Effect.runPromise(
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      yield* prepareFlowDependencies({
        repositoryPath: temporary,
        fs,
        environment: { PATH: temporary + ":/usr/bin:/bin" }
      }, temporary)
      imports++
    }).pipe(Effect.result, Effect.provide(platform.host))
  )
  assert.equal(result._tag, "Failure")
  assert.equal(imports, 0)
})

const workspace = "22222222-2222-4222-8222-222222222222"
const source = "a".repeat(40)
const unavailable = Effect.die("unrelated native operation")
const service = (importSource?: NativeCoding["Service"]["importSource"]) => Layer.succeed(NativeCoding)({
  sourcePublication: "cloud", read: () => unavailable, apply: () => unavailable,
  publishOriginalSource: () => unavailable,
  ...(importSource === undefined ? {} : { importSource })
})

test("pinned startup imports only its immutable source through the workspace transport", async () => {
  const calls: Array<typeof ImportSource.Type> = []
  const native = service((request) => Effect.sync(() => {
    calls.push(request)
    const revision = { kind: "resolved" as const, changeId: "k".repeat(32), commitId: source,
      treeId: "b".repeat(40), operationId: "c".repeat(128), parentCommitIds: [] }
    return { status: "imported", requestId: request.requestId, workspaceId: workspace, repositoryId: 1,
      operationId: revision.operationId, head: revision, revisions: [revision] } satisfies typeof SourceImport.Type
  }))
  await Effect.runPromise(preparePinnedFlowSource(workspace, source).pipe(Effect.provide(native)))
  await Effect.runPromise(preparePinnedFlowSource(workspace, source).pipe(Effect.provide(native)))
  assert.deepEqual(calls[0]!.commits, [{ commitId: source,
    ref: `refs/smithers/workspaces/22222222-2222-4222-8222-222222222222/sources/${"a".repeat(40)}` }])
  assert.deepEqual(calls[1], calls[0], "startup recovery repeats the identical native request")
})

test("malformed pin or workspace refuses before importing anything", async () => {
  let calls = 0
  const native = service(() => { calls++; return unavailable })
  for (const [owner, commit] of [[workspace, "main"], [workspace, "0".repeat(40)],
    [workspace, "A".repeat(40)], ["../another-workspace", source]]) {
    await assert.rejects(Effect.runPromise(preparePinnedFlowSource(owner!, commit!).pipe(Effect.provide(native))))
  }
  assert.equal(calls, 0)
})

test("a host without the qualified importer refuses pinned startup", async () => {
  await assert.rejects(Effect.runPromise(preparePinnedFlowSource(workspace, source).pipe(Effect.provide(service()))))
})

test("an unavailable retained source cannot fall back to the editing checkout", async () => {
  await assert.rejects(Effect.runPromise(preparePinnedFlowSource(workspace, source).pipe(Effect.provide(service(() =>
    Effect.fail(new NativeCodingError({ code: "source_missing", message: "Retained source missing" })))))),
    /Retained source missing/)
})
