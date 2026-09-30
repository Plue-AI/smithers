import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import type { PlueFault } from "@smthrs/rpc/Refusal"
import { RECEIPT_CODES, type RunFault, runFailure, runFailureOf, SETUP_REFUSAL_COPY, SETUP_REFUSALS, setupFailureSentence, setupVerdict } from "./RunFailure"
import { REFUSAL_COPY } from "@smthrs/rpc/RefusalCopy"
import * as Fault from "@smthrs/flow/Fault"
import { CodingError } from "../../../../../flows/coding/schema.ts"
import { runCause } from "./RunCause"

const INFRA = "Something on Smithers' side failed. Not your fault, and nothing your request could have changed."
// Formatting may wrap the call, but the emitted argument must remain exact.
const invalidCall = (argument: string): RegExp =>
  new RegExp(`\\binvalid\\(\\s*${argument.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\)`)
/* One of the sentences flows/repository/triggers.ts refuses a registration with. */
const REFUSAL = 'Add a model to "nightly-lint" to schedule it.'
const VERDICT = `failed — invalid_receipt: ${REFUSAL}`
const journal = (cause: string, fault?: { class: string; tag: string }) =>
  [{ sequence: 1, kind: "control.run.failed", runId: "run-1", occurredAt: 1, payload: { runId: "run-1", status: "failed", cause, ...(fault === undefined ? {} : { fault }) } }]

test("uncoded execution errors use infra copy and retain the complete raw detail", () => {
  const raw = "failed — Error: Error: git exited 1"
  expect(runFailure(raw)).toEqual({ fault: "infra", message: "Something on Smithers' side failed. Not your fault, and nothing your request could have changed.", detail: raw })
})

test("coded errors use the shared refusal table without interpreting raw prose", () => {
  const raw = JSON.stringify({ code: "no_capacity", message: "No slots" })
  const failure = runFailure(raw)
  expect(failure.fault).toBe("infra")
  expect(failure.message).toContain("@fucory")
  expect(failure.detail).toBe(raw)
  expect(runFailure().message).toContain("Not your fault")
})

test("only the registrar's own refusal is the person's input; every other flow's invalid_receipt stays Smithers'", () => {
  const cause = `invalid_receipt: ${REFUSAL}\n    at repository/trigger (flows/repository/triggers.ts:20)`
  expect(runFailureOf({ workflow: "repository/trigger", error: VERDICT, events: journal(cause) }))
    .toEqual({ fault: "user", message: REFUSAL, detail: `invalid_receipt: ${REFUSAL}` })
  for (const [workflow, engine] of [
    ["coding/request", "Native source creation returned an invalid receipt"],
    ["repository/setup", "Setup output failed the shared response contract"]
  ]) {
    expect(runFailureOf({ workflow: workflow!, error: VERDICT, events: journal(`invalid_receipt: ${engine!}`) }))
      .toEqual({ fault: "infra", message: INFRA, detail: VERDICT })
  }
})

test("a registrar failure the registrar did not refuse keeps the verdict and the infra headline", () => {
  for (const cause of [
    "execution: The schedule registration did not complete; inspect the retained run",
    "Error: connect ECONNREFUSED 127.0.0.1:8788",
    "invalid_receipt:",
    "invalid_receipt: "
  ]) {
    expect(runFailureOf({ workflow: "repository/trigger", error: VERDICT, events: journal(cause) }))
      .toEqual({ fault: "infra", message: INFRA, detail: VERDICT })
  }
  // The journal gone, the registrar's verdict still carries its refusal: the person's.
  expect(runFailureOf({ workflow: "repository/trigger", error: VERDICT, events: [] })).toEqual({ fault: "user", message: REFUSAL, detail: VERDICT })
  expect(runFailureOf({ workflow: "repository/trigger", error: VERDICT })).toEqual({ fault: "user", message: REFUSAL, detail: VERDICT })
  expect(runFailureOf({ workflow: "repository/trigger", error: "failed — unavailable: The exact schedule could not be registered" }))
    .toMatchObject({ fault: "infra", message: INFRA })
  expect(runFailureOf({ workflow: "repository/trigger" })).toEqual({ fault: "infra", message: INFRA, detail: "" })
})

