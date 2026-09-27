import { NodeServices } from "@effect/platform-node"
import * as DurableEngineState from "@smthrs/engine-store/DurableEngineState"
import { Action, HumanTask } from "@smthrs/flow"
import * as DurableDeferred from "@smthrs/flow/DurableDeferred"
import * as NodeRuntime from "@smthrs/flows/NodeRuntime"
import * as Evaluator from "@smthrs/model/Evaluator"
import { Effect, FileSystem, Layer, Option, Schema } from "effect"
import { ChildProcessSpawner } from "effect/unstable/process"
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { test, type TestContext } from "node:test"
import { CodingError } from "../coding/schema.ts"
import { cleanup } from "../register-repository/cleanup.ts"
import Register, { APPROVE, DECLINE, DECLINE_NOTE, REVIEW } from "../register-repository/flow.ts"
import {
  agentShare,
  agentTrace,
  churn,
  commitGraph,
  contributors,
  DAY,
  LOG_FORMAT,
  mergedPulls,
  parseLog
} from "../register-repository/history.ts"
import { registration } from "../register-repository/host.ts"
import { canonicalRepo } from "../register-repository/link.ts"
import {
  affectedPackages,
  ciEstimate,
  ciMinutes,
  intake,
  parsePulls,
  workspacePackages
} from "../register-repository/pulls.ts"
import { namesCommand, readiness } from "../register-repository/readiness.ts"
import type { Outcome } from "../register-repository/schema.ts"
import { checkCommands, checkRunners, licenseCandidates, type Tree } from "../register-repository/tree.ts"
import { githubReadable, RepositoryRemote } from "../repository/remote.ts"

test("a freeform link becomes one canonical owner/repo, and anything else is refused", () => {
  for (
    const link of [
      "https://github.com/Acme/Widgets",
      "github.com/acme/widgets.git",
      "git@github.com:acme/widgets.git",
      "ssh://git@github.com/acme/widgets",
      "https://github.com/acme/widgets/tree/main/src?x=1",
      "  acme/widgets  "
    ]
  ) assert.equal(canonicalRepo(link), "acme/widgets", link)
  for (const link of ["", "acme", "https://gitlab.com/acme/widgets", "acme/../x", "a b/c", "https://github.com/acme"]) {
    assert.equal(canonicalRepo(link), undefined, link)
  }
})

const NOW = Date.UTC(2026, 8, 1) / 1000
const log = (
  entries: ReadonlyArray<
    { subject: string; email?: string; name?: string; age: number; trailer?: string; files?: string }
  >
) =>
  entries.map((entry, index) =>
    `\x1e${index.toString(16).padStart(40, "0")}\x1f${entry.email ?? "a@x.dev"}\x1f${entry.name ?? "A"}\x1f${
      NOW - entry.age * DAY
    }\x1f${entry.subject}\x1f${entry.trailer ?? ""}\n\n${entry.files ?? "3\t1\tsrc/a.ts"}\n`
  ).join("")

test("history traces agent commits by trailer, agent author and branch, never by guessing", () => {
  const commits = parseLog(log([
    { subject: "feat: one", age: 1, trailer: "Claude <noreply@anthropic.com>" },
    { subject: "Merge pull request #7 from bob/codex/fix-x", age: 2 },
    {
      subject: "fix: two",
      age: 3,
      name: "copilot-swe-agent[bot]",
      email: "198982749+copilot@users.noreply.github.com"
    },
    { subject: "chore: bump", age: 4, name: "dependabot[bot]", email: "dependabot[bot]@users.noreply.github.com" },
    { subject: "plain (#12)", age: 5, email: "b@x.dev" },
    { subject: "old", age: 400 }
  ]))
  assert.equal(commits.length, 6)
  assert.deepEqual(commits.map(agentTrace), [
    "co-author trailer",
    "agent branch",
    "agent author",
    undefined,
    undefined,
    undefined
  ])
  const share = agentShare(commits, NOW, ["AGENTS.md", ".cursor/rules.md", "src/a.ts"])
  assert.equal(share.commits, 5, "only the last twelve months count")
  assert.equal(share.traced, 3)
  assert.deepEqual(share.markers.slice(-2), ["AGENTS.md", ".cursor"])
  const graph = commitGraph(commits, NOW)
  assert.equal(graph.weeks.length, 12)
  assert.equal(graph.weeks.at(-1)!.agents, 3)
  assert.equal(graph.weeks.at(-1)!.people, 2)
  const people = contributors(commits, NOW)
  assert.equal(people.total, 2, "bots are not contributors")
  assert.deepEqual(people.shares, [2, 1])
  assert.equal(people.core, 1)
  assert.deepEqual(mergedPulls(commits), [7, 12])
})

