/**
 * The implementations behind the burndown round's actions. The round is pure
 * topology; everything that reads the clock, GitHub, account usage or the
 * engine happens here.
 */
import { FlowInstance } from "@smthrs/flow/FlowRuntime"
import { Cause, Effect, Exit, Layer, Option } from "effect"
import { execFile } from "node:child_process"
import { mkdir, writeFile } from "node:fs/promises"
import { homedir, hostname } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import { discoverAccounts, readAccounts, type Reading } from "./accounts.ts"
import { type History, issueKey, selectCandidates } from "./issues.ts"
import { landAll } from "./land.ts"
import { earliestReset, exhausted, learnRates, type Rates, slots } from "./pacing.ts"
import { Land, Launch, Observe, Settle } from "./round.ts"
import type { Assignment, Capacity, InFlight, Observation, Ready, RoundState, WorkerResult } from "./schema.ts"
import Worker from "./worker/flow.ts"

const run = promisify(execFile)
const opsDir = join(homedir(), "Smithers-Ops/burndown")
const claimScript = process.env.BURNDOWN_ISSUE_CLAIM_SCRIPT ??
  fileURLToPath(new URL("../../scripts/issue-claim.mjs", import.meta.url))

/** Burn horizon: pace each window to the sooner of its reset and this many hours. */
const horizonHours = Number(process.env.BURNDOWN_HORIZON_HOURS ?? 12)

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

/** Pacing sees a window no further away than the burn horizon. */
const horizonReading = (reading: Reading, now: number): Reading =>
  reading.usage === null ? reading : {
    ...reading,
    usage: {
      ...reading.usage,
      windows: reading.usage.windows.map((w) => ({
        ...w,
        resetsAt: Math.min(w.resetsAt, now + horizonHours * 3_600_000)
      }))
    }
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
      const polled = yield* Worker.poll(item.executionId).pipe(Effect.option)
      const result = Option.flatten(polled)
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
          ? settled.exit.value
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
      const last = previous.find((p) => p.account.id === reading.account.id && p.usage !== null && p.error === null)
      return last === undefined ? reading : { ...reading, usage: last.usage }
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
      slots: slots(horizonReading(reading, now), now, rates[reading.account.id], inFlightBy[reading.account.id] ?? 0),
      inFlight: inFlightBy[reading.account.id] ?? 0,
      hardStop: (reading.error !== null && reading.error._tag !== "UsageUnavailable") ||
        reading.usage?.limitReached === true ||
        (reading.usage?.windows ?? []).some((w) => w.used >= 97),
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
      exhausted: exhausted(readings.map((r) => horizonReading(r, now)), now, rates, inFlightBy),
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
          if (yield* Effect.promise(() => claim(candidate.repo, m.n, by))) claimed.push(m.n)
          else if (m.n === candidate.lead.n) break
        }
        if (!claimed.includes(candidate.lead.n)) {
          for (const n of claimed) yield* Effect.promise(() => release(candidate.repo, n, by, "lead claim failed"))
          return []
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
const readyWork = (state: RoundState, observation: Observation): Array<Ready> => [
  ...state.ready,
  ...observation.finished.flatMap((result) => {
    const item = state.inFlight.find((i) => i.assignment.key === result.key)
    return result.status === "ready" && item !== undefined ? [{ assignment: item.assignment, result }] : []
  })
]

/**
 * Lands READY work unless landing is switched off (`BURNDOWN_LAND=off`), which
 * lets agents keep producing while the queue is being repaired; the work stays
 * in round state and its receipts on disk until landing is switched on.
 */
const land = (state: RoundState, observation: Observation) => {
  const ready = readyWork(state, observation)
  if (process.env.BURNDOWN_LAND === "off" || ready.length === 0) {
    return Effect.succeed({ landed: [], quarantined: [] })
  }
  return Effect.gen(function*() {
    const owned = yield* Effect.filter(ready, (member) => Effect.promise(() => refreshOwned(member.assignment)))
    return yield* landAll(
      owned.map((r) => r.result),
      owned.map((r) => ({ assignment: r.assignment, executionId: r.assignment.key, startedAt: 0 }))
    )
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
  landed: { landed: ReadonlyArray<string>; quarantined: ReadonlyArray<{ key: string; error: string }> }
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
    const ready = queue.filter((r) =>
      !landed.landed.includes(r.result.key) && !landed.quarantined.some((q) => q.key === r.result.key)
    )
    const quarantined = [
      ...state.quarantined.filter((q) => !launched.some((i) => i.assignment.key === q.key)),
      ...landed.quarantined.flatMap((q) => {
        const member = queue.find((r) => r.assignment.key === q.key)
        return member === undefined ? [] : [{ ...member, ...q }]
      })
    ]
    const idle = inFlight.length === 0 && ready.length === 0 && quarantined.length === 0 &&
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
          : { ...prior, attempts: (prior.attempts ?? 0) + 1, last: now / 1000 }
      }
    }
    for (const member of landed.quarantined) {
      const assignment = queue.find((r) => r.assignment.key === member.key)?.assignment
      if (assignment === undefined) continue
      for (const issue of [assignment.lead, ...assignment.extras]) {
        const key = issueKey(assignment.repo, issue.n)
        const prior = history[key] ?? {}
        history[key] = { ...prior, attempts: (prior.attempts ?? 0) + 1, last: now / 1000 }
      }
    }
    const capped = observation.candidates.length > 0 && launched.length === 0 &&
      observation.exhausted
    await mkdir(opsDir, { recursive: true })
    const line =
      `${new Date(now).toISOString()} round=${state.round} inFlight=${inFlight.length} launched=${launched.length} ` +
      `finished=${observation.finished.length} landed=${landed.landed.length} quarantined=${landed.quarantined.length} ` +
      `candidates=${observation.candidates.length} open=${observation.openIssues} target=${state.target}`
    await writeFile(join(opsDir, "status.txt"), `${line}\n`)
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
    const tick = state.options.tickMinutes * 60_000
    const wakeAt = capped ? Math.min(observation.earliestReset ?? now + 600_000, now + 600_000) : now + tick
    return {
      done: idle,
      wakeAt,
      summary: `burndown finished after ${state.round + 1} rounds; landed ${state.landed + landed.landed.length}`,
      next: {
        options: state.options,
        round: state.round + 1,
        target: plan.nextTarget > 0 ? Math.min(Math.round(plan.nextTarget), state.options.maxAgents) : state.target,
        inFlight,
        quarantined,
        ready,
        readings: observation.readings,
        rates: observation.rates,
        history: history as never,
        landed: state.landed + landed.landed.length
      }
    }
  })

export const layer = Layer.mergeAll(
  Observe.toLayer(({ state }) => observe(state), { implementationVersion: "burndown/observe/v3" }),
  Launch.toLayer(({ observation, plan, state }) => launch(state, observation, plan.launches), {
    implementationVersion: "burndown/launch/v3"
  }),
  Land.toLayer(({ observation, state }) => land(state, observation), {
    implementationVersion: "burndown/land/v1"
  }),
  Settle.toLayer(
    ({ landed, launched, observation, plan, state }) => settle(state, observation, plan, launched, landed),
    {
      implementationVersion: "burndown/settle/v3"
    }
  )
)
