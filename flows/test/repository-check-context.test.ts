import { NodeServices } from "@effect/platform-node"
import { Effect, FileSystem, Layer } from "effect"
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test, type TestContext } from "node:test"
import * as NodeJj from "../../packages/smithers/flows/jj/src/node/NodeJj.ts"
import { captureCheckContext, contextFailure, rulePaths, sourceImports } from "../repository/check-context.ts"
import { assessSemantic, captureChecks, type Comparison, selectedComparison } from "../repository/checks.ts"
import type { Work } from "../repository/jobs.ts"

const exporter = process.env.SMITHERS_WORKSPACE_JJ_EXPORT_BINARY
const check = {
  id: "telemetry",
  name: "Telemetry",
  kind: "ai" as const,
  rule: "Follow the local helper",
  paths: ["src/**"],
  policy: "report" as const
}
const revision = "a".repeat(40)
test("context selection distinguishes explicit files and local module edges from prose, examples and packages", () => {
  assert.deepEqual(
    rulePaths(
      "Use Node.js and next.js. Follow docs/telemetry.md and `rules.md`. See https://example.org/docs/network.md."
    ),
    ["docs/telemetry.md", "rules.md"]
  )
  assert.deepEqual(rulePaths("Read `../private.md` and `/etc/config.md`"), ["../private.md", "/etc/config.md"])
  assert.deepEqual(rulePaths("Use ./docs/telemetry.md but never /etc/config.md"), [
    "docs/telemetry.md",
    "/etc/config.md"
  ])
  assert.deepEqual(
    sourceImports(
      "src/handler.ts",
      `// import x from './comment.ts'
    const example = "import x from './example.ts'";
    import { telemetry } from '../telemetry.js';
    export { helper } from './helper';
    const late = import('./late.js'); const external = require('external-package');
    const dynamic = import(path); object.import('./method.js');`
    ),
    ["../telemetry.js", "./helper", "./late.js", "external-package"]
  )
  assert.deepEqual(sourceImports("README.md", "import x from './example.ts'"), [])
})

test("supporting reads retain missing, oversized, refused and unresolved inputs without reading held-out aliases", async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "check-context-")))
  const outside = await realpath(await mkdtemp(join(tmpdir(), "check-context-outside-")))
  t.after(() => Promise.all([root, outside].map((path) => rm(path, { recursive: true, force: true }))))
  await mkdir(join(root, "src"))
  await mkdir(join(root, ".smithers", "repository-jobs"), { recursive: true })
  await writeFile(join(root, ".smithers", "repository-jobs", "evals.json"), "HELD_OUT_EXPECTATION")
  await writeFile(join(outside, "secret.ts"), "EXTERNAL_BYTES")
  await symlink("../.smithers/repository-jobs/evals.json", join(root, "src", "alias.ts"))
  await symlink(join(outside, "secret.ts"), join(root, "src", "outside.ts"))
  await writeFile(join(root, "src", "big.ts"), "x".repeat(32_769))
  await writeFile(join(root, "src", "binary.ts"), "\u0000binary")
  await writeFile(
    join(root, "src", "handler.ts"),
    "import './alias'; import './outside'; import './big'; import './binary'; import './missing'; import '@app/logger'; import '@/local';"
  )
  const fs = await Effect.runPromise(FileSystem.FileSystem.pipe(Effect.provide(NodeServices.layer)))
  const capture = (rule = check.rule) =>
    Effect.runPromise(
      captureCheckContext({ repositoryPath: root, fs }, root, {
        check: { ...check, rule },
        source: revision,
        paths: ["src/handler.ts"],
        deadlineAt: Date.now() + 10_000
      }).pipe(Effect.provide(NodeServices.layer))
    )
  const context = await capture("Read docs/missing.md")
  for (
    const [path, status] of [
      ["docs/missing.md", "missing"],
      ["src/alias.ts", "refused"],
      ["src/outside.ts", "refused"],
      ["src/big.ts", "oversized"],
      ["src/binary.ts", "unreadable"],
      ["src/missing", "unresolved"],
      ["@/local", "unresolved"]
    ]
  ) {
    assert(
      context.reads.some((read) => read.path === path && read.status === status && read.required),
      `${path} must retain ${status}`
    )
  }
  assert(context.reads.some((read) => read.path === "@app/logger" && read.status === "external" && !read.required))
  assert(!JSON.stringify(context).includes("HELD_OUT_EXPECTATION"))
  assert(!JSON.stringify(context).includes("EXTERNAL_BYTES"))
  assert.match(contextFailure(context, revision, check.id)!, /Supporting context.+missing/)
  const direct = await capture("Read `.smithers/repository-jobs/evals.json`")
  assert(direct.reads.some((read) => read.path === ".smithers/repository-jobs/evals.json" && read.status === "refused"))
  const comparison: typeof Comparison.Type = {
    base: "b".repeat(40),
    candidate: revision,
    paths: ["src/handler.ts"],
    diff: "",
    files: context.files,
    changes: []
  }
  assert.equal(
    assessSemantic(comparison, {
      verdict: "pass",
      summary: "Looks fine",
      examinedPaths: comparison.paths,
      findings: []
    }, context).status,
    "error",
    "a favorable model answer cannot override absent evidence"
  )
})

