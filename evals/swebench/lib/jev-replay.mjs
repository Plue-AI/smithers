/**
 * Replays the supervisor's reading over archived journals, offline, and scores
 * it against the verdicts the evaluator gave.
 *
 *   node lib/jev-replay.mjs <journals-dir> --manifest <fullbench/manifest.jsonl>
 *       [--suffix -r97] [--limit N] [--json] [--dry-run]
 *
 * The harness asks Jev about a run's shape once per frame, off the cell loop's
 * hot path (`@smthrs/harness` `Supervisor`). Before its nudge is allowed in
 * front of a model, the question is whether the reading predicts anything: a
 * run it calls thrashing or off target should be one the evaluator later marks
 * unresolved, and a run it calls confident should be one it marks resolved.
 * This script builds, for every frame the live supervisor would have been
 * offered, the same `Snapshot` the harness builds, asks the same classifier,
 * and reports precision, recall and F1 against the manifest's verdicts: of
 * `Supervisor.crosses`, the rule `judge` nudges on, and of each of the five
 * `Supervisor.triggers` it is made of, beside the levels and `needs_help`.
 *
 * The snapshot is rebuilt from the journal and not from the harness's memory:
 * `lib/journal-facts.mjs` folds the `control.agent.*` events back into the
 * per-frame ledgers `CellTurn` carried, through the harness's own modules, so
 * a count read here is the count the run had. Three things the archive cannot
 * give are stated rather than guessed at:
 *
 * - No memory is recalled. Recalled rows are judged by a separate relevance
 *   reading, not by `supervisor/turn`, and the supervisor asks nothing about
 *   memory, so the eleven fixed questions are asked.
 * - `remoteMutations` is zero. The journal records container writes only on
 *   the call that made them, and the r9x waves ran no container-side edits.
 * - `task` is the last system text of the first frame's `model-requested`
 *   record, which is where the run's task segment sits (see `opening` in
 *   `@smthrs/agent` Agent.ts). A journal written before that record existed
 *   has no task text, and its snapshots say so with an empty string rather
 *   than with the dataset's problem statement, which is not what the run read.
 *
 * Beside the supervisor, the journal's own Jev gates are replayed without
 * asking anything (`gates`): each `relevance/unnecessary` decision is
 * re-thresholded per item kind at {@link withholdThresholds}, and each
 * monitor's readings, deliveries and suppressions are counted, with the
 * deliveries a run answered within {@link resolvedWithin} frames by a newly
 * passing check or a rise in `on_target`.
 *
 * `--dry-run` builds every snapshot and prints their counts and the gates
 * without asking Jev; `fixtures/check-jev-replay.mjs` runs it that way over
 * synthetic journals. A live run needs `AI_GATEWAY_API_KEY` and reaches the gateway
 * through the same egress client the CLI's own judge uses, at most four
 * requests in flight.
 *
 * A journal is read read-only and never written.
 *
 * @since 0.1.0
 */
import { Effect, Layer, Redacted } from "effect"
import { existsSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import * as Judgement from "../../../packages/smithers/agent/harness/src/Judgement.ts"
import * as Monitor from "../../../packages/smithers/agent/harness/src/Monitor.ts"
import * as Relevance from "../../../packages/smithers/agent/harness/src/Relevance.ts"
import * as Supervisor from "../../../packages/smithers/agent/harness/src/Supervisor.ts"
import * as UnmovedTree from "../../../packages/smithers/agent/harness/src/UnmovedTree.ts"
import * as Evaluator from "../../../packages/smithers/agent/model/src/Evaluator.ts"
import * as EgressHttpClient from "../../../packages/smithers/flows/platform-node/src/EgressHttpClient.ts"
import { read as readManifest } from "./fullbench-manifest.mjs"
import { read as readFacts } from "./journal-facts.mjs"
import { journalRows } from "./journal-rows.mjs"

const usage =
  "usage: node lib/jev-replay.mjs <journals-dir> --manifest <manifest.jsonl> [--suffix S] [--limit N] [--json] [--dry-run]"

/** Parses the command line into its options. */
export const parseArguments = (argv) => {
  const options = { journals: undefined, manifest: undefined, suffix: "", limit: Infinity, json: false, dryRun: false }
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index]
    if (argument === "--manifest") options.manifest = argv[++index]
    else if (argument === "--suffix") options.suffix = argv[++index] ?? ""
    else if (argument === "--limit") options.limit = Number.parseInt(argv[++index] ?? "", 10)
    else if (argument === "--json") options.json = true
    else if (argument === "--dry-run") options.dryRun = true
    else if (options.journals === undefined) options.journals = argument
    else throw new Error(`unexpected argument ${argument}`)
  }
  if (options.journals === undefined) throw new Error(usage)
  if (!Number.isFinite(options.limit) && options.limit !== Infinity) throw new Error("--limit takes an integer")
  return options
}