/* The canary's own trial refusal, verbatim: `Create test issue` pressed before the evals passed
 * (.artifacts/mvp-canary-walk-20260917/B-18-state-trial-terminal.json, receipt run-3). */
const TRIAL = "Run evals for this exact candidate before continuing"
const TRIAL_VERDICT = `failed — invalid_receipt: ${TRIAL}`
/* flows/repository/setup.ts refuses a request whose revision moved on. */
const STALE = "Setup input must match the current setup revision"
const setupCause = (sentence: string) => journal(`invalid_receipt: ${sentence}\n    at repository/Setup (flows/repository/receipts.ts:109)`)

test("a setup refusal the person must answer is the person's, headline and all", () => {
  expect(runFailureOf({ workflow: "repository/setup", error: TRIAL_VERDICT, events: setupCause(TRIAL) }))
    .toEqual({ fault: "user", message: TRIAL, detail: `invalid_receipt: ${TRIAL}` })
  for (const sentence of [
    "Required evaluation cases have not passed with evidence",
    "Repository source changed after the live trial; test the candidate again",
    "Automatic replies are currently available for native issue handling only; choose draft replies"
  ]) {
    expect(runFailureOf({ workflow: "repository/setup", error: TRIAL_VERDICT, events: setupCause(sentence) }))
      .toEqual({ fault: "user", message: sentence, detail: `invalid_receipt: ${sentence}` })
  }
})

test("a setup failure the person cannot act on stays Smithers', and no other flow reads the table", () => {
  for (const engine of [
    "Setup output failed the shared response contract",
    "Repository setup needs its approved Control entry",
    "The receipt has no retained native owner",
    "Setup belongs to a different repository or workspace"
  ]) {
    expect(runFailureOf({ workflow: "repository/setup", error: TRIAL_VERDICT, events: setupCause(engine) }))
      .toEqual({ fault: "infra", message: INFRA, detail: TRIAL_VERDICT })
  }
  for (const workflow of ["coding/request", "repository-jobs/issues", "repository/Setup"]) {
    expect(runFailureOf({ workflow, error: TRIAL_VERDICT, events: setupCause(TRIAL) }))
      .toEqual({ fault: "infra", message: INFRA, detail: TRIAL_VERDICT })
  }
  expect(runFailureOf({ workflow: "repository/setup", error: TRIAL_VERDICT, events: journal(`execution: ${TRIAL}`) }))
    .toEqual({ fault: "infra", message: INFRA, detail: TRIAL_VERDICT })
})

/*
 * L103's own disclosure, closed: the setup bridge journals the same typed pair
 * the settled receipt carries, so `stale_revision` used to read as the
 * person's on the setup card and as Smithers' on the run card of the very same
 * failure. One code, one reading, on both surfaces.
 */
test("a setup journal's code reads on the run card exactly as it reads on the setup card", () => {
  for (const code of RECEIPT_CODES) {
    for (const sentence of [TRIAL, "Something the engine wrote"]) {
      const verdict = `failed — ${code}: ${sentence}`
      const settled = setupVerdict(verdict)!
      expect(runFailureOf({ workflow: "repository/setup", error: verdict, events: journal(`${code}: ${sentence}`) }))
        .toMatchObject({ fault: settled.fault, message: settled.message })
    }
  }
  expect(runFailureOf({ workflow: "repository/setup", error: `failed — stale_revision: ${STALE}`, events: journal(`stale_revision: ${STALE}`) }))
    .toEqual({ fault: "user", message: STALE, detail: `stale_revision: ${STALE}` })
})

/*
 * L111. A run that made nine calls and then died at turn 6 said only the infra
 * lead — true about blame, empty about cause, and the last sentence a person
 * reads after a run that visibly did most of its work. The cause it died with
 * IS typed: the harness and the model each declare a closed code vocabulary,
 * and the journal's first line and the gateway's verdict both carry the code.
 * Neither was read here.
 */
const LATE_FLOW = "agent/run"
/* Verbatim shapes, ids and all: AgentSession.ts:1942 and CompletionClaim.ts:551. */
const EXHAUSTED = 'model_failed: The agent session "run-7f3a" ended without a completed answer after 6 frames'
const UNPROVEN = "claim_unproven: A completion reporting work this run never recorded: invented 0.91 (complete 0.35, overclaims 0.89, neither of which decides this). The claim was handed back for a frame and came back still unrecorded."