test("an internal alias resolves supporting imports beside its canonical source", async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "check-context-alias-")))
  t.after(() => rm(root, { recursive: true, force: true }))
  await mkdir(join(root, "src"))
  await mkdir(join(root, "shared"))
  await writeFile(join(root, "shared", "helper.ts"), "import './dependency';")
  await writeFile(join(root, "shared", "dependency.ts"), "export const value = 'canonical';")
  await writeFile(join(root, "src", "dependency.ts"), "WRONG_DEPENDENCY")
  await symlink("../shared/helper.ts", join(root, "src", "alias.ts"))
  const fs = await Effect.runPromise(FileSystem.FileSystem.pipe(Effect.provide(NodeServices.layer)))
  const context = await Effect.runPromise(
    captureCheckContext({ repositoryPath: root, fs }, root, {
      check,
      source: revision,
      paths: ["src/alias.ts"],
      deadlineAt: Date.now() + 10_000
    }).pipe(Effect.provide(NodeServices.layer))
  )
  assert.equal(contextFailure(context, revision, check.id, ["src/alias.ts"]), undefined)
  assert(context.files.some((file) => file.path === "shared/dependency.ts"))
  assert(!JSON.stringify(context).includes("WRONG_DEPENDENCY"))
})

test("context budget and depth exhaustion stay visible; complete source is digest bound", async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "check-context-budget-")))
  t.after(() => rm(root, { recursive: true, force: true }))
  await writeFile(
    join(root, "main.ts"),
    Array.from({ length: 26 }, (_, index) => `import './helper${index}';`).join("\n")
  )
  for (let index = 0; index < 26; index++) await writeFile(join(root, `helper${index}.ts`), "export const value = 1;\n")
  const fs = await Effect.runPromise(FileSystem.FileSystem.pipe(Effect.provide(NodeServices.layer)))
  const capture = () =>
    Effect.runPromise(
      captureCheckContext({ repositoryPath: root, fs }, root, {
        check,
        source: revision,
        paths: ["main.ts"],
        deadlineAt: Date.now() + 10_000
      }).pipe(Effect.provide(NodeServices.layer))
    )
  const limited = await capture()
  assert(limited.reads.some((read) => read.required && read.status === "limit"))
  assert(limited.files.length <= 24)
  await writeFile(join(root, "main.ts"), "import './helper0';")
  const context = await capture()
  assert.equal(contextFailure(context, revision, check.id), undefined)
  await writeFile(join(root, "README.md"), "Optional overview ".repeat(2500))
  await writeFile(
    join(root, "main.ts"),
    Array.from({ length: 150 }, (_, index) => `import 'external${index}';`).join("\n")
  )
  const packages = await capture()
  assert.equal(
    contextFailure(packages, revision, check.id),
    undefined,
    "unfetched external packages and optional oversized prose are not mandatory inputs"
  )
  assert(packages.reads.some((read) => read.path === "README.md" && read.status === "oversized" && !read.required))
  assert(packages.reads.filter((read) => read.status === "external").length <= 8)
  await writeFile(join(root, "main.ts"), "import './helper0';")
  assert.match(contextFailure(context, "b".repeat(40), check.id)!, /another/)
  assert.match(
    contextFailure(
      { ...context, files: context.files.map((file) => ({ ...file, text: "stale" })) },
      revision,
      check.id
    )!,
    /incomplete/
  )
  assert.match(
    contextFailure(
      { ...context, files: context.files.map((file) => ({ ...file, truncated: true })) },
      revision,
      check.id
    )!,
    /incomplete/
  )
  for (let index = 0; index < 5; index++) {
    await writeFile(join(root, `helper${index}.ts`), `import './helper${index + 1}';`)
  }
  assert.match(contextFailure(await capture(), revision, check.id)!, /limit/)
})

