import { NodeServices } from "@effect/platform-node"
import * as DurableEngineState from "@smthrs/engine-store/DurableEngineState"
import { Action, Flow, HumanTask, Interpreter } from "@smthrs/flow"
import * as DurableDeferred from "@smthrs/flow/DurableDeferred"
import * as NodeRuntime from "@smthrs/flows/NodeRuntime"
import * as Evaluator from "@smthrs/model/Evaluator"
import { Effect, FileSystem, Layer, Option, Redacted, Schema } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { ChildProcessSpawner } from "effect/unstable/process"
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { test, type TestContext } from "node:test"
import { CodingError } from "../coding/schema.ts"
import { cleanup, cleanupCandidates } from "../register-repository/cleanup.ts"
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
import { estimateAgentShare } from "../register-repository/jev.ts"
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
import {
  Clone,
  Commits,
  Input,
  Languages,
  type Outcome,
  RegisterError,
  Unavailable
} from "../register-repository/schema.ts"
import { checkCommands, checkRunners, licenseCandidates, type Tree } from "../register-repository/tree.ts"
import { CloneStep, CommitsStep, LanguagesStep } from "../register-repository/workflow.ts"
import { githubReadable, makeRemote, RepositoryRemote } from "../repository/remote.ts"

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

test("a mirror under another name reads its source's pull requests and CI runs through the source's proxy", async (t) => {
  const proxied: Array<{ url: string | undefined; path: string }> = []
  const server = createServer(async (request, response) => {
    response.setHeader("content-type", "application/json")
    if (request.url === "/api/repos/alice/widgets-import/repository-source") {
      response.end(JSON.stringify({ source: "github", full_name: "acme/widgets" }))
      return
    }
    let text = ""
    for await (const chunk of request) text += chunk
    const body = JSON.parse(text) as { method: string; path: string }
    assert.equal(body.method, "GET")
    proxied.push({ url: request.url, path: body.path })
    response.end(JSON.stringify(body.path.includes("/actions/runs") ? { workflow_runs: [] } : [{ number: 12 }]))
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  t.after(() => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())))
  const address = server.address()
  assert(address && typeof address !== "string")
  const bound = await Effect.runPromise(
    makeRemote({
      apiBaseUrl: `http://127.0.0.1:${address.port}/api`,
      repositorySlug: "alice/widgets-import",
      repositoryId: 1,
      workspaceId: "22222222-2222-4222-8222-222222222222",
      token: Redacted.make("fixture-token"),
      gatewayId: "11111111-1111-4111-8111-111111111111",
      credential: "fixture-gateway"
    }).pipe(Effect.provide(FetchHttpClient.layer))
  )
  assert.equal(await Effect.runPromise(bound.githubSource!), "acme/widgets")
  const reads = [
    "/pulls?state=all&per_page=50",
    "/pulls/12/reviews?per_page=10",
    "/pulls/12/files?per_page=100",
    "/actions/runs?event=pull_request&status=success&per_page=30"
  ]
  for (const path of reads) await Effect.runPromise(bound.github!(path))
  assert.deepEqual(
    proxied,
    reads.map((path) => ({ url: "/api/repos/acme/widgets/github-proxy", path: `/repos/acme/widgets${path}` }))
  )
  await assert.rejects(Effect.runPromise(bound.github!("/issues")), /outside this repository/)
  assert.equal(proxied.length, reads.length)
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

/** Jev for cleanup and commit judgments: `answer` decides each finding's probability of yes. */
const judgeWith = (answer: (state: { path: string; line: number; note: string; snippet: string }) => number) => {
  const calls: Array<string> = []
  const layer = Evaluator.layerScripted((request) => {
    if ("finding" in request.questions) {
      const state = request.state as { path: string; line: number; note: string; snippet: string }
      calls.push(`${state.path}:${state.line}`)
      const yes = answer(state)
      return { finding: { choice: yes >= 0.5 ? "yes" : "no", probabilities: { yes, no: 1 - yes } } }
    }
    const state = request.state as { subject: string }
    const agent = /comprehensive/i.test(state.subject)
    const unclear = /unclear/i.test(state.subject)
    return {
      author: {
        choice: agent || unclear ? "agent" : "human",
        probabilities: unclear
          ? { agent: 0.5, human: 0.4, unclear: 0.1 }
          : { agent: agent ? 0.9 : 0.05, human: agent ? 0.05 : 0.9, unclear: 0.05 }
      }
    }
  })
  return { calls, layer }
}
const judged = <A>(effect: Effect.Effect<A, never, Evaluator.Evaluator>, layer: Layer.Layer<Evaluator.Evaluator>) =>
  Effect.runPromise(Effect.provide(effect, layer))

test("cleanup scores deterministic signals as a range with file links, or says insufficient data", async () => {
  const block = Array.from({ length: 8 }, (_, index) => `  const value${index} = compute(${index}, input)`).join("\n")
  const files: Record<string, string> = {
    "src/a.ts": `export function a() {\n${block}\n}\n// for now this should work\n`,
    "src/b.ts": `export function b() {\n${block}\n}\ntry { x() } catch {}\n`,
    "src/c.py": "def f():\n    pass\n"
  }
  const jev = judgeWith(() => 0.9)
  const scored = await judged(cleanup(tree(files), 30, 0), jev.layer)
  assert.equal(scored.status, "scored")
  assert.ok(scored.low <= scored.score && scored.score <= scored.high)
  assert.deepEqual(scored.causes.map((cause) => cause.signal).sort(), ["duplicates", "lexicon", "stubs"])
  assert.deepEqual(scored.causes.find((cause) => cause.signal === "lexicon")!.location, { path: "src/a.ts", line: 11 })
  assert.equal(scored.method, "hybrid-v0", "no candidates is a measured zero, not a missing signal")
  assert.deepEqual(jev.calls, [], "Jev is asked only about candidates")
  assert.deepEqual(await judged(cleanup(tree(files), 30, 0), jev.layer), scored, "the interval is the same on replay")
  const insufficient = await judged(cleanup(tree(files), 1000, 0.1), jev.layer)
  assert.equal(insufficient.status, "insufficient", "under 60% coverage gives no number")
})

/** One candidate for each Jev-judged signal, S6-S10. */
const judgedTree = () =>
  tree({
    "src/user.ts": [
      "import { save } from \"./store.ts\"",
      "import { gone } from \"./gone.js\"",
      "// Gets the user",
      "export function getUser(id: string) {",
      "  return save(id)",
      "}",
      "export function load(id: string) {",
      "  try {",
      "    return save(id)",
      "  } catch (error) {",
      "    console.error(error)",
      "    throw error",
      "  }",
      "}",
      "export const same = gone"
    ].join("\n"),
    "src/store.ts": [
      "export interface Store {",
      "  put(id: string): string",
      "}",
      "export class MemoryStore implements Store {",
      "  put(id: string) { return id }",
      "}",
      "export const save = (id: string) => new MemoryStore().put(id)"
    ].join("\n"),
    "test/user.test.ts": [
      "import { getUser } from \"../src/user.ts\"",
      "test(\"getUser should work\", () => { getUser(\"a\") })",
      "test(\"load\", () => {",
      "  assert.equal(getUser(\"b\"), \"b\")",
      "})"
    ].join("\n"),
    "README.md": "# Users\n\nCall `frobnicate()` to reset and `getUser()` to read.\n"
  })

test("cleanup finds Jev-judged signals S6-S10 from deterministic candidates", () => {
  const found = cleanupCandidates(judgedTree())
  const at = (id: keyof typeof found) => found[id].map((candidate) => `${candidate.path}:${candidate.line}`)
  assert.deepEqual(at("comments"), ["src/user.ts:3"], "a comment that repeats the function's name")
  assert.deepEqual(at("defensive"), ["src/user.ts:10"], "catch, log, rethrow")
  assert.deepEqual(at("abstraction"), ["src/user.ts:4", "src/store.ts:1"], "one implementation; one-call wrapper")
  assert.deepEqual(at("drift"), ["src/user.ts:2", "README.md:3"], "an unresolved import; a documented call no code has")
  assert.deepEqual(at("test-theater"), ["test/user.test.ts:2"], "a test without an assertion, even named should")
})

test("the pre-filter reads block doc comments and subclasses, and never reads vendored or partial docs", () => {
  const files = {
    "src/shape.ts": [
      "export abstract class Shape {",
      "  abstract area(): number",
      "}",
      "export class Square extends Shape {",
      "  area() { return 1 }",
      "}",
      "/**",
      " * Gets the area.",
      " * @param shape the shape",
      " */",
      "export function getArea(shape: Shape) {",
      "  if (shape !== null && shape !== undefined) console.log(shape)",
      "  return shape.area()",
      "}"
    ].join("\n"),
    "lib/app.ex": "def configure(), do: :ok\n",
    "vendor/lib/README.md": "Call `vendoredOnly()`.\n",
    "README.md": "Call `configure()` or `missing()`.\n"
  }
  const found = cleanupCandidates(tree(files))
  const at = (id: keyof typeof found) => found[id].map((candidate) => `${candidate.path}:${candidate.line}`)
  assert.deepEqual(at("comments"), ["src/shape.ts:7"], "a block doc comment, tags aside, that repeats the name")
  assert.deepEqual(at("abstraction"), ["src/shape.ts:1"], "an abstract class with one subclass")
  assert.deepEqual(at("defensive"), ["src/shape.ts:12"], "not null and not undefined")
  assert.deepEqual(at("drift"), ["README.md:1"], "any readable file defines a name; vendored docs are not the owner's")
  const partial = cleanupCandidates(tree(files, ["src/large.ts"]))
  assert.deepEqual(partial.drift, [], "an unreadable source file could define the documented call")
})

test("the pre-filter skips comments, declaration files, build output and lone typeof checks", () => {
  const found = cleanupCandidates(tree({
    "src/types.d.ts": "export interface User { id: string }\n",
    "src/notes.txt": "notes\n",
    "src/user.ts": [
      "import type { User } from \"./types\"",
      "import { client } from \"./generated/client.js\"",
      "import notes from \"./notes.txt?raw\"",
      "export const ready = typeof window === \"undefined\"",
      "export const user = (id: string): User => client(id)"
    ].join("\n"),
    "test/user.test.ts": [
      "test(\"commented\", () => {",
      "  // expect(user(\"a\")).toBe(1)",
      "  user(\"a\")",
      "})",
      "test(\"braces in a comment\", () => {",
      "  // }}",
      "  expect(user(\"b\").id).toBe(\"b\")",
      "})"
    ].join("\n")
  }))
  assert.deepEqual(
    found.drift,
    [],
    "a declaration file answers; a bundler query names the same file; build output is untracked"
  )
  assert.deepEqual(found.defensive, [], "typeof alone is how code asks about a global")
  assert.deepEqual(
    found["test-theater"].map((candidate) => `${candidate.path}:${candidate.line}`),
    ["test/user.test.ts:1"],
    "a commented-out assertion asserts nothing; a commented brace ends nothing"
  )
})

test("a repository in languages the pre-filter cannot read leaves the judged signals unmeasured", async () => {
  const java = tree({
    "src/User.java": "class User {\n  // Gets the user\n  public User getUser() { return this; }\n}\n"
  })
  const jev = judgeWith(() => 0.9)
  const offline = await judged(cleanup(java, 4, 0), jev.layer)
  assert.equal(offline.status, "scored")
  assert.equal(offline.method, "deterministic-v0", "no zero without evidence")
  assert.deepEqual(jev.calls, [])
  const read = await judged(cleanup(tree({ "src/user.ts": "export const user = 1\n" }), 1, 0), jev.layer)
  assert.equal(read.method, "hybrid-v0")
  assert.ok(offline.high - offline.low > read.high - read.low, "unmeasured signals widen the range")
})

test("test theater reads each test's own body, however long", () => {
  const found = cleanupCandidates(tree({
    "src/run.ts": "export const run = (n: number) => n\n",
    "test/run.test.ts": [
      "test(\"empty\", () => { run(1) })",
      "function check() { expect(run(2)).toBe(2) }",
      "test(\"long\", () => {",
      ...Array.from({ length: 70 }, (_, index) => `  run(${index})`),
      "  expect(run(3)).toBe(3)",
      "})"
    ].join("\n"),
    "test/test_run.py": [
      "def test_empty():",
      "    run(1)",
      "",
      "def helper():",
      "    assert run(2) == 2"
    ].join("\n")
  }))
  assert.deepEqual(
    found["test-theater"].map((candidate) => `${candidate.path}:${candidate.line}`),
    ["test/run.test.ts:1", "test/test_run.py:1"],
    "a helper's assertion after a test is not the test's; an assertion 70 lines in is"
  )
  assert.equal(found["test-theater"][0]!.snippet, "test(\"empty\", () => { run(1) })", "Jev reads the test itself")
})

test("cleanup finds test theater with Jev and stops labeling itself deterministic-v0", async () => {
  const theater = tree({
    "src/a.ts": "export const a = (n: number) => n + 1\n",
    "test/a.test.ts": "import { a } from \"../src/a.ts\"\ntest(\"a works\", () => { a(1) })\n"
  })
  const confirmed = await judged(cleanup(theater, 3, 0), judgeWith(() => 0.95).layer)
  assert.equal(confirmed.method, "hybrid-v0")
  assert.deepEqual(confirmed.causes.find((cause) => cause.signal === "test-theater"), {
    signal: "test-theater",
    count: 1,
    location: { path: "test/a.test.ts", line: 2 }
  })
  const rejected = await judged(cleanup(theater, 3, 0), judgeWith(() => 0.05).layer)
  assert.equal(rejected.causes.some((cause) => cause.signal === "test-theater"), false, "Jev said no")
  assert.ok(rejected.score < confirmed.score)
  const unsure = await judged(cleanup(theater, 3, 0), judgeWith(() => 0.55).layer)
  assert.equal(unsure.causes.some((cause) => cause.signal === "test-theater"), false, "unclear is no finding")
  assert.ok(unsure.high > rejected.high && unsure.low === rejected.low, "unclear widens only the high end")
  const offline = await judged(cleanup(theater, 3, 0), Evaluator.layerUnavailable())
  assert.equal(offline.method, "deterministic-v0", "without Jev the judged signals stay unmeasured")
  assert.ok(offline.high - offline.low > rejected.high - rejected.low, "an unmeasured signal widens the range")
})

test("cleanup samples at most eight candidates per signal and scales the judged share", async () => {
  const tests = Array.from({ length: 20 }, (_, index) => `test("t${index}", () => { run(${index}) })`).join("\n")
  const many = tree({ "src/run.ts": "export const run = (n: number) => n\n", "test/run.test.ts": tests })
  const jev = judgeWith((state) => state.line >= 11 ? 0.9 : 0.1)
  const result = await judged(cleanup(many, 21, 0), jev.layer)
  assert.equal(jev.calls.length, 8)
  assert.deepEqual(jev.calls, [1, 3, 6, 8, 11, 13, 16, 18].map((line) => `test/run.test.ts:${line}`))
  const theater = result.causes.find((cause) => cause.signal === "test-theater")
  assert.equal(theater?.count, 10, "four of eight sampled scale to ten of twenty")
  assert.deepEqual(theater?.location, { path: "test/run.test.ts", line: 11 })
})

test("the agent-written estimate is a Jev range over sampled untraced commits beside the traced floor", async () => {
  const commits = parseLog(log([
    { subject: "feat: one", age: 1, trailer: "Claude <noreply@anthropic.com>" },
    { subject: "feat: Add comprehensive widget system", age: 2 },
    { subject: "fix typo", age: 3 },
    { subject: "unclear change", age: 4 },
    { subject: "bump", age: 5 },
    { subject: "old", age: 400 }
  ]))
  const estimate = await judged(estimateAgentShare(commits, NOW), judgeWith(() => 0).layer)
  assert.deepEqual(estimate, { low: 40, high: 60, sampled: 4 }, "1 traced + 1 agent of 5; one unclear")
  assert.equal(await judged(estimateAgentShare(commits, NOW), Evaluator.layerUnavailable()), undefined)
  assert.equal(await judged(estimateAgentShare([], NOW), judgeWith(() => 0).layer), undefined)
  const traced = parseLog(log([{ subject: "a", age: 1, trailer: "Claude <noreply@anthropic.com>" }]))
  assert.deepEqual(await judged(estimateAgentShare(traced, NOW), Evaluator.layerUnavailable()), {
    low: 100,
    high: 100,
    sampled: 0
  })
  const contradicted = Evaluator.layerScripted(() => ({
    author: { choice: "agent", probabilities: { agent: 0.1, human: 0.85, unclear: 0.05 } }
  }))
  assert.deepEqual(
    await judged(estimateAgentShare(commits, NOW), contradicted),
    { low: 20, high: 100, sampled: 4 },
    "a choice its own probabilities contradict is unclear, not a confident agent"
  )
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

/** Jev: the first candidate, lint for pull requests about exports, every cleanup finding, human commits, and a count of every call. */
const jev = () => {
  const calls = { count: 0 }
  const layer = Evaluator.layerScripted((request) => {
    calls.count++
    if ("finding" in request.questions) return { finding: { choice: "yes", probabilities: { yes: 0.9, no: 0.1 } } }
    if ("author" in request.questions) {
      return { author: { choice: "human", probabilities: { agent: 0.05, human: 0.9, unclear: 0.05 } } }
    }
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
    assert.ok(report.agentShare._tag === "agent-share" && report.agentShare.estimate !== undefined, "Jev estimated")
    assert.equal(report.cleanup._tag === "cleanup" && report.cleanup.method, "hybrid-v0")
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

/** Each registration step alone, so the checkout can move between them. */
const PinnedClone = Flow.make("register-test/clone", {
  payload: Input.fields,
  success: Clone,
  error: RegisterError,
  body: (input) => CloneStep.call(input)
})
const PinnedLanguages = Flow.make("register-test/languages", {
  payload: { clone: Clone },
  success: Languages,
  error: RegisterError,
  body: (input) => LanguagesStep.call(input)
})
const PinnedCommits = Flow.make("register-test/commits", {
  payload: { clone: Clone },
  success: Schema.Union([Commits, Unavailable]),
  error: RegisterError,
  body: (input) => CommitsStep.call(input)
})

test("analyses stay pinned to the captured commit when HEAD advances", { timeout: 180_000 }, async (t) => {
  const { root, repo } = await checkout(t)
  const judge = jev()
  const analyses = (clone: typeof Clone.Type, id: string) =>
    Effect.all({
      languages: PinnedLanguages.execute({ clone }, { executionId: `${id}-languages` }),
      commits: PinnedCommits.execute({ clone }, { executionId: `${id}-commits` })
    })
  const { captured, advanced, pinned, fresh } = await lifetime(
    repo,
    root,
    judge.layer,
    Effect.gen(function*() {
      const captured = yield* PinnedClone.execute({ link: "acme/widgets" }, { executionId: "pin-clone" })
      const before = yield* analyses(captured, "pin-before")
      // The checkout moves on after the clone recorded its commit.
      gitIn(repo, ["rm", "-q", "src/index.ts"])
      yield* Effect.promise(() => writeFile(join(repo, "app.py"), "print('widgets')\n"))
      gitIn(repo, ["add", "app.py"])
      gitIn(repo, ["commit", "-q", "-m", "Rewrite in Python"], "2026-08-25T10:00:00Z")
      const advanced = gitIn(repo, ["rev-parse", "HEAD"]).trim()
      const pinned = yield* analyses(captured, "pin-after")
      const next = yield* PinnedClone.execute({ link: "acme/widgets" }, { executionId: "pin-clone-next" })
      return { captured, advanced, pinned: { before, after: pinned }, fresh: yield* analyses(next, "pin-next") }
    }).pipe(
      Effect.provide(Layer.mergeAll(
        Interpreter.layer(PinnedClone),
        Interpreter.layer(PinnedLanguages),
        Interpreter.layer(PinnedCommits)
      ))
    )
  )
  assert.notEqual(advanced, captured.commit)
  const names = (result: { languages: { languages: ReadonlyArray<{ name: string }> } }) =>
    result.languages.languages.map((entry) => entry.name)
  assert.ok(names(pinned.before).includes("TypeScript"))
  assert.deepEqual(names(pinned.after), names(pinned.before), "the recorded commit's languages, not HEAD's")
  assert.ok(!names(pinned.after).includes("Python"))
  assert.deepEqual(pinned.after.commits, pinned.before.commits, "history ends at the recorded commit")
  // A registration that captures the new commit sees it.
  assert.ok(names(fresh).includes("Python") && !names(fresh).includes("TypeScript"))
  assert.equal(
    fresh.commits._tag === "commits" && pinned.after.commits._tag === "commits" &&
      fresh.commits.total - pinned.after.commits.total,
    1
  )
})