const stamp = (tag: string, kind: PlueFault): RunFault => ({ class: kind, tag })
const HARNESS = (code: string) => `/harness/HarnessError/${code}`

test("a run that died late names what happened from its stamped fault, never in the harness's own words", () => {
  for (const [cause, code] of [[EXHAUSTED, "model_failed"], [UNPROVEN, "claim_unproven"]] as const) {
    const fault = stamp(HARNESS(code), code === "model_failed" ? "dependency" : "factory")
    const failure = runFailureOf({ workflow: LATE_FLOW, error: `failed — ${cause.slice(0, 100)}`, events: journal(cause, fault) })
    expect(failure).toMatchObject({ fault: fault.class, message: runCause(fault.tag), detail: cause })
    expect(failure.message).not.toContain("run-7f3a")
    expect(failure.message).not.toContain("invented")
  }
  /* The brake's two halves mean different things since 46fcc61722f5, so they read differently. */
  const unproven = runFailureOf({ workflow: LATE_FLOW, events: journal(UNPROVEN, stamp(HARNESS("claim_unproven"), "factory")) })
  const unjudged = runFailureOf({ workflow: LATE_FLOW, events: journal("completion_unjudged: 503", stamp(HARNESS("completion_unjudged"), "dependency")) })
  expect(unproven.message).not.toBe(unjudged.message)  for (const failure of [unproven, unjudged]) expect(failure.message).toContain("Not your fault")
})

/*
 * A code string does not name its author: a `JjError`, a sandbox
 * `ProviderError`, a `SyncError`, a `CodingError` and a std `StdError` all
 * journal a first line that looks exactly like the model's. The stamped tag
 * does name it, so each reads as its own class's lead, never a model sentence.
 */
test("another vocabulary's code reads as its class's lead, never as a model call that failed", () => {
  for (
    const [tag, kind] of [
      ["@smthrs/jj/JjError/unknown", "bug"],
      ["coding/Error/invalid_request", "user"],
      ["@smthrs/std/StdError/rate_limited", "bug"]
    ] as const
  ) {
    const failure = runFailureOf({ workflow: LATE_FLOW, events: journal(`${tag.split("/").at(-1)}: x`, stamp(tag, kind)) })
    expect(failure).toMatchObject({ fault: kind, message: REFUSAL_COPY[kind].lead })
    expect(failure.message).not.toContain("model")
  }
})

/*
 * A torn-down workspace takes the journal with it (workflow-pump.ts
 * `readJournalPages`), but the card keeps the stamp it copied off the run row.
 */
test("the sentence survives the workspace the journal died with", () => {
  const failure = stamp("flows/model/ModelError/transport", "dependency")
  const verdict = "failed — transport: the socket closed"
  expect(runFailureOf({ workflow: LATE_FLOW, error: verdict, failure }))
    .toEqual({ fault: "dependency", message: runCause(failure.tag)!, detail: verdict })
  expect(runFailureOf({ workflow: LATE_FLOW, error: verdict, events: [], failure }).message).toBe(runCause(failure.tag)!)
  /* A policy stop with no worded tag reads as its lead. */
  expect(runFailureOf({ workflow: LATE_FLOW, error: verdict, failure: stamp("flows/agent/BudgetExceeded", "policy") }))
    .toEqual({ fault: "policy", message: REFUSAL_COPY.policy.lead, detail: verdict })
})

test("an unstamped late failure is Smithers', whatever code its prose carries", () => {
  for (const cause of [EXHAUSTED, "unknown: jj describe: cannot run in /gone", "transport: closed"]) {
    const error = `failed — ${cause.slice(0, 100)}`
    expect(runFailureOf({ workflow: LATE_FLOW, error, events: journal(cause) })).toMatchObject({ fault: "infra", message: INFRA })
    expect(runFailureOf({ workflow: LATE_FLOW, error })).toEqual({ fault: "infra", message: INFRA, detail: error })
  }
})

