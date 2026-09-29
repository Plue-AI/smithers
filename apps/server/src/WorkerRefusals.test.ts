import { describe, expect, test } from "bun:test"
import * as Exit from "effect/Exit"
import { refusalOf } from "@smthrs/rpc/Refusal"
import type { Refusal } from "@smthrs/rpc/Refusal"
import { INFRA_NOT_YOUR_FAULT, refusalLead } from "@smthrs/rpc/RefusalCopy"
import { WORKER_FAILURE_CODES, WORKER_FAILURES } from "@smthrs/rpc/WorkerFailureCodes"
import type { WorkerFailureCode } from "@smthrs/rpc/WorkerFailureCodes"
import { responseFromExit } from "./Boundary"
import { BodyNotJson, BodyTooLarge, BodyUnreadable, UpstreamTimeout, UpstreamUnreachable } from "./Failures"
import {
  bodyRefusal,
  methodNotAllowed,
  notConfigured,
  notFound,
  refuse,
  refuseWithStatus,
  upstreamFailureCode,
  upstreamUnreachable
} from "./Responses"
import { ANONYMOUS_CEILING, turnLimitResponse } from "./turnLimit"

/*
 * The Worker's OWN refusals — the ones plue never sees. Until they carried a
 * code, the app could only tell them apart by reading English, and the one
 * that matters most (this deployment is missing a secret) read to a person as
 * the one thing it is not: a full fleet.
 *
 * Every test here reads the answer back through the app's own classifier
 * (@smthrs/rpc/Refusal), because that is the only thing that proves the wire
 * is enough: a code the Worker writes and the app cannot resolve is worth
 * nothing.
 */

/** The refusal the app would build from this response, exactly as CloudClient does. */
const classify = async (response: Response): Promise<Refusal> => {
  const body: unknown = await response.json().catch(() => null)
  const message = typeof body === "object" && body !== null && typeof (body as { message?: unknown }).message === "string"
    ? (body as { message: string }).message
    : `HTTP ${response.status}`
  const header = Number(response.headers.get("retry-after") ?? "")
  return refusalOf({
    body,
    status: response.status,
    message,
    retryAfterSeconds: Number.isInteger(header) && header > 0 ? header : null
  })
}