test("GitHub reads are limited to the paths registration uses, and AGENTS.md must name a working command", () => {
  for (
    const path of [
      "/pulls?state=all&per_page=50",
      "/pulls/12/reviews?per_page=10",
      "/pulls/3/files?per_page=100",
      "/actions/runs?event=pull_request&status=success&per_page=30"
    ]
  ) {
    assert.ok(githubReadable(path), path)
  }
  for (
    const path of [
      "/issues",
      "/pulls/%2e%2e/x",
      "/pulls/../../user",
      "/contents/.env",
      "/pulls?x=%2f",
      "/pulls/1/merge"
    ]
  ) {
    assert.ok(!githubReadable(path), path)
  }
  assert.ok(namesCommand("Run `npm test` first.", "npm run test"))
  assert.ok(namesCommand("cargo test", "cargo test --quiet"))
  assert.ok(!namesCommand("Use the latest release.", "npm run test"))
  assert.ok(!namesCommand("Run `go vet`.", "go test ./..."))
})

test("churn counts lines deleted within two weeks of being added", () => {
  const commits = parseLog(log([
    { subject: "rewrite", age: 10, files: "0\t40\tsrc/a.ts" },
    { subject: "add", age: 15, files: "100\t0\tsrc/a.ts" },
    { subject: "late delete", age: 40, files: "0\t50\tsrc/b.ts" },
    { subject: "add b", age: 60, files: "100\t0\tsrc/b.ts" }
  ]))
  assert.equal(churn(commits, NOW), 40 / 200)
})

const tree = (files: Record<string, string>, extra: ReadonlyArray<string> = []): Tree => ({
  paths: [...Object.keys(files), ...extra],
  files: Object.entries(files).map(([path, text]) => ({ path, text }))
})

test("license, checks and commands are detected from the tree's own files", () => {
  const t = tree({
    LICENSE: "MIT License\n\nPermission is hereby granted, free of charge, to any person",
    "package.json": JSON.stringify({
      license: "Apache-2.0",
      scripts: { test: "vitest", lint: "eslint .", build: "tsc" }
    }),
    "pnpm-lock.yaml": "",
    Makefile: "test:\n\tgo test ./...\n",
    ".github/workflows/ci.yml": "on: [pull_request]\njobs: {}"
  })
  assert.deepEqual(licenseCandidates(t).map((entry) => entry.spdx), ["MIT", "Apache-2.0"])
  assert.deepEqual(checkRunners(t).map((entry) => entry.runner), ["GitHub Actions", "Makefile", "Scripts"])
  assert.deepEqual(checkCommands(t).map((command) => command.argv.join(" ")), [
    "pnpm run test",
    "pnpm run lint",
    "pnpm run build"
  ])
})

test("readiness counts what ran, leaves out what the sandbox could not start, and names three fixes", () => {
  const t = tree({ "README.md": "# X\n\n```sh\npnpm test\n```", "package.json": "{}", "pnpm-lock.yaml": "" })
  const ran = readiness(t, [
    { kind: "test", command: "pnpm run test", status: "passed", ms: 1000 },
    { kind: "lint", command: "pnpm run lint", status: "error", ms: 0 }
  ], true)
  assert.equal(ran.level, 2, "tests pass but no CI")
  assert.equal(ran.fixes.length, 3)
  assert.deepEqual(ran.fixes[0], { pillar: "ci", title: "Run checks in CI", points: 8 })
  assert.equal(ran.pillars.find((pillar) => pillar.id === "types")!.max, 11, "unrun lint is not counted")
  const failing = readiness(t, [{ kind: "test", command: "pnpm run test", status: "failed", ms: 1000 }], true)
  assert.ok(failing.score < ran.score)
  assert.equal(failing.level, 2)
})

