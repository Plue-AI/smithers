/**
 * The codex arm twice over one population: with the network, and sealed.
 *
 *   node compare-codex-lanes.mjs [--net f] [--sealed f] [--manifest f] \
 *     [--logs dir] [--out dir] [--label text] [--json]
 *
 * The sealed column is whichever sealed lane the flags point at — `r90s` by
 * default, `r90sh` when the flags name the sealed-high lane — and `--label`
 * names it in the report, because a column rendered under another lane's
 * heading is a number quoted under conditions it was not measured under.
 *
 * `compare-arms.mjs` answers "does flows resolve a superset of what codex
 * resolves", which is a question about two harnesses. This answers a different
 * one about a single harness: **how much of the codex column came from the
 * network.** The `net` lane ran with egress and used it — four
 * `curl https://api.github.com/…` calls read the merged pull request on
 * `matplotlib__matplotlib-24970` — so a column measured against it inherits a
 * caveat that no arithmetic removes. The sealed lane is the same instances, the
 * same model, the same per-instance budget and the same grading rig, with the
 * child commands' HTTP proxy pointed at a closed port.
 *
 * Three rules, each the same one the rest of the rig already obeys:
 *
 * - **A verdict that is not a grading is not a verdict.** `eval error` means the
 *   evaluator never ran the patch. Those rows are named and left out of the
 *   movement sets rather than counted as a loss on either side. `empty patch`
 *   still counts: the agent finished and changed nothing, which is a fact about
 *   the agent.
 * - **Both denominators, always.** `lib/excluded.mjs` names the instances whose
 *   verdicts are statements about the grading environment, and every count here
 *   is printed scored and raw in the same sentence.
 * - **A claimed seal is read back off the traces.** The seal is an environment
 *   one — the proxy variables every child command inherits — not a kernel-level
 *   one, so the report counts, per instance, the egress commands the transcript
 *   contains and the proxy refusals they produced. An instance that attempted
 *   egress is listed by name whatever the outcome, because the reader of a
 *   sealed number is entitled to know where the seal was pushed on.
 * - **A kernel seal is asserted, not described.** From 2026-08-24 a lane may run
 *   its testbed container on `--network none`, and each run records what
 *   `docker inspect` said its container was actually on. A lane whose ledger
 *   claims `none` must observe `none` on every attempted row, retain every
 *   transcript, and show no counted container breaches or web searches, or
 *   `main` exits non-zero. The trace obligations also cover host-side tools
 *   and other containers that the testbed's network observation cannot seal.
 *
 * It reads two codex ledgers, the flows ledger and the sealed lane's own
 * transcripts. No evaluator report, no journal, no clock, no network. Running it
 * twice over the same files produces the same bytes.
 *
 * @since 0.1.0
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { traceFailures } from "./breach-scan.mjs"
import { attempted, population } from "./lib/codex-backfill-queue.mjs"
import { denominators, isExcluded, renderExclusions } from "./lib/excluded.mjs"

const rigRoot = import.meta.dirname

/** Verdicts that say the evaluator never produced a judgement of the patch. */
export const NOT_A_GRADING = new Set(["eval error", ""])

/**
 * Reads a verdict into one of three states.
 *
 * @category conversions
 * @since 0.1.0
 */
export const readVerdict = (verdict) => {
  if (verdict === undefined || NOT_A_GRADING.has(verdict)) {
    return { graded: false, resolved: false, verdict: verdict ?? "not run" }
  }
  return { graded: true, resolved: verdict === "resolved", verdict }
}

/**
 * The commands a transcript contains that would have left the machine, and the
 * refusals the seal produced.
 *
 * The patterns are the shapes the `net` lane actually used plus the obvious
 * neighbours. A count of zero is the evidence a sealed run never reached for the
 * network; a count above zero is a transcript to **read**, not a finding on its
 * own — a match can be prose the agent quoted out of a docstring, which is what
 * `psf__requests-1766` turned out to be in the `net` lane. The instance is named
 * either way, because the reader of a sealed number is entitled to the list.
 *
 * @category conversions
 * @since 0.1.0
 */
