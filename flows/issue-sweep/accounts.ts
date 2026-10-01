/**
 * The Codex and Claude subscription pools `codex-rr` and `claude-rr` rotate,
 * read through their `status` command, and what they allow this round.
 */
import { Burndown } from "@smthrs/patterns"
import { Effect } from "effect"
import { output } from "./host.ts"

/** One account that cannot take work now, and why. */
export interface Unavailable {
  readonly label: string
  readonly state: string
}

/** One subscription pool. */
export interface Pool {
  readonly ready: ReadonlyArray<string>
  readonly unavailable: ReadonlyArray<Unavailable>
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
  return Burndown.available(Math.max(1, Math.min(maxAgents, ready * perAccount)))
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

/** Reads both pools from the rotators on this machine. */
export const readPools = Effect.all({
  codex: Effect.map(output("codex-rr", ["status"]), parsePool),
  claude: Effect.map(output("claude-rr", ["status"]), parsePool)
}, { concurrency: 2 })