test("a late failure carrying no code this build knows is still Smithers', headline and all", () => {
  for (const error of [
    "failed — Smithers generated an OpenRouter default agent, but OPENROUTER_API_KEY is not set.",
    "failed — no cause recorded in the journal",
    "failed — Error: connect ECONNREFUSED 127.0.0.1:8788"
  ]) {
    expect(runFailureOf({ workflow: LATE_FLOW, error })).toEqual({ fault: "infra", message: INFRA, detail: error })
  }
  /* The setup bridge's and the registrar's vocabularies are answered where they always were, not here. */
  expect(runFailureOf({ workflow: "repository/setup", error: TRIAL_VERDICT, events: setupCause(TRIAL) }))
    .toEqual({ fault: "user", message: TRIAL, detail: `invalid_receipt: ${TRIAL}` })
})

test("every sentence in the table is one the setup flows still emit, in the file that emits it", () => {
  const read = (file: string) => readFileSync(fileURLToPath(new URL(`../../../../../flows/repository/${file}`, import.meta.url)), "utf8")
  const source = ["setup.ts", "activation.ts"].map(read).join("\n")
  /* The two the host builds from one template; the rest it writes out. */
  expect(read("receipts.ts")).toMatch(invalidCall('`Run ${operation === "evaluate" ? "evals" : "the live trial"} for this exact candidate before continuing`'))
  for (const sentence of SETUP_REFUSALS) {
    if (sentence.endsWith("for this exact candidate before continuing")) continue
    expect(source).toMatch(invalidCall(JSON.stringify(sentence)))
  }
})

/*
 * The canary's own retry, verbatim (.artifacts/mvp-canary-walk-20260917/
 * W1-g-discard-and-retry.json `L76-issuesAfterRetry`): the issues card's
 * settled failure read `failed — invalid_receipt: Setup input must match the
 * reviewed candidate digest` — a run status and an engine code, shown to a
 * person. A settled verdict is `<phase> — <code>: <sentence>`; every code the
 * setup bridge can put there is answered, so none of them reaches a card as
 * itself.
 */
const RETRY_VERDICT = "failed — invalid_receipt: Setup input must match the reviewed candidate digest"

test("a settled verdict never reaches a person as its phase and code", () => {
  expect(setupFailureSentence(RETRY_VERDICT)).toBe("This setup changed after it was reviewed. Test this draft again, then apply it.")
  expect(setupFailureSentence("failed — invalid_receipt: Run evals for this exact candidate before continuing"))
    .toBe("Run evals for this exact candidate before continuing")
  expect(setupFailureSentence("failed — invalid_receipt: Setup output failed the shared response contract")).toBe(INFRA)
  /* An uncoded host sentence is the host's own and stays exactly as written. */
  expect(setupFailureSentence("AI check Documentation edits preserve existing content has no completed in-scope trial result; test a change that exercises it")).toBeUndefined()
  expect(setupFailureSentence(undefined)).toBeUndefined()
  for (const code of RECEIPT_CODES) {
    const sentence = setupFailureSentence(`failed — ${code}: Something the engine wrote`)
    expect(sentence).toBeString()
    expect(sentence).not.toContain(code)
    expect(sentence).not.toContain("failed — ")
  }
  /* A code this build does not know is still never printed at a person. */
  expect(setupFailureSentence("failed — brand_new_code: Something the engine wrote")).toBe(INFRA)
})

test("every receipt code the setup flows can raise is answered here", () => {
  const schema = readFileSync(fileURLToPath(new URL("../../../../../flows/coding/schema.ts", import.meta.url)), "utf8")
  const declared = /export class CodingError[\s\S]*?code: Schema\.Literals\(\[([\s\S]*?)\]\)/.exec(schema)?.[1] ?? ""
  const codes = [...declared.matchAll(/"([a-z_]+)"/g)].map((match) => match[1])
  expect(codes.length).toBeGreaterThan(0)
  const answered: ReadonlyArray<string> = RECEIPT_CODES
  expect([...answered].sort()).toEqual(codes.sort())
})

test("the sentences the app words itself are ones the setup flows still emit", () => {
  const setup = readFileSync(fileURLToPath(new URL("../../../../../flows/repository/setup.ts", import.meta.url)), "utf8")
  for (const sentence of SETUP_REFUSAL_COPY.keys()) {
    expect(SETUP_REFUSALS.has(sentence)).toBe(true)
    expect(setup).toMatch(invalidCall(JSON.stringify(sentence)))
  }
})

