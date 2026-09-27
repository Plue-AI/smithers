import { refusalOf } from "@smthrs/rpc/Refusal"
import type { PlueFault } from "@smthrs/rpc/Refusal"
import { REFUSAL_COPY, refusalLead } from "@smthrs/rpc/RefusalCopy"
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

/** The bridge every repository setup operation runs under (apps/server/src/repositorySetupExecution.ts). */
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
  "invalid_plan", "invalid_request", "fast_gate", "stale_revision", "invalid_receipt", "unavailable",
  "execution", "source_missing", "source_changed", "source_refused", "source_unavailable", "declined",
  "stalled"
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
    /* Nothing judged the request: the source host or the flow's dependency did not answer. */
    case "unavailable":
    case "source_unavailable": return "dependency"
    /* A plan this app's own flow built, and an execution that died under it. */
    case "invalid_plan": return "bug"
    case "execution": return "infra"
    default: { const unhandled: never = code; return unhandled }
  }
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
  const code = settled[1] ?? "", sentence = settled[2] ?? ""
  /* A code this build has never heard of is still a code, and still never printed at a person. */
  if (!isReceiptCode(code)) return { fault: "infra", message: REFUSAL_COPY.infra.lead }
  const fault = receiptFault(code, sentence)
  return fault === "user"
    ? { fault, message: SETUP_REFUSAL_COPY.get(sentence) ?? sentence }
    : { fault, message: REFUSAL_COPY[fault].lead }
}

/** {@link setupVerdict}'s sentence: what the setup card and its toast render in place of a verdict line. */
export const setupFailureSentence = (error: string | undefined): string | undefined => setupVerdict(error)?.message

/**
 * A failed run's copy, framed at render time from what the card already
 * carries: the flow it ran and the code its journal recorded, never the prose.
 * Nothing projected or persisted changes — `payload.error` stays the gateway's
 * verdict, so a maximized frame hashed by an older build still replays.
 */
export const runFailureOf = (payload: {
  readonly workflow: string
  readonly error?: string | undefined
  readonly events?: ReadonlyArray<Record<string, unknown>> | undefined
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
        case "bug": return payload.workflow === SETUP_FLOW ? { fault, message: REFUSAL_COPY[fault].lead, detail: failure.detail } : failure
        default: { const unhandled: never = fault; return unhandled }
      }
    }
  }
  /*
   * The run's own typed cause, for any flow: the harness and the model each
   * declare a closed vocabulary, and a code only one of them spells says what
   * happened without anything being read off the sentence beside it. A code a
   * second vocabulary also spells gets no sentence and the fault's lead
   * stands (`RunCause.SHARED_CODES`). The two flow vocabularies above are
   * answered first, so a code they both spell keeps the reading its own flow
   * gives it.
   *
   * The journal is preferred and the verdict stands in for it, because the two
   * carry the same first line and only one of them survives the run: the
   * journal is a live read against the run's workspace
   * (`controller/workflow-pump.ts` `readJournalPages`), so a run whose
   * workspace has been torn down has no journal at all, while the verdict is
   * persisted on the card. Before this, such a run could only ever say the
   * infra lead, however typed the cause it died of.
   */
  const settled = SETTLED.exec(payload.error?.split(/[\r\n]/, 1)[0] ?? "")
  const code = journalled?.[1] ?? settled?.[1]
  const cause = code === undefined ? undefined : runCause(code)
  if (cause === undefined) return failure
  return { fault: cause.fault, message: cause.message, detail: line ?? failure.detail }
}
