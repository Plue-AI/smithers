import { Effect } from "effect"
import assert from "node:assert/strict"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { syncBuiltinESMExports } from "node:module"
import os, { tmpdir } from "node:os"
import { join } from "node:path"
import test, { mock } from "node:test"
import type { SelectOptions } from "../issues.ts"
import {
  areas,
  candidates,
  IssueReadError,
  observeIssues,
  pick_companions,
  priority,
  selectCandidates
} from "../issues.ts"

const repo = "smithersai/smithers"
const row = (n: number, severity = "medium", effort = "easy", type = "bug") => ({
  repo,
  n,
  severity,
  effort,
  type,
  needs_will: false,
  title: `issue ${n}`
})
const issue = (number: number, labels: Array<string> = [], title = `issue ${number}`) => ({
  number,
  title,
  labels: labels.map((name) => ({ name }))
})
const cand = (n: number, extra = {}) => ({
  repo,
  n,
  title: `issue ${n}`,
  blocked: false,
  severity: 2,
  effort: 1,
  boost: 1,
  bundleable: true,
  ...extra
})

test("triage ranking preserves known ranks, unknown defaults, repository isolation and last row", () => {
  const p = priority([
    row(1, "critical", "trivial"),
    row(2, "high", "hard"),
    row(3, "low", "easy"),
    row(4, "mystery", "unknown"),
    row(1, "medium", "easy"),
    { ...row(1), repo: "smithersai/plue" }
  ])
  assert.deepEqual(p.get(`${repo}#1`), [2, 1, "bug"])
  assert.deepEqual(p.get(`${repo}#2`), [1, 2, "bug"])
  assert.deepEqual(p.get(`${repo}#3`), [3, 1, "bug"])
  assert.deepEqual(p.get(`${repo}#4`), [4, 1, "bug"])
  assert.equal(p.size, 5)
})

test("source areas accept all source extensions and exclude test files and embedded prefixes", () => {
  const paths = [
    "apps/app/a.ts",
    "packages/p/a.tsx",
    "scripts/a.mjs",
    "infra/a.js",
    "internal/a.go",
    "cmd/a.py",
    "db/a.sql",
    "e2e/a.rs"
  ]
  assert.deepEqual(
    [...areas(
      paths.join(" ") +
        " packages/p/a.tsx apps/app/test/a.ts packages/p/tests/a.go scripts/a.test.ts cmd/a.spec.js internal/a_test.go xapps/a.ts docs/a.ts"
    )].sort(),
    paths.sort()
  )
  assert.equal(areas("").size, 0)
})

test("selection orders boost, blocked, severity, effort and descending issue number", () => {
  const result = candidates(repo, [issue(1), issue(2), issue(3, ["blocked-on-will"]), issue(4), issue(5), issue(6)], [
    row(3, "critical"),
    row(4, "critical", "hard"),
    row(5, "critical", "trivial"),
    row(6, "low")
  ], { history: { [`${repo}#6`]: { boost: true } } })
  assert.deepEqual(result.candidates.map((x) => x.n), [6, 5, 4, 2, 1, 3])
  assert.equal(result.pending, true)
  assert.deepEqual(result.candidates[0], cand(6, { severity: 3, boost: 0 }))
})

test("label severity and effort precedence override triage without weakening critical rank", () => {
  const result = candidates(repo, [
    issue(1, ["security"]),
    issue(2, ["severity:high"]),
    issue(3, ["severity:critical", "severity:high", "size:hard", "size:trivial"]),
    issue(4, ["size:trivial"]),
    issue(5, ["size:easy"])
  ], [row(2, "critical"), row(5, "medium", "hard")])
  const by = new Map(result.candidates.map((x) => [x.n, x]))
  assert.equal(by.get(1)?.severity, 1)
  assert.equal(by.get(2)?.severity, 0)
  assert.deepEqual([by.get(3)?.severity, by.get(3)?.effort], [0, 2])
  assert.equal(by.get(4)?.effort, 0)
  assert.equal(by.get(5)?.effort, 1)
})

