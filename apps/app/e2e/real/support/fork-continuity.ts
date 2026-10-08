// /proc's comm field may contain spaces and parentheses. Field 22 is the
// process start time; a PID alone cannot detect reuse during the fork.
export function counterIdentity(stat: string, expectedPid: string): string {
  const match = /^(\d+) \((.*)\) (\S+) (.*)$/s.exec(stat.trim())
  const fields = match?.[4]?.trim().split(/\s+/)
  const started = fields?.[18]
  if (!match || match[1] !== expectedPid || !started || !/^\d+$/.test(started) || ["Z", "X", "x"].includes(match[3]!)) {
    throw new Error("Source counter is missing or no longer running")
  }
  return `${match[1]} (${match[2]}) ${started}`
}

export function maximumTickGap(ticks: number[]): number {
  if (ticks.length < 2 || ticks.some(tick => !Number.isFinite(tick))) throw new Error("Missing source counter observations")
  const gaps = ticks.slice(1).map((tick, index) => tick - ticks[index]!)
  if (gaps.some(gap => gap < 0) || ticks.at(-1)! <= ticks[0]!) throw new Error("Source counter timestamps did not advance")
  return Math.max(...gaps)
}

// A truncated/replaced log cannot establish uninterrupted execution, even if
// its remaining timestamps look healthy. Keep the boundary tick so a pause
// immediately after the first observation remains part of the measured gap.
export function observedTickInterval(before: number[], after: number[]): number[] {
  maximumTickGap(before)
  if (after.length <= before.length || before.some((tick, index) => after[index] !== tick)) {
    throw new Error("Source counter history was replaced or did not advance")
  }
  const interval = after.slice(before.length - 1)
  maximumTickGap(interval)
  return interval
}