test("cleanup scores deterministic signals as a range with file links, or says insufficient data", () => {
  const block = Array.from({ length: 8 }, (_, index) => `  const value${index} = compute(${index}, input)`).join("\n")
  const files: Record<string, string> = {
    "src/a.ts": `export function a() {\n${block}\n}\n// for now this should work\n`,
    "src/b.ts": `export function b() {\n${block}\n}\ntry { x() } catch {}\n`,
    "src/c.py": "def f():\n    pass\n"
  }
  const scored = cleanup(tree(files), 30, 0)
  assert.equal(scored.status, "scored")
  assert.ok(scored.low <= scored.score && scored.score <= scored.high)
  assert.deepEqual(scored.causes.map((cause) => cause.signal).sort(), ["duplicates", "lexicon", "stubs"])
  assert.deepEqual(scored.causes.find((cause) => cause.signal === "lexicon")!.location, { path: "src/a.ts", line: 11 })
  assert.deepEqual(cleanup(tree(files), 30, 0), scored, "the interval is the same on replay")
  assert.equal(cleanup(tree(files), 1000, 0.1).status, "insufficient", "under 60% coverage gives no number")
})

test("intake, affected packages and the CI estimate read GitHub rows", () => {
  const pulls = parsePulls([
    {
      number: 1,
      title: "a",
      author_association: "CONTRIBUTOR",
      created_at: "2026-08-01T00:00:00Z",
      merged_at: "2026-08-02T00:00:00Z",
      closed_at: "2026-08-02T00:00:00Z",
      user: { type: "User" }
    },
    {
      number: 2,
      title: "b",
      author_association: "MEMBER",
      created_at: "2026-08-01T00:00:00Z",
      merged_at: null,
      closed_at: "2026-08-03T00:00:00Z",
      user: { type: "User" }
    },
    {
      number: 3,
      title: "c",
      author_association: "NONE",
      created_at: "2026-08-01T00:00:00Z",
      merged_at: null,
      closed_at: null,
      user: { type: "Bot" }
    }
  ])
  const summary = intake(tree({ "CONTRIBUTING.md": "" }), pulls, [2, 6])
  assert.equal(summary.external, 1)
  assert.equal(summary.merged, 1)
  assert.equal(summary.firstReviewHours, 4)
  assert.equal(summary.choice.chosen, "Open, reviewed")
  assert.equal(summary.contributing, true)
  const t = tree({
    "package.json": JSON.stringify({ workspaces: ["packages/*"] }),
    "packages/core/package.json": JSON.stringify({ name: "core" }),
    "packages/ui/package.json": JSON.stringify({ name: "ui", dependencies: { core: "*" } }),
    "packages/docs/package.json": JSON.stringify({ name: "docs" })
  })
  const packages = workspacePackages(t)
  assert.equal(packages.length, 3)
  assert.equal(affectedPackages(packages, ["packages/core/src/x.ts"]), 2)
  assert.equal(affectedPackages(packages, ["packages/docs/a.md"]), 1)
  assert.equal(affectedPackages(packages, ["pnpm-lock.yaml"]), 3)
  assert.equal(
    ciMinutes({
      workflow_runs: [
        { run_started_at: "2026-08-01T00:00:00Z", updated_at: "2026-08-01T00:10:00Z" },
        { run_started_at: "2026-08-01T00:00:00Z", updated_at: "2026-08-01T00:14:00Z" },
        { run_started_at: "2026-08-01T00:00:00Z", updated_at: "2026-08-01T00:20:00Z" }
      ]
    }),
    14
  )
  assert.deepEqual(ciEstimate(812, 14, 3, 1), {
    _tag: "ci",
    pr: 812,
    baselineMinutes: 14,
    estimateMinutes: 7,
    affected: 1,
    packages: 3
  })
})

// ---- the flow, on a real git checkout ----------------------------------------------------------

