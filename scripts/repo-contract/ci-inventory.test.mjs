import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { once } from "node:events"
import { createPlanner, requestPlan } from "../ci-planner.mjs"
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, dirname, join } from "node:path"
import { test } from "node:test"
import { planned, plannedInProcess, resolveInventory, root, runnerFor, targetInvocation } from "../ci-inventory.mjs"
import { openPackageIndex } from "@smthrs/build-cli/Cli"
import * as Target from "@smthrs/targets/Target"
import * as Exec from "@smthrs/targets/Exec"
import { parseWorkflow } from "../release-rehearsal.mjs"
import * as PackageExec from "@smthrs/build-cli/PackageExec"

test("CI command discovery retains diagnostic options and refuses unknown selection syntax", () => {
  for (const options of ["--jobs 2 --verbose", "--verbose --jobs 2"]) {
    assert.deepEqual(targetInvocation(`pnpm exec smthrs ci '//packages/...' ${options}`), {
      verb: "ci", pattern: "//packages/...", jobs: 2, verbose: true
    })
  }
  assert.deepEqual(targetInvocation("pnpm exec smthrs build '//apps/app:check' --verbose"), {
    verb: "build", pattern: "//apps/app:check", jobs: undefined, verbose: true
  })
  assert.deepEqual(targetInvocation("pnpm exec smthrs ci '//apps/...' --known-red '.github/ci-known-red.json' --verbose"), {
    verb: "ci", pattern: "//apps/...", jobs: undefined, knownRed: ".github/ci-known-red.json", verbose: true
  })
  assert.equal(targetInvocation("node scripts/generate-ci.mjs"), undefined)
  for (const options of ["--include-exclusive", "--jobs", "--jobs 0", "--jobs 2 --jobs 3", "--plan", "--known-red", "--known-red list.json"])
    assert.throws(() => targetInvocation(`pnpm exec smthrs test '//packages/...' ${options}`), /Unrecognized CI target/)
  assert.throws(() => targetInvocation("pnpm exec smthrs test //packages/..."), /Unrecognized CI target/)
})

test("UI typecheck plans strict devkit preparation as an uncached prerequisite", async () => {
  const plan = planned("build", "//apps/app:check")
  assert.deepEqual(plan.roots, ["//apps/app:check"])
  const check = plan.targets.find((target) => target.label === "//apps/app:check")
  const devkit = plan.targets.find((target) => target.label === "//apps/app:devkit")
  assert.ok(check)
  assert.ok(devkit, "a clean checkout has no ignored devkit for TypeScript to extend")
  assert.ok(check.dependencies.includes(devkit.label))
  assert.equal(devkit.rule, "NodeBinary")
  assert.equal(devkit.cacheable, false, "a previous result cannot restore the SDK projection")
  assert.equal(check.cacheable, false)
  const index = await openPackageIndex({ workspace: root })
  const declaration = index.targets().find((target) => target.label === devkit.label)
  assert.ok(declaration)
  assert.deepEqual(runnerFor(Target.metadata(declaration.target), index.workspace, "build"), [
    "node", "scripts/ensure-devkit.mjs"
  ], "the CI prerequisite must use Node and strict preparation, without --soft")
})

test("CI inventory plans without building packages or the site", async () => {
  const plan = planned("test", "//scripts/repo-contract:ciInventory")
  assert.deepEqual(plan.roots, ["//scripts/repo-contract:ciInventory"])
  assert.deepEqual(plan.targets.map((target) => target.label), plan.roots)
  assert.equal(plan.targets[0].cacheable, false, "inventory always executes fresh planner checks")
  assert.deepEqual(await plannedInProcess("test", "//scripts/repo-contract:ciInventory"), plan,
    "the serial CLI host emits the same complete plan as the source executable")
  const planner = createPlanner()
  try {
    for (let selection = 0; selection < 2; selection++)
      assert.deepEqual(await planner.plan("test", "//scripts/repo-contract:ciInventory", root), plan,
        "the supervised persistent child emits the same complete plan on reuse")
  } finally { await planner.close() }
})

