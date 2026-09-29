import { NodeFileSystem, NodePath } from "@effect/platform-node"
import { Action, Flow, Interpreter } from "@smthrs/flow"
import * as NodeRuntime from "@smthrs/flows/NodeRuntime"
import * as Descriptor from "@smthrs/registry/Descriptor"
import * as Discovery from "@smthrs/registry/Discovery"
import * as Executable from "@smthrs/registry/Executable"
import { Effect, FileSystem, Layer, ManagedRuntime } from "effect"
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { access, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, dirname, join } from "node:path"
import { test } from "node:test"
import { CapabilityPattern } from "../../packages/smithers/flows/capability/src/Capability.ts"
import { Rule } from "../../packages/smithers/flows/capability/src/Permission.ts"
import * as NodeJj from "../../packages/smithers/flows/jj/src/node/NodeJj.ts"
import { catalogLayers } from "../coding/catalog.ts"
import { checkDelegate, checkLayers } from "../coding/checks.ts"
import {
  type Check,
  CodingError,
  type Implementation,
  Receipt,
  receiptMatches,
  type Revision
} from "../coding/schema.ts"
import { RunCheck } from "../coding/workflow.ts"

const CheckRun = Flow.make("acceptance/RegisteredCheck", {
  payload: RunCheck.payloadSchema,
  success: Receipt,
  error: CodingError,
  body: (input) => RunCheck.call(input)
})

