/**
 * Reads a wave's journals for the changes `rerun-r92.md` asked for by name.
 *
 *   node lib/round3-evidence.mjs <journals-dir> [--json] [--instance <id>]
 *
 * `fullbench/reports/rerun-r92.md` ends in a ranked list of five next-steps.
 * Four of them shipped as harness changes, and each one is a claim about what a
 * run then *does*, so each is counted here off the run's own journal rather
 * than read off the diff that shipped it. This is the third such reader:
 * `lib/program-evidence.mjs` counts the eleven changes of the original program,
 * `lib/surgery-evidence.mjs` counts the four that answered r91, and this counts
 * the ones that answer r92. They are kept apart so no one of them has to be
 * re-baselined when another's question is settled.
 *
 * | metric | the next-step it settles |
 * | --- | --- |
 * | `vacuous` | 1 — diagnose `django__django-14351` |
 * | `ladders` / `wallBound` / `survived` | 2 — the transport ladder's last rung |
 * | `transportRetries` | 2 — how often the class fired at all |
 *
 * Three definitions carry the weight.
 *
 * **A vacuous-verification observation** is a
 * `control.agent.vacuous-verification-observed` event: the controller telling a
 * run that the check it stored as `state.verification` is one this run had
 * already watched pass over the tree it was handed. The count is zero by
 * construction on any wave before the control existed, which is what makes a
 * non-zero count evidence rather than coincidence. The observation is a fact
 * and not a brake — nothing is refused and no cap is spent — so the interesting
 * number is never the firing but **what the run did next**, which is why every
 * firing carries its own after-record: how many frames the run still had, what
 * it stored as its proof after being told, whether it went and watched that
 * same check fail, and how the run ended.
 *
 * **A ladder** is a maximal contiguous run of `control.agent.model-retried`
 * events. Every rung of one sealed model step is journaled when that step
 * settles, so the rungs of a ladder share an `emitted_at_ms` and a ladder's own
 * wall clock cannot be read from the gaps between them. It is read instead as
 * the span from the frame's `turn-opened` to the rungs' own timestamp. For a
 * ladder that never recovered that span is the whole of what the frame spent
 * getting nowhere — the attempts and the sleeps together, which is exactly the
 * quantity `defaultModelRetryWindowMillis` bounds. For one that recovered it
 * also covers the attempt that worked, so it is an upper bound there and the
 * report says so.
 *
 * **A ladder survived** when a `control.agent.model-settled` follows its last
 * rung inside the same frame. That is the observable the rebuild produces: no
 * event records a client swap, because the swap is a process-internal exchange
 * of one HTTP client for another, but a ladder that ends in a settled model
 * call is a frame that got its answer across a transport that had been failing.
 * Under r92's harness that never happened: both ladders exhausted five rungs
 * and the run ended.
 *
 * A journal is opened read-only and never written, so this is safe against a
 * wave still in flight; a database mid-write is reported unreadable rather than
 * guessed at.
 *
 * @since 0.1.0
 */
import { readdirSync, statSync } from "node:fs"
import { join } from "node:path"
import { journalRows } from "./journal-rows.mjs"

/**
 * The declared rung count of the production ladder, so a ladder that stopped
 * short of it can be named.
 *
 * Mirrors `FlowEngineLike.defaultModelRetryTimes`. It is spelled here rather
 * than imported because this reader runs against journals from waves whose
 * harness declared a different number, and the report says which.
 *
 * @category constants
 * @since 0.1.0
 */
export const declaredRungs = 5

/**
 * The wall clock the production ladder may span, in milliseconds.
 *
 * Mirrors `FlowEngineLike.defaultModelRetryWindowMillis`, and is spelled here
 * for the same reason.
 *
 * @category constants
 * @since 0.1.0
 */
export const declaredWindowMillis = 45_000

/**
 * How much of a check's text two readings have to share to be the same check.
 *
 * The observation quotes the stored input as `NarrowedCheck` labels one: the
 * input canonicalised and clipped to 320 characters. A journal reader has the
 * input itself rather than the controller's signature, so it re-derives the
 * same text — keys sorted, no whitespace — and compares a prefix. 200 is well
 * inside the clip, so a comparison is never against an ellipsis, and it is far
 * past the point where two different commands still read alike.
 *
 * @category constants
 * @since 0.1.0
 */
export const labelPrefix = 200

