import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, test } from "vitest"
import { digestOf } from "../scripts/refresh-failure-codes.mjs"
import type { FailureCodeRow } from "../scripts/refresh-failure-codes.mjs"
import {
  PLUE_FAILURE_CODES,
  PLUE_FAILURE_DIGEST,
  PLUE_FAILURE_SCHEMA_VERSION,
  PLUE_FAILURES,
  PLUE_FAULTS
} from "../src/PlueFailureCodes.ts"
import {
  clientRefusal,
  faultOfStatus,
  isCapacityRefusal,
  mayAutoRetry,
  plueFailureCode,
  refusalOf,
  retryAfterHeader,
  statedRetryDelayMs
} from "../src/Refusal.ts"

const vendored = JSON.parse(readFileSync(join(__dirname, "..", "src", "plue-failure-codes.json"), "utf8")) as {
  readonly schema_version: number
  readonly digest: string
  readonly faults: ReadonlyArray<string>
  readonly codes: ReadonlyArray<FailureCodeRow>
}

/*
 * plue owns the taxonomy; this package vendors it. Everything below exists so
 * that vendoring can go stale LOUDLY. The generated table is the app's whole
 * definition of what a failure is, so a copy that has quietly drifted from
 * plue's is worse than no copy at all: it would classify a real refusal with a
 * row that no longer describes it.
 */
describe("the vendored plue failure registry", () => {
  test("the digest in the artifact verifies against the rows it covers", () => {
    // Recomputed the way plue computes it (sha256 over Go's compact encoding
    // of the rows), so hand-editing a row — a status nudged, a fault
    // re-classified locally to make something render differently — fails here
    // instead of shipping.
    expect(digestOf(vendored.codes)).toBe(vendored.digest)
  })

  test("the generated table matches the vendored artifact row for row", () => {
    expect(PLUE_FAILURE_DIGEST).toBe(vendored.digest)
    expect(PLUE_FAILURE_SCHEMA_VERSION).toBe(vendored.schema_version)
    expect([...PLUE_FAULTS]).toEqual([...vendored.faults])
    expect([...PLUE_FAILURE_CODES]).toEqual(vendored.codes.map((row) => row.code))
    const generated = Object.entries(PLUE_FAILURES).map(([code, entry]) => ({
      code,
      fault: entry.fault,
      status: entry.status,
      retry_after: entry.retryAfter
    }))
    expect(generated).toEqual(
      vendored.codes.map((row) => ({
        code: row.code,
        fault: row.fault,
        status: row.status,
        retry_after: row.retry_after
      }))
    )
  })

  test("every code has exactly one row — the table is the exhaustiveness gate", () => {
    // `satisfies Record<PlueFailureCode, PlueFailureEntry>` in the generated
    // file makes a missing row a COMPILE error; this pins the same fact at
    // runtime so the row count cannot silently diverge from plue's code list.
    expect(Object.keys(PLUE_FAILURES)).toHaveLength(PLUE_FAILURE_CODES.length)
    expect(new Set(PLUE_FAILURE_CODES).size).toBe(PLUE_FAILURE_CODES.length)
  })

  test("a full fleet and an account at its own cap are different codes with different faults", () => {
    // The distinction the Worker landed (8352e3e3) and the reason this whole
    // table exists: one of these is nobody's fault and one is the caller's.
    expect(PLUE_FAILURES.no_capacity).toEqual({ fault: "infra", status: 503, retryAfter: 30 })
    expect(PLUE_FAILURES.quota_exceeded).toEqual({ fault: "user", status: 429, retryAfter: 0 })
  })

  test("every code this repository already reads off the wire by name has a row", () => {
    // These are the codes Smithers itself branches on — WorkspaceSeam.ts
    // and the flow controllers in apps/app. Vendoring that lags plue leaves them as `rawCode` strings
    // with the verdict guessed from the status, which is the exact thing this
    // table exists to stop; a row here is what makes them codes.
    expect(PLUE_FAILURES.plan_limit_exceeded).toEqual({ fault: "user", status: 402, retryAfter: 0 })
    expect(PLUE_FAILURES.coding_host_upgrade_required).toEqual({ fault: "infra", status: 409, retryAfter: 0 })
    expect(PLUE_FAILURES.repository_workspace_pending).toEqual({ fault: "wait", status: 409, retryAfter: 2 })
    expect(PLUE_FAILURES.repository_ci_run_unverified).toEqual({ fault: "user", status: 403, retryAfter: 0 })
    // The eligibility refusal gateway.ts pairs with NOT_ON_WAITLIST: still the
    // caller's to clear, so a refresh may not turn the closed alpha into infra.
    expect(PLUE_FAILURES.access_not_granted).toEqual({ fault: "user", status: 403, retryAfter: 0 })
  })

  test("control-plane contention is plue's own infra refusal, and its pacing licenses no retry loop", () => {
    // plue's newest code: a control-plane transaction that kept losing a race
    // with a concurrent writer. Without a row the app reads it as an unnamed
    // 503 — right fault by accident, attributed to the Worker, with no code to
    // branch on. With one it is plue's, and the pacing it states is the trap:
    // `infra` may state a wait the way no_capacity does, and neither licenses
    // retrying on a timer.
    expect(PLUE_FAILURES.sandbox_control_busy).toEqual({ fault: "infra", status: 503, retryAfter: 2 })
    const busy = refusalOf({ body: { code: "sandbox_control_busy", retry_after: 2 }, status: 503, message: "x" })
    expect(busy.code).toBe("sandbox_control_busy")
    expect(busy.origin).toBe("plue")
    expect(busy.fault).toBe("infra")
    expect(mayAutoRetry(busy)).toBe(false)
  })
})

