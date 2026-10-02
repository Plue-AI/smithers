/*
 * J4's morning: the seed stack grown to the spec's counts (mvp.md J4.1).
 * Needs you 2, Working 3, Queued 1, In review 4, one Failed, and 5 merged
 * since Maya last looked. Three TODOs hold all three machines, so the queued
 * item waits, and so does anything that resumes until a machine frees.
 */
import type { Branch, Evidence, Todo, World } from "../world"
import { ALICE, BEN, MAYA } from "./seed"

const green = (files: number, added: number, removed: number, review: string): Evidence => ({
  files, added, removed,
  checks: [{ name: "typecheck", state: "passed", took: "12s" }, { name: "test", state: "passed", took: "58s" }, { name: "lint", state: "passed", took: "8s" }],
  github: { passed: 5, total: 5 },
  review
})

/** The rebased revision's checks, rerunning after Move up (mvp.md §4.2). */
export const rerunning = (evidence: Evidence): Evidence => ({
  ...evidence,
  checks: evidence.checks.map(check => ({ name: check.name, state: "running" as const })),
  github: { passed: 0, total: evidence.github.total }
})

export const passedAgain = (evidence: Evidence): Evidence => ({
  ...evidence,
  checks: [{ name: "typecheck", state: "passed", took: "11s" }, { name: "test", state: "passed", took: "1m 01s" }, { name: "lint", state: "passed", took: "8s" }],
  github: { passed: evidence.github.total, total: evidence.github.total }
})

export const RATES_EVIDENCE = green(2, 46, 8, "No blocking issues.")
export const LIMITS_EVIDENCE = green(4, 97, 6, "No blocking issues. 429s carry Retry-After.")
export const CHECKOUT_EVIDENCE = green(1, 9, 4, "The race was an unawaited cart save. 200 runs, 0 failures.")
export const STRIPE_LESSONS = 2

const ADDED: ReadonlyArray<Todo> = [
  {
    id: "t-invoices", title: "Paginate GET /invoices", owner: BEN, branch: "b-invoices", state: "failed", step: "verify", pr: 90,
    prompt: "Paginate GET /invoices with a cursor. Keep the response shape for the first page.",
    failure: "invoices.test.ts: the last page repeats a row"
  },
  {
    id: "t-rates", title: "Cache exchange rates for 10 minutes", owner: ALICE, branch: "b-rates", state: "in-review", pr: 92,
    prompt: "Cache exchange rates in memory for 10 minutes. Refresh them in the background.",
    evidence: RATES_EVIDENCE
  },
  {
    id: "t-receipts", title: "Send receipts in the customer's language", owner: BEN, branch: "b-receipts", state: "in-review", pr: 93,
    prompt: "Send payment receipts in the customer's saved language, falling back to English.",
    evidence: green(6, 88, 12, "No blocking issues.")
  },
  {
    id: "t-rename", title: "Rename customer_id to account_id", owner: ALICE, branch: "b-rename", state: "needs-you", step: "implement", failure: "conflict",
    prompt: "Rename customer_id to account_id across the schema, models and API.",
    question: { text: "Rebasing onto #87 conflicts in src/db/schema.ts. I can't resolve it safely." }, elapsed: "40m"
  },
  {
    id: "t-coupons", title: "Drop the unused coupons table", owner: ALICE, branch: "b-coupons", state: "in-review", pr: 94,
    prompt: "Drop the coupons table and its model. Nothing has read it since March.",
    evidence: green(3, 4, 61, "No blocking issues. The migration is reversible.")
  },
  {
    id: "t-limits", title: "Rate-limit the public API", owner: BEN, branch: "b-limits", state: "working", step: "verify",
    prompt: "Limit /v1 to 100 requests a minute per API key. Return 429 with Retry-After.", elapsed: "21m"
  },
  {
    id: "t-audit", title: "Add an audit log for refunds", owner: MAYA, branch: "b-audit", state: "working", step: "plan",
    prompt: "Record every refund in an audit log: who, when, amount and reason.", elapsed: "3m"
  }
]

const branchFor = (id: string, name: string, item: string, machine: Branch["machine"], step?: string): Branch => ({
  id, name, item, from: "main", machine, activity: [], terminals: [],
  presence: step === undefined ? [] : [{ who: `agent:${id}`, where: { kind: "step", step } }]
})

export const buildMorning = (world: World): void => {
  world.todos.push(...ADDED.map(each => structuredClone(each)))
  world.stack = ["t-stripe", "t-invoices", "t-rates", "t-receipts", "t-retry", "t-rename", "t-coupons", "t-limits", "t-checkout", "t-audit", "t-log"]
  // Overnight nobody stayed on the retry branch, and a branch waiting on a person releases its machine.
  const retry = world.branches.find(each => each.id === "b-retry")!
  retry.machine = "asleep"
  retry.presence = []
  world.branches.push(
    branchFor("b-invoices", "paginate-invoices", "t-invoices", "asleep"),
    branchFor("b-rates", "cache-exchange-rates", "t-rates", "asleep"),
    branchFor("b-receipts", "localize-receipts", "t-receipts", "asleep"),
    branchFor("b-rename", "rename-account-id", "t-rename", "asleep"),
    branchFor("b-coupons", "drop-coupons", "t-coupons", "asleep"),
    branchFor("b-limits", "rate-limit-api", "t-limits", "awake", "verify"),
    branchFor("b-audit", "refund-audit-log", "t-audit", "awake", "plan")
  )
  world.runs.push({ id: "learn-87", title: "Learning from #87", state: "failed", detail: "Provider timed out", seq: 0 })
}
