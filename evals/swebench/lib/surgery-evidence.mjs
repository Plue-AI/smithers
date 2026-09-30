/**
 * Reads a wave's journals for the four surgical changes r91 asked for.
 *
 *   node lib/surgery-evidence.mjs <journals-dir> [--json] [--interpreters <driver.log>]
 *
 * `fullbench/reports/rerun-r91.md` ends in a numbered list of what to do next,
 * and four of its items shipped as harness changes. Each one is a claim about
 * what a run then *does*, so each is counted here off the run's own journal
 * rather than read off the diff that shipped it. `lib/program-evidence.mjs`
 * already counts the eleven changes of the earlier program; this counts the
 * four that answer its finding, and the two files are kept apart so neither
 * has to be re-baselined when the other's question is settled.
 *
 * | metric | the next-step it settles |
 * | --- | --- |
 * | `testCalls` / `basedTestCalls` | 1 — bind `StandardFlows.tests` |
 * | `statedInterpreter` / `bareInterpreter` | 2 — state the project interpreter |
 * | `huntCalls` / `huntFrames` / `huntInstances` | 2 — what not stating it cost |
 * | `missingModule` | 2 — the failure the hunt was chasing |
 * | `transportRetries` / `retriesByCode` | 5 — retry the transport |
 * | `invalidProbes` | 3 — the probe bootstrap rule, made conditional |
 *
 * Three definitions carry the weight, and each is written here rather than in a
 * report so that two waves are counted by one rule:
 *
 * **Using the interpreter fact** is passing an absolute path as `bash`'s
 * `interpreter`, or opening a `command` with one. The fact the harness now
 * states is an absolute path; a bare `python3` is the r91 spelling that reached
 * an interpreter the repository's dependencies are not installed against.
 * `--interpreters` sharpens that from "an absolute path" to "the path this
 * instance was told", by reading the `project interpreter` lines `run-instance.sh`
 * writes into the driver log. A wave whose harness stated nothing has no such
 * lines and simply reports no `taughtPath` column, which is the honest answer
 * for it.
 *
 * **Hunting for it** is a discovery verb in the payload — `which python`,
 * `command -v`, `ls`/`find` under `/opt`, `sys.executable`, `conda env list`,
 * `echo $PATH`. Naming the absolute path is deliberately *not* a hunt: a run
 * that was handed the fact and then used it names the same path a run that
 * went looking for it does, and the difference between them is the verb.
 *
 * **A transport retry** is a `control.agent.model-retried` event carrying code
 * `transport`. Before the surgery a body that ended without a settlement was a
 * `HarnessError` no retry classification saw, so the count is zero by
 * construction on any wave that predates it — which is what makes a non-zero
 * count evidence rather than coincidence.
 *
 * A journal is opened read-only and never written, so this is safe against a
 * wave still in flight; a database mid-write is reported unreadable rather
 * than guessed at.
 *
 * @since 0.1.0
 */
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"
import { journalRows } from "./journal-rows.mjs"

/**
 * The interpreter each instance was told, read out of a driver log.
 *
 * @category conversions
 * @since 0.1.0
 */
export const taughtInterpreters = (logPath) => {
  const found = new Map()
  const line = /^\[([^\]\s]+?)-[^\]-]+\] project interpreter (\/\S+)$/
  for (const text of readFileSync(logPath, "utf8").split("\n")) {
    const match = line.exec(text.trim())
    if (match !== null) found.set(match[1], match[2])
  }
  return found
}

/** A discovery verb aimed at an interpreter, rather than a use of one. */
const HUNT = new RegExp(
  [
    "\\bwhich\\s+python",
    "\\bcommand\\s+-v\\s+python",
    "\\btype\\s+-?\\w*\\s*python",
    "\\b(ls|find)\\b[^\\n]{0,80}/opt\\b",
    "sys\\.executable",
    "conda\\s+(env\\s+)?list",
    "echo\\s+\\$PATH",
    "\\bcompgen\\b[^\\n]{0,40}python"
  ].join("|"),
  "i"
)

/** What a Python that does not own the repository answers with. */
const MISSING = /ModuleNotFoundError|No module named|ImproperlyConfigured|no such file or directory/i

/** The text of a `bash` call that the agent composed, without its own fields. */
const payloadText = (input) =>
  [input?.command, input?.script, input?.stdin, ...(Array.isArray(input?.args) ? input.args : [])]
    .filter((part) => typeof part === "string")
    .join("\n")

/** Whether a value names an absolute interpreter path. */
const isAbsolute = (value) => typeof value === "string" && value.startsWith("/")

/**
 * One journal's counts.
 *
 * @category conversions
 * @since 0.1.0
 */
