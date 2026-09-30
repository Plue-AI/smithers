/**
 * The implementations behind the burndown round's actions. The round is pure
 * topology; everything that reads the clock, GitHub, account usage or the
 * engine happens here.
 */
import { FlowInstance } from "@smthrs/flow/FlowRuntime"
import { Cause, Effect, Exit, Layer, Option, Schema } from "effect"
import { execFile } from "node:child_process"
import { mkdir, statfs, writeFile } from "node:fs/promises"
import { homedir, hostname } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import { discoverAccounts, readAccounts, type Reading } from "./accounts.ts"
import { type Refusal, refuseIfClosed } from "./closed-guard.ts"
import { type History, issueKey, selectCandidates } from "./issues.ts"
import { hasPushedReceipt, landAll } from "./land.ts"
import { earliestReset, exhausted, learnRates, type Rates, slots } from "./pacing.ts"
import { advanceReceiptRetries } from "./receipt-retry.ts"
import { Land, Launch, Observe, Settle } from "./round.ts"
import {
  type Assignment,
  type Capacity,
  type InFlight,
  type LandReport,
  type Observation,
  Ready,
  type RoundState,
  type WorkerResult
} from "./schema.ts"
import Worker from "./worker/flow.ts"

const run = promisify(execFile)
const opsDir = join(homedir(), "Smithers-Ops/burndown")
const claimScript = process.env.BURNDOWN_ISSUE_CLAIM_SCRIPT ??
  fileURLToPath(new URL("../../scripts/issue-claim.mjs", import.meta.url))

/** Burn horizon: pace each window to the sooner of its reset and this many hours. */
const horizonHours = Number(process.env.BURNDOWN_HORIZON_HOURS ?? 12)

/** Local launches wait while free disk is below this many GiB; running workers continue. */
const minFreeGiB = () => {
  const value = Number(process.env.BURNDOWN_MIN_FREE_GIB?.trim() || Number.NaN)
  return Number.isFinite(value) && value >= 0 ? value : 8
}

const models = { claude: "claude-opus-5-5", codex: "gpt-6.1-sol" } as const

const toolOf = (account: string): "claude" | "codex" => account.startsWith("claude-") ? "claude" : "codex"

const agentHoursByAccount = (inFlight: ReadonlyArray<InFlight>, since: number, now: number) => {
  const hours: Record<string, number> = {}
  for (const item of inFlight) {
    const from = Math.max(item.startedAt, since)
    hours[item.assignment.account] = (hours[item.assignment.account] ?? 0) + Math.max(0, now - from) / 3_600_000
  }
  return hours
}

