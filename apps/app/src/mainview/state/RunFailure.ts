import { PLUE_FAULTS } from "@smthrs/rpc/PlueFailureCodes"
import { refusalOf } from "@smthrs/rpc/Refusal"
import type { PlueFault } from "@smthrs/rpc/Refusal"
import { z } from "zod"
import { leadingRefusal, REFUSAL_COPY, refusalLead } from "@smthrs/rpc/RefusalCopy"
import { runCause } from "./RunCause"

/** Uncoded run failures belong to Smithers. Never infer blame from an error string. */
export function runFailure(detail = "") {
  let body: unknown
  try { body = JSON.parse(detail) } catch { body = undefined }
  const refusal = refusalOf({ body, status: null, message: detail })
  return { fault: refusal.fault, message: refusalLead(refusal), detail }
}

/** The workspace built-in that registers a repository flow on a schedule. */
const REGISTRAR_FLOW = "repository/trigger"

/** The bridge every repository setup operation runs under (packages/backend services/repository_setup.go). */
const SETUP_FLOW = "repository/setup"

/**
 * The setup bridge's own refusals, verbatim from the host that writes them.
 *
 * The bridge is not the registrar: its `invalid_receipt` covers the candidate
 * the person declared AND the receipt plumbing behind it — ancestry, response
 * contracts, control ownership — so the flow and the code together still say
 * nothing about blame, and the host's own sentence is what does. Each one here
 * names an act the person performs: a draft edit, a run of the evals or the
 * trial, resolving source conflicts, connecting the repository host. Nothing
 * is inferred from the prose and no fragment is matched; a sentence the host
 * rewords falls back to the infra lead, and RunFailure.test.ts fails when one
 * of these leaves the file that emits it.
 */
export const SETUP_REFUSALS: ReadonlySet<string> = new Set([
  // flows/repository/receipts.ts:109 — the evidence the next operation needs
  "Run evals for this exact candidate before continuing",
  "Run the live trial for this exact candidate before continuing",
  // flows/repository/setup.ts
  "Required evaluation cases have not passed with evidence",
  "A retained candidate was edited; create a new revision",
  "The reviewed flow declaration was edited; create a new candidate",
  "Connect the repository host before testing or activating automation",
  "Repository source changed after the live trial; test the candidate again",
  // flows/repository/activation.ts
  "Connect the repository host before activation",
  "Setup reached its configured time limit",
  "Automatic replies are currently available for native issue handling only; choose draft replies",
  "Resolve native source conflicts before registration",
  // flows/repository/setup.ts RefuseSetup / RefuseJob
  "Setup input must match the reviewed candidate digest",
  "Job input does not match its registered responsibility or candidate"
])

/**
 * The two setup refusals the APP words, because the host's own sentence names
 * the mechanism rather than the act.
 *
 * "Setup input must match the reviewed candidate digest" is true and is the
 * person's to answer — their draft moved on from the candidate the evals and
 * the trial were run against — but a person reading it off a card learns only
 * that two digests differ. Every other sentence in the table above already
 * names an act, so it is rendered verbatim and this map holds no row for it.
 * The keys are exact host sentences; nothing is inferred from the prose and no
 * fragment is matched, so a sentence the host rewords falls straight back to
 * the host's own words.
 */
export const SETUP_REFUSAL_COPY: ReadonlyMap<string, string> = new Map([
  ["Setup input must match the reviewed candidate digest", "This setup changed after it was reviewed. Test this draft again, then apply it."],
  ["Job input does not match its registered responsibility or candidate", "This run doesn't match the configuration this job has registered. Apply the current draft, then run it again."]
])

/**
 * Every code a settled setup receipt's verdict can carry: the literal set
 * `CodingError` declares in flows/coding/schema.ts, which every
 * flows/repository/*.ts refusal is built from.
 *
 * RunFailure.test.ts reads that declaration, so a code added to the flow's set
 * fails this suite until it is answered below, and the exhaustive match in
 * {@link receiptFault} fails to compile until it is.
 */
export const RECEIPT_CODES = [
  "invalid_plan", "invalid_request", "fast_gate", "check_infra", "stale_revision", "invalid_receipt", "unavailable",
  "execution", "source_missing", "source_changed", "source_refused", "source_unavailable", "declined",
  "stalled", "evicted"
] as const

/** One member of {@link RECEIPT_CODES}. */
export type ReceiptCode = (typeof RECEIPT_CODES)[number]

const isReceiptCode = (code: string): code is ReceiptCode => (RECEIPT_CODES as ReadonlyArray<string>).includes(code)

