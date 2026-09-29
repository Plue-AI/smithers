import { NodeCrypto } from "@effect/platform-node"
import * as NodeServices from "@effect/platform-node/NodeServices"
import * as MemoryCalibration from "@smthrs/agent/MemoryCalibration"
import { FlowEngine } from "@smthrs/engine"
import { Action, Interpreter } from "@smthrs/flow"
import * as Evaluator from "@smthrs/model/Evaluator"
import { Cause, Effect, Exit, Layer, ManagedRuntime } from "effect"
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { test } from "node:test"
import { fileURLToPath } from "node:url"
import * as Calibrate from "../memory/calibrate.ts"
import * as CalibrateFlow from "../memory/calibrate/flow.ts"
import * as Labels from "../memory/labels.ts"
import * as Landed from "../memory/landed.ts"
import * as Thresholds from "../memory/thresholds.ts"

// A PATH guard refuses git and jj to agent sessions; the temp repositories
// below are this test's own.
delete process.env.CLAUDECODE
delete process.env.CODEX_THREAD_ID
delete process.env.OPENCODE

const here = dirname(fileURLToPath(import.meta.url))
const fixture = join(here, "fixtures", "memory-calibrate-e2e.jsonl")

// ---------------------------------------------------------------------------
// Labels
// ---------------------------------------------------------------------------

test("a real memory run labels its withheld-then-read directories and never-used items", async () => {
  const run = Labels.fromEvents(Labels.parseJsonl(await readFile(fixture, "utf8")))
  const needed = run.labels.filter((label) => label.needed)
  // The run grepped apps/tui and packages/smithers/agent after Jev withheld both parents.
  assert.deepEqual(
    needed.map(({ decision, id, p, source }) => ({ decision, id, p, source })),
    [
      { decision: "descend", id: "apps", p: 0.29, source: "withheld-then-read" },
      { decision: "descend", id: "packages/smithers", p: 0.17, source: "withheld-then-read" }
    ]
  )
  const unused = run.labels.filter((label) => !label.needed)
  assert.ok(unused.length > 0)
  assert.ok(unused.every((label) => label.source === "never-used" && label.weight === Labels.neverUsedWeight))
  assert.deepEqual(
    new Set(unused.map((label) => label.decision)),
    new Set(["descend", "page", "skill", "file", "commit"])
  )
  // Every label's p is the reading's raw probability for that item.
  assert.deepEqual(unused.find((label) => label.id === "smithers-memory")?.p, 0.64)
  assert.equal(run.restores, 0)
  assert.ok(run.withheldFlows > 0)
})

const reading = (
  classifier: "memory/needed" | "memory/descend",
  items: ReadonlyArray<Record<string, string>>,
  ps: ReadonlyArray<number>
) => ({
  _tag: "decision-settled",
  classifier,
  state: { context: { task: "t" }, items },
  answers: Object.fromEntries(
    ps.map((p, index) => [`${classifier === "memory/descend" ? "descend" : "needed"}_${index}`, { kind: "boolean", p }])
  )
})
const started = (flowName: string, input: Record<string, unknown>) => ({
  _tag: "cell-call-started",
  call: { flowName, input }
})
const settledMemory = (
  kept: ReadonlyArray<{ kind: string; id: string; p: number }>,
  omitted: ReadonlyArray<{ kind: string; id: string; p: number }>
) => ({ _tag: "cell-call-settled", flowName: "memory", result: { outcome: "success", value: { kept, omitted } } })