const observe = (state: RoundState) =>
  Effect.gen(function*() {
    const now = Date.now()
    // Refresh only our own host's held claims, including members waiting for landing.
    const held = new Map([
      ...state.inFlight.map((i) => [i.assignment.key, i.assignment] as const),
      ...state.ready.map((i) => [i.assignment.key, i.assignment] as const),
      ...state.quarantined.map((i) => [i.assignment.key, i.assignment] as const)
    ])
    for (const assignment of held.values()) {
      yield* Effect.promise(() => refreshOwned(assignment))
    }
    // Workers: which in-flight executions settled, and how.
    const finished: Array<WorkerResult> = []
    const still: Array<InFlight> = []
    for (const item of state.inFlight) {
      const polled = yield* Worker.poll(item.executionId).pipe(Effect.exit)
      if (Exit.isFailure(polled)) {
        if (Cause.hasInterrupts(polled.cause)) return yield* Effect.failCause(polled.cause)
        const failure = Cause.findErrorOption(polled.cause)
        if (Option.isNone(failure) || failure.value._tag !== "@smthrs/flow/FlowExecutionNotFound") {
          still.push(item)
          yield* Effect.logWarning(
            `burndown: poll unavailable for ${item.executionId}: ${Cause.pretty(polled.cause).slice(-2000)}`
          )
          continue
        }
        finished.push({
          key: item.assignment.key,
          status: "failed",
          commits: [],
          notes: Cause.pretty(polled.cause).slice(-2000),
          agentHours: Math.max(0, now - item.startedAt) / 3_600_000
        })
        continue
      }
      const result = polled.value
      if (Option.isNone(result)) {
        still.push(item)
        continue
      }
      const settled = result.value
      if (settled._tag !== "Complete") {
        still.push(item)
        continue
      }
      finished.push(
        settled.exit._tag === "Success"
          ? settled.exit.value.key === item.assignment.key ? settled.exit.value : {
            key: item.assignment.key,
            status: "failed",
            commits: [],
            notes:
              `Worker identity mismatch: expected ${item.assignment.key}, received ${settled.exit.value.key}; ${settled.exit.value.notes}`,
            agentHours: Math.max(0, now - item.startedAt) / 3_600_000
          }
          : {
            key: item.assignment.key,
            status: "failed",
            commits: [],
            notes: Cause.pretty(settled.exit.cause).slice(-2000),
            agentHours: (now - item.startedAt) / 3_600_000
          }
      )
    }
    // Accounts and live usage.
    const { accounts } = yield* Effect.promise(() => discoverAccounts())
    const previous = (state.readings as { readings?: Array<Reading> }).readings ?? []
    // Retain the last good usage as evidence, but preserve the current read failure.
    // Stale usage must neither authorize launches nor prove current exhaustion.
    const readings = (yield* Effect.promise(() => readAccounts(accounts))).map((reading) => {
      if (reading.error?._tag !== "UsageUnavailable") return reading
      const last = previous.find((p) =>
        p.account.id === reading.account.id && p.usage !== null &&
        (p.error === null || p.error._tag === "UsageUnavailable")
      )
      return last === undefined ? reading : { ...reading, usage: last.usage, observedAt: last.observedAt }
    })
    const since = (state.readings as { at?: number }).at ?? now
    const rates = learnRates(
      previous,
      readings,
      agentHoursByAccount(state.inFlight, since, now),
      state.rates as Record<string, Rates>
    )
    const inFlightBy: Record<string, number> = {}
    for (const item of still) inFlightBy[item.assignment.account] = (inFlightBy[item.assignment.account] ?? 0) + 1
    const capacity: Array<Capacity> = readings.map((reading) => ({
      account: reading.account.id,
      tool: reading.account.tool,
      email: reading.account.email,
      slots: slots(reading, now, rates[reading.account.id], inFlightBy[reading.account.id] ?? 0, horizonHours),
      inFlight: inFlightBy[reading.account.id] ?? 0,
      hardStop: (reading.error !== null && reading.error._tag !== "UsageUnavailable") ||
        (reading.error === null && (reading.usage?.limitReached === true ||
          (reading.usage?.windows ?? []).some((w) => w.resetsAt !== null && w.resetsAt > now && w.used >= 97))),
      windows: (reading.usage?.windows ?? []).map((w) => ({ name: w.name, used: w.used, resetsAt: w.resetsAt })),
      problem: reading.error === null
        ? null
        : `${reading.error._tag}: ${reading.error.message}`
    }))
    // Issues not claimed by anyone, plus quarantined landings to fix.
    const busy = new Set([
      ...still.map((i) => i.assignment),
      ...state.ready.map((i) => i.assignment),
      ...state.quarantined.map((i) => i.assignment)
    ].flatMap((a) => [a.lead, ...a.extras].map((x) => `${x.repo}#${x.n}`)))
    const selected = yield* selectCandidates({
      repos: state.options.repos,
      exclude: busy,
      selection: { history: state.history as Record<string, History> }
    })
    const fixes = state.quarantined.filter((q) => {
      const prior = (state.history as Record<string, History>)[issueKey(q.assignment.repo, q.assignment.lead.n)]
      const cooldown = Math.min(3 * 3600 * Math.max(1, prior?.attempts ?? 0), 24 * 3600)
      return prior === undefined || now / 1000 - (prior.last ?? 0) >= cooldown
    }).map((q) => ({
      repo: q.assignment.repo,
      lead: q.assignment.lead,
      extras: q.assignment.extras,
      severity: "high",
      effort: "easy",
      fix: q.error
    }))
    const observation: Observation = {
      now,
      target: state.target,
      candidates: [...fixes, ...selected.candidates],
      openIssues: selected.openIssues,
      inFlight: still,
      finished,
      capacity,
      exhausted: exhausted(readings, now, rates, inFlightBy, horizonHours),
      earliestReset: earliestReset(readings, now),
      pending: selected.pending,
      readings: { at: now, readings },
      rates
    }
    return observation
  }).pipe(Effect.mapError(String))

