import { Effect, FileSystem } from "effect"
import assert from "node:assert/strict"
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { withImmutableCommit, withPinnedSource } from "../coding/immutable-source.ts"
import { nativeLayer } from "../coding/native.ts"

for (
  const mode of [
    "valid",
    "refused",
    "wrong-workspace",
    "wrong-commit",
    "zero-source",
    "bad-workspace",
    "uppercase-source"
  ] as const
) {
  test(`pinned startup ${mode} imports retained source before exporting or loading it`, async (t) => {
    const temporary = await realpath(await mkdtemp(join(tmpdir(), "coding-pinned-import-")))
    t.after(() => rm(temporary, { recursive: true, force: true }))
    const branch = join(temporary, "branch"), state = join(temporary, "state"), helper = join(temporary, "helper")
    await mkdir(branch)
    await writeFile(join(branch, "editable"), "keep the person's work")
    const workspace = "11111111-1111-4111-a111-111111111111", commit = "a".repeat(40)
    // Protocol fixture: the selected immutable commit does not exist until
    // native import acknowledges it. Exercise the real native adapter and
    // exporter process boundaries; transport itself is covered by J1.
    await writeFile(
      helper,
      `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
if (process.argv[2] === '--local') {
  const request = JSON.parse(fs.readFileSync(0, 'utf8'));
  fs.appendFileSync(${JSON.stringify(join(temporary, "imports"))}, JSON.stringify(request) + '\\n');
  if (${JSON.stringify(mode)} === 'refused') {
    console.log(JSON.stringify({error:{code:'source_refused', message:'retention unavailable'}})); process.exit(1);
  }
  fs.writeFileSync(path.join(request.repositoryPath, 'imported'), 'yes');
  const revision = {kind:'resolved', commitId:${JSON.stringify(mode === "wrong-commit" ? "b".repeat(40) : commit)},
    treeId:'${"c".repeat(40)}', changeId:'${"k".repeat(32)}', operationId:'${
        "d".repeat(128)
      }', parentCommitIds:[], description:''};
  console.log(JSON.stringify({status:'imported', requestId:request.requestId,
    workspaceId:${JSON.stringify(mode === "wrong-workspace" ? "22222222-2222-4222-a222-222222222222" : workspace)},
    repositoryId:1, operationId:'${"d".repeat(128)}', head:revision, revisions:[revision]}));
} else {
  if (!fs.existsSync(path.join(process.argv[2], 'imported'))) process.exit(2);
  fs.appendFileSync(${JSON.stringify(join(temporary, "exports"))}, 'export\\n');
  const root = path.join(process.argv[4], 'source'); fs.mkdirSync(root);
  fs.writeFileSync(path.join(root, 'pinned'), 'approved source');
  console.log(JSON.stringify({commitId:process.argv[3], treeId:'${
        "c".repeat(40)
      }', changeId:'source', path:root, fileCount:1}));
}
`,
      { mode: 0o700 }
    )
    const { platform } = await import("../../packages/smithers/src/internal/NodeControlHost.ts")
    let loaded = 0
    const run = () =>
      Effect.runPromise(
        Effect.gen(function*() {
          const fs = yield* FileSystem.FileSystem
          return yield* withPinnedSource(
            {
              repositoryPath: branch,
              fs,
              sourceDirectory: state,
              exporterPath: helper,
              environment: { PATH: process.env.PATH! }
            },
            mode === "bad-workspace" ? "../other" : workspace,
            mode === "zero-source" ? "0".repeat(40) : mode === "uppercase-source" ? "A".repeat(40) : commit,
            (_tree, root) =>
              Effect.gen(function*() {
                loaded++
                assert.equal(yield* fs.readFileString(join(root, "pinned")), "approved source")
              })
          ).pipe(Effect.provide(nativeLayer({ repositoryPath: branch, helperPath: helper })))
        }).pipe(Effect.result, Effect.provide(platform.host))
      )
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = await run()
      assert.equal(result._tag, mode === "valid" ? "Success" : "Failure")
    }
    assert.equal(loaded, mode === "valid" ? 2 : 0)
    if (mode === "zero-source" || mode === "bad-workspace" || mode === "uppercase-source") {
      await assert.rejects(readFile(join(temporary, "imports")), { code: "ENOENT" })
      await assert.rejects(readFile(join(temporary, "exports")), { code: "ENOENT" })
      return
    }
    const requests = (await readFile(join(temporary, "imports"), "utf8")).trim().split("\n").map((line) =>
      JSON.parse(line)
    )
    assert.equal(requests[0].requestId, requests[1].requestId, "startup retries retain their import identity")
    assert.deepEqual(requests[0].commits, [{
      commitId: commit,
      ref: `refs/smithers/workspaces/${workspace}/sources/${commit}`
    }])
    assert.equal(await readFile(join(branch, "editable"), "utf8"), "keep the person's work")
    if (mode !== "valid") await assert.rejects(readFile(join(temporary, "exports")), { code: "ENOENT" })
  })
}

for (const mode of ["valid", "wrong-commit", "outside", "unavailable"] as const) {
  test(`pinned machine source export ${mode} never selects the editable checkout`, async (t) => {
    const temporary = await realpath(await mkdtemp(join(tmpdir(), "coding-pinned-source-")))
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
    const temporary = await realpath(await mkdtemp(join(tmpdir(), "coding-pinned-dependencies-")))
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
  const temporary = await realpath(await mkdtemp(join(tmpdir(), "coding-pinned-dependencies-fail-")))
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
  const temporary = await realpath(await mkdtemp(join(tmpdir(), "coding-pinned-registry-")))
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
      const draft = bindRepositoryRegistry(measured, Registry.makeNoop(), "a".repeat(64), [], undefined, true)
      const draftBody = yield* draft.loadBody("todo")
      assert.equal(draftBody._tag, "Prompt")
      assert.equal(loads, 2, "explicit draft host loads the working-copy version")
      const mismatch = yield* pinned.loadBody("todo", "0".repeat(64)).pipe(Effect.result)
      assert.equal(mismatch._tag, "Failure")
      assert.equal(loads, 2, "a plan cannot widen the admitted digest")
    }).pipe(Effect.provide(platform.host))
  )
})

test("an installer cannot replace the approved lockfile before flow imports", async (t) => {
  const temporary = await realpath(await mkdtemp(join(tmpdir(), "coding-pinned-lockfile-fail-")))
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
