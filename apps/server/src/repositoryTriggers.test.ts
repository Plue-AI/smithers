import { afterEach, expect, test } from "bun:test"
import { initialSetup, REPOSITORY_JOBS, setupCandidate, type RepositoryJob, type SetupRecoveryResponse } from "@smthrs/rpc/RepositorySetup"
import worker from "./index"
import { memoryDurableObjects } from "./memoryDurableObjects"
import { TRIGGER_APPROVAL_PATH, TRIGGER_PAUSE_PATH, TRIGGER_REGISTRATIONS_PATH, triggerRegistrationRow } from "./repositoryTriggers"

/*
 * The three generic-trigger routes (L36 §1.5) through the real Worker: the
 * listing that parses each row on its own, the pause that stops a schedule,
 * and the approval receipt Plue stamps. Nothing here reaches a network: the
 * identity door and Smithers Cloud are both the stub below, and an
 * unstubbed host throws rather than resolving.
 */

const originalFetch = globalThis.fetch
afterEach(() => { globalThis.fetch = originalFetch })

const workspaceId = "11111111-1111-4111-8111-111111111111"

/** One of the five built-in setup registrations, exactly as recovery reads it. */
const known = (job: RepositoryJob, mode: "enabled" | "trial") => {
  const source = initialSetup("org/repo", job, "alice")
  const shared = { repo: source.repo, workspace_id: workspaceId, source_revision: "b".repeat(40), flow_id: `repository-jobs/${job}`,
    mode, revision: source.revision, digest: setupCandidate(source), schedule: "" }
  return { ...shared, id: `registration-${job}-${mode}`, user_id: 1, job, enabled: true, next_fire_at: null, configuration: { ...shared, input: source.draft } }
}

/** A generic trigger row as Plue serves it. */
const triggerRow = (slug: string, overrides: Record<string, unknown> = {}) => ({
  id: `registration-${slug}`, workspace_id: workspaceId, user_id: 1, job: `flow:${slug}`, mode: "enabled",
  revision: 1, digest: "c".repeat(64), source_revision: "b".repeat(40), flow_id: "nightly-lint", enabled: true,
  schedule: "0 9 * * 1-5", next_fire_at: "2026-09-18T09:00:00Z",
  configuration: { input: { label: "nightly" } }, ...overrides
})

interface CloudCall { readonly method: string; readonly path: string; readonly body: string | null }

/** What the identity door answers for a Cloud token; the default is a minted one. */
type CloudToken = () => Response
const minted: CloudToken = () => Response.json({ found: true, token: "cloud-alice" })
/** The account is signed in and still on the closed-alpha waitlist (gateway.ts CLOUD_ELIGIBILITY_REFUSALS). */
const waitlisted: CloudToken = () => Response.json({ found: false, cloud: { status: "NOT_ON_WAITLIST" } })

/** The Worker under a stubbed identity door and a stubbed Smithers Cloud. */
const deployment = (cloud: (call: CloudCall) => Response, token: CloudToken = minted) => {
  const settings = { ASSETS: { fetch: async () => new Response("SPA") }, IDENTITY_UPSTREAM_URL: "https://identity.test",
    IDENTITY_SERVICE_TOKEN: "synthetic-service", SMITHERS_CLOUD_API_BASE_URL: "https://cloud.test" }
  const durable = memoryDurableObjects({ env: settings, nativeAlarms: true })
  const env = { ...settings, GATEWAY_SESSIONS: durable.GATEWAY_SESSIONS, TURN_CANCELS: durable.TURN_CANCELS }
  const calls: Array<CloudCall> = []
  globalThis.fetch = (async (target: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(target instanceof Request ? target.url : String(target), "https://identity.test")
    if (url.hostname === "identity.test") {
      if (url.pathname === "/api/identity/cloud-token") return token()
      const cookie = (target instanceof Request ? target.headers.get("cookie") : null) ??
        new Headers(init?.headers ?? {}).get("cookie")
      return cookie === null || cookie === ""
        ? Response.json({ error: "no session" }, { status: 401 })
        : Response.json({ login: "alice", allowlisted: true, admin: false })
    }
    if (url.hostname !== "cloud.test") throw Error(`Unexpected upstream ${url.toString()}`)
    const call: CloudCall = {
      method: (target instanceof Request ? target.method : init?.method) ?? "GET",
      path: url.pathname,
      body: typeof init?.body === "string" ? init.body : null
    }
    calls.push(call)
    return cloud(call)
  }) as typeof fetch
  const background: Array<Promise<unknown>> = []
  const fetchAs = (path: string, init?: RequestInit & { readonly signedIn?: boolean }) =>
    worker.fetch(
      new Request(`https://app.test${path}`, { ...init, headers: { ...(init?.signedIn === false ? {} : { cookie: "session=alice" }), ...(init?.headers ?? {}) } }),
      env,
      { waitUntil: (promise: Promise<unknown>) => { background.push(promise) } }
    )
  return { calls, fetchAs }
}