test("every label kind: withheld-then-read, kept-and-used, never-used, restores and instruction misses", () => {
  const events = [
    {
      _tag: "relevance-settled",
      withheld: [{ kind: "flow", id: "deploy" }, { kind: "flow", id: "wiki" }, {
        kind: "instruction",
        id: "/repo/AGENTS.md#2"
      }, { kind: "instruction", id: "/repo/docs/AGENTS.md#0" }]
    },
    started("memory", { task: "t" }),
    reading("memory/descend", [{ path: "src", about: "" }, { path: "docs", about: "" }, { path: "web", about: "" }], [
      0.8,
      0.1,
      0.05
    ]),
    reading("memory/needed", [
      { kind: "file", id: "src/a.ts", head: "" },
      { kind: "file", id: "src/b.ts", head: "" },
      { kind: "file", id: "src/c.ts", head: "" },
      { kind: "page", id: "start-here", head: "" },
      { kind: "commit", id: "0123456789ab", head: "" },
      { kind: "file", id: "src/d.ts", head: "" }
    ], [0.7, 0.2, 0.1, 0.5, 0.6, 0.9]),
    settledMemory(
      [{ kind: "file", id: "src/a.ts", p: 0.7 }, { kind: "page", id: "start-here", p: 0.5 }, {
        kind: "commit",
        id: "0123456789ab",
        p: 0.6
      }, { kind: "file", id: "src/d.ts", p: 0.9 }],
      [{ kind: "file", id: "src/b.ts", p: 0.2 }, { kind: "dir", id: "docs", p: 0.1 }, {
        kind: "file",
        id: "src/c.ts",
        p: 0.1
      }, {
        kind: "dir",
        id: "web",
        p: 0.05
      }]
    ),
    started("read", { path: "/repo/src/a.ts" }),
    started("grep", { pattern: "parse", root: "src/b.ts" }),
    started("bash", { command: "jj show 0123456789ab" }),
    started("read", { path: "AGENTS.md" }),
    { _tag: "relevance-restored", flow: "deploy" },
    { _tag: "resolved", message: { content: [{ type: "text", text: "Fixed in src/d.ts." }] } }
  ]
  const run = Labels.fromEvents(events)
  const byId = Object.fromEntries(run.labels.map((label) => [label.id, label]))
  assert.deepEqual(byId["src/a.ts"], {
    decision: "file",
    id: "src/a.ts",
    p: 0.7,
    needed: true,
    source: "kept-and-used"
  })
  assert.deepEqual(byId["src/b.ts"], {
    decision: "file",
    id: "src/b.ts",
    p: 0.2,
    needed: true,
    source: "withheld-then-read"
  })
  // A withheld item nothing names carries no label.
  assert.equal(byId["src/c.ts"], undefined)
  assert.equal(byId["web"], undefined)
  assert.equal(byId["docs"], undefined)
  assert.deepEqual(byId["start-here"], {
    decision: "page",
    id: "start-here",
    p: 0.5,
    needed: false,
    weight: 0.2,
    source: "never-used"
  })
  assert.equal(byId["0123456789ab"]?.source, "kept-and-used")
  // Named only by the answer.
  assert.equal(byId["src/d.ts"]?.source, "kept-and-used")
  // A walked directory is in neither list; a later call under it uses it.
  assert.deepEqual(byId["src"], { decision: "descend", id: "src", p: 0.8, needed: true, source: "kept-and-used" })
  assert.equal(run.restores, 1)
  assert.equal(run.withheldFlows, 2)
  assert.equal(run.instructionMisses, 1)
  const grouped = Labels.byDecision(run.labels)
  assert.equal(grouped.file.length, 3)
  assert.deepEqual(grouped.page, [{ p: 0.5, needed: false, weight: 0.2 }])
})

test("readings no successful memory call claims yield no labels", () => {
  const events = [
    reading("memory/needed", [{ kind: "file", id: "a.ts", head: "" }], [0.1]),
    { _tag: "cell-call-settled", flowName: "memory", result: { outcome: "failure" } },
    started("read", { path: "a.ts" })
  ]
  assert.deepEqual(Labels.fromEvents(events).labels, [])
})

test("a failed memory call's readings are never claimed by the next successful call", () => {
  const events = [
    reading("memory/needed", [{ kind: "file", id: "src/a.ts", head: "" }, { kind: "file", id: "src/x.ts", head: "" }], [
      0.7,
      0.6
    ]),
    { _tag: "cell-call-settled", flowName: "memory", result: { outcome: "failure" } },
    reading("memory/needed", [{ kind: "file", id: "src/b.ts", head: "" }], [0.8]),
    settledMemory([{ kind: "file", id: "src/b.ts", p: 0.8 }], []),
    started("read", { path: "src/a.ts" }),
    started("read", { path: "src/b.ts" })
  ]
  // Only the successful call's own reading is labelled: a.ts is not
  // withheld-then-read and x.ts is not never-used.
  assert.deepEqual(Labels.fromEvents(events).labels, [
    { decision: "file", id: "src/b.ts", p: 0.8, needed: true, source: "kept-and-used" }
  ])
})

test("mentions matches whole paths, absolute paths under the root and files under a directory only", () => {
  assert.ok(Labels.mentions("/repo/src/a.ts", "src/a.ts", "/repo"))
  assert.ok(Labels.mentions("/repo/apps/tui/src/host.ts", "apps/tui", "/repo"))
  assert.ok(Labels.mentions("cat src/a.ts && ls", "src/a.ts"))
  assert.ok(Labels.mentions("cat ./src/a.ts", "src/a.ts"))
  assert.ok(Labels.mentions("src/a.ts.", "src/a.ts"))
  assert.ok(Labels.mentions("see `src/a.ts:12`", "src/a.ts"))
  assert.ok(Labels.mentions("apps/tui/src/host.ts", "apps/tui"))
  assert.ok(!Labels.mentions("src/a.tsx", "src/a.ts"))
  assert.ok(!Labels.mentions("xsrc/a.ts", "src/a.ts"))
  assert.ok(!Labels.mentions("apps/tuiX", "apps/tui"))
  assert.ok(!Labels.mentions("a.b.ts", "b.ts"))
  // A root path never matches a nested path with the same suffix.
  assert.ok(!Labels.mentions("packages/smithers/agent/README.md", "README.md", "/repo"))
  assert.ok(!Labels.mentions("cat apps/tui/package.json", "package.json", "/repo"))
  assert.ok(!Labels.mentions("/repo/packages/smithers/docs/x.md", "docs", "/repo"))
  // An absolute path resolves against the run's root only.
  assert.ok(!Labels.mentions("/other/src/a.ts", "src/a.ts", "/repo"))
  assert.ok(!Labels.mentions("/src/a.ts", "src/a.ts"))
})

