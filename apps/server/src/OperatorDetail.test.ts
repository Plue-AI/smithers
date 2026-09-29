import { expect, test } from "bun:test"
import { Effect } from "effect"
import * as Cause from "effect/Cause"
import { WORKER_REFUSAL_COPY } from "@smthrs/rpc/RefusalCopy"
import { serveRequest } from "./Boundary"
import { cloudTokenResponse, CLOUD_TOKEN_UNAVAILABLE } from "./cloudToken"
import type { CloudTokenOutcome } from "./cloudToken"
import {
  OUTPUT_FAILURE_SENTENCE,
  OutputFrameInvalid,
  OutputInterrupted,
  OutputLimitReached,
  OutputStorageLost,
  outputFailureSentence
} from "./DurableTurn"
import { BodyNotJson, BodyTooLarge, BodyUnreadable, StorageFailure, UpstreamTimeout, UpstreamUnreachable } from "./Failures"
import { jevFailureDetail, jevFailureMessage } from "./recommend"
import type { JevAnswer } from "./jev"
import {
  BODY_UNREADABLE,
  bodyRefusal,
  notConfigured,
  routeRefusal,
  STORAGE_FAILED,
  storageFailureAnswer,
  storageRefusal,
  upstreamUnreachable
} from "./Responses"
import { JournalRefusal } from "./TurnJournal"
import { DeployGuardRefusal } from "../scripts/deployGuard"

/*
 * A refusal body reaches the reader verbatim (packages/rpc/src/Refusal.ts
 * renders `message` as the Worker's own words). So the body holds one fixed
 * sentence and every piece of operator evidence (a native cause, an unset
 * variable, a storage operation, an HTTP status) is on the log line only.
 */

const SECRET = "ECONNRESET at tls.connect (node:internal/stack:42) IDENTITY_SERVICE_TOKEN"

const capture = async (run: () => Promise<void>) => {
  const lines: string[] = [], original = console.error
  console.error = (...args: unknown[]) => { lines.push(args.map(String).join(" ")) }
  try { await run() } finally { console.error = original }
  return lines.map(line => JSON.parse(line) as Record<string, unknown>)
}

/** Serve one response through the real boundary: its body, and the refusal log line it wrote. */
const served = async (make: () => Response) => {
  let body: Record<string, unknown> = {}
  const lines = await capture(async () => {
    const response = await serveRequest(new Request("https://app.test/api/x"), Effect.sync(make))
    body = await response.json() as Record<string, unknown>
  })
  return { body, log: lines.find(line => line.event === "worker_refusal") }
}

const expectClean = (body: Record<string, unknown>) => {
  const text = JSON.stringify(body)
  for (const leak of ["ECONNRESET", "node:internal", "IDENTITY_SERVICE_TOKEN", "_API_KEY", "is unset", "ms.", "Error:"]) {
    expect(text).not.toContain(leak)
  }
}

test("an unreadable body answers a fixed sentence and logs the native cause", async () => {
  const { body, log } = await served(() => bodyRefusal(new BodyUnreadable({ cause: new Error(SECRET) })))
  expect(body).toEqual({ status: "error", code: "request_body_unreadable", message: BODY_UNREADABLE })
  expect(log?.cause).toContain("ECONNRESET")
})

test("the other body refusals keep their own fixed sentences", async () => {
  expect((await served(() => bodyRefusal(new BodyTooLarge({ limit: 1 })))).body.message).toBe("Request body is too large.")
  expect((await served(() => bodyRefusal(new BodyNotJson({ cause: new Error(SECRET) })))).body.message).toBe("Request body must be valid JSON.")
})

test("an upstream timeout names the service, not its deadline, and logs the seam", async () => {
  const { body, log } = await served(() => upstreamUnreachable("Smithers Cloud", new UpstreamTimeout({ seam: "Smithers Cloud", timeoutMs: 8000 })))
  expect(body.code).toBe("upstream_timeout")
  expect(body.message).toBe("Smithers Cloud took too long to answer. Try again in a moment.")
  expectClean(body)
  expect(log?.cause).toContain("UpstreamTimeout(Smithers Cloud)")
})