const body = async (response: Response) => await response.json() as Record<string, unknown>

test("the listing reads each row on its own: the five built-ins, a foreign row and a later shape never hide a trigger", async () => {
  const rows = [
    ...REPOSITORY_JOBS.map((job) => known(job, "enabled")),
    triggerRow("nightly"),
    { id: "from-the-future", job: "flow:tomorrow", flow_id: "x", schedule: "0 3 * * *", enabled: true, revision: "one" },
    { nothing: "recognisable" }
  ]
  const { fetchAs } = deployment(() => Response.json(rows))
  const answer = await fetchAs(`${TRIGGER_REGISTRATIONS_PATH}?repo=org%2Frepo`)
  expect(answer.status).toBe(200)
  expect(await body(answer)).toEqual({
    status: "ok",
    repo: "org/repo",
    rows: [{
      slug: "nightly", flowId: "nightly-lint", schedule: "0 9 * * 1-5", enabled: true, revision: 1,
      digest: "c".repeat(64), sourceRevision: "b".repeat(40), nextFireAt: "2026-09-18T09:00:00Z",
      registrationId: "registration-nightly"
    }]
  })
})

test("a trigger row leaves the five setup jobs' recovery reporting their real state", async () => {
  const rows = [...REPOSITORY_JOBS.map((job) => known(job, "enabled")), triggerRow("nightly")]
  const { fetchAs } = deployment((call) => call.path === "/api/user" ? Response.json({ id: 1 }) : Response.json(rows))
  for (const job of REPOSITORY_JOBS) {
    const answer = await fetchAs(`/api/repository-setup/state?repo=org%2Frepo&job=${job}`)
    const state = (await answer.json() as SetupRecoveryResponse).registration
    if (state.state !== "known") throw Error(`Expected ${job} to stay known, got ${JSON.stringify(state)}`)
    expect(state.active?.digest).toBe(setupCandidate(initialSetup("org/repo", job, "alice")))
  }
  const listed = await fetchAs(`${TRIGGER_REGISTRATIONS_PATH}?repo=org%2Frepo`)
  expect((await body(listed)).rows).toHaveLength(1)
})

test("the listing names its repository and its session before it spends anything", async () => {
  const { calls, fetchAs } = deployment(() => Response.json([]))
  expect((await body(await fetchAs(`${TRIGGER_REGISTRATIONS_PATH}?repo=not-a-repo`))).code).toBe("request_invalid")
  const signedOut = await fetchAs(`${TRIGGER_REGISTRATIONS_PATH}?repo=org%2Frepo`, { signedIn: false })
  expect((await body(signedOut)).code).toBe("sign_in_required")
  expect((await fetchAs(`${TRIGGER_REGISTRATIONS_PATH}?repo=org%2Frepo`, { method: "POST" })).status).toBe(405)
  expect(calls).toEqual([])
})

