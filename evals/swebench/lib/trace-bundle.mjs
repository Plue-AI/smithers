/**
 * Everything an analyst needs about one instance, in one file.
 *
 *   node lib/trace-bundle.mjs <instance_id> [options]
 *   node lib/trace-bundle.mjs --prompt-only
 *
 * Writes `fullbench/analysis/<id>/bundle.md` — the task as the agent saw it, our
 * run's metrics and its frame-by-frame trace, codex's trace and its metrics —
 * and `fullbench/analysis/PROMPT.md`, the brief both analysts answer. One file
 * per instance, one brief for all of them, so two analyses of two instances are
 * answers to the same question and can be compared.
 *
 * ## What is deliberately not in a bundle
 *
 * The bundle is the evidence for designing a *better trace*, and a better trace
 * has to be one a live agent could have produced. So it carries only what a live
 * agent had:
 *
 * | withheld | why |
 * | --- | --- |
 * | the gold patch (`patch`) | the answer |
 * | the graded test file (`test_patch`) | the answer, spelled as a test |
 * | `FAIL_TO_PASS`, `PASS_TO_PASS` | which tests are graded — knowing them makes every search trivial and every conclusion untransferable |
 * | `hints_text` | maintainer commentary from the PR, which no agent had |
 * | the evaluator's own report | it lists the graded identifiers by name |
 *
 * Enforcement is at the source rather than by scanning the output: the dataset
 * row is projected through `visible()` before anything is rendered, and that
 * projection is asserted to carry none of those keys. Verdicts are read from the
 * two ledgers, never from `fullbench/reports/<id>.json`, because that file names
 * every graded test.
 *
 * Scanning the finished bundle for those identifiers would be the wrong check
 * and would fail on honest traces: an agent that found the right test by reading
 * the repository put it in its own transcript, and that is the trace doing its
 * job. What matters is that this module never *adds* it.
 *
 * ## Options
 *
 * | option | default | what it changes |
 * | --- | --- | --- |
 * | `--clip` | 200 | characters kept of each call input, call result, codex command and codex output |
 * | `--text-clip` | 400 | characters kept of each codex assistant turn |
 * | `--cell-clip` | 3000 | characters kept of each of our cells |
 * | `--fb` | `fullbench` | the benchmark directory to read and write under |
 * | `--dataset` | `swb-verified.json` | the dataset the problem statement comes from |
 *
 * Every clip records what it dropped, so the analyst can see that a 40 KB test
 * log was 40 KB rather than believing the 200 characters were all of it.
 *
 * Spends nothing, needs no docker, needs no model. Safe to run while a benchmark
 * is in flight: it opens every journal read-only and writes only under
 * `fullbench/analysis/`.
 *
 * @since 0.1.0
 */
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { fileURLToPath } from "node:url"
import { readTokensFile } from "./codex-tokens.mjs"
import { readRows } from "./fullbench-manifest.mjs"
import { readCost } from "./run-cost.mjs"

const here = dirname(fileURLToPath(import.meta.url))
const rig = resolve(here, "..")

/** The dataset columns a live agent had. Everything else is hindsight. */
export const VISIBLE_KEYS = ["instance_id", "repo", "base_commit", "version", "problem_statement"]

/** The dataset columns no bundle may carry, checked rather than remembered. */
export const WITHHELD_KEYS = ["patch", "test_patch", "FAIL_TO_PASS", "PASS_TO_PASS", "hints_text"]

/**
 * Projects a dataset row down to what a live agent could see.
 *
 * @category conversions
 * @since 0.1.0
 */
export const visible = (row) => {
  const projected = {}
  for (const key of VISIBLE_KEYS) {
    if (row[key] !== undefined) projected[key] = row[key]
  }
  for (const key of WITHHELD_KEYS) {
    if (key in projected) {
      throw new Error(`trace-bundle.mjs: '${key}' is hindsight and must never reach a bundle`)
    }
  }
  return projected
}

const clipText = (value, limit) => {
  const text = typeof value === "string" ? value : JSON.stringify(value) ?? String(value)
  if (text.length <= limit) return text
  return `${text.slice(0, limit)}… [+${text.length - limit} chars]`
}