const gitIn = (root: string, args: ReadonlyArray<string>, date?: string) =>
  execFileSync("git", ["-C", root, ...args], {
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Ada",
      GIT_AUTHOR_EMAIL: "ada@example.com",
      GIT_COMMITTER_NAME: "Ada",
      GIT_COMMITTER_EMAIL: "ada@example.com",
      ...(date === undefined ? {} : { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date })
    },
    encoding: "utf8"
  })

const checkout = async (t: TestContext) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "smithers-register-")))
  t.after(() => rm(root, { recursive: true, force: true }))
  const repo = join(root, "repo")
  const files: Record<string, string> = {
    "README.md": "# Widgets\n\nBuild and test:\n\n```sh\nnpm test\n```\n",
    LICENSE: "MIT License\n\nPermission is hereby granted, free of charge, to any person obtaining a copy",
    "AGENTS.md": "Run `npm run test` before landing.\n",
    "package.json": JSON.stringify({ name: "widgets", scripts: { test: "node test.mjs", lint: "node lint.mjs" } }),
    "package-lock.json": JSON.stringify({
      name: "widgets",
      lockfileVersion: 3,
      requires: true,
      packages: { "": { name: "widgets" } }
    }),
    "test.mjs": "process.exit(0)\n",
    "lint.mjs": "process.exit(1)\n",
    ".github/workflows/ci.yml":
      "on: [pull_request]\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - run: npm test\n",
    "src/index.ts": "export const widget = (n: number) => n + 1\n// for now this should work\n"
  }
  for (const [path, text] of Object.entries(files)) {
    await mkdir(dirname(join(repo, path)), { recursive: true })
    await writeFile(join(repo, path), text)
  }
  // A committed symlink out of the checkout is listed, never read.
  await writeFile(join(root, "outside.txt"), "GNU AFFERO GENERAL PUBLIC LICENSE\n")
  await symlink("../outside.txt", join(repo, "COPYING"))
  gitIn(repo, ["init", "-q", "-b", "main"])
  gitIn(repo, ["add", "-A"])
  gitIn(repo, ["commit", "-q", "-m", "Initial widgets"], "2026-08-01T10:00:00Z")
  await writeFile(join(repo, "src/index.ts"), "export const widget = (n: number) => n + 2\n")
  gitIn(repo, [
    "commit",
    "-q",
    "-am",
    "Remove default exports (#12)",
    "-m",
    "Co-authored-by: Claude <noreply@anthropic.com>"
  ], "2026-08-20T10:00:00Z")
  return { root, repo }
}

/** Jev: the first candidate, lint for pull requests about exports, and a count of every call. */
const jev = () => {
  const calls = { count: 0 }
  const layer = Evaluator.layerScripted((request) => {
    calls.count++
    if ("kind" in request.questions) {
      const state = request.state as { title: string }
      const kind = /export/i.test(state.title) ? "lint" : "neither"
      return {
        kind: {
          choice: kind,
          probabilities: { lint: kind === "lint" ? 0.9 : 0.05, chore: 0.05, neither: kind === "lint" ? 0.05 : 0.9 }
        }
      }
    }
    return { pick: { choice: "first", probabilities: { first: 0.9, second: 0.05, third: 0.05 } } }
  })
  return { calls, layer }
}