test("CI planning hard-kills a child that ignores SIGTERM and blocks synchronously", async (t) => {
  const child = spawn(process.execPath, ["--input-type=module", "--eval", `
    process.on("SIGTERM", () => process.send("ignored", () => {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0)
    }))
    process.on("message", () => {
      process.send("planning")
    })
    process.send("ready")
  `], { stdio: ["ignore", "ignore", "inherit", "ipc"] })
  t.after(async () => {
    if (child.exitCode !== null || child.signalCode !== null) return
    const exited = once(child, "exit")
    child.kill("SIGKILL")
    await exited
  })
  assert.equal((await once(child, "message"))[0], "ready")
  const timers = new Map()
  const result = requestPlan(child, { verb: "test", pattern: "//:stubborn" }, {
    setTimer: (callback, ms) => { timers.set(ms, callback); return ms },
    clearTimer: (timer) => { timers.delete(timer) }
  })
  const rejected = assert.rejects(result, /Planning test \/\/:stubborn timed out after 120000ms/)
  assert.equal((await once(child, "message"))[0], "planning")
  const ignored = once(child, "message")
  timers.get(120_000)()
  assert.equal((await ignored)[0], "ignored", "SIGTERM reaches the real child first")
  assert.ok(timers.has(1_000), "a separate grace timer must enforce SIGKILL")
  const exited = once(child, "exit")
  timers.get(1_000)()
  assert.deepEqual(await exited, [null, "SIGKILL"])
  await rejected
  assert.equal(timers.size, 0, "completion releases both timers")
})

test("CI planning cancels the hard deadline after cooperative SIGTERM completion", async (t) => {
  const child = spawn(process.execPath, ["--input-type=module", "--eval", `
    process.on("SIGTERM", () => process.send({ type: "plan", value: null }))
    process.on("message", () => process.send("planning"))
    process.send("ready")
  `], { stdio: ["ignore", "ignore", "inherit", "ipc"] })
  t.after(async () => {
    if (child.exitCode !== null || child.signalCode !== null) return
    const exited = once(child, "exit")
    child.kill("SIGKILL")
    await exited
  })
  assert.equal((await once(child, "message"))[0], "ready")
  const timers = new Map()
  const result = requestPlan(child, { verb: "lint", pattern: "//:cooperative" }, {
    setTimer: (callback, ms) => { timers.set(ms, callback); return ms },
    clearTimer: (timer) => { timers.delete(timer) }
  })
  const rejected = assert.rejects(result, /timed out after 120000ms/)
  assert.equal((await once(child, "message"))[0], "planning")
  timers.get(120_000)()
  await rejected
  assert.equal(timers.size, 0, "cooperative completion clears the grace timer")
  assert.equal(child.signalCode, null, "cooperative completion does not need SIGKILL")
})

test("release smoke retains packing, fresh execution and its measured Exec deadline", async () => {
  const index = await openPackageIndex({ workspace: root })
  const plan = await PackageExec.plan({
    index, verb: "test", patterns: ["//scripts:releaseSmoke"], cacheDirectory: index.workspace.cache.directory
  })
  const smoke = plan.nodes.get("//scripts:releaseSmoke")
  assert.ok(smoke)
  const declaration = index.targets().find((target) => target.label === smoke.label)
  assert.ok(declaration)
  const call = Target.plan(declaration.target, smoke.attrs).ast
  assert.equal(call._tag, "ActionCall", "the smoke plans its actual Exec invocation")
  assert.equal(call.action, "smithers-build/exec")
  assert.equal(Exec.Payload.make(call.payload).timeoutMs, 1_800_000,
    "the inner Exec must receive the declared 30m bound, not its 10m default")
  assert.equal(smoke.timeoutMs, 1_800_000, "the outer executor must honor the 30m deadline too")
  assert.equal(smoke.cacheable, false, "a successful receipt never substitutes for a fresh smoke")
  assert.ok(smoke.dependencies.includes("//scripts:releasePack"), "source qualification still rebuilds candidate bytes")
})

/**
 * Where the resolved inventory is written: the operator's SMITHERS_CI_INVENTORY,
 * else a file in a fresh private directory. A predictable name under a shared
 * tmpdir() lets another local user pre-plant a symlink the write follows.
 * The default directory is removed once every assertion passes and kept on a
 * failure, so the logged path is there to read when it matters.
 */
