/**
 * Pins the analysis bundle: what it shows, what it clips, and what it withholds.
 *
 *   node fixtures/check-trace-bundle.mjs
 *
 * The bundle is the evidence an analyst designs an optimal trace from, and the
 * whole exercise is void if it hands over hindsight. So the withholding is not a
 * convention anyone has to remember — it is checked here, over a dataset row
 * whose gold patch, graded test file, graded identifiers and maintainer hints
 * are each a sentinel string that must not appear in the output.
 *
 * The rest of the check is the reading: a synthesised journal in the harness's
 * own event shapes folds into the frames, calls, tokens and timings the bundle
 * prints; a synthesised codex transcript in the CLI's own transcript shape folds
 * into its turns and commands; every clip says what it dropped; and an instance
 * the backfill has not reached yet says so rather than printing zeroes.
 *
 * Spends no tokens, needs no docker, needs no dataset.
 */
import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { PROMPT, readCodexTrace, visible, VISIBLE_KEYS, WITHHELD_KEYS } from "../lib/trace-bundle.mjs"

const temporary = mkdtempSync(join(tmpdir(), "flows-trace-bundle-"))
const fb = join(temporary, "fullbench")
const graded = "stubtrace__graded"
const pending = "stubtrace__pending"

// ---------------------------------------------------------------------------
// The dataset. Every column a live agent never had is a sentinel.
// ---------------------------------------------------------------------------
const sentinels = {
  patch: "GOLD-PATCH-SENTINEL",
  test_patch: "TEST-PATCH-SENTINEL",
  FAIL_TO_PASS: ["FAIL-TO-PASS-SENTINEL"],
  PASS_TO_PASS: ["PASS-TO-PASS-SENTINEL"],
  hints_text: "HINTS-SENTINEL"
}
const datasetPath = join(temporary, "dataset.json")
writeFileSync(
  datasetPath,
  JSON.stringify(
    [graded, pending].map((id) => ({
      instance_id: id,
      repo: "stub/repo",
      base_commit: "aaaabbbbccccdddd",
      version: "1.0",
      problem_statement: "PROBLEM-STATEMENT-SENTINEL: the widget drops its query string on redirect.",
      ...sentinels
    })),
    null,
    2
  )
)

// ---------------------------------------------------------------------------
// The projection is the enforcement point, so it is checked directly rather
// than only through the rendered output.
// ---------------------------------------------------------------------------
for (const key of WITHHELD_KEYS) {
  assert.ok(!VISIBLE_KEYS.includes(key), `'${key}' is hindsight and is not a visible column`)
}
const projected = visible(JSON.parse(readFileSync(datasetPath, "utf8"))[0])
assert.deepEqual(
  Object.keys(projected).sort(),
  [...VISIBLE_KEYS].sort(),
  "the projection carries the visible columns and nothing else"
)

