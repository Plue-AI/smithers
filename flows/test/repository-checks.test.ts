import { NodeServices } from "@effect/platform-node"
import * as Digest from "@smthrs/core/Digest"
import { Effect, FileSystem, Layer, Schema } from "effect"
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import * as NodeJj from "../../packages/smithers/flows/jj/src/node/NodeJj.ts"
import {
  assessSemantic,
  CaptureChecks,
  captureChecks,
  checkLocations,
  type CheckPlan,
  type CheckResult,
  checksSummary,
  type Comparison,
  diffPaths,
  executeCommand,
  materializeProposal,
  probeCheckLocations,
  selectedComparison
} from "../repository/checks.ts"
import type { Work } from "../repository/jobs.ts"
import type { Check } from "../repository/schema.ts"

const exporter = process.env.SMITHERS_WORKSPACE_JJ_EXPORT_BINARY
test("repository checks use a committed PR comparison and immutable executable source, including proposed edits", {
  skip: exporter === undefined ? "Set SMITHERS_WORKSPACE_JJ_EXPORT_BINARY to the packaged exporter" : false,
  timeout: 180_000
}, async (t) => {
  const temporary = await realpath(await mkdtemp(join(tmpdir(), "repository-checks-")))
  t.after(() => rm(temporary, { recursive: true, force: true }))
  const root = join(temporary, "repo")
  execFileSync("jj", ["git", "init", root], { stdio: "pipe" })
  const jj = (...args: string[]) => execFileSync("jj", ["-R", root, ...args], { cwd: root, stdio: "pipe" }).toString()
  jj("config", "set", "--repo", "user.name", "Repository CI Test")
  jj("config", "set", "--repo", "user.email", "repository-ci@example.com")
  await writeFile(join(root, "value.txt"), "old\n")
  await writeFile(
    join(root, "verify.mjs"),
    "import{readFileSync}from'node:fs';const v=readFileSync('value.txt','utf8').trim();console.log(v);process.exit(v===process.argv[2]?0:7)"
  )
  jj("status")
  const base = jj("log", "-r", "@", "--no-graph", "-T", "commit_id").trim()
  jj("new", "-m", "Add a handler")
  await mkdir(join(root, "src"))
  await writeFile(join(root, "src", "new-handler.ts"), "export function handle() { return 42 }\n")
  await writeFile(join(root, "package-lock.json"), JSON.stringify({ fixture: "x".repeat(300_000) }))
  jj("status")
  const commit = JSON.parse(jj("log", "--ignore-working-copy", "-r", "@", "--no-graph", "-T", "json(self)"))
  const exported = JSON.parse(
    execFileSync(exporter!, [root, commit.commit_id, temporary], { stdio: "pipe" }).toString()
  )
  await rm(exported.path, { recursive: true, force: true })
  const operationId = JSON.parse(jj("op", "log", "-n", "1", "--no-graph", "-T", "json(self)")).id
  const fs = await Effect.runPromise(FileSystem.FileSystem.pipe(Effect.provide(NodeServices.layer)))
  const options = { repositoryPath: root, fs, exporterPath: exporter, environment: { PATH: process.env.PATH! } }
  const command: typeof Check.Type = {
    id: "verify",
    name: "Verify",
    kind: "command",
    rule: `${JSON.stringify(process.execPath)} verify.mjs old`,
    paths: [],
    policy: "required"
  }
  const ai: typeof Check.Type = {
    id: "observability",
    name: "Observability",
    kind: "ai",
    rule: "Each request handler records structured telemetry",
    paths: ["src/**"],
    policy: "required"
  }
  const work: typeof Work.Type = {
    repo: "test/repo",
    job: "ci",
    step: { id: "checks", name: "Checks", mode: "automatic", prompt: "Run configured checks" },
    checks: [command, ai],
    landing: "ask",
    replies: "draft",
    executionMode: "live",
    deadlineAt: Date.now() + 120_000,
    event: {
      source: "github",
      type: "pull_request",
      action: "opened",
      deliveryKey: "event-1",
      payload: { pull_request: { base: { sha: base }, head: { sha: exported.commitId } } }
    },
    evidence: {
      repo: "test/repo",
      source: {
        commitId: exported.commitId,
        treeId: exported.treeId,
        changeId: exported.changeId,
        parentCommitIds: commit.parents,
        operationId
      },
      files: [],
      missing: [],
      history: [],
      records: [],
      sources: []
    }
  }
  const platform = NodeJj.layerSpawnerAt(root).pipe(Layer.provideMerge(NodeServices.layer))
  const plan = await Effect.runPromise(captureChecks(options, work).pipe(Effect.provide(platform)))
  assert.equal(plan.comparison.base, base)
  assert.equal(plan.comparison.candidate, exported.commitId)
  assert.ok(
    plan.comparison.diff.includes("new-handler.ts"),
    "committed changes cannot disappear because the worktree is clean"
  )
  assert.deepEqual(plan.comparison.paths, ["package-lock.json", "src/new-handler.ts"])
  assert(
    !plan.comparison.diff.includes("package-lock.json"),
    "an unrelated large lockfile cannot exhaust this AI rule's source budget"
  )
  assert.deepEqual(
    selectedComparison(plan.comparison, ai).paths,
    ["src/new-handler.ts"],
    "a new handler is in semantic scope"
  )
  await writeFile(join(root, "value.txt"), "live edit\n")
  jj("status")
  const run = (rule: string, value = plan) =>
    Effect.runPromise(
      executeCommand(options, value, { ...command, rule }, "check-execution").pipe(Effect.provide(NodeServices.layer))
    )
  const passed = await run(command.rule)
  assert.equal(passed.status, "passed")
  assert.equal((passed.detail as { stdout: string }).stdout.trim(), "old")
  assert.equal((await run("exit 7")).status, "failed")
  assert.equal((await run("no-such-check-program-54321")).status, "error", "missing executables are execution errors")
  const commandsOnly = await Effect.runPromise(
    captureChecks(options, { ...work, checks: [command] }).pipe(Effect.provide(platform))
  )
  assert.equal(
    commandsOnly.comparison.files.length,
    0,
    "command-only CI needs the real source tree, not bounded model attachments"
  )
  assert.equal((await run(command.rule, commandsOnly)).status, "passed")
  const proposed = await Effect.runPromise(
    captureChecks(options, {
      ...work,
      proposal: [{ path: "value.txt", beforeDigest: Digest.digest("old\n"), content: "fixed\n" }]
    }).pipe(Effect.provide(platform))
  )
  assert.ok(proposed.comparison.candidate.startsWith(exported.commitId + "+"))
  assert.equal((await run(`${JSON.stringify(process.execPath)} verify.mjs fixed`, proposed)).status, "passed")
  assert.equal(
    await readFile(join(root, "value.txt"), "utf8"),
    "live edit\n",
    "checks cannot mutate the editor's source"
  )
  await assert.rejects(
    Effect.runPromise(
      captureChecks(options, {
        ...work,
        event: { ...work.event, payload: { pull_request: { base: { sha: base }, head: { sha: "f".repeat(40) } } } }
      }).pipe(Effect.provide(platform))
    ),
    /not the event's candidate/
  )
  await assert.rejects(
    Effect.runPromise(
      captureChecks(options, {
        ...work,
        proposal: [{ path: "value.txt", beforeDigest: "f".repeat(64), content: "wrong" }]
      }).pipe(Effect.provide(platform))
    ),
    /preimage differs/
  )
})