test("the setup bridge reads its receipt codes by its own table, and differs from the factory ladder only where pinned", () => {
  const verdict = (code: string) => `failed — ${code}: Something the engine wrote`
  const differs = RECEIPT_CODES.filter((code) =>
    setupVerdict(verdict(code))!.fault !== Fault.of(new CodingError({ code, message: "m" })).class
  )
  // A setup refusal is the person's to answer on the card; the factory would replan these.
  expect([...differs].sort()).toEqual(["fast_gate", "invalid_plan", "stale_revision", "stalled"])
  // And a stamped setup run still reads by the bridge's table, not the stamp.
  const stamped = runFailureOf({
    workflow: "repository/setup",
    events: journal(`stalled: ${TRIAL}`, { class: "factory", tag: "coding/Error/stalled" })
  })
  expect(stamped.fault).toBe("user")
})

test("a setup run whose journal is gone still reads by the bridge's table, not the stamp", () => {
  const verdict = `failed — invalid_receipt: ${TRIAL}`
  expect(runFailureOf({ workflow: "repository/setup", error: verdict, failure: { class: "infra", tag: "coding/Error/invalid_receipt" } }))
    .toEqual({ fault: "user", message: TRIAL, detail: verdict })
})

test("a long setup refusal the gateway clipped in its verdict still reads as the person's sentence", () => {
  const refusal = "Automatic replies are currently available for native issue handling only; choose draft replies"
  const line = `invalid_receipt: ${refusal}`
  const verdict = `failed — ${[...line].slice(0, 99).join("")}…`
  expect(setupVerdict(verdict)).toEqual({ fault: "user", message: refusal })
  expect(runFailureOf({ workflow: "repository/setup", error: verdict })).toMatchObject({ fault: "user", message: refusal })
})

test("every setup refusal long enough for the gateway to clip is told apart by what survives the clip", () => {
  const long = [...SETUP_REFUSALS].filter((refusal) => [...`invalid_receipt: ${refusal}`].length > 99)
  for (const refusal of long) {
    const kept = [...`invalid_receipt: ${refusal}`].slice(0, 99).join("").slice("invalid_receipt: ".length)
    expect([...SETUP_REFUSALS].filter((other) => other.startsWith(kept))).toEqual([refusal])
  }
})

/* Literal public copy and blame per setup receipt code; nothing here is read from the classifier under test. */
const setupCodes = [
  { code: "invalid_plan", fault: "bug", message: "That's a bug in Smithers, not something you did." },
  { code: "invalid_request", fault: "user" }, { code: "fast_gate", fault: "user" }, { code: "stale_revision", fault: "user" },
  { code: "check_infra", fault: "infra", message: INFRA },
  { code: "invalid_receipt", fault: "infra", message: INFRA },
  { code: "unavailable", fault: "dependency", message: "Something Smithers depends on failed. Not your doing." },
  { code: "execution", fault: "infra", message: INFRA },
  { code: "source_missing", fault: "user" }, { code: "source_changed", fault: "user" }, { code: "source_refused", fault: "user" },
  { code: "source_unavailable", fault: "dependency", message: "Something Smithers depends on failed. Not your doing." },
  { code: "declined", fault: "user" }, { code: "stalled", fault: "user" }
] as const

test("setup receipt codes have literal blame and copy on both settled and journalled surfaces", () => {
  expect(setupCodes.map(row => row.code).sort()).toEqual([...RECEIPT_CODES].sort())
  for (const row of setupCodes) {
    for (const sentence of [TRIAL, "Something the engine wrote"]) {
      const user = row.fault === "user" || row.code === "invalid_receipt" && sentence === TRIAL
      const fault = user ? "user" : row.fault
      const message = user ? sentence : "message" in row ? row.message : sentence
      const verdict = `failed — ${row.code}: ${sentence}`
      expect(setupVerdict(verdict)).toEqual({ fault, message })
      expect(runFailureOf({ workflow: "repository/setup", error: verdict, events: journal(`${row.code}: ${sentence}`) }))
        .toEqual({ fault, message, detail: user ? `${row.code}: ${sentence}` : verdict })
    }
  }
})

