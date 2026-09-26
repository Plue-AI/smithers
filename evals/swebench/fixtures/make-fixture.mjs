/**
 * Materializes a scorecard fixture from the recorded numbers of a past wave.
 *
 *   node fixtures/make-fixture.mjs [--with-latency]
 *
 * `mirror-results.json` is what the 2026-08-19 overnight wave measured, copied
 * out of the rig's mirror before the scratchpad that held it was wiped. The
 * journals themselves did not survive, so this rebuilds a journal that carries
 * exactly those numbers: the same turns, the same call and refusal counts, the
 * same token totals, over the same span. It is synthetic, and it is the only
 * thing in this directory that is: everything the scorecard then reports is
 * computed by the real reader, the real `Forensics.digest`, and the real price
 * table.
 *
 * `--with-latency` stamps the harness's exact `durationMillis` field onto each
 * model settlement. `verify.sh` builds the fixture both ways to prove the
 * scorecard reports latency when it is there and says so plainly when it is not.
 *
 * Writes work/, patches/, timings/ and one evaluator-shaped report under
 * fixtures/. All of it is generated and gitignored.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { fileURLToPath } from "node:url"

const here = dirname(fileURLToPath(import.meta.url))
const withLatency = process.argv.includes("--with-latency")
const results = JSON.parse(readFileSync(join(here, "mirror-results.json"), "utf8"))

/** A fixed epoch: the fixture must be byte-stable across builds. */
const EPOCH = 1_755_500_000_000

/**
 * The subject stamp the fixture wave ran, matching `fixtures/subject.json`.
 *
 * A real stamp is a content hash of the tree; this one is fixed, because the
 * fixture must report the same preconditions on every machine. What it
 * exercises is the scorecard's agreement rule: one pin, stamped by every
 * instance, is the only shape a wave may be written up as.
 */
const FIXTURE_SUBJECT = "sha256:0000000000000000000000000000000000000000000000000000000000000000"

const ddl = `CREATE TABLE IF NOT EXISTS flows_journal_events (
  run_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  event_id TEXT NOT NULL UNIQUE,
  source_id TEXT NOT NULL,
  source_seq INTEGER NOT NULL,
  emitted_at_ms INTEGER NOT NULL,
  event_type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  meta_json TEXT NOT NULL,
  PRIMARY KEY (run_id, seq)
)`

/** Expands the recorded per-flow call counts back into a call sequence. */
const callSequence = (row) => {
  const editFlows = new Set(["write", "edit", "apply_patch"])
  const calls = []
  for (const [flowName, count] of Object.entries(row.byFlow ?? {})) {
    for (let index = 0; index < count; index++) calls.push({ flowName, isEdit: editFlows.has(flowName) })
  }
  let editFailures = (row.edits ?? 0) - (row.editsOk ?? 0)
  let otherFailures = (row.failed ?? 0) - editFailures
  return calls.map((call) => {
    if (call.isEdit && editFailures > 0) {
      editFailures -= 1
      return { ...call, outcome: "failure" }
    }
    if (!call.isEdit && otherFailures > 0) {
      otherFailures -= 1
      return { ...call, outcome: "failure" }
    }
    return { ...call, outcome: "success" }
  })
}