test("proposal writes refuse traversal, stale preimages and internal symlink aliases", async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "repository-proposal-")))
  t.after(() => rm(root, { recursive: true, force: true }))
  await writeFile(join(root, "a.ts"), "original")
  await symlink("a.ts", join(root, "alias.ts"))
  const outside = await realpath(await mkdtemp(join(tmpdir(), "repository-proposal-outside-")))
  t.after(() => rm(outside, { recursive: true, force: true }))
  await symlink(outside, join(root, "outside"))
  const fs = await Effect.runPromise(FileSystem.FileSystem.pipe(Effect.provide(NodeServices.layer)))
  const materialize = (path: string, beforeDigest: string | null) =>
    Effect.runPromise(
      materializeProposal({ fs, repositoryPath: root }, root, [{ path, beforeDigest, content: "changed" }]).pipe(
        Effect.provide(NodeServices.layer)
      )
    )
  await assert.rejects(materialize("../outside.ts", null), /cannot alter/)
  await assert.rejects(materialize("a.ts", null), /preimage/)
  await assert.rejects(materialize("alias.ts", Digest.digest("original")), /symbolic link/)
  await assert.rejects(materialize("outside/new-parent/new.ts", null), /symbolic link/)
  await assert.rejects(readFile(join(outside, "new-parent", "new.ts")), { code: "ENOENT" })
  await assert.rejects(
    realpath(join(outside, "new-parent")),
    { code: "ENOENT" },
    "a refused path cannot create an external directory"
  )
  assert.equal(await readFile(join(root, "a.ts"), "utf8"), "original")
})

