/**
 * Proves `lib/jev-replay.mjs` rebuilds the supervisor's snapshot from a
 * journal, offline, and scores readings the way its report claims.
 *
 *   node fixtures/check-jev-replay.mjs
 *
 * One synthetic journal is written to a temp dir with the `control.agent.*`
 * rows the harness journals: the arming, a first request carrying the task,
 * and seven frames (a read-only frame, an edit, a failing check re-run over
 * the same tree, a completion the claim brake hands back, a rejected cell, a
 * passing check, and a completion that stands). The replay is run in
 * `--dry-run`, so nothing is asked and nothing is spent, and the snapshots are
 * asserted field by field against what `CellTurn` would have offered. The scoreboard is then fed hand-written
 * readings so precision and recall are checked on numbers a person can add up.
 *
 * `jev-gates-journal.json` is then replayed through the command line: two
 * relevance decisions, three monitor readings, one delivery and one restore.
 * The printed withheld, crossing, delivered and resolved rates are asserted,
 * every reading is checked against `Monitor.lint`, and `scorecard.ts` is run
 * over the same journal for its gate counts.
 *
 * Offline, spends nothing, needs no docker.
 *
 * @since 0.1.0
 */
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { fileURLToPath } from "node:url"
import {
  emptyGates,
  gates,
  gatesMarkdown,
  lintAgrees,
  parseArguments,
  replay,
  scoreboard,
  snapshots,
  withholdThresholds
} from "../lib/jev-replay.mjs"
import { read } from "../lib/journal-facts.mjs"

const temporary = mkdtempSync(join(tmpdir(), "flows-swebench-jev-replay-"))

/** Writes one journal database out of a list of `[type, payload]` events. */
const journal = (name, events, root = temporary) => {
  const directory = join(root, name)
  mkdirSync(directory, { recursive: true })
  const path = join(directory, "engine.db")
  const database = new DatabaseSync(path)
  database.exec(
    "create table flows_journal_events ("
      + " run_id text not null, seq integer not null, event_id text not null unique,"
      + " source_id text not null, source_seq integer not null, emitted_at_ms integer not null,"
      + " event_type text not null, payload_json text not null, meta_json text not null,"
      + " primary key (run_id, seq))"
  )
  const insert = database.prepare(
    "insert into flows_journal_events"
      + " (run_id, seq, event_id, source_id, source_seq, emitted_at_ms, event_type, payload_json, meta_json)"
      + " values (?, ?, ?, ?, ?, ?, ?, ?, ?)"
  )
  events.forEach(([type, payload], index) => {
    insert.run("run-1", index, `e${index}`, "agent", index, 1000 + index, type, JSON.stringify(payload), "{}")
  })
  database.close()
  return path
}

const opened = ["control.agent.turn-opened", { seat: "openai:gpt-5.6-sol" }]
const requested = (
  frame,
  system
) => ["control.agent.model-requested", { scope: "s", frame, attempt: 1, purpose: "frame", system }]
const settled = (text) => ["control.agent.model-settled", { text, usage: { inputTokens: 1, outputTokens: 1 } }]
const produced = (text) => ["control.agent.cell-produced", { language: "js", digest: "d", text }]
const printed = (text) => ["control.agent.cell-printed", { cell: "d", text }]
const call = (flowName, input, value = {}, outcome = "success") => [
  ["control.agent.cell-call-started", { flowName, input }],
  ["control.agent.cell-call-settled", { flowName, outcome, value }]
]
const observed = (
  digest,
  mutated
) => ["control.agent.mutation-observed", {
  basis: "observed",
  digest,
  mutated,
  paths: 3,
  declaredWrites: mutated ? 1 : 0
}]
const transition = (tag) => ["control.agent.transition-applied", { transition: { _tag: tag } }]