const build = (row) => {
  const runId = `run-${row.id}`
  const events = []
  const turns = row.turns ?? 0
  const calls = callSequence(row)
  const perTurnInput = turns === 0 ? 0 : Math.floor((row.inTok ?? 0) / turns)
  const perTurnOutput = turns === 0 ? 0 : Math.floor((row.outTok ?? 0) / turns)
  const spanMs = (row.seconds ?? 0) * 1000
  const total = Math.max(1, turns * 2 + calls.length * 2 + 1)
  let step = 0
  const at = () => EPOCH + Math.round((spanMs * step++) / total)

  for (let turn = 0; turn < turns; turn++) {
    const last = turn === turns - 1
    events.push(["control.agent.turn-opened", { seat: "openai:gpt-5.6-sol" }, at()])
    events.push([
      "control.agent.model-settled",
      {
        text: "",
        usage: {
          inputTokens: last ? (row.inTok ?? 0) - perTurnInput * (turns - 1) : perTurnInput,
          outputTokens: last ? (row.outTok ?? 0) - perTurnOutput * (turns - 1) : perTurnOutput
        },
        ...(withLatency ? { durationMillis: 4000 + turn } : {})
      },
      at()
    ])
  }
  // The two harness classifiers' readings, with the usage the gateway meters
  // them at, and the same reading repeated as `decision-settled`, which
  // carries no usage and must price at nothing. Neither adds a flow call, so
  // every count the mirror pins stays as recorded; `fixtures/check.mjs` pins
  // the Jev column against these two numbers.
  events.push([
    "control.agent.claim-demanded",
    {
      complete: 0.9,
      overclaims: 0.1,
      invented: 0.05,
      latencyMs: 300,
      usage: { inputTokens: 900, outputTokens: 0 },
      demanded: false,
      refused: false,
      currentDigest: "",
      nextFrame: turns
    },
    at()
  ])
  events.push([
    "control.agent.supervisor-settled",
    {
      scope: runId,
      frame: 0,
      thrashing: 0.1,
      onTarget: 0.9,
      suspect: 0.1,
      needsHelp: "none",
      latencyMs: 280,
      usage: { inputTokens: 600, outputTokens: 0 }
    },
    at()
  ])
  events.push([
    "control.agent.decision-settled",
    {
      scope: runId,
      frame: 0,
      classifier: "supervisor/turn",
      digest: "fixture",
      latencyMs: 280,
      acted: false,
      decidedBy: "jev"
    },
    at()
  ])
  // The supervisor's own faults: a reading the run's end interrupted, which
  // was asked and carries no usage, and a memory write the store refused.
  // Neither is a Jev call with usage; `fixtures/check.mjs` counts them apart.
  events.push([
    "control.agent.supervisor-unjudged",
    { scope: runId, frame: 1, reason: "interrupted", detail: "The run ended with this reading in flight" },
    at()
  ])
  events.push([
    "control.agent.supervisor-memory-failed",
    { scope: runId, frame: 0, operation: "remember", detail: "database is locked" },
    at()
  ])
  for (const call of calls) {
    events.push(["control.agent.cell-call-started", { flowName: call.flowName, input: { seq: events.length } }, at()])
    events.push([
      "control.agent.cell-call-settled",
      call.outcome === "failure"
        ? { flowName: call.flowName, outcome: "failure", message: "failed: fixture refusal" }
        : { flowName: call.flowName, outcome: "success" },
      at()
    ])
  }
  events.push([
    `control.run.${row.status ?? "completed"}`,
    row.status === "failed" ? { cause: "fixture cause" } : {},
    EPOCH + spanMs
  ])

  const workspace = join(here, "work", row.id, ".flows")
  mkdirSync(workspace, { recursive: true })
  const path = join(workspace, "engine.db")
  rmSync(path, { force: true })
  const database = new DatabaseSync(path)
  database.exec(ddl)
  const insert = database.prepare(
    "insert into flows_journal_events (run_id, seq, event_id, source_id, source_seq, emitted_at_ms, event_type, payload_json, meta_json) values (?, ?, ?, ?, ?, ?, ?, ?, ?)"
  )
  events.forEach(([eventType, payload, emittedAt], index) => {
    insert.run(runId, index, `${runId}-${index}`, "fixture", index, emittedAt, eventType, JSON.stringify(payload), "{}")
  })
  database.close()

  mkdirSync(join(here, "patches"), { recursive: true })
  writeFileSync(join(here, "patches", `${row.id}.patch`), "x".repeat(row.patchBytes ?? 0))

  mkdirSync(join(here, "timings"), { recursive: true })
  writeFileSync(
    join(here, "timings", `${row.id}.json`),
    `${
      JSON.stringify(
        {
          instance_id: row.id,
          seat: "openai:gpt-5.6-sol",
          // The stamp `run-instance.sh` copies out of the pinned `.subject.json`.
          // It matches `fixtures/subject.json`, so the fixture wave exercises
          // the scorecard's "one subject" branch rather than its unstamped one.
          subject: FIXTURE_SUBJECT,
          budgetSeconds: 1200,
          startedAt: EPOCH,
          endedAt: EPOCH + (row.seconds ?? 0) * 1000,
          wallClockSeconds: row.seconds ?? 0
        },
        null,
        2
      )
    }\n`
  )
}

for (const row of results) build(row)

const bucket = (verdict) =>
  verdict === "resolved"
    ? "resolved_ids"
    : verdict === "unresolved"
    ? "unresolved_ids"
    : verdict === "empty patch"
    ? "empty_patch_ids"
    : "error_ids"
const report = { resolved_ids: [], unresolved_ids: [], empty_patch_ids: [], error_ids: [] }
for (const row of results) report[bucket(row.graded)].push(row.id)
writeFileSync(join(here, "flows-cell-harness.mirror.json"), `${JSON.stringify(report, null, 2)}\n`)

if (!existsSync(join(here, "work"))) process.exit(1)
console.log(
  `make-fixture.mjs: ${results.length} instances${withLatency ? " (with per-call latency)" : ""} under ${
    join(here, "work")
  }`
)
