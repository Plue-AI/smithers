import type { Account, Reading } from "./accounts.ts"

export type Rates = Record<string, { pointsPerAgentHour: number; source: "seed" | "measured" }>
export function seedRates(tool: Account["tool"]): Rates {
  return tool === "codex" ? { primary: { pointsPerAgentHour: 2, source: "seed" } } : {
    five_hour: { pointsPerAgentHour: 6, source: "seed" },
    seven_day: { pointsPerAgentHour: 1.2, source: "seed" }
  }
}
/** Stale windows are unavailable until a fresh reading confirms the reset. */
export function slots(
  account: Reading,
  now: number,
  rates: Rates = seedRates(account.account.tool),
  inFlight = 0,
  horizonHours = Infinity
): number {
  if (
    !(horizonHours > 0) || !Number.isFinite(now) || !Number.isFinite(inFlight) || inFlight < 0 || account.error ||
    !account.usage || account.usage.limitReached || account.usage.windows.length === 0
  ) return 0
  let ceiling = Infinity
  for (const window of account.usage.windows) {
    const rate = rates[window.name]?.pointsPerAgentHour
    const idle = window.resetsAt === null
    if (idle && (account.account.tool !== "claude" || window.name === "primary" || window.used !== 0)) return 0
    if (window.resetsAt !== null && !Number.isFinite(window.resetsAt)) return 0
    const hours = Math.min(
      window.resetsAt === null ? window.durationHours : (window.resetsAt - now) / 3_600_000,
      horizonHours
    )
    if (
      !Number.isFinite(window.used) || window.used < 0 || window.used >= 97 ||
      !Number.isFinite(window.durationHours) || window.durationHours <= 0 ||
      !Number.isFinite(hours) || hours <= 0 || !rate || !Number.isFinite(rate) || rate <= 0
    ) return 0
    ceiling = Math.min(ceiling, (95 - window.used) / (hours * rate))
  }
  return Math.max(0, Math.floor(ceiling) - Math.ceil(inFlight))
}
export function learnRates(
  previous: ReadonlyArray<Reading>,
  current: ReadonlyArray<Reading>,
  agentHoursPerAccount: Record<string, number>,
  rates: Record<string, Rates> = {},
  alpha = 0.3
): Record<string, Rates> {
  if (!Number.isFinite(alpha) || alpha <= 0 || alpha > 1) throw new RangeError("EWMA alpha must be in (0, 1]")
  const result = Object.fromEntries(
    Object.entries(rates).map((
      [id, value]
    ) => [id, Object.fromEntries(Object.entries(value).map(([name, rate]) => [name, { ...rate }]))])
  )
  for (const reading of current) {
    const id = reading.account.id
    const prior = previous.find((entry) => entry.account.id === id)
    const hours = agentHoursPerAccount[id]
    result[id] ??= seedRates(reading.account.tool)
    if (
      !prior?.usage || prior.error || !reading.usage || reading.error || !hours || !Number.isFinite(hours) ||
      hours < 0.25 || reading.observedAt <= prior.observedAt
    ) continue
    for (const window of reading.usage.windows) {
      const before = prior.usage.windows.find((entry) => entry.name === window.name)
      const old = result[id]?.[window.name]
      if (
        !before || !old || before.resetsAt === null || window.resetsAt === null ||
        before.resetsAt !== window.resetsAt || window.used < before.used ||
        !Number.isFinite(window.used) || !Number.isFinite(before.used)
      ) continue
      const observed = (window.used - before.used) / hours
      result[id][window.name] = {
        pointsPerAgentHour: alpha * observed + (1 - alpha) * old.pointsPerAgentHour,
        source: "measured"
      }
    }
  }
  return result
}
export function exhausted(
  accounts: ReadonlyArray<Reading>,
  now: number,
  rates: Record<string, Rates> = {},
  inFlight: Record<string, number> = {},
  horizonHours = Infinity
): boolean {
  return Number.isFinite(now) && accounts.length > 0 &&
    accounts.every((account) =>
      account.usage !== null && account.error === null &&
      account.usage.windows.some((window) => window.resetsAt !== null) &&
      account.usage.windows.every((window) =>
        Number.isFinite(window.used) && window.used >= 0 && window.used <= 100 &&
        Number.isFinite(window.durationHours) && window.durationHours > 0 &&
        (window.resetsAt === null
          ? account.account.tool === "claude" && window.name !== "primary" && window.used === 0
          : Number.isFinite(window.resetsAt) && window.resetsAt > now)
      ) &&
      slots(account, now, rates[account.account.id], inFlight[account.account.id] ?? 0, horizonHours) === 0
    )
}
export function earliestReset(accounts: ReadonlyArray<Reading>, now: number): number | null {
  const resets = accounts.flatMap((account) =>
    account.error ? [] : account.usage?.windows.map((window) => window.resetsAt) ?? []
  )
    .filter((reset): reset is number => reset !== null && Number.isFinite(reset) && reset > now)
  return resets.length ? Math.min(...resets) : null
}