const exporter = process.env.SMITHERS_WORKSPACE_JJ_EXPORT_BINARY
test("native command checks read immutable source during edits and replay exact process evidence", {
  skip: exporter === undefined
    ? "Set SMITHERS_WORKSPACE_JJ_EXPORT_BINARY to packaged smithers-jj-export binary"
    : false,
  timeout: 900_000
}, async (t) => {
  const nativeRuntime = process.versions.bun ? await import("@smthrs/flows/BunRuntime") : NodeRuntime
  const temporary = await mkdtemp(join(tmpdir(), "coding-check-acceptance-"))
  let disposeHost = async () => {}
  t.after(async () => {
    await disposeHost()
    await rm(temporary, { force: true, recursive: true })
  })
  const root = join(temporary, "repo"), started = join(temporary, "started"), release = join(temporary, "release")
  execFileSync("jj", ["git", "init", root], { stdio: "pipe" })
  const jj = (...args: string[]) => execFileSync("jj", ["-R", root, ...args], { cwd: root, stdio: "pipe" }).toString()
  jj("config", "set", "--repo", "user.name", "Check Acceptance")
  jj("config", "set", "--repo", "user.email", "check@example.com")
  await writeFile(join(root, ".gitignore"), ".flows/\n")
  const definition = join(root, "flows", "checks", "schema", "flow.mdx")
  await mkdir(join(root, "flows", "checks", "schema"), { recursive: true })
  const declare = (mode: string) =>
    writeFile(
      definition,
      "---\ndescription: Verify immutable source.\nflows: [coding/CommandCheck]\ncapabilities: ['*']\n---\n" +
        JSON.stringify({
          argv: [mode === "pass" ? process.execPath : basename(process.execPath), "verify.mjs", started, release, mode],
          cwd: ".",
          timeoutMs: 60_000
        }) + "\n"
    )
  await declare("pass")
  await writeFile(join(root, "value.txt"), "old source")
  await symlink("value.txt", join(root, "alias-value.txt"))
  await writeFile(
    join(root, "verify.mjs"),
    `
import {appendFileSync,existsSync,readFileSync} from 'node:fs';
const [started,release,mode]=process.argv.slice(2);
appendFileSync(started,'started\\n');
while(!existsSync(release)) await new Promise(resolve=>setTimeout(resolve,25));
const value=readFileSync('alias-value.txt','utf8');
console.log(value+'|'+process.env.SMITHERS_CHECK_FILES);
process.exit(mode==='fail'?7:value==='old source'?0:9);
`
  )
  jj("status")
  const commit = JSON.parse(jj("log", "--ignore-working-copy", "-r", "@", "--no-graph", "-T", "json(self)"))
  const operationId = JSON.parse(jj("op", "log", "-n", "1", "--no-graph", "-T", "json(self)")).id as string
  const initial = JSON.parse(execFileSync(exporter!, [root, commit.commit_id, temporary], { stdio: "pipe" }).toString())
  assert.equal(initial.commitId, commit.commit_id)
  assert.equal(initial.changeId, commit.change_id)
  await rm(initial.path, { recursive: true, force: true })
  const revision: Revision = {
    changeId: initial.changeId,
    commitId: initial.commitId,
    treeId: initial.treeId,
    parentCommitIds: commit.parents,
    operationId
  }
  const implementation: Implementation = {
    change: "schema",
    parent: revision,
    atoms: [revision],
    head: revision,
    reads: [],
    writes: ["value.txt"]
  }
  const loadExecutable = () =>
    Effect.runPromise(
      Effect.gen(function*() {
        const found = yield* (yield* Discovery.Discovery).scan({
          source: "project",
          root: join(root, "flows"),
          naming: "path"
        })
        assert.equal(found.entries.length, 1)
        return yield* Executable.fromDescriptor(found.entries[0]!, { delegates: [checkDelegate] })
      }).pipe(
        Effect.provide(Discovery.layer.pipe(Layer.provideMerge(Layer.merge(NodeFileSystem.layer, NodePath.layer))))
      )
    )
  let executable = await loadExecutable()
  const check: Check = {
    id: "verify",
    flow: "checks/schema",
    flowDigest: Descriptor.executionDigest(executable.descriptor)!,
    target: "//:schema",
    tier: "slow",
    required: true
  }
  const directories: string[] = []
  const fs = await Effect.runPromise(FileSystem.FileSystem.pipe(Effect.provide(NodeFileSystem.layer)))
  const recordingFs: FileSystem.FileSystem = {
    ...fs,
    makeTempDirectoryScoped: (options?: Parameters<typeof fs.makeTempDirectoryScoped>[0]) =>
      fs.makeTempDirectoryScoped(options).pipe(Effect.tap((directory) =>
        Effect.sync(() => {
          directories.push(directory)
        })
      ))
  }
  const runtime = () =>
    nativeRuntime.layerHost(
      {
        filename: join(root, ".flows", "engine.db"),
        workspaceRoot: root,
        owner: { hostId: "check-acceptance" },
        signals: [],
        rules: [[
          new Rule({ effect: "allow", pattern: new CapabilityPattern({ action: "proc:spawn", resource: "**" }) })
        ]]
      },
      Layer.mergeAll(
        checkLayers({
          repositoryPath: root,
          exporterPath: exporter,
          fs: recordingFs,
          environment: { PATH: dirname(process.execPath) }
        }),
        catalogLayers,
        Interpreter.layer(CheckRun),
        executable.layer
      ).pipe(
        Layer.provideMerge(Action.layerImplementations),
        Layer.provideMerge(Layer.succeed(Executable.Catalog, { executables: [executable], refused: [] }))
      )
    ).pipe(
      Layer.provide(Layer.succeed(NodeJj.StartupTimeoutMs, 30_000))
    )
  let host = ManagedRuntime.make(runtime())
  disposeHost = () => host.dispose()
  const run = (check: Check, executionId: string, source: Implementation = implementation) =>
    host.runPromise(
      CheckRun.execute({ implementation: source, check }, { executionId }).pipe(Effect.scoped),
      { signal: t.signal }
    )
  const first = run(check, "check-original-source")
  // Keep rejection observed while waiting for the real checker to start.
  let earlyFailure: unknown
  void first.catch((error) => {
    earlyFailure = error
  })
  const deadline = Date.now() + 120_000
  for (;;) {
    if (earlyFailure) throw earlyFailure
    try {
      await access(started)
      break
    } catch {}
    assert.ok(Date.now() < deadline, "checker must start within the host acquisition budget")
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  await writeFile(join(root, "value.txt"), "new live source")
  jj("status")
  const afterEdit = JSON.parse(jj("op", "log", "-n", "1", "--no-graph", "-T", "json(self)")).id
  await writeFile(release, "continue")
  const passed = await first
  assert.equal(passed.status, "passed")
  assert.ok(receiptMatches(implementation, check, passed))
  assert.equal(JSON.parse(passed.evidence).stdout.trim(), "old source|value.txt", "the check reads the Change's written paths")
  assert.equal(await readFile(join(root, "value.txt"), "utf8"), "new live source")
  assert.equal(
    JSON.parse(jj("op", "log", "-n", "1", "--no-graph", "-T", "json(self)")).id,
    afterEdit,
    "check completion must not mutate JJ"
  )
  await host.dispose()
  await declare("fail")
  executable = await loadExecutable()
  const nextDigest = Descriptor.executionDigest(executable.descriptor)!
  assert.notEqual(nextDigest, check.flowDigest)
  host = ManagedRuntime.make(runtime())
  assert.deepEqual(await run(check, "check-original-source"), passed)
  assert.equal(await readFile(started, "utf8"), "started\n", "reopening must reuse the recorded process evidence")
  const failed = await run({ ...check, flowDigest: nextDigest }, "check-new-definition")
  assert.equal(failed.status, "failed")
  assert.equal(JSON.parse(failed.evidence).exitCode, 7)
  assert.equal(
    JSON.parse(failed.evidence).argv[0],
    basename(process.execPath),
    "relative executable resolves only through the explicitly supplied PATH"
  )
  assert.equal(failed.findings[0]?.sourceCommitId, revision.commitId)
  assert.equal(await readFile(started, "utf8"), "started\nstarted\n")
  assert.equal(
    directories.length,
    2,
    "both actual checks must acquire distinct host-owned exports; replay acquires none"
  )
  await symlink(join(root, "value.txt"), join(root, "live-source-link"))
  jj("status")
  const linkedCommit = JSON.parse(jj("log", "--ignore-working-copy", "-r", "@", "--no-graph", "-T", "json(self)"))
  const linked = JSON.parse(
    execFileSync(exporter!, [root, linkedCommit.commit_id, temporary], { stdio: "pipe" }).toString()
  )
  await rm(linked.path, { recursive: true, force: true })
  assert.equal(linked.commitId, linkedCommit.commit_id)
  assert.equal(linked.changeId, linkedCommit.change_id)
  const linkedRevision: Revision = {
    ...revision,
    changeId: linked.changeId,
    commitId: linked.commitId,
    treeId: linked.treeId
  }
  await assert.rejects(
    run({ ...check, flowDigest: nextDigest }, "check-external-link", {
      ...implementation,
      head: linkedRevision,
      atoms: [linkedRevision]
    }),
    /symbolic link outside/
  )
  assert.equal(
    await readFile(started, "utf8"),
    "started\nstarted\n",
    "an external source link must refuse before the check process starts"
  )
  assert.equal(directories.length, 3)
  for (const directory of directories) {
    await assert.rejects(access(directory), "temporary exports must be cleaned after process release")
  }
})