test("a root file withheld is not read by a nested file with the same name", () => {
  const events = [
    { _tag: "relevance-settled", kept: [{ kind: "instruction", id: "/repo/AGENTS.md#0" }], withheld: [] },
    reading("memory/descend", [{ path: "docs", about: "" }], [0.1]),
    reading("memory/needed", [
      { kind: "file", id: "README.md", head: "" },
      { kind: "file", id: "package.json", head: "" },
      { kind: "file", id: "src/a.ts", head: "" }
    ], [0.2, 0.1, 0.1]),
    settledMemory([], [
      { kind: "file", id: "README.md", p: 0.2 },
      { kind: "file", id: "package.json", p: 0.1 },
      { kind: "dir", id: "docs", p: 0.1 },
      { kind: "file", id: "src/a.ts", p: 0.1 }
    ]),
    started("read", { path: "/repo/packages/smithers/agent/README.md" }),
    started("bash", { command: "cat apps/tui/package.json" }),
    started("read", { path: "packages/smithers/docs/index.md" }),
    started("read", { path: "/repo/src/a.ts" })
  ]
  assert.deepEqual(Labels.fromEvents(events).labels, [
    { decision: "file", id: "src/a.ts", p: 0.1, needed: true, source: "withheld-then-read" }
  ])
})

test("a global instruction file outside the repository leaves the run root at the repository", () => {
  const events = [
    {
      _tag: "relevance-settled",
      kept: [
        { kind: "instruction", id: "/Users/x/.smithers/agent/AGENTS.md#0" },
        { kind: "instruction", id: "/Users/x/repo/AGENTS.md#0" }
      ],
      withheld: [{ kind: "instruction", id: "/Users/x/repo/apps/tui/AGENTS.md#1" }]
    },
    reading("memory/needed", [
      { kind: "file", id: "src/a.ts", head: "" },
      { kind: "file", id: "src/b.ts", head: "" }
    ], [0.2, 0.7]),
    settledMemory([{ kind: "file", id: "src/b.ts", p: 0.7 }], [{ kind: "file", id: "src/a.ts", p: 0.2 }]),
    started("read", { path: "/Users/x/repo/src/a.ts" }),
    started("read", { path: "/Users/x/repo/src/b.ts" }),
    started("read", { path: "/Users/x/repo/apps/tui/AGENTS.md" })
  ]
  const run = Labels.fromEvents(events)
  assert.deepEqual(run.labels, [
    { decision: "file", id: "src/a.ts", p: 0.2, needed: true, source: "withheld-then-read" },
    { decision: "file", id: "src/b.ts", p: 0.7, needed: true, source: "kept-and-used" }
  ])
  assert.equal(run.instructionMisses, 1)
})

test("an apply_patch call uses the files its patch touches; a grep uses its globs", () => {
  const patch = [
    "*** Begin Patch",
    "*** Update File: src/a.ts",
    "@@",
    "-old",
    "+new",
    "*** Update File: src/b.ts",
    "*** Move to: src/c.ts",
    "@@",
    "-x",
    "+y",
    "*** End Patch"
  ].join("\n")
  const events = [
    { _tag: "relevance-settled", kept: [{ kind: "instruction", id: "/repo/AGENTS.md#0" }], withheld: [] },
    reading("memory/needed", [
      { kind: "file", id: "src/a.ts", head: "" },
      { kind: "file", id: "src/b.ts", head: "" },
      { kind: "file", id: "src/c.ts", head: "" },
      { kind: "file", id: "lib/d.ts", head: "" }
    ], [0.2, 0.7, 0.1, 0.1]),
    settledMemory([{ kind: "file", id: "src/b.ts", p: 0.7 }], [
      { kind: "file", id: "src/a.ts", p: 0.2 },
      { kind: "file", id: "src/c.ts", p: 0.1 },
      { kind: "file", id: "lib/d.ts", p: 0.1 }
    ]),
    started("apply_patch", { input: patch }),
    started("grep", { pattern: "x", globs: ["lib/d.ts"] })
  ]
  assert.deepEqual(Labels.fromEvents(events).labels, [
    { decision: "file", id: "src/a.ts", p: 0.2, needed: true, source: "withheld-then-read" },
    { decision: "file", id: "src/b.ts", p: 0.7, needed: true, source: "kept-and-used" },
    { decision: "file", id: "src/c.ts", p: 0.1, needed: true, source: "withheld-then-read" },
    { decision: "file", id: "lib/d.ts", p: 0.1, needed: true, source: "withheld-then-read" }
  ])
})

/** `events` as the TUI persists them: a `session` header, then wrapped events among other records. */
const sessionRows = (cwd: string, events: ReadonlyArray<unknown>): ReadonlyArray<unknown> => [
  { type: "session", version: 1, id: "s", cwd, createdAt: 0 },
  { type: "user", at: 0, text: "task" },
  ...events.map((event, at) => ({ type: "event", at, event })),
  { type: "outcome", at: 0 }
]

test("a TUI launched in a subdirectory resolves absolute reads against the session's cwd", () => {
  const events = [
    {
      _tag: "relevance-settled",
      kept: [{ kind: "instruction", id: "/repo/AGENTS.md#0" }, {
        kind: "instruction",
        id: "/repo/apps/tui/AGENTS.md#0"
      }],
      withheld: []
    },
    reading("memory/needed", [
      { kind: "file", id: "src/host.ts", head: "" },
      { kind: "file", id: "src/flows.ts", head: "" }
    ], [0.2, 0.7]),
    settledMemory([{ kind: "file", id: "src/flows.ts", p: 0.7 }], [{ kind: "file", id: "src/host.ts", p: 0.2 }]),
    started("read", { path: "/repo/apps/tui/src/host.ts" }),
    started("read", { path: "/repo/apps/tui/src/flows.ts" })
  ]
  const journal = Labels.journalOf(sessionRows("/repo/apps/tui", events))
  assert.equal(journal.cwd, "/repo/apps/tui")
  assert.equal(journal.events.length, events.length)
  assert.deepEqual(Labels.fromEvents(journal.events, journal.cwd).labels, [
    { decision: "file", id: "src/host.ts", p: 0.2, needed: true, source: "withheld-then-read" },
    { decision: "file", id: "src/flows.ts", p: 0.7, needed: true, source: "kept-and-used" }
  ])
})