test("committed check context captures local helpers and rule files without using later editor bytes", {
  skip: exporter === undefined ? "Set SMITHERS_WORKSPACE_JJ_EXPORT_BINARY to the packaged exporter" : false,
  timeout: 120_000
}, async (t) => {
  const temporary = await realpath(await mkdtemp(join(tmpdir(), "check-context-native-")))
  t.after(() => rm(temporary, { recursive: true, force: true }))
  const root = join(temporary, "repo")
  execFileSync("jj", ["git", "init", root], { stdio: "pipe" })
  const jj = (...args: string[]) => execFileSync("jj", ["-R", root, ...args], { cwd: root, stdio: "pipe" }).toString()
  jj("config", "set", "--repo", "user.name", "Context test")
  jj("config", "set", "--repo", "user.email", "context@example.com")
  await mkdir(join(root, "src"))
  await mkdir(join(root, "docs"))
  await writeFile(join(root, "AGENTS.md"), "Use the structured telemetry helper.\n")
  await writeFile(join(root, "src", "AGENTS.md"), "Handlers retain operation and failure context.\n")
  await writeFile(join(root, "docs", "telemetry.md"), "Never include secrets in telemetry.\n")
  await writeFile(join(root, "src", "telemetry.ts"), "export const record = () => 'captured helper';\n")
  jj("status")
  const base = jj("log", "-r", "@", "--no-graph", "-T", "commit_id").trim()
  jj("new", "-m", "Add handler")
  await writeFile(
    join(root, "src", "handler.ts"),
    "import { record } from './telemetry.js';\nexport const handle = () => record();\n"
  )
  jj("status")
  const commit = JSON.parse(jj("log", "--ignore-working-copy", "-r", "@", "--no-graph", "-T", "json(self)"))
  const exported = JSON.parse(
    execFileSync(exporter!, [root, commit.commit_id, temporary], { stdio: "pipe" }).toString()
  )
  await rm(exported.path, { recursive: true, force: true })
  const operationId = JSON.parse(jj("op", "log", "-n", "1", "--no-graph", "-T", "json(self)")).id
  const fs = await Effect.runPromise(FileSystem.FileSystem.pipe(Effect.provide(NodeServices.layer)))
  const work: typeof Work.Type = {
    repo: "test/repo",
    job: "ci",
    step: { id: "checks", name: "Checks", mode: "automatic", prompt: "Check telemetry" },
    checks: [{
      id: "telemetry",
      name: "Telemetry",
      kind: "ai",
      rule: "Follow docs/telemetry.md for handlers",
      paths: ["src/handler.ts"],
      policy: "report"
    }],
    landing: "ask",
    replies: "draft",
    executionMode: "live",
    deadlineAt: Date.now() + 90_000,
    event: {
      source: "github",
      type: "pull_request",
      action: "opened",
      deliveryKey: "captured-context",
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
  // The current working tree deliberately disagrees with the committed PR.
  await writeFile(join(root, "src", "telemetry.ts"), "EDITOR_BYTES_MUST_NOT_REACH_REVIEW\n")
  const options = { repositoryPath: root, fs, exporterPath: exporter, environment: { PATH: process.env.PATH! } }
  const platform = NodeJj.layerSpawnerAt(root).pipe(Layer.provideMerge(NodeServices.layer))
  const plan = await Effect.runPromise(captureChecks(options, work).pipe(Effect.provide(platform)))
  const contexts = (plan as unknown as {
    contexts?: Array<
      {
        checkId: string
        source: string
        files: Array<{ path: string; text: string }>
        reads: Array<{ path: string; status: string; required: boolean }>
      }
    >
  }).contexts
  assert(contexts, "A checked candidate must carry actual per-rule supporting context")
  const context = contexts.find((value) => value.checkId === "telemetry")!
  assert.equal(context.source, exported.commitId)
  for (const path of ["src/telemetry.ts", "docs/telemetry.md", "AGENTS.md", "src/AGENTS.md"]) {
    assert(context.files.some((file) => file.path === path), `Missing ${path}`)
  }
  assert(context.files.find((file) => file.path === "src/telemetry.ts")!.text.includes("captured helper"))
  assert(!JSON.stringify(context).includes("EDITOR_BYTES"))
  assert.equal(await readFile(join(root, "src", "telemetry.ts"), "utf8"), "EDITOR_BYTES_MUST_NOT_REACH_REVIEW\n")
  const missing = await Effect.runPromise(
    captureChecks(options, { ...work, checks: [{ ...work.checks[0]!, rule: "Follow docs/missing.md" }] }).pipe(
      Effect.provide(platform)
    )
  )
  const missingContext = (missing as unknown as { contexts: typeof contexts }).contexts[0]!
  assert(
    missingContext.reads.some((read) => read.path === "docs/missing.md" && read.status === "missing" && read.required),
    "A named missing input must remain explicit"
  )
})

async function deletedFixture(
  t: TestContext,
  candidateHelper = "export const record = () => 'CANDIDATE_HELPER';\n",
  heldOutAlias = false
) {
  const temporary = await realpath(await mkdtemp(join(tmpdir(), "check-deleted-context-")))
  t.after(() => rm(temporary, { recursive: true, force: true }))
  const root = join(temporary, "repo")
  execFileSync("jj", ["git", "init", root], { stdio: "pipe" })
  const jj = (...args: string[]) => execFileSync("jj", ["-R", root, ...args], { cwd: root, stdio: "pipe" }).toString()
  jj("config", "set", "--repo", "user.name", "Deletion context")
  jj("config", "set", "--repo", "user.email", "deletion@example.com")
  await mkdir(join(root, "src"))
  await mkdir(join(root, "docs"))
  await writeFile(join(root, "AGENTS.md"), "Preserve the local helper's behavior.\n")
  const old = "import { record } from '../helper.js';\nexport const obsolete = () => record();\n"
  await writeFile(join(root, "src", "old.ts"), old)
  await writeFile(
    join(root, "src", "kept.ts"),
    "import { record } from '../helper.js';\nexport const kept = () => record();\n"
  )
  if (heldOutAlias) {
    await mkdir(join(root, ".smithers", "repository-jobs"), { recursive: true })
    await writeFile(join(root, ".smithers", "repository-jobs", "evals.json"), "HELD_OUT_BASE_AND_CANDIDATE")
    await symlink(".smithers/repository-jobs/evals.json", join(root, "private-alias.ts"))
  }
  await writeFile(
    join(root, "helper.ts"),
    "export const record = () => 'BASE_HELPER';\n" + (heldOutAlias ? "import './private-alias.js';\n" : "")
  )
  jj("status")
  const base = jj("log", "-r", "@", "--no-graph", "-T", "commit_id").trim()
  jj("new", "-m", "Remove obsolete handler")
  await rm(join(root, "src", "old.ts"))
  await writeFile(
    join(root, "src", "kept.ts"),
    "import { record } from '../helper.js';\nexport const kept = () => record() + 'new';\n"
  )
  await writeFile(join(root, "docs", "new-rule.md"), "The remaining handler uses the current helper.\n")
  if (candidateHelper) {
    await writeFile(join(root, "helper.ts"), candidateHelper + (heldOutAlias ? "import './private-alias.js';\n" : ""))
  } else await rm(join(root, "helper.ts"))
  jj("status")
  const commit = JSON.parse(jj("log", "--ignore-working-copy", "-r", "@", "--no-graph", "-T", "json(self)"))
  const exported = JSON.parse(
    execFileSync(exporter!, [root, commit.commit_id, temporary], { stdio: "pipe" }).toString()
  )
  await rm(exported.path, { recursive: true, force: true })
  const operationId = JSON.parse(jj("op", "log", "-n", "1", "--no-graph", "-T", "json(self)")).id
  const fs = await Effect.runPromise(FileSystem.FileSystem.pipe(Effect.provide(NodeServices.layer)))
  const work: typeof Work.Type = {
    repo: "test/repo",
    job: "ci",
    step: { id: "checks", name: "Checks", mode: "automatic", prompt: "Check deletion" },
    checks: [{ ...check, rule: "Review src/old.ts and follow docs/new-rule.md" }],
    landing: "ask",
    replies: "draft",
    executionMode: "live",
    deadlineAt: Date.now() + 90_000,
    event: {
      source: "github",
      type: "pull_request",
      action: "opened",
      deliveryKey: "deleted-context",
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
  const options = { repositoryPath: root, fs, exporterPath: exporter, environment: { PATH: process.env.PATH! } }
  const platform = NodeJj.layerSpawnerAt(root).pipe(Layer.provideMerge(NodeServices.layer))
  const capture = (override = options) =>
    Effect.runPromise(captureChecks(override, work).pipe(Effect.provide(platform)))
  return { temporary, root, work, options, capture, base, old }
}
const deletedNative = {
  skip: exporter === undefined ? "Set SMITHERS_WORKSPACE_JJ_EXPORT_BINARY to the packaged exporter" : false,
  timeout: 120_000
}
test(
  "committed deletions keep exact base preimages and helpers separate from modified candidate context",
  deletedNative,
  async (t) => {
    const fixture = await deletedFixture(t)
    await writeFile(join(fixture.root, "helper.ts"), "EDITOR_HELPER_MUST_NOT_ENTER_EITHER_SIDE\n")
    const plan = await fixture.capture(),
      candidate = plan.contexts[0]!,
      comparison = selectedComparison(plan.comparison, fixture.work.checks[0]!)
    assert.equal(
      contextFailure(candidate, plan.comparison.candidate, check.id, ["src/kept.ts"]),
      undefined,
      "A valid deletion must not require its absent file in the candidate tree"
    )
    const baseContext = (plan as typeof plan & { baseContexts?: Array<typeof candidate> }).baseContexts?.[0]
    assert(baseContext, "The removed source needs independently captured base-side evidence")
    assert.equal(baseContext.source, fixture.base)
    assert.equal(contextFailure(baseContext, fixture.base, check.id, ["src/old.ts"]), undefined)
    assert(candidate.files.find((file) => file.path === "helper.ts")!.text.includes("CANDIDATE_HELPER"))
    assert(baseContext.files.find((file) => file.path === "helper.ts")!.text.includes("BASE_HELPER"))
    assert(!candidate.files.some((file) => file.path === "src/old.ts"))
    assert(
      !baseContext.reads.some((read) => read.path === "docs/new-rule.md"),
      "A newly introduced rule file is candidate evidence, not a required historical file"
    )
    assert(candidate.files.some((file) => file.path === "docs/new-rule.md"))
    assert(!JSON.stringify(plan).includes("EDITOR_HELPER"))
    assert.deepEqual(plan.comparison.changes.find((file) => file.path === "src/old.ts"), {
      path: "src/old.ts",
      before: fixture.old,
      after: null
    })
    const verdict = {
      verdict: "fail" as const,
      summary: "The removed handler needs replacement",
      examinedPaths: ["src/old.ts", "src/kept.ts"],
      findings: [{ path: "src/old.ts", line: 2, message: "This removed behavior still has a caller." }]
    }
    assert.equal(
      assessSemantic(comparison, verdict, candidate, baseContext).status,
      "failed",
      "Old-line findings on a proven deletion are valid policy findings"
    )
    assert.equal(
      assessSemantic(
        comparison,
        { ...verdict, findings: [{ ...verdict.findings[0]!, line: 99 }] },
        candidate,
        baseContext
      ).status,
      "error"
    )
    assert.equal(
      assessSemantic(comparison, verdict, candidate, { ...baseContext, source: plan.comparison.candidate }).status,
      "error",
      "A different base cannot establish historical context"
    )
    assert.equal(
      assessSemantic(
        comparison,
        { ...verdict, findings: [{ ...verdict.findings[0]!, path: "helper.ts" }] },
        candidate,
        baseContext
      ).status,
      "error",
      "Supporting base helpers are not changed finding scope"
    )
    assert.equal(
      assessSemantic(comparison, verdict, candidate).status,
      "error",
      "Missing base evidence cannot pass or establish a finding"
    )
    assert.equal(
      assessSemantic(comparison, verdict, candidate, {
        ...baseContext,
        files: baseContext.files.map((file) => file.path === "src/old.ts" ? { ...file, text: "stale preimage" } : file)
      }).status,
      "error"
    )
    assert.equal(await readFile(join(fixture.root, "helper.ts"), "utf8"), "EDITOR_HELPER_MUST_NOT_ENTER_EITHER_SIDE\n")
  }
)

test(
  "missing candidate helpers never borrow base bytes and unavailable base export refuses deletion review",
  deletedNative,
  async (t) => {
    const fixture = await deletedFixture(t, "")
    const plan = await fixture.capture(), candidate = plan.contexts[0]!
    assert(candidate.reads.some((read) => read.path === "helper.js" && read.status === "unresolved" && read.required))
    assert(!candidate.files.some((file) => file.text.includes("BASE_HELPER")))
    const baseContext = (plan as typeof plan & { baseContexts?: Array<typeof candidate> }).baseContexts?.[0]
    assert(baseContext?.files.some((file) => file.path === "helper.ts" && file.text.includes("BASE_HELPER")))
    assert.equal(
      assessSemantic(
        plan.comparison,
        { verdict: "pass", summary: "Fine", examinedPaths: plan.comparison.paths, findings: [] },
        candidate,
        baseContext
      ).status,
      "error"
    )
    const unavailable = join(fixture.temporary, "missing-base-exporter")
    await writeFile(
      unavailable,
      `#!/bin/sh\nif [ "$2" = "${fixture.base}" ]; then exit 1; fi\nexec '${exporter!.replaceAll("'", "'\\''")}' "$@"\n`
    )
    await chmod(unavailable, 0o700)
    await assert.rejects(
      fixture.capture({ ...fixture.options, exporterPath: unavailable }),
      /selected source commit is unavailable/
    )
    await writeFile(
      unavailable,
      `#!/bin/sh\nif [ "$2" = "${fixture.base}" ]; then exec '${
        exporter!.replaceAll("'", "'\\''")
      }' "$1" '${fixture.work.evidence.source.commitId}' "$3"; fi\nexec '${exporter!.replaceAll("'", "'\\''")}' "$@"\n`
    )
    await assert.rejects(
      fixture.capture({ ...fixture.options, exporterPath: unavailable }),
      /another source or path/,
      "An exporter returning candidate bytes for the base cannot establish history"
    )
  }
)

test("base and candidate supporting reads both refuse held-out aliases", deletedNative, async (t) => {
  const fixture = await deletedFixture(t, "export const record = () => 'CANDIDATE_HELPER';\n", true)
  const plan = await fixture.capture(), context = plan.contexts[0]!, baseContext = plan.baseContexts![0]!
  for (const side of [context, baseContext]) {
    assert(side.reads.some((read) => read.path === "private-alias.ts" && read.status === "refused" && read.required))
    assert(!side.files.some((file) => file.path === "private-alias.ts"))
  }
  assert(!JSON.stringify(plan).includes("HELD_OUT_BASE_AND_CANDIDATE"))
  assert.equal(
    assessSemantic(
      plan.comparison,
      { verdict: "pass", summary: "Fine", examinedPaths: plan.comparison.paths, findings: [] },
      context,
      baseContext
    ).status,
    "error"
  )
})