/**
 * Whose problem one receipt code is, for the person reading a setup card.
 *
 * `invalid_receipt` is the engine's catch-all, so there and only there the
 * host's own sentence decides — exactly the rule {@link journalledFault}
 * already applies to a run's journal. Every other code says by itself whether
 * the request has to change, something Smithers depends on failed, or Smithers
 * is defective.
 */
const receiptFault = (code: ReceiptCode, sentence: string): PlueFault => {
  switch (code) {
    case "invalid_receipt": return SETUP_REFUSALS.has(sentence) ? "user" : "infra"
    /* The request, the revision it names, or the source it points at: the person's to change. */
    case "invalid_request":
    case "stale_revision":
    case "fast_gate":
    case "source_missing":
    case "source_changed":
    case "source_refused":
    /* The planner judged the request not actionable as a code change. */
    case "declined":
    /* Correction rounds stopped changing anything; the request needs a person. */
    case "stalled": return "user"
    /* The local lander evicted its candidate after conflict, failed checks, or main movement. The factory must replan it. */
    case "evicted": return "factory"
    /* Nothing judged the request: the source host or the flow's dependency did not answer. */
    case "unavailable":
    case "source_unavailable": return "dependency"
    /* A plan this app's own flow built, and an execution that died under it. */
    case "invalid_plan": return "bug"
    /* A check whose infrastructure could not measure the revision; never repair feedback. */
    case "check_infra":
    case "execution": return "infra"
    default: { const unhandled: never = code; return unhandled }
  }
}

/**
 * The gateway clips a verdict's first line to 100 characters with a trailing
 * `…` (Diagnosis.verdict), so a long setup refusal arrives cut; the one known
 * refusal it is the start of is the sentence it was.
 */
const unclipped = (sentence: string): string => {
  if (!sentence.endsWith("…")) return sentence
  const start = sentence.slice(0, -1)
  const known = [...SETUP_REFUSALS].filter((refusal) => refusal.startsWith(start))
  return known.length === 1 ? known[0]! : sentence
}

/** `<code>: <sentence>`, the pair agent/internal/FailureSummary.ts writes on a journalled failure's first line. */
const JOURNALLED = /^([a-z][a-z0-9_]*): (\S.*)$/

/** The same pair behind the run's status, which is how a settled receipt's error reads. */
const SETTLED = /^[a-z]+ — ([a-z][a-z0-9_]*): (\S.*)$/

/** The first line of the cause the run itself journalled, which is where the code sits. */
const journalledCause = (events: ReadonlyArray<Record<string, unknown>> = []): string | undefined => {
  const failed = events.filter(event => event.kind === "control.run.failed").at(-1)
  const payload = failed?.payload as { cause?: unknown } | undefined
  return typeof payload?.cause === "string" ? payload.cause.split(/[\r\n]/, 1)[0] : undefined
}

/**
 * Whose problem a journalled code is, for the flow that journalled it.
 *
 * `invalid_receipt` is the engine's catch-all evidence code — an exporter exit,
 * a decode failure, a deadline — so the code alone says nothing about blame.
 * The registrar is the one flow that builds it from the maintainer's own
 * declared input (flows/repository/triggers.ts), so the pair identifies a
 * refusal the request has to answer. Every other pair is Smithers' until the
 * host journals the fault beside the cause.
 *
 * The setup bridge is the exception, and it is not a special case: it journals
 * the same typed pair its settled receipt carries, so {@link receiptFault}
 * reads it here exactly as {@link setupVerdict} reads it on the setup card. A
 * `stale_revision` used to be the person's on the card and Smithers' on the
 * run card of the same failure; one code now reads one way.
 */
/*
 * For the setup bridge and the registrar this table, not the run's stamped
 * fault, is the authority: their codes are refusals a person answers on the
 * setup card, and four of them (invalid_plan, fast_gate, stale_revision,
 * stalled) read differently from the factory ladder's class on purpose.
 * RunFailure.test.ts pins those exceptions.
 */
const journalledFault = (workflow: string, code: string, sentence: string): PlueFault | undefined =>
  workflow === SETUP_FLOW ? isReceiptCode(code) ? receiptFault(code, sentence) : undefined
    : code !== "invalid_receipt" ? undefined
    : workflow === REGISTRAR_FLOW ? "user" : undefined

/**
 * What a settled setup receipt says, typed by its own code.
 *
 * A verdict is `<phase> — <code>: <sentence>`, and a card that could not place
 * the sentence used to render that whole string: the canary walk's issues card
 * read `failed — invalid_receipt: Setup input must match the reviewed
 * candidate digest` after Retry. A run status and an engine code are not a
 * message. Every code the setup bridge can raise carries its fault class here,
 * and a fault that is not the person's is answered with that fault's own line
 * — never with the engine's.
 */
