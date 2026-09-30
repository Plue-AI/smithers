import { describe, expect, test } from "vitest"
import { PLUE_FAILURE_CODES, PLUE_FAILURES } from "../src/PlueFailureCodes.ts"
import {
  faultOfStatus,
  isWorkerFailureCode,
  mayAutoRetry,
  refusalCode,
  refusalEntry,
  refusalFromStored,
  refusalOf,
  storedRefusal,
  workerRefusalEnvelope
} from "../src/Refusal.ts"
import {
  agentFaultNote,
  agentRefusalText,
  INFRA_NOT_YOUR_FAULT,
  refusalDoors,
  refusalLead,
  refusalSentence,
  WORKER_REFUSAL_COPY
} from "../src/RefusalCopy.ts"
import { WORKER_FAILURE_CODES, WORKER_FAILURES, workerFailureCode } from "../src/WorkerFailureCodes.ts"
import { workerRefusal } from "./refusalFixtures.ts"

/*
 * The Cloudflare Worker's own refusals. plue's registry is generated and
 * vendored; this one is written by hand, and these are the properties that
 * keep the two from colliding, from drifting apart in shape, or from reaching
 * a person with a sentence nobody wrote for them.
 */
describe("the Worker's own failure registry", () => {
  test("shares no code with plue's, which is what lets one string name its author", async () => {
    const shared = WORKER_FAILURE_CODES.filter((code) => Object.hasOwn(PLUE_FAILURES, code))
    expect(shared).toEqual([])
  })

  test("stays sorted and free of duplicates, so a new code lands in one obvious place", async () => {
    expect([...WORKER_FAILURE_CODES]).toEqual([...new Set(WORKER_FAILURE_CODES)].sort())
  })

  test("answers the same three questions per row as plue's", async () => {
    for (const code of WORKER_FAILURE_CODES) {
      const entry = WORKER_FAILURES[code]
      expect(Object.keys(entry).sort()).toEqual(["fault", "retryAfter", "status"])
      expect(PLUE_FAILURES[PLUE_FAILURE_CODES[0]].fault).toBeTypeOf("string")
      expect(entry.status).toBeGreaterThanOrEqual(400)
      expect(entry.retryAfter).toBeGreaterThanOrEqual(0)
    }
  })

  test("names a written lead for every code — an unwritten one does not compile, and is not blank either", async () => {
    for (const code of WORKER_FAILURE_CODES) {
      expect(WORKER_REFUSAL_COPY[code].lead.trim()).not.toBe("")
    }
    expect(Object.keys(WORKER_REFUSAL_COPY).sort()).toEqual([...WORKER_FAILURE_CODES])
  })

  test("reads a code back to its own table and never to plue's", async () => {
    for (const code of WORKER_FAILURE_CODES) {
      expect(workerFailureCode(code)).toBe(code)
      expect(refusalCode(code)).toBe(code)
      expect(isWorkerFailureCode(code)).toBe(true)
      expect(refusalEntry(code)).toEqual(WORKER_FAILURES[code])
    }
    expect(workerFailureCode("no_capacity")).toBeNull()
    expect(isWorkerFailureCode("no_capacity")).toBe(false)
  })
})

describe("a Worker refusal as it reaches the app", () => {
  test("carries the Worker's own code, its documented fault, and origin=worker", async () => {
    for (const code of WORKER_FAILURE_CODES) {
      const entry = WORKER_FAILURES[code]
      const refusal = refusalOf({ body: { status: "error", code }, status: entry.status, message: "nope" })
      expect(refusal.code).toBe(code)
      expect(refusal.rawCode).toBe(code)
      expect(refusal.fault).toBe(entry.fault)
      expect(refusal.origin).toBe("worker")
    }
  })

  test("the envelope takes status and pacing from the table, and the app reads back what it wrote", async () => {
    for (const code of WORKER_FAILURE_CODES) {
      const entry = WORKER_FAILURES[code]
      const envelope = workerRefusalEnvelope(code, "nope")
      const paced = entry.retryAfter > 0
      expect(envelope).toEqual({
        status: entry.status,
        body: { status: "error", code, message: "nope", ...(paced ? { retry_after: entry.retryAfter } : {}) },
        headers: paced ? { "retry-after": String(entry.retryAfter) } : {}
      })
      const built = await workerRefusal(code, "nope")
      expect({ status: built.status, fault: built.fault, origin: built.origin, retryAfter: built.retryAfter }).toEqual({
        status: entry.status,
        fault: entry.fault,
        origin: "worker",
        retryAfter: paced ? entry.retryAfter : null
      })
    }
  })

  test("the desktop host's envelope says local and carries the same pacing", async () => {
    const refusal = await workerRefusal("model_rate_limited", "slow down", { origin: "local" })
    expect({ origin: refusal.origin, retryAfter: refusal.retryAfter }).toEqual({ origin: "local", retryAfter: 60 })
  })

  test("a caller's status and stated wait win; null states no wait", () => {
    expect(workerRefusalEnvelope("upstream_refused", "x", { status: 409, retryAfterSeconds: null })).toEqual({
      status: 409,
      body: { status: "error", code: "upstream_refused", message: "x" },
      headers: {}
    })
    expect(workerRefusalEnvelope("model_rate_limited", "x", { retryAfterSeconds: 5 }).headers).toEqual({
      "retry-after": "5"
    })
  })

  test("survives a round trip through a card's stored shape", async () => {
    const refusal = await workerRefusal("deployment_not_configured", "CEREBRAS_API_KEY is unset.")
    expect(refusalFromStored(storedRefusal(refusal))).toEqual(refusal)
  })

  test("beats the status guess it used to get: a 501 is infra here, not the bug faultOfStatus reads", async () => {
    expect(faultOfStatus(501)).toBe("bug")
    expect((await workerRefusal("deployment_not_configured", "x")).fault).toBe("infra")
  })

  test("is never retried on a timer unless the Worker said to wait and said how long", async () => {
    for (const code of WORKER_FAILURE_CODES) {
      const refusal = await workerRefusal(code, "x")
      expect(mayAutoRetry(refusal)).toBe(WORKER_FAILURES[code].fault === "wait" && refusal.retryAfter !== null)
    }
  })
})