/**
 * The transition a frame's snapshot names: the transition it applied, or how
 * its cell ended when it applied none.
 */
const transitionOf = (frame) => {
  if (frame.outcome === "raised" || frame.outcome === "rejected") return frame.outcome
  if (frame.transition === "complete" || frame.transition === "park") return frame.transition
  return "continue"
}

/** The demand events issued at or before one frame's transition. */
const demandsBefore = (facts, seq) => {
  const count = (rows) => rows.filter((row) => row.seq <= seq).length
  return {
    narrowingDemands: count(facts.demands.narrowed) + count(facts.demands.narrowOnly),
    unmovedDemands: count(facts.demands.unmoved),
    unresolvedDemands: count(facts.demands.unresolved),
    // `claim-demanded` is written on every reading of the claim brake; only
    // the readings that handed the completion back are what `State.claimDemands`
    // counts.
    claimDemands: count(facts.demands.claim.filter((row) => row.demanded === true))
  }
}

/** Whether a completion demand was handed back for this frame: its transition, then the next frame. */
const bounced = (facts, frame, next) => {
  const after = frame.transitionSeq ?? Number.MAX_SAFE_INTEGER
  const before = next?.seq ?? Number.MAX_SAFE_INTEGER
  const within = (row) => row.seq > after && row.seq < before
  return [
    ...facts.demands.unmoved,
    ...facts.demands.unresolved,
    ...facts.demands.narrowed,
    ...facts.demands.narrowOnly,
    ...facts.demands.claim.filter((row) => row.demanded === true)
  ].some(within)
}

/**
 * Whether the live supervisor would have been offered this frame.
 *
 * `CellTurn` offers a frame from its live boundary only when the run carries
 * on through it (`drain` in `CellTurn.ts`): a cell the parser rejected offers
 * nothing, a completion offers nothing unless a demand handed it back, an
 * honored park offers nothing, and the last frame of the budget offers
 * nothing. A raise and a refused park continue the run and are offered.
 *
 * @category conversions
 * @since 0.1.0
 */
export const offered = (facts, index, maxFrames, approvalChannel) => {
  const frame = facts.frames[index]
  if (frame.outcome === "rejected") return false
  if (maxFrames > 0 && frame.index + 1 >= maxFrames) return false
  if (frame.transition === "complete") return bounced(facts, frame, facts.frames[index + 1])
  if (frame.transition === "park") return !approvalChannel
  return true
}

/**
 * Builds the snapshots the harness would have offered, one per offered frame.
 *
 * `facts.frames` is in frame order and each entry already carries the ledgers
 * the frame closed on, so the signals are read off the entry and the streaks
 * are folded here exactly as `Frame.account` folds them: a frame that changed
 * nothing advances the read-only streak, a frame whose every call was already
 * issued and that changed nothing advances the repeat streak, and a frame
 * that issued no call carries the repeat streak across. Every frame is folded;
 * only the frames `offered` admits become snapshots, and a snapshot's recent
 * frames are the offered frames before it, as the live handle keeps them.
 *
 * The prose is the model's text with its fenced cell stripped, by the same
 * `prose` the live supervisor calls. `treeMoved` is `UnmovedTree.find` on the same inputs.
 *
 * @category conversions
 * @since 0.1.0
 */
