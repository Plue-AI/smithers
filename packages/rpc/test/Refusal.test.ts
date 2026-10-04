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
  type Refusal,
  REFUSAL_ORIGINS,
  refusalFromStored,
  refusalOf,
  retryAfterHeader,
  statedRetryDelayMs,
  type StoredRefusal,
  storedRefusal
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

describe("refusal persistence units", () => {
  test.each(
    [
      { name: "missing code", stored: { status: 0, message: "Load failed" } },
      { name: "null code", stored: { status: 0, message: "Load failed", code: null } }
    ] satisfies Array<{ name: string; stored: StoredRefusal }>
  )("a legacy never-answered record with $name remains a client refusal", ({ stored }) => {
    expect(refusalFromStored(stored)).toEqual({
      code: null,
      rawCode: null,
      fault: "infra",
      message: "Load failed",
      retryAfter: null,
      status: null,
      origin: "client"
    })
  })

  test("a current client refusal stores a zero status and restores its connection attribution", () => {
    const refused = clientRefusal("Connection closed")
    const stored = storedRefusal(refused)
    expect(stored).toEqual({
      status: 0,
      message: "Connection closed",
      code: null,
      retryAfterSeconds: null,
      fault: "infra",
      origin: "client"
    })
    const fromJson: StoredRefusal = JSON.parse(JSON.stringify(stored))
    expect(refusalFromStored(fromJson)).toEqual({
      code: null,
      rawCode: null,
      fault: "infra",
      message: "Connection closed",
      retryAfter: null,
      status: null,
      origin: "client"
    })
  })

  test.each(
    [
      { origin: "client", status: 0, expectedStatus: null },
      { origin: "local", status: 0, expectedStatus: null },
      { origin: "worker", status: 0, expectedStatus: null },
      { origin: "plue", status: 0, expectedStatus: null },
      { origin: "client", status: 503, expectedStatus: 503 },
      { origin: "local", status: 503, expectedStatus: 503 },
      { origin: "worker", status: 503, expectedStatus: 503 },
      { origin: "plue", status: 503, expectedStatus: 503 }
    ] satisfies Array<{ origin: Refusal["origin"]; status: number; expectedStatus: number | null }>
  )(
    "a stated $origin origin survives status $status independently of code provenance",
    ({ origin, status, expectedStatus }) => {
      const stored: StoredRefusal = {
        status,
        message: "Workspace starting",
        code: "workspace_starting",
        origin,
        retryAfterSeconds: 2
      }
      expect(refusalFromStored(stored)).toEqual({
        code: "workspace_starting",
        rawCode: "workspace_starting",
        fault: "wait",
        message: "Workspace starting",
        retryAfter: 2,
        status: expectedStatus,
        origin
      })
    }
  )

  test.each(
    [
      { rawCode: "native_repo_not_found", code: "native_repo_not_found", fault: "user" },
      { rawCode: "workspace_starting", code: "workspace_starting", fault: "wait" },
      { rawCode: "no_capacity", code: "no_capacity", fault: "infra" },
      { rawCode: "future_connection_failure", code: null, fault: "infra" }
    ] satisfies Array<{ rawCode: string; code: Refusal["code"]; fault: Refusal["fault"] }>
  )(
    "a never-answered $rawCode record retains its code and verdict with client attribution",
    ({ rawCode, code, fault }) => {
      const stored: StoredRefusal = { status: 0, message: "Connection ended", code: rawCode }
      expect(refusalFromStored(stored)).toEqual({
        code,
        rawCode,
        fault,
        message: "Connection ended",
        retryAfter: null,
        status: null,
        origin: "client"
      })
    }
  )

  test.each(
    [
      { name: "user over the capacity registry", status: 503, code: "no_capacity", fault: "user" },
      { name: "wait over the capacity registry", status: 503, code: "no_capacity", fault: "wait" },
      { name: "bug over an uncoded user status", status: 403, code: null, fault: "bug" },
      { name: "dependency over an uncoded user status", status: 403, code: null, fault: "dependency" },
      { name: "infra over an uncoded user status", status: 403, code: null, fault: "infra" }
    ] satisfies Array<{ name: string; status: number; code: Refusal["code"]; fault: Refusal["fault"] }>
  )("a persisted verdict preserves $name", ({ status, code, fault }) => {
    const stored: StoredRefusal = { status, message: "Recorded verdict", code, fault, origin: "plue" }
    expect(refusalFromStored(stored)).toEqual({
      code,
      rawCode: code,
      fault,
      message: "Recorded verdict",
      retryAfter: null,
      status,
      origin: "plue"
    })
  })

  test.each([
    { name: "a thrown string", error: "Connection closed", message: undefined, expected: "Connection closed" },
    {
      name: "an explicit public message",
      error: new Error("Socket details"),
      message: "Try again",
      expected: "Try again"
    },
    { name: "an empty override on an Error", error: new Error("Socket details"), message: "", expected: "" },
    { name: "an empty override on a thrown string", error: "Socket details", message: "", expected: "" }
  ])("client classification preserves $name", ({ error, message, expected }) => {
    expect(clientRefusal(error, message)).toEqual({
      code: null,
      rawCode: null,
      fault: "infra",
      message: expected,
      retryAfter: null,
      status: null,
      origin: "client"
    })
  })

  test.each(
    [
      {
        name: "a legacy Plue capacity refusal",
        stored: { status: 503, message: "Fleet full", code: "no_capacity", retryAfterSeconds: 30 },
        expected: {
          code: "no_capacity",
          rawCode: "no_capacity",
          fault: "infra",
          message: "Fleet full",
          retryAfter: 30,
          status: 503,
          origin: "plue"
        }
      },
      {
        name: "a legacy Worker wait with no invented retry delay",
        stored: { status: 503, message: "Workspace starting", code: "workspace_starting" },
        expected: {
          code: "workspace_starting",
          rawCode: "workspace_starting",
          fault: "wait",
          message: "Workspace starting",
          retryAfter: null,
          status: 503,
          origin: "worker"
        }
      },
      {
        name: "a legacy native refusal",
        stored: { status: 404, message: "Repository is absent", code: "native_repo_not_found" },
        expected: {
          code: "native_repo_not_found",
          rawCode: "native_repo_not_found",
          fault: "user",
          message: "Repository is absent",
          retryAfter: null,
          status: 404,
          origin: "local"
        }
      },
      {
        name: "an uncoded legacy dependency response",
        stored: { status: 502, message: "Proxy unavailable" },
        expected: {
          code: null,
          rawCode: null,
          fault: "dependency",
          message: "Proxy unavailable",
          retryAfter: null,
          status: 502,
          origin: "worker"
        }
      },
      {
        name: "a code from a newer server without a stated verdict",
        stored: { status: 500, message: "New server failure", code: "future_failure" },
        expected: {
          code: null,
          rawCode: "future_failure",
          fault: "bug",
          message: "New server failure",
          retryAfter: null,
          status: 500,
          origin: "worker"
        }
      },
      {
        name: "a newer server's explicit verdict, author and fractional pacing",
        stored: {
          status: 503,
          message: "Workspace images syncing",
          code: "workspace_images_syncing",
          fault: "wait",
          origin: "plue",
          retryAfterSeconds: 1.25
        },
        expected: {
          code: null,
          rawCode: "workspace_images_syncing",
          fault: "wait",
          message: "Workspace images syncing",
          retryAfter: 2,
          status: 503,
          origin: "plue"
        }
      }
    ] satisfies Array<{ name: string; stored: StoredRefusal; expected: Refusal }>
  )("restores $name without mutating the stored record", ({ stored, expected }) => {
    const before = structuredClone(stored)
    expect(refusalFromStored(stored)).toEqual(expected)
    expect(stored).toEqual(before)
  })

  test("plan guidance survives JSON persistence with the original server verdict", () => {
    const refusal = refusalOf({
      status: 402,
      message: "Monthly coding minutes used",
      body: {
        code: "plan_limit_exceeded",
        plan_key: "starter",
        limit_kind: "coding_minutes",
        upgrade_plan_key: "pro"
      }
    })
    const stored = storedRefusal(refusal)
    expect(stored).toEqual({
      status: 402,
      message: "Monthly coding minutes used",
      code: "plan_limit_exceeded",
      retryAfterSeconds: null,
      fault: "user",
      origin: "plue",
      plan_key: "starter",
      limit_kind: "coding_minutes",
      upgrade_plan_key: "pro"
    })
    const fromJson: StoredRefusal = JSON.parse(JSON.stringify(stored))
    expect(refusalFromStored(fromJson)).toEqual({
      code: "plan_limit_exceeded",
      rawCode: "plan_limit_exceeded",
      fault: "user",
      message: "Monthly coding minutes used",
      retryAfter: null,
      status: 402,
      origin: "plue",
      plan_key: "starter",
      limit_kind: "coding_minutes",
      upgrade_plan_key: "pro"
    })
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

describe("a persisted refusal", () => {
  const codes = [
    { label: "missing code", fields: {}, code: null, fault: "infra", origin: "worker" },
    { label: "null code", fields: { code: null }, code: null, fault: "infra", origin: "worker" },
    { label: "undefined code", fields: { code: undefined }, code: null, fault: "infra", origin: "worker" },
    { label: "unknown code", fields: { code: "future_code" }, code: null, fault: "infra", origin: "worker" },
    { label: "plue code", fields: { code: "quota_exceeded" }, code: "quota_exceeded", fault: "user", origin: "plue" },
    {
      label: "worker code",
      fields: { code: "seam_not_configured" },
      code: "seam_not_configured",
      fault: "infra",
      origin: "worker"
    },
    {
      label: "native code",
      fields: { code: "native_node_missing" },
      code: "native_node_missing",
      fault: "dependency",
      origin: "local"
    }
  ] as const

  test.each(codes)("status 0 means no answer with $label", ({ fields, code, fault }) => {
    expect(refusalFromStored({ status: 0, message: "Load failed", ...fields })).toEqual({
      code,
      rawCode: "code" in fields ? fields.code ?? null : null,
      fault,
      message: "Load failed",
      retryAfter: null,
      status: null,
      origin: "client"
    })
  })

  test.each(codes)("a nonzero status keeps code attribution with $label", ({ fields, code, fault, origin }) => {
    expect(refusalFromStored({ status: 503, message: "Server refused", ...fields })).toEqual({
      code,
      rawCode: "code" in fields ? fields.code ?? null : null,
      fault,
      message: "Server refused",
      retryAfter: null,
      status: 503,
      origin
    })
  })

  test.each([403, 500, 502, 504])("an uncoded HTTP %i keeps its status-based fault and worker origin", (status) => {
    const refusal = refusalFromStored({ status, message: "Server refused" })
    expect(refusal.status).toBe(status)
    expect(refusal.origin).toBe("worker")
    expect(refusal.fault).toBe(status === 403 ? "user" : status === 500 ? "bug" : "dependency")
  })

  test.each(REFUSAL_ORIGINS)("an explicit %s origin and fault survive status and code inference", (origin) => {
    for (const status of [0, 503]) {
      for (const { fields } of codes) {
        for (const fault of PLUE_FAULTS) {
          const refusal = refusalFromStored({ status, message: "Stored verdict", ...fields, origin, fault })
          expect(refusal.origin).toBe(origin)
          expect(refusal.fault).toBe(fault)
          expect(refusal.status).toBe(status === 0 ? null : status)
        }
      }
    }
  })

  test.each(PLUE_FAULTS)("an explicit %s fault survives client inference without an origin", (fault) => {
    const refusal = refusalFromStored({ status: 0, message: "Stored verdict", code: "quota_exceeded", fault })
    expect(refusal.origin).toBe("client")
    expect(refusal.fault).toBe(fault)
  })
})

describe("auto-retry", () => {
  test("fires only for the wait fault — the registry's pacing is enough to allow it", () => {
    expect(mayAutoRetry(refusalOf({ body: { code: "guest_not_ready" }, status: 503, message: "x" }))).toBe(true)
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