test("filtered open work stays pending until current Will-only evidence exists", () => {
  for (
    const label of [
      "mega:in-progress",
      "in-progress",
      "epic",
      "wontfix",
      "invalid",
      "duplicate",
      "question",
      "needs-human-approval"
    ]
  ) {
    assert.deepEqual(candidates(repo, [issue(1, [label])], []), { candidates: [], pending: true }, label)
  }
  for (const title of ["Blocked on Will: credential", "EPIC example", "[Epic] migration", "Umbrella migration"]) {
    assert.deepEqual(candidates(repo, [issue(1, [], title)], []), { candidates: [], pending: true }, title)
  }
  for (
    const options of [{ taken: new Set([1]) }, { reserved: new Set([`${repo}#1`]) }, { skip: new Set([`${repo}#1`]) }, {
      history: { [`${repo}#1`]: { closed: true } }
    }]
  ) {
    assert.deepEqual(candidates(repo, [issue(1)], [], options), { candidates: [], pending: true })
  }
  assert.equal(candidates(repo, [issue(1)], [row(1, "medium", "easy", "epic")]).pending, true)
  for (const n of [2598, 2524, 2523, 2441, 2414, 2765]) assert.equal(candidates(repo, [issue(n)], []).pending, true)
  assert.equal(candidates(repo, [issue(1)], [], { history: { [`${repo}#1`]: { willonly: true } } }).pending, true)
  assert.equal(candidates(repo, [issue(1, ["will-only"])], []).pending, false)
  assert.equal(candidates(repo, [issue(1, ["in-progress", "will-only"])], []).pending, true)
  assert.equal(candidates("smithersai/plue", [issue(2598)], []).candidates.length, 1)
})

test("retryAfter and attempt cooldown use seconds, allow equality, cap at 24 hours, and retain pending", () => {
  const select = (now: number, h: object) => candidates(repo, [issue(1)], [], { now, history: { [`${repo}#1`]: h } })
  assert.deepEqual(select(99, { retryAfter: 100 }), { candidates: [], pending: true })
  assert.equal(select(100, { retryAfter: 100 }).candidates.length, 1)
  assert.equal(select(10899, { attempts: 1, last: 100 }).candidates.length, 0)
  assert.equal(select(10900, { attempts: 1, last: 100 }).candidates.length, 1)
  assert.equal(select(21700, { attempts: 2, last: 100 }).candidates.length, 1)
  assert.equal(select(86499, { attempts: 100, last: 100 }).candidates.length, 0)
  assert.equal(select(86500, { attempts: 100, last: 100 }).candidates.length, 1)
  assert.equal(select(0, { attempts: 0, last: 100 }).candidates.length, 1)
})

test("companions require shared production source, medium/simple/unblocked and at most two", () => {
  const bodies = new Map([
    [1, "apps/a.ts packages/a.go"],
    [2, "apps/a.ts packages/a.go"],
    [3, "apps/a.ts"],
    [4, "apps/a.ts"],
    [5, "apps/a.ts"],
    [6, "apps/a.ts"],
    [7, "apps/a.ts"],
    [8, "apps/a.ts"],
    [9, "apps/a.ts"],
    [10, "apps/a.ts"],
    [11, "apps/a.ts"]
  ])
  const cs = [
    cand(1),
    cand(2),
    cand(3),
    cand(4, { effort: 0 }),
    cand(5, { blocked: true }),
    cand(6, { severity: 1 }),
    cand(7, { effort: 2 }),
    cand(8, { title: "[Architecture] change" }),
    cand(9, { title: "EPIC change" }),
    cand(10),
    cand(11, { repo: "smithersai/plue" })
  ]
  assert.deepEqual(pick_companions(cand(1), cs, bodies, new Set([10])).map((x) => x.n), [2, 4])
  assert.deepEqual(pick_companions(cand(1, { effort: 2 }), cs, bodies), [])
  assert.deepEqual(pick_companions(cand(1, { severity: 1 }), cs, bodies), [])
  assert.deepEqual(pick_companions(cand(20), cs, bodies), [])
  assert.deepEqual(pick_companions(cand(1), [cand(2)], new Map([[1, "apps/a.test.ts"], [2, "apps/a.test.ts"]])), [])
})