try {
  const claim = (demanded) => ["control.agent.claim-demanded", {
    complete: 0.9,
    overclaims: 0.1,
    invented: demanded ? 0.9 : 0.1,
    latencyMs: 300,
    demanded,
    currentDigest: "t1",
    nextFrame: 4
  }]
  const rejected = ["control.agent.cell-settled", {
    cell: "",
    outcome: { _tag: "rejected", code: "no_cell", message: "No cell was found" }
  }]
  const path = journal("one__one-1", [
    // The arming the first frame journals: the budget and no approval channel.
    ["control.agent.discipline-armed", { maxFrames: 10, approvalChannel: false }],
    // Frame 0: the task travels in the first request's last system text. A
    // grep that changes nothing.
    requested(0, ["cell contract", "flow catalog", "The task for this run:\n\nFix add()."]),
    opened,
    // The run's opening measurement, which is what `treeMoved` compares against.
    ["flows.time-travel.effect-boundary", {
      effect: {
        kind: "harness/boundary/workspace-open",
        status: "succeeded",
        output: { _tag: "Some", value: { digest: "t0", complete: true } }
      }
    }],
    settled("Looking first.\n\n```cell\nawait ctx.call('grep', {pattern:'add'})\n```"),
    produced("await ctx.call('grep', {pattern:'add'})"),
    ...call("grep", { pattern: "add" }, { matches: [] }),
    printed("no matches"),
    observed("t0", false),
    transition("continue"),
    // Frame 1: an edit that moves the tree, then the check fails.
    opened,
    settled("Editing.\n\n```cell\n...\n```"),
    produced("await ctx.call('edit', {path:'a.py'}); await ctx.call('bash', {command:'pytest'})"),
    ...call("edit", { path: "a.py" }, {}),
    ...call("bash", { command: "pytest" }, { exitCode: 1, stdout: "1 failed" }),
    printed("1 failed"),
    observed("t1", true),
    transition("continue"),
    // Frame 2: the same check again over the unchanged tree, still failing,
    // and the run is told it is repeating itself.
    opened,
    settled("Retrying.\n\n```cell\n...\n```"),
    produced("await ctx.call('bash', {command:'pytest'})"),
    ...call("bash", { command: "pytest" }, { exitCode: 1, stdout: "1 failed" }),
    printed("1 failed"),
    observed("t1", false),
    transition("continue"),
    ["control.agent.repeat-demanded", { frames: 1, cap: 1, nextFrame: 3 }],
    // Frame 3: a completion the claim brake hands back. The run continues
    // through it, so the live supervisor is offered it.
    opened,
    settled("Done.\n\n```cell\nctx.done('fixed')\n```"),
    produced("ctx.done('fixed')"),
    printed(""),
    observed("t1", false),
    transition("complete"),
    claim(true),
    // Frame 4: prose and no cell. The parser rejects it, and a rejected frame
    // is never offered.
    opened,
    settled("I think it is fixed."),
    rejected,
    // Frame 5: a check that passes.
    opened,
    settled("Checking.\n\n```cell\nawait ctx.call('bash', {command:'pytest -q'})\n```"),
    produced("await ctx.call('bash', {command:'pytest -q'})"),
    ...call("bash", { command: "pytest -q" }, { exitCode: 0, stdout: "1 passed" }),
    printed("1 passed"),
    observed("t1", false),
    transition("continue"),
    // Frame 6: a completion the brake lets stand. The run ends on it, so no
    // live boundary offers it.
    opened,
    settled("Done.\n\n```cell\nctx.done('fixed')\n```"),
    produced("ctx.done('fixed')"),
    printed(""),
    observed("t1", false),
    transition("complete"),
    claim(false)
  ])

  const facts = read(path)
  assert.equal(facts.task, "The task for this run:\n\nFix add().", "the task is the first request's last system text")
  assert.equal(facts.frames.length, 7)
  assert.equal(
    facts.frames[1].cell,
    "await ctx.call('edit', {path:'a.py'}); await ctx.call('bash', {command:'pytest'})"
  )
  assert.equal(facts.frames[2].printed, "1 failed")
  assert.equal(facts.armed.maxFrames, 10)

  const built = snapshots(facts)
  assert.deepEqual(
    built.map((snapshot) => snapshot.signals.frame),
    [0, 1, 2, 3, 5],
    "the rejected frame and the accepted completion are never offered; the bounced completion is"
  )
  assert.equal(built[0].frames.length, 1)
  assert.equal(built[2].frames.length, 3, "the third snapshot carries the newest three frames")
  assert.deepEqual(built[4].frames.map((frame) => frame.frame), [2, 3, 5], "recent frames are offered frames")
  assert.equal(built[2].task, facts.task)
  assert.equal("recalled" in built[2], false)
  assert.equal(built[2].frames[2].transition, "continue")
  assert.equal(built[2].frames[1].mutated, true)
  // The fenced cell is stripped, as the live supervisor strips it.
  assert.equal(built[2].frames[2].prose, "Retrying.")
  assert.equal("candidates" in built[2], false)
  assert.equal(built[3].frames[2].transition, "complete")

  const s0 = built[0].signals
  assert.equal(s0.frame, 0)
  assert.equal(s0.maxFrames, 10, "the budget comes from discipline-armed")
  assert.equal(s0.readOnlyFrames, 1, "frame 0 changed nothing")
  assert.equal(s0.repeatFrames, 0)
  assert.equal(s0.mutations, 0)
  assert.equal(s0.treeMoved, false)
  assert.equal(s0.paths, 3, "the paths the closing measurement covered")
  assert.equal(s0.checksRun, 1, "the grep is a check")
  assert.equal(s0.checksFailing, 0)
  assert.equal(s0.callsSettled, 1)

  const s1 = built[1].signals
  assert.equal(s1.readOnlyFrames, 0, "frame 1 moved the tree")
  assert.equal(s1.mutations, 1)
  assert.equal(s1.treeMoved, true)
  assert.equal(s1.checksFailing, 1, "pytest last reported failing")
  assert.equal(s1.failuresUnanswered, 1)
  assert.equal(s1.callsSettled, 3)

  const s2 = built[2].signals
  assert.equal(s2.readOnlyFrames, 1)
  assert.equal(s2.repeatFrames, 1, "frame 2 issued only a call frame 1 had issued, and changed nothing")
  assert.equal(s2.mutations, 1)
  assert.equal(s2.checksRun, 2, "grep and pytest are the distinct checks")
  assert.equal(s2.checksFailing, 1)
  assert.equal(s2.callsFailed, 0)
  assert.equal(s2.narrowingDemands, 0)
  assert.equal(s2.claimDemands, 0)
  assert.equal(s2.sufficiencyStated, false)

  // The bounce is counted from the frame after it, as `State.claimDemands` is;
  // the reading that let the completion stand is not a demand.
  assert.equal(built[3].signals.claimDemands, 0)
  assert.equal(built[4].signals.claimDemands, 1)

  // The snapshot encodes under the harness's own schema, which is what the
  // live path sends: a shape drift here would be `invalid_question` on the wire.
  const { Schema } = await import("effect")
  const Supervisor = await import("../../../packages/smithers/agent/harness/src/Supervisor.ts")
  for (const snapshot of built) Schema.encodeUnknownSync(Supervisor.Snapshot)(snapshot)

  // The dry run through the command surface: one journal, five offered frames, no ask.
  const options = parseArguments([temporary, "--dry-run", "--suffix", "-1"])
  const report = await replay(options, {})
  assert.equal(report.journals, 1)
  assert.equal(report.frames, 5)
  assert.equal(report.readings, 0)
  assert.equal(report.runs[0].id, "one__one")
  assert.equal(report.runs[0].label, undefined, "no manifest, no label")

  // A directory whose names carry no matching suffix holds no journals.
  const none = await replay(parseArguments([temporary, "--dry-run", "--suffix", "-r97"]), {})
  assert.equal(none.journals, 0)

  // The scoreboard on numbers a person can add up. Positive predicts unresolved.
  const reading = (thrashing, onTarget, needsHelp = "none", frustrated = "none", extra = {}) => ({
    thrashing,
    onTarget,
    suspect: 0.1,
    outdatedContext: 0.1,
    irrelevantContext: 0.1,
    emotions: { frustrated, anxious: "none", scared: "none", confused: "none", confident: "none" },
    needsHelp,
    ...extra
  })
  const board = scoreboard([
    { id: "a", label: "unresolved", readings: [reading(0.2, 0.9), reading(0.8, 0.9, "stuck", "strong")] },
    { id: "b", label: "unresolved", readings: [reading(0.2, 0.9)] },
    { id: "c", label: "resolved", readings: [reading(0.9, 0.9)] },
    { id: "d", label: "resolved", readings: [reading(0.1, 0.9)] },
    { id: "e", label: undefined, readings: [reading(0.9, 0.1)] },
    { id: "f", label: "unresolved", readings: [] }
  ])
  assert.equal(board.labelled, 4, "an unlabelled run and a run with no reading score nothing")
  assert.equal(board.unresolved, 2)
  const rowOf = (from) => (signal, frame) => from.rows.find((entry) => entry.signal === signal && entry.frame === frame)
  const row = rowOf(board)
  const crossedLast = row("crossed", "last")
  assert.deepEqual([crossedLast.tp, crossedLast.fp, crossedLast.fn, crossedLast.tn], [1, 1, 1, 1])
  assert.equal(crossedLast.precision, 0.5)
  assert.equal(crossedLast.recall, 0.5)
  const thrashingAny = row("thrashing", "any")
  assert.deepEqual([thrashingAny.tp, thrashingAny.fp, thrashingAny.fn, thrashingAny.tn], [1, 1, 1, 1])
  const stuck = row("needs_help=stuck", "any")
  assert.deepEqual([stuck.tp, stuck.fp, stuck.fn, stuck.tn], [1, 0, 1, 2])
  assert.equal(stuck.precision, 1)
  const frustrated = row("frustrated=strong", "last")
  assert.deepEqual([frustrated.tp, frustrated.fp], [1, 0])
  assert.ok(row("confident=mild|strong", "any") !== undefined)
  assert.ok(row("needs_help!=none", "last") !== undefined)
  // One row per trigger the live rule is made of, and the rule itself.
  for (const signal of ["crossed", "thrashing", "off_target", "suspect", "outdated_context", "irrelevant_context"]) {
    assert.ok(row(signal, "last") !== undefined && row(signal, "any") !== undefined, signal)
  }

  // The live inequalities, at their thresholds: `judge` crosses at exactly
  // 0.5 on every trigger, so the replay does too, and a context trigger
  // crosses on its own.
  for (
    const [at, signal] of [
      [reading(0.5, 0.9), "thrashing"],
      [reading(0.1, 0.5), "off_target"],
      [reading(0.1, 0.9, "none", "none", { suspect: 0.5 }), "suspect"],
      [reading(0.1, 0.9, "none", "none", { outdatedContext: 0.5 }), "outdated_context"],
      [reading(0.1, 0.9, "none", "none", { irrelevantContext: 0.5 }), "irrelevant_context"]
    ]
  ) {
    const edge = rowOf(scoreboard([{ id: "g", label: "unresolved", readings: [at] }]))
    assert.equal(edge(signal, "last").tp, 1, `${signal} fires at its threshold`)
    assert.equal(edge("crossed", "last").tp, 1, `${signal} alone crosses`)
  }
  const below = rowOf(scoreboard([{ id: "h", label: "unresolved", readings: [reading(0.49, 0.51)] }]))
  assert.equal(below("crossed", "last").tp, 0, "just inside every threshold crosses nothing")

  // Without a key the live path refuses before reading a journal.
  await assert.rejects(replay(parseArguments([temporary]), {}), /AI_GATEWAY_API_KEY/)

  // The gates, from the committed synthetic journal, through the command line.
  const here = dirname(fileURLToPath(import.meta.url))
  const gateEvents = JSON.parse(readFileSync(join(here, "jev-gates-journal.json"), "utf8"))
  const gateRoot = join(temporary, "gates")
  const gatePath = journal("gates__gates-1", gateEvents, gateRoot)
  assert.deepEqual(withholdThresholds, [0.8, 0.9, 0.95], "the live withholdAt is the middle threshold")
  const replayed = spawnSync(process.execPath, [
    join(here, "..", "lib", "jev-replay.mjs"),
    gateRoot,
    "--dry-run",
    "--suffix",
    "-1"
  ], {
    encoding: "utf8",
    timeout: 60_000
  })
  assert.equal(replayed.status, 0, replayed.stderr)
  for (
    const line of [
      "decisions: 2, unreadable: 0",
      "| flow | 1 | 100% | 100% | 100% |",
      "| instruction | 1 | 0% | 0% | 0% |",
      "| memory | 2 | 50% | 50% | 0% |",
      "| skill | 1 | 100% | 0% | 0% |",
      "readings checked against Monitor.lint: 3",
      "| supervisor | 0 | 3 | 67% | 50% | 100% | cooldown:1 |",
      "| use_jev | 1 | 3 | 67% | 0% | - | streak:2 |"
    ]
  ) assert.ok(replayed.stdout.includes(line), `the replay prints ${line}\n${replayed.stdout}`)
  const gateReport = await replay(parseArguments([gateRoot, "--dry-run"]), {})
  assert.equal(gateReport.gates.lintChecked, 3)
  assert.equal(gateReport.gates.monitors.supervisor.resolved, 1, "frame 1 passed the failing check")

  // The lint monitor and the replay's rule agree on every reading, crossing or not.
  const supervisorReadings = gateEvents.filter(([type]) => type === "control.agent.supervisor-settled")
    .map(([, payload]) => payload)
  assert.deepEqual(supervisorReadings.map(lintAgrees), [1, 0, 1])
  for (
    const at of [
      reading(0.5, 0.9),
      reading(0.1, 0.5),
      reading(0.49, 0.51),
      reading(0.1, 0.9, "none", "none", { irrelevantContext: 0.5 })
    ]
  ) {
    lintAgrees(at)
  }

  // A delivery resolved by an `on_target` rise, one left unresolved, a bounded
  // decision and an item of no kind, folded directly.
  const rows = (events) => events.map(([type, payload], seq) => ({ seq, type, payload }))
  const noChecks = { frames: [0, 1, 2, 3, 4, 5].map(() => ({ frameChecks: [], ledgerBefore: [] })) }
  const turn = ["control.agent.turn-opened", {}]
  const readAt = (frame, onTarget) => ["control.agent.supervisor-settled", {
    frame,
    thrashing: 0.1,
    onTarget,
    suspect: 0.1,
    monitors: [{ id: "careful", kind: "mood", p: 1, crossed: true }]
  }]
  const deliver = ["control.agent.steering-drained", { messages: [], monitor: "careful" }]
  const direct = gates(
    noChecks,
    rows([
      turn,
      readAt(0, 0.6),
      deliver,
      turn,
      readAt(1, 0.7),
      turn,
      deliver,
      ["control.agent.decision-settled", {
        classifier: "relevance/unnecessary",
        state: { truncated: true },
        answers: []
      }],
      ["control.agent.decision-settled", {
        classifier: "relevance/unnecessary",
        state: { items: [] },
        answers: [{ id: "unnecessary_0", kind: "boolean", p: 0.99 }, { id: "other", kind: "boolean", p: 1 }]
      }],
      ["control.agent.decision-settled", { classifier: "supervisor/turn", answers: { truncated: true } }],
      ["control.agent.decision-settled", { classifier: "seat/route", answers: [] }]
    ])
  )
  assert.equal(direct.monitors.careful.delivered, 2)
  assert.equal(
    direct.monitors.careful.resolved,
    1,
    "on_target rose after the first delivery; nothing followed the second"
  )
  assert.deepEqual(direct.relevance, {
    decisions: 2,
    unreadable: 1,
    kinds: { unknown: { items: 1, withheld: { 0.8: 1, 0.9: 1, 0.95: 1 } } }
  })
  assert.ok(gatesMarkdown(emptyGates()).includes("decisions: 0, unreadable: 0"))
  // A newly passing check resolves with no reading at all; one already passing does not.
  const passing = (signature) => ({ signature, passing: true })
  const checked = (before, ran) =>
    gates(
      {
        frames: [{ frameChecks: [], ledgerBefore: [] }, {
          frameChecks: [passing(ran)],
          ledgerBefore: [passing(before)]
        }]
      },
      rows([turn, deliver])
    ).monitors.careful.resolved
  assert.equal(checked("a", "b"), 1)
  assert.equal(checked("a", "a"), 0)

  // The scorecard counts what the gates did.
  const work = join(temporary, "work", "gates__gates", ".flows")
  mkdirSync(work, { recursive: true })
  const copy = new DatabaseSync(join(work, "engine.db"))
  copy.exec(`attach database '${gatePath}' as source`)
  copy.exec("create table flows_journal_events as select * from source.flows_journal_events")
  copy.close()
  writeFileSync(join(temporary, "report.json"), JSON.stringify({ resolved_ids: ["gates__gates"] }))
  const scored = spawnSync(process.execPath, [
    join(here, "..", "scorecard.ts"),
    "--work",
    join(temporary, "work"),
    "--patches",
    join(temporary, "patches"),
    "--timings",
    join(temporary, "timings"),
    "--report",
    join(temporary, "report.json"),
    "--subject",
    join(temporary, "subject.json"),
    "--out",
    temporary,
    "--instances",
    "gates__gates"
  ], { encoding: "utf8", timeout: 60_000 })
  assert.equal(scored.status, 0, scored.stderr)
  const card = JSON.parse(readFileSync(join(temporary, "scorecard.json"), "utf8"))
  assert.deepEqual(card.instances[0].gates, {
    relevanceWithheld: { flow: 1, memory: 1 },
    relevanceRestored: 1,
    monitorsDelivered: { supervisor: 1 },
    memoryDelivered: 1,
    compactionRemoved: 2
  })
  assert.ok(
    readFileSync(join(temporary, "scorecard.md"), "utf8").includes(
      "| gates__gates | flow:1 memory:1 | 1 | supervisor:1 | 1 | 2 |"
    )
  )

  console.log("check-jev-replay: ok")
} finally {
  rmSync(temporary, { recursive: true, force: true })
}