export const egress = (text) => {
  // `curl: (7) …` is the *refusal*, not another attempt, so the command forms
  // are matched with the diagnostic's colon excluded. Counting it would report
  // one blocked fetch as two.
  const commands = text.match(
    /\b(?:curl|wget|git clone|git fetch|git ls-remote|pip install|pip download)(?!:)(?=[\s'"])[^\n'"]{0,120}/gu
  ) ?? []
  const refusals = text.match(/127\.0\.0\.1 port 1\b/gu) ?? []
  const proxied = text.match(/(?:proxy|Proxy)[^\n]{0,60}127\.0\.0\.1:1\b/gu) ?? []
  return {
    commands,
    attempts: commands.length,
    refusals: refusals.length + proxied.length,
    breaches: breaches(text),
    webSearches: webSearches(text)
  }
}

/**
 * The second surface of the seal: codex's own web-search tool.
 *
 * The proxy variables reach the commands codex spawns. They do not reach the
 * tool the model calls itself, so `web_search=disabled` is what turns it off and
 * the transcript is what proves it did. `codex exec` prints one `web search:`
 * line per query, and the first r90s attempt is why this is counted rather than
 * assumed: it set `tools.web_search=false`, a key codex-cli 0.149.0 ignores, and
 * 126 of these lines went unnoticed across 15 of its 45 runs — several opening
 * the instance's own upstream issue, which is precisely the hindsight a sealed
 * lane exists to remove.
 *
 * A run with a search line is in the same class as a breach and not in the same
 * class as a refused `curl`: it read the network. Its verdict is not a sealed
 * verdict.
 *
 * @category conversions
 * @since 0.1.0
 */
export const webSearches = (text) =>
  (text.match(/^web search:.*$/gmu) ?? []).map((line) => line.slice(0, 160))

/**
 * The egress the seal does not reach: a fetch run **inside** the testbed
 * container.
 *
 * The proxy variables are set through `shell_environment_policy.set`, which
 * reaches the commands codex spawns on the host. `docker exec <container> …`
 * is one of those commands and it is allowed — both arms are told to run the
 * project's tests that way — but the process it starts is the daemon's child,
 * not codex's, so it inherits the container's environment and the container
 * keeps the network the `net` lane gave it. A `curl` on the far side of a
 * `docker exec` is therefore a hole in the seal, and it is the *only* one the
 * lane's own runs have been observed to use.
 *
 * It is reported apart from `attempts` because it is a different finding. An
 * attempt that the proxy refused is the seal working. A breach is a run that
 * read the network anyway, and on 2026-08-22 two of the 45 sealed runs did:
 * `sphinx-doc__sphinx-8721` fetched `pull/8721.patch` and
 * `sympy__sympy-19495` fetched `pull/19495.diff` — in both cases the merged
 * upstream fix, which is exactly the hindsight the lane exists to remove. A
 * verdict from a run that appears here is not a sealed verdict.
 *
 * The command's own outcome is not read: `docker exec` reports the exit status
 * of the last stage of whatever pipeline it was handed, so a `curl … | head`
 * that fetched nothing still exits 0 and a fetch that succeeded can be followed
 * by a `grep` that exits 1. The transcript is named for a human to read, which
 * is the same rule `attempts` follows.
 *
 * @category conversions
 * @since 0.1.0
 */
export const breaches = (text) => literalBreaches(withContainerLines(text))

const literalBreaches = (text) => {
  const lines = text.split("\n")
  const found = []
  for (const line of lines) {
    if (!line.includes("docker exec")) continue
    const after = line.slice(line.indexOf("docker exec"))
    if (!/\b(?:curl|wget|git clone|git fetch|git ls-remote|pip install|pip download)(?!:)(?=[\s'"])/u.test(after)) {
      continue
    }
    found.push(after.slice(0, 160))
  }
  return found
}

const containerIdentity = /^[\w][\w.-]*$/u

/** Every `{ container, command }` call in one parsed value, JSON strings included. */
const containerCalls = (value, found) => {
  if (typeof value === "string") {
    if (!/^\s*[[{]/u.test(value)) return found
    try {
      return containerCalls(JSON.parse(value), found)
    } catch {
      return found
    }
  }
  if (value === null || typeof value !== "object") return found
  const program = typeof value.command === "string" ? value.command : typeof value.script === "string"
    ? [value.interpreter, value.script].filter((part) => typeof part === "string").join(" ")
    : undefined
  if (typeof value.container === "string" && value.container !== "" && program !== undefined) {
    const container = containerIdentity.test(value.container) ? value.container : JSON.stringify(value.container)
    found.push(`docker exec ${container} ${program.replace(/\s+/gu, " ")}`)
  }
  for (const child of Object.values(value)) containerCalls(child, found)
  return found
}

/**
 * The trace with each structured container call also written as its docker line.
 *
 * The flows `bash` tool runs a project command as
 * `{ mode: "unhermetic", container, cwd, command }` and never types
 * `docker exec`, so the literal reading above would count the fetch as an
 * attempt and never as in-container. Each such call found in a JSON line is
 * written as `docker exec <container> <command>` on the line before it, which
 * keeps its container identity for the seal reading and starts its outcome
 * window where the call is. Codex transcripts and older traces pass unchanged.
 */
const withContainerLines = (text) =>
  text.split("\n").map((line) => {
    const calls = containerCalls(line, [])
    return calls.length === 0 ? line : [...calls, line].join("\n")
  }).join("\n")

/**
 * What a fetch looks like when the network was not there.
 *
 * These are the diagnostics a `--network none` container actually produces, all
 * of them observed in the 2026-08-25 sealed lane: curl resolves nothing and
 * exits 6, pip's urllib3 reports `Temporary failure in name resolution`, and a
 * raw address fails to connect rather than to resolve. `curl: (6)` and
 * `curl: (7)` are matched as well as their prose because `--silent` prints the
 * code without the sentence.
 *
 * @category patterns
 * @since 0.1.0
 */
export const SEAL_REFUSALS = [
  /Could not resolve host/iu,
  /Couldn't resolve host/iu,
  /Temporary failure in name resolution/iu,
  /Name or service not known/iu,
  /Failed to establish a new connection/iu,
  /Network is unreachable/iu,
  /Failed to connect to \S+ port/iu,
  /Connection refused/iu,
  /curl: \(6\)/u,
  /curl: \(7\)/u
]

/**
 * Every in-container fetch in one trace, each read to its outcome.
 *
 * `breaches` supplies the attempts, so this cannot drift from it on *what counts
 * as an in-container fetch*; only the outcome reading is added on top. The
 * window an outcome is read from ends at the next `docker exec`, so one
 * command's failure is never credited to another, and is capped so a quiet trace
 * cannot absolve an attempt with something printed thousands of lines later.
 *
 * @category conversions
 * @since 0.1.0
 */
export const inContainerEgress = (trace) => {
  const text = withContainerLines(trace)
  const attempts = literalBreaches(text)
  const read = []
  let from = 0
  for (const command of attempts) {
    const at = text.indexOf(command, from)
    const start = at === -1 ? from : at + command.length
    if (at !== -1) from = start
    const next = text.indexOf("docker exec", start)
    const end = Math.min(next === -1 ? text.length : next, start + 4000)
    const window = text.slice(start, end)
    // Only literal identities can share evidence. An option or a shell
    // expression we cannot resolve gets only its own command's refusal.
    const identity = command.match(/^docker exec\s+(?:"([\w][\w.-]*)"|'([\w][\w.-]*)'|([\w][\w.-]*))(?=\s)/u)
    const container = identity?.[1] ?? identity?.[2] ?? identity?.[3]
    read.push({ command, container, start, end, refused: SEAL_REFUSALS.some((pattern) => pattern.test(window)) })
  }
  return read
}

/**
 * Whether a run's own trace proves its container had no network at all.
 *
 * The seal is a property of the container, not of each command, and reading it
 * per-command underreads it. `curl --silent | grep …` prints no diagnostic and
 * exits with `grep`'s status, so a fetch that returned nothing can leave no
 * refusal text behind — that is exactly what `sphinx-doc__sphinx-7590` did on
 * 2026-08-25, one second before the identical URL in the identical container
 * came back `curl: (6) Could not resolve host`.
 *
 * So: one fetch shown dying on a name that does not resolve establishes that the
 * container had no DNS and no route. A running container cannot acquire one on
 * its own — it takes a `docker network connect` from outside, which is a command
 * and would be in the trace. The guard is therefore the whole rule: **any**
 * `docker network connect` in the trace withdraws it, and an instance whose
 * trace shows nothing refused never earns it. Evidence is bound to the literal
 * container identity: every container in the supplied attempts must have its
 * own refusal. A quiet trace proves nothing and is given nothing.
 *
 * @category conversions
 * @since 0.1.0
 */
export const provedUnnetworked = (text, read) =>
  read.length > 0 && !/docker\s+network\s+connect/u.test(text)
  && read.every((one) => one.container !== undefined
    && read.some((evidence) => evidence.container === one.container && evidence.refused))

/**
 * The in-container fetches that count against a lane, after the seal is read.
 *
 * On a container the daemon reported on `none`, a fetch is refused by
 * construction and the trace has to show it — directly, or through the
 * container-level reading above. Anywhere else the attempt is the finding, which
 * is the rule every lane before 2026-08-25 was scored under and is left
 * untouched here.
 *
 * @category conversions
 * @since 0.1.0
 */
export const countedBreaches = (text, observed) => {
  if (text === undefined) return []
  const read = inContainerEgress(text)
  if (observed !== "none") return read.map((one) => one.command)
  return read.filter((one) => !one.refused
    && !provedUnnetworked(text, read.filter((evidence) => evidence.container === one.container)))
    .map((one) => one.command)
}

const readLog = (logsDirectory, id) => {
  const path = join(logsDirectory, `${id}.run.log`)
  if (!existsSync(path)) return undefined
  return readFileSync(path, "utf8")
}

/** The two testbed network conditions a run may have been measured under. */
export const TESTBED_MODES = new Set(["none", "bridge"])

/**
 * What testbed network a lane was measured under, read off its own rows.
 *
 * Two fields, and the difference between them is the whole design.
 * `testbedNetwork` is what the lane asked for and `testbedNetworkObserved` is
 * what the run read back out of `docker inspect` at the moment it started its
 * container. **The claim comes from the request and the assertion comes from
 * the observation**, because a lane that judged itself by its own request would
 * be checking a variable against itself, and a lane that took its claim from
 * the observation could clear itself by failing to seal every single container.
 *
 * Four states, and the fourth is the interesting one:
 *
 * - `none` — the lane asked for `none`
 * - `bridge` — the lane asked for `bridge`
 * - `unrecorded` — no row carries either field. The three lanes that ran before
 *   2026-08-24 are here, and they stay readable: their reports are the
 *   trace-reading ones they always were, with the hole they always had.
 * - `mixed` — the rows disagree, in either field, which is fatal on its own. A
 *   lane measured under two testbed conditions is not one measurement, and no
 *   arithmetic over it means anything.
 *
 * A row with no observation is `missing`, and it is counted apart from a row
 * that observed `bridge`: one is a container that was networked and one is a
 * container nothing checked. Both fail a `none` lane, for the same reason — a
 * seal that was not measured was not sealed — but a reader repairing the lane
 * needs to know which.
 *
 * @category conversions
 * @since 0.1.0
 */
export const testbed = (rows) => {
  const requests = []
  const observations = []
  const missing = []
  const unsealed = []
  for (const row of rows) {
    // A row the lane never attempted is not a row about a container. Only the
    // instances this lane actually ran can say anything about its testbed.
    if (!row.attempted) continue
    const asked = TESTBED_MODES.has(row.testbedRequested) ? row.testbedRequested : undefined
    const seen = TESTBED_MODES.has(row.testbedObserved) ? row.testbedObserved : undefined
    if (asked !== undefined) requests.push(asked)
    if (seen === undefined) {
      missing.push({ id: row.id, requested: asked ?? "unrecorded" })
      continue
    }
    observations.push(seen)
    if (seen !== "none") unsealed.push({ id: row.id, observed: seen, requested: asked ?? "unrecorded" })
  }
  const askedFor = new Set(requests)
  const seenOn = new Set(observations)
  // Observations that disagree are `mixed` before anything else is read: two
  // containers on two networks is two measurements whatever both rows asked
  // for. Then the request, which is the lane's claim. Then the observation on
  // its own, so a ledger written by a runner that records only the fact still
  // reads as a lane rather than as an absence.
  const claim = seenOn.size > 1 || askedFor.size > 1 ? "mixed"
    : askedFor.size === 1 ? [...askedFor][0]
    : seenOn.size === 1 ? [...seenOn][0]
    : "unrecorded"
  return { claim, observed: observations.length, missing, unsealed }
}

/**
 * The two codex lanes over the flows population.
 *
 * @category conversions
 * @since 0.1.0
 */
export const compareLanes = (
  { label = "`r90s` (sealed)", logsDirectory, manifestPath, netPath, require: required, sealedPath }
) => {
  const flows = population(manifestPath)
  const net = attempted(netPath)
  const sealed = attempted(sealedPath)

  const rows = flows.map(({ id, flowsVerdict }) => {
    const text = logsDirectory === undefined ? undefined : readLog(logsDirectory, id)
    const sealedRow = sealed.get(id)
    return {
      id,
      excluded: isExcluded(id),
      flows: readVerdict(flowsVerdict),
      net: readVerdict(net.get(id)?.verdict),
      sealed: readVerdict(sealedRow?.verdict),
      netWall: net.get(id)?.wallSeconds,
      sealedWall: sealedRow?.wallSeconds,
      netTokens: net.get(id)?.tokens,
      sealedTokens: sealedRow?.tokens,
      // The condition asked for, and the condition `docker inspect` reported.
      attempted: sealedRow !== undefined,
      testbedRequested: sealedRow?.testbedNetwork,
      testbedObserved: sealedRow?.testbedNetworkObserved,
      egress: text === undefined ? undefined : egress(text),
      // The attempts above, read to their outcomes against the condition the
      // container was actually observed on.
      countedBreaches: countedBreaches(text, sealedRow?.testbedNetworkObserved)
    }
  })

  const scored = rows.filter((row) => !row.excluded)
  const comparable = scored.filter((row) => row.net.graded && row.sealed.graded)
  const count = (list, predicate) => list.filter(predicate).length
  const denominator = denominators(rows.map((row) => row.id))

  // The kernel half of the seal. It is computed over every row the lane
  // attempted, excluded ones included: an exclusion is a statement about a
  // grading environment and never a licence to run one instance networked.
  const sealedTestbed = testbed(rows)
  const breachRows = rows.filter((row) => row.countedBreaches.length > 0)
  const failures = sealFailures({
    breaches: breachRows,
    required,
    testbedState: sealedTestbed,
    searched: rows.filter((row) => (row.egress?.webSearches.length ?? 0) > 0),
    untraced: rows.filter((row) => row.attempted && row.egress === undefined)
  })

  return {
    // Which sealed lane this is. The script reads whichever ledger and
    // transcripts it is pointed at, so the report has to name the lane it
    // scored: an `r90sh` column rendered under the `r90s` heading is a number
    // quoted under another lane's conditions, which is the defect the lanes
    // exist to prevent.
    label,
    // The condition the caller demanded, if any. `--require none` is how a lane
    // is gated before a number is quoted out of it, and it is recorded so the
    // report says whether it was asserted or merely described.
    required,
    rows,
    excluded: denominator.excluded,
    totals: {
      raw: rows.length,
      scored: scored.length,
      comparable: comparable.length,
      netResolvedScored: count(scored, (row) => row.net.resolved),
      netResolvedRaw: count(rows, (row) => row.net.resolved),
      sealedResolvedScored: count(scored, (row) => row.sealed.resolved),
      sealedResolvedRaw: count(rows, (row) => row.sealed.resolved),
      flowsResolvedScored: count(scored, (row) => row.flows.resolved),
      flowsResolvedRaw: count(rows, (row) => row.flows.resolved)
    },
    movement: {
      lostWithTheSeal: comparable.filter((row) => row.net.resolved && !row.sealed.resolved).map((row) => row.id),
      gainedWithTheSeal: comparable.filter((row) => !row.net.resolved && row.sealed.resolved).map((row) => row.id),
      unchanged: comparable.filter((row) => row.net.resolved === row.sealed.resolved).map((row) => row.id)
    },
    notComparable: scored
      .filter((row) => !row.net.graded || !row.sealed.graded)
      .map((row) => ({ id: row.id, net: row.net.verdict, sealed: row.sealed.verdict })),
    seal: {
      instancesWithAttempts: rows.filter((row) => (row.egress?.attempts ?? 0) > 0).map((row) => ({
        id: row.id,
        attempts: row.egress.attempts,
        refusals: row.egress.refusals,
        breaches: row.countedBreaches.length,
        commands: row.egress.commands.slice(0, 6)
      })),
      // The runs that reached the network through the one hole the seal does
      // not close. Their verdicts are not sealed verdicts and the report says so
      // rather than leaving them to be read out of a commands column.
      instancesWithBreaches: rows.filter((row) => row.countedBreaches.length > 0).map((row) => ({
        id: row.id,
        sealed: row.sealed.verdict,
        breaches: row.countedBreaches.length,
        commands: row.countedBreaches.slice(0, 6)
      })),
      // The other surface of the seal, counted the same way and for the same
      // reason: the lane-wide total is the claim, and any instance behind a
      // non-zero total is named.
      webSearchLines: rows.reduce((total, row) => total + (row.egress?.webSearches.length ?? 0), 0),
      instancesWithWebSearches: rows.filter((row) => (row.egress?.webSearches.length ?? 0) > 0).map((row) => ({
        id: row.id,
        sealed: row.sealed.verdict,
        searches: row.egress.webSearches.length,
        queries: row.egress.webSearches.slice(0, 6)
      })),
      transcriptsRead: rows.filter((row) => row.egress !== undefined).length,
      testbed: sealedTestbed,
      // The assertions a kernel-sealed lane has to satisfy. Empty is the pass,
      // and `main` exits non-zero when it is not.
      failures
    }
  }
}

/**
 * What a lane's testbed condition obliges it to prove.
 *
 * A `bridge` or `unrecorded` lane owes nothing new: those are the lanes read
 * back off their traces, reported with the hole they have, and nothing about
 * them is retroactively re-graded. A `none` lane owes observed isolation,
 * complete traces, and no container breaches or web searches. These are
 * assertions rather than descriptions.
 *
 * `require` forces the `none` obligations whatever the ledger claims, which is
 * how an operator gates a lane before quoting a number out of it. It is also
 * the only way an `unrecorded` lane fails: without it, a lane that predates the
 * field is reported and not judged.
 *
 * @category conversions
 * @since 0.1.0
 */
export const sealFailures = ({ breaches, required, searched = [], testbedState, untraced = [] }) => {
  const failures = []
  if (testbedState.claim === "mixed") {
    failures.push({
      kind: "mixed testbed",
      detail: "the lane's rows were measured under more than one testbed network, so it is not one measurement"
    })
  }
  const asserted = required === "none" || testbedState.claim === "none"
  if (!asserted) return failures
  if (testbedState.claim === "unrecorded") {
    failures.push({
      kind: "unmeasured testbed",
      detail: "`none` was required and no row in this lane recorded what its container was on"
    })
  }
  for (const row of testbedState.unsealed) {
    failures.push({
      kind: "networked testbed",
      detail: `${row.id} ran its testbed on '${row.observed}', not none`
    })
  }
  for (const row of testbedState.missing) {
    failures.push({
      kind: "unmeasured testbed",
      detail: `${row.id} recorded no observed testbed network (asked for '${row.requested}')`
    })
  }
  for (const row of breaches) {
    failures.push({
      kind: "in-container egress",
      detail: `${row.id} fetched from inside its testbed container, which a --network none container cannot do`
    })
  }
  failures.push(...traceFailures({ searched, untraced }))
  return failures
}

const verdictCell = (state) => (state.graded ? state.verdict : `_${state.verdict}_`)

/**
 * The report, as markdown.
 *
 * @category rendering
 * @since 0.1.0
 */
export const render = (result) => {
  const { excluded, movement, notComparable, required, rows, seal, totals } = result
  const label = result.label ?? "`r90s` (sealed)"
  // The narrow column header is the lane's index alone; the label's first
  // backticked token is it, so one flag names both.
  const column = label.match(/`[^`]+`/u)?.[0] ?? label
  const lines = []
  lines.push("# The codex arm, with the network and sealed")
  lines.push("")
  lines.push(
    `Population: **${totals.scored} scored of ${totals.raw} run**. Both arms have a real grading on`
      + ` **${totals.comparable}** of the scored instances, and only those are in the movement sets below.`
  )
  lines.push("")
  lines.push("| arm | resolved (scored) | resolved (raw) |")
  lines.push("| --- | --- | --- |")
  lines.push(`| flows \`r90\` | ${totals.flowsResolvedScored} of ${totals.scored} | ${totals.flowsResolvedRaw} of ${totals.raw} |`)
  lines.push(`| codex \`r90c\` (network) | ${totals.netResolvedScored} of ${totals.scored} | ${totals.netResolvedRaw} of ${totals.raw} |`)
  lines.push(`| codex ${label} | ${totals.sealedResolvedScored} of ${totals.scored} | ${totals.sealedResolvedRaw} of ${totals.raw} |`)
  lines.push("")
  lines.push("## What the seal moved")
  lines.push("")
  lines.push(`- **lost with the seal** (${movement.lostWithTheSeal.length}): ${movement.lostWithTheSeal.join(", ") || "none"}`)
  lines.push(`- **gained with the seal** (${movement.gainedWithTheSeal.length}): ${movement.gainedWithTheSeal.join(", ") || "none"}`)
  lines.push(`- **unchanged** (${movement.unchanged.length})`)
  lines.push("")
  if (notComparable.length > 0) {
    lines.push("Rows one arm never graded, left out of the movement sets:")
    lines.push("")
    for (const row of notComparable) lines.push(`- \`${row.id}\` — network: ${row.net}, sealed: ${row.sealed}`)
    lines.push("")
  }
  lines.push("## The testbed")
  lines.push("")
  const claim = seal.testbed.claim
  const asserted = required === "none" || claim === "none"
  if (claim === "none") {
    lines.push(
      `**\`--network none\`, observed on ${seal.testbed.observed} of the lane's containers.** Each run read`
        + " `docker inspect` back off its own container and recorded what it said, so this is a kernel fact rather"
        + " than a claim about a transcript. A container with no interface but `lo` cannot fetch an upstream patch"
        + " whatever command is run inside it, which is the hole `r90s` and `r90sh` disclose and this lane does not"
        + " have."
    )
  } else if (claim === "bridge") {
    lines.push(
      `**\`--network bridge\`, observed on ${seal.testbed.observed} of the lane's containers.** The testbed keeps`
        + " the network on purpose so that test behaviour does not change with the condition, which leaves the"
        + " `docker exec` hole open. The section below is what that costs, read off the transcripts."
    )
  } else if (claim === "mixed") {
    lines.push(
      "**The lane's rows disagree about what their containers were on.** A lane measured under two testbed"
        + " conditions is not one measurement, and no rate over it means anything."
    )
  } else {
    lines.push(
      "**Unrecorded.** This lane ran before `SWB_TESTBED_NETWORK` existed, so no row says what its container was"
        + " on. It is read back off its traces, below, and reported with the hole it has."
    )
  }
  lines.push("")
  if (seal.failures.length === 0) {
    if (asserted) {
      lines.push(
        "**Sealed by construction.** Every attempted row observed `none` and has a transcript."
          + " No transcript contains a counted in-container breach or a web search."
          + " The traces cross-check the observation: the breach count below has to be zero,"
          + " and a non-zero one would mean the constraint did not hold somewhere the ledger did not see."
      )
    }
  } else {
    lines.push("### The testbed was not sealed")
    lines.push("")
    lines.push(
      `**${seal.failures.length} failed assertions.** ${
        required === "none" ? "`--require none` was passed, so" : "This lane's rows claim `none`, so"
      } every container had to be observed on \`none\`, every attempted run had to leave a transcript,`
        + " and no transcript could contain a counted in-container breach or a web search."
        + " **No number in this report is a sealed number.**"
    )
    lines.push("")
    lines.push("| what failed | detail |")
    lines.push("| --- | --- |")
    for (const failure of seal.failures) lines.push(`| ${failure.kind} | ${failure.detail} |`)
    lines.push("")
  }
  lines.push("")
  lines.push("## Was the seal pushed on")
  lines.push("")
  lines.push(
    `${seal.transcriptsRead} sealed transcripts read. The seal is an environment one — the proxy variables every`
      + " child command inherits — so a transcript that never reached for the network is the evidence that nothing"
      + " needed to be refused, and one that did has to be read."
  )
  lines.push("")
  if (seal.instancesWithAttempts.length === 0) {
    lines.push("No sealed run issued an egress command.")
  } else {
    lines.push("| instance | egress commands | proxy refusals | breaches |")
    lines.push("| --- | --- | --- | --- |")
    for (const row of seal.instancesWithAttempts) {
      lines.push(`| \`${row.id}\` | ${row.attempts} | ${row.refusals} | ${row.breaches} |`)
    }
  }
  lines.push("")
  lines.push("")
  lines.push("### The web-search tool")
  lines.push("")
  if (seal.webSearchLines === 0) {
    lines.push(
      `**0 \`web search:\` lines across ${seal.transcriptsRead} transcripts.** The tool is codex's own rather than a`
        + " child command's, so no amount of proxying reaches it and only `web_search=disabled` turns it off. Zero is"
        + " the evidence that it did."
    )
  } else {
    lines.push(
      `**${seal.webSearchLines} \`web search:\` lines across ${seal.instancesWithWebSearches.length} of`
        + ` ${seal.transcriptsRead} transcripts.** The web-search tool was live for these runs, which reads the network`
        + " through a surface the proxy seal does not touch. **A verdict on this list is not a sealed verdict**, and a"
        + " lane with a non-zero total here is the `codex-sealed-websearch` failure again."
    )
    lines.push("")
    lines.push("| instance | sealed verdict | searches | first query |")
    lines.push("| --- | --- | --- | --- |")
    for (const row of seal.instancesWithWebSearches) {
      lines.push(`| \`${row.id}\` | ${row.sealed} | ${row.searches} | \`${row.queries[0]?.replaceAll("|", "\\|")}\` |`)
    }
  }
  lines.push("")
  lines.push("### Where the seal did not hold")
  lines.push("")
  if (seal.instancesWithBreaches.length === 0) {
    lines.push(
      "No sealed run fetched from inside the testbed container, which is the one way out the environment seal"
        + " does not reach."
    )
  } else {
    lines.push(
      "These runs fetched from **inside the testbed container**, where the proxy variables do not reach because the"
        + " process is the docker daemon's child rather than codex's. The container keeps the network on purpose, so"
        + " that test behaviour does not change with the condition — which makes this the one hole the seal cannot"
        + " close from outside. **A verdict on this list is not a sealed verdict**, and a rate that counts one is"
        + " quoting the network lane under the sealed lane's name."
    )
    lines.push("")
    lines.push("| instance | sealed verdict | in-container fetches | first command |")
    lines.push("| --- | --- | --- | --- |")
    for (const row of seal.instancesWithBreaches) {
      lines.push(`| \`${row.id}\` | ${row.sealed} | ${row.breaches} | \`${row.commands[0]?.replaceAll("|", "\\|")}\` |`)
    }
  }
  lines.push("")
  lines.push("## Per instance")
  lines.push("")
  lines.push(`| instance | flows \`r90\` | codex \`r90c\` | codex ${column} | sealed wall (s) |`)
  lines.push("| --- | --- | --- | --- | --- |")
  for (const row of rows) {
    const mark = row.excluded ? " ⟂" : ""
    lines.push(
      `| \`${row.id}\`${mark} | ${verdictCell(row.flows)} | ${verdictCell(row.net)} | ${verdictCell(row.sealed)}`
        + ` | ${row.sealedWall ?? ""} |`
    )
  }
  lines.push("")
  lines.push("⟂ marks an instance `lib/excluded.mjs` keeps out of every rate, for both arms, with the cause on record.")
  lines.push(...renderExclusions(excluded))
  lines.push("")
  return `${lines.join("\n")}\n`
}

const main = () => {
  const argv = process.argv.slice(2)
  const flag = (name, fallback) => {
    const index = argv.indexOf(name)
    return index === -1 ? fallback : argv[index + 1]
  }
  const manifestPath = resolve(flag("--manifest", join(rigRoot, "fullbench", "manifest.jsonl")))
  const netPath = resolve(flag("--net", join(rigRoot, "fullbench", "codex-manifest.jsonl")))
  const sealedPath = resolve(flag("--sealed", join(rigRoot, "fullbench", "codex-sealed-manifest.jsonl")))
  const logsDirectory = resolve(flag("--logs", join(rigRoot, "fullbench", "codex-sealed", "logs")))
  const out = resolve(flag("--out", join(rigRoot, "fullbench", "codex-sealed")))

  for (const path of [manifestPath, netPath, sealedPath]) {
    if (!existsSync(path)) {
      console.error(`compare-codex-lanes.mjs: no ledger at ${path}`)
      process.exit(1)
    }
  }
  // `--require none` asserts the kernel seal whatever the ledger claims, so an
  // operator can gate a lane before quoting a number out of it. Nothing else is
  // a condition worth demanding: `bridge` is the absence of the constraint.
  const required = flag("--require", undefined)
  if (required !== undefined && required !== "none") {
    console.error(`compare-codex-lanes.mjs: --require takes 'none', got '${required}'`)
    process.exit(2)
  }
  const result = compareLanes({
    label: flag("--label", "`r90s` (sealed)"),
    manifestPath,
    netPath,
    sealedPath,
    require: required,
    logsDirectory: existsSync(logsDirectory) ? logsDirectory : undefined
  })
  if (argv.includes("--json")) {
    process.stdout.write(`${JSON.stringify(result, undefined, 2)}\n`)
  } else {
    const markdown = render(result)
    writeFileSync(join(out, "lanes.md"), markdown)
    writeFileSync(join(out, "lanes.json"), `${JSON.stringify(result, undefined, 2)}\n`)
    process.stdout.write(markdown)
  }
  // The lane fails the process, not just the prose. A report that printed "no
  // number here is a sealed number" and exited 0 would be a report a script
  // could quote from, and the whole point of a kernel seal is that it is checked
  // rather than believed.
  if (result.seal.failures.length > 0) {
    console.error(
      `compare-codex-lanes.mjs: ${result.seal.failures.length} failed testbed assertions — this lane is not sealed`
    )
    for (const failure of result.seal.failures) console.error(`  ${failure.kind}: ${failure.detail}`)
    process.exit(1)
  }
}

if (import.meta.filename === process.argv[1]) main()
