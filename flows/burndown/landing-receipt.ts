import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { type AcceptanceRecord, validateAcceptance } from "./acceptance.ts"

export interface ReceiptMember {
  readonly key: string
  readonly repo: string
  readonly commits: ReadonlyArray<{ readonly issue: number; readonly commit: string }>
}
export interface LandingReceipt extends ReceiptMember {
  readonly version: 1 | 2
  readonly phase?: "landed" | "verified"
  readonly landed: ReadonlyArray<{ readonly issue: number; readonly sha: string }>
  readonly acceptance?: AcceptanceRecord
}
const directory = join(homedir(), "Smithers-Ops/burndown/landings")

/** Shared by persisted recovery and the generated atomic receipt writer. */
export function validateLandingReceipt(value: unknown, member: ReceiptMember): LandingReceipt {
  const saved = value as LandingReceipt
  if (
    !saved || (saved.version !== 1 && saved.version !== 2) ||
    (saved.version === 2 && saved.phase !== "landed" && saved.phase !== "verified") ||
    saved.key !== member.key || saved.repo !== member.repo ||
    !/^[^/\s]+\/[^/\s]+$/.test(member.repo) || !Array.isArray(member.commits) || member.commits.length === 0 ||
    member.commits.some((item) =>
      !Number.isSafeInteger(item.issue) || item.issue < 1 || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(item.commit)
    ) ||
    new Set(member.commits.map((item) => item.issue)).size !== member.commits.length ||
    JSON.stringify(saved.commits) !== JSON.stringify(member.commits) ||
    !Array.isArray(saved.landed) || saved.landed.length !== member.commits.length ||
    saved.landed.some((item, index) => item.issue !== member.commits[index]?.issue || !/^[0-9a-f]{40}$/.test(item.sha))
  ) throw new Error("PUSHED_RECEIPT_INVALID")
  if (saved.version === 1 || saved.phase === "verified") {
    validateMemberAcceptance(saved.acceptance, member, saved.landed.at(-1)!.sha)
  } else if (saved.acceptance !== undefined) throw new Error("PUSHED_RECEIPT_INVALID")
  return saved
}

export function validateMemberAcceptance(value: unknown, member: ReceiptMember, revision: string): AcceptanceRecord {
  const record = value as AcceptanceRecord
  if (
    !record?.context || record.context.repo !== member.repo || record.context.revision !== revision ||
    JSON.stringify(record.context.commits) !== JSON.stringify(member.commits) ||
    !Array.isArray(record.context.issues) || record.context.issues.length !== member.commits.length ||
    record.context.issues.some((item) => !member.commits.some((commit) => commit.issue === item.issue))
  ) throw new Error("PUSHED_RECEIPT_INVALID: acceptance binding")
  validateAcceptance(record.receipt, record.context)
  return record
}

export function readPushedReceipt(member: ReceiptMember, root = directory): LandingReceipt | undefined {
  try {
    return validateLandingReceipt(JSON.parse(readFileSync(join(root, `${member.key}.pushed.json`), "utf8")), member)
  } catch {
    return undefined
  }
}
export const hasPushedReceipt = (member: ReceiptMember, root = directory): boolean =>
  readPushedReceipt(member, root) !== undefined
export const hasVerifiedPushedReceipt = (member: ReceiptMember, root = directory): boolean => {
  const saved = readPushedReceipt(member, root)
  return saved !== undefined && (saved.version === 1 || saved.phase === "verified")
}

/** The embedded verified record is authoritative if the earlier file was lost. */
export function loadAcceptanceRecord(member: ReceiptMember, revision: string, root = directory): AcceptanceRecord {
  const saved = readPushedReceipt(member, root)
  if (saved?.acceptance) return validateMemberAcceptance(saved.acceptance, member, revision)
  return validateMemberAcceptance(
    JSON.parse(readFileSync(join(root, `${member.key}.acceptance.json`), "utf8")),
    member,
    revision
  )
}

/** Only host-generated, member-bound remote confirmation grants replay. */
export function isPushedFailure(member: ReceiptMember, cause: unknown, root = directory): boolean {
  if (hasPushedReceipt(member, root)) return true
  try {
    const stdout = (cause as { stdout?: unknown }).stdout
    if (typeof stdout !== "string") return false
    const lines = stdout.split("\n").filter((line) => line.startsWith("LANDING_CONFIRMED "))
    if (lines.length > 0) {
      if (lines.length !== 1) return false
      const saved = validateLandingReceipt(JSON.parse(lines[0]!.slice("LANDING_CONFIRMED ".length)), member)
      return saved.version === 2 && saved.phase === "landed"
    }
    // Historical trusted markers require the pre-push acceptance binding.
    const record = loadAcceptanceRecord(
      member,
      JSON.parse(readFileSync(join(root, `${member.key}.acceptance.json`), "utf8")).context.revision,
      root
    )
    const pushed = [...stdout.matchAll(/^PUSH_ACCEPTED ([0-9a-f]{40})$/gm)]
    if (pushed.length > 0) return pushed.length === 1 && pushed[0]?.[1] === record.context.revision
    const landed = [...stdout.matchAll(/^LANDED ([1-9][0-9]*) ([0-9a-f]{40})$/gm)]
    return landed.length === member.commits.length && landed.every((item, index) => Number(item[1]) === index + 1) &&
      landed.at(-1)?.[2] === record.context.revision
  } catch {
    return false
  }
}