test("an unreachable upstream never carries its connection error to the reader", async () => {
  const { body, log } = await served(() => upstreamUnreachable("The model service", new UpstreamUnreachable({ seam: "model", cause: new Error(SECRET) })))
  expect(body.code).toBe("upstream_unreachable")
  expect(body.message).toBe("The model service can't be reached right now. Try again in a moment.")
  expectClean(body)
  expect(log?.cause).toContain("ECONNRESET")
})

test("a missing deployment variable is named in the log, never in the body", async () => {
  const { body, log } = await served(() => notConfigured("Sign-in", "IDENTITY_UPSTREAM_URL is unset. Sign-in is unavailable"))
  expect(body.code).toBe("deployment_not_configured")
  expect(body.message).toBe("Sign-in isn't set up on this deployment.")
  expect(JSON.stringify(body)).not.toContain("IDENTITY_UPSTREAM_URL")
  expect(log).toMatchObject({ fault: "infra", seam: "Sign-in", cause: "IDENTITY_UPSTREAM_URL is unset. Sign-in is unavailable" })
})

test("a route storage failure answers the fixed sentence and logs the operation", async () => {
  const { body, log } = await served(() => storageRefusal(new StorageFailure({ operation: "journal put", cause: new Error(SECRET) })))
  expect(body).toMatchObject({ code: "storage_failed", message: STORAGE_FAILED })
  expectClean(body)
  expect(log).toMatchObject({ seam: "journal put" })
  expect(String(log?.cause)).toContain("ECONNRESET")
})

test("a Durable Object storage failure writes a seam line and a fixed body", async () => {
  let response: Response | undefined
  const lines = await capture(async () => {
    response = storageFailureAnswer("turn limits", new StorageFailure({ operation: "spend", cause: new Error(SECRET) }))
  })
  expect(response?.status).toBe(500)
  const body = await response!.json() as Record<string, unknown>
  expect(body).toEqual({ status: "error", code: "storage_failed", message: STORAGE_FAILED })
  expectClean(body)
  expect(lines).toEqual([{ event: "worker_seam_failure", seam: "turn limits", cause: expect.stringContaining("ECONNRESET") }])
})

const tokenCases: ReadonlyArray<Exclude<CloudTokenOutcome, { readonly status: "ok" }>> = [
  { status: "not_configured", detail: "IDENTITY_SERVICE_TOKEN is unset on this deployment." },
  { status: "unavailable", detail: `The identity service is unreachable: ${SECRET}` },
  { status: "not_found", detail: "No Smithers Cloud identity is available for this account (suspended: internal)." }
]

for (const outcome of tokenCases) {
  test(`a Cloud token outcome ${outcome.status} answers one sentence and logs its detail`, async () => {
    const { body, log } = await served(() => cloudTokenResponse(outcome))
    expect(body).toMatchObject({ code: "cloud_token_unavailable", message: CLOUD_TOKEN_UNAVAILABLE })
    expectClean(body)
    expect(String(body.message)).not.toContain(outcome.status)
    expect(log).toMatchObject({ seam: "cloud token", cause: `${outcome.status}: ${outcome.detail}`.slice(0, 500) })
  })
}

test("a Cloud token eligibility refusal keeps the allowlist code and its written copy", async () => {
  const { body } = await served(() => cloudTokenResponse({ status: "not_eligible", detail: "Smithers Cloud has not let this account in yet (NOT_ON_WAITLIST)." }))
  expect(body).toMatchObject({ code: "account_not_allowlisted", message: WORKER_REFUSAL_COPY.account_not_allowlisted.lead })
})

