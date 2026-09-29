/**
 * What a test runner said, read out of what it printed.
 *
 * A suite's answer is two facts — how many passed, and which ones failed — and
 * a runner spends twenty to thirty kilobytes of stdout saying them. Paying a
 * model to read that is the expensive way to learn a number, and the measured
 * program shows what it costs: sixteen frames on sphinx-8721 existed because a
 * pre-existing failure was never isolated, and the failure *names* were in the
 * output all along.
 *
 * The parsers below recognise the report shapes the standard runners print.
 * Precision is the design constraint, exactly as in `Probe`: a reader claims a
 * complete report only when the runner printed an authoritative completion
 * statement and the observed outcomes agree with it. Pytest requires a tally,
 * TAP requires a plan with every planned outcome, and unittest requires its
 * `Ran` line plus an `OK` or `FAILED` summary. Incomplete captures still return
 * the outcomes they contain with `parsed: false`. A wrong failure set is worse
 * than no failure set, because attribution is built on it.
 *
 * @since 1.0.0
 */

/**
 * One run's outcome as this module could read it.
 *
 * @category models
 * @since 1.0.0
 */
export interface Report {
  readonly passed: number
  readonly failed: ReadonlyArray<string>
  readonly reportedFailed: number | undefined
  readonly parsed: boolean
}

const unique = (ids: ReadonlyArray<string>): ReadonlyArray<string> => [...new Set(ids)]

const collect = (text: string, pattern: RegExp): ReadonlyArray<string> => {
  const found: Array<string> = []
  for (const match of text.matchAll(pattern)) {
    const id = match[1]
    if (id !== undefined) found.push(id)
  }
  return found
}

const count = (text: string, pattern: RegExp): number | undefined => {
  const match = pattern.exec(text)
  return match?.[1] === undefined ? undefined : Number(match[1])
}

/**
 * pytest, in every verbosity it is normally run at.
 *
 * The short summary (`-rA`, and the default on failure) prints one
 * `FAILED path::id - reason` line per failure, and the tally line prints the
 * authoritative counts. Verbose outcome lines preserve observations from an
 * incomplete capture but cannot establish that the run completed.
 */
const pytest = (text: string): Report | undefined => {
  const summaryFailed = collect(text, /^(?:FAILED|ERROR)[ \t]+(.+?)(?:[ \t]+-[ \t]+.*)?$/gm)
  const outcomes = [...text.matchAll(/^(.+?)[ \t]+(PASSED|FAILED|ERROR)(?:[ \t]+.*)?$/gm)]
  const verboseFailed = outcomes.flatMap((match) => match[2] === "FAILED" || match[2] === "ERROR" ? [match[1]!] : [])
  const verbosePassed = unique(outcomes.flatMap((match) => match[2] === "PASSED" ? [match[1]!] : [])).length
  const failed = unique([...summaryFailed, ...verboseFailed])
  // Only a terminal pytest summary can certify completion. Earlier diagnostic
  // lines (including test stdout) are not runner tallies.
  const lastLine = text.trimEnd().split("\n").at(-1) ?? ""
  const summary = /^(?:=+[ \t]*)?(\d+ [a-z]+(?:,[ \t]*\d+ [a-z]+)*) in \d+(?:\.\d+)?s(?: \([^)]*\))?[ \t]*(?:=+)?$/
    .exec(lastLine)?.[1]
  const tally = summary === undefined ? undefined : count(summary, /\b(\d+) passed\b/)
  const failures = summary === undefined ? undefined : count(summary, /\b(\d+) failed\b/)
  const errors = summary === undefined ? undefined : count(summary, /\b(\d+) errors?\b/)
  const hasTally = tally !== undefined || failures !== undefined || errors !== undefined
  const reportedFailed = hasTally ? (failures ?? 0) + (errors ?? 0) : undefined
  if (!hasTally && outcomes.length === 0 && summaryFailed.length === 0) return undefined
  return {
    passed: tally ?? verbosePassed,
    failed,
    reportedFailed,
    parsed: hasTally && reportedFailed !== undefined && failed.length === reportedFailed
  }
}

/**
 * unittest, whose failures name a method and a class in the opposite order to
 * the dotted id everything else uses.
 */