// ---------------------------------------------------------------------------
// Our journal, in the harness's own event shapes: two frames, the second of
// which edits and completes, and one call whose result is far past the clip.
// ---------------------------------------------------------------------------
const usage = { inputTokens: 100000, cachedInputTokens: 50000, outputTokens: 2000, reasoningTokens: 1000 }
const longResult = { content: "x".repeat(5000) }
const events = [
  [1, 1000, "control.agent.turn-opened", { seat: "openai:gpt-5.6-sol", at: 1000 }],
  [2, 1100, "control.agent.model-settled", { text: "```cell\n…\n```", usage, durationMillis: 7200 }],
  [3, 1110, "control.agent.cell-produced", {
    language: "javascript",
    text: "CELL-ONE-SENTINEL\nawait ctx.call(\"grep\", {})"
  }],
  [4, 1120, "control.agent.cell-call-started", { flowName: "grep", input: { pattern: "widget" }, at: 1120 }],
  [5, 1500, "control.agent.cell-call-settled", { flowName: "grep", outcome: "success", value: longResult, at: 1500 }],
  [6, 1510, "control.agent.mutation-observed", {
    basis: "observed",
    mutated: false,
    digest: "d",
    paths: 10,
    declaredWrites: 0,
    at: 1510
  }],
  [7, 1520, "control.agent.transition-applied", { transition: { _tag: "continue" }, at: 1520 }],
  [8, 1530, "control.agent.narrowed-demanded", { reason: "broad" }],
  [9, 1540, "control.agent.turn-closed", { stopReason: "stop", outcome: "continue", at: 1540 }],
  [10, 2000, "control.agent.turn-opened", { seat: "openai:gpt-5.6-sol", at: 2000 }],
  [11, 2100, "control.agent.model-settled", { text: "```cell\n…\n```", usage, durationMillis: 3300 }],
  [12, 2110, "control.agent.cell-produced", { language: "javascript", text: "CELL-TWO-SENTINEL" }],
  [13, 2120, "control.agent.cell-call-started", { flowName: "edit", input: { path: "a.py" }, at: 2120 }],
  [14, 2300, "control.agent.cell-call-settled", {
    flowName: "edit",
    outcome: "success",
    value: { replacements: 1 },
    at: 2300
  }],
  [15, 2310, "control.agent.mutation-observed", {
    basis: "observed",
    mutated: true,
    digest: "e",
    paths: 10,
    declaredWrites: 1,
    at: 2310
  }],
  [16, 2320, "control.agent.transition-applied", { transition: { _tag: "complete" }, at: 2320 }],
  [17, 2330, "control.agent.turn-closed", { stopReason: "stop", outcome: "resolved", at: 2330 }],
  [18, 2340, "control.agent.resolved", { text: "RESOLVED-TEXT-SENTINEL" }]
]
mkdirSync(join(fb, "journals", graded), { recursive: true })
const database = new DatabaseSync(join(fb, "journals", graded, "engine.db"))
database.exec(
  "create table flows_journal_events (seq integer primary key, emitted_at_ms integer,"
    + " event_type text, payload_json text)"
)
const insert = database.prepare(
  "insert into flows_journal_events (seq, emitted_at_ms, event_type, payload_json) values (?, ?, ?, ?)"
)
for (const [seq, at, type, payload] of events) insert.run(seq, at, type, JSON.stringify(payload))
database.close()

// ---------------------------------------------------------------------------
// The rest of our side, and codex's
// ---------------------------------------------------------------------------
mkdirSync(join(fb, "timings"), { recursive: true })
mkdirSync(join(fb, "patches"), { recursive: true })
mkdirSync(join(fb, "codex", "logs"), { recursive: true })
mkdirSync(join(fb, "codex", "timings"), { recursive: true })
mkdirSync(join(fb, "codex", "patches"), { recursive: true })

writeFileSync(
  join(fb, "timings", `${graded}.json`),
  JSON.stringify({ instance_id: graded, wallClockSeconds: 109 })
)
writeFileSync(
  join(fb, "patches", `${graded}.patch`),
  "diff --git a/a.py b/a.py\n--- a/a.py\n+++ b/a.py\n@@\n-old\n+new\n"
)
writeFileSync(
  join(fb, "codex", "patches", `${graded}.patch`),
  "diff --git a/a.py b/a.py\n--- a/a.py\n+++ b/a.py\n@@\n-old\n+other\n"
)
writeFileSync(
  join(fb, "codex", "timings", `${graded}.json`),
  JSON.stringify({ instance_id: graded, wallClockSeconds: 402 })
)
writeFileSync(
  join(fb, "codex", "logs", `${graded}.run.log`),
  [
    "OpenAI Codex v0.149.0",
    "--------",
    `workdir: /work/${graded}`,
    "model: gpt-5.6-sol",
    "--------",
    "user",
    "the prompt, which the bundle reports as the problem statement instead",
    "codex",
    "ASSISTANT-TURN-SENTINEL: I will reproduce it first.",
    "exec",
    `/bin/zsh -lc 'CODEX-COMMAND-SENTINEL' in /work/${graded}`,
    " succeeded in 52ms:",
    `CODEX-OUTPUT-SENTINEL${"y".repeat(5000)}`,
    "",
    "exec",
    `/bin/zsh -lc 'failing' in /work/${graded}`,
    " exited 127 in 783ms:",
    "not found",
    "",
    "tokens used",
    "46,469",
    ""
  ].join("\n")
)