export const snapshots = (facts) => {
  const maxFrames = facts.armed?.maxFrames ?? 0
  const approvalChannel = facts.armed?.approvalChannel === true
  const out = []
  const recent = []
  let readOnlyFrames = 0
  let repeatFrames = 0
  const asked = new Set()
  let callsSettled = 0
  let callsFailed = 0
  for (const [index, frame] of facts.frames.entries()) {
    // The frame's own opening: every demand and sufficiency notice the run
    // held when this frame closed was issued by a frame before it. A frame's
    // own demands follow its transition and belong to the frame after.
    const seq = frame.seq
    readOnlyFrames = frame.mutated ? 0 : readOnlyFrames + 1
    const signatures = frame.calls.map((call) => call.signature)
    const novel = signatures.some((signature) => !asked.has(signature))
    if (signatures.length > 0) repeatFrames = novel || frame.mutated ? 0 : repeatFrames + 1
    for (const signature of signatures) asked.add(signature)
    callsSettled += frame.calls.length
    callsFailed += frame.calls.filter((call) => !call.ok).length
    if (!offered(facts, index, maxFrames, approvalChannel)) continue
    const written = Supervisor.prose(frame.prose ?? "")
    const current = {
      frame: frame.index,
      cell: Supervisor.head(frame.cell ?? ""),
      prose: Supervisor.head(written),
      printed: Supervisor.tail(frame.printed ?? ""),
      transition: transitionOf(frame),
      mutated: frame.mutated
    }
    const frames = [...recent.slice(-(Supervisor.recentFrames - 1)), current]
    recent.push(current)
    out.push({
      task: Judgement.task(facts.task ?? ""),
      frames,
      signals: {
        frame: frame.index,
        maxFrames,
        readOnlyFrames,
        repeatFrames,
        mutations: frame.closingEpoch ?? 0,
        remoteMutations: 0,
        treeMoved: UnmovedTree.find({ opened: facts.openedDigest, digest: frame.workspaceDigest ?? "", elsewhere: 0 })
          === undefined,
        paths: frame.paths ?? 0,
        checksRun: (frame.ledger ?? []).length,
        checksFailing: (frame.ledger ?? []).filter((check) => check.failing).length,
        failuresUnanswered: (frame.failures ?? []).length,
        callsFailed,
        callsSettled,
        ...demandsBefore(facts, seq),
        sufficiencyStated: facts.sufficiencyEvents.some((event) => event.seq <= seq)
      },
      // An archived journal records no catalog, so no skill or use-jev monitor is rebuilt.
      skills: [],
      called: [],
      jevAvailable: false
    })
  }
  return out
}

/** The instance id an archived journal directory belongs to, or nothing. */
const instanceOf = (name, suffix) => {
  if (suffix !== "" && !name.endsWith(suffix)) return undefined
  const id = suffix === "" ? name : name.slice(0, -suffix.length)
  return /^[A-Za-z0-9][A-Za-z0-9._-]*__[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id) ? id : undefined
}

/**
 * The archived journals under a directory, keyed by instance id.
 *
 * @category conversions
 * @since 0.1.0
 */
export const journalsUnder = (directory, suffix = "") =>
  readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
    .map((entry) => ({ id: instanceOf(entry.name, suffix), path: join(directory, entry.name, "engine.db") }))
    .filter((entry) => entry.id !== undefined && existsSync(entry.path))
    .sort((a, b) => a.id.localeCompare(b.id))

/** Verdicts by instance id, `resolved` and `unresolved` only. */
const labelsOf = (manifestPath) => {
  const labels = new Map()
  if (manifestPath === undefined) return labels
  const manifest = readManifest(manifestPath)
  for (const [id, state] of manifest.states) {
    if (state.verdict === "resolved" || state.verdict === "unresolved") labels.set(id, state.verdict)
  }
  return labels
}

/** Precision, recall and F1 of one predicate over labelled runs; positive predicts `unresolved`. */
const score = (runs, predicate) => {
  let tp = 0
  let fp = 0
  let fn = 0
  let tn = 0
  for (const run of runs) {
    const positive = predicate(run)
    const unresolved = run.label === "unresolved"
    if (positive && unresolved) tp++
    else if (positive && !unresolved) fp++
    else if (!positive && unresolved) fn++
    else tn++
  }
  const precision = tp + fp === 0 ? 0 : tp / (tp + fp)
  const recall = tp + fn === 0 ? 0 : tp / (tp + fn)
  const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall)
  return { tp, fp, fn, tn, precision, recall, f1 }
}

