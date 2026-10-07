// The reference-host job-started hook admits only main's reference-host
// workflow on push or workflow_dispatch, and wipes what a previous job left
// behind before it admits anything (#3471). The free plan has no runner
// groups, so this hook is the only control that keeps a fork pull request's
// own workflow file off the self-hosted runner.
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { after, test } from "node:test"

const hook = resolve(import.meta.dirname, "job-started.sh")
const scratch = realpathSync(mkdtempSync(join(tmpdir(), "reference-host-hook-")))
after(() => rmSync(scratch, { recursive: true, force: true }))

const workflowRef = "smithersai/smithers/.github/workflows/reference-host.yml@refs/heads/main"
const admitted = {
  GITHUB_REPOSITORY: "smithersai/smithers",
  GITHUB_EVENT_NAME: "workflow_dispatch",
  GITHUB_REF: "refs/heads/main",
  GITHUB_WORKFLOW_REF: workflowRef,
  GITHUB_SHA: "0123456789abcdef0123456789abcdef01234567"
}

let fixtures = 0
/** A runner layout with leftovers from a previous job in every wiped place. */
const layout = () => {
  const root = join(scratch, String(fixtures++))
  const work = join(root, "actions-runner", "_work")
  const paths = {
    root,
    work,
    runnerWorkspace: join(work, "smithers"),
    workspace: join(work, "smithers", "smithers"),
    home: join(root, "home"),
    tmp: join(root, "tmp")
  }
  for (const dir of [
    join(work, "_actions", "actions", "checkout"),
    join(work, "_temp", "_github_workflow"),
    join(work, "_tool", "node"),
    join(work, "other-repo", "other-repo"),
    paths.workspace,
    join(paths.home, "Library", "Caches", "bun"),
    join(paths.home, "Library", "Preferences"),
    paths.tmp
  ]) mkdirSync(dir, { recursive: true })
  writeFileSync(join(work, "_actions", "actions", "checkout", "action.yml"), "current job\n")
  writeFileSync(join(work, "_temp", "_github_workflow", "event.json"), "{}\n")
  writeFileSync(join(work, "stale-top-level"), "left by the previous job\n")
  writeFileSync(join(paths.runnerWorkspace, "stale-sibling"), "left by the previous job\n")
  writeFileSync(join(paths.workspace, "stale-checkout-file"), "left by the previous job\n")
  writeFileSync(join(paths.workspace, ".hidden-stale"), "left by the previous job\n")
  writeFileSync(join(paths.home, "Library", "Caches", "bun", "poisoned"), "left by the previous job\n")
  writeFileSync(join(paths.home, "Library", "Preferences", "kept.plist"), "kept\n")
  writeFileSync(join(paths.tmp, "stale-tmp"), "left by the previous job\n")
  return paths
}

const run = (env, paths = layout()) => {
  const result = spawnSync("sh", [hook], {
    encoding: "utf8",
    timeout: 15_000,
    env: {
      PATH: process.env.PATH,
      HOME: paths.home,
      TMPDIR: paths.tmp,
      RUNNER_WORKSPACE: paths.runnerWorkspace,
      GITHUB_WORKSPACE: paths.workspace,
      REFERENCE_HOST_HOOK_FIXTURE: "1",
      ...env
    }
  })
  assert.equal(result.error, undefined)
  return { ...result, paths }
}

/** True when nothing a previous job left behind was removed. */
const untouched = (paths) =>
  existsSync(join(paths.work, "stale-top-level")) &&
  existsSync(join(paths.workspace, "stale-checkout-file")) &&
  existsSync(join(paths.home, "Library", "Caches", "bun", "poisoned"))

test("admits main's reference-host workflow on workflow_dispatch and on push", () => {
  for (const event of ["workflow_dispatch", "push"]) {
    const result = run({ ...admitted, GITHUB_EVENT_NAME: event })
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, new RegExp(`admitted ${workflowRef.replaceAll(".", "\\.")} \\(${event},`))
  }
})