test("pause counts the rows Smithers Cloud actually stopped, and says zero when it stopped none", async () => {
  /* Plue's pause answers the rows it updated (db/queries/repository_jobs.sql PauseRepositoryJob), never a count. */
  const stopped = deployment(() => Response.json([triggerRow("nightly", { enabled: false })]))
  const answer = await stopped.fetchAs(TRIGGER_PAUSE_PATH, { method: "POST", body: JSON.stringify({ repo: "org/repo", slug: "nightly" }) })
  expect(await body(answer)).toEqual({ status: "ok", paused: 1 })
  expect(stopped.calls.map((call) => `${call.method} ${call.path}`)).toEqual(["POST /api/repos/org/repo/repository-jobs/flow:nightly/pause"])

  /* A well-formed slug nobody registered passes Plue's name gate and updates nothing. */
  const none = deployment(() => Response.json([]))
  const missing = await none.fetchAs(TRIGGER_PAUSE_PATH, { method: "POST", body: JSON.stringify({ repo: "org/repo", slug: "no-such-schedule" }) })
  expect(await body(missing)).toEqual({ status: "ok", paused: 0 })

  const refused = deployment(() => Response.json({ message: "unknown repository job" }, { status: 404 }))
  const unknown = await refused.fetchAs(TRIGGER_PAUSE_PATH, { method: "POST", body: JSON.stringify({ repo: "org/repo", slug: "nightly" }) })
  expect(await body(unknown)).toMatchObject({ code: "upstream_refused", message: "unknown repository job" })

  const invalid = deployment(() => Response.json({}))
  expect((await body(await invalid.fetchAs(TRIGGER_PAUSE_PATH, { method: "POST", body: JSON.stringify({ repo: "org/repo", slug: "NIGHTLY" }) }))).code)
    .toBe("request_invalid")
  expect(invalid.calls).toEqual([])
})

/*
 * The app reads `paused` as a NUMBER and says "no such schedule" below one
 * (TriggersSeam pauseTrigger). Any other shape reads as a successful pause,
 * so an accepted pause answers a number whatever Smithers Cloud returned —
 * including a body this Worker's vocabulary does not cover.
 */
test("an accepted pause always answers a numeric count, whatever shape Cloud answered", async () => {
  for (const answer of [{}, null, { rows: [] }, "ok"] as const) {
    const deployed = deployment(() => Response.json(answer))
    const paused = await body(await deployed.fetchAs(TRIGGER_PAUSE_PATH, {
      method: "POST",
      body: JSON.stringify({ repo: "org/repo", slug: "nightly" })
    }))
    expect(paused).toEqual({ status: "ok", paused: 0 })
    expect(typeof paused.paused).toBe("number")
  }
})

/* The envelope a registration carries: Cloud stores it and refuses one with no finite token/time limits. */
const REVIEWED_ENVELOPE = { capabilities: ["fs:read:**"], flows: ["nightly-lint"], budget: { tokens: 200_000, milliseconds: 600_000 } }
const APPROVED_PLAN = { repo: "org/repo", slug: "nightly", planId: "plan-1", planDigest: "d".repeat(64), envelope: REVIEWED_ENVELOPE }
const APPROVAL = { ...APPROVED_PLAN, flowId: "nightly-lint" }

test("the approval receipt names the registered flow, sends only what Control produced, and Cloud alone states who approved", async () => {
  const recorded = deployment(() => Response.json({ approved_at: "2026-09-17T06:00:00Z", approved_by: 1 }))
  const answer = await recorded.fetchAs(TRIGGER_APPROVAL_PATH, {
    method: "POST",
    body: JSON.stringify({ ...APPROVAL, approvedBy: 99, approvedAt: "1999-01-01T00:00:00Z" })
  })
  expect(await body(answer)).toEqual({ status: "ok", approvedAt: "2026-09-17T06:00:00Z", approvedBy: 1 })
  expect(recorded.calls[0]?.path).toBe("/api/repos/org/repo/repository-jobs/flow:nightly/approvals")
  /* Plue's RecordApproval decodes exactly these four with DisallowUnknownFields and refuses an empty flow_id. */
  const sent = JSON.parse(recorded.calls[0]?.body ?? "{}") as Record<string, unknown>
  expect(sent).toEqual({ plan_id: "plan-1", plan_digest: "d".repeat(64), flow_id: "nightly-lint", envelope: REVIEWED_ENVELOPE })

  const silent = deployment(() => Response.json({ ok: true }))
  const malformed = await silent.fetchAs(TRIGGER_APPROVAL_PATH, { method: "POST", body: JSON.stringify(APPROVAL) })
  expect((await body(malformed)).code).toBe("upstream_malformed")
})

