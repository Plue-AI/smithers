/**
 * The token tripwires for each chat turn, each worker, and each UTC day.
 *
 * These are for runaway loops, not cost control: a healthy run never nears
 * them, and hitting one is reported loudly because something may have gone
 * wrong. `--budget-tokens` (winning) or `SMITHERS_TUI_BUDGET_TOKENS` overrides
 * the per-run cap; `--budget-daily-tokens` or `SMITHERS_TUI_BUDGET_DAILY_TOKENS`
 * overrides the per-day cap across every run on this machine. `0` or `none`
 * disables a cap. A run that would pass one stops with `Budget.BudgetExceeded`.
 */
import type * as Budget from "@smthrs/agent/Budget"
import * as Editor from "./editor.ts"

export const environmentKey = "SMITHERS_TUI_BUDGET_TOKENS"
export const dailyEnvironmentKey = "SMITHERS_TUI_BUDGET_DAILY_TOKENS"

/**
 * 200M tokens per run. `totalTokens` counts the whole context on every call, so a
 * long Opus/Fable worker (~150k context, ~400 calls) is about 60M; no recorded
 * journal carries usage to measure, so this leaves 3x above that estimate.
 */
export const defaultRunTokens = 200_000_000
/** 2B tokens per UTC day: ten runs at the per-run cap. */
export const defaultDailyTokens = 2_000_000_000

type Cap = number | undefined | { readonly error: string }

const cap = (
  fallback: number,
  env: Readonly<Record<string, string | undefined>>,
  key: string,
  flag: string | undefined,
  flagName: string
): Cap => {
  const [value, name] = flag !== undefined ? [flag, flagName] : [env[key], key]
  if (value === undefined || value === "") return fallback
  if (value === "none" || value === "0") return undefined
  const max = Number(value)
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(max) || max <= 0) {
    return { error: `${name} must be a positive whole number, 0, or none` }
  }
  return max
}

/** The policy, or undefined when both caps are disabled. */
export const policy = (
  env: Readonly<Record<string, string | undefined>>,
  flags: { readonly tokens?: string | undefined; readonly daily?: string | undefined } = {}
): Budget.Policy | undefined | { readonly error: string } => {
  const run = cap(defaultRunTokens, env, environmentKey, flags.tokens, "--budget-tokens")
  if (typeof run === "object") return run
  const daily = cap(defaultDailyTokens, env, dailyEnvironmentKey, flags.daily, "--budget-daily-tokens")
  if (typeof daily === "object") return daily
  if (run === undefined && daily === undefined) return undefined
  return {
    ...(run === undefined ? {} : { tokens: { max: run, onExceeded: "fail" as const } }),
    ...(daily === undefined ? {} : { daily: { max: daily } })
  }
}

/** Whether a failed worker stopped at its run's token cap, from its failure copy. */
export const capped = (failure: { readonly headline: string } | undefined): boolean =>
  failure?.headline === "Token budget reached"

/**
 * The run allowances the cap form offers a stopped worker, as multiples of the
 * host's cap: the cap, or twice it. A resumed worker is a new run, so what it
 * gets is an allowance of its own. The day's cap is shared by every run on the
 * machine and is never raised from here.
 */
export const offers: ReadonlyArray<number> = [1, 2]

/** `200M`: an offer as the form shows it. */
export const offer = (tokens: number): string =>
  tokens >= 1_000_000 && tokens % 1_000_000 === 0 ? `${tokens / 1_000_000}M` : Editor.tokens(tokens)
