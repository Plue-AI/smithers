/**
 * Reads a run's journals for the behaviour `analysis/PROGRAM.md` predicts.
 *
 *   node lib/program-evidence.mjs <journals-dir> [--json] [--suffix -r91]
 *
 * The program's eleven changes each carry a falsifiable prediction, and every
 * one of them is a statement about what the agent *did*, not about what the
 * harness contains. This counts the doing, straight off `control.agent.*`
 * events, so a claim that a change acted is a number from the run's own
 * journal rather than a reading of the diff that shipped it.
 *
 * What it counts, and which change each settles:
 *
 * | metric | change |
 * | --- | --- |
 * | `recallOrdinals` — ordinals named in a transition's `recall` | #1 |
 * | `renderKeys` — state keys named in a transition's `render` | #1 |
 *
 * The first two are structurally zero on any journal written after 2026-08-24:
 * `recall` and `render` belonged to the filing surface, which was deleted, and
 * the fields survive on the transition schema for decoding alone. They are read
 * here because the waves that used them are still on disk.
 * | `zeroCallFrames` — frames whose cell issued no call | #1, #5 |
 * | `deadFrames` — frames that applied no transition | #5 |
 * | `failedCalls` / `recoveredFrames` — a failed call the same cell survived | #8 |
 * | `testCalls` — calls to the structured `test` flow | #6 |
 * | `baselinedTestCalls` — those asking for the pristine-base comparison | #6 |
 * | `scriptCalls` — `bash` calls passing a payload as data | #4 |
 * | `quotedCalls` — `bash` calls still composing a shell command string | #4 |
 * | `failedEdits` — `edit`/`write`/`apply_patch` calls that did not apply | #3 |
 * | `cacheRate` — cached input tokens over input tokens | cost |
 *
 * A journal is read read-only and never written, so this is safe to run
 * against a wave that is still in flight; a database a live run is mid-write
 * in is reported as unreadable rather than guessed at.
 *
 * @since 0.1.0
 */
import { readdirSync, statSync } from "node:fs"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"

/** The flows that change the workspace, so a failure is a failed mutation. */
const mutating = new Set(["edit", "write", "apply_patch"])

/** Reads one journal into the counts above. */
export const readJournal = (databasePath) => {
  const database = new DatabaseSync(databasePath, { readOnly: true })
  let rows
  try {
    rows = database.prepare(
      "select seq, event_type, payload_json from flows_journal_events"
        + " where event_type like 'control.agent.%' order by seq"
    ).all()
  } finally {
    database.close()
  }

  const counts = {
    frames: 0,
    modelCalls: 0,
    calls: 0,
    zeroCallFrames: 0,
    deadFrames: 0,
    recallTransitions: 0,
    recallOrdinals: 0,
    renderTransitions: 0,
    renderKeys: 0,
    failedCalls: 0,
    framesWithFailedCall: 0,
    recoveredFrames: 0,
    testCalls: 0,
    baselinedTestCalls: 0,
    bashCalls: 0,
    scriptCalls: 0,
    quotedCalls: 0,
    editCalls: 0,
    failedEdits: 0,
    grepCalls: 0,
    readCalls: 0,
    completing: 0,
    usage: { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningTokens: 0 }
  }

  let frame
  const started = []
  const closeFrame = () => {
    if (frame === undefined) return
    counts.frames += 1
    if (frame.calls === 0) counts.zeroCallFrames += 1
    if (frame.transition === "none") counts.deadFrames += 1
    if (frame.failed > 0) {
      counts.framesWithFailedCall += 1
      // A recovery is the cell surviving its own failed call: it went on to
      // settle another call, or it still applied a transition. Both are the
      // thing `{ok:false}` was for — the branch the model already wrote ran.
      if (frame.callsAfterFailure > 0 || frame.transition !== "none") counts.recoveredFrames += 1
    }
    frame = undefined
  }

  for (const row of rows) {
    const payload = JSON.parse(row.payload_json)
    switch (row.event_type) {
      case "control.agent.turn-opened":
        closeFrame()
        frame = { calls: 0, failed: 0, callsAfterFailure: 0, transition: "none" }
        break
      case "control.agent.model-settled":
        counts.modelCalls += 1
        for (const key of Object.keys(counts.usage)) counts.usage[key] += payload.usage?.[key] ?? 0
        break
      case "control.agent.cell-call-started":
        started.push(payload)
        break
      case "control.agent.cell-call-settled": {
        const opened = started.shift()
        const input = opened?.input ?? {}
        const flow = payload.flowName
        const ok = payload.outcome === "success"
        counts.calls += 1
        if (frame !== undefined) {
          frame.calls += 1
          if (frame.failed > 0) frame.callsAfterFailure += 1
          if (!ok) frame.failed += 1
        }
        if (!ok) counts.failedCalls += 1
        if (flow === "test") {
          counts.testCalls += 1
          if (input?.against === "base" || input?.baseline === true) counts.baselinedTestCalls += 1
        }
        if (flow === "bash") {
          counts.bashCalls += 1
          if (typeof input?.script === "string" || typeof input?.stdin === "string") counts.scriptCalls += 1
          else counts.quotedCalls += 1
        }
        if (flow === "grep") counts.grepCalls += 1
        if (flow === "read") counts.readCalls += 1
        if (mutating.has(flow)) {
          counts.editCalls += 1
          if (!ok) counts.failedEdits += 1
        }
        break
      }
      case "control.agent.transition-applied": {
        const transition = payload.transition ?? {}
        if (frame !== undefined) frame.transition = transition._tag ?? "none"
        if (transition._tag === "complete") counts.completing += 1
        const recall = Array.isArray(transition.recall) ? transition.recall : []
        const render = Array.isArray(transition.render) ? transition.render : []
        if (recall.length > 0) {
          counts.recallTransitions += 1
          counts.recallOrdinals += recall.length
        }
        if (render.length > 0) {
          counts.renderTransitions += 1
          counts.renderKeys += render.length
        }
        break
      }
    }
  }
  closeFrame()
  return counts
}