/** One line, for a markdown list item: no newlines, no backticks to close early. */
const inline = (value, limit) => clipText(value, limit).replace(/\s*\n\s*/gu, " ⏎ ").replace(/`/gu, "'")

const seconds = (millis) => (millis === undefined || millis === null ? null : Math.round(millis / 1000))

const number = (value) => (typeof value === "number" ? value.toLocaleString("en-US") : "—")

// ---------------------------------------------------------------------------
// Our journal, frame by frame.
//
// Read with `node:sqlite` and nothing else, for the reason `lib/run-cost.mjs`
// gives: importing the harness's own modules to rebuild the controller's
// decisions makes this stop working whenever a sibling lane is mid-edit in
// `packages/smithers/agent/harness`, and an analysis pipeline that breaks on someone else's
// refactor is not one anybody will run.
// ---------------------------------------------------------------------------

/**
 * Folds one run's journal into per-frame cells, calls, tokens and timings.
 *
 * @category conversions
 * @since 0.1.0
 */
export const readFrames = (databasePath) => {
  const database = new DatabaseSync(databasePath, { readOnly: true })
  let rows
  try {
    rows = database.prepare(
      "select seq, emitted_at_ms, event_type, payload_json from flows_journal_events"
        + " where event_type like 'control.agent.%' order by seq"
    ).all()
  } finally {
    database.close()
  }

  const frames = []
  const started = []
  let frame
  let resolvedText
  for (const row of rows) {
    const payload = JSON.parse(row.payload_json)
    switch (row.event_type) {
      case "control.agent.turn-opened":
        frame = {
          index: frames.length + 1,
          openedAt: payload.at ?? row.emitted_at_ms,
          closedAt: undefined,
          seat: payload.seat,
          cell: "",
          modelMillis: undefined,
          usage: undefined,
          calls: [],
          mutated: false,
          declaredWrites: 0,
          paths: undefined,
          transition: "none",
          stopReason: undefined,
          demands: []
        }
        frames.push(frame)
        break
      case "control.agent.model-settled":
        if (frame === undefined) break
        frame.modelMillis = payload.durationMillis
        frame.usage = payload.usage
        break
      case "control.agent.cell-produced":
        if (frame === undefined) break
        frame.cell = payload.text ?? ""
        break
      case "control.agent.cell-call-started":
        started.push(payload)
        break
      case "control.agent.cell-call-settled": {
        if (frame === undefined) break
        const opened = started.shift()
        frame.calls.push({
          flow: payload.flowName,
          input: opened?.input ?? null,
          ok: payload.outcome === "success",
          value: payload.outcome === "success" ? payload.value : payload.error ?? payload.cause ?? null,
          millis: opened?.at === undefined || payload.at === undefined ? undefined : payload.at - opened.at
        })
        break
      }
      case "control.agent.mutation-observed":
        if (frame === undefined) break
        frame.mutated = payload.mutated === true
        frame.declaredWrites = payload.declaredWrites ?? 0
        frame.paths = payload.paths
        break
      case "control.agent.transition-applied":
        if (frame === undefined) break
        frame.transition = payload.transition?._tag ?? "none"
        break
      case "control.agent.turn-closed":
        if (frame === undefined) break
        frame.closedAt = payload.at ?? row.emitted_at_ms
        frame.stopReason = payload.stopReason
        break
      case "control.agent.resolved":
        resolvedText = payload.text
        break
      default:
        // The controller's demands: the frames it refused to let complete, and
        // why. They are the harness teaching the agent something mid-run, which
        // is exactly the kind of cost an optimal trace either needs or does not.
        if (row.event_type.endsWith("-demanded") && frame !== undefined) {
          frame.demands.push(row.event_type.slice("control.agent.".length, -"-demanded".length))
        }
        break
    }
  }
  return { frames, resolvedText }
}

// ---------------------------------------------------------------------------
// Codex's transcript, block by block.
//
// `codex exec --color never` writes a plain transcript: a header, the prompt
// under a `user` marker, then alternating `codex` (assistant) and `exec`
// (command) blocks, and a token footer. Every marker is a line on its own, which
// is what makes this parseable without the CLI's own JSON.
// ---------------------------------------------------------------------------

const MARKERS = new Set(["codex", "exec", "thinking", "user", "tokens used"])
const STATUS = /^\s+(succeeded|failed|exited \d+)\s+in\s+(.+):\s*$/u

/**
 * Parses a codex transcript into assistant turns and executed commands.
 *
 * @category conversions
 * @since 0.1.0
 */
export const readCodexTrace = (text) => {
  const lines = text.split("\n")
  const workdir = /^workdir:\s*(.+)$/mu.exec(text)?.[1]
  const model = /^model:\s*(.+)$/mu.exec(text)?.[1]
  const blocks = []
  let current
  for (const line of lines) {
    if (MARKERS.has(line)) {
      current = { kind: line, lines: [] }
      blocks.push(current)
      continue
    }
    if (current !== undefined) current.lines.push(line)
  }

  const entries = []
  for (const block of blocks) {
    // The prompt and the footer are already reported elsewhere in the bundle.
    if (block.kind === "user" || block.kind === "tokens used") continue
    if (block.kind === "exec") {
      const [commandLine = "", ...rest] = block.lines
      let command = commandLine.trim()
      // The CLI appends ` in <workdir>` to every command it echoes. The workdir
      // is an absolute path that is the same on every line, so it is noise.
      if (workdir !== undefined && command.endsWith(` in ${workdir}`)) {
        command = command.slice(0, -` in ${workdir}`.length)
      }
      const statusAt = rest.findIndex((line) => STATUS.test(line))
      const status = statusAt === -1 ? undefined : STATUS.exec(rest[statusAt])
      entries.push({
        kind: "exec",
        command,
        outcome: status?.[1] ?? "unknown",
        duration: status?.[2],
        output: (statusAt === -1 ? rest : rest.slice(statusAt + 1)).join("\n").trim()
      })
      continue
    }
    const said = block.lines.join("\n").trim()
    if (said !== "") entries.push({ kind: block.kind === "thinking" ? "thinking" : "assistant", text: said })
  }
  return { entries, workdir, model }
}

// ---------------------------------------------------------------------------
// Reading the two ledgers
// ---------------------------------------------------------------------------

const lastRow = (path, id) => {
  let found
  for (const row of readRows(path).rows) {
    if (row.kind === "instance" && row.id === id) {
      found = found === undefined || row.state === "started" ? row : { ...found, ...row }
    }
  }
  return found
}

const readJson = (path) => {
  try {
    return JSON.parse(readFileSync(path, "utf8"))
  } catch {
    return undefined
  }
}

/** The files a patch touches, and its size. Never the patch itself. */
const patchShape = (path) => {
  if (!existsSync(path)) return undefined
  const text = readFileSync(path, "utf8")
  const files = [...text.matchAll(/^diff --git a\/(\S+) b\/\S+$/gmu)].map((match) => match[1])
  const added = text.split("\n").filter((line) => /^\+[^+]/u.test(line)).length
  const removed = text.split("\n").filter((line) => /^-[^-]/u.test(line)).length
  return { bytes: statSync(path).size, files, added, removed }
}

// ---------------------------------------------------------------------------
// The brief
// ---------------------------------------------------------------------------

/** The analyst brief. One question, asked identically of every instance. */
export const PROMPT = `# The optimal-trace brief

You are given, for one SWE-bench Verified instance:

- **the task as the agent saw it** — the problem statement, the repository and
  the commit, and the environment the run had;
- **our harness's full trace**, frame by frame, with the cost of each frame in
  tokens, milliseconds and calls;
- **codex's trace** on the same instance under the same conditions, with its
  cost.

## What to construct

**Construct THE OPTIMAL TRACE for this instance.**

It must be *possible*: a way of solving this problem using **only the information
provided to a live agent**. No hindsight-only knowledge. Every lookup in your
trace must be motivated by something already visible at the point you make it —
the problem statement, or the result of an earlier step in your own trace. If a
step only makes sense because you know the answer, it is not in the optimal
trace.

It must be *minimal*: in wall-clock time, in model turns, and in dollars.

Write it as concrete flows cells — the \`ctx.call\` protocol, with as many calls
per cell as you like. A cell is one model turn; calls inside it are free of model
latency and are the lever that matters.

## What to diagnose

1. **Where our trace spent what the optimal trace does not.** Name each place —
   a frame, a call, a retry — and say what it cost in turns, seconds and dollars.
   Classify each one:

   | class | means |
   | --- | --- |
   | tool gap | no tool existed to do it in one call |
   | teaching gap | the agent did not know something the harness could have told it |
   | context-visibility gap | the agent could not see something it had already paid for |
   | model choice gap | a different seat would have done it cheaper or better |
   | pure waste | nothing would have been lost by not doing it |

2. **What codex did that the optimal trace adopts or rejects.** Name each one and
   say which, with the reason.

## What to state

Money and time are the point. State the optimal trace's estimated **frames,
tokens and dollars** in one table next to ours and next to codex's.

## What to end with

**At most three harness changes** that would move real runs toward your optimal
trace.

- General only. Never instance-specific, and never anything that would only help
  on this problem.
- Never an added review, audit or verification step. Runs are not made better by
  bolting more steps onto them; they are made better by giving the agent tools
  powerful enough to build up its own context in fewer turns.
- Each one: what it is, which class of waste above it removes, and what it would
  have saved on this instance.
`

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

const metricsTable = (ours, theirs) => {
  const rows = [
    ["verdict", ours.verdict ?? "—", theirs.verdict ?? "not back filled yet"],
    [
      "wall clock, whole instance",
      ours.wallSeconds === undefined ? "—" : `${ours.wallSeconds}s`,
      theirs.wallSeconds === undefined ? "—" : `${theirs.wallSeconds}s`
    ],
    [
      "wall clock, agent only",
      ours.agentSeconds === null ? "—" : `${ours.agentSeconds}s`,
      theirs.agentSeconds === undefined ? "—" : `${theirs.agentSeconds}s`
    ],
    ["model turns", number(ours.frames), theirs.assistantTurns === undefined ? "—" : number(theirs.assistantTurns)],
    ["model calls", number(ours.modelCalls), "—"],
    ["tool calls / exec commands", number(ours.calls), theirs.execs === undefined ? "—" : number(theirs.execs)],
    ["input tokens", number(ours.usage?.inputTokens), "—"],
    ["cached input tokens", number(ours.usage?.cachedInputTokens), "—"],
    ["output tokens", number(ours.usage?.outputTokens), "—"],
    ["reasoning tokens", number(ours.usage?.reasoningTokens), "—"],
    [
      "tokens, total",
      number(ours.totalTokens),
      theirs.tokens === undefined || theirs.tokens === null ? "—" : number(theirs.tokens)
    ],
    ["USD", ours.usd === null || ours.usd === undefined ? "—" : `$${ours.usd.toFixed(4)}`, "not derivable"],
    ["patch bytes", number(ours.patch?.bytes), number(theirs.patch?.bytes)],
    [
      "files touched",
      ours.patch === undefined ? "—" : String(ours.patch.files.length),
      theirs.patch === undefined ? "—" : String(theirs.patch.files.length)
    ]
  ]
  return [
    "| | ours (flows harness) | codex CLI |",
    "| --- | --- | --- |",
    ...rows.map(([label, mine, theirs_]) => `| ${label} | ${mine} | ${theirs_} |`)
  ].join("\n")
}

const renderFrames = (frames, options) => {
  const out = []
  for (const frame of frames) {
    const millis = frame.closedAt === undefined ? undefined : frame.closedAt - frame.openedAt
    const usage = frame.usage ?? {}
    out.push(
      `#### Frame ${frame.index} — ${millis === undefined ? "?" : `${(millis / 1000).toFixed(1)}s`}`
        + `, ${frame.calls.length} call${frame.calls.length === 1 ? "" : "s"}`
        + `, ${number(usage.inputTokens ?? 0)} in / ${number(usage.cachedInputTokens ?? 0)} cached`
        + ` / ${number(usage.outputTokens ?? 0)} out`
        + `${frame.modelMillis === undefined ? "" : `, model ${(frame.modelMillis / 1000).toFixed(1)}s`}`
    )
    out.push("")
    const facts = [
      `transition \`${frame.transition}\``,
      `stop \`${frame.stopReason ?? "?"}\``,
      frame.mutated ? "**tree moved**" : "tree unchanged",
      `${frame.declaredWrites} declared write${frame.declaredWrites === 1 ? "" : "s"}`
    ]
    if (frame.demands.length > 0) facts.push(`demands: ${frame.demands.map((name) => `\`${name}\``).join(", ")}`)
    out.push(facts.join(" · "))
    out.push("")
    out.push("```js")
    out.push(clipText(frame.cell, options.cellClip))
    out.push("```")
    out.push("")
    if (frame.calls.length === 0) {
      out.push("_no calls_")
    } else {
      for (const [index, call] of frame.calls.entries()) {
        out.push(
          `${index + 1}. \`${call.flow}\` — ${call.ok ? "ok" : "**failed**"}`
            + `${call.millis === undefined ? "" : `, ${call.millis}ms`}`
        )
        out.push(`   - in: \`${inline(call.input, options.clip)}\``)
        out.push(`   - out: \`${inline(call.value, options.clip)}\``)
      }
    }
    out.push("")
  }
  return out.join("\n")
}