const inventoryArtifact = (environment = process.env) =>
  environment.SMITHERS_CI_INVENTORY ?? join(mkdtempSync(join(tmpdir(), "smithers-ci-inventory-")), "inventory.json")

test("the default inventory artifact lives in a fresh private directory", () => {
  const first = inventoryArtifact({})
  const second = inventoryArtifact({})
  try {
    assert.notEqual(dirname(first), dirname(second))
    assert.ok(!existsSync(first), "the artifact path is new, so nothing pre-planted sits there")
    if (process.platform !== "win32") assert.equal(statSync(dirname(first)).mode & 0o777, 0o700)
    assert.equal(inventoryArtifact({ SMITHERS_CI_INVENTORY: "chosen.json" }), "chosen.json")
  } finally {
    rmSync(dirname(first), { recursive: true, force: true })
    rmSync(dirname(second), { recursive: true, force: true })
  }
})

test("required CI resolves package, app, script, evaluation and fault suites to real runners", async () => {
  const inventory = await resolveInventory()
  const artifact = inventoryArtifact()
  writeFileSync(artifact, `${JSON.stringify(inventory, null, 2)}\n`)
  console.log(`Resolved CI inventory: ${artifact}`)
  assert.deepEqual(inventory.selectionErrors, [], "every required command must successfully plan")
  const selected = (label, job) => inventory.rows.filter((row) => row.label === label && row.job === job && row.required && row.selectedRoot)
  for (const [label, job] of [
    ["//apps/app:check", "apps-e2e"], ["//apps/app:unitTests", "apps-e2e"], ["//apps/app:browserE2e", "apps-e2e"],
    ["//apps/tui:check", "apps-e2e"], ["//apps/tui:unitTests", "apps-e2e"], ["//apps/tui:e2eTests", "apps-e2e"],
    ["//apps/server:check", "repository"], ["//apps/server:unitTests", "repository"],
    ["//apps/review:unitTests", "repository"], ["//apps/bug-worker:unitTests", "repository"],
    ["//apps/review:check", "repository"], ["//apps/review:checkTests", "repository"],
    ["//apps/bug-worker:check", "repository"],
    ["//evals/agent:test", "repository"], ["//evals/authoring:test", "repository"],
    ["//evals/agent:check", "repository"], ["//evals/authoring:check", "repository"], ["//evals/swebench:check", "repository"],
    ["//evals/review-seeded-bugs:suite", "repository"], ["//evals/review-seeded-bugs:test", "repository"],
    ["//evals/review-seeded-bugs:check", "repository"],
    ["//evals/recommend:suite", "repository"], ["//evals/recommend:test", "repository"], ["//evals/recommend:check", "repository"],
    ["//scripts/repo-contract:ciInventory", "scripts"], ["//scripts:mutationGate", "scripts"], ["//scripts:benchmarkGate", "scripts"],
    ["//scripts:tierContracts", "scripts"],
    ["//scripts:webBundleContract", "browser"],
    ["//packages/smithers/gateway:test", "test"], ["//packages/smithers/flows/jj:test", "packages"]
  ]) assert.ok(selected(label, job).length, `${label} must be a required root of ${job}`)
  const inventoryRunner = selected("//scripts/repo-contract:ciInventory", "scripts")[0].runner
  assert.equal(basename(inventoryRunner[0]), "node")
  assert.deepEqual(inventoryRunner.slice(1), ["--test", "scripts/repo-contract/ci-inventory.test.mjs"])
  const uiUnits = inventory.rows.filter((row) => row.label === "//apps/app:unitTests" && row.required && row.selectedRoot)
  assert.equal(uiUnits.length, 1, "the UI unit tier runs once in required CI")
  assert.deepEqual(uiUnits[0].runner, ["bun", "test", "src", "e2e/contracts", "e2e/real/coverage", "e2e/real/support", "e2e/real/auth-permissions/profile.test.ts", "scripts"])
  const packageTests = inventory.rows.filter((row) => row.job === "packages" && row.required && row.selectedRoot)
  assert.ok(packageTests.length > 100, "the complete package test graph must resolve")
  for (const row of packageTests) assert.ok(selected(row.label, "test").length, `${row.label} must also be selected by ci //packages/...`)
  const faults = inventory.rows.filter((row) => row.job === "e2e-faults" && row.selectedRoot)
  assert.ok(faults.length >= 3)
  for (const row of faults) {
    assert.equal(row.rule, "Vitest")
    assert.ok(row.runner.includes("vitest.faults.config.ts"), row.label)
    assert.ok(row.inputs.some((input) => input.pattern?.includes("test/faults/")), row.label)
  }
  const native = selected("//crates/flows-jj:cargoTest", "rust")
  assert.equal(native.length, 1)
  assert.equal(basename(native[0].runner[0]), "cargo")
  assert.deepEqual(native[0].runner.slice(1), ["test", "-p", "flows-jj", "--locked"])
  assert.equal(native[0].cwd, ".")
  assert.ok(native[0].inputs.some((input) => input.path === "//Cargo.lock"))
  const nodeRelease = readFileSync(join(root, ".node-version"), "utf8").trim()
  const jobs = workflowJobs(".github/workflows/ci.yml")
  for (const row of inventory.rows) {
    if (jobs[row.job].steps.some((step) => step.with?.["node-version-file"] === ".node-version"))
      assert.ok(row.runtimes.includes(`Node ${nodeRelease}`), row.job + " must report the pinned Node release")
    const name = row.label.split(":").at(-1)
    if (/^browser|^e2e|faults$/i.test(name)) {
      assert.ok(name === "browserE2e" || name === "faults" || row.label === "//apps/tui:e2eTests",
        `${row.label}: classify and verify this suite's E2E runner`)
    }
    if (/unitTests$/.test(row.label)) {
      // One required UI job owns the app's three tiers and the TUI suite; each
      // unit step must still name and execute a unit runner, never claim
      // browser coverage.
      assert.doesNotMatch(row.step, /e2e|end.to.end/i)
      if (row.job === "apps-e2e") assert.ok(["//apps/app:unitTests", "//apps/tui:unitTests"].includes(row.label), row.label)
    }
    if (/browserE2e$/.test(row.label)) {
      assert.equal(row.rule, "NodeTest")
      assert.ok(row.runner.includes("scripts/run-pr-e2e.mjs"))
      const entry = readFileSync(join(root, row.cwd, "scripts/run-pr-e2e.mjs"), "utf8")
      assert.match(entry, /\["exec", "playwright", "test"\]/)
    }
    if (row.label === "//apps/tui:e2eTests") {
      // The terminal tier types raw keys into the production entry inside a private tmux server.
      assert.equal(row.rule, "NodeTest")
      assert.deepEqual(row.runner, ["bun", "test", "./e2e"])
      const driver = readFileSync(join(root, row.cwd, "e2e/tmux.ts"), "utf8")
      assert.match(driver, /process\.env\.TMUX_BIN \?\? "tmux"/)
      assert.match(driver, /spawnSync\(binary\(\), \["-S", this\.socket/)
      assert.match(readFileSync(join(root, row.cwd, "e2e/tui.test.ts"), "utf8"),
        /Tui\.start\(\{[^}]*command: `bun \$\{join\(app, "src", "main\.tsx"\)\}/)
    }
    // Ambient helper/fixture/config/dependency/runtime/seed inputs are safe only
    // while the general NodeTest/Vitest runners always execute fresh work.
    if (["NodeTest", "Vitest"].includes(row.rule)) assert.equal(row.cacheable, false, `${row.label}: review all effective inputs before enabling result reuse`)
  }
  for (const app of ["server", "app", "review", "bug-worker"]) {
    assert.match(readFileSync(join(root, `apps/${app}/PACKAGE.ts`), "utf8"), /Coverage policy: assertion-only/)
  }
  if (process.env.SMITHERS_CI_INVENTORY === undefined) rmSync(dirname(artifact), { recursive: true, force: true })
})

test("public project copy keeps the support contract out of the short description", () => {
  const description = "Smithers maintains your codebase. It turns issues into reviewed, tested changes and, when enabled, keeps the project wiki current. Flows beside your code define how."
  const project = JSON.parse(readFileSync(join(root, "apps/site/src/data/project.json"), "utf8"))
  const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"))
  assert.equal(project.description, description)
  assert.equal(manifest.description, description)
  assert.deepEqual(project.support, {
    summary: "The release candidate's required platform is Linux with Node 26.4.0."
  })
  const readme = readFileSync(join(root, "README.md"), "utf8")
  const docs = readFileSync(join(root, "apps/site/src/content/docs/docs/index.mdx"), "utf8")
  assert.ok(readme.includes(`\n\n${description}\n\n`))
  assert.doesNotMatch(readme, /\u2014/)
  assert.equal(JSON.parse(docs.match(/^description: (.*)$/m)?.[1] ?? "null"), description)
  assert.equal(docs.match(/generated:project-description start[^\n]*\n\n([\s\S]*?)\n\n\{\/\* generated:project-description end/)?.[1], description)
  const readmeSupport = readme.match(/(?:^|\n)## Supported platforms\n\n([\s\S]*?)(?=\n## |$)/)?.[1]
  const developers = readFileSync(join(root, "apps/site/src/content/docs/docs/developers.mdx"), "utf8")
  const docsSupport = developers.match(/generated:project-support start[^\n]*\n\n## Supported platforms\n\n([\s\S]*?)\n\n\{\/\* generated:project-support end/)?.[1]
  for (const [name, support] of [["README", readmeSupport], ["developer overview", docsSupport]]) {
    assert.equal(typeof support, "string", `${name} must have a dedicated support section`)
    assert.match(support, /required platform is Linux with Node 26\.4\.0/)
    assert.match(support, /\[support matrix\]\((https:\/\/smithers\.sh)?\/docs\/reference\/support-matrix\/\)/)
  }
})

// Read workflow semantics through the same YAML parser as release rehearsal.
// Generated CI quotes keys and values; the hand-written release workflow need not.
const workflowJobs = (workflow) => {
  const { jobs } = parseWorkflow(readFileSync(join(root, workflow), "utf8"))
  assert.ok(jobs && Object.keys(jobs).length > 0, workflow + " must declare jobs")
  return jobs
}

test("every CI job and the release publish job bound their runtime below GitHub's six-hour default", () => {
  const jobs = [...Object.entries(workflowJobs(".github/workflows/ci.yml")),
    ["release.publish", workflowJobs(".github/workflows/release.yml").publish]]
  for (const [id, job] of jobs) {
    const timeout = job["timeout-minutes"]
    assert.ok(Number.isInteger(timeout) && timeout > 0 && timeout < 360,
      id + " must declare a positive timeout-minutes below the six-hour default")
  }
})

test("jobs that install the workspace restore the pnpm store", () => {
  for (const [id, job] of Object.entries(workflowJobs(".github/workflows/ci.yml"))) {
    if (job.steps.some((step) => step.run?.includes("pnpm install --frozen-lockfile"))) {
      const setup = job.steps.find((step) => step.uses?.startsWith("actions/setup-node@"))
      assert.ok(setup, id + " must set up Node before installing the workspace")
      assert.equal(setup.with?.["node-version-file"], ".node-version", id + " must use the pinned Node release")
      assert.equal(setup.with?.cache, "pnpm", id + " installs the workspace from a cold store")
    }
  }
})

test("the root TypeScript project owns declarations, not package source or fixtures", () => {
  const { include } = JSON.parse(readFileSync(join(root, "tsconfig.json"), "utf8"))
  for (const entry of ["scripts/*/PACKAGE.ts", "flows/PACKAGE.ts", "examples/PACKAGE.ts", "apps/docs/*/PACKAGE.ts",
    "packages/*/PACKAGE.ts", "packages/*/*/PACKAGE.ts", "packages/*/*/*/PACKAGE.ts"])
    assert.ok(include.includes(entry), `tsconfig.json include omits ${entry}`)
  assert.ok(include.every((entry) => !entry.includes("/src/") && !entry.includes("/test/") && !entry.includes("/examples/")),
    "package source, test fixtures, and examples must use their owning TypeScript projects")
})

