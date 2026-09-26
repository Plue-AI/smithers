/**
 * The qualification scorecard: per-role and per-case pass rates and the
 * reasons attempts failed, as one wiki page.
 */

/** One scored attempt. */
export interface Scored {
  readonly caseId: string
  readonly principal: string
  readonly kind: string
  readonly attempt: number
  /** Why it failed; empty when it passed. */
  readonly reasons: ReadonlyArray<string>
  readonly receipt?: string | undefined
  readonly seconds: number
}

const infrastructure = "infrastructure:"
const blockedByHost = (attempt: Scored) => attempt.reasons.some((reason) => reason.startsWith(infrastructure))

/** A case that did not run, and why. */
export interface Skipped {
  readonly caseId: string
  readonly principal: string
  readonly reason: string
}

export interface Scorecard {
  readonly date: string
  readonly runs: number
  /** How many times each delivery case ran, when not `runs`. */
  readonly deliveryRuns?: number | undefined
  readonly seats: Readonly<Record<string, string>>
  readonly scored: ReadonlyArray<Scored>
  readonly pending: ReadonlyArray<Skipped>
  readonly invalid: ReadonlyArray<Skipped>
  /** What was graded: the wiki's git revision (`+` with uncommitted changes), the roster revision, the cases' digest. */
  readonly graded?: { readonly wiki: string | undefined; readonly roster: string; readonly cases: string } | undefined
}

const percent = (passed: number, total: number) => total === 0 ? "–" : `${Math.round((passed / total) * 100)}%`
const cell = (text: string) => text.replaceAll("|", "\\|").replaceAll(/\s+/g, " ").trim()

/** Groups `items` by `key`, in first-seen order. */
const group = <A>(items: ReadonlyArray<A>, key: (item: A) => string): ReadonlyMap<string, ReadonlyArray<A>> => {
  const groups = new Map<string, Array<A>>()
  for (const item of items) {
    const name = key(item)
    const bucket = groups.get(name)
    if (bucket === undefined) groups.set(name, [item])
    else bucket.push(item)
  }
  return groups
}

/** Each distinct reason with how many attempts gave it, most frequent first. */
export const reasonsOf = (attempts: ReadonlyArray<Scored>): ReadonlyArray<string> =>
  [...group(attempts.flatMap((attempt) => attempt.reasons), (reason) => reason).entries()]
    .sort((left, right) => right[1].length - left[1].length)
    .map(([reason, all]) => `${reason.length > 300 ? `${reason.slice(0, 299)}…` : reason} (${all.length})`)

/** The scorecard as markdown. */
export const render = (card: Scorecard): string => {
  const passed = card.scored.filter((attempt) => attempt.reasons.length === 0).length
  const hosted = card.scored.filter(blockedByHost).length
  const byRole = group(
    [...card.scored].sort((left, right) => left.principal < right.principal ? -1 : 1),
    (attempt) => attempt.principal
  )
  const byCase = group(
    [...card.scored].sort((left, right) => left.caseId < right.caseId ? -1 : 1),
    (attempt) => attempt.caseId
  )
  const lines = [
    `# Qualification ${card.date}`,
    "",
    `${passed}/${card.scored.length} attempts passed (${
      percent(passed, card.scored.length)
    }); ${hosted} stopped by the host, not the role; ${byCase.size} cases × ${card.runs}${
      card.deliveryRuns === undefined || card.deliveryRuns === card.runs ? "" : ` (deliveries × ${card.deliveryRuns})`
    }; ${card.pending.length} pending; ${card.invalid.length} invalid.`,
    "",
    ...(card.graded === undefined ? [] : [
      `Graded: wiki ${card.graded.wiki ?? "not a git checkout"}, roster ${card.graded.roster.slice(0, 12)}, cases ${
        card.graded.cases.slice(0, 12)
      }.`,
      ""
    ]),
    "| Role | Seat | Passed | Rate | Host stops |",
    "| --- | --- | --- | --- | --- |",
    ...[...byRole.entries()].map(([role, attempts]) => {
      const ok = attempts.filter((attempt) => attempt.reasons.length === 0).length
      return `| ${role} | ${card.seats[role] ?? ""} | ${ok}/${attempts.length} | ${percent(ok, attempts.length)} | ${
        attempts.filter(blockedByHost).length
      } |`
    }),
    "",
    "| Case | Role | Kind | Passed | Failures |",
    "| --- | --- | --- | --- | --- |",
    ...[...byCase.entries()].map(([id, attempts]) => {
      const ok = attempts.filter((attempt) => attempt.reasons.length === 0).length
      return `| ${id} | ${attempts[0]!.principal} | ${attempts[0]!.kind} | ${ok}/${attempts.length} | ${
        cell(reasonsOf(attempts).join("; "))
      } |`
    }),
    ...(card.pending.length === 0 ? [] : [
      "",
      "| Pending | Role | Why |",
      "| --- | --- | --- |",
      ...card.pending.map((skipped) => `| ${skipped.caseId} | ${skipped.principal} | ${cell(skipped.reason)} |`)
    ]),
    ...(card.invalid.length === 0 ? [] : [
      "",
      "| Invalid | Why |",
      "| --- | --- |",
      ...card.invalid.map((skipped) => `| ${skipped.caseId} | ${cell(skipped.reason)} |`)
    ]),
    ""
  ]
  return lines.join("\n")
}