const refusals = [
  ["a fork pull request's own workflow", {
    GITHUB_REPOSITORY: "smithersai/smithers",
    GITHUB_EVENT_NAME: "pull_request",
    GITHUB_REF: "refs/pull/4242/merge",
    GITHUB_HEAD_REF: "attacker:main",
    GITHUB_WORKFLOW_REF: "smithersai/smithers/.github/workflows/evil.yml@refs/pull/4242/merge"
  }, /GITHUB_EVENT_NAME is 'pull_request'/],
  ["a fork pull request that copies reference-host.yml", {
    ...admitted,
    GITHUB_EVENT_NAME: "pull_request",
    GITHUB_REF: "refs/pull/4242/merge",
    GITHUB_HEAD_REF: "main",
    GITHUB_WORKFLOW_REF: "smithersai/smithers/.github/workflows/reference-host.yml@refs/pull/4242/merge"
  }, /GITHUB_EVENT_NAME is 'pull_request'/],
  ["pull_request_target", { ...admitted, GITHUB_EVENT_NAME: "pull_request_target" }, /GITHUB_EVENT_NAME is 'pull_request_target'/],
  ["workflow_run", { ...admitted, GITHUB_EVENT_NAME: "workflow_run" }, /GITHUB_EVENT_NAME is 'workflow_run'/],
  ["a missing event name", { ...admitted, GITHUB_EVENT_NAME: undefined }, /GITHUB_EVENT_NAME is ''/],
  ["another repository (a fork running its own copy)", { ...admitted, GITHUB_REPOSITORY: "attacker/smithers" }, /GITHUB_REPOSITORY is 'attacker\/smithers'/],
  ["a missing repository", { ...admitted, GITHUB_REPOSITORY: undefined }, /GITHUB_REPOSITORY is ''/],
  ["a push to another branch", { ...admitted, GITHUB_EVENT_NAME: "push", GITHUB_REF: "refs/heads/feature" }, /GITHUB_REF is 'refs\/heads\/feature'/],
  ["a tag", { ...admitted, GITHUB_EVENT_NAME: "push", GITHUB_REF: "refs/tags/v1.0.0" }, /GITHUB_REF is 'refs\/tags\/v1\.0\.0'/],
  ["another workflow file on main", {
    ...admitted,
    GITHUB_WORKFLOW_REF: "smithersai/smithers/.github/workflows/ci.yml@refs/heads/main"
  }, /GITHUB_WORKFLOW_REF is '.*ci\.yml@refs\/heads\/main'/],
  ["reference-host.yml from a branch that only starts with main", {
    ...admitted,
    GITHUB_WORKFLOW_REF: `${workflowRef}-x`
  }, /GITHUB_WORKFLOW_REF is '.*@refs\/heads\/main-x'/],
  ["reference-host.yml from another branch", {
    ...admitted,
    GITHUB_WORKFLOW_REF: "smithersai/smithers/.github/workflows/reference-host.yml@refs/heads/feature"
  }, /GITHUB_WORKFLOW_REF is '.*@refs\/heads\/feature'/],
  ["a reusable-workflow ref from another repository", {
    ...admitted,
    GITHUB_WORKFLOW_REF: `attacker/smithers/.github/workflows/reference-host.yml@refs/heads/main`
  }, /GITHUB_WORKFLOW_REF is 'attacker\//],
  ["a missing workflow ref", { ...admitted, GITHUB_WORKFLOW_REF: undefined }, /GITHUB_WORKFLOW_REF is ''/],
  ["a pull-request head ref on an otherwise admitted job", { ...admitted, GITHUB_HEAD_REF: "feature" }, /GITHUB_HEAD_REF is 'feature'/]
]

for (const [name, env, reason] of refusals) {
  test(`refuses ${name} and wipes nothing`, () => {
    const defined = Object.fromEntries(Object.entries(env).filter(([, value]) => value !== undefined))
    const result = run(defined)
    assert.equal(result.status, 1, `expected refusal, got ${result.status}: ${result.stdout}`)
    assert.match(result.stderr, reason)
    assert.match(result.stderr, /reference-host guard: refused:/)
    assert.doesNotMatch(result.stdout, /admitted/)
    assert.ok(untouched(result.paths), "a refused job must not reach the wipe")
  })
}

test("wipes the previous job's work, temp and caches but keeps this job's runner state", () => {
  const { status, stderr, stdout, paths } = run(admitted)
  assert.equal(status, 0, stderr)
  assert.deepEqual(readdirSync(paths.work).sort(), ["_actions", "_temp", "smithers"])
  assert.deepEqual(readdirSync(paths.runnerWorkspace), ["smithers"])
  assert.deepEqual(readdirSync(paths.workspace), [], "the checkout directory stays, emptied")
  assert.ok(existsSync(join(paths.work, "_actions", "actions", "checkout", "action.yml")))
  assert.ok(existsSync(join(paths.work, "_temp", "_github_workflow", "event.json")))
  assert.deepEqual(readdirSync(join(paths.home, "Library", "Caches")), [])
  assert.ok(existsSync(join(paths.home, "Library", "Preferences", "kept.plist")))
  assert.deepEqual(readdirSync(paths.tmp), [])
  assert.match(stdout, /removed .*stale-top-level/)
  assert.match(stdout, /removed .*_tool/)
  assert.match(stdout, /removed .*other-repo/)
  assert.match(stdout, /removed .*\.hidden-stale/)
  assert.match(stdout, /fixture mode, so no processes killed/)
})

test("outside fixture mode wipes nothing unless it runs as ghrunner", (t) => {
  // Without this gate a developer running the hook would lose their own
  // TMPDIR, caches and processes.
  if (spawnSync("id", ["-un"], { encoding: "utf8" }).stdout.trim() === "ghrunner") return t.skip("running as ghrunner")
  const result = run({ ...admitted, REFERENCE_HOST_HOOK_FIXTURE: undefined })
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /not ghrunner, so nothing wiped/)
  assert.ok(untouched(result.paths))
  assert.ok(existsSync(join(result.paths.tmp, "stale-tmp")))
})

test("is idempotent on an already clean layout", () => {
  const paths = layout()
  assert.equal(run(admitted, paths).status, 0)
  const second = run(admitted, paths)
  assert.equal(second.status, 0, second.stderr)
  assert.doesNotMatch(second.stdout, /removed/)
})