describe("every refusal the Worker writes itself", () => {
  test("answers the status its code names, so a route and the registry cannot drift", async () => {
    for (const code of WORKER_FAILURE_CODES) {
      const response = refuse(code, "a sentence the seam wrote")
      expect(response.status).toBe(WORKER_FAILURES[code].status)
      const refusal = await classify(response)
      expect(refusal.code).toBe(code)
      expect(refusal.fault).toBe(WORKER_FAILURES[code].fault)
      expect(refusal.origin).toBe("worker")
      expect(refusal.message).toBe("a sentence the seam wrote")
    }
  })

  test("states a wait it can pace, on the header and in the body, and nothing it cannot", async () => {
    for (const code of WORKER_FAILURE_CODES) {
      const refusal = await classify(refuse(code, "x"))
      const pacing = WORKER_FAILURES[code].retryAfter
      expect(refusal.retryAfter).toBe(pacing > 0 ? pacing : null)
    }
    expect(refuse("error_reports_throttled", "x").headers.get("retry-after")).toBe("60")
    expect(refuse("route_not_found", "x").headers.get("retry-after")).toBeNull()
  })

  test("keeps an upstream's own status when the status is that upstream's evidence", async () => {
    const refusal = await classify(
      refuseWithStatus(429, "model_rate_limited", "The model service is rate-limiting this deployment.", {
        retryAfterSeconds: 12
      })
    )
    expect(refusal.status).toBe(429)
    expect(refusal.code).toBe("model_rate_limited")
    expect(refusal.fault).toBe("dependency")
    expect(refusal.retryAfter).toBe(12)
  })

  test("the canonical answers carry their documented code", async () => {
    expect((await classify(notFound())).code).toBe("route_not_found")
    expect((await classify(methodNotAllowed())).code).toBe("method_not_allowed")
    expect((await classify(upstreamUnreachable("The identity service", new UpstreamTimeout({
      seam: "The identity service",
      timeoutMs: 20
    })))).code).toBe("upstream_timeout")
    expect((await classify(upstreamUnreachable("The identity service", new UpstreamUnreachable({
      seam: "The identity service",
      cause: new Error("connection refused")
    })))).code).toBe("upstream_unreachable")
  })

  test("a body refusal names which of the three ways a body failed", async () => {
    expect((await classify(bodyRefusal(new BodyTooLarge({ limit: 10 })))).code).toBe("request_body_too_large")
    expect((await classify(bodyRefusal(new BodyNotJson({ cause: new Error("x") })))).code).toBe("request_body_not_json")
    expect((await classify(bodyRefusal(new BodyUnreadable({ cause: new Error("x") })))).code).toBe(
      "request_body_unreadable"
    )
  })

  test("the error boundary's own two answers are coded, not only the routes'", async () => {
    const disconnected = await classify(responseFromExit(Exit.interrupt(1)))
    expect(disconnected.status).toBe(499)
    expect(disconnected.code).toBe("client_disconnected")
    /* The 500 a defect earns: a bug, and never dressed as the user's problem. */
    const console_error = console.error
    console.error = () => {}
    try {
      const defect = await classify(responseFromExit(Exit.die(new Error("boom"))))
      expect(defect.code).toBe("unexpected_failure")
      expect(defect.fault).toBe("bug")
    } finally {
      console.error = console_error
    }
  })

  test("a spent turn budget is a wait, not a fault of the person who spent it", async () => {
    const refusal = await classify(
      turnLimitResponse({ allowed: false, remaining: 0, retryAt: Date.now() + 60_000 }, {}, ANONYMOUS_CEILING)
    )
    expect(refusal.code).toBe("turn_rate_limited")
    expect(refusal.fault).toBe("wait")
    expect(refusalLead(refusal)).not.toContain("@fucory")
  })
})

describe("the misconfigured deployment", () => {
  /*
   * The refusal this change exists for. It is INFRA — the person reading it
   * did nothing — and it is NOT the infra the product owner's line describes.
   * Nothing ran out; a value was never set, and the only person who can fix it
   * is whoever deployed this.
   */
  test("is infra, and says the honest thing rather than the capacity line", async () => {
    const refusal = await classify(notConfigured("The chat seam", "SMITHERS_CHAT_URL"))
    expect(refusal.status).toBe(501)
    expect(refusal.code).toBe("deployment_not_configured")
    expect(refusal.fault).toBe("infra")
    expect(refusal.origin).toBe("worker")
    expect(refusal.message).toBe("The chat seam isn't set up on this deployment.")
    const lead = refusalLead(refusal)
    expect(lead).toBe(
      "This deployment of Smithers isn't fully set up. Not your fault — and not something you can fix from here; whoever deployed it has to finish wiring it."
    )
    expect(lead).not.toBe(INFRA_NOT_YOUR_FAULT)
    expect(lead).not.toContain("@fucory")
    expect(lead).not.toContain("ran out")
  })

  test("is what an upstream refusing this deployment's own credential is, too", () => {
    expect(upstreamFailureCode(401)).toBe("deployment_not_configured")
    expect(upstreamFailureCode(403)).toBe("deployment_not_configured")
    expect(WORKER_FAILURES[upstreamFailureCode(401)].fault).toBe("infra")
    /* And the rate limit above it is the provider's, so it stays a dependency. */
    expect(upstreamFailureCode(429)).toBe("model_rate_limited")
    expect(WORKER_FAILURES[upstreamFailureCode(429)].fault).toBe("dependency")
    expect(upstreamFailureCode(500)).toBe("upstream_refused")
  })

  test("no Worker refusal at all borrows the capacity line", async () => {
    for (const code of WORKER_FAILURE_CODES satisfies ReadonlyArray<WorkerFailureCode>) {
      expect(refusalLead(await classify(refuse(code, "x")))).not.toContain("@fucory")
    }
  })
})
