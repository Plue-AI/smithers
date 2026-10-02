/**
 * The Codex and Claude subscription pools `codex-rr` and `claude-rr` rotate,
 * read through their `status` command, and what they allow this round.
 */
import { Burndown } from "@smthrs/patterns"
import { Effect } from "effect"
import { readFile } from "node:fs/promises"
import { homedir } from "node:os"
import { HostFailed, output } from "./host.ts"

/** One account that cannot take work now, and why. */
export interface Unavailable {
  readonly label: string
  readonly state: string
}

/** One subscription pool. */
export interface Pool {
  readonly ready: ReadonlyArray<string>
  readonly unavailable: ReadonlyArray<Unavailable>
  readonly active?: Readonly<Record<string, number>>
}

// One account row of `<tool>-rr status`: "> codex-3       willcory10@proton.me     ready".
const accountRow = /^[> ] (\S+)\s+\S+@\S+\s+(.+?)\s*$/

/** Parses `<tool>-rr status`. A row whose state is not `ready` is unavailable. */
export const parsePool = (status: string): Pool => {
  const ready: Array<string> = []
  const unavailable: Array<Unavailable> = []
  for (const line of status.split("\n")) {
    const match = accountRow.exec(line)
    if (match === null) continue
    const [, label, state] = match as unknown as [string, string, string]
    if (state === "ready") ready.push(label)
    else unavailable.push({ label, state })
  }
  return { ready, unavailable }
}

export interface Pools {
  readonly codex: Pool
  readonly claude: Pool
}

/**
 * What the pools allow this round: every ready account takes `perAccount`
 * agents, bounded by `maxAgents`. With no ready account anywhere, the
 * burndown parks until an operator resets accounts and signals it; the detail
 * names every account and why it is out.
 */
export const capacity = (pools: Pools, perAccount: number, maxAgents: number): Burndown.Capacity => {
  const ready = pools.codex.ready.length + pools.claude.ready.length
  if (ready === 0) {
    const out = [...pools.codex.unavailable, ...pools.claude.unavailable]
      .map((account) => `${account.label} (${account.state})`)
    return Burndown.exhausted(`reset accounts: ${out.length === 0 ? "no signed-in accounts" : out.join(", ")}`)
  }
  const slots = [pools.codex, pools.claude].reduce(
    (total, pool) =>
      total + pool.ready.reduce((n, account) => n + Math.max(0, perAccount - (pool.active?.[account] ?? 0)), 0),
    0
  )
  return slots === 0 || maxAgents === 0
    ? Burndown.exhausted("account or placement slots are occupied")
    : Burndown.available(Math.min(maxAgents, slots))
}

export type Agent = "codex" | "claude"

/**
 * The agent for one issue: even issues prefer Codex and odd ones Claude, so a
 * sweep splits its load across both pools; an issue moves to the other pool
 * when its preferred one has no ready account. `undefined` when neither does.
 */
export const pickAgent = (issue: number, pools: Pools): Agent | undefined => {
  const preferred: Agent = issue % 2 === 0 ? "codex" : "claude"
  const other: Agent = preferred === "codex" ? "claude" : "codex"
  if (pools[preferred].ready.length > 0) return preferred
  if (pools[other].ready.length > 0) return other
  return undefined
}

/** The live per-account cap the rotators enforce (`RR_MAX_PER_ACCOUNT`, default 6). */
export const perAccount = (() => {
  const configured = Number(process.env.RR_MAX_PER_ACCOUNT ?? "6")
  return Number.isSafeInteger(configured) && configured >= 1 ? configured : 6
})()

/** Counts live rotator jobs; remote sweep runs reserve separately below. */
export const liveAccounts = (state: unknown, alive: (pid: number) => boolean): Record<string, number> => {
  if (typeof state !== "object" || state === null || !("active" in state)) return {}
  const active = state.active
  if (typeof active !== "object" || active === null || Array.isArray(active)) throw new Error("invalid active accounts")
  return Object.fromEntries(
    Object.entries(active).map(([account, pids]) => {
      if (!Array.isArray(pids) || pids.some((pid) => !Number.isSafeInteger(pid) || pid <= 0)) {
        throw new Error("invalid account jobs")
      }
      return [account, pids.filter(alive).length]
    })
  )
}

/** `rr status` omits model cooldowns. Apply both scopes before reserving a slot. */
export const cooledPool = (pool: Pool, state: unknown, model: string, now = Date.now() / 1000): Pool => {
  if (typeof state !== "object" || state === null || Array.isArray(state)) throw new Error("invalid account state")
  const cool = "cool" in state ? state.cool : {}
  if (typeof cool !== "object" || cool === null || Array.isArray(cool)) throw new Error("invalid account cooldowns")
  const unavailable = [...pool.unavailable]
  const ready = pool.ready.filter((account) => {
    for (const key of [account, `${account}@${model}`]) {
      if (!(key in cool)) continue
      const entry: unknown = (cool as Record<string, unknown>)[key]
      if (
        typeof entry !== "object" || entry === null || !("until" in entry) ||
        typeof entry.until !== "number" || !Number.isFinite(entry.until)
      ) throw new Error("invalid account cooldown")
      if (entry.until > now) {
        unavailable.push({ label: account, state: `cooling (${key})` })
        return false
      }
    }
    return true
  })
  return { ...pool, ready, unavailable }
}