const renderCodex = (trace, options) => {
  const out = []
  for (const [index, entry] of trace.entries.entries()) {
    if (entry.kind === "exec") {
      out.push(`${index + 1}. **exec** (${entry.outcome}${entry.duration === undefined ? "" : `, ${entry.duration}`})`)
      out.push(`   - \`${inline(entry.command, options.clip)}\``)
      out.push(`   - out: \`${inline(entry.output, options.clip)}\``)
      continue
    }
    out.push(`${index + 1}. **${entry.kind}**`)
    out.push(`   - ${inline(entry.text, options.textClip)}`)
  }
  return out.join("\n")
}

/**
 * Builds one instance's bundle. Returns the markdown; writes nothing.
 *
 * @category conversions
 * @since 0.1.0
 */
export const bundle = (id, options) => {
  const fb = options.fb
  const dataset = JSON.parse(readFileSync(options.dataset, "utf8"))
  const found = dataset.find((row) => row.instance_id === id)
  if (found === undefined) throw new Error(`trace-bundle.mjs: ${id} is not in ${options.dataset}`)
  const instance = visible(found)

  // ---- our side -----------------------------------------------------------
  const ourRow = lastRow(join(fb, "manifest.jsonl"), id) ?? {}
  const journal = join(fb, "journals", id, "engine.db")
  const cost = existsSync(journal) ? readCost(journal) : undefined
  const ourFrames = existsSync(journal) ? readFrames(journal) : { frames: [], resolvedText: undefined }
  const ourTimings = readJson(join(fb, "timings", `${id}.json`))
  const ourPatch = patchShape(join(fb, "patches", `${id}.patch`))
  const ourCalls = ourFrames.frames.reduce((total, frame) => total + frame.calls.length, 0)
  const ours = {
    verdict: ourRow.verdict,
    wallSeconds: ourTimings?.wallClockSeconds ?? ourRow.wallSeconds,
    agentSeconds: seconds(cost?.spanMillis),
    frames: cost?.frames ?? ourFrames.frames.length,
    modelCalls: cost?.modelCalls,
    calls: ourCalls,
    usage: cost?.usage,
    totalTokens: cost === undefined
      ? undefined
      : cost.usage.inputTokens + cost.usage.outputTokens,
    usd: cost?.usd,
    patch: ourPatch
  }

  // ---- codex's side -------------------------------------------------------
  const codexRow = lastRow(join(fb, "codex-manifest.jsonl"), id) ?? {}
  const codexLog = join(fb, "codex", "logs", `${id}.run.log`)
  const hasCodex = existsSync(codexLog)
  const codexTrace = hasCodex
    ? readCodexTrace(readFileSync(codexLog, "utf8"))
    : { entries: [], workdir: undefined, model: undefined }
  const codexTimings = readJson(join(fb, "codex", "timings", `${id}.json`))
  const theirs = {
    verdict: codexRow.verdict,
    wallSeconds: codexRow.wallSeconds,
    agentSeconds: codexTimings?.wallClockSeconds ?? codexRow.agentSeconds,
    tokens: codexRow.tokens ?? (hasCodex ? readTokensFile(codexLog) : undefined),
    // Absent, not zero. An instance the backfill has not reached yet made no
    // turns and ran no commands, and a `0` in those columns reads as a codex run
    // that did nothing rather than as a codex run that has not happened.
    execs: hasCodex ? codexTrace.entries.filter((entry) => entry.kind === "exec").length : undefined,
    assistantTurns: hasCodex ? codexTrace.entries.filter((entry) => entry.kind !== "exec").length : undefined,
    patch: patchShape(join(fb, "codex", "patches", `${id}.patch`))
  }

  const testCommand = options.testCommand

  const out = []
  out.push(`# ${id}`)
  out.push("")
  out.push(
    "One instance, two traces. Read `../PROMPT.md` first: it is the question this"
      + " file is the evidence for."
  )
  out.push("")
  out.push(
    "> **What is not here, on purpose.** The gold patch, the graded test file, the"
      + " `FAIL_TO_PASS` and `PASS_TO_PASS` identifiers, the maintainer hints, and the"
      + " evaluator's own report. A trace that is only optimal because it knew which"
      + " tests are graded is not a trace any real run can follow. If a graded test's"
      + " name appears below, it appears because an agent found it by reading the"
      + " repository — which is the trace doing its job."
  )
  out.push("")
  out.push("## The task, as the agent saw it")
  out.push("")
  out.push(`- repository: \`${instance.repo}\` at \`${instance.base_commit}\``)
  out.push(`- version: \`${instance.version ?? "—"}\``)
  if (testCommand !== undefined) out.push(`- the repository's own test runner, given to both sides: \`${testCommand}\``)
  out.push(
    "- the environment, given to both sides: a host checkout extracted from the"
      + " official image, bind-mounted at `/testbed` in a live container of that image,"
      + " so anything that must run in the project's own interpreter runs through"
      + " `docker exec`."
  )
  out.push("")
  out.push("### Problem statement")
  out.push("")
  out.push(instance.problem_statement.trim())
  out.push("")
  out.push("## The two runs, side by side")
  out.push("")
  out.push(metricsTable(ours, theirs))
  out.push("")
  out.push(
    "The codex CLI publishes one token total in its footer and no input/output"
      + " split, so no dollar figure can be derived from it without inventing that"
      + " split. Our own figure is the committed price table in `prices.ts` applied to"
      + " the four counters in the journal."
  )
  out.push("")
  if (ours.verdict === "eval error" || theirs.verdict === "eval error") {
    out.push(
      "> **An `eval error` verdict is a fact about the evaluator invocation, not"
        + " about the patch.** It means that grading did not complete and produced no"
        + " report, so nothing here says whether that patch resolves the instance. The"
        + " trace below is still the whole trace, and the cost is still the cost."
    )
    out.push("")
  }
  if (ourPatch !== undefined) {
    out.push(
      `Our patch: ${ourPatch.bytes} bytes, ${ourPatch.files.length} file(s) —`
        + ` ${ourPatch.files.map((file) => `\`${file}\``).join(", ") || "none"}`
        + ` (+${ourPatch.added}/-${ourPatch.removed} lines).`
    )
  }
  if (theirs.patch !== undefined) {
    out.push(
      `Codex's patch: ${theirs.patch.bytes} bytes, ${theirs.patch.files.length} file(s) —`
        + ` ${theirs.patch.files.map((file) => `\`${file}\``).join(", ") || "none"}`
        + ` (+${theirs.patch.added}/-${theirs.patch.removed} lines).`
    )
  }
  out.push("")
  out.push("## Our trace, frame by frame")
  out.push("")
  out.push(
    "Each frame is one model turn. The cell is what the model wrote; the calls are"
      + " what that cell executed, in order, with no model latency between them. Inputs"
      + ` and results are clipped to ${options.clip} characters and every clip says what`
      + " it dropped."
  )
  out.push("")
  if (ourFrames.frames.length === 0) {
    out.push("_no journal was archived for this run_")
  } else {
    out.push(renderFrames(ourFrames.frames, options))
    if (ourFrames.resolvedText !== undefined) {
      out.push("#### What the run said it did")
      out.push("")
      out.push(clipText(ourFrames.resolvedText, options.cellClip))
      out.push("")
    }
  }
  out.push("## Codex's trace")
  out.push("")
  if (codexTrace.entries.length === 0) {
    out.push(
      "_no codex transcript is archived for this instance yet — run"
        + " `./codex-backfill.sh --one " + id + "`_"
    )
  } else {
    out.push(
      `Assistant turns are clipped to ${options.textClip} characters, commands and`
        + ` command output to ${options.clip}. Codex has no cells: every command is its`
        + " own turn's tail, so the turn count and the command count are the two numbers"
        + " to compare against our frames and our calls."
    )
    out.push("")
    out.push(renderCodex(codexTrace, options))
  }
  out.push("")
  return `${out.join("\n")}\n`
}

const parse = (argv) => {
  const options = {
    clip: 200,
    textClip: 400,
    cellClip: 3000,
    fb: join(rig, "fullbench"),
    dataset: process.env.SWB_DATASET ?? join(rig, "swb-verified.json"),
    ids: [],
    promptOnly: false
  }
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index]
    switch (argument) {
      case "--prompt-only":
        options.promptOnly = true
        break
      case "--clip":
        options.clip = Number(argv[++index])
        break
      case "--text-clip":
        options.textClip = Number(argv[++index])
        break
      case "--cell-clip":
        options.cellClip = Number(argv[++index])
        break
      case "--fb":
        options.fb = resolve(argv[++index])
        break
      case "--dataset":
        options.dataset = resolve(argv[++index])
        break
      default:
        if (argument.startsWith("--")) {
          console.error(`trace-bundle.mjs: unknown option '${argument}'`)
          process.exit(2)
        }
        options.ids.push(argument)
    }
  }
  for (const key of ["clip", "textClip", "cellClip"]) {
    if (!Number.isInteger(options[key]) || options[key] <= 0) {
      console.error(`trace-bundle.mjs: --${key} must be a positive integer`)
      process.exit(2)
    }
  }
  return options
}

const main = async () => {
  const options = parse(process.argv.slice(2))
  const analysis = join(options.fb, "analysis")
  mkdirSync(analysis, { recursive: true })
  writeFileSync(join(analysis, "PROMPT.md"), PROMPT)
  if (options.promptOnly) {
    console.log(`trace-bundle.mjs: wrote ${join(analysis, "PROMPT.md")}`)
    return
  }
  if (options.ids.length === 0) {
    console.error("usage: node lib/trace-bundle.mjs <instance_id> [--clip n] [--fb dir]")
    process.exit(2)
  }
  // The repository's own test runner, from the same place both prompts read it.
  // It is offline and needs no docker; a rig without the evaluator venv, or an
  // instance that venv does not know, simply has no such line in its bundle.
  const { spawnSync } = await import("node:child_process")
  const python = join(rig, ".venv-swb", "bin", "python")
  for (const id of options.ids) {
    let testCommand
    if (existsSync(python)) {
      const result = spawnSync(python, [join(rig, "lib", "test-command.py"), options.dataset, id], {
        encoding: "utf8"
      })
      if (result.status === 0 && result.stdout.trim() !== "") testCommand = result.stdout.trim()
    }
    const text = bundle(id, { ...options, testCommand })
    const out = join(analysis, id, "bundle.md")
    mkdirSync(dirname(out), { recursive: true })
    writeFileSync(out, text)
    console.log(`trace-bundle.mjs: wrote ${out} (${text.length} bytes)`)
  }
}

if (import.meta.filename === process.argv[1]) await main()