export const readJournal = (databasePath, taught) => {
  // `control.db` beside the archived `engine.db` holds the `control.*` rows
  // of a current run; `journalRows` reads both (see lib/journal-rows.mjs).
  const rows = journalRows(databasePath, "event_type like 'control.agent.%'")

  const counts = {
    frames: 0,
    bashCalls: 0,
    statedInterpreter: 0,
    taughtPath: 0,
    bareInterpreter: 0,
    huntCalls: 0,
    huntFrames: 0,
    missingModule: 0,
    testCalls: 0,
    basedTestCalls: 0,
    invalidProbes: 0,
    modelRetries: 0,
    transportRetries: 0,
    retriesByCode: {}
  }

  let frameHunted = false
  const started = []
  for (const row of rows) {
    const payload = JSON.parse(row.payload_json)
    switch (row.event_type) {
      case "control.agent.turn-opened":
        counts.frames += 1
        frameHunted = false
        break
      case "control.agent.model-retried": {
        counts.modelRetries += 1
        const code = typeof payload.code === "string" ? payload.code : "unknown"
        counts.retriesByCode[code] = (counts.retriesByCode[code] ?? 0) + 1
        if (code === "transport") counts.transportRetries += 1
        break
      }
      case "control.agent.cell-call-started":
        started.push(payload)
        break
      case "control.agent.cell-call-settled": {
        const opened = started.shift()
        const input = opened?.input ?? {}
        const flow = payload.flowName
        // `value` is the flow's own answer and `message` is how a failure reads;
        // a `ModuleNotFoundError` arrives in one or the other depending on
        // whether the call failed or merely reported a non-zero exit.
        const result = JSON.stringify({ value: payload.value ?? null, message: payload.message ?? null })
        if (flow === "test") {
          counts.testCalls += 1
          if (input?.against === "base" || input?.baseline === true) counts.basedTestCalls += 1
        }
        if (flow === "bash") {
          counts.bashCalls += 1
          const text = payloadText(input)
          if (isAbsolute(input?.interpreter) || /^\s*\//.test(input?.command ?? "")) counts.statedInterpreter += 1
          else if (typeof input?.interpreter === "string" && input.interpreter.length > 0) counts.bareInterpreter += 1
          if (typeof taught === "string" && (input?.interpreter === taught || text.includes(taught))) {
            counts.taughtPath += 1
          }
          if (HUNT.test(text)) {
            counts.huntCalls += 1
            if (!frameHunted) {
              counts.huntFrames += 1
              frameHunted = true
            }
          }
          if (MISSING.test(result)) counts.missingModule += 1
        }
        if (/"invalidProbe"\s*:/.test(result)) counts.invalidProbes += 1
        break
      }
    }
  }
  return counts
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
export const readDirectory = (directory, taught = new Map()) => {
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
      const counts = readJournal(database, taught.get(entry))
      perInstance[entry] = counts
      accumulate(total, counts)
    } catch (error) {
      unreadable.push({ instance: entry, message: String(error?.message ?? error) })
    }
  }
  const values = Object.values(perInstance)
  return {
    instances: values.length,
    taughtInstances: taught.size,
    huntInstances: values.filter((one) => one.huntCalls > 0).length,
    testInstances: values.filter((one) => one.testCalls > 0).length,
    statedInterpreterInstances: values.filter((one) => one.statedInterpreter > 0).length,
    taughtPathInstances: values.filter((one) => one.taughtPath > 0).length,
    unreadable,
    total,
    perInstance
  }
}

const main = () => {
  const [directory, ...flags] = process.argv.slice(2)
  if (directory === undefined) {
    console.error("surgery-evidence.mjs: pass the journals directory")
    process.exit(2)
  }
  const logIndex = flags.indexOf("--interpreters")
  const logPath = logIndex === -1 ? undefined : flags[logIndex + 1]
  if (logIndex !== -1 && logPath === undefined) {
    console.error("surgery-evidence.mjs: --interpreters takes the driver log to read")
    process.exit(2)
  }
  const summary = readDirectory(directory, logPath === undefined ? new Map() : taughtInterpreters(logPath))
  if (flags.includes("--json")) {
    process.stdout.write(JSON.stringify(summary, undefined, 2) + "\n")
    return
  }
  const total = summary.total
  console.log(`instances          ${summary.instances}`)
  console.log(`frames             ${total.frames}`)
  console.log(
    `test flow          ${total.testCalls} calls in ${summary.testInstances} instances, ${total.basedTestCalls} against base`
  )
  console.log(`bash               ${total.bashCalls} calls`)
  console.log(`  stated path      ${total.statedInterpreter} in ${summary.statedInterpreterInstances} instances`)
  if (summary.taughtInstances > 0) {
    console.log(
      `  taught path      ${total.taughtPath} in ${summary.taughtPathInstances} of ${summary.taughtInstances} instances told one`
    )
  }
  console.log(`  bare interpreter ${total.bareInterpreter}`)
  console.log(
    `interpreter hunt   ${total.huntCalls} calls over ${total.huntFrames} frames in ${summary.huntInstances} instances`
  )
  console.log(`missing module     ${total.missingModule} results`)
  console.log(`invalid probes     ${total.invalidProbes}`)
  console.log(
    `model retries      ${total.modelRetries} (${total.transportRetries} transport) ${
      JSON.stringify(total.retriesByCode)
    }`
  )
  if (summary.unreadable.length > 0) {
    console.log(`unreadable         ${summary.unreadable.map((one) => one.instance).join(", ")}`)
  }
}

if (import.meta.url === `file://${process.argv[1]}`) main()