const strong = (level) => level === "strong"
const mildOrStrong = (level) => level === "mild" || level === "strong"

/**
 * Every signal scored, over the last frame's reading and over any frame's.
 *
 * @category conversions
 * @since 0.1.0
 */
export const scoreboard = (runs) => {
  const labelled = runs.filter((run) => run.label !== undefined && run.readings.length > 0)
  const last = (run) => run.readings[run.readings.length - 1]
  const rows = []
  // The live rule itself, not a copy: `Supervisor.crosses` is what `judge`
  // nudges on, and each of `Supervisor.triggers` is one of its inequalities.
  rows.push({ signal: "crossed", frame: "last", ...score(labelled, (run) => Supervisor.crosses(last(run))) })
  rows.push({ signal: "crossed", frame: "any", ...score(labelled, (run) => run.readings.some(Supervisor.crosses)) })
  for (const [name, fires] of Object.entries(Supervisor.triggers)) {
    rows.push({ signal: name, frame: "last", ...score(labelled, (run) => fires(last(run))) })
    rows.push({ signal: name, frame: "any", ...score(labelled, (run) => run.readings.some(fires)) })
  }
  for (const emotion of Supervisor.emotions) {
    for (const [name, test] of [["strong", strong], ["mild|strong", mildOrStrong]]) {
      rows.push({
        signal: `${emotion}=${name}`,
        frame: "last",
        ...score(labelled, (run) => test(last(run).emotions[emotion]))
      })
      rows.push({
        signal: `${emotion}=${name}`,
        frame: "any",
        ...score(labelled, (run) => run.readings.some((reading) => test(reading.emotions[emotion])))
      })
    }
  }
  rows.push({ signal: "needs_help!=none", frame: "last", ...score(labelled, (run) => last(run).needsHelp !== "none") })
  rows.push({
    signal: "needs_help!=none",
    frame: "any",
    ...score(labelled, (run) => run.readings.some((reading) => reading.needsHelp !== "none"))
  })
  for (const help of ["clarification", "permission", "stuck", "risky_action"]) {
    rows.push({
      signal: `needs_help=${help}`,
      frame: "any",
      ...score(labelled, (run) => run.readings.some((reading) => reading.needsHelp === help))
    })
  }
  return { labelled: labelled.length, unresolved: labelled.filter((run) => run.label === "unresolved").length, rows }
}

/**
 * The probabilities of "unnecessary" a relevance decision is re-thresholded
 * at; the middle one is `Relevance.withholdAt`, the live rule.
 *
 * @category constants
 * @since 1.0.0-rc.0
 */
export const withholdThresholds = [0.8, Relevance.withholdAt, 0.95]

/**
 * Frames, the delivering one first, in which a delivery counts as resolved.
 *
 * @category constants
 * @since 1.0.0-rc.0
 */
export const resolvedWithin = 3

const lintMonitor = Monitor.lint()[0]

/**
 * `Supervisor.crosses` as a 0 or 1, after asserting `Monitor.lint` scores the
 * reading the same: the replay's rule and the live monitor's are one rule.
 *
 * @category conversions
 * @since 1.0.0-rc.0
 */
export const lintAgrees = (reading) => {
  const rule = Supervisor.crosses(reading) ? 1 : 0
  const scored = lintMonitor.score(reading, undefined)
  if (scored !== rule) throw new Error(`Monitor.lint scored ${scored} where Supervisor.crosses gives ${rule}`)
  return rule
}

/**
 * An empty gates board.
 *
 * @category constructors
 * @since 1.0.0-rc.0
 */
export const emptyGates = () => ({
  relevance: { decisions: 0, unreadable: 0, kinds: {} },
  monitors: {},
  lintChecked: 0
})

const gateTypes = [
  "control.agent.turn-opened",
  "control.agent.decision-settled",
  "control.agent.supervisor-settled",
  "control.agent.steering-drained"
]

/**
 * The rows `gates` reads from one archived journal, payloads parsed.
 *
 * @category conversions
 * @since 1.0.0-rc.0
 */