const iso = (minutes: number) => new Date(Date.UTC(2026, 7, 20, 10, minutes)).toISOString()
const pulls = [
  {
    number: 12,
    title: "Remove default exports",
    author_association: "CONTRIBUTOR",
    user: { type: "User" },
    created_at: iso(0),
    merged_at: iso(90),
    closed_at: iso(90)
  },
  {
    number: 11,
    title: "Add widgets",
    author_association: "OWNER",
    user: { type: "User" },
    created_at: iso(0),
    merged_at: iso(30),
    closed_at: iso(30)
  }
]
/** GitHub as the repository's proxy answers it, keyed by the requested path. */
const github: Record<string, unknown> = {
  "/pulls?state=all&per_page=50": pulls,
  "/pulls?state=closed&per_page=50": pulls,
  "/pulls?state=closed&per_page=20": pulls,
  "/pulls/12/reviews?per_page=10": [{ submitted_at: iso(60) }],
  "/pulls/11/reviews?per_page=10": [],
  "/actions/runs?event=pull_request&status=success&per_page=30": {
    workflow_runs: [{ run_started_at: iso(0), updated_at: iso(14) }]
  },
  "/pulls/12/files?per_page=100": [{ filename: "src/index.ts" }]
}
/** The coding host's repository binding, reduced to what registration reads. */
const remote = Layer.succeed(RepositoryRemote)(
  {
    githubSource: Effect.succeed("acme/widgets"),
    github: (path: string) =>
      path in github
        ? Effect.succeed(github[path] as Schema.Json)
        : Effect.fail(new CodingError({ code: "unavailable", message: path }))
  } as unknown as RepositoryRemote["Service"]
)

const host = (repo: string, root: string, evaluator: Layer.Layer<Evaluator.Evaluator>, bound = false) =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    return NodeRuntime.layerHost(
      { filename: join(root, "engine.db"), workspaceRoot: root, owner: { hostId: "register-test" }, signals: [] },
      Layer.mergeAll(
        registration({
          repositoryPath: repo,
          fs,
          spawner,
          environment: { PATH: process.env.PATH ?? "", HOME: root },
          ...(bound ? {} : { source: Effect.succeed("Acme/Widgets") }),
          evaluator,
          commandTimeoutMs: 60_000
        }),
        HumanTask.layer
      ).pipe(
        Layer.provideMerge(Action.layerImplementations),
        (layers) => bound ? Layer.provideMerge(layers, remote) : layers
      )
    )
  })

/** One engine lifetime: every call builds a fresh engine over the same database, like a restarted host. */
const lifetime = <A>(
  repo: string,
  root: string,
  evaluator: Layer.Layer<Evaluator.Evaluator>,
  body: Effect.Effect<A, unknown, any>,
  bound = false
): Promise<A> =>
  Effect.runPromise(
    Effect.scoped(Effect.gen(function*() {
      const layer = yield* host(repo, root, evaluator, bound)
      return yield* body.pipe(Effect.provide(layer))
    })).pipe(Effect.provide(NodeServices.layer)) as Effect.Effect<A, unknown, never>
  )

/** A discarded execution runs in the background; the wait appears once the analysis reaches it. */
const waiting = (id: string) =>
  Effect.gen(function*() {
    const state = yield* DurableEngineState.DurableEngineState
    for (let attempt = 0; attempt < 240; attempt++) {
      const row = yield* state.waiting(id)
      if (Option.isSome(row)) return row
      yield* Effect.sleep(250)
    }
    return Option.none<DurableEngineState.WaitingRow>()
  })
const answer = (row: DurableEngineState.WaitingRow, value: Schema.Json) =>
  HumanTask.answer({ token: Schema.decodeUnknownSync(DurableDeferred.Token)(row.token), value })