test("semantic results cannot hide missing new handlers, fake source citations or contradictory success", () => {
  const comparison: typeof Comparison.Type = {
    base: "a".repeat(40),
    candidate: "b".repeat(40),
    diff: "",
    paths: ["src/new.ts"],
    files: [{ path: "src/new.ts", text: "export function handle() {}\n", digest: "c".repeat(64), truncated: false }],
    changes: []
  }
  const verdict = { verdict: "pass" as const, summary: "The rule holds", examinedPaths: ["src/new.ts"], findings: [] }
  assert.equal(assessSemantic(comparison, verdict).status, "passed")
  assert.equal(assessSemantic(comparison, { ...verdict, examinedPaths: [] }).status, "error")
  assert.equal(assessSemantic(comparison, { ...verdict, verdict: "uncertain" }).status, "error")
  const findings = [{ path: "src/new.ts", line: 1, message: "No request telemetry" }]
  assert.equal(assessSemantic(comparison, { ...verdict, findings }).status, "error")
  assert.equal(assessSemantic(comparison, { ...verdict, verdict: "fail", findings }).status, "failed")
  assert.equal(
    assessSemantic(comparison, { ...verdict, verdict: "fail", findings: [{ ...findings[0]!, line: 100 }] }).status,
    "error"
  )
  assert.deepEqual(diffPaths(""), [])
  assert.throws(() => diffPaths("binary or partial output"), /did not identify/)
  assert.throws(() => diffPaths("diff --git \"a/path with spaces\" \"b/path with spaces\""), /encoding/)
})

const checkResult = (values: Partial<typeof CheckResult.Type>): typeof CheckResult.Type => ({
  checkId: "docs",
  policy: "report",
  status: "skipped",
  summary: "No changed paths match this check",
  evidence: [],
  executionId: "execution-1",
  detail: null,
  ...values
})
/** The shape of the canary's failing eval: a PR job whose evidence was captured
 * from the event payload, and one report-only AI check that matched no path. */
const canaryPlan = (
  missing: readonly string[],
  searched: readonly { readonly path: string; readonly present: boolean }[]
): typeof CheckPlan.Type => ({
  searched,
  work: {
    repo: "codeplanesmithers/canary-sandbox",
    job: "ci",
    deadlineAt: Date.now() + 600_000,
    step: {
      id: "checks",
      name: "Run repository checks",
      mode: "automatic",
      prompt: "Inventory the tree for CI workflow files, build/test manifests and runnable scripts"
    },
    checks: [{
      id: "docs",
      name: "Documentation stays grounded",
      kind: "ai",
      rule: "Report findings only",
      paths: ["**/*.md"],
      policy: "report"
    }],
    landing: "ask",
    replies: "draft",
    executionMode: "live",
    event: {
      source: "github",
      type: "pull_request",
      action: "opened",
      deliveryKey: "delivery-1",
      payload: {
        pull_request: { base: { sha: "b".repeat(40) }, head: { sha: "f4d4814e64ec741c153a6163e6cac16c02691db6" } }
      }
    },
    evidence: {
      repo: "codeplanesmithers/canary-sandbox",
      files: [],
      missing,
      history: [],
      records: [],
      sources: [],
      source: {
        commitId: "f4d4814e64ec741c153a6163e6cac16c02691db6",
        treeId: "c".repeat(40),
        changeId: "d".repeat(32),
        operationId: "e".repeat(40),
        parentCommitIds: ["b".repeat(40)]
      }
    }
  },
  comparison: {
    base: "b".repeat(40),
    candidate: "f4d4814e64ec741c153a6163e6cac16c02691db6",
    diff: "",
    paths: [],
    files: [],
    changes: []
  },
  contexts: []
})

const absent = [".github/workflows", "package.json", "Makefile", "tox.ini", "pyproject.toml", "Cargo.toml", "go.mod"]
  .map((path) => ({ path, present: false }))
const where =
  " Searched for workflow files, manifests and scripts in .github/workflows, package.json, Makefile, tox.ini, pyproject.toml, Cargo.toml, go.mod: "

