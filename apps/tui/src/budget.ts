/**
 * The opt-in token ceiling for each chat turn and each worker.
 *
 * Unbounded unless `--budget-tokens` (winning) or `SMITHERS_TUI_BUDGET_TOKENS`
 * sets one. A run that would pass it stops with `Budget.BudgetExceeded`.
 */
import type * as Budget from "@smthrs/agent/Budget"

export const environmentKey = "SMITHERS_TUI_BUDGET_TOKENS"

export const policy = (
  env: Readonly<Record<string, string | undefined>>,
  flag?: string
): Budget.Policy | undefined | { readonly error: string } => {
  const [value, name] = flag !== undefined ? [flag, "--budget-tokens"] : [env[environmentKey], environmentKey]
  if (value === undefined || value === "") return undefined
  const max = Number(value)
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(max) || max <= 0) {
    return { error: `${name} must be a positive whole number` }
  }
  return { tokens: { max, onExceeded: "fail" } }
}