test(
  "registration analyzes, parks for review across restarts, and a decline carries its note",
  { timeout: 180_000 },
  async (t) => {
    const { root, repo } = await checkout(t)
    const judge = jev()
    const input = { link: "https://github.com/acme/widgets" }
    // First lifetime: the analysis runs and parks on the admin review, unresolved.
    const parked = await lifetime(
      repo,
      root,
      judge.layer,
      Effect.gen(function*() {
        yield* Register.execute(input, { executionId: "reg-1", discard: true })
        return yield* waiting("reg-1")
      })
    )
    assert.ok(Option.isSome(parked), "the run waits for review")
    assert.equal((parked.value.request as { name: string }).name, REVIEW)
    assert.deepEqual((parked.value.request as { options: Array<string> }).options, [APPROVE, DECLINE])
    const analyzed = judge.calls.count
    assert.ok(analyzed > 0, "Jev answered the workflow's questions")
    // Second lifetime (a restarted host): the same wait is still there and nothing re-ran.
    const again = await lifetime(repo, root, judge.layer, waiting("reg-1"))
    assert.ok(Option.isSome(again))
    assert.equal(again.value.token, parked.value.token)
    assert.equal(judge.calls.count, analyzed, "a restart asks no model anything")
    // Decline, then the note.
    const noted = await lifetime(
      repo,
      root,
      judge.layer,
      Effect.gen(function*() {
        yield* answer(parked.value, DECLINE)
        yield* Register.execute(input, { executionId: "reg-1", discard: true })
        return yield* waiting("reg-1")
      })
    )
    assert.ok(Option.isSome(noted))
    assert.equal((noted.value.request as { name: string }).name, DECLINE_NOTE)
    const outcome = await lifetime(
      repo,
      root,
      judge.layer,
      Effect.gen(function*() {
        yield* answer(noted.value, "Not open source yet")
        return yield* Register.execute(input, { executionId: "reg-1" })
      })
    ) as Outcome
    assert.deepEqual(outcome.review, { decision: "decline", note: "Not open source yet" })
    assert.equal(outcome.setup, null)
    const report = outcome.report
    assert.equal(report.repo, "acme/widgets")
    assert.equal(report.clone.files, 10)
    assert.equal(
      report.license._tag === "license" && report.license.choice.evidence.join(),
      "LICENSE",
      "the symlink is not read"
    )
    assert.equal(report.theme._tag === "theme" && report.theme.name, "Widgets")
    assert.equal(report.license._tag === "license" && report.license.spdx, "MIT")
    assert.equal(report.checks._tag === "checks" && report.checks.choice.chosen, "GitHub Actions")
    assert.equal(report.readiness._tag, "readiness")
    if (report.readiness._tag === "readiness") {
      assert.deepEqual(report.readiness.runs.map((run) => `${run.command}:${run.status}`), [
        "npm run test:passed",
        "npm run lint:failed"
      ])
    }
    assert.equal(report.agentShare._tag === "agent-share" && report.agentShare.traced, 1)
    assert.equal(report.workflows._tag === "workflows" && report.workflows.lintRules[0]?.pr, 12)
    assert.equal(report.intake._tag, "unavailable", "no GitHub, no intake tile")
    assert.equal(report.ci._tag, "unavailable")
    // A finished run replays from its journal: the same outcome and no model call.
    const before = judge.calls.count
    const replayed = await lifetime(repo, root, judge.layer, Register.execute(input, { executionId: "reg-1" }))
    assert.deepEqual(replayed, outcome)
    assert.equal(judge.calls.count, before, "replay asks no model anything")
  }
)

test("approval starts setup, which runs the repository's checks, and a wrong repository is refused", {
  timeout: 180_000
}, async (t) => {
  const { root, repo } = await checkout(t)
  const judge = jev()
  const input = { link: "acme/widgets" }
  const parked = await lifetime(
    repo,
    root,
    judge.layer,
    Effect.gen(function*() {
      yield* Register.execute(input, { executionId: "reg-2", discard: true })
      return yield* waiting("reg-2")
    }),
    true
  )
  assert.ok(Option.isSome(parked))
  const outcome = await lifetime(
    repo,
    root,
    judge.layer,
    Effect.gen(function*() {
      yield* answer(parked.value, APPROVE)
      return yield* Register.execute(input, { executionId: "reg-2" })
    }),
    true
  ) as Outcome
  assert.equal(outcome.review.decision, "approve")
  assert.deepEqual(outcome.setup?.runs.map((run) => run.status), ["passed", "passed", "failed"])
  // The host's repository binding answers GitHub: intake and the CI estimate are real.
  const { intake, ci } = outcome.report
  assert.equal(intake._tag === "intake" && `${intake.external}/${intake.pulls} ${intake.firstReviewHours}h`, "1/2 1h")
  assert.equal(ci._tag === "ci" && `#${ci.pr} ${ci.baselineMinutes}->${ci.estimateMinutes}`, "#12 14->14")
  const refused = await lifetime(
    repo,
    root,
    judge.layer,
    Register.execute({ link: "acme/other" }, { executionId: "reg-3" }).pipe(Effect.flip),
    true
  )
  assert.equal((refused as { code?: string }).code, "wrong_repository")
})