export const readGates = (databasePath) =>
  journalRows(databasePath, `event_type in (${gateTypes.map((type) => `'${type}'`).join(", ")})`)
    .map((row) => ({ seq: row.seq, type: row.event_type, payload: JSON.parse(row.payload_json) }))

const monitorOf = (board, id) =>
  board.monitors[id] ??= { asked: 0, readings: 0, crossed: 0, delivered: 0, resolved: 0, suppressed: {} }

const unnecessary = /^unnecessary_(\d+)$/

/** One `relevance/unnecessary` decision's items as `{ kind, p }`, or nothing when the journal bounded it. */
const relevanceItems = (payload) => {
  const items = payload.state?.items
  if (!Array.isArray(items) || !Array.isArray(payload.answers)) return undefined
  return payload.answers.flatMap((answer) => {
    const index = unnecessary.exec(answer?.id ?? "")?.[1]
    if (index === undefined || typeof answer.p !== "number") return []
    const kind = items[Number(index)]?.kind
    return [{ kind: typeof kind === "string" ? kind : "unknown", p: answer.p }]
  })
}

/**
 * Folds one run's gate rows into `board`.
 *
 * `facts` is `journal-facts.mjs`'s read of the same journal, whose frames
 * carry the checks each frame ran. A drain is delivered to the frame after
 * the turn-opened rows before it. A delivery resolves when one of the
 * {@link resolvedWithin} frames from there runs a check passing that was not
 * passing when it was delivered, or when a supervisor reading of one of those
 * frames puts `on_target` above the last reading before them.
 *
 * @category conversions
 * @since 1.0.0-rc.0
 */
export const gates = (facts, rows, board = emptyGates()) => {
  const readings = []
  const deliveries = []
  let opened = 0
  for (const { type, payload } of rows) {
    if (type === "control.agent.turn-opened") {
      opened++
    } else if (type === "control.agent.decision-settled" && payload.classifier === "relevance/unnecessary") {
      board.relevance.decisions++
      const items = relevanceItems(payload)
      if (items === undefined) {
        board.relevance.unreadable++
        continue
      }
      for (const { kind, p } of items) {
        const row = board.relevance.kinds[kind] ??= {
          items: 0,
          withheld: Object.fromEntries(withholdThresholds.map((at) => [at, 0]))
        }
        row.items++
        for (const at of withholdThresholds) if (p >= at) row.withheld[at]++
      }
    } else if (type === "control.agent.decision-settled" && payload.classifier === "supervisor/turn") {
      if (!Array.isArray(payload.answers)) continue
      for (const answer of payload.answers) {
        if (answer?.id?.startsWith(Supervisor.monitorPrefix)) {
          monitorOf(board, answer.id.slice(Supervisor.monitorPrefix.length)).asked++
        }
      }
    } else if (type === "control.agent.supervisor-settled") {
      lintAgrees(payload)
      board.lintChecked++
      readings.push({ frame: payload.frame, onTarget: payload.onTarget })
      for (const monitor of payload.monitors ?? []) {
        const row = monitorOf(board, monitor.id)
        row.readings++
        if (monitor.crossed) row.crossed++
      }
    } else if (type === "control.agent.steering-drained") {
      for (const { id, reason } of payload.suppressed ?? []) {
        const row = monitorOf(board, id)
        row.suppressed[reason] = (row.suppressed[reason] ?? 0) + 1
      }
      if (payload.monitor !== undefined) {
        monitorOf(board, payload.monitor).delivered++
        deliveries.push({ id: payload.monitor, frame: opened })
      }
    }
  }
  for (const { id, frame } of deliveries) {
    const window = facts.frames.slice(frame, frame + resolvedWithin)
    const before = facts.frames[frame]?.ledgerBefore ?? []
    const passing = new Set(before.filter((check) => check.passing).map((check) => check.signature))
    const checked = window.some((entry) =>
      entry.frameChecks.some((check) => check.passing && !passing.has(check.signature))
    )
    const last = readings.filter((reading) => reading.frame < frame).at(-1)
    const rose = last !== undefined &&
      readings.some((reading) =>
        reading.frame >= frame && reading.frame < frame + resolvedWithin && reading.onTarget > last.onTarget
      )
    if (checked || rose) board.monitors[id].resolved++
  }
  return board
}