/*
 * Walk run 3, defect D3-N2: a registration carried the target flow's plan
 * envelope, which for a flow that declares no ceiling is `"budget": {}`, and
 * Smithers Cloud refused it — `automatic work needs the reviewed envelope and
 * finite token/time limits`. The person read `upstream_refused … Not your
 * doing.` for a fact about their own registration. Plue refuses it, so this
 * route refuses it here rather than there, exactly as it already does for an
 * absent flow id.
 */
test("an approval whose envelope names no finite token and time limits never reaches Smithers Cloud", async () => {
  const { envelope: _reviewed, ...unbounded } = APPROVAL
  for (
    const envelope of [
      undefined,
      {},
      { capabilities: ["*"], flows: [], budget: {} },
      { capabilities: ["*"], flows: [], budget: { tokens: 200_000 } },
      { capabilities: ["*"], flows: [], budget: { tokens: 0, milliseconds: 600_000 } },
      { capabilities: ["*"], flows: [], budget: { tokens: "200000", milliseconds: 600_000 } },
      { flows: [], budget: { tokens: 200_000, milliseconds: 600_000 } },
      { capabilities: ["*"], budget: { tokens: 200_000, milliseconds: 600_000 } }
    ] as const
  ) {
    const attempt = deployment(() => Response.json({ approved_at: "2026-09-17T06:00:00Z", approved_by: 1 }))
    const answer = await attempt.fetchAs(TRIGGER_APPROVAL_PATH, {
      method: "POST",
      body: JSON.stringify({ ...unbounded, ...(envelope === undefined ? {} : { envelope }) })
    })
    expect((await body(answer)).code).toBe("request_invalid")
    expect(attempt.calls).toEqual([])
  }
})

/*
 * R98 F1: the app bounded only the limits a person typed, so a flow that
 * DECLARES four hours (nothing in `Descriptor.BudgetCeiling` stops it) reached
 * this route with that envelope, and Plue refused the approval with the same
 * `automatic work needs the reviewed envelope and finite token/time limits`.
 * The deployment's own ceiling is the bound on both sides of this wire, so an
 * envelope no registration could run under writes no approval row.
 */
test("an approval whose envelope is past the deployment's ceiling never reaches Smithers Cloud", async () => {
  const { envelope: _reviewed, ...unbounded } = APPROVAL
  for (
    const budget of [
      { tokens: 200_000, milliseconds: 6 * 60 * 60_000 + 1 },
      { tokens: 200_001, milliseconds: 600_000 },
      { tokens: 5_000_000, milliseconds: 86_400_000 }
    ]
  ) {
    const attempt = deployment(() => Response.json({ approved_at: "2026-09-17T06:00:00Z", approved_by: 1 }))
    const answer = await attempt.fetchAs(TRIGGER_APPROVAL_PATH, {
      method: "POST",
      body: JSON.stringify({ ...unbounded, envelope: { ...REVIEWED_ENVELOPE, budget } })
    })
    expect((await body(answer)).code).toBe("request_invalid")
    expect(attempt.calls).toEqual([])
  }
  /* The ceiling itself is a registration, not a refusal: 200000 tokens and the six hours Plue admits. */
  const ceiling = deployment(() => Response.json({ approved_at: "2026-09-17T06:00:00Z", approved_by: 1 }))
  const recorded = await ceiling.fetchAs(TRIGGER_APPROVAL_PATH, {
    method: "POST",
    body: JSON.stringify({ ...unbounded, envelope: { ...REVIEWED_ENVELOPE, budget: { tokens: 200_000, milliseconds: 21_600_000 } } })
  })
  expect((await body(recorded)).status).toBe("ok")
  expect(ceiling.calls).toHaveLength(1)
})

