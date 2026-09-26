/**
 * Distils the r97 wave's 45 journals into the narrow-only precision fixture.
 *
 *   node lib/r97-narrow-only-journals.mjs [journals-dir] [out-file]
 *
 * Same distillation as lib/narrowing-journals.mjs — every settled call's flow,
 * input and outcome, per-frame digests, transitions — with three additions the
 * r97 measurement needs:
 *
 * - `demands`: every `*-demanded` event the wave recorded, with its seq, so
 *   the replay in `packages/smithers/agent/harness/test/CompletionDemands.test.ts` validates
 *   itself against what the wave really did rather than a memory of it. r97
 *   fired narrow-only five times; three were false positives, and the fixture
 *   is the evidence the fix was measured on.
 * - `prompt`: the flow body each run was handed, re-rendered byte for byte by
 *   lib/write-flow.mjs from the dataset row and the facts the driver log
 *   records (seat `openai:gpt-5.6-sol`, container `flowsbench-<id>-r97`,
 *   test command from lib/test-command.py, interpreter
 *   `/opt/miniconda3/envs/testbed/bin/python` on all 45 — see
 *   fullbench/rerun-r97/driver.log). `NarrowedCheck.findOnly` reads taught
 *   terms off the run's prefix, so the replay needs the text.
 * - per-call `checkpointed` marks. The journal's `cell-call-started`
 *   projection drops the call's `at`, but a reading pinned to `ctx.base`
 *   never enters the live check ledger, and a replay that folded one in found
 *   narrowings the wave never saw (`psf__requests-2317`). The cell text is
 *   journaled and every r97 cell's calls are plain sequential `await
 *   ctx.call(...)` statements, so source order is runtime order; a
 *   string-aware scan of each cell recovers which calls named an `at`. A cell
 *   this misread would surface as a replay mismatch against `demands`, not
 *   pass silently.
 *
 * Mutating and failed calls carry no `input`: nothing in the completion
 * demands reads one, and dropping them keeps the fixture near the size of its
 * siblings.
 *
 * The fixture is regenerable only while fullbench/rerun-r97/journals and the
 * pinned evaluator venv exist; treat the committed copy as the record.
 */
import { execFileSync } from "node:child_process"
import { existsSync, readdirSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { fileURLToPath } from "node:url"

const here = dirname(fileURLToPath(import.meta.url))
const swebench = join(here, "..")
const journalsDir = resolve(process.argv[2] ?? join(swebench, "fullbench", "rerun-r97", "journals"))
const dataset = join(swebench, "swb-verified.json")
const out = resolve(
  process.argv[3] ??
    join(swebench, "..", "..", "packages", "smithers", "agent", "harness", "test", "fixtures", "r97Journals.json")
)

/** Flows whose calls change the workspace, so they are never checks. */
const editing = new Set(["write", "edit", "apply_patch"])

/** The reserved result keys the controller reads off an otherwise opaque call. */
const exitStatusKey = "exitCode"
const invalidProbeKey = "invalidProbe"

const reading = (value) => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return {}
  const status = value[exitStatusKey]
  const probe = value[invalidProbeKey]
  return {
    ...(typeof status === "number" ? { exit: status } : {}),
    ...(probe !== null && typeof probe === "object" && !Array.isArray(probe) ? { probe: true } : {})
  }
}

const demandTypes = new Map([
  ["control.agent.unmoved-demanded", "unmoved"],
  ["control.agent.unresolved-demanded", "unresolved"],
  ["control.agent.narrowed-demanded", "narrowed"],
  ["control.agent.narrow-only-demanded", "narrow-only"]
])

/** Which of a cell's `ctx.call` invocations name a checkpoint, in source order. */
const checkpointedCalls = (text) => {
  const marks = []
  let index = 0
  while (true) {
    const start = text.indexOf("ctx.call(", index)
    if (start < 0) break
    let cursor = start + "ctx.call(".length
    let depth = 1
    let quote
    const commas = []
    while (cursor < text.length && depth > 0) {
      const char = text[cursor]
      if (quote !== undefined) {
        if (char === "\\") cursor += 1
        else if (char === quote) quote = undefined
      } else if (char === "\"" || char === "'" || char === "`") quote = char
      else if (char === "(" || char === "[" || char === "{") depth += 1
      else if (char === ")" || char === "]" || char === "}") depth -= 1
      else if (char === "," && depth === 1) commas.push(cursor)
      cursor += 1
    }
    const third = commas.length >= 2 ? text.slice(commas[1] + 1, cursor - 1) : ""
    marks.push(/\bat\s*:/.test(third))
    index = cursor
  }
  return marks
}

