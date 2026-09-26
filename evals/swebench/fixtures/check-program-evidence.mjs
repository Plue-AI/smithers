/**
 * Replays `lib/program-evidence.mjs` over a synthesised journal.
 *
 * The re-run report claims that particular `analysis/PROGRAM.md` changes acted,
 * and every one of those claims is a count this module takes off the journal.
 * A miscount would be invisible in the report and would read as evidence, so
 * the counts are pinned here against a journal whose every event is known.
 *
 * What is pinned:
 *
 * - a frame that issues no call is a **zero-call frame**, and one that applies
 *   no transition is a **dead frame**, and the two are counted separately
 *   because change #1 removes the first and change #5 the second;
 * - a **failed call is not the end of its cell**: a cell that settles another
 *   call after one fails, or that still applies a transition, is counted as
 *   the recovery change #8 exists to produce;
 * - a `bash` call carrying `script` or `stdin` is **script-as-data** and one
 *   carrying `command` is not, which is the whole of change #4's prediction;
 * - `recall` ordinals and `render` keys are counted per transition, so
 *   change #1's "never re-buy what you paid for" has a number;
 * - a `test` call naming `against: "base"` is a **baselined** one (change #6);
 * - and a failed `edit`/`write`/`apply_patch` is a failed mutation (change #3).
 *
 * Spends nothing, needs no docker, needs no dataset.
 */
import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { readJournal } from "../lib/program-evidence.mjs"

const temporary = mkdtempSync(join(tmpdir(), "flows-swebench-evidence-"))

/** Writes one journal database out of a list of `[type, payload]` events. */
const journal = (name, events) => {
  const directory = join(temporary, name)
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
const settled = (usage) => ["control.agent.model-settled", { usage }]
const call = (flowName, input, outcome = "success") => [
  ["control.agent.cell-call-started", { flowName, input }],
  ["control.agent.cell-call-settled", { flowName, outcome, value: {} }]
]
const transition = (transitionValue) => ["control.agent.transition-applied", { transition: transitionValue }]

try {
  // -------------------------------------------------------------------------
  // One journal holding every shape the report reads.
  // -------------------------------------------------------------------------
  const path = journal("one__one-1", [
    // Frame 1 — two calls, one of them script-as-data, and a recall.
    opened,
    settled({ inputTokens: 1000, cachedInputTokens: 400, outputTokens: 100, reasoningTokens: 10 }),
    ...call("grep", { pattern: "x" }),
    ...call("bash", { script: "print(1)", interpreter: "python3" }),
    transition({ _tag: "continue", recall: [1, 2], render: ["hits"] }),

    // Frame 2 — a failed call the cell survives: the next call still settles.
    opened,
    settled({ inputTokens: 2000, cachedInputTokens: 1600, outputTokens: 200, reasoningTokens: 20 }),
    ...call("edit", { path: "a.py" }, "failure"),
    ...call("read", { path: "a.py" }),
    transition({ _tag: "continue", render: ["region"] }),

    // Frame 3 — a structured test against the pristine base, and a shell string.
    opened,
    settled({ inputTokens: 1000, cachedInputTokens: 1000, outputTokens: 50, reasoningTokens: 0 }),
    ...call("test", { target: "tests/test_a.py", against: "base" }),
    ...call("bash", { command: "ls" }),
    transition({ _tag: "complete" }),

    // Frame 4 — the cell issued no call and applied no transition.
    opened,
    settled({ inputTokens: 500, cachedInputTokens: 0, outputTokens: 900, reasoningTokens: 0 })
  ])

  const counts = readJournal(path)

  assert.equal(counts.frames, 4, "every opened turn is a frame, including the last")
  assert.equal(counts.modelCalls, 4)
  assert.equal(counts.calls, 6)

  // The two frame pathologies are counted apart from each other.
  assert.equal(counts.zeroCallFrames, 1, "only frame 4 issued no call")
  assert.equal(counts.deadFrames, 1, "only frame 4 applied no transition")

  // Change #1: the run re-read what it had already paid for, for free.
  assert.equal(counts.recallTransitions, 1)
  assert.equal(counts.recallOrdinals, 2)
  assert.equal(counts.renderTransitions, 2)
  assert.equal(counts.renderKeys, 2)

  // Change #8: a failed call does not end its cell.
  assert.equal(counts.failedCalls, 1)
  assert.equal(counts.framesWithFailedCall, 1)
  assert.equal(counts.recoveredFrames, 1, "frame 2 settled another call after the failure")

  // Change #6: the structured test flow, and the pristine-base comparison.
  assert.equal(counts.testCalls, 1)
  assert.equal(counts.baselinedTestCalls, 1)

  // Change #4: a payload passed as data is not a composed shell string.
  assert.equal(counts.bashCalls, 2)
  assert.equal(counts.scriptCalls, 1)
  assert.equal(counts.quotedCalls, 1)

  // Change #3: a mutation that did not apply is a failed edit.
  assert.equal(counts.editCalls, 1)
  assert.equal(counts.failedEdits, 1)

  assert.equal(counts.grepCalls, 1)
  assert.equal(counts.readCalls, 1)
  assert.equal(counts.completing, 1)

  assert.deepEqual(counts.usage, {
    inputTokens: 4500,
    cachedInputTokens: 3000,
    outputTokens: 1250,
    reasoningTokens: 30
  })

  // -------------------------------------------------------------------------
  // A cell that throws after its failed call still counts as a recovery when
  // the harness applied its transition, and not when nothing survived.
  // -------------------------------------------------------------------------
  const lost = readJournal(journal("two__two-2", [
    opened,
    settled({ inputTokens: 10, cachedInputTokens: 0, outputTokens: 10, reasoningTokens: 0 }),
    ...call("grep", { pattern: "(" }, "failure")
  ]))
  assert.equal(lost.failedCalls, 1)
  assert.equal(lost.framesWithFailedCall, 1)
  assert.equal(lost.recoveredFrames, 0, "nothing followed the failure and no transition landed")
  assert.equal(lost.zeroCallFrames, 0, "a failed call is still a call")

  console.log(
    "check-program-evidence: zero-call and dead frames are counted apart, a survived failure is a"
      + " recovery, and script-as-data is told from a shell string."
  )
} finally {
  rmSync(temporary, { recursive: true, force: true })
}