test("a route refusal keeps its headers, logs its detail, and leaves Plue's out_of_credit unmarked", async () => {
  const { body, log } = await served(() => routeRefusal("seam_not_configured", "Decisions aren't available on this deployment.", { "x-a": "1" }, { seam: "jev", cause: "AI_GATEWAY_API_KEY is unset" }))
  expect(body).toEqual({ status: "error", code: "seam_not_configured", message: "Decisions aren't available on this deployment." })
  expect(log).toMatchObject({ seam: "jev", cause: "AI_GATEWAY_API_KEY is unset" })
  const response = routeRefusal("seam_not_configured", "x", { "x-a": "1" })
  expect(response.headers.get("x-a")).toBe("1")
  expect(response.status).toBe(503)
  const credit = await served(() => routeRefusal("out_of_credit", "Out of credit.", {}))
  expect(credit.log).toBeUndefined()
  expect(credit.body.code).toBe("out_of_credit")
})

const jevCases: ReadonlyArray<[Exclude<JevAnswer, { readonly ok: true }>, string]> = [
  [{ ok: false, reason: "http", status: 429 }, "http 429"],
  [{ ok: false, reason: "http", status: 502 }, "http 502"],
  [{ ok: false, reason: "empty" }, "empty"],
  [{ ok: false, reason: "timeout" }, "timeout"],
  [{ ok: false, reason: "unreachable", message: SECRET }, SECRET],
  [{ ok: false, reason: "out_of_credit" }, "out_of_credit"]
]

for (const [answer, cause] of jevCases) {
  test(`a Jev ${answer.reason} failure has a plain sentence and its evidence only in the detail`, () => {
    const sentence = jevFailureMessage(answer)
    expect(sentence).not.toMatch(/Jev|HTTP|\d{3}|ms\b|ECONNRESET/)
    expect(jevFailureDetail(answer)).toEqual({ seam: "jev", cause })
  })
}

test("a rate-limited Jev and a refusing Jev read differently", () => {
  expect(jevFailureMessage({ ok: false, reason: "http", status: 429 })).not.toBe(jevFailureMessage({ ok: false, reason: "http", status: 500 }))
})

test("each output failure variant ends a recorded turn with its own sentence", () => {
  expect(outputFailureSentence(new OutputLimitReached())).toBe(OUTPUT_FAILURE_SENTENCE.OutputLimitReached)
  expect(outputFailureSentence(new OutputStorageLost({ cause: SECRET }))).toBe(OUTPUT_FAILURE_SENTENCE.OutputStorageLost)
  expect(outputFailureSentence(new OutputInterrupted({ cause: new Error(SECRET) }))).toBe(OUTPUT_FAILURE_SENTENCE.OutputInterrupted)
  expect(outputFailureSentence(new OutputFrameInvalid({ cause: new SyntaxError(SECRET) }))).toBe(OUTPUT_FAILURE_SENTENCE.OutputFrameInvalid)
  expect(new Set(Object.values(OUTPUT_FAILURE_SENTENCE)).size).toBe(4)
  for (const sentence of Object.values(OUTPUT_FAILURE_SENTENCE)) expect(sentence).not.toContain("ECONNRESET")
})

test("an unknown output failure ends the turn with the storage sentence, never its message", () => {
  for (const unknown of [new Error(SECRET), SECRET, { _tag: "Other", message: SECRET }, null, Cause.fail(SECRET)]) {
    expect(outputFailureSentence(unknown)).toBe(OUTPUT_FAILURE_SENTENCE.OutputStorageLost)
  }
})

test("the journal and deploy guard refusals are tagged errors that keep their messages", () => {
  const journal = new JournalRefusal({ reason: "corrupt" })
  expect(journal._tag).toBe("JournalRefusal")
  expect(journal.reason).toBe("corrupt")
  expect(journal.message).toBe("Turn journal corrupt.")
  const guard = new DeployGuardRefusal({ code: "DEPLOY_GUARD_LIVE_CHANGED", detail: "moved" })
  expect(guard._tag).toBe("DeployGuardRefusal")
  expect(guard).toBeInstanceOf(Error)
  expect(guard.message).toBe("DEPLOY_GUARD_LIVE_CHANGED: moved")
  expect(() => { throw guard }).toThrow(DeployGuardRefusal)
})
