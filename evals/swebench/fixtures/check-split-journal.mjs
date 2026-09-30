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
 * counted twice. The five evidence readers — program, REPL, round-three and
 * surgery evidence, and the trace bundle's frames — read the same split archive
 * the same way, and the trace bundle tells an absent journal from a readable
 * one that records no frames.
 *
 * Offline, spends nothing, needs no docker.
 *
 * @since 0.1.0
 */
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { read } from "../lib/journal-facts.mjs"
import * as Repl from "../lib/repl-evidence.mjs"
import * as Round3 from "../lib/round3-evidence.mjs"
import { readCost } from "../lib/run-cost.mjs"
import * as Surgery from "../lib/surgery-evidence.mjs"
import { bundle, readFrames } from "../lib/trace-bundle.mjs"

const root = resolve(import.meta.dirname, "..")
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

const journal = (name, engine, control, root = temporary) => {
  const directory = join(root, name)
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

  // -----------------------------------------------------------------------
  // The evidence readers. One archive directory per layout, each holding one
  // run with two flow calls: split across the two stores, legacy in engine.db
  // alone, and journaled into both (which must not count twice).
  // -----------------------------------------------------------------------
  const calls = [
    ...control.slice(0, 4),
    [1005.1, "control.agent.cell-call-started", { input: { pattern: "add" } }],
    [1005.2, "control.agent.cell-call-settled", { flowName: "grep", outcome: "success", value: {} }],
    [1005.3, "control.agent.cell-settled", { outcome: { _tag: "returned" } }],
    ...control.slice(4, 9),
    [1010.1, "control.agent.cell-call-started", { input: { path: "a.py" } }],
    [1010.2, "control.agent.cell-call-settled", { flowName: "edit", outcome: "success", value: {} }],
    [1010.3, "control.agent.cell-settled", { outcome: { _tag: "returned" } }],
    ...control.slice(9)
  ].map(([at, type, payload]) => [Math.round(at * 10), type, payload])
  const engineRows = [attempt, opening].map(([at, type, payload]) => [at * 10, type, payload])
  const layouts = {}
  for (
    const [name, engine, controlRows] of [
      ["legacy", [...engineRows, ...calls], undefined],
      ["split", engineRows, calls],
      ["both", [...engineRows, ...calls], calls]
    ]
  ) {
    const directory = join(temporary, `archive-${name}`)
    mkdirSync(directory)
    journal("review__one", engine, controlRows, directory)
    layouts[name] = directory
  }
  const evidence = (directory) => {
    // program-evidence reads a directory only through its CLI.
    const cli = spawnSync(process.execPath, [join(root, "lib", "program-evidence.mjs"), directory, "--json"], {
      encoding: "utf8"
    })
    assert.equal(cli.status, 0, cli.stderr)
    const program = JSON.parse(cli.stdout)
    const repl = Repl.readAll(directory)
    const round3 = Round3.readDirectory(directory)
    const surgery = Surgery.readDirectory(directory)
    const frames = readFrames(join(directory, "review__one", "engine.db"))
    return { program, repl, round3, surgery, frames }
  }
  const reference = evidence(layouts.legacy)
  assert.equal(reference.program.perInstance.review__one.frames, 2)
  assert.equal(reference.program.perInstance.review__one.modelCalls, 2)
  assert.equal(reference.program.perInstance.review__one.calls, 2)
  assert.equal(reference.repl.review__one.cells, 2)
  assert.equal(reference.round3.perInstance.review__one.frames, 2)
  assert.equal(reference.surgery.perInstance.review__one.frames, 2)
  assert.equal(reference.frames.frames.length, 2)
  assert.equal(reference.frames.frames.reduce((sum, frame) => sum + frame.calls.length, 0), 2)
  for (const layout of ["split", "both"]) {
    assert.deepEqual(evidence(layouts[layout]), reference, `${layout}: the evidence readers read control.db once`)
  }

  // The trace bundle: an archived split journal renders its frames; a readable
  // journal with no frames and an absent one say different things.
  const dataset = join(temporary, "dataset.json")
  writeFileSync(
    dataset,
    JSON.stringify(["review__one", "review__empty", "review__absent"].map((id) => ({
      instance_id: id,
      repo: "stub/repo",
      base_commit: "aaaa",
      version: "1.0",
      problem_statement: "fix add()"
    })))
  )
  const fb = join(temporary, "fb")
  mkdirSync(join(fb, "journals"), { recursive: true })
  writeFileSync(join(fb, "manifest.jsonl"), "")
  journal("review__one", engineRows, calls, join(fb, "journals"))
  journal("review__empty", [attempt], [], join(fb, "journals"))
  const options = { fb, dataset, clip: 400, cellClip: 4000, textClip: 4000 }
  const rendered = bundle("review__one", options)
  assert.doesNotMatch(rendered, /no journal was archived|records no frames/)
  assert.match(rendered, /await ctx\.call\('edit', \{\}\)/)
  assert.match(bundle("review__empty", options), /_the archived journal records no frames_/)
  assert.match(bundle("review__absent", options), /_no journal was archived for this run_/)

  console.log("check-split-journal: ok")
} finally {
  rmSync(temporary, { recursive: true, force: true })
}