test("a repository under a hidden directory resolves against the session's cwd", () => {
  const root = "/Users/x/.worktrees/repo"
  const events = [
    { _tag: "relevance-settled", kept: [{ kind: "instruction", id: `${root}/AGENTS.md#0` }], withheld: [] },
    reading("memory/needed", [{ kind: "file", id: "src/a.ts", head: "" }], [0.2]),
    settledMemory([], [{ kind: "file", id: "src/a.ts", p: 0.2 }]),
    started("read", { path: `${root}/src/a.ts` })
  ]
  const journal = Labels.journalOf(sessionRows(root, events))
  assert.deepEqual(Labels.fromEvents(journal.events, journal.cwd).labels, [
    { decision: "file", id: "src/a.ts", p: 0.2, needed: true, source: "withheld-then-read" }
  ])
})

test("journals read the TUI session form under per-cwd folders; a file with no event fails typed", async () => {
  const flat = Labels.parseJsonl(await readFile(fixture, "utf8"))
  const expected = Labels.fromEvents(flat)
  assert.ok(expected.labels.length > 0)
  const sessions = await tempDir("memory-sessions-")
  try {
    const folder = join(sessions, "--repo--0123456789ab")
    await mkdir(join(folder, "workers"), { recursive: true })
    const body = (rows: ReadonlyArray<unknown>) => rows.map((row) => `${JSON.stringify(row)}\n`).join("")
    const cwd = "/Users/williamcory/smithers-lane-memory"
    await writeFile(join(folder, "2026-09-28_a.jsonl"), body(sessionRows(cwd, flat)))
    await writeFile(join(folder, "workers", "2026-09-28_b.jsonl"), body(sessionRows(cwd, flat)))
    const read = await Effect.runPromise(Calibrate.journalLabels(sessions))
    assert.deepEqual(read, { runs: [expected, expected], skipped: 0 })

    // A session with a header and no harness event is a tab that never ran an agent: skipped, counted.
    await writeFile(
      join(folder, "2026-09-29_c.jsonl"),
      body([{ type: "session", version: 1, id: "c", cwd, createdAt: 0 }, { type: "user", text: "hi" }])
    )
    assert.deepEqual(await Effect.runPromise(Calibrate.journalLabels(sessions)), {
      runs: [expected, expected],
      skipped: 1
    })

    // Anything else with no harness event is not a run with no labels.
    await writeFile(join(folder, "2026-09-29_d.jsonl"), body([{ type: "user", text: "no header" }]))
    const failure = await Effect.runPromise(Effect.flip(Calibrate.journalLabels(sessions)))
    assert.ok(failure instanceof Calibrate.JournalInvalid)
    assert.equal(failure.path, join(folder, "2026-09-29_d.jsonl"))
    assert.equal(failure.message, "no harness events")
  } finally {
    await rm(sessions, { recursive: true, force: true })
  }
})

test("an answer naming a kept page or skill uses it; a longer token or a path under it does not", () => {
  const events = [
    reading("memory/needed", [
      { kind: "page", id: "start-here", head: "" },
      { kind: "skill", id: "smithers-memory", head: "" },
      { kind: "dep", id: "effect", head: "" },
      { kind: "page", id: "memory", head: "" },
      { kind: "page", id: "packages", head: "" }
    ], [0.5, 0.6, 0.4, 0.3, 0.2]),
    settledMemory([
      { kind: "page", id: "start-here", p: 0.5 },
      { kind: "skill", id: "smithers-memory", p: 0.6 },
      { kind: "dep", id: "effect", p: 0.4 },
      { kind: "page", id: "memory", p: 0.3 }
    ], [{ kind: "page", id: "packages", p: 0.2 }]),
    // A path under a same-named directory names neither the dep nor the page.
    started("read", { path: "node_modules/effect/package.json" }),
    started("grep", { pattern: "x", root: "packages/smithers" }),
    {
      _tag: "resolved",
      message: {
        content: [{
          type: "text",
          text: "Per the start-here page and the smithers-memory skill, done; memory-flow aside."
        }]
      }
    }
  ]
  const sources = Object.fromEntries(Labels.fromEvents(events).labels.map((label) => [label.id, label.source]))
  assert.deepEqual(sources, {
    "start-here": "kept-and-used",
    "smithers-memory": "kept-and-used",
    effect: "never-used",
    memory: "never-used"
  })
})

// ---------------------------------------------------------------------------
// Calibrate
// ---------------------------------------------------------------------------

/** Separable labels: needed items at p 0.9, unneeded at p 0.1. */
const separable = (count: number): ReadonlyArray<MemoryCalibration.Label> =>
  Array.from({ length: count }, (_, index) => ({ p: index % 2 === 0 ? 0.9 : 0.1, needed: index % 2 === 0 }))