describe("what a person is told about a Worker refusal", () => {
  /*
   * The product owner's infra line names ONE failure: the fleet is full and
   * somebody has to buy more. No refusal the Worker writes is that failure —
   * `no_capacity` is plue's — so borrowing the sentence here would send a
   * reader to the wrong person about the wrong problem.
   */
  test("never borrows the capacity line for a failure that is not a full fleet", async () => {
    for (const code of WORKER_FAILURE_CODES) {
      const refusal = await workerRefusal(code, "x")
      expect(refusalLead(refusal)).not.toContain("@fucory")
      expect(agentRefusalText(refusal)).not.toContain("@fucory")
    }
  })

  test("a misconfigured deployment is infra, says so, and says the honest thing about it", async () => {
    const refusal = await workerRefusal("deployment_not_configured", "CHAT_URL is not configured on this deployment.")
    expect(refusal.fault).toBe("infra")
    const lead = refusalLead(refusal)
    expect(lead).toBe(
      "This deployment of Smithers isn't fully set up. Not your fault — and not something you can fix from here; whoever deployed it has to finish wiring it."
    )
    expect(lead).not.toBe(INFRA_NOT_YOUR_FAULT)
    expect(lead).not.toContain("ran out")
    expect(lead).toContain("Not your fault")
    /* The words the deployment wrote still reach the reader, underneath. */
    expect(refusalSentence(refusal)).toContain("CHAT_URL is not configured on this deployment.")
    const agent = agentRefusalText(refusal)
    expect(agent).toContain("fault=infra")
    expect(agent).toContain("origin=worker")
    expect(agent).toContain("do NOT say Smithers ran out of infra")
  })

  test("an absent seam gets the same audience and the same refusal to mention capacity", async () => {
    const refusal = await workerRefusal("seam_not_configured", "Repository actions need the identity seam.")
    expect(refusal.fault).toBe("infra")
    expect(refusalLead(refusal)).toContain("doesn't have the piece that answers this")
    expect(refusalLead(refusal)).not.toContain("ran out")
  })

  test("opens the doors each refusal actually has", async () => {
    expect(refusalDoors(await workerRefusal("sign_in_required", "x"))).toContain("sign-in")
    expect(refusalDoors(await workerRefusal("session_expired", "x"))).toContain("sign-in")
    expect(refusalDoors(await workerRefusal("route_not_found", "x"))).toEqual([])
    /* The report door stays carried and unattached: no surface renders it yet. */
    expect(refusalDoors(await workerRefusal("deployment_not_configured", "x"))).toContain("report")
    expect(refusalDoors(await workerRefusal("unexpected_failure", "x"))).toContain("report")
  })

  test("tells the chat model the fault class for a Worker code, not only a plue one", async () => {
    const note = agentFaultNote("deployment_not_configured — CHAT_URL is not configured on this deployment.")
    expect(note).toContain("[fault=infra code=deployment_not_configured]")
    expect(note).not.toContain("@fucory")
    expect(agentFaultNote("turn_rate_limited — that is 10 turns today.")).toContain("[fault=wait")
    /* Still reads plue's vocabulary, and still refuses to guess from English. */
    expect(agentFaultNote("no_capacity — no sandbox slots are free.")).toContain("[fault=infra code=no_capacity]")
    expect(agentFaultNote("something went wrong")).toBeNull()
  })

  test("keeps the two infra audiences apart, which is the whole reason origin exists", async () => {
    const fleetFull = refusalOf({ body: { code: "no_capacity", fault: "infra" }, status: 503, message: "full" })
    const misconfigured = await workerRefusal("deployment_not_configured", "unset")
    expect(fleetFull.origin).toBe("plue")
    expect(misconfigured.origin).toBe("worker")
    expect(fleetFull.fault).toBe(misconfigured.fault)
    expect(refusalLead(fleetFull)).not.toBe(refusalLead(misconfigured))
    expect(refusalLead(fleetFull)).toContain("@fucory")
  })
})
