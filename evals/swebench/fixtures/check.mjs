/**
 * Asserts a fixture scorecard against the numbers it was built from.
 *
 *   node fixtures/check.mjs [expect-latency|expect-no-latency]
 *
 * The fixture journal carries the 2026-08-19 wave's recorded numbers; the
 * scorecard must report exactly those, and must reach the same buckets the wave
 * reached against the committed codex baseline. That half reads the scorecard
 * `verify.sh` generated and runs only when a mode is given.
 *
 * Every run first scores `jev-callers-journal.json`, a synthetic journal with
 * one reading per Jev caller, in a throwaway directory: each row's caller, the
 * scorecard's per-caller counts and `lib/run-cost.mjs`'s price.
 */
import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { fileURLToPath } from "node:url"
import { jevCaller, jevCellQuestionsOf, jevUsageOf } from "../jev-usage.ts"
import { readCost } from "../lib/run-cost.mjs"
import { jevModel, usd } from "../prices.ts"

const here = dirname(fileURLToPath(import.meta.url))
const mode = process.argv[2]
const read = (path) => JSON.parse(readFileSync(path, "utf8"))

const failures = []
const check = (label, actual, expected) => {
  if (actual !== expected) failures.push(`${label}: expected ${expected}, got ${actual}`)
}

// ---------------------------------------------------------------------------
// Jev, split by caller
// ---------------------------------------------------------------------------

const journal = read(join(here, "jev-callers-journal.json"))
const expectedCallers = [
  undefined,
  undefined,
  undefined,
  undefined,
  "cell",
  undefined,
  undefined,
  undefined,
  undefined,
  undefined,
  "brake",
  "supervisor",
  undefined,
  "gate",
  undefined,
  undefined,
  undefined
]
check("jev callers journal rows", journal.length, expectedCallers.length)
journal.forEach(([eventType, payload], index) =>
  check(`jev caller of row ${index} (${eventType})`, jevCaller(eventType, payload), expectedCallers[index])
)
// A failed `jev` call is still the cell's, but Jev answered nothing to price.
const failedCall = { flowName: "jev", outcome: "failure", message: "refused" }
check("failed jev call caller", jevCaller("control.agent.cell-call-settled", failedCall), "cell")
check("failed jev call usage", jevUsageOf("control.agent.cell-call-settled", failedCall), undefined)
check("model-settled caller", jevCaller("control.agent.model-settled", {}), undefined)
check("classifier-less decision caller", jevCaller("control.agent.decision-settled", {}), undefined)
// A result the journal bounded to a marker has an unknown question count, never zero.
const marker = { truncated: true, bytes: 70_000, digest: "sha256:marker" }
check("marker questions", jevCellQuestionsOf({ flowName: "jev", outcome: "success", value: marker }), undefined)
check(
  "marker usage",
  jevUsageOf("control.agent.cell-call-settled", {
    flowName: "jev",
    outcome: "success",
    value: marker
  }),
  undefined
)