const withTau = (decision: MemoryCalibration.Decision, tau: number): MemoryCalibration.Thresholds => ({
  ...MemoryCalibration.initial,
  decisions: {
    ...MemoryCalibration.initial.decisions,
    [decision]: { ...MemoryCalibration.initial.decisions[decision], tau }
  }
})

test("calibrate refits a decision with 200 labels and keeps the rest", () => {
  const { receipt, thresholds } = Calibrate.calibrate({
    labels: { file: separable(200) },
    current: MemoryCalibration.initial,
    recallAtBudget: 0.5,
    items: 100,
    unjudged: 400,
    restoreRate: 0.1,
    instructionMisses: 2
  })
  assert.deepEqual(receipt.perDecision.file, { labels: 200, outcome: "refit", from: 0.35, proposed: 0.35, to: 0.35 })
  assert.notEqual(thresholds.decisions.file.reliability, null)
  assert.deepEqual(receipt.perDecision.page, {
    labels: 0,
    outcome: "too_few_labels",
    from: 0.35,
    proposed: 0.35,
    to: 0.35
  })
  assert.deepEqual(thresholds.decisions.page, MemoryCalibration.initial.decisions.page)
  assert.equal(receipt.n, 200)
  assert.equal(receipt.recallAtBudget, 0.5)
  assert.equal(receipt.items, 100)
  assert.equal(receipt.unjudged, 400)
  assert.equal(receipt.restoreRate, 0.1)
  assert.equal(receipt.instructionMisses, 2)
  assert.deepEqual(Object.keys(receipt.perDecision).sort(), [...MemoryCalibration.Decision.literals].sort())
})

test("calibrate refuses 199 labels and keeps the current setting", () => {
  const current = withTau("file", 0.4)
  const { receipt, thresholds } = Calibrate.calibrate({ labels: { file: separable(199) }, current })
  assert.equal(receipt.perDecision.file.outcome, "too_few_labels")
  assert.equal(receipt.perDecision.file.proposed, 0.35)
  assert.equal(receipt.perDecision.file.to, 0.4)
  assert.deepEqual(thresholds.decisions.file, current.decisions.file)
  assert.equal(receipt.recallAtBudget, null)
  assert.equal(receipt.restoreRate, null)
})

test("calibrate refuses a 0.06 move and lands a 0.05 one", () => {
  const far = Calibrate.calibrate({ labels: { descend: separable(200) }, current: withTau("descend", 0.36) })
  assert.deepEqual(far.receipt.perDecision.descend, {
    labels: 200,
    outcome: "move_too_large",
    from: 0.36,
    proposed: 0.3,
    to: 0.36
  })
  assert.equal(far.thresholds.decisions.descend.reliability, null)
  const near = Calibrate.calibrate({ labels: { descend: separable(200) }, current: withTau("descend", 0.35) })
  assert.equal(near.receipt.perDecision.descend.outcome, "refit")
  assert.equal(near.receipt.perDecision.descend.to, 0.3)
})

// ---------------------------------------------------------------------------
// Thresholds file
// ---------------------------------------------------------------------------

const tempDir = (prefix: string) => mkdtemp(join(tmpdir(), prefix))