/** `part` of `whole` as a percentage, or `-` when there is no whole. */
const rate = (part, whole) => whole === 0 ? "-" : percent(part / whole)

/**
 * The gates board as markdown: relevance withheld rates per kind and
 * threshold, then per monitor its crossing, delivered and delivered-then-
 * resolved rates and its suppressions.
 *
 * @category conversions
 * @since 1.0.0-rc.0
 */
export const gatesMarkdown = (board) => {
  const lines = [`## Relevance`, ``]
  lines.push(`decisions: ${board.relevance.decisions}, unreadable: ${board.relevance.unreadable}`, ``)
  lines.push(
    `| kind | items | ${withholdThresholds.map((at) => `withheld >= ${at}`).join(" | ")} |`,
    `| --- | ---: | ${withholdThresholds.map(() => "---:").join(" | ")} |`
  )
  for (const [kind, row] of Object.entries(board.relevance.kinds).sort(([a], [b]) => a.localeCompare(b))) {
    lines.push(
      `| ${kind} | ${row.items} | ${withholdThresholds.map((at) => rate(row.withheld[at], row.items)).join(" | ")} |`
    )
  }
  lines.push(``, `## Monitors`, ``, `readings checked against Monitor.lint: ${board.lintChecked}`, ``)
  lines.push(
    `| monitor | asked | readings | crossed | delivered | resolved | suppressed |`,
    `| --- | ---: | ---: | ---: | ---: | ---: | --- |`
  )
  for (const [id, row] of Object.entries(board.monitors).sort(([a], [b]) => a.localeCompare(b))) {
    const suppressed = Object.entries(row.suppressed).sort(([a], [b]) => a.localeCompare(b))
      .map(([reason, count]) => `${reason}:${count}`).join(" ")
    lines.push(
      `| ${id} | ${row.asked} | ${row.readings} | ${rate(row.crossed, row.readings)} | ${
        rate(row.delivered, row.crossed)
      } | ${rate(row.resolved, row.delivered)} | ${suppressed === "" ? "-" : suppressed} |`
    )
  }
  return lines.join("\n")
}

const percent = (value) => `${(value * 100).toFixed(0)}%`

const markdown = (report) => {
  const lines = []
  lines.push(`# Supervisor replay`, ``)
  lines.push(
    `journals: ${report.journals}, labelled: ${report.board.labelled} (${report.board.unresolved} unresolved), frames: ${report.frames}, readings: ${report.readings}, unjudged: ${report.unjudgedTotal}`
  )
  if (Object.keys(report.unjudged).length > 0) {
    lines.push(``, `| unjudged reason | frames |`, `| --- | ---: |`)
    for (const [reason, count] of Object.entries(report.unjudged)) lines.push(`| ${reason} | ${count} |`)
  }
  lines.push(``, `Positive predicts unresolved.`, ``)
  lines.push(
    `| signal | frame | tp | fp | fn | tn | precision | recall | f1 |`,
    `| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |`
  )
  for (const row of report.board.rows) {
    lines.push(
      `| ${row.signal} | ${row.frame} | ${row.tp} | ${row.fp} | ${row.fn} | ${row.tn} | ${percent(row.precision)} | ${
        percent(row.recall)
      } | ${row.f1.toFixed(2)} |`
    )
  }
  lines.push(
    ``,
    `| instance | verdict | frames | last thrashing | max thrashing | last on_target | min on_target | last suspect | last needs_help | last emotions |`
  )
  lines.push(`| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | --- | --- |`)
  for (const run of report.runs) {
    const last = run.readings[run.readings.length - 1]
    if (last === undefined) {
      lines.push(
        `| ${run.id} | ${run.label ?? "-"} | ${run.frames} | - | - | - | - | - | - | unjudged ${run.unjudged} |`
      )
      continue
    }
    const emotions = Supervisor.emotions.map((emotion) => `${emotion}:${last.emotions[emotion]}`).join(" ")
    lines.push(
      `| ${run.id} | ${run.label ?? "-"} | ${run.frames} | ${last.thrashing.toFixed(2)} | ${
        run.maxThrashing.toFixed(2)
      } | ${last.onTarget.toFixed(2)} | ${run.minOnTarget.toFixed(2)} | ${
        last.suspect.toFixed(2)
      } | ${last.needsHelp} | ${emotions} |`
    )
  }
  lines.push(``, gatesMarkdown(report.gates))
  return lines.join("\n")
}