const readPool = (agent: Agent) =>
  Effect.gen(function*() {
    const pool = yield* Effect.map(output(`${agent}-rr`, ["status"]), parsePool)
    return yield* Effect.tryPromise({
      try: async () => {
        const text = await readFile(`${homedir()}/.smithers/accounts/${agent}-rr.json`, "utf8").catch((error) => {
          if (error.code === "ENOENT") return "{}"
          throw error
        })
        const state: unknown = JSON.parse(text)
        const active = liveAccounts(state, (pid) => {
          try {
            process.kill(pid, 0)
            return true
          } catch (error) {
            return (error as NodeJS.ErrnoException).code !== "ESRCH"
          }
        })
        return { ...cooledPool(pool, state, agent === "claude" ? "opus" : "gpt-6.1-sol"), active }
      },
      catch: () => new HostFailed({ message: `${agent}: could not read account jobs and cooldowns` })
    })
  })

export interface Reservation {
  readonly agent: Agent
  readonly account: string
  release(): void
}

/** Shared by every local, VM and Cloud action in this host process. */
export const makeReservations = (limit: number) => {
  const held = new Map<string, number>()
  const jobs = new Map<string, Reservation>()
  let cursor = 0
  const reserve = (pools: Pools, issue: number): Reservation | undefined => {
    const preferred = pickAgent(issue, pools)
    if (preferred === undefined) return undefined
    const agents: ReadonlyArray<Agent> = [preferred, preferred === "codex" ? "claude" : "codex"]
    for (const agent of agents) {
      const pool = pools[agent]
      for (let offset = 0; offset < pool.ready.length; offset++) {
        const account = pool.ready[(cursor + offset) % pool.ready.length]!
        if ((held.get(account) ?? 0) + (pool.active?.[account] ?? 0) >= limit) continue
        held.set(account, (held.get(account) ?? 0) + 1)
        cursor = (cursor + offset + 1) % pool.ready.length
        let released = false
        return {
          agent,
          account,
          release: () => {
            if (released) return
            released = true
            const remaining = (held.get(account) ?? 1) - 1
            if (remaining === 0) held.delete(account)
            else held.set(account, remaining)
          }
        }
      }
    }
    return undefined
  }
  const restore = (key: string, agent: Agent, account: string) => {
    if (jobs.has(key)) return
    held.set(account, (held.get(account) ?? 0) + 1)
    jobs.set(key, {
      agent,
      account,
      release: () => {
        const remaining = (held.get(account) ?? 1) - 1
        if (remaining === 0) held.delete(account)
        else held.set(account, remaining)
      }
    })
  }
  const release = (key: string) => {
    jobs.get(key)?.release()
    jobs.delete(key)
  }
  return { reserve, restore, release }
}

/** One host's picker; injection keeps lifecycle and cancellation tests deterministic. */
export const makeAccountPicker = (
  limit: number,
  getPools: Effect.Effect<Pools, HostFailed>,
  reservations = makeReservations(limit)
) => {
  return (issue: number, eligible?: (pools: Pools) => Effect.Effect<Pools, HostFailed>) =>
    Effect.acquireRelease(
      Effect.gen(function*() {
        for (;;) {
          const current = yield* Effect.interruptible(getPools)
          const pools = eligible === undefined ? current : yield* Effect.interruptible(eligible(current))
          if (pools.codex.ready.length + pools.claude.ready.length === 0) {
            return yield* new HostFailed({
              message: "no ready Codex or Claude account"
            })
          }
          const reserved = reservations.reserve(pools, issue)
          if (reserved !== undefined) return reserved
          yield* Effect.interruptible(Effect.sleep("1 second"))
        }
      }),
      (reserved) => Effect.sync(() => reserved.release())
    )
}

/** Keeps the exact account until a local or remote action finishes or is interrupted. */
export const accountHome = (account: string) => `${homedir()}/.smithers/accounts/${account}`

/** Reads both pools from the rotators on this machine. */
export const readPools = Effect.all({
  codex: readPool("codex"),
  claude: readPool("claude")
}, { concurrency: 2 })

const reservations = makeReservations(perAccount)
export const reserveAccount = makeAccountPicker(perAccount, readPools, reservations)
/** Job ownership lasts across probe scopes; repeated attachment is idempotent. */
export const restoreJobAccount = reservations.restore
export const releaseJobAccount = reservations.release

/** Preserve rotator cooling when invoking a reserved account directly. */
export const cooldownMinutes = (stdout: string, stderr: string, code: number): number | undefined => {
  if (code <= 0) return undefined
  const ending = [stdout, stderr].map((text) => text.trim().split("\n").slice(-8).join("\n")).join("\n")
  if (
    /not logged in|failed to authenticate|oauth session expired|invalid api key|401 unauthorized|refresh token|please run \/login|codex login/i
      .test(ending)
  ) return 24 * 60
  if (/out of usage credits|switch to another model/i.test(ending)) return 180
  if (
    /hit your (weekly |session |usage )?limit|usage limit|rate.?limit|limit reached|quota exceeded|exceeded your( current)? quota|insufficient_quota|overloaded/i
      .test(ending)
  ) return 60
  return undefined
}

export const coolAccount = (agent: Agent, account: string, stdout: string, stderr: string, code: number) => {
  const minutes = cooldownMinutes(stdout, stderr, code)
  const key = minutes === 180 ? `${account}@${agent === "claude" ? "opus" : "gpt-6.1-sol"}` : account
  return minutes === undefined ? Effect.void : Effect.asVoid(output(`${agent}-rr`, ["cool", key, String(minutes)]))
}
