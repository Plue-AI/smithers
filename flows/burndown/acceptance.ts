import { fileURLToPath } from "node:url"

/** Reviewed acceptance is separate from a commit's permission to land. */
export interface IssueDisposition {
  readonly issue: number
  readonly disposition: "complete" | "landed"
  readonly criteria: ReadonlyArray<{ readonly criterion: string; readonly evidence: ReadonlyArray<string> }>
  readonly remaining: ReadonlyArray<{ readonly issue: string; readonly condition: string }>
}

export interface AcceptanceReceipt {
  readonly version: 1
  readonly repo: string
  readonly revision: string
  readonly issues: ReadonlyArray<IssueDisposition>
}

export interface AcceptanceContext {
  readonly commits?: ReadonlyArray<{ readonly issue: number; readonly commit: string }>
  readonly repo: string
  readonly revision: string
  readonly issues: ReadonlyArray<{ readonly issue: number; readonly body: string }>
  readonly checks: string
}

/**
 * The Fable reviewer assesses full acceptance; this boundary rejects invented
 * citations, missing issues and contradictory completion receipts. Self-contained
 * so the host's generated reviewer uses the same validation implementation.
 */
export function validateAcceptance(value: unknown, context: AcceptanceContext): AcceptanceReceipt {
  const fail = (): never => {
    throw new Error("ACCEPTANCE_INVALID: missing, contradictory or unbound evidence")
  }
  const object = (input: unknown): Record<string, unknown> =>
    input !== null && typeof input === "object" && !Array.isArray(input) ? input as Record<string, unknown> : fail()
  const text = (input: unknown): string => typeof input === "string" && input.trim().length > 0 ? input : fail()
  const list = (input: unknown): ReadonlyArray<unknown> => Array.isArray(input) ? input : fail()
  const receipt = object(value)
  if (
    receipt.version !== 1 || receipt.repo !== context.repo || receipt.revision !== context.revision ||
    !/^[^/\s]+\/[^/\s]+$/.test(context.repo) || !/^[0-9a-f]{40}$/.test(context.revision) ||
    context.issues.length === 0 || context.issues.some((item) => !Number.isSafeInteger(item.issue) || item.issue < 1) ||
    new Set(context.issues.map((item) => item.issue)).size !== context.issues.length
  ) fail()
  const issues = list(receipt.issues)
  if (issues.length !== context.issues.length) fail()
  const seen = new Set<number>()
  const validated = issues.map((input): IssueDisposition => {
    const item = object(input)
    const source = context.issues.find((source) => source.issue === item.issue)
    if (!source || seen.has(source.issue)) return fail()
    seen.add(source.issue)
    if (item.disposition !== "complete" && item.disposition !== "landed") return fail()
    const criteria = list(item.criteria).map((input) => {
      const row = object(input)
      const criterion = text(row.criterion)
      if (!source.body.includes(criterion)) return fail()
      const evidence = list(row.evidence).map((input) => {
        const citation = text(input)
        if (
          !context.checks.includes(citation) ||
          /CHECK_FAILED|CHECK_RED_END|VERDICT:?\s+FAIL|CHECK_TIMEOUT|NO_VERIFICATION|not measured|not executed|blocked|noncacheable|remains pending/i
            .test(citation)
        ) return fail()
        return citation
      })
      if (evidence.length === 0) return fail()
      return { criterion, evidence }
    })
    const remaining = list(item.remaining).map((input) => {
      const row = object(input)
      const issue = text(row.issue)
      if (!/^[^/\s]+\/[^/#\s]+#[1-9][0-9]*$/.test(issue)) return fail()
      return { issue, condition: text(row.condition) }
    })
    if (item.disposition === "complete" && (criteria.length === 0 || remaining.length !== 0)) return fail()
    if (item.disposition === "landed" && remaining.length === 0) return fail()
    return { issue: source.issue, disposition: item.disposition, criteria, remaining }
  })
  return { version: 1, repo: context.repo, revision: context.revision, issues: validated }
}

/** Retain the inputs alongside the result so replay validates the same evidence. */
export interface AcceptanceRecord {
  readonly context: AcceptanceContext
  readonly receipt: AcceptanceReceipt
}

/** Attempt every issue write; the caller retains this record before pushing. */
export async function completeIssueReceipts(
  member: { readonly repo: string; readonly key: string },
  landed: ReadonlyArray<{ readonly issue: number; readonly sha: string }>,
  record: AcceptanceRecord,
  invoke: (command: string, args: ReadonlyArray<string>) => Promise<unknown>
): Promise<void> {
  if (
    !record || !record.context || record.context.repo !== member.repo ||
    record.context.revision !== landed.at(-1)?.sha || landed.length === 0 ||
    landed.some((item) => !/^[0-9a-f]{40}$/.test(item.sha)) ||
    new Set(landed.map((item) => item.issue)).size !== landed.length ||
    record.context.issues.length !== landed.length ||
    record.context.issues.some((item) => !landed.some((commit) => commit.issue === item.issue))
  ) {
    throw new Error("ACCEPTANCE_INVALID: receipt does not match pushed commits")
  }
  const receipt = validateAcceptance(record.receipt, record.context)
  const claimScript = process.env.BURNDOWN_ISSUE_CLAIM_SCRIPT ??
    fileURLToPath(new URL("../../scripts/issue-claim.mjs", import.meta.url))
  const failures: Array<string> = []
  for (const { issue, sha } of landed) {
    const disposition = receipt.issues.find((item) => item.issue === issue)!
    const evidence = disposition.criteria.map((item) => `${item.criterion}\n${item.evidence.join("\n")}`).join("\n\n")
    const remaining = disposition.remaining.map((item) => `${item.issue}: ${item.condition}`).join("\n")
    const body = `Landed on main in ${sha} by the burndown merge queue (${member.key}).\n\n` +
      (disposition.disposition === "complete" ?
        `Acceptance verified at ${receipt.revision}:\n${evidence}` :
        `Issue remains open. Remaining acceptance:\n${remaining}${
          evidence ? `\n\nVerified prerequisite:\n${evidence}` : ""
        }`)
    try {
      const checked = await invoke("node", [
        claimScript,
        "check",
        `${member.repo}#${issue}`,
        "--by",
        `burndown-${member.key}`
      ]) as { stdout: string }
      const ownership = JSON.parse(checked.stdout) as { mine?: boolean; free?: boolean; holder?: unknown }
      if (
        ownership.mine !== true && !(ownership.mine === false && ownership.free === true && ownership.holder == null)
      ) {
        throw new Error("ACCEPTANCE_CLAIM_NOT_OWNED")
      }
      await invoke("node", [
        claimScript,
        "comment",
        `${member.repo}#${issue}`,
        "--by",
        `burndown-${member.key}`,
        "--body",
        body,
        ...(ownership.mine === true ? ["--release"] : []),
        ...(disposition.disposition === "complete" ? ["--close"] : []),
        "--note",
        `${disposition.disposition === "complete" ? "completed" : "landed; acceptance pending"} ${sha}`
      ])
    } catch (cause) {
      const error = (cause ?? {}) as { stdout?: string; stderr?: string; message?: string }
      failures.push(
        `${member.repo}#${issue} ${sha}: ${error.stdout ?? ""} ${error.stderr ?? ""} ${error.message ?? String(cause)}`
      )
    }
  }
  if (failures.length > 0) throw new Error(`LANDING_RECEIPTS_FAILED (commits already pushed):\n${failures.join("\n")}`)
}

/** The model's prose cannot substitute for the required structured disposition. */
export function parseAcceptanceReview(report: string, context: AcceptanceContext): AcceptanceRecord {
  if (!/(?:^|\n)VERDICT: PASS\s*$/.test(report) || /(?:^|\n)VERDICT: FAIL(?:\s|$)/.test(report)) {
    throw new Error("ACCEPTANCE_REVIEW_REJECTED")
  }
  const lines = report.split("\n").filter((line) => line.startsWith("ACCEPTANCE "))
  if (lines.length !== 1) throw new Error("ACCEPTANCE_REVIEW_MISSING: expected one structured disposition")
  let value: unknown
  try {
    value = JSON.parse(lines[0]!.slice("ACCEPTANCE ".length))
  } catch {
    throw new Error("ACCEPTANCE_REVIEW_INVALID: malformed JSON")
  }
  return { context, receipt: validateAcceptance(value, context) }
}

/** Replayed receipts cannot complete acceptance that changed since review. */
export function validateCurrentAcceptance(
  record: AcceptanceRecord,
  current: ReadonlyArray<{ readonly issue: number; readonly body: string }>
): void {
  validateAcceptance(record.receipt, record.context)
  if (
    current.length !== record.context.issues.length ||
    new Set(current.map((item) => item.issue)).size !== current.length ||
    record.context.issues.some((item) =>
      !current.some((source) => source.issue === item.issue && source.body === item.body)
    )
  ) {
    throw new Error(`ACCEPTANCE_CHANGED: ${record.context.repo} issue requirements changed after review`)
  }
}