/** A refresh or repair never steals an expired claim or a claim on another host. */
const refreshOwned = async (assignment: Assignment): Promise<boolean> => {
  const by = `burndown-${assignment.key}`
  for (const member of [assignment.lead, ...assignment.extras]) {
    try {
      const { stdout } = await run("node", [claimScript, "check", `${member.repo}#${member.n}`, "--by", by])
      const ownership = JSON.parse(stdout.trim()) as { mine?: boolean; holder?: { host?: string; at?: string } }
      if (ownership.mine !== true || ownership.holder?.host !== hostname()) return false
      const claimedAt = Date.parse(ownership.holder.at ?? "")
      if (Number.isFinite(claimedAt) && Date.now() - claimedAt < 3_600_000) continue
      if (!await claim(member.repo, member.n, by)) return false
    } catch {
      return false
    }
  }
  return true
}

const issueState = (repo: string, n: number) =>
  run("gh", ["issue", "view", String(n), "--repo", repo, "--json", "state", "--jq", ".state"], {
    timeout: 60_000,
    maxBuffer: 1 << 20
  }).then(({ stdout }) => stdout)

const claim = (repo: string, n: number, by: string) =>
  run("node", [claimScript, "claim", `${repo}#${n}`, "--by", by]).then(() => true, () => false)
const release = async (repo: string, n: number, by: string, note: string): Promise<boolean> => {
  try {
    const { stdout } = await run("node", [claimScript, "check", `${repo}#${n}`, "--by", by])
    const ownership = JSON.parse(stdout.trim()) as { mine?: boolean; holder?: { host?: string } }
    if (ownership.mine !== true || ownership.holder?.host !== hostname()) return false
    await run("node", [claimScript, "release", `${repo}#${n}`, "--by", by, "--note", note])
    return true
  } catch {
    return false
  }
}

const launch = (
  state: RoundState,
  observation: Observation,
  launches: ReadonlyArray<{ repo: string; n: number; account: string }>
) =>
  Effect.gen(function*() {
    // Keys are unique per round execution: a later run re-launching the same issue is a new worker.
    const round = (yield* FlowInstance).executionId.slice(0, 8)
    if (state.options.placement === "local" && launches.length > 0) {
      const disk = yield* Effect.promise(() => statfs(homedir()))
      const freeGiB = (disk.bavail * disk.bsize) / 2 ** 30
      const floor = minFreeGiB()
      if (freeGiB < floor) {
        yield* Effect.logWarning(`burndown: ${freeGiB.toFixed(1)} GiB free < ${floor} GiB; not launching`)
        return []
      }
    }
    const room = Math.max(0, Math.min(state.target, state.options.maxAgents) - observation.inFlight.length)
    // Computed slots are remaining capacity, after already-running workers.
    const remaining = new Map(observation.capacity.map((c) => [
      c.account,
      !c.hardStop && c.problem === null && Number.isFinite(c.slots) ? Math.max(0, Math.floor(c.slots)) : 0
    ]))
    const chosen: Array<{ candidate: Observation["candidates"][number]; account: string }> = []
    const taken = new Set<string>()
    for (const wanted of launches) {
      if (chosen.length >= room) break
      const candidate = observation.candidates.find((c) => c.repo === wanted.repo && c.lead.n === wanted.n)
      if (
        candidate === undefined || taken.has(`${candidate.repo}#${candidate.lead.n}`) ||
        (remaining.get(wanted.account) ?? 0) <= 0
      ) {
        continue
      }
      remaining.set(wanted.account, remaining.get(wanted.account)! - 1)
      taken.add(`${candidate.repo}#${candidate.lead.n}`)
      chosen.push({ candidate, account: wanted.account })
    }
    // Every worker is claimed and started concurrently; one refusal never stops the others.
    const started = yield* Effect.forEach(chosen, ({ account, candidate }) =>
      Effect.gen(function*() {
        const repair = state.quarantined.find((q) =>
          q.assignment.repo === candidate.repo && q.assignment.lead.n === candidate.lead.n
        )
        if (repair !== undefined && !(yield* Effect.promise(() => refreshOwned(repair.assignment)))) return []
        const key = repair?.assignment.key ??
          `${candidate.repo.split("/")[1]}-${candidate.lead.n}-r${state.round}-${round}`
        const by = `burndown-${key}`
        const claimed: Array<number> = []
        for (const m of [candidate.lead, ...candidate.extras]) {
          if (repair !== undefined) {
            claimed.push(m.n)
            continue
          }
          // The lead is claimed first: when it is refused nothing is held, so nothing is released.
          if (yield* Effect.promise(() => claim(candidate.repo, m.n, by))) claimed.push(m.n)
          else if (m.n === candidate.lead.n) return []
        }
        const tool = toolOf(account)
        const assignment: Assignment = {
          key,
          repo: candidate.repo,
          lead: candidate.lead,
          extras: candidate.extras.filter((e) => claimed.includes(e.n)),
          account,
          tool,
          model: models[tool],
          attempt: repair === undefined ? state.round : repair.assignment.attempt + 1,
          placement: state.options.placement,
          ...(candidate.fix === undefined ? {} : { fix: candidate.fix })
        }
        const startedAt = Date.now()
        const exit = yield* Worker.ensure(assignment, {
          key: repair === undefined ? key : `${key}@repair-${assignment.attempt}`
        }).pipe(Effect.exit)
        if (Exit.isFailure(exit)) {
          yield* Effect.logWarning(`burndown: could not start ${key}: ${Cause.pretty(exit.cause).slice(0, 500)}`)
          if (repair === undefined) {
            for (const n of claimed) yield* Effect.promise(() => release(candidate.repo, n, by, "worker start failed"))
          }
          return []
        }
        return [{ assignment, executionId: exit.value, startedAt }]
      }), { concurrency: "unbounded" })
    return started.flat()
  }).pipe(Effect.mapError(String))