/* The harness's and the model's worded codes, with the copy a person reads for each. */
const stampedCauses = [
  { tag: HARNESS("assembly_failed"), fault: "infra", message: "This run couldn't be assembled, so no turn ever opened. Not your fault — that's a defect here." },
  { tag: HARNESS("incompatible_journal"), fault: "infra", message: "This run's record was written by a different version of Smithers and can't be read back. Not your fault — start a new run." },
  { tag: HARNESS("render_failed"), fault: "bug", message: "Smithers couldn't build the next turn to send. Not your fault, and not your request's — that's a defect here." },
  { tag: HARNESS("model_failed"), fault: "infra", message: "A turn opened and the model never answered, so the run stopped with no result. Not your fault — the turns it finished stand, and it's worth asking again." },
  { tag: HARNESS("engine_failed"), fault: "infra", message: "The engine underneath this run failed before a turn could finish, so the run stopped. Not your fault, and the turns it finished stand; it's worth starting it again." },
  { tag: HARNESS("read_only_cap"), fault: "policy", message: "This run read for turn after turn without changing anything, so Smithers stopped it. Not your fault — it's worth asking again." },
  { tag: HARNESS("completion_unjudged"), fault: "infra", message: "The run finished, but nothing was able to check its answer, so Smithers didn't pass it on. Not your fault — it's worth asking again." },
  { tag: HARNESS("claim_unproven"), fault: "infra", message: "The run claimed work its own record doesn't show it doing, so Smithers refused the answer rather than pass it on. Not your fault — ask again and it has to show the work." },
  { tag: HARNESS("suspended"), fault: "infra", message: "The run stopped to wait for something that never came. Not your fault — it's worth starting it again." },
  { tag: "flows/model/ModelError/context_overflow", fault: "user", message: "The conversation outgrew the model's context window. Not your fault — start a fresh run." },
  { tag: "flows/model/ModelError/no_route", fault: "infra", message: "No model seat was available for this run. Not your fault — it's a setting on Smithers' side." },
  { tag: "flows/model/ModelError/authentication", fault: "user", message: "The model provider rejected the sign-in. Sign in again, then run it again." },
  { tag: "flows/model/ModelError/quota_exceeded", fault: "wait", message: "The model account is out of credit, so the run stopped where it was. Not your fault — it can run again once the account has credit." },
  { tag: "flows/model/ModelError/out_of_credit", fault: "user", message: "The hosted credit is spent, so the run stopped where it was. Add credit, then run it again." },
  { tag: "flows/model/ModelError/content_policy", fault: "user", message: "The model provider refused this request under its content policy. Ask for something else." },
  { tag: "flows/model/ModelError/provider_internal", fault: "dependency", message: "The model provider failed on its own side. Not your doing — it's worth asking again." },
  { tag: "flows/model/ModelError/transport", fault: "dependency", message: "The call to the model provider never completed. Not your doing — it's worth asking again." },
  { tag: "flows/model/ModelError/call_timeout", fault: "infra", message: "A model call ran past the time this run allows and was cut off, so nothing came back from it. Not your fault — asking for something shorter usually gets through." },
  { tag: "flows/model/ModelError/invalid_provider_output", fault: "dependency", message: "The model provider answered with something Smithers couldn't read. Not your doing — it's worth asking again." }
] as const satisfies ReadonlyArray<{ tag: string; fault: PlueFault; message: string }>

test("every stamped harness and model code reaches a person as its own sentence on the journal, the row and the settled verdict", () => {
  for (const row of stampedCauses) {
    const code = row.tag.slice(row.tag.lastIndexOf("/") + 1)
    const cause = `${code}: whatever the host wrote`
    const verdict = `failed — ${cause}`
    const failure = stamp(row.tag, row.fault)
    expect(runCause(row.tag)).toBe(row.message)
    expect(runFailureOf({ workflow: LATE_FLOW, error: verdict, events: journal(cause, failure) }))
      .toEqual({ fault: row.fault, message: row.message, detail: cause })
    expect(runFailureOf({ workflow: LATE_FLOW, error: verdict, failure }))
      .toEqual({ fault: row.fault, message: row.message, detail: verdict })
    expect(runFailureOf({ workflow: LATE_FLOW, error: verdict, events: [], failure }))
      .toEqual({ fault: row.fault, message: row.message, detail: verdict })
  }
})

test("a code spelled by another author never takes a harness or model sentence", () => {
  for (const code of ["model_failed", "transport", "claim_unproven"]) {
    for (const author of ["coding/Error", "@smthrs/jj/JjError", "@smthrs/std/StdError"]) {
      const tag = `${author}/${code}`
      expect(runCause(tag)).toBeUndefined()
      expect(runFailureOf({ workflow: LATE_FLOW, failure: stamp(tag, "bug") }))
        .toEqual({ fault: "bug", message: REFUSAL_COPY.bug.lead, detail: "" })
    }
  }
})