const ddl = `CREATE TABLE flows_journal_events (
  run_id TEXT NOT NULL, seq INTEGER NOT NULL, event_id TEXT NOT NULL UNIQUE, source_id TEXT NOT NULL,
  source_seq INTEGER NOT NULL, emitted_at_ms INTEGER NOT NULL, event_type TEXT NOT NULL,
  payload_json TEXT NOT NULL, meta_json TEXT NOT NULL, PRIMARY KEY (run_id, seq)
)`
const temporary = mkdtempSync(join(tmpdir(), "swebench-jev-callers-"))
try {
  // The same journal twice: as recorded, and with the `jev` result bounded to a marker.
  const bounded = journal.map((
    [eventType, payload]
  ) => [
    eventType,
    eventType === "control.agent.cell-call-settled" && payload.flowName === "jev"
      ? { ...payload, value: marker }
      : payload
  ])
  const instances = { "jev__callers-1": journal, "jev__callers-2": bounded }
  for (const [id, events] of Object.entries(instances)) {
    mkdirSync(join(temporary, "work", id, ".flows"), { recursive: true })
    const database = new DatabaseSync(join(temporary, "work", id, ".flows", "engine.db"))
    database.exec(ddl)
    const insert = database.prepare("insert into flows_journal_events values (?, ?, ?, ?, ?, ?, ?, ?, ?)")
    events.forEach(([eventType, payload], index) =>
      insert.run(
        id,
        index,
        `${id}-${index}`,
        "fixture",
        index,
        1_755_500_000_000 + index,
        eventType,
        JSON.stringify(payload),
        "{}"
      )
    )
    database.close()
  }
  const ids = Object.keys(instances)
  writeFileSync(join(temporary, "report.json"), JSON.stringify({ resolved_ids: ids }))
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
    ids.join(",")
  ], { encoding: "utf8", timeout: 60_000 })
  check("jev callers scorecard exit", scored.status, 0)
  if (scored.status !== 0) failures.push(scored.stderr)
  else {
    const rows = read(join(temporary, "scorecard.json")).instances
    const columns = (row) =>
      [
        row.cost.jevCellCalls,
        row.cost.jevCellQuestions,
        row.cost.jevCellQuestionsUnknown,
        row.cost.jevBrakeReadings,
        row.cost.jevSupervisorReadings,
        row.cost.jevGateReadings,
        `${row.cost.cellsWithJev}/${row.cost.cells}`,
        row.cost.jevUnjudged
      ].join(" ")
    check("jev callers columns", columns(rows[0]), "1 3 0 1 1 1 1/2 2")
    check("bounded jev callers columns", columns(rows[1]), "1 0 1 1 1 1 1/2 2")
    // The cell, the brake, the supervisor and the gate, each once; the
    // supervisor's own `decision-settled` is not a fifth reading.
    check("jev callers input tokens", rows[0].cost.jevInputTokens, 12_000)
    check("jev callers output tokens", rows[0].cost.jevOutputTokens, 100)
    const jevUsd = usd(jevModel, { inputTokens: 12_000, cachedInputTokens: 0, outputTokens: 100 }).usd
    check("jev callers usd", rows[0].cost.jevUsd, jevUsd)
    const cost = readCost(join(temporary, "work", ids[0], ".flows", "engine.db"))
    check("run-cost jev calls", cost.jevCalls, 4)
    check("run-cost jev input tokens", cost.jevInputTokens, 12_000)
    check("run-cost jev usd", cost.jevUsd, jevUsd)
    const boundedCost = readCost(join(temporary, "work", ids[1], ".flows", "engine.db"))
    check("bounded run-cost jev calls", boundedCost.jevCalls, 4)
    check("bounded run-cost unknown", boundedCost.unknown, true)
    check("bounded run-cost jev usd", boundedCost.jevUsd, null)
    check("bounded run-cost total usd", boundedCost.totalUsd, null)
  }
} finally {
  rmSync(temporary, { recursive: true, force: true })
}

// ---------------------------------------------------------------------------
// The recorded wave
// ---------------------------------------------------------------------------