export const setupVerdict = (error: string | undefined): { readonly fault: PlueFault; readonly message: string } | undefined => {
  const settled = SETTLED.exec(error?.split(/[\r\n]/, 1)[0] ?? "")
  if (settled === null) return undefined
  const code = settled[1] ?? "", sentence = unclipped(settled[2] ?? "")
  /* A code this build has never heard of is still a code, and still never printed at a person. */
  if (!isReceiptCode(code)) return { fault: "infra", message: REFUSAL_COPY.infra.lead }
  const fault = receiptFault(code, sentence)
  return fault === "user"
    ? { fault, message: SETUP_REFUSAL_COPY.get(sentence) ?? sentence }
    : { fault, message: REFUSAL_COPY[fault].lead }
}

/**
 * What the setup card and its toast render in place of a receipt error: a
 * verdict line's sentence, or the written lead of a refusal line led by a known
 * code (`workspace_gone — …`); never the words after the code.
 */
export const setupFailureSentence = (error: string | undefined): string | undefined => {
  const verdict = setupVerdict(error)
  if (verdict !== undefined) return verdict.message
  const refusal = error === undefined ? null : leadingRefusal(error)
  return refusal === null ? undefined : refusalLead(refusal)
}

/** The fault the run stamped on its own `control.run.failed`, when the journal is at hand. */
const journalledStamp = (events: ReadonlyArray<Record<string, unknown>> = []): RunFault | undefined => {
  const failed = events.filter(event => event.kind === "control.run.failed").at(-1)
  const fault = (failed?.payload as { fault?: unknown } | undefined)?.fault
  const parsed = RunFaultSchema.safeParse(fault)
  return parsed.success ? parsed.data : undefined
}

/** A failed run's typed fault: `class` is whose problem it is, `tag` the error it came from. */
export interface RunFault { readonly class: PlueFault; readonly tag: string }

/** The stamp a run row carries when it failed, in the shape a card persists. */
export const stampOf = (row: { readonly failureFault?: PlueFault | undefined; readonly failureTag?: string | undefined }): RunFault | undefined =>
  row.failureFault === undefined || row.failureTag === undefined ? undefined : { class: row.failureFault, tag: row.failureTag }
const RunFaultSchema = z.object({ class: z.enum(PLUE_FAULTS), tag: z.string() })

/**
 * A failed run's copy, framed at render time from what the card already
 * carries: the flow it ran and the fault the run stamped when it failed,
 * never the prose. The card persists the stamp from the run row, so the
 * sentence survives a workspace whose journal died with it.
 */
export const runFailureOf = (payload: {
  readonly workflow: string
  readonly error?: string | undefined
  readonly events?: ReadonlyArray<Record<string, unknown>> | undefined
  readonly failure?: RunFault | undefined
}) => {
  const failure = runFailure(payload.error)
  const line = journalledCause(payload.events)
  const journalled = line === undefined ? null : JOURNALLED.exec(line)
  if (journalled !== null && line !== undefined) {
    const fault = journalledFault(payload.workflow, journalled[1] ?? "", journalled[2] ?? "")
    if (fault !== undefined) {
      switch (fault) {
        case "user": return { fault, message: SETUP_REFUSAL_COPY.get(journalled[2] ?? "") ?? journalled[2] ?? "", detail: line }
        /* The fault's own lead, so the setup card and the run card say one thing; the verdict stays the evidence. */
        case "wait":
        case "infra":
        case "dependency":
        case "bug":
        case "factory":
        case "policy": return payload.workflow === SETUP_FLOW ? { fault, message: REFUSAL_COPY[fault].lead, detail: failure.detail } : failure
        default: { const unhandled: never = fault; return unhandled }
      }
    }
  }
  // A setup run's receipt table decides it even when its journal is gone: the verdict carries the same pair.
  if (payload.workflow === SETUP_FLOW) {
    const verdict = setupVerdict(payload.error)
    if (verdict !== undefined) return { ...verdict, detail: failure.detail }
  }
  // So does the registrar's: its invalid_receipt is the person's refusal, and the verdict carries it.
  if (payload.workflow === REGISTRAR_FLOW && line === undefined) {
    const settled = SETTLED.exec(payload.error?.split(/[\r\n]/, 1)[0] ?? "")
    if (settled?.[1] === "invalid_receipt" && settled[2] !== undefined) {
      return { fault: "user" as const, message: settled[2], detail: failure.detail }
    }
  }
  // The row is never staler than the app's copy of the journal.
  const stamp = payload.failure ?? journalledStamp(payload.events)
  if (stamp === undefined) return failure
  return { fault: stamp.class, message: runCause(stamp.tag) ?? REFUSAL_COPY[stamp.class].lead, detail: line ?? failure.detail }
}
