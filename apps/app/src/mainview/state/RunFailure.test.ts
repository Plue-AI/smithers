import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { RECEIPT_CODES, runFailure, runFailureOf, SETUP_REFUSAL_COPY, SETUP_REFUSALS, setupFailureSentence, setupVerdict } from "./RunFailure"
import { ANSWERED_CODES, runCause } from "./RunCause"
import { librarianFailureMessage } from "./LibrarianLaunch"

const INFRA = "Something on Smithers' side failed. Not your fault, and nothing your request could have changed."
// Formatting may wrap the call, but the emitted argument must remain exact.
const invalidCall = (argument: string): RegExp =>
  new RegExp(`\\binvalid\\(\\s*${argument.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\)`)
/* One of the sentences flows/repository/triggers.ts refuses a registration with. */
const REFUSAL = 'Add a model to "nightly-lint" to schedule it.'
const VERDICT = `failed — invalid_receipt: ${REFUSAL.slice(0, 20)}`
const journal = (cause: string) => [{ sequence: 1, kind: "control.run.failed", runId: "run-1", occurredAt: 1, payload: { runId: "run-1", status: "failed", cause } }]

test("uncoded execution errors use infra copy and retain the complete raw detail", () => {
  const raw = "failed — Error: Error: git exited 1"
  expect(runFailure(raw)).toEqual({ fault: "infra", message: "Something on Smithers' side failed. Not your fault, and nothing your request could have changed.", detail: raw })
  expect(librarianFailureMessage(raw)).toBe(`Create Mythical history didn't start: ${runFailure(raw).message}`)
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
    ["librarian/history", "Native main retention returned an invalid receipt"],
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
  expect(runFailureOf({ workflow: "repository/trigger", error: VERDICT, events: [] })).toEqual({ fault: "infra", message: INFRA, detail: VERDICT })
  expect(runFailureOf({ workflow: "repository/trigger", error: VERDICT })).toEqual({ fault: "infra", message: INFRA, detail: VERDICT })
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
  for (const workflow of ["coding/request", "librarian/history", "repository-jobs/issues", "repository/Setup"]) {
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

test("a run that died late names what happened, and never in the harness's own words", () => {
  for (const cause of [EXHAUSTED, UNPROVEN]) {
    const failure = runFailureOf({ workflow: LATE_FLOW, error: `failed — ${cause.slice(0, 100)}`, events: journal(cause) })
    expect(failure.message).not.toBe(INFRA)
    expect(failure.message).not.toContain("run-7f3a")
    expect(failure.message).not.toContain("frames")
    expect(failure.message).not.toContain("invented")
    expect(failure.detail).toBe(cause)
  }
  /* The brake's two halves mean different things since 46fcc61722f5, so they read differently. */
  const unproven = runFailureOf({ workflow: LATE_FLOW, error: "", events: journal(UNPROVEN) })
  const unjudged = runFailureOf({ workflow: LATE_FLOW, error: "", events: journal("completion_unjudged: A completion no evaluator could judge (transport): 503") })
  expect(unproven.message).not.toBe(unjudged.message)
  for (const failure of [unproven, unjudged]) expect(failure.message).toContain("Not your fault")
})

/*
 * Four real failures, verbatim from the packages that raise them, none of
 * which is a model call. `failureSummary` walks to the innermost record that
 * has a `message` and prefixes THAT record's code, so a `JjError`, a sandbox
 * `ProviderError`, a `SyncError`, a `CodingError` and a std `StdError` all
 * reach this file as a first line that looks exactly like the model's.
 */
const FOREIGN = [
  /* flows/jj/src/node/NodeJj.ts:226 — @smthrs/jj/JjError */
  "unknown: jj describe: cannot run in /gone: not a directory",
  /* flows/sandbox/src/internal/execSession.ts:189 — @smthrs/sandbox/RemoteChildProcessSpawner/ProviderError */
  "unknown: unrecognized process",
  /* flows/sync/src/internal/ShareSigner.ts:97 — @smthrs/sync/SyncError */
  "unknown: Web Crypto could not import the HMAC signing key",
  /* flows/coding/native.ts:56 — coding/Error */
  "invalid_request: Native coding request exceeds its bounded payload size",
  /* agent/std/src/ExaWebSearch.ts:102 — @smthrs/std/StdError */
  "rate_limited: Exa search was throttled; retry after 30 seconds"
]

test("a code another vocabulary also spells is never told a model call failed", () => {
  for (const cause of FOREIGN) {
    const error = `failed — ${cause.slice(0, 100)}`
    for (const failure of [runFailureOf({ workflow: LATE_FLOW, error, events: journal(cause) }), runFailureOf({ workflow: LATE_FLOW, error })]) {
      expect(failure.message).toBe(INFRA)
      expect(failure.message).not.toContain("model")
      expect(failure.fault).toBe("infra")
    }
  }
})

test("every code the harness and the model can journal reaches a person as its own sentence", () => {
  for (const code of ANSWERED_CODES) {
    const answered = runCause(code)!
    expect(runFailureOf({ workflow: LATE_FLOW, error: `failed — ${code}: whatever the host wrote`, events: journal(`${code}: whatever the host wrote`) }))
      .toEqual({ fault: answered.fault, message: answered.message, detail: `${code}: whatever the host wrote` })
  }
})

/*
 * The run this lane was opened for could not be read at all: teardown deleted
 * the workspace, and the journal is a live read against it
 * (workflow-pump.ts `readJournalPages` -> `gateway.runEvents`). The verdict is
 * not — it is `<phase> — <first journal line clipped to 100>`, persisted on the
 * card, and it carries the same code.
 */
test("the sentence survives the workspace the journal died with", () => {
  for (const code of ANSWERED_CODES) {
    const answered = runCause(code)!
    const verdict = `failed — ${code}: whatever the host wrote`
    expect(runFailureOf({ workflow: LATE_FLOW, error: verdict }))
      .toEqual({ fault: answered.fault, message: answered.message, detail: verdict })
    expect(runFailureOf({ workflow: LATE_FLOW, error: verdict, events: [] }))
      .toEqual({ fault: answered.fault, message: answered.message, detail: verdict })
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