/** READY work awaiting the queue: carried from earlier rounds plus this round's. */
const reportedReady = (state: RoundState, observation: Observation): Array<Ready> => [
  ...state.ready,
  ...observation.finished.flatMap((result) => {
    const item = state.inFlight.find((i) => i.assignment.key === result.key)
    return result.status === "ready" && item !== undefined ? [{ assignment: item.assignment, result }] : []
  })
]

const readyWork = (state: RoundState, observation: Observation): Array<Ready> =>
  reportedReady(state, observation).filter(Schema.is(Ready))

/**
 * Lands READY work unless landing is switched off (`BURNDOWN_LAND=off`), which
 * lets agents keep producing while the queue is being repaired; the work stays
 * in round state and its receipts on disk until landing is switched on.
 */
/** Read-only admission hint; the locked landing script re-proves remote ancestry. */
const alreadyOnRemoteMain = async (member: Ready): Promise<boolean> => {
  try {
    const cwd = join(homedir(), member.assignment.repo.split("/")[1]!)
    for (const commit of member.result.commits) {
      const original = await run("jj", [
        "--ignore-working-copy",
        "log",
        "--no-graph",
        "-r",
        commit.commit,
        "-T",
        "change_id"
      ], { cwd, timeout: 15_000, maxBuffer: 1 << 20 })
      const change = original.stdout.trim()
      if (!/^[a-z]{32}$/.test(change)) return false
      const landed = await run("jj", [
        "--ignore-working-copy",
        "log",
        "--no-graph",
        "-r",
        `${change} & ::main@origin`,
        "-T",
        "commit_id"
      ], { cwd, timeout: 15_000, maxBuffer: 1 << 20 })
      if (!/^[0-9a-f]{40}$/.test(landed.stdout.trim())) return false
    }
    return member.result.commits.length > 0
  } catch {
    return false
  }
}

const land = (state: RoundState, observation: Observation) => {
  const ready = readyWork(state, observation).filter((member) => {
    const retry = state.receiptRetries?.find((item) => item.key === member.assignment.key)
    if (retry !== undefined && JSON.stringify(retry.ready) !== JSON.stringify(member)) return false
    return retry?.status !== "parked" || state.options.resumeReceipts?.includes(member.assignment.key)
  })
  if (process.env.BURNDOWN_LAND === "off" || ready.length === 0) {
    return Effect.succeed({ landed: [], quarantined: [] })
  }
  return Effect.gen(function*() {
    const refused: Array<Refusal> = []
    const owned = yield* Effect.filter(
      ready,
      (member) =>
        Effect.promise(async () => {
          if (
            state.receiptRetries?.some((retry) => retry.key === member.assignment.key && retry.receipt !== undefined) ||
            await hasPushedReceipt({
              key: member.result.key,
              repo: member.assignment.repo,
              commits: member.result.commits
            }) || await alreadyOnRemoteMain(member)
          ) return true
          // A closed issue never lands, whoever holds the claim.
          try {
            const refusal = await refuseIfClosed(member, { view: issueState, release })
            if (refusal !== undefined) {
              refused.push(refusal)
              return false
            }
          } catch {
            return false
          }
          return await refreshOwned(member.assignment)
        })
    )
    if (owned.length === 0) return { landed: [], quarantined: [], refused }
    const report = yield* landAll(
      owned.map((r) => r.result),
      owned.map((r) => ({ assignment: r.assignment, executionId: r.assignment.key, startedAt: 0 })),
      {
        reverify: owned.filter((member) => state.options.resumeReceipts?.includes(member.assignment.key)).map((
          member
        ) => member.assignment.key),
        expectedReceipts: (state.receiptRetries ?? []).flatMap((retry) =>
          retry.receipt === undefined ? [] : [{ key: retry.key, receipt: retry.receipt }]
        )
      }
    )
    return {
      ...report,
      refused,
      resumed: owned.filter((member) => state.options.resumeReceipts?.includes(member.assignment.key)).map((member) =>
        member.assignment.key
      )
    }
  })
}