test("a repository that configures no runnable check says so and names the locations that were searched", () => {
  // A live CI job captures its evidence from the event payload, so evidence.missing
  // is empty and never describes where this repository would configure a check.
  const live = canaryPlan([], absent)
  assert.equal(
    checksSummary(live, [checkResult({})]),
    `No checks ran (1 configured ai check skipped).${where}none present.`
  )
  assert.equal(
    checksSummary(canaryPlan(["package.json", "tox.ini", "pyproject.toml"], absent), [checkResult({})]),
    checksSummary(live, [checkResult({})]),
    "the setup inspect's prompt-derived paths are not the locations this step probed"
  )
  const found = canaryPlan(
    [],
    absent.map((source) => source.path === "package.json" ? { path: source.path, present: true } : source)
  )
  assert.equal(
    checksSummary(found, [checkResult({})]),
    `No checks ran (1 configured ai check skipped).${where}found package.json.`
  )
  assert.equal(checksSummary(found, []), `No checks ran.${where}found package.json.`)
  assert.equal(checksSummary(canaryPlan([], []), [checkResult({})]), "No checks ran (1 configured ai check skipped).")
})

test("a summary that measured nothing names the kinds of the checks that did not run", () => {
  const base = canaryPlan([], [])
  const plan: typeof CheckPlan.Type = {
    ...base,
    work: {
      ...base.work,
      checks: [...base.work.checks, {
        id: "verify",
        name: "Tests pass",
        kind: "command",
        rule: "npm test",
        paths: [],
        policy: "report"
      }]
    }
  }
  assert.equal(
    checksSummary(plan, [checkResult({}), checkResult({ checkId: "verify" })]),
    "No checks ran (2 configured ai/command checks skipped)."
  )
  assert.equal(
    checksSummary(plan, [checkResult({ checkId: "verify" })]),
    "No checks ran (1 configured command check skipped)."
  )
  assert.equal(
    checksSummary(plan, [checkResult({ checkId: "withdrawn" })]),
    "No checks ran (1 configured check skipped).",
    "a result whose check the plan no longer carries contributes no kind"
  )
})

test("a plan journaled before this step probed locations still decodes, and claims no search", async () => {
  // The engine answers a journal hit by decoding the stored value through the
  // action's own JSON codec, so a run captured by an older build resumes here.
  const codec = Schema.toCodecJson(CaptureChecks.successSchema)
  const encoded = await Effect.runPromise(Schema.encodeEffect(codec)(canaryPlan([], absent)))
  const { searched, ...older } = encoded as Record<string, unknown>
  assert.ok(searched, "the current build journals the locations it probed")
  const decoded = await Effect.runPromise(Schema.decodeUnknownEffect(codec)(older))
  assert.equal(checksSummary(decoded, [checkResult({})]), "No checks ran (1 configured ai check skipped).")
})

test("the check-location probe measures this immutable tree, not an alias out of it", async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "repository-check-locations-")))
  t.after(() => rm(root, { recursive: true, force: true }))
  const outside = await realpath(await mkdtemp(join(tmpdir(), "repository-check-locations-outside-")))
  t.after(() => rm(outside, { recursive: true, force: true }))
  await writeFile(join(outside, "package.json"), "{}")
  await writeFile(join(root, "README.md"), "# canary\n")
  await symlink(join(outside, "package.json"), join(root, "package.json"))
  const fs = await Effect.runPromise(FileSystem.FileSystem.pipe(Effect.provide(NodeServices.layer)))
  const probe = () =>
    Effect.runPromise(probeCheckLocations({ fs, repositoryPath: root }, root).pipe(Effect.provide(NodeServices.layer)))
  assert.deepEqual(
    await probe(),
    checkLocations.map((path) => ({ path, present: false })),
    "a tree holding only README.md defines no check, and an aliased manifest is not this tree's source"
  )
  await mkdir(join(root, ".github", "workflows"), { recursive: true })
  await writeFile(join(root, "Makefile"), "test:\n\techo ok\n")
  assert.deepEqual(
    await probe(),
    checkLocations.map((path) => ({ path, present: path === ".github/workflows" || path === "Makefile" }))
  )
  assert.deepEqual(
    absent.map((source) => source.path),
    checkLocations,
    "the summary names every location the probe reads"
  )
})

test("a skipped check is neither a measured pass nor a measured failure", () => {
  const plan = canaryPlan([], absent)
  const passed = checkResult({ checkId: "verify", status: "passed", summary: "Exit 0" })
  assert.equal(checksSummary(plan, [passed, checkResult({})]), "1 of 1 checks passed, 1 skipped")
  assert.equal(
    checksSummary(plan, [passed, checkResult({ checkId: "lint", status: "failed" })]),
    "1 of 2 checks passed"
  )
  assert.equal(
    checksSummary(plan, [passed, checkResult({ checkId: "lint", status: "failed", policy: "required" })]),
    "1 required checks blocked"
  )
})