const manifestRow = (row) => `${JSON.stringify({ kind: "instance", ...row })}\n`
writeFileSync(
  join(fb, "manifest.jsonl"),
  manifestRow({ id: graded, state: "cleaned", at: 1, verdict: "resolved", wallSeconds: 120 })
    + manifestRow({ id: pending, state: "cleaned", at: 1, verdict: "unresolved", wallSeconds: 90 })
)
writeFileSync(
  join(fb, "codex-manifest.jsonl"),
  manifestRow({ id: graded, state: "started", at: 1 })
    + manifestRow({ id: graded, state: "graded", at: 2, verdict: "unresolved", wallSeconds: 430, tokens: 46469 })
)

// ---------------------------------------------------------------------------
// Build it
// ---------------------------------------------------------------------------
const { bundle } = await import("../lib/trace-bundle.mjs")
const options = { clip: 200, textClip: 400, cellClip: 3000, fb, dataset: datasetPath }
const text = bundle(graded, options)
assert.equal(text, bundle(graded, options), "two builds over one ledger produce the same bytes")

// ---------------------------------------------------------------------------
// What must not be in it, at any cost
// ---------------------------------------------------------------------------
for (const [key, value] of Object.entries(sentinels)) {
  const needle = Array.isArray(value) ? value[0] : value
  assert.ok(!text.includes(needle), `the bundle leaked '${key}' — it is hindsight`)
}
assert.ok(!text.includes("resolved\": true"), "the evaluator's own report is never read")

// ---------------------------------------------------------------------------
// The task, as the agent saw it
// ---------------------------------------------------------------------------
assert.match(text, /PROBLEM-STATEMENT-SENTINEL/u, "the problem statement is the task")
assert.match(text, /stub\/repo` at `aaaabbbbccccdddd/u)

// ---------------------------------------------------------------------------
// The metrics, ours and theirs
// ---------------------------------------------------------------------------
assert.match(text, /\| verdict \| resolved \| unresolved \|/u)
assert.match(text, /\| wall clock, whole instance \| 109s \| 430s \|/u)
assert.match(text, /\| wall clock, agent only \| 1s \| 402s \|/u)
assert.match(text, /\| model turns \| 2 \| 1 \|/u, "our frames against codex's assistant turns")
assert.match(text, /\| tool calls \/ exec commands \| 2 \| 2 \|/u)
assert.match(text, /\| input tokens \| 200,000 \|/u)
assert.match(text, /\| cached input tokens \| 100,000 \|/u)
assert.match(text, /\| tokens, total \| 204,000 \| 46,469 \|/u)
assert.match(text, /\| USD \| \$0\.6[67]\d\d \| not derivable \|/u, "ours is priced; codex's cannot be")
assert.match(text, /\| files touched \| 1 \| 1 \|/u)
assert.ok(
  !text.includes("An `eval error` verdict is a fact"),
  "a graded instance carries no eval-error caveat"
)