describe("classifying a refusal", () => {
  test("plue's own body is taken at its word", () => {
    const refusal = refusalOf({
      body: { code: "no_capacity", fault: "infra", message: "no sandbox slots are free", retry_after: 30 },
      status: 503,
      message: "no sandbox slots are free"
    })
    expect(refusal).toEqual({
      code: "no_capacity",
      rawCode: "no_capacity",
      fault: "infra",
      message: "no sandbox slots are free",
      retryAfter: 30,
      status: 503,
      origin: "plue"
    })
    expect(isCapacityRefusal(refusal)).toBe(true)
  })

  test("a code that reached us through the Worker is classified from the registry, not from prose", () => {
    // proxies.ts preserves `code` and `retry_after` and restates the message;
    // it does NOT forward `fault`. The registry is why the verdict survives.
    const refusal = refusalOf({
      body: { code: "no_capacity", retry_after: 30 },
      status: 503,
      message: "Smithers Cloud is having trouble right now (HTTP 503)."
    })
    expect(refusal.fault).toBe("infra")
    expect(refusal.retryAfter).toBe(30)
    expect(refusal.origin).toBe("plue")
  })

  test("retryAfter is what THIS RESPONSE said, and nothing inferred", () => {
    // The registry states 3s for guest_not_ready, but this response stated
    // none — so the field is null and the caller uses its own configured wait.
    // Folding the registry in here would make a seam's injectable delay a lie.
    expect(refusalOf({ body: { code: "guest_not_ready" }, status: 503, message: "not ready" }).retryAfter).toBeNull()
    expect(refusalOf({ body: { code: "guest_not_ready", retry_after: 4 }, status: 503, message: "x" }).retryAfter).toBe(
      4
    )
  })

  test("the Retry-After header wins over both", () => {
    expect(
      refusalOf({ body: { code: "guest_not_ready" }, status: 503, message: "not ready", retryAfterSeconds: 9 })
        .retryAfter
    ).toBe(9)
  })

  test("a code this build predates is shown but not branched on", () => {
    const refusal = refusalOf({ body: { code: "some_code_plue_added_later" }, status: 503, message: "nope" })
    expect(refusal.code).toBeNull()
    expect(refusal.rawCode).toBe("some_code_plue_added_later")
    expect(refusal.fault).toBe("infra")
    expect(refusal.origin).toBe("worker")
  })

  test("a body with no code at all falls back to its status", () => {
    expect(refusalOf({ body: {}, status: 403, message: "no" }).fault).toBe("user")
    expect(refusalOf({ body: null, status: 500, message: "no" }).fault).toBe("bug")
    expect(refusalOf({ body: {}, status: 502, message: "no" }).fault).toBe("dependency")
    expect(refusalOf({ body: {}, status: 503, message: "no" }).fault).toBe("infra")
    expect(faultOfStatus(null)).toBe("infra")
  })

  test("a fetch that threw before any response is an infra-class client refusal", () => {
    // It used to reach the chat model as `failed: Load failed` — a sentence
    // with no verdict in it, which the model read as the user's mistake.
    const refusal = clientRefusal(new Error("Load failed"))
    expect(refusal).toEqual({
      code: null,
      rawCode: null,
      fault: "infra",
      message: "Load failed",
      retryAfter: null,
      status: null,
      origin: "client"
    })
  })

  test("plueFailureCode is the one ingress for a string code", () => {
    expect(plueFailureCode("no_capacity")).toBe("no_capacity")
    expect(plueFailureCode("nope")).toBeNull()
    expect(plueFailureCode(7)).toBeNull()
    // A prototype key is not a code.
    expect(plueFailureCode("toString")).toBeNull()
  })

  test("Retry-After is read as a delta and never as a date", () => {
    const headers = (value: string | null) => ({ get: () => value })
    expect(retryAfterHeader(headers("30"))).toBe(30)
    expect(retryAfterHeader(headers("Wed, 21 Oct 2026 07:28:00 GMT"))).toBeNull()
    expect(retryAfterHeader(headers("0"))).toBeNull()
    expect(retryAfterHeader(headers(null))).toBeNull()
  })
})