/** A value serialised with its keys in a fixed order, the way a label is. */
const canonical = (value) => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`
  }
  return JSON.stringify(value) ?? "null"
}

/**
 * The comparable text of one call, as an observation quotes it.
 *
 * @category conversions
 * @since 0.1.0
 */
export const label = (flow, input) => `${flow} ${canonical(input).slice(0, labelPrefix)}`

/** Whether a call is the check an observation named. */
const isCheck = (firing, flow, input) => label(flow, input) === firing.label

/** The stored `{ flow, input }` of a transition, as a comparable string. */
const storedProof = (transition) => {
  const state = transition?.state
  if (state === null || typeof state !== "object" || Array.isArray(state)) return undefined
  const declared = state.verification
  if (declared === null || typeof declared !== "object" || Array.isArray(declared)) return undefined
  if (typeof declared.flow !== "string" || declared.input === undefined) return undefined
  return label(declared.flow, declared.input)
}

/** A settled call the run watched fail: the flow refused it, or it exited non-zero. */
const failing = (payload) => {
  if (payload.outcome !== "success") return true
  const value = payload.value
  if (value === null || typeof value !== "object") return false
  return typeof value.exitCode === "number" && value.exitCode !== 0
}

/**
 * One journal's counts, and every firing it carries in full.
 *
 * @category conversions
 * @since 0.1.0
 */
export const readJournal = (databasePath) => {
  // `control.db` beside the archived `engine.db` holds the `control.*` rows
  // of a current run; `journalRows` reads both (see lib/journal-rows.mjs).
  const rows = journalRows(databasePath, "event_type like 'control.agent.%'")

  const counts = {
    frames: 0,
    modelRetries: 0,
    transportRetries: 0,
    retriesByCode: {},
    vacuousObserved: 0,
    ladderCount: 0,
    ladderRungs: 0,
    survivedLadders: 0,
    wallBoundLadders: 0,
    exhaustedLadders: 0
  }
  const vacuous = []
  const ladders = []

  let frameIndex = 0
  let frameOpenedAt = 0
  let ladder
  const started = []
  let outcome = "none"

  const closeLadder = () => {
    if (ladder === undefined) return
    ladders.push(ladder)
    ladder = undefined
  }

  for (const row of rows) {
    const payload = JSON.parse(row.payload_json)
    if (row.event_type !== "control.agent.model-retried") closeLadder()
    switch (row.event_type) {
      case "control.agent.turn-opened":
        counts.frames += 1
        frameIndex = counts.frames
        frameOpenedAt = row.emitted_at_ms
        started.length = 0
        break
      case "control.agent.model-retried": {
        counts.modelRetries += 1
        const code = typeof payload.code === "string" ? payload.code : "unknown"
        counts.retriesByCode[code] = (counts.retriesByCode[code] ?? 0) + 1
        if (code === "transport") counts.transportRetries += 1
        if (ladder === undefined) {
          ladder = {
            frame: frameIndex,
            seq: row.seq,
            rungs: 0,
            codes: [],
            delayMillis: 0,
            spanMillis: Math.max(0, row.emitted_at_ms - frameOpenedAt),
            survived: false
          }
        }
        ladder.rungs += 1
        ladder.codes.push(code)
        ladder.delayMillis += typeof payload.delayMillis === "number" ? payload.delayMillis : 0
        break
      }
      case "control.agent.model-settled":
        // The frame got its answer. A ladder that ran in this frame is a ladder
        // the run came back from, whatever it took to get there.
        for (const one of ladders) if (one.frame === frameIndex) one.survived = true
        break
      case "control.agent.cell-call-started":
        started.push(payload)
        break
      case "control.agent.cell-call-settled": {
        const opened = started.shift()
        for (const one of vacuous) {
          if (isCheck(one, payload.flowName, opened?.input) && failing(payload)) one.watchedFailAfter = true
        }
        break
      }
      case "control.agent.transition-applied": {
        const proof = storedProof(payload.transition)
        for (const one of vacuous) {
          if (proof !== undefined && proof !== one.label) one.changedProof = true
        }
        break
      }
      case "control.agent.cell-settled":
        outcome = typeof payload.outcome === "string" ? payload.outcome : outcome
        break
      case "control.agent.vacuous-verification-observed": {
        counts.vacuousObserved += 1
        vacuous.push({
          seq: row.seq,
          frame: frameIndex,
          nextFrame: payload.nextFrame,
          flow: payload.flow,
          signature: payload.signature,
          check: payload.check,
          // The observed check as this reader spells one, so a later
          // transition or a later call can be compared against it without
          // replaying the controller's own signature function.
          label: `${payload.flow} ${String(payload.check).slice(0, labelPrefix)}`,
          framesAfter: 0,
          changedProof: false,
          watchedFailAfter: false
        })
        break
      }
      default:
        break
    }
    if (row.event_type === "control.agent.turn-opened") {
      for (const one of vacuous) if (one.seq < row.seq) one.framesAfter += 1
    }
  }
  closeLadder()

  for (const one of ladders) {
    counts.ladderCount += 1
    counts.ladderRungs += one.rungs
    if (one.survived) counts.survivedLadders += 1
    else if (one.rungs >= declaredRungs) counts.exhaustedLadders += 1
    else counts.wallBoundLadders += 1
  }
  return { ...counts, outcome, vacuous, ladders }
}

/** Adds one journal's counts into a running total. */
const accumulate = (total, counts) => {
  for (const [key, value] of Object.entries(counts)) {
    if (key === "retriesByCode") {
      for (const [code, hits] of Object.entries(value)) {
        total.retriesByCode[code] = (total.retriesByCode[code] ?? 0) + hits
      }
      continue
    }
    if (typeof value !== "number") continue
    total[key] = (total[key] ?? 0) + value
  }
  return total
}

/**
 * Every journal under a directory, folded.
 *
 * @category conversions
 * @since 0.1.0
 */
export const readDirectory = (directory) => {
  const perInstance = {}
  const unreadable = []
  const total = { retriesByCode: {} }
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
  const values = Object.entries(perInstance)
  return {
    instances: values.length,
    vacuousInstances: values.filter(([, one]) => one.vacuousObserved > 0).map(([id]) => id),
    ladderInstances: values.filter(([, one]) => one.ladderCount > 0).map(([id]) => id),
    unreadable,
    total,
    perInstance
  }
}

const main = () => {
  const flags = process.argv.slice(2)
  const directory = flags.find((one) => !one.startsWith("--") && flags[flags.indexOf(one) - 1] !== "--instance")
  if (directory === undefined) {
    console.error("round3-evidence.mjs: pass the journals directory")
    process.exit(2)
  }
  const only = flags.indexOf("--instance") === -1 ? undefined : flags[flags.indexOf("--instance") + 1]
  const summary = readDirectory(directory)
  if (flags.includes("--json")) {
    const shown = only === undefined
      ? summary
      : { ...summary, perInstance: { [only]: summary.perInstance[only] } }
    process.stdout.write(JSON.stringify(shown, undefined, 2) + "\n")
    return
  }
  const total = summary.total
  console.log(`instances            ${summary.instances}`)
  console.log(`frames               ${total.frames}`)
  console.log(
    `vacuous verification ${total.vacuousObserved} observations in ${summary.vacuousInstances.length} instances`
      + `${summary.vacuousInstances.length > 0 ? `: ${summary.vacuousInstances.join(", ")}` : ""}`
  )
  for (const [id, one] of Object.entries(summary.perInstance)) {
    for (const firing of one.vacuous) {
      console.log(
        `  ${id} frame ${firing.frame} ${firing.flow} — ${firing.framesAfter} frames after,`
          + ` changed proof: ${firing.changedProof}, watched it fail after: ${firing.watchedFailAfter},`
          + ` run ended ${one.outcome}`
      )
    }
  }
  console.log(
    `model retries        ${total.modelRetries} (${total.transportRetries} transport)`
      + ` ${JSON.stringify(total.retriesByCode)}`
  )
  console.log(
    `ladders              ${total.ladderCount ?? 0} over ${total.ladderRungs ?? 0} rungs`
      + ` — ${total.survivedLadders ?? 0} survived, ${total.exhaustedLadders ?? 0} exhausted all ${declaredRungs},`
      + ` ${total.wallBoundLadders ?? 0} stopped short`
  )
  for (const [id, one] of Object.entries(summary.perInstance)) {
    for (const rung of one.ladders) {
      console.log(
        `  ${id} frame ${rung.frame}: ${rung.rungs} rungs, ${rung.delayMillis} ms declared backoff,`
          + ` ${rung.spanMillis} ms frame span, codes ${rung.codes.join("/")},`
          + ` ${rung.survived ? "settled after" : "no settle"}`
      )
    }
  }
  if (summary.unreadable.length > 0) {
    console.log(`unreadable           ${summary.unreadable.map((one) => one.instance).join(", ")}`)
  }
}

if (import.meta.url === `file://${process.argv[1]}`) main()