const unittest = (text: string): Report | undefined => {
  const ran = count(text, /^Ran (\d+) tests?\b/m)
  const outcomes = [...text.matchAll(/^(?:FAIL|ERROR|UNEXPECTED SUCCESS):[ \t]+(\S+)[ \t]+\(([^)\s]+)\)/gm)]
  if (ran === undefined && outcomes.length === 0) return undefined
  const failed = unique(
    outcomes.map((match) => match[2]!.endsWith(`.${match[1]}`) ? match[2]! : `${match[2]}.${match[1]}`)
  )
  const summary = /^(OK|FAILED)(?: \(([^)]*)\))?[ \t]*$/m.exec(text)
  const counts = new Map<string, number>()
  let known = summary !== null
  for (const entry of summary?.[2]?.split(", ") ?? []) {
    const match = /^(failures|errors|skipped|expected failures|unexpected successes)=(\d+)$/.exec(entry)
    if (match === null || counts.has(match[1]!)) known = false
    else counts.set(match[1]!, Number(match[2]))
  }
  const reportedFailed = known
    ? (counts.get("failures") ?? 0) + (counts.get("errors") ?? 0) + (counts.get("unexpected successes") ?? 0)
    : undefined
  const skipped = counts.get("skipped") ?? 0
  const expectedFailures = counts.get("expected failures") ?? 0
  const passed = ran === undefined || reportedFailed === undefined
    ? 0
    : Math.max(0, ran - reportedFailed - skipped - expectedFailures)
  return {
    passed,
    failed,
    reportedFailed,
    parsed: ran !== undefined && reportedFailed !== undefined && failed.length === reportedFailed &&
      (summary?.[1] === "OK" ? reportedFailed === 0 : reportedFailed > 0) &&
      passed + failed.length + skipped + expectedFailures === ran
  }
}

/**
 * TAP, which several ecosystems emit and which names each test on its own line.
 */
const tap = (text: string): Report | undefined => {
  const outcomes = [...text.matchAll(/^(not ok|ok)\b[ \t]*\d*[ \t]*-?[ \t]*(.*)$/gm)].map((match) => {
    const directive = /[ \t]*#[ \t]*(SKIP|TODO)\b.*$/i.exec(match[2]!)
    return {
      ok: match[1] === "ok",
      id: match[2]!.slice(0, directive?.index).trim(),
      directive: directive?.[1]?.toUpperCase()
    }
  })
  const failures = outcomes.filter((outcome) => !outcome.ok && outcome.directive === undefined)
  const failed = unique(failures.flatMap((outcome) => outcome.id === "" ? [] : [outcome.id]))
  const passed = outcomes.filter((outcome) => outcome.ok && outcome.directive !== "SKIP").length
  const planned = count(text, /^1\.\.(\d+)\b/m)
  if (outcomes.length === 0 && planned === undefined) return undefined
  const reportedFailed = failures.length
  return {
    passed,
    failed,
    reportedFailed,
    parsed: planned !== undefined && outcomes.length === planned && failed.length === reportedFailed
  }
}

/**
 * Reads one run's report, or says plainly that it could not.
 *
 * @category parsing
 * @since 1.0.0
 */
export const parse = (text: string): Report => {
  const hasTap = /^(?:TAP version \d+|1\.\.\d+|not ok\b|ok\b)/m.test(text)
  const hasUnittest = /^Ran \d+ tests?\b/m.test(text)
  const lastLine = text.trimEnd().split("\n").at(-1) ?? ""
  const hasPytest = /^(?:=+[ \t]*)?\d+ [a-z]+(?:,[ \t]*\d+ [a-z]+)* in \d+(?:\.\d+)?s(?: \([^)]*\))?[ \t]*(?:=+)?$/
    .test(lastLine)
  // Two runner completion signatures in one capture cannot establish which
  // protocol owns the outcomes. Never attribute such a report.
  if ([hasTap, hasUnittest, hasPytest].filter(Boolean).length > 1) {
    return { passed: 0, failed: [], reportedFailed: undefined, parsed: false }
  }
  const readers = hasTap ? [tap] : hasUnittest ? [unittest] : hasPytest ? [pytest] : [unittest, pytest, tap]
  for (const reader of readers) {
    const report = reader(text)
    if (report !== undefined) return report
  }
  return { passed: 0, failed: [], reportedFailed: undefined, parsed: false }
}

/**
 * How two runs of the same command differ, which is the whole of attribution.
 *
 * @category parsing
 * @since 1.0.0
 */
export const attribute = (
  current: Report,
  base: Report
): {
  readonly introduced: ReadonlyArray<string>
  readonly preexisting: ReadonlyArray<string>
  readonly fixed: ReadonlyArray<string>
} | undefined => {
  if (!current.parsed || !base.parsed) return undefined
  const before = new Set(base.failed)
  const now = new Set(current.failed)
  return {
    introduced: current.failed.filter((id) => !before.has(id)),
    preexisting: current.failed.filter((id) => before.has(id)),
    fixed: base.failed.filter((id) => !now.has(id))
  }
}