const distil = (path) => {
  const db = new DatabaseSync(path, { readOnly: true })
  let rows
  try {
    rows = db.prepare(
      "select seq, event_type, payload_json from flows_journal_events"
        + " where event_type like 'control.agent.%' or event_type = 'flows.time-travel.effect-boundary'"
        + " order by seq"
    ).all()
  } finally {
    db.close()
  }
  const frames = []
  const demands = []
  const started = []
  let cellMarks = []
  let cellCallIndex = 0
  let frame
  let openedOn
  for (const row of rows) {
    const payload = JSON.parse(row.payload_json)
    if (row.event_type === "flows.time-travel.effect-boundary") {
      const effect = payload.effect
      if (
        openedOn === undefined && effect.kind === "harness/boundary/workspace-open"
        && effect.status === "succeeded" && effect.output?._tag === "Some"
      ) {
        openedOn = effect.output.value.complete ? effect.output.value.digest : ""
      }
      continue
    }
    const demanded = demandTypes.get(row.event_type)
    if (demanded !== undefined) {
      demands.push({ kind: demanded, seq: row.seq })
      continue
    }
    switch (row.event_type) {
      case "control.agent.turn-opened":
        frame = {
          calls: [],
          basis: "declared",
          digest: "",
          mutated: false,
          transition: "none",
          seq: row.seq
        }
        frames.push(frame)
        break
      case "control.agent.cell-produced":
        cellMarks = checkpointedCalls(payload.text ?? "")
        cellCallIndex = 0
        break
      case "control.agent.cell-call-started":
        started.push({ ...payload, checkpointed: cellMarks[cellCallIndex] === true })
        cellCallIndex += 1
        break
      case "control.agent.cell-call-settled": {
        const opened = started.shift()
        const ok = payload.outcome === "success"
        const mutates = editing.has(payload.flowName)
        frame.calls.push({
          flow: payload.flowName,
          ...(ok && !mutates ? { input: opened.input } : {}),
          ok,
          mutates,
          ...(opened.checkpointed ? { checkpointed: true } : {}),
          ...(ok ? reading(payload.value) : {}),
          seq: row.seq
        })
        break
      }
      case "control.agent.mutation-observed":
        frame.basis = payload.basis
        frame.digest = payload.digest
        frame.mutated = payload.mutated
        break
      case "control.agent.transition-applied":
        frame.transition = payload.transition._tag
        frame.transitionSeq = row.seq
        break
      default:
        break
    }
  }
  return { openedOn: openedOn ?? "", frames, demands }
}

const testCommand = (instance) =>
  execFileSync(
    join(swebench, ".venv-swb", "bin", "python"),
    [join(swebench, "lib", "test-command.py"), dataset, instance],
    { encoding: "utf8" }
  ).trim()

const prompt = (instance) =>
  execFileSync("node", [
    join(swebench, "lib", "write-flow.mjs"),
    dataset,
    instance,
    "openai:gpt-5.6-sol",
    `flowsbench-${instance.replace("__", "--")}-r97`,
    testCommand(instance),
    "/opt/miniconda3/envs/testbed/bin/python"
  ], { encoding: "utf8" })

const instances = readdirSync(journalsDir)
  .filter((name) => existsSync(join(journalsDir, name, "engine.db")))
  .sort()
const journals = instances.map((instance) => ({
  instance,
  prompt: prompt(instance),
  ...distil(join(journalsDir, instance, "engine.db"))
}))
writeFileSync(out, `${JSON.stringify({ journals }, null, 2)}\n`)
for (const journal of journals) {
  const calls = journal.frames.reduce((total, frame) => total + frame.calls.length, 0)
  const fired = journal.demands.map((demand) => demand.kind).join(",")
  console.log(
    `${journal.instance}: ${journal.frames.length} frames, ${calls} calls${fired === "" ? "" : `, demanded ${fired}`}`
  )
}
console.log(`wrote ${out}`)