// ---------------------------------------------------------------------------
// Our trace, frame by frame
// ---------------------------------------------------------------------------
assert.match(text, /#### Frame 1 — 0\.5s, 1 call, 100,000 in \/ 50,000 cached \/ 2,000 out, model 7\.2s/u)
assert.match(text, /#### Frame 2 — 0\.3s, 1 call/u)
assert.match(text, /CELL-ONE-SENTINEL/u, "the cell is what the model wrote")
assert.match(text, /CELL-TWO-SENTINEL/u)
assert.match(text, /transition `continue` · stop `stop` · tree unchanged · 0 declared writes · demands: `narrowed`/u)
assert.match(text, /transition `complete` · stop `stop` · \*\*tree moved\*\* · 1 declared write/u)
assert.match(text, /1\. `grep` — ok, 380ms/u, "each call's flow, outcome and latency")
assert.match(text, /1\. `edit` — ok, 180ms/u)
assert.match(text, /\[\+4\d\d\d chars\]/u, "a result past the clip says how much it dropped")
assert.ok(!text.includes("x".repeat(300)), "and the dropped part is really gone")
assert.match(text, /RESOLVED-TEXT-SENTINEL/u, "what the run said it did")

// ---------------------------------------------------------------------------
// Codex's trace
// ---------------------------------------------------------------------------
assert.match(text, /ASSISTANT-TURN-SENTINEL/u)
assert.match(text, /CODEX-COMMAND-SENTINEL/u)
assert.match(text, /CODEX-OUTPUT-SENTINEL/u)
assert.ok(!text.includes("y".repeat(300)), "codex output past the clip is really dropped")
assert.match(text, /\*\*exec\*\* \(succeeded, 52ms\)/u)
assert.match(text, /\*\*exec\*\* \(exited 127, 783ms\)/u, "a failed command is marked as one")
assert.ok(
  !text.includes(`in /work/${graded}`),
  "the workdir the CLI appends to every command is not repeated on every line"
)
assert.ok(
  !text.includes("the prompt, which the bundle reports"),
  "the prompt block is not repeated: the problem statement is already above"
)

// The parser itself, on the same transcript.
const parsed = readCodexTrace(readFileSync(join(fb, "codex", "logs", `${graded}.run.log`), "utf8"))
assert.equal(parsed.workdir, `/work/${graded}`)
assert.equal(parsed.model, "gpt-5.6-sol")
assert.deepEqual(parsed.entries.map((entry) => entry.kind), ["assistant", "exec", "exec"])
assert.equal(parsed.entries[1].command, "/bin/zsh -lc 'CODEX-COMMAND-SENTINEL'")
assert.equal(parsed.entries[2].outcome, "exited 127")

// ---------------------------------------------------------------------------
// An instance the backfill has not reached: absent, not zero
// ---------------------------------------------------------------------------
const notYet = bundle(pending, options)
assert.match(notYet, /\| verdict \| unresolved \| not back filled yet \|/u)
assert.match(notYet, /\| model turns \| 0 \| — \|/u, "no codex run is a dash, never a zero")
assert.match(notYet, /\| tool calls \/ exec commands \| 0 \| — \|/u)
assert.match(notYet, /no codex transcript is archived for this instance yet/u)
assert.match(notYet, /codex-backfill\.sh --one stubtrace__pending/u, "and it says how to get one")

// ---------------------------------------------------------------------------
// An `eval error` says what it is: a fact about the evaluator, not the patch
// ---------------------------------------------------------------------------
writeFileSync(
  join(fb, "manifest.jsonl"),
  manifestRow({ id: graded, state: "cleaned", at: 1, verdict: "eval error", wallSeconds: 120 })
    + manifestRow({ id: pending, state: "cleaned", at: 1, verdict: "unresolved", wallSeconds: 90 })
)
const errored = bundle(graded, options)
assert.match(errored, /\| verdict \| eval error \| unresolved \|/u)
assert.match(errored, /An `eval error` verdict is a fact about the evaluator invocation/u)
assert.match(errored, /nothing here says whether that patch resolves the instance/u)

// ---------------------------------------------------------------------------
// The brief both analysts answer
// ---------------------------------------------------------------------------
assert.match(PROMPT, /THE OPTIMAL TRACE/u)
assert.match(PROMPT, /only the information\s+provided to a live agent/u)
assert.match(PROMPT, /No hindsight-only knowledge/u)
assert.match(PROMPT, /motivated by something already visible/u)
assert.match(PROMPT, /ctx\.call/u)
assert.match(PROMPT, /tool gap/u)
assert.match(PROMPT, /teaching gap/u)
assert.match(PROMPT, /context-visibility gap/u)
assert.match(PROMPT, /model choice gap/u)
assert.match(PROMPT, /pure waste/u)
assert.match(PROMPT, /adopts or rejects/u)
assert.match(PROMPT, /frames,\s*\n?tokens and dollars/u)
assert.match(PROMPT, /At most three harness changes/u)
assert.match(PROMPT, /Never an added review, audit or verification step/u)
assert.match(PROMPT, /Never instance-specific/u)

rmSync(temporary, { recursive: true, force: true })

console.log(
  "check-trace-bundle.mjs: the bundle carries the task, both traces and both bills, clips"
    + " what it clips out loud, says when codex has not run, and withholds the gold patch,"
    + " the graded tests and the hints."
)