test("canonical options do not exclude equal issue numbers in another repository", () => {
  const other = "smithersai/plue"
  const result = candidates(repo, [issue(1)], [], {
    reserved: new Set([`${other}#1`]),
    skip: new Set([`${other}#1`]),
    history: { [`${other}#1`]: { closed: true } }
  })
  assert.deepEqual(result, { candidates: [cand(1)], pending: true })
  assert.deepEqual(candidates(repo, [], []), { candidates: [], pending: false })
})

test("companion ties prefer effort then increasing issue number regardless of input order", () => {
  const bodies = new Map([[1, "apps/a.ts"], [2, "apps/a.ts"], [3, "apps/a.ts"], [4, "apps/a.ts"]])
  assert.deepEqual(
    pick_companions(cand(1), [cand(4), cand(3, { effort: 0 }), cand(2, { effort: 0 })], bodies).map((x) => x.n),
    [2, 3]
  )
})

// Inject only GitHub's process boundary: deterministic read-only evidence without network quota.
test("observation reads real triage JSON and normalizes live GitHub bodies", async () => {
  const dir = await mkdtemp(join(tmpdir(), "burndown-issues-"))
  try {
    const path = join(dir, "triage.json")
    await writeFile(path, JSON.stringify([row(1, "critical", "hard")]))
    let calls = 0
    const result = await Effect.runPromise(
      observeIssues({
        repo: "smithers",
        triagePath: path,
        command: async (requestedRepo, signal) => {
          calls++
          assert.equal(requestedRepo, repo)
          assert.equal(signal.aborted, false)
          return JSON.stringify([{ ...issue(1), body: "apps/a.ts" }, { ...issue(2), body: null }, issue(3)])
        }
      })
    )
    assert.equal(calls, 1)
    assert.deepEqual(result.candidates.map((x) => [x.n, x.severity, x.effort]), [[1, 0, 2], [3, 2, 1], [2, 2, 1]])
    assert.deepEqual(result.issues.map((x) => x.body), ["apps/a.ts", "", ""])
    assert.equal(result.pending, true)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("missing triage defaults ranks while observation supplies current seconds and permits explicit clock", async () => {
  const dir = await mkdtemp(join(tmpdir(), "burndown-issues-"))
  try {
    const options = {
      repo,
      triagePath: join(dir, "missing.json"),
      command: async () => JSON.stringify([issue(1)]),
      selection: { history: { [`${repo}#1`]: { attempts: 1, last: 0 } } }
    }
    assert.deepEqual((await Effect.runPromise(observeIssues(options))).candidates, [cand(1)])
    assert.deepEqual(
      await Effect.runPromise(observeIssues({ ...options, selection: { ...options.selection, now: 1 } })),
      { issues: [{ ...issue(1), body: "" }], candidates: [], pending: true }
    )
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("triage malformed JSON and invalid schema are typed failures before GitHub is invoked", async () => {
  const dir = await mkdtemp(join(tmpdir(), "burndown-issues-"))
  try {
    const path = join(dir, "triage.json")
    for (const content of ["{", JSON.stringify([{ ...row(1), n: "1" }])]) {
      await writeFile(path, content)
      let called = false
      const outcome = await Effect.runPromise(
        Effect.result(observeIssues({
          repo,
          triagePath: path,
          command: async () => {
            called = true
            return "[]"
          }
        }))
      )
      assert.equal(outcome._tag, "Failure")
      if (outcome._tag === "Failure") {
        assert.ok(outcome.failure instanceof IssueReadError)
        assert.equal(outcome.failure.operation, "triage")
        assert.ok(outcome.failure.detail.length > 0)
      }
      assert.equal(called, false)
    }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("GitHub rejection, malformed JSON and invalid schema are typed failures, never empty completion", async () => {
  const dir = await mkdtemp(join(tmpdir(), "burndown-issues-"))
  try {
    for (
      const command of [
        async () => {
          throw new Error("gh refused")
        },
        async () => "{",
        async () => JSON.stringify([{ number: 1, title: "bad", labels: ["bug"] }])
      ]
    ) {
      const outcome = await Effect.runPromise(
        Effect.result(observeIssues({ repo, triagePath: join(dir, "missing"), command }))
      )
      assert.equal(outcome._tag, "Failure")
      if (outcome._tag === "Failure") {
        assert.ok(outcome.failure instanceof IssueReadError)
        assert.equal(outcome.failure.operation, "github")
        assert.ok(outcome.failure.detail.length > 0)
      }
    }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("cancelling observation aborts the running GitHub boundary", async () => {
  const dir = await mkdtemp(join(tmpdir(), "burndown-issues-"))
  const controller = new AbortController()
  try {
    let observedAbort = false
    let started!: () => void
    const ready = new Promise<void>((resolve) => {
      started = resolve
    })
    const promise = Effect.runPromiseExit(
      observeIssues({
        repo,
        triagePath: join(dir, "missing"),
        command: (_repo, signal) =>
          new Promise((_resolve, reject) => {
            signal.addEventListener("abort", () => {
              observedAbort = true
              reject(new Error("aborted"))
            }, { once: true })
            started()
          })
      }),
      { signal: controller.signal }
    )
    await ready
    controller.abort()
    const exit = await promise
    assert.equal(exit._tag, "Failure")
    assert.equal(observedAbort, true)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("non-missing triage read errors are surfaced rather than treated as empty triage", async () => {
  const dir = await mkdtemp(join(tmpdir(), "burndown-issues-"))
  try {
    let called = false
    const outcome = await Effect.runPromise(Effect.result(observeIssues({
      repo,
      triagePath: dir,
      command: async () => {
        called = true
        return "[]"
      }
    })))
    assert.equal(outcome._tag, "Failure")
    if (outcome._tag === "Failure") assert.equal(outcome.failure.operation, "triage")
    assert.equal(called, false)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

// A disposable executable verifies the real subprocess adapter/arguments without external credentials or quota.
test("default GitHub subprocess requests open issues with bodies and propagates command refusal", async () => {
  const dir = await mkdtemp(join(tmpdir(), "burndown-gh-"))
  const priorPath = process.env.PATH
  try {
    const executable = join(dir, "gh")
    await writeFile(
      executable,
      `#!/bin/sh\nif [ "$*" != "issue list --repo smithersai/smithers --state open --limit 1000 --json number,title,labels,body" ]; then exit 7; fi\nprintf '%s' '[{"number":1,"title":"from process","labels":[],"body":"apps/a.ts"}]'\n`,
      { mode: 0o700 }
    )
    process.env.PATH = `${dir}:${priorPath ?? ""}`
    const options = { repo: "smithers", triagePath: join(dir, "missing") }
    const result = await Effect.runPromise(observeIssues(options))
    assert.deepEqual(result.issues, [{ number: 1, title: "from process", labels: [], body: "apps/a.ts" }])
    assert.equal(result.candidates[0]?.title, "from process")
    const bundles = await Effect.runPromise(selectCandidates({ repos: [repo], triagePath: options.triagePath }))
    assert.equal(bundles.candidates[0]?.lead.title, "from process")
    await writeFile(executable, "#!/bin/sh\necho \"permission denied\" >&2\nexit 3\n", { mode: 0o700 })
    const outcome = await Effect.runPromise(Effect.result(observeIssues(options)))
    assert.equal(outcome._tag, "Failure")
    if (outcome._tag === "Failure") {
      assert.equal(outcome.failure.operation, "github")
      assert.match(outcome.failure.detail, /permission denied/)
    }
  } finally {
    if (priorPath === undefined) delete process.env.PATH
    else process.env.PATH = priorPath
    await rm(dir, { recursive: true, force: true })
  }
})

test("missing attempt timestamps use epoch zero and unnamed companion bodies never match", () => {
  assert.equal(
    candidates(repo, [issue(1)], [], { now: 10800, history: { [`${repo}#1`]: { attempts: 1 } } }).candidates.length,
    1
  )
  assert.deepEqual(pick_companions(cand(1), [cand(2)], new Map([[1, "apps/a.ts"]])), [])
  assert.deepEqual(
    pick_companions(cand(1, { blocked: true }), [cand(2)], new Map([[1, "apps/a.ts"], [2, "apps/a.ts"]])),
    []
  )
})

test("repository selection composes ranked bundles, deduplicates repos and never reassigns companions", async () => {
  const dir = await mkdtemp(join(tmpdir(), "burndown-selection-"))
  try {
    const path = join(dir, "triage.json")
    await writeFile(path, JSON.stringify([row(1), row(2), row(3), row(4)]))
    const calls: Array<string> = []
    const result = await Effect.runPromise(
      selectCandidates({
        repos: ["smithers", repo, "plue"],
        triagePath: path,
        exclude: new Set([`${repo}#4`]),
        command: async (r) => {
          calls.push(r)
          return JSON.stringify(
            r === repo
              ? [1, 2, 3, 4].map((n) => ({ ...issue(n), body: "apps/a.ts" }))
              : [issue(8, ["severity:high", "size:hard"])]
          )
        }
      })
    )
    assert.deepEqual(calls, [repo, "smithersai/plue"])
    assert.equal(result.openIssues, 5)
    assert.equal(result.pending, true)
    assert.deepEqual(result.candidates, [
      {
        repo,
        lead: { repo, n: 3, title: "issue 3" },
        extras: [{ repo, n: 1, title: "issue 1" }, { repo, n: 2, title: "issue 2" }],
        severity: "medium",
        effort: "easy"
      },
      {
        repo: "smithersai/plue",
        lead: { repo: "smithersai/plue", n: 8, title: "issue 8" },
        extras: [],
        severity: "high",
        effort: "hard"
      }
    ])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("repository composition preserves pending cooling and propagates read errors", async () => {
  const dir = await mkdtemp(join(tmpdir(), "burndown-selection-"))
  try {
    const triagePath = join(dir, "missing")
    assert.deepEqual(
      await Effect.runPromise(
        selectCandidates({
          repos: [repo],
          triagePath,
          selection: { now: 1, history: { [`${repo}#1`]: { attempts: 1 } } },
          command: async () => JSON.stringify([issue(1)])
        })
      ),
      { candidates: [], openIssues: 1, pending: true }
    )
    const result = await Effect.runPromise(
      Effect.result(selectCandidates({
        repos: [repo],
        triagePath,
        command: async () => {
          throw new Error("refused")
        }
      }))
    )
    assert.equal(result._tag, "Failure")
    if (result._tag === "Failure") assert.equal(result.failure.operation, "github")
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

// Override only home discovery to exercise the default location with a real isolated file.
test("omitted triage path reads dispatch final.json beneath the discovered home", async () => {
  const dir = await mkdtemp(join(tmpdir(), "burndown-home-"))
  const home = mock.method(os, "homedir", () => dir)
  syncBuiltinESMExports()
  try {
    const dispatch = join(dir, "Smithers-Ops", "dispatch")
    await mkdir(dispatch, { recursive: true })
    await writeFile(join(dispatch, "final.json"), JSON.stringify([row(1, "low", "trivial")]))
    const result = await Effect.runPromise(observeIssues({ repo, command: async () => JSON.stringify([issue(1)]) }))
    assert.deepEqual(result.candidates, [cand(1, { severity: 3, effort: 0 })])
    const bundles = await Effect.runPromise(
      selectCandidates({ repos: [repo], command: async () => JSON.stringify([issue(1)]) })
    )
    assert.equal(bundles.candidates[0]?.severity, "low")
    assert.equal(bundles.candidates[0]?.effort, "trivial")
  } finally {
    home.mock.restore()
    syncBuiltinESMExports()
    await rm(dir, { recursive: true, force: true })
  }
})

test("composition keeps explicit canonical skips, maps low/unknown severity and trivial effort", async () => {
  const dir = await mkdtemp(join(tmpdir(), "burndown-selection-"))
  try {
    const path = join(dir, "triage.json")
    await writeFile(path, JSON.stringify([row(1, "low", "trivial"), row(2, "n/a", "trivial")]))
    const result = await Effect.runPromise(
      selectCandidates({
        repos: [repo],
        triagePath: path,
        selection: { skip: new Set([`${repo}#3`, `${repo}#4`]) },
        command: async () => JSON.stringify([issue(1), issue(2), issue(3), issue(4)])
      })
    )
    assert.deepEqual(result.candidates.map((x) => [x.lead.n, x.severity, x.effort, x.extras]), [[
      1,
      "low",
      "trivial",
      []
    ], [2, "unknown", "trivial", []]])
    assert.equal(result.openIssues, 4)
    assert.equal(result.pending, true)
    assert.deepEqual(await Effect.runPromise(selectCandidates({ repos: [] })), {
      candidates: [],
      openIssues: 0,
      pending: false
    })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("composition exclusions suppress only canonical issue keys across equal repository numbers", async () => {
  const dir = await mkdtemp(join(tmpdir(), "burndown-selection-"))
  try {
    const result = await Effect.runPromise(
      selectCandidates({
        repos: [repo, "smithersai/plue"],
        triagePath: join(dir, "missing"),
        exclude: new Set([`${repo}#1`]),
        command: async () => JSON.stringify([issue(1), issue(2)])
      })
    )
    assert.deepEqual(result.candidates.map((x) => `${x.repo}#${x.lead.n}`), [
      `${repo}#2`,
      "smithersai/plue#2",
      "smithersai/plue#1"
    ])
    assert.equal(result.openIssues, 4)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

// Public composition accepts canonical exclusions; bare issue numbers are intentionally not a cross-repo option.
const disallowedSelection: SelectOptions = {
  repos: [],
  selection: {
    // @ts-expect-error taken is repository-local and excluded from the composition API.
    taken: new Set([1])
  }
}
void disallowedSelection

// Will's rule (#2916): security, money, merge/landing, unclear root cause and cross-package design never bundle.
test("never-bundle classes are neither companions nor bundle leads, by label or title", async () => {
  const classes: ReadonlyArray<readonly [Array<string>, string]> = [
    [["security"], "tighten token check"],
    [[], "Security: redact webhook secret"],
    [["billing"], "fix invoice rounding"],
    [[], "Pricing page shows stale plan"],
    [[], "Credit balance off by one"],
    [["area:merge-queue"], "retry flaky rebase"],
    [[], "Lander pushes stale receipt"],
    [[], "Unclear root cause: runs stall"],
    [["needs-design"], "share run state"],
    [[], "Cross-package design for run ids"]
  ]
  const issues = [
    { ...issue(1), body: "apps/a.ts" },
    { ...issue(2), body: "apps/a.ts" },
    ...classes.map(([labels, title], i) => ({ ...issue(10 + i, labels, title), body: "apps/a.ts" }))
  ]
  const result = await Effect.runPromise(selectCandidates({
    repos: [repo],
    triagePath: join(tmpdir(), "burndown-missing-triage.json"),
    command: async () => JSON.stringify(issues)
  }))
  const bundled = result.candidates.filter((bundle) => bundle.extras.length > 0)
  assert.deepEqual(bundled.map((bundle) => [bundle.lead.n, bundle.extras.map((extra) => extra.n)]), [[2, [1]]])
  assert.equal(result.candidates.length, 2 + classes.length - 1)
})