test("the latest failed event wins over a conflicting persisted verdict and unrelated later events", () => {
  const stale = stamp(HARNESS("suspended"), "infra")
  const live = stamp("flows/model/ModelError/context_overflow", "user")
  const events = [
    ...journal("suspended: Earlier failure", stale),
    { sequence: 2, kind: "control.run.failed", payload: { cause: "context_overflow: Raw provider detail\r\nPRIVATE-STACK", fault: live } },
    { sequence: 3, kind: "control.run.completed", payload: { cause: "transport: Ignore unrelated cause", fault: stamp("flows/model/ModelError/transport", "dependency") } }
  ]
  const failure = runFailureOf({ workflow: LATE_FLOW, error: "failed — transport: Old network failure", events })
  expect(failure).toEqual({ fault: "user", message: runCause(live.tag)!, detail: "context_overflow: Raw provider detail" })
  expect(JSON.stringify(failure)).not.toContain("PRIVATE-STACK")
  /* The setup bridge reads the newest failed pair the same way. */
  const setupEvents = [
    ...journal("stale_revision: Earlier revision moved"),
    { sequence: 2, kind: "control.run.failed", payload: { cause: "execution: Host stopped\r\nPRIVATE-STACK" } },
    { sequence: 3, kind: "control.run.completed", payload: { cause: "stale_revision: Ignore unrelated cause" } }
  ]
  const error = "failed — stale_revision: Saved older verdict"
  expect(runFailureOf({ workflow: "repository/setup", error, events: setupEvents })).toEqual({ fault: "infra", message: INFRA, detail: error })
})

test("an unknown journal code cannot inherit the cause from a conflicting known verdict", () => {
  const error = "failed — context_overflow: Older failure"
  expect(runFailureOf({ workflow: LATE_FLOW, error, events: journal("brand_new_code: Newest failure") })).toEqual({ fault: "infra", message: INFRA, detail: error })
  expect(runFailureOf({ workflow: LATE_FLOW, error, events: journal("An uncoded transport exception") })).toEqual({ fault: "infra", message: INFRA, detail: error })
  /* On the setup bridge an unknown journal pair defers to the settled row, never to a known-code guess. */
  expect(runFailureOf({ workflow: "repository/setup", error: "failed — brand_new_code: Older", events: journal("stale_revision: Newest") }))
    .toEqual({ fault: "user", message: "Newest", detail: "stale_revision: Newest" })
})

test.each(["not-json", "null", "[]", "{}", "17", '"plain error"'])("uncoded serialized error %s retains evidence without inferred blame", raw => {
  expect(runFailure(raw)).toEqual({ fault: "infra", message: INFRA, detail: raw })
})

test("setup refusal matching is exact and excludes private later lines", () => {
  expect(setupVerdict(`failed — invalid_receipt: ${TRIAL}\r\nPRIVATE-DETAIL`)).toEqual({ fault: "user", message: TRIAL })
  expect(runFailureOf({ workflow: "repository/setup", error: "saved verdict", events: journal(`invalid_receipt: ${TRIAL}.\nPRIVATE-DETAIL`) }))
    .toEqual({ fault: "infra", message: INFRA, detail: "saved verdict" })
  expect(setupFailureSentence("failed — invalid_receipt: Job input does not match its registered responsibility or candidate"))
    .toBe("This run doesn't match the configuration this job has registered. Apply the current draft, then run it again.")
})

test.each([
  ["Setup input must match the reviewed candidate digest", "This setup changed after it was reviewed. Test this draft again, then apply it."],
  ["Job input does not match its registered responsibility or candidate", "This run doesn't match the configuration this job has registered. Apply the current draft, then run it again."]
])("journalled setup refusal %s carries actionable copy and its original evidence", (sentence, message) => {
  expect(runFailureOf({ workflow: "repository/setup", error: "older saved verdict", events: journal(`invalid_receipt: ${sentence}\nPRIVATE-DETAIL`) }))
    .toEqual({ fault: "user", message, detail: `invalid_receipt: ${sentence}` })
})