test("thresholds: absent is the declared defaults; write then load round-trips deterministically", async () => {
  const root = await tempDir("memory-thresholds-")
  try {
    assert.deepEqual(await Effect.runPromise(Thresholds.load(root)), MemoryCalibration.initial)
    const fitted = withTau("file", 0.33)
    const receipt = { z: 1, a: { y: 2, b: 3 } }
    await Effect.runPromise(Thresholds.write(root, fitted, receipt))
    assert.deepEqual(await Effect.runPromise(Thresholds.load(root)), fitted)
    const text = await readFile(join(root, Thresholds.file), "utf8")
    assert.ok(text.endsWith("}\n"))
    assert.equal(text, Thresholds.stable(JSON.parse(text)))
    assert.ok(
      text.indexOf("\"decisions\"") < text.indexOf("\"model\"") &&
        text.indexOf("\"model\"") < text.indexOf("\"version\"")
    )
    assert.equal(
      await readFile(join(root, Thresholds.receiptFile), "utf8"),
      "{\n  \"a\": {\n    \"b\": 3,\n    \"y\": 2\n  },\n  \"z\": 1\n}\n"
    )
    // Writing the same fit twice writes the same bytes.
    await Effect.runPromise(Thresholds.write(root, fitted, receipt))
    assert.equal(await readFile(join(root, Thresholds.file), "utf8"), text)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("thresholds: a malformed or mis-shaped file fails typed and never falls back", async () => {
  const root = await tempDir("memory-thresholds-bad-")
  try {
    await mkdir(join(root, ".smithers"))
    for (const body of ["{not json", JSON.stringify({ ...MemoryCalibration.initial, decisions: {} })]) {
      await writeFile(join(root, Thresholds.file), body)
      const failure = await Effect.runPromise(Effect.flip(Thresholds.load(root)))
      assert.ok(failure instanceof Thresholds.ThresholdsInvalid)
      assert.equal(failure.path, join(root, Thresholds.file))
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// Landed fixes, on a real jj repository
// ---------------------------------------------------------------------------

const sh = (cwd: string, command: string, args: ReadonlyArray<string>) =>
  execFileSync(command, args, { cwd, encoding: "utf8", stdio: "pipe" })

const repository = async () => {
  const root = await tempDir("memory-landed-")
  sh(root, "jj", ["git", "init", "--colocate", root])
  sh(root, "jj", ["config", "set", "--repo", "user.name", "Test"])
  sh(root, "jj", ["config", "set", "--repo", "user.email", "test@example.com"])
  await mkdir(join(root, "src"))
  await mkdir(join(root, "web"))
  await writeFile(join(root, "README.md"), "# Parser\n\nsrc holds the parser; web holds the site.\n")
  await writeFile(join(root, "src", "parse.ts"), "export const parse = (text: string) => text.split(\",\")\n")
  await writeFile(join(root, "src", "format.ts"), "export const format = (rows: string[]) => rows.join(\",\")\n")
  await writeFile(join(root, "web", "index.ts"), "export const page = \"home\"\n")
  // Kept, and larger than the budget: the block carries a head of it.
  await writeFile(join(root, "src", "big.ts"), `export const rows = [\n${"  \"row\",\n".repeat(6000)}]\n`)
  sh(root, "jj", ["commit", "-m", "Add the parser and the site"])
  // An empty commit between the two: the last 2 non-empty commits skip it.
  sh(root, "jj", ["commit", "-m", "Empty"])
  await writeFile(
    join(root, "src", "parse.ts"),
    "export const parse = (text: string) => text.split(\",\").map((cell) => cell.trim())\n"
  )
  sh(root, "jj", ["commit", "-m", "Trim cells when splitting rows"])
  sh(root, "jj", ["bookmark", "create", "main", "-r", "@-"])
  const fix = sh(root, "jj", ["log", "-r", "main", "--no-graph", "-T", "commit_id", "--ignore-working-copy"]).trim()
  sh(root, "/usr/bin/git", [
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.com",
    "notes",
    "--ref=refs/notes/mythical",
    "add",
    "-m",
    "---\nversion: 2\nissue: 42\n---\n",
    fix
  ])
  return { root, fix }
}

/** Every item Jev was shown. */
const shown: Array<Record<string, string>> = []

/** Jev: the parser file, the big file and their directory are needed, nothing else. */
const jev = Evaluator.layerScripted((request) => {
  const items = (request.state as { readonly items: ReadonlyArray<Record<string, string>> }).items
  shown.push(...items)
  return Object.fromEntries(
    Object.keys(request.questions).map((id) => {
      const item = items[Number(id.slice(id.lastIndexOf("_") + 1))]!
      const name = item.path ?? item.id
      return [id, { probability: name === "src" || name === "src/parse.ts" || name === "src/big.ts" ? 0.9 : 0.1 }]
    })
  )
})
const provided = Layer.merge(NodeServices.layer, jev)

test("landed fixes: recall@budget and labels on a real two-commit repository", async () => {
  const { fix, root } = await repository()
  try {
    const commits = await Effect.runPromise(Landed.landedCommits(root, 2).pipe(Effect.provide(NodeServices.layer)))
    assert.equal(commits.length, 2)
    const [second, first] = commits
    assert.equal(second!.commit, fix)
    assert.equal(second!.issue, 42)
    assert.equal(second!.description, "Trim cells when splitting rows\n")
    assert.deepEqual(second!.touched, ["src/parse.ts"])
    assert.deepEqual(second!.existing, ["src/parse.ts"])
    assert.equal(first!.issue, undefined)
    // Every file of the first commit was added, so none existed in its parent.
    assert.deepEqual(first!.existing, [])
    assert.equal(Landed.taskOf(second!), "Trim cells when splitting rows\n\nissue #42")

    shown.length = 0
    const results = await Effect.runPromise(Landed.evaluateAll(root, commits).pipe(Effect.provide(provided)))
    // Jev judged the parent's tree: the parser head without the fix, and never
    // the fix commit itself.
    const parse = shown.filter((item) => item.id === "src/parse.ts")
    assert.ok(parse.length > 0)
    assert.ok(parse.every((item) => item.head !== undefined && !item.head.includes("trim")))
    assert.ok(!shown.some((item) => item.kind === "commit" && item.id?.startsWith(fix.slice(0, 12))))
    // The temporary workspace is forgotten afterwards.
    assert.equal(sh(root, "jj", ["workspace", "list", "--ignore-working-copy", "-T", "name ++ \"\\n\""]), "default\n")
    assert.deepEqual(results[0]!.found, ["src/parse.ts"])
    assert.equal(results[0]!.recall, 1)
    assert.equal(results[0]!.seeded, 0)
    assert.equal(results[1]!.recall, null)
    // bytes is the packed block, never the kept files' whole sizes.
    assert.ok(results[0]!.bytes > 0 && results[0]!.bytes <= Landed.budget, String(results[0]!.bytes))
    const labels = Object.fromEntries(results[0]!.labels.map((label) => [`${label.decision}:${label.id}`, label]))
    assert.deepEqual(labels["file:src/parse.ts"], {
      decision: "file",
      id: "src/parse.ts",
      p: 0.9,
      needed: true,
      source: "landed"
    })
    assert.equal(labels["file:src/format.ts"]?.needed, false)
    assert.equal(labels["file:src/big.ts"]?.needed, false)
    assert.equal(labels["descend:src"]?.needed, true)
    assert.equal(labels["descend:web"]?.needed, false)
    assert.deepEqual(Landed.recallAtBudget(results), {
      recall: 1,
      items: 1,
      unjudged: 0,
      needed: 1,
      found: 1,
      meanPerItem: 1
    })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("landed fixes: a renamed file's source existed in the parent; both paths were touched", async () => {
  const root = await tempDir("memory-landed-rename-")
  try {
    sh(root, "jj", ["git", "init", "--colocate", root])
    await mkdir(join(root, "src"))
    await writeFile(join(root, "src", "a.ts"), "export const a = 1\nexport const b = 2\nexport const c = 3\n")
    await writeFile(join(root, "src", "gone.ts"), "export const gone = 1\n")
    sh(root, "jj", ["commit", "-m", "Add"])
    await rename(join(root, "src", "a.ts"), join(root, "lib.ts"))
    await writeFile(
      join(root, "lib.ts"),
      "export const a = 1\nexport const b = 2\nexport const c = 3\nexport const d = 4\n"
    )
    await rm(join(root, "src", "gone.ts"))
    await writeFile(join(root, "new.ts"), "export const fresh = 1\n")
    sh(root, "jj", ["commit", "-m", "Move a to lib"])
    sh(root, "jj", ["bookmark", "create", "main", "-r", "@-"])
    const [moved] = await Effect.runPromise(Landed.landedCommits(root, 1).pipe(Effect.provide(NodeServices.layer)))
    assert.deepEqual([...moved!.touched].sort(), ["lib.ts", "new.ts", "src/a.ts", "src/gone.ts"])
    assert.deepEqual([...moved!.existing].sort(), ["src/a.ts", "src/gone.ts"])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("landed fixes: an unreachable Jev leaves the commit unjudged and out of recall@budget", async () => {
  const { root } = await repository()
  try {
    const down = Layer.merge(
      NodeServices.layer,
      Evaluator.layerScripted(() => Effect.fail(new Evaluator.EvaluatorError({ code: "unreachable", message: "down" })))
    )
    const commits = await Effect.runPromise(Landed.landedCommits(root, 2).pipe(Effect.provide(NodeServices.layer)))
    const results = await Effect.runPromise(Landed.evaluateAll(root, commits).pipe(Effect.provide(down)))
    assert.equal(results[0]!.unjudged, "unreachable")
    assert.deepEqual(results[0]!.needed, ["src/parse.ts"])
    assert.deepEqual(Landed.recallAtBudget(results), {
      recall: null,
      items: 0,
      unjudged: 1,
      needed: 0,
      found: 0,
      meanPerItem: null
    })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("the flow resolves journals against the repository and refuses a path outside it", async () => {
  const root = "/repo"
  assert.equal(await Effect.runPromise(CalibrateFlow.journalsUnder(root, ".smithers/runs")), "/repo/.smithers/runs")
  assert.equal(await Effect.runPromise(CalibrateFlow.journalsUnder(root, "/repo/runs")), "/repo/runs")
  assert.equal(await Effect.runPromise(CalibrateFlow.journalsUnder(root, "..runs")), "/repo/..runs")
  for (const escape of ["../other", "/tmp/runs", "runs/../../x"]) {
    const failure = await Effect.runPromise(Effect.flip(CalibrateFlow.journalsUnder(root, escape)))
    assert.ok(failure instanceof Calibrate.JournalInvalid)
  }
})

test("landed fixes fail typed outside a jj repository", async () => {
  const root = await tempDir("memory-landed-none-")
  try {
    const failure = await Effect.runPromise(Effect.flip(Landed.landedCommits(root, 2)).pipe(Effect.provide(provided)))
    assert.ok(failure instanceof Landed.LandedFailed)
    assert.match(failure.message, /^jj log .*exit \d+/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("recallAtBudget pools found over needed and skips items with nothing needed", () => {
  const item = (needed: number, found: number) => ({
    commit: "c",
    needed: Array.from({ length: needed }, (_, index) => `f${index}`),
    found: Array.from({ length: found }, (_, index) => `f${index}`),
    seeded: 0,
    recall: needed === 0 ? null : found / needed,
    bytes: 0,
    jevMs: 0,
    labels: []
  })
  assert.deepEqual(
    Landed.recallAtBudget([item(4, 1), item(1, 1), item(0, 0), { ...item(3, 0), unjudged: "timeout" }]),
    {
      recall: 0.4,
      items: 2,
      unjudged: 1,
      needed: 5,
      found: 2,
      meanPerItem: 0.625
    }
  )
  assert.deepEqual(Landed.recallAtBudget([]), {
    recall: null,
    items: 0,
    unjudged: 0,
    needed: 0,
    found: 0,
    meanPerItem: null
  })
})

test("noteIssue reads the issue from a mythical note's front matter only", () => {
  assert.equal(Landed.noteIssue("---\nversion: 2\nissue: 7\n---\n\n## Evidence\n"), 7)
  assert.equal(Landed.noteIssue("---\nversion: 2\n---\n\nissue: 7\n"), undefined)
  assert.equal(Landed.noteIssue("no front matter"), undefined)
})

test("run writes no thresholds without write and writes the fit with it", async () => {
  const { root } = await repository()
  const journals = await tempDir("memory-journals-")
  try {
    await writeFile(join(journals, "e2e-run.jsonl"), await readFile(fixture, "utf8"))
    await writeFile(join(journals, "other.jsonl"), "{not json\n")
    const options = { root, journals, journalPrefix: "e2e", landed: 2 }
    const dry = await Effect.runPromise(Calibrate.run({ ...options, write: false }).pipe(Effect.provide(provided)))
    assert.equal(dry.written, false)
    await assert.rejects(stat(join(root, Thresholds.file)))
    assert.equal(dry.evidence.journals, 1)
    assert.equal(dry.receipt.recallAtBudget, 1)
    assert.equal(dry.receipt.items, 1)
    assert.equal(dry.receipt.unjudged, 0)
    assert.equal(dry.receipt.perDecision.file.outcome, "too_few_labels")
    assert.equal(
      dry.receipt.n,
      dry.evidence.labelSources["withheld-then-read"]! +
        dry.evidence.labelSources["kept-and-used"]! + dry.evidence.labelSources["never-used"]! +
        dry.evidence.labelSources.landed!
    )

    const wet = await Effect.runPromise(Calibrate.run({ ...options, write: true }).pipe(Effect.provide(provided)))
    assert.equal(wet.written, true)
    assert.deepEqual(await Effect.runPromise(Thresholds.load(root)), wet.thresholds)
    assert.deepEqual(JSON.parse(await readFile(join(root, Thresholds.receiptFile), "utf8")), wet.receipt)

    // A truncated journal fails typed, naming the file.
    const failure = await Effect.runPromise(
      Effect.flip(Calibrate.run({ ...options, journalPrefix: "other", write: false })).pipe(Effect.provide(provided))
    )
    assert.ok(failure instanceof Calibrate.JournalInvalid)
    assert.equal(failure.path, join(journals, "other.jsonl"))
    const missing = await Effect.runPromise(
      Effect.flip(Calibrate.run({ ...options, journals: join(journals, "absent"), write: false })).pipe(
        Effect.provide(provided)
      )
    )
    assert.ok(missing instanceof Calibrate.JournalInvalid)
    assert.equal(missing.path, join(journals, "absent"))
    // Both entry points share the cap: run refuses more than maxLanded commits.
    for (const landed of [Calibrate.maxLanded + 1, -1, 1.5]) {
      const capped = await Effect.runPromise(
        Effect.flip(Calibrate.run({ ...options, landed, write: false })).pipe(Effect.provide(provided))
      )
      assert.ok(capped instanceof Landed.LandedFailed)
      assert.match(capped.message, /^landed must be an integer from 0 to 500/)
    }
  } finally {
    await rm(root, { recursive: true, force: true })
    await rm(journals, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// The flow, through the flow runtime
// ---------------------------------------------------------------------------

/** Runs `memory/calibrate` with `layer(root)` on the in-memory engine. */
const runFlow = async (root: string, payload: typeof CalibrateFlow.default.payloadSchema.Type, id: string) => {
  const host = ManagedRuntime.make(
    Layer.mergeAll(
      CalibrateFlow.layer(root).pipe(Layer.provide(provided)),
      Interpreter.layer(CalibrateFlow.default)
    ).pipe(
      Layer.provideMerge(Action.layerImplementations),
      Layer.provideMerge(FlowEngine.layerMemory),
      Layer.provideMerge(NodeCrypto.layer)
    )
  )
  try {
    return await host.runPromiseExit(CalibrateFlow.default.execute(payload, { executionId: id }))
  } finally {
    await host.dispose()
  }
}

test("the calibrate flow runs through the flow runtime: a decoded success and a typed failure", async () => {
  const { root } = await repository()
  const bare = await tempDir("memory-flow-no-main-")
  try {
    await mkdir(join(root, ".smithers", "runs"), { recursive: true })
    await writeFile(join(root, ".smithers", "runs", "e2e-run.jsonl"), await readFile(fixture, "utf8"))
    const exit = await runFlow(root, { journals: ".smithers/runs", landed: 2, write: true }, "calibrate-ok")
    assert.ok(Exit.isSuccess(exit), Exit.isFailure(exit) ? Cause.pretty(exit.cause) : "")
    const success = exit.value
    assert.equal(success.written, true)
    assert.equal(success.evidence.journals, 1)
    assert.equal(success.evidence.landed.commits.length, 2)
    assert.equal(success.receipt.recallAtBudget, 1)
    assert.equal(success.receipt.items, 1)
    assert.equal(success.receipt.unjudged, 0)
    assert.deepEqual(JSON.parse(await readFile(join(root, Thresholds.receiptFile), "utf8")), success.receipt)

    // A jj repository without a main bookmark: jj log fails, typed.
    sh(bare, "jj", ["git", "init", "--colocate", bare])
    const failed = await runFlow(bare, { landed: 1, write: false }, "calibrate-no-main")
    assert.ok(Exit.isFailure(failed))
    const error = Cause.squash(failed.cause)
    assert.ok(error instanceof Landed.LandedFailed, String(error))
    assert.match(error.message, /^jj log .*exit \d+/)
  } finally {
    await rm(root, { recursive: true, force: true })
    await rm(bare, { recursive: true, force: true })
  }
})