/** Adds one journal's counts into a running total. */
const accumulate = (total, counts) => {
  for (const [key, value] of Object.entries(counts)) {
    if (key === "usage") {
      for (const [name, tokens] of Object.entries(value)) total.usage[name] += tokens
      continue
    }
    total[key] = (total[key] ?? 0) + value
  }
  return total
}

const main = () => {
  const [directory, ...flags] = process.argv.slice(2)
  if (directory === undefined) {
    console.error("program-evidence.mjs: pass the journals directory")
    process.exit(2)
  }
  const asJson = flags.includes("--json")
  const perInstance = {}
  const unreadable = []
  const total = {
    usage: { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningTokens: 0 }
  }
  for (const entry of readdirSync(directory).sort()) {
    const database = join(directory, entry, "engine.db")
    try {
      if (!statSync(database).isFile()) continue
    } catch {
      continue
    }
    try {
      const counts = readJournal(database)
      perInstance[entry] = counts
      accumulate(total, counts)
    } catch (error) {
      unreadable.push({ instance: entry, message: String(error?.message ?? error) })
    }
  }
  const instances = Object.keys(perInstance).length
  const summary = {
    instances,
    unreadable,
    total,
    cacheRate: total.usage.inputTokens === 0
      ? 0
      : total.usage.cachedInputTokens / total.usage.inputTokens,
    framesPerInstance: instances === 0 ? 0 : total.frames / instances,
    perInstance
  }
  if (asJson) {
    process.stdout.write(JSON.stringify(summary, undefined, 2) + "\n")
    return
  }
  console.log(`instances        ${summary.instances}`)
  console.log(`frames           ${total.frames} (${summary.framesPerInstance.toFixed(1)}/instance)`)
  console.log(`calls            ${total.calls}`)
  console.log(`zero-call frames ${total.zeroCallFrames}`)
  console.log(`dead frames      ${total.deadFrames}`)
  console.log(`recall           ${total.recallOrdinals} ordinals over ${total.recallTransitions} transitions`)
  console.log(`render           ${total.renderKeys} keys over ${total.renderTransitions} transitions`)
  console.log(
    `failed calls     ${total.failedCalls} in ${total.framesWithFailedCall} frames, ${total.recoveredFrames} recovered`
  )
  console.log(`test flow        ${total.testCalls} calls, ${total.baselinedTestCalls} against base`)
  console.log(
    `bash             ${total.bashCalls} calls, ${total.scriptCalls} as data, ${total.quotedCalls} as a command string`
  )
  console.log(`edits            ${total.editCalls} calls, ${total.failedEdits} failed`)
  console.log(`cache rate       ${(summary.cacheRate * 100).toFixed(1)}%`)
  if (unreadable.length > 0) console.log(`unreadable       ${unreadable.map((one) => one.instance).join(", ")}`)
}

if (import.meta.url === `file://${process.argv[1]}`) main()
