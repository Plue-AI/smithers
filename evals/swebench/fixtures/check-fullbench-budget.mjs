/** Offline budget regressions: no docker, dataset or model access. */
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { renderReport, spendByInstance, summarise } from "../fullbench-report.mjs"
import { read } from "../lib/fullbench-manifest.mjs"
import { readCost } from "../lib/run-cost.mjs"

const root = resolve(import.meta.dirname, "..")
const temporary = mkdtempSync(join(tmpdir(), "swebench-budget-"))
const manifest = join(temporary, "manifest.jsonl")
const writeLedger = (rows) => writeFileSync(manifest, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`)
const instance = (state, extra = {}) => ({ kind: "instance", id: "a__a-1", state, ...extra })
const spend = () =>
  spawnSync(process.execPath, [join(root, "fullbench-report.mjs"), "--spend-cents", "--manifest", manifest], {
    encoding: "utf8",
    timeout: 10_000
  })

// Execute the driver's own reader and loop through its budget decision. Stop
// before subject checks or scheduling, so this can never launch a worker.
const driver = readFileSync(join(root, "fullbench.sh"), "utf8")
const reader = driver.slice(
  driver.indexOf("spend_cents() {"),
  driver.indexOf("BUDGET_CENTS=", driver.indexOf("spend_cents() {"))
)
const loopStart = driver.indexOf("for ID in $QUEUE; do")
const gate = driver.slice(loopStart, driver.indexOf("  # The subject was pinned once", loopStart))
const gateDecision = () =>
  spawnSync("bash", [
    "-c",
    [
      reader,
      "pause_now() { printf \"paused\\n\"; }",
      "sleep() { :; }",
      "STOPPING=0; SESSION_LIMIT=\"\"; SCHEDULED=0; QUEUE=a__a-1; BUDGET_CENTS=6000",
      gate,
      "printf \"launched\\n\"",
      "done"
    ].join("\n")
  ], { encoding: "utf8", timeout: 10_000, env: { ...process.env, S: root, MANIFEST: manifest } })

try {
  const path = join(temporary, "engine.db")
  const database = new DatabaseSync(path)
  database.exec(
    "CREATE TABLE flows_journal_events (seq INTEGER, emitted_at_ms INTEGER, event_type TEXT, payload_json TEXT)"
  )
  const append = database.prepare("INSERT INTO flows_journal_events VALUES (?, ?, ?, ?)")
  append.run(0, 0, "control.agent.turn-opened", JSON.stringify({ seat: "openai:unpriced-fixture" }))
  for (let i = 1; i <= 5; i++) {
    append.run(i, i, "control.agent.model-settled", JSON.stringify({ usage: { inputTokens: 1000, outputTokens: 100 } }))
  }
  database.close()
  const cost = readCost(path)
  assert.equal(cost.modelCalls, 5)
  writeLedger([instance("ran", { cost }), instance("graded", { verdict: "resolved" })])
  const unknown = spend()
  assert.ok(
    unknown.status !== 0 || !/^\d+$/.test(unknown.stdout.trim()),
    "five unpriced calls must not report numeric zero spend"
  )
  const decision = gateDecision()
  assert.equal(decision.status, 0, decision.stderr)
  assert.equal(decision.stdout.trim(), "paused", "unknown cost must take the driver's fail-closed path")
  assert.equal(cost.unknown, true)
  assert.deepEqual(spendByInstance(read(manifest)), { cents: 0, unknownAttempts: 1 })
  const summary = summarise({ manifest, now: 10, total: 1 })
  assert.equal(summary.spentUsd, null)
  assert.equal(summary.meanUsd, undefined)
  assert.equal(summary.projectedUsd, undefined)
  assert.match(renderReport(summary), /attempts with unknown cost \| 1/)

  // Unknown is not zero, even when a failed cost reader left the legacy {}.
  for (
    const unknownCost of [undefined, null, {}, { usd: null }, { usd: "5" }, { usd: -1 }, { usd: 0, unknown: true }]
  ) {
    writeLedger([instance("ran", { cost: unknownCost }), instance("graded")])
    assert.equal(spend().stdout.trim(), "unknown")
    assert.deepEqual(spendByInstance(read(manifest)), { cents: 0, unknownAttempts: 1 })
    assert.equal(gateDecision().stdout.trim(), "paused")
  }
  writeLedger([instance("ran", { cost: { usd: 0 } }), instance("graded"), instance("cleaned")])
  assert.equal(spend().stdout.trim(), "0", "a proven zero is numeric")
  assert.equal(gateDecision().stdout.trim(), "launched")
  writeLedger([instance("pulled")])
  assert.equal(spend().stdout.trim(), "0", "an in-flight worker has not recorded a cost yet")

  // Grade rows enrich one attempt; a replacement never erases an earlier bill.
  writeLedger([
    instance("ran", { cost: { usd: 40 } }),
    instance("pulled"),
    instance("ran", { cost: { usd: 25 } }),
    instance("graded", { cost: { usd: 25 } })
  ])
  assert.deepEqual(spendByInstance(read(manifest)), { cents: 6500, unknownAttempts: 0 })
  assert.equal(spend().stdout.trim(), "6500")
  assert.equal(gateDecision().stdout.trim(), "paused")
  writeLedger([instance("ran"), instance("graded", { cost: { usd: 25 } })])
  assert.equal(spend().stdout.trim(), "2500", "a grade can supply its attempt's missing cost")
  writeLedger([instance("graded", { cost: { usd: 25 } })])
  assert.equal(spend().stdout.trim(), "2500", "older grade-only ledgers still carry spend")
  writeLedger([instance("ran"), instance("pulled"), instance("ran", { cost: { usd: 25 } })])
  assert.deepEqual(spendByInstance(read(manifest)), { cents: 2500, unknownAttempts: 1 })
  assert.equal(spend().stdout.trim(), "unknown", "a priced retry cannot repair an unpriced earlier attempt")
  writeLedger(Array.from({ length: 5 }, () => instance("ran", { cost: { usd: 0.004 } })))
  assert.equal(spend().stdout.trim(), "2", "round after summing sub-cent attempts")

  const header = { kind: "header", budgetUsd: 60, seat: "openai:unpriced-fixture" }
  writeLedger([header])
  assert.equal(spend().stdout.trim(), "unknown-seat", "refuse the seat before its first attempt")
  assert.equal(gateDecision().stdout.trim(), "paused")
  writeLedger([header, { ...header, seat: "openai:gpt-5.6-sol" }])
  assert.equal(spend().stdout.trim(), "0", "the current session determines the seat to be launched")

  for (
    const damaged of [
      "{\"kind\":\"instance\",",
      "{broken}\n",
      "{\"kind\":\"instance\",\"state\":\"ran\",\"cost\":{\"usd\":1e400}}\n"
    ]
  ) {
    writeFileSync(manifest, damaged)
    assert.equal(spend().stdout.trim(), "unknown", "damaged accounting cannot produce numeric spend")
  }

  const priced = new DatabaseSync(path)
  priced.prepare("UPDATE flows_journal_events SET payload_json = ? WHERE seq = 0")
    .run(JSON.stringify({ seat: "openai:gpt-5.6-sol" }))
  assert.equal(readCost(path).usd, 0.04, "five priced calls sum their recorded usage")
  assert.equal(readCost(path).unknown, false)
  const insert = priced.prepare("INSERT INTO flows_journal_events VALUES (?, ?, ?, ?)")
  insert.run(6, 6, "control.agent.turn-opened", JSON.stringify({ seat: "openai:unpriced-fixture" }))
  insert.run(7, 7, "control.agent.model-settled", JSON.stringify({ usage: { inputTokens: 1000, outputTokens: 100 } }))
  assert.equal(readCost(path).unknown, true, "a priced first seat cannot hide a later unpriced call")
  priced.exec("DELETE FROM flows_journal_events WHERE seq > 0")
  assert.equal(readCost(path).usd, 0, "a readable journal without calls proves zero recorded usage")
  assert.equal(readCost(path).unknown, false)
  for (let i = 1; i <= 10; i++) {
    insert.run(i, i, "control.agent.model-settled", JSON.stringify({ usage: { inputTokens: 1, outputTokens: 0 } }))
  }
  assert.equal(readCost(path).usd, 0.0001, "price aggregated usage without rounding away each small call")
  // Jev is metered on its own rows and priced under its own row: the
  // completion brake, the supervisor, the agent's `jev` flow call and a
  // gate's `decision-settled` each count once; a failed `jev` call and the
  // supervisor's own `decision-settled`, even carrying usage, count nothing.
  // 12,000 input tokens at 0.042 USD per 1M is 0.000504, rounded to 0.0005.
  priced.exec("DELETE FROM flows_journal_events WHERE seq > 0")
  insert.run(1, 1, "control.agent.model-settled", JSON.stringify({ usage: { inputTokens: 1000, outputTokens: 100 } }))
  insert.run(2, 2, "control.agent.claim-demanded", JSON.stringify({ usage: { inputTokens: 4000, outputTokens: 0 } }))
  insert.run(
    3,
    3,
    "control.agent.supervisor-settled",
    JSON.stringify({ usage: { inputTokens: 3000, outputTokens: 0 } })
  )
  insert.run(
    4,
    4,
    "control.agent.cell-call-settled",
    JSON.stringify({
      flowName: "jev",
      outcome: "success",
      value: { answers: {}, usage: { inputTokens: 3000, outputTokens: 0 }, latencyMs: 290 }
    })
  )
  insert.run(
    5,
    5,
    "control.agent.cell-call-settled",
    JSON.stringify({ flowName: "jev", outcome: "failure", message: "refused" })
  )
  insert.run(
    6,
    6,
    "control.agent.cell-call-settled",
    JSON.stringify({ flowName: "bash", outcome: "success", value: { exitCode: 0 } })
  )
  insert.run(
    7,
    7,
    "control.agent.decision-settled",
    JSON.stringify({
      classifier: "supervisor/turn",
      answers: {},
      usage: { inputTokens: 3000, outputTokens: 0 }
    })
  )
  insert.run(
    11,
    11,
    "control.agent.decision-settled",
    JSON.stringify({
      classifier: "relevance/unnecessary",
      answers: {},
      usage: { inputTokens: 2000, outputTokens: 0 }
    })
  )
  // A supervisor reading the run's end interrupted: asked, never metered.
  // Counted on its own, never priced and never an unknown.
  insert.run(9, 9, "control.agent.supervisor-unjudged", JSON.stringify({ reason: "interrupted", frame: 2 }))
  insert.run(10, 10, "control.agent.supervisor-unjudged", JSON.stringify({ reason: "timeout", frame: 1 }))
  {
    const metered = readCost(path)
    assert.equal(metered.jevInterrupted, 1, "only the interrupted reading, not a transport timeout")
    assert.equal(metered.usd, 0.008, "the seat's usd is the model turns alone")
    assert.equal(metered.jevCalls, 4, "the brake, the supervisor, one settled jev call and one gate")
    assert.equal(metered.jevInputTokens, 12_000)
    assert.equal(metered.jevOutputTokens, 0)
    assert.equal(metered.jevUsd, 0.0005, "Jev priced under typesafe-ai/jev, the supervisor's decision-settled unpriced")
    assert.equal(metered.totalUsd, 0.0085)
    assert.equal(metered.unknown, false)
  }
  insert.run(8, 8, "control.agent.supervisor-settled", JSON.stringify({ usage: { inputTokens: -1, outputTokens: 0 } }))
  assert.equal(readCost(path).unknown, true, "malformed Jev usage is an explicit unknown")
  priced.exec("DELETE FROM flows_journal_events WHERE seq > 0")
  priced.prepare("INSERT INTO flows_journal_events VALUES (1, 1, 'control.agent.model-settled', ?)").run("{}")
  assert.equal(readCost(path).unknown, true, "a call without usage cannot prove zero")
  priced.exec("UPDATE flows_journal_events SET payload_json = '{broken}' WHERE seq = 1")
  assert.equal(readCost(path).unknown, true, "corrupt journal payloads are explicit unknowns")
  priced.close()
  const broken = join(temporary, "broken.db")
  writeFileSync(broken, "not sqlite")
  for (const target of [broken, join(temporary, "missing.db")]) {
    const result = spawnSync(process.execPath, [join(root, "lib/run-cost.mjs"), target], {
      encoding: "utf8",
      timeout: 10_000
    })
    assert.equal(result.status, 0, result.stderr)
    const unknownJournal = JSON.parse(result.stdout)
    assert.equal(unknownJournal.unknown, true)
    assert.equal(unknownJournal.usd, null)
    writeLedger([instance("ran", { cost: unknownJournal })])
    assert.equal(gateDecision().stdout.trim(), "paused")
  }

  console.log(
    "check-fullbench-budget: unknown costs, retry totals, seat admission and journal failures pass the driver budget gate checks."
  )
} finally {
  rmSync(temporary, { recursive: true, force: true })
}
