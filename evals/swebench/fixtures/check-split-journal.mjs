/**
 * Proves the journal readers see a run the CLI journaled into two databases.
 *
 *   node fixtures/check-split-journal.mjs
 *
 * The current CLI writes `control.agent.*` into `.flows/control.db` and its
 * engine events into `.flows/engine.db`. The archive keeps both, and every
 * reader is handed the archived `engine.db`. This writes one run split that
 * way, and the same run written the legacy way into `engine.db` alone, and
 * asserts `journal-facts.mjs` and `run-cost.mjs` read the two identically:
 * the same frames, the same opening digest, the same model calls and dollars.
 * A third journal carries the control rows in both databases and must not be
 * counted twice.
 *
 * Offline, spends nothing, needs no docker.
 *
 * @since 0.1.0
 */
import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { read } from "../lib/journal-facts.mjs"
import { readCost } from "../lib/run-cost.mjs"

const temporary = mkdtempSync(join(tmpdir(), "flows-swebench-split-journal-"))

const write = (path, events) => {
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
  // Each database numbers its own `seq` from zero, as the CLI's two do.
  events.forEach(([at, type, payload], index) => {
    insert.run("run-1", index, `e${index}`, "s", index, at, type, JSON.stringify(payload), "{}")
  })
  database.close()
}

const journal = (name, engine, control) => {
  const directory = join(temporary, name)
  mkdirSync(directory, { recursive: true })
  write(join(directory, "engine.db"), engine)
  if (control !== undefined) write(join(directory, "control.db"), control)
  return join(directory, "engine.db")
}

const usage = { inputTokens: 1000, cachedInputTokens: 0, outputTokens: 100 }
const opening = [1001, "flows.time-travel.effect-boundary", {
  effect: {
    kind: "harness/boundary/workspace-open",
    status: "succeeded",
    output: { _tag: "Some", value: { digest: "t0", complete: true } }
  }
}]
const attempt = [1000, "flows.engine.attempt-started", { attempt: 1 }]
const control = [
  [1002, "control.agent.model-requested", { frame: 0, purpose: "frame", system: ["contract", "The task: fix add()."] }],
  [1003, "control.agent.turn-opened", { seat: "openai:gpt-6-sol" }],
  [1004, "control.agent.model-settled", { text: "reading", usage }],
  [1005, "control.agent.cell-produced", { language: "js", digest: "d", text: "await ctx.call('grep', {})" }],
  [1006, "control.agent.mutation-observed", {
    basis: "observed",
    digest: "t0",
    mutated: false,
    paths: 1,
    declaredWrites: 0
  }],
  [1007, "control.agent.transition-applied", { transition: { _tag: "continue" } }],
  [1008, "control.agent.turn-opened", { seat: "openai:gpt-6-sol" }],
  [1009, "control.agent.model-settled", { text: "editing", usage }],
  [1010, "control.agent.cell-produced", { language: "js", digest: "e", text: "await ctx.call('edit', {})" }],
  [1011, "control.agent.mutation-observed", {
    basis: "observed",
    digest: "t1",
    mutated: true,
    paths: 1,
    declaredWrites: 1
  }],
  [1012, "control.agent.transition-applied", { transition: { _tag: "complete" } }]
]

try {
  const legacy = journal("legacy", [attempt, opening, ...control])
  const split = journal("split", [attempt, opening], control)
  const both = journal("both", [attempt, opening, ...control], control)

  const expected = read(legacy)
  assert.equal(expected.frames.length, 2, "the legacy journal reads two frames")
  for (const path of [split, both]) {
    const facts = read(path)
    assert.equal(facts.frames.length, 2, `${path}: control.db frames are read`)
    assert.equal(facts.task, expected.task)
    assert.equal(facts.openedDigest, expected.openedDigest, "the opening digest still comes from engine.db")
    assert.deepEqual(facts.frames.map((frame) => frame.cell), expected.frames.map((frame) => frame.cell))
    assert.deepEqual(facts.frames.map((frame) => frame.mutated), expected.frames.map((frame) => frame.mutated))
    assert.equal(facts.modelCalls, expected.modelCalls)
  }

  const legacyCost = readCost(legacy)
  assert.equal(legacyCost.modelCalls, 2)
  assert.equal(legacyCost.frames, 2)
  for (const path of [split, both]) {
    const cost = readCost(path)
    assert.equal(cost.modelCalls, 2, `${path}: model calls in control.db are counted once`)
    assert.equal(cost.frames, 2)
    assert.equal(cost.seat, "openai:gpt-6-sol")
    assert.deepEqual(cost.usage, legacyCost.usage)
    assert.equal(cost.usd, legacyCost.usd)
  }

  // An engine.db with nothing beside it and no control rows is a run that
  // never reached the model, and still reads as one.
  const empty = readCost(journal("empty", [attempt]))
  assert.equal(empty.modelCalls, 0)

  console.log("check-split-journal: ok")
} finally {
  rmSync(temporary, { recursive: true, force: true })
}