/** The evaluator the replay asks: Jev through the gateway, over the CLI's own egress client. */
const evaluatorLayer = (environment) => {
  const apiKey = environment.AI_GATEWAY_API_KEY
  if (apiKey === undefined || apiKey === "") throw new Error("AI_GATEWAY_API_KEY is required unless --dry-run")
  return Evaluator.layerVercelGateway({
    apiKey: Redacted.make(apiKey),
    ...(environment.SMITHERS_EVALUATOR_BASE_URL === undefined
      ? {}
      : { baseUrl: environment.SMITHERS_EVALUATOR_BASE_URL })
  }).pipe(Layer.provide(EgressHttpClient.layer(environment)))
}

/**
 * Replays one directory of journals and returns the report.
 *
 * @category conversions
 * @since 0.1.0
 */
export const replay = async (options, environment) => {
  const labels = labelsOf(options.manifest)
  const journals = journalsUnder(options.journals, options.suffix).slice(0, options.limit)
  const unjudged = {}
  let frames = 0
  let readings = 0
  let unjudgedTotal = 0
  const layer = options.dryRun ? undefined : evaluatorLayer(environment)

  const ask = (snapshot) =>
    Supervisor.read(snapshot, {}).pipe(
      Effect.map((reading) => ({ _tag: "read", reading })),
      Effect.catch((failure) => Effect.succeed({ _tag: "unjudged", failure })),
      Effect.provide(layer)
    )

  const runs = []
  const board = emptyGates()
  for (const journal of journals) {
    const facts = readFacts(journal.path)
    gates(facts, readGates(journal.path), board)
    const built = snapshots(facts)
    frames += built.length
    const run = {
      id: journal.id,
      label: labels.get(journal.id),
      frames: built.length,
      readings: [],
      unjudged: 0,
      maxThrashing: 0,
      minOnTarget: 1,
      snapshots: options.dryRun ? built : undefined
    }
    if (!options.dryRun) {
      const outcomes = await Effect.runPromise(Effect.forEach(built, ask, { concurrency: 4 }))
      for (const outcome of outcomes) {
        if (outcome._tag === "read") {
          lintAgrees(outcome.reading)
          readings++
          run.readings.push(outcome.reading)
          run.maxThrashing = Math.max(run.maxThrashing, outcome.reading.thrashing)
          run.minOnTarget = Math.min(run.minOnTarget, outcome.reading.onTarget)
        } else {
          unjudgedTotal++
          run.unjudged++
          unjudged[outcome.failure.reason] = (unjudged[outcome.failure.reason] ?? 0) + 1
        }
      }
    }
    runs.push(run)
  }
  return {
    journals: journals.length,
    frames,
    readings,
    unjudgedTotal,
    unjudged,
    board: scoreboard(runs),
    gates: board,
    runs
  }
}

const main = async () => {
  let options
  try {
    options = parseArguments(process.argv.slice(2))
  } catch (error) {
    console.error(error.message)
    process.exit(2)
  }
  const report = await replay(options, process.env)
  if (options.json) {
    process.stdout.write(JSON.stringify(report, null, 2) + "\n")
  } else if (options.dryRun) {
    process.stdout.write(`journals: ${report.journals}, frames: ${report.frames} (dry run, nothing asked)\n`)
    for (const run of report.runs) {
      const last = run.snapshots[run.snapshots.length - 1]
      process.stdout.write(
        `${run.id}: ${run.frames} frames, verdict ${run.label ?? "-"}, last signals ${
          JSON.stringify(last?.signals ?? null)
        }\n`
      )
    }
    process.stdout.write(`\n${gatesMarkdown(report.gates)}\n`)
  } else {
    process.stdout.write(markdown(report) + "\n")
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error))
    process.exit(1)
  })
}