describe("auto-retry", () => {
  test("fires only for the wait fault — the registry's pacing is enough to allow it", () => {
    expect(mayAutoRetry(refusalOf({ body: { code: "guest_not_ready" }, status: 503, message: "x" }))).toBe(true)
    expect(mayAutoRetry(refusalOf({ body: { code: "desktop_not_ready" }, status: 503, message: "x" }))).toBe(true)
  })

  test("waits the interval the response stated, and leaves the caller's own wait alone when it stated none", () => {
    expect(
      statedRetryDelayMs(
        refusalOf({ body: { code: "guest_not_ready" }, status: 503, message: "x", retryAfterSeconds: 1 })
      )
    )
      .toBe(1_000)
    expect(statedRetryDelayMs(refusalOf({ body: { code: "guest_not_ready" }, status: 503, message: "x" }))).toBeNull()
  })

  test("never fires for infra — a full fleet does not empty because a client asked twice", () => {
    // no_capacity states retry_after 30, so this is the fault gate doing the
    // work and not the absence of a number.
    const full = refusalOf({
      body: { code: "no_capacity", fault: "infra", retry_after: 30 },
      status: 503,
      message: "x"
    })
    expect(full.retryAfter).toBe(30)
    expect(mayAutoRetry(full)).toBe(false)
  })

  test("never fires for a user, dependency or bug fault", () => {
    for (const code of ["quota_exceeded", "github_rate_limited", "internal"] as const) {
      expect(mayAutoRetry(refusalOf({ body: { code }, status: PLUE_FAILURES[code].status, message: "x" }))).toBe(false)
    }
  })

  test("never fires for a client refusal", () => {
    expect(mayAutoRetry(clientRefusal(new Error("offline")))).toBe(false)
  })

  test("every wait code in the registry states a pacing, so none of them stalls", () => {
    // If plue ever adds a `wait` code with retry_after 0, the app would have
    // no interval to honour and would simply stop waiting. Catch it here.
    for (const [code, entry] of Object.entries(PLUE_FAILURES)) {
      if (entry.fault !== "wait") continue
      expect(entry.retryAfter, `${code} is a wait fault with no stated pacing`).toBeGreaterThan(0)
    }
  })
})