const notify = (title: string, message: string) =>
  run("osascript", [
    "-e",
    `display notification ${JSON.stringify(message)} with title ${JSON.stringify(title)} sound name "Glass"`
  ])
    .catch(() => undefined)

const settle = (
  state: RoundState,
  observation: Observation,
  plan: { readonly nextTarget: number },
  launched: ReadonlyArray<InFlight>,
  landed: LandReport
) =>
  Effect.promise(async () => {
    const now = Date.now()
    const inFlight = [...observation.inFlight, ...launched]
    // A worker that ended without a landable change releases its claims.
    for (const result of observation.finished.filter((r) => r.status !== "ready")) {
      const item = state.inFlight.find((i) => i.assignment.key === result.key)
      if (item === undefined) continue
      for (const m of [item.assignment.lead, ...item.assignment.extras]) {
        await release(item.assignment.repo, m.n, `burndown-${item.assignment.key}`, `worker ${result.status}`)
      }
    }
    const queue = readyWork(state, observation)
    // A mixed READY/BLOCKED bundle is a repair receipt, not a complete queue member.
    const invalid = reportedReady(state, observation).filter((member): boolean => !Schema.is(Ready)(member)).map((
      member
    ) => ({
      ...member,
      key: member.assignment.key,
      error: `Incomplete READY bundle: ${member.result.notes}`
    }))
    const ready = queue.filter((r) =>
      ((landed.receiptsPending ?? []).some((q) => q.key === r.result.key) || !landed.landed.includes(r.result.key)) &&
      !landed.quarantined.some((q) => q.key === r.result.key) &&
      !(landed.refused ?? []).some((q) => q.key === r.result.key)
    )
    const receiptRetries = advanceReceiptRetries(state.receiptRetries ?? [], queue, landed)
    const quarantined = [
      ...invalid,
      ...state.quarantined.filter((q) => !launched.some((i) => i.assignment.key === q.key)),
      ...landed.quarantined.flatMap((q) => {
        const member = queue.find((r) => r.assignment.key === q.key)
        return member === undefined ? [] : [{ ...member, ...q }]
      })
    ]
    const idle = (landed.receiptsPending ?? []).length === 0 && inFlight.length === 0 && ready.length === 0 &&
      quarantined.length === 0 &&
      observation.candidates.length === 0 && !observation.pending
    // Attempts feed selection's cooldown, so a failing issue waits before its next try.
    const history = { ...(state.history as Record<string, History>) }
    for (const result of observation.finished) {
      const item = state.inFlight.find((i) => i.assignment.key === result.key)
      if (item === undefined || result.status === "ready" || result.status === "limited") continue
      for (const m of [item.assignment.lead, ...item.assignment.extras]) {
        const key = issueKey(item.assignment.repo, m.n)
        const prior = history[key] ?? {}
        history[key] = result.status === "closed"
          ? { ...prior, closed: true }
          : { ...prior, attempts: (prior.attempts ?? 0) + 1, last: now / 1000, notes: result.notes }
      }
    }
    for (const member of [...landed.quarantined, ...invalid]) {
      const assignment = reportedReady(state, observation).find((r) => r.assignment.key === member.key)?.assignment
      if (assignment === undefined) continue
      for (const issue of [assignment.lead, ...assignment.extras]) {
        const key = issueKey(assignment.repo, issue.n)
        const prior = history[key] ?? {}
        history[key] = { ...prior, attempts: (prior.attempts ?? 0) + 1, last: now / 1000, notes: member.error }
      }
    }
    // A refused bundle is closed work: its receipt keeps the commits, and selection never retries it.
    for (const refusal of landed.refused ?? []) {
      const assignment = queue.find((r) => r.assignment.key === refusal.key)?.assignment
      if (assignment === undefined) continue
      for (const issue of [assignment.lead, ...assignment.extras]) {
        const key = issueKey(assignment.repo, issue.n)
        history[key] = { ...(history[key] ?? {}), closed: true }
      }
    }
    const capped = observation.candidates.length > 0 && launched.length === 0 &&
      observation.exhausted
    await mkdir(opsDir, { recursive: true })
    const line =
      `${new Date(now).toISOString()} round=${state.round} inFlight=${inFlight.length} launched=${launched.length} ` +
      `finished=${observation.finished.length} landed=${landed.landed.length} quarantined=${landed.quarantined.length} ` +
      `candidates=${observation.candidates.length} open=${observation.openIssues} target=${state.target}`
    await writeFile(
      join(opsDir, "status.txt"),
      `${line}\n${
        [
          ...(landed.receiptsPending ?? []).map((item) => `receipts pending ${item.key}: ${item.error}`),
          ...receiptRetries.filter((item) => item.status === "parked").map((item) =>
            `verification parked ${item.key} after ${item.attempts} attempt(s): ${item.error}`
          ),
          ...(landed.refused ?? []).map((item) =>
            `refused ${item.key}: ${item.reason} ${item.issues.map((n) => `#${n}`).join(" ")}`
          ),
          ...(landed.retainedSnapshots ?? []).map((item) => `snapshot retained ${item.path}: ${item.error}`)
        ].join("\n")
      }\n`
    )
    // A recoverable projection of canonical round data, never an authority ledger.
    const parked = receiptRetries.filter((item) => item.status === "parked")
    await writeFile(
      join(opsDir, "parked-verification.json"),
      JSON.stringify(
        {
          repos: state.options.repos,
          receiptRetries: parked,
          resumeReceipts: parked.map((item) => item.key)
        },
        null,
        2
      ) + "\n"
    )
    if (capped) {
      const reset = observation.earliestReset === null ? "unknown" : new Date(observation.earliestReset).toISOString()
      const table = observation.capacity.map((c) =>
        `- ${c.account} (${c.email}): ${c.windows.map((w) => `${w.name} ${w.used}%`).join(", ")}${
          c.problem === null ? "" : ` ${c.problem}`
        }`
      ).join("\n")
      await writeFile(
        join(opsDir, "NEEDS-YOU.md"),
        `# Every account is at its ceiling\n\n${observation.candidates.length} issues wait. Earliest reset ${reset}.\nReset accounts; the flow re-reads usage every 10 minutes and continues.\n\n${table}\n`
      )
      await notify("Burndown needs resets", `${observation.candidates.length} issues wait; every account is capped`)
    }
    const settledLandings = landed.landed.filter((key) =>
      !(landed.receiptsPending ?? []).some((item) => item.key === key)
    ).length
    const tick = state.options.tickMinutes * 60_000
    const wakeAt = capped ? Math.min(observation.earliestReset ?? now + 600_000, now + 600_000) : now + tick
    return {
      done: idle,
      wakeAt,
      summary: `burndown finished after ${state.round + 1} rounds; landed ${state.landed + settledLandings}`,
      next: {
        options: {
          ...state.options,
          ...(state.options.resumeReceipts === undefined ? {} : {
            resumeReceipts: state.options.resumeReceipts.filter((key) =>
              !landed.resumed?.includes(key) && !landed.refused?.some((item) => item.key === key) &&
              !landed.quarantined.some((item) => item.key === key)
            )
          })
        },
        round: state.round + 1,
        target: plan.nextTarget > 0 ? Math.min(Math.round(plan.nextTarget), state.options.maxAgents) : state.target,
        inFlight,
        quarantined,
        ready,
        receiptRetries,
        readings: observation.readings,
        rates: observation.rates,
        history: history as never,
        landed: state.landed + settledLandings
      }
    }
  })

export const layer = Layer.mergeAll(
  Observe.toLayer(({ state }) => observe(state), { implementationVersion: "burndown/observe/v6" }),
  Launch.toLayer(({ observation, plan, state }) => launch(state, observation, plan.launches), {
    implementationVersion: "burndown/launch/v3"
  }),
  Land.toLayer(({ observation, state }) => land(state, observation), {
    implementationVersion: "burndown/land/v6"
  }),
  Settle.toLayer(
    ({ landed, launched, observation, plan, state }) => settle(state, observation, plan, launched, landed),
    {
      implementationVersion: "burndown/settle/v7"
    }
  )
)