const wave = () => {
  const mirror = read(join(here, "mirror-results.json"))
  const baseline = read(join(here, "..", "baseline", "codex-comparison.json"))
  const card = read(join(here, "scorecard.json"))

  const bucket = (flows, codex) =>
    flows === "resolved" && codex !== "resolved" ?
      "FLOWS WIN"
      : codex === "resolved" && flows !== "resolved" ?
      "codex win"
      : flows === "resolved"
      ? "both pass"
      : "both fail"

  check("instance count", card.instances.length, mirror.length)
  for (const expected of mirror) {
    const row = card.instances.find((instance) => instance.instanceId === expected.id)
    if (row === undefined) {
      failures.push(`${expected.id}: missing from the scorecard`)
      continue
    }
    const codex = baseline.find((entry) => entry.id === expected.id).codex
    check(`${expected.id} verdict`, row.quality.verdict, expected.graded)
    check(`${expected.id} patch bytes`, row.quality.patchBytes, expected.patchBytes)
    check(`${expected.id} edits attempted`, row.quality.editsAttempted, expected.edits)
    check(`${expected.id} edits succeeded`, row.quality.editsSucceeded, expected.editsOk)
    check(`${expected.id} turns`, row.speed.turns, expected.turns)
    check(`${expected.id} flow calls`, row.speed.flowCalls, expected.calls)
    check(`${expected.id} refusals`, row.speed.flowCallsRefused, expected.failed)
    check(`${expected.id} wall clock`, row.speed.wallClockSeconds, expected.seconds)
    check(`${expected.id} input tokens`, row.cost.inputTokens, expected.inTok)
    check(`${expected.id} output tokens`, row.cost.outputTokens, expected.outTok)
    check(`${expected.id} model`, row.cost.model, "openai:gpt-5.6-sol")
    check(`${expected.id} baseline verdict`, row.baseline?.verdict, codex.verdict)
    check(`${expected.id} bucket`, row.callout, bucket(expected.graded, codex.verdict))

    // Cost is the price table applied to the reported tokens, recomputed here.
    const expectedUsd = Math.round((expected.inTok * 5 + expected.outTok * 30) / 100) / 10_000
    check(`${expected.id} usd`, row.cost.usd, expectedUsd)

    // Jev is priced apart from the seat: the fixture journal carries one
    // claim-demanded (900 input tokens) and one supervisor-settled (600), plus a
    // supervisor decision-settled that is not a gate and must not be counted.
    check(`${expected.id} jev brake readings`, row.cost.jevBrakeReadings, 1)
    check(`${expected.id} jev supervisor readings`, row.cost.jevSupervisorReadings, 1)
    check(`${expected.id} jev gate readings`, row.cost.jevGateReadings, 0)
    check(`${expected.id} jev cell calls`, row.cost.jevCellCalls, 0)
    check(`${expected.id} jev unjudged`, row.cost.jevUnjudged, 1)
    check(`${expected.id} jev input tokens`, row.cost.jevInputTokens, 1500)
    check(`${expected.id} jev output tokens`, row.cost.jevOutputTokens, 0)
    const expectedJevUsd = Math.round(1500 * 0.042 / 100) / 10_000
    check(`${expected.id} jev usd`, row.cost.jevUsd, expectedJevUsd)
    check(`${expected.id} total usd`, row.cost.totalUsd, Math.round((expectedUsd + expectedJevUsd) * 10_000) / 10_000)
    // The supervisor's faults are counted, and apart from the metered calls:
    // one reading interrupted by the run's end, one memory write refused.
    check(`${expected.id} jev interrupted`, row.cost.jevInterrupted, 1)
    check(
      `${expected.id} supervisor unjudged`,
      JSON.stringify(row.cost.supervisorUnjudged),
      JSON.stringify({ interrupted: 1 })
    )
    check(`${expected.id} supervisor memory failures`, row.cost.supervisorMemoryFailures, 1)

    if (mode === "expect-latency") {
      if (row.speed.meanCallLatencyMs === undefined) failures.push(`${expected.id}: expected a per-call latency`)
      check(
        `${expected.id} mean call latency`,
        row.speed.meanCallLatencyMs,
        Math.round(4000 + (expected.turns - 1) / 2)
      )
      check(`${expected.id} latency availability`, row.speed.perCallLatency, "journaled")
    } else {
      if (row.speed.meanCallLatencyMs !== undefined) failures.push(`${expected.id}: expected no per-call latency`)
      if (!String(row.speed.perCallLatency).startsWith("unavailable")) {
        failures.push(`${expected.id}: expected the latency to be reported unavailable`)
      }
    }
  }

  // The preconditions block. A scorecard that cannot say which bytes a wave ran
  // is not a scorecard, so the agreement rule is checked here rather than left to
  // a reader noticing the line is missing.
  const pinned = read(join(here, "subject.json"))
  check("subject stamp", card.subject.stamp, pinned.stamp)
  check("subject marker", card.subject.marker.hash, pinned.marker.hash)
  check("subject agreement", card.subject.agreement, "one subject, pinned and stamped by every instance")
  for (const expected of mirror) check(`${expected.id} subject`, card.subject.instances[expected.id], pinned.stamp)

  // The rendered preconditions carry the paths the subject recorded, not the
  // paths the repository uses today: a later layout change must not rewrite an
  // old measurement's provenance.
  const rendered = readFileSync(join(here, "scorecard.md"), "utf8")
  for (
    const row of [
      `| \`${pinned.marker.path}\` | \`${pinned.marker.hash}\` |`,
      `| loaded from | ${pinned.marker.resolvedBy} |`,
      `| \`${pinned.cliDist.directory}\` | \`${pinned.cliDist.hash}\` (${pinned.cliDist.files} modules) |`,
      `| \`${pinned.cliSrc.directory}\` | \`${pinned.cliSrc.hash}\` (${pinned.cliSrc.files} files, built above) |`
    ]
  ) {
    if (!rendered.includes(row)) failures.push(`scorecard.md: missing the recorded subject row ${row}`)
  }

  check("flows resolved", card.aggregate.flowsResolved, mirror.filter((row) => row.graded === "resolved").length)
  check(
    "codex resolved",
    card.aggregate.codexResolved,
    baseline.filter((row) => row.codex.verdict === "resolved").length
  )
  check(
    "flows wall clock total",
    card.aggregate.flowsWallClockSeconds,
    mirror.reduce((total, row) => total + row.seconds, 0)
  )
  check(
    "codex wall clock total",
    card.aggregate.codexWallClockSeconds,
    baseline.reduce((total, row) => total + row.codex.seconds, 0)
  )
}

if (mode !== undefined) wave()

if (failures.length > 0) {
  console.error(`check.mjs: ${failures.length} mismatch(es)`)
  for (const failure of failures) console.error(`  ${failure}`)
  process.exit(1)
}
console.log(
  mode === undefined
    ? "check.mjs: Jev readings split by caller"
    : `check.mjs: Jev readings split by caller; scorecard matches the recorded wave (${mode})`
)