test("an approval that does not name a registrable flow never reaches Smithers Cloud", async () => {
  for (const flowId of [undefined, "", "-leading-dash", "x".repeat(201)]) {
    const attempt = deployment(() => Response.json({ approved_at: "2026-09-17T06:00:00Z", approved_by: 1 }))
    const answer = await attempt.fetchAs(TRIGGER_APPROVAL_PATH, {
      method: "POST",
      body: JSON.stringify({ ...APPROVED_PLAN, ...(flowId === undefined ? {} : { flowId }) })
    })
    expect((await body(answer)).code).toBe("request_invalid")
    expect(attempt.calls).toEqual([])
  }
})

test("a conflict from Smithers Cloud is the typed approval refusal, with Plue's own sentence", async () => {
  const sentence = "register only the plan a person approved; approve the preview, then apply"
  const conflicted = deployment(() => Response.json({ message: sentence }, { status: 409 }))
  const refusal = await conflicted.fetchAs(TRIGGER_APPROVAL_PATH, { method: "POST", body: JSON.stringify(APPROVAL) })
  expect(refusal.status).toBe(409)
  expect(await body(refusal)).toMatchObject({ code: "trigger_approval_missing", message: sentence })
})

test("an account still on the waitlist reads as its own eligibility on every trigger route", async () => {
  const listing = deployment(() => Response.json([]), waitlisted)
  expect((await body(await listing.fetchAs(`${TRIGGER_REGISTRATIONS_PATH}?repo=org%2Frepo`))).code).toBe("account_not_allowlisted")
  expect(listing.calls).toEqual([])

  const pausing = deployment(() => Response.json([]), waitlisted)
  const paused = await pausing.fetchAs(TRIGGER_PAUSE_PATH, { method: "POST", body: JSON.stringify({ repo: "org/repo", slug: "nightly" }) })
  expect((await body(paused)).code).toBe("account_not_allowlisted")

  const approving = deployment(() => Response.json({}), waitlisted)
  const approved = await approving.fetchAs(TRIGGER_APPROVAL_PATH, { method: "POST", body: JSON.stringify(APPROVAL) })
  expect(approved.status).toBe(403)
  expect((await body(approved)).code).toBe("account_not_allowlisted")
})

test("the row reader keeps a trigger and drops everything else", () => {
  expect(triggerRegistrationRow(triggerRow("nightly"))?.slug).toBe("nightly")
  expect(triggerRegistrationRow(known("chores", "enabled"))).toBeUndefined()
  expect(triggerRegistrationRow(triggerRow("Nightly", { job: "flow:Nightly" }))).toBeUndefined()
  expect(triggerRegistrationRow(triggerRow("nightly", { schedule: "" }))).toBeUndefined()
  expect(triggerRegistrationRow(triggerRow("nightly", { next_fire_at: null }))?.nextFireAt).toBeNull()
})

test.each([[403, "forbidden"], [404, "not_found"], [422, "validation_failed"], [500, "internal"]] as const)("trigger refusals preserve Cloud's typed %s code %s and bound prose", async (status, code) => {
  const t = deployment(() => Response.json({ code, message: "x".repeat(500) }, { status }))
  const response = await t.fetchAs(`${TRIGGER_REGISTRATIONS_PATH}?repo=org%2Frepo`)
  expect(t.calls).toHaveLength(1)
  expect(response.status).toBe(status)
  expect(await body(response)).toMatchObject({ code, message: "x".repeat(200) })
})

test("a token refused twice is an infrastructure refusal, with no raw HTML", async () => {
  const t = deployment(() => new Response("<html>provider debug</html>", { status: 401 }))
  const response = await t.fetchAs(`${TRIGGER_REGISTRATIONS_PATH}?repo=org%2Frepo`)
  expect(t.calls).toHaveLength(2)
  expect(await body(response)).toMatchObject({ code: "upstream_refused" })
})
