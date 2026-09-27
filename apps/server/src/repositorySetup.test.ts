import { afterEach, expect, test } from "bun:test"
import { initialSetup, setupCandidate } from "@smthrs/rpc/RepositorySetup"
import worker from "./index"
import { memoryDurableObjects } from "./memoryDurableObjects"

/*
 * `/api/repository-setup/*` is the Smithers backend's (internal/compose/
 * repository_setup.go). The Worker checks the session and forwards each
 * request as that user; nothing here is stored or executed by the Worker.
 */

const originalFetch = globalThis.fetch
afterEach(() => { globalThis.fetch = originalFetch })

const CLOUD = "https://cloud.test"
const settings = { ASSETS: { fetch: async () => new Response("SPA") }, IDENTITY_UPSTREAM_URL: "https://identity.test",
  IDENTITY_SERVICE_TOKEN: "synthetic-service", SMITHERS_CLOUD_API_BASE_URL: CLOUD }

interface CloudCall { readonly method: string; readonly url: string; readonly authorization: string | null; readonly body: string }

const deployment = (cloud: (call: CloudCall) => Response) => {
  const calls: CloudCall[] = []
  globalThis.fetch = (async (target: RequestInfo | URL, init?: RequestInit) => {
    const request = target instanceof Request ? target : new Request(String(target), init)
    const url = new URL(request.url)
    if (url.hostname === "identity.test") {
      if (url.pathname === "/api/identity/cloud-token") return Response.json({ found: true, token: `cloud-${(await request.json() as { login: string }).login}` })
      const login = request.headers.get("cookie")?.split("=")[1]
      return login === undefined ? Response.json({}, { status: 401 }) : Response.json({ login, allowlisted: true, admin: false })
    }
    if (url.origin !== CLOUD) throw Error(`Unexpected upstream ${url.toString()}`)
    const call = { method: request.method, url: request.url, authorization: request.headers.get("authorization"), body: await request.text() }
    calls.push(call)
    return cloud(call)
  }) as typeof fetch
  const fetchAs = (path: string, init?: RequestInit, login: string | null = "alice") => worker.fetch(
    new Request(`https://app.test${path}`, { ...init, headers: { ...(login === null ? {} : { cookie: `smithers_session=${login}` }), ...(init?.headers ?? {}) } }),
    { ...settings, ...memoryDurableObjects() })
  return { calls, fetchAs }
}

const setup = initialSetup("org/repo", "issues", "alice")
const input = { requestId: "setup-test", repo: setup.repo, job: setup.job, revision: setup.revision, draft: setup.draft, digest: setupCandidate(setup) }
const queued = { requestId: input.requestId, revision: input.revision, digest: input.digest,
  receipt: { requestId: input.requestId, revision: input.revision, digest: input.digest, operation: "inspect", phase: "queued", updatedAt: 1, results: [], evidence: [] } }

test("a setup request reaches the backend as the signed-in user with its body unchanged, and its 202 passes through", async () => {
  const { calls, fetchAs } = deployment(() => Response.json(queued, { status: 202 }))
  const body = JSON.stringify(input)
  const response = await fetchAs("/api/repository-setup/inspect", { method: "POST", headers: { "content-type": "application/json" }, body })
  expect(response.status).toBe(202)
  expect(await response.json()).toEqual(queued)
  expect(response.headers.get("cache-control")).toBe("private, no-store")
  expect(calls).toEqual([{ method: "POST", url: `${CLOUD}/api/repository-setup/inspect`, authorization: "Bearer cloud-alice", body }])
})

test("recovery and observation reads keep their query", async () => {
  const { calls, fetchAs } = deployment(() => Response.json({ owner: "alice", repo: "org/repo", job: "issues", registration: { state: "known" }, setup: { state: "none" } }))
  for (const path of ["/api/repository-setup/state?repo=org%2Frepo&job=issues", "/api/repository-setup/observe?requestId=setup-test&repo=org%2Frepo&job=issues"]) {
    expect((await fetchAs(path)).status).toBe(200)
  }
  expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual([
    `GET ${CLOUD}/api/repository-setup/state?repo=org%2Frepo&job=issues`,
    `GET ${CLOUD}/api/repository-setup/observe?requestId=setup-test&repo=org%2Frepo&job=issues`
  ])
})

test("a backend refusal keeps its status, its code and its sentence", async () => {
  const refusals = [
    { status: 404, body: { code: "not_found", fault: "user", message: "Setup request not found" } },
    { status: 409, body: { code: "setup_request_reused", fault: "user", message: "Setup request was already used for another operation" } },
    { status: 503, body: { code: "service_unavailable", fault: "infra", message: "Setup completed without a verified result" } }
  ]
  for (const refusal of refusals) {
    const { fetchAs } = deployment(() => Response.json(refusal.body, { status: refusal.status }))
    const response = await fetchAs("/api/repository-setup/request?requestId=setup-test&repo=org%2Frepo&job=issues")
    expect(response.status).toBe(refusal.status)
    expect(await response.json()).toEqual({ status: "error", code: refusal.body.code, message: refusal.body.message })
  }
})

test("an unauthenticated caller, another method, a nested path and an oversized draft are refused before the backend", async () => {
  const { calls, fetchAs } = deployment(() => Response.json({}))
  expect((await fetchAs("/api/repository-setup/inspect", { method: "POST", body: JSON.stringify(input) }, null)).status).toBe(401)
  expect((await fetchAs("/api/repository-setup/inspect", { method: "PUT", body: "{}" })).status).toBe(405)
  expect((await fetchAs("/api/repository-setup/state/extra")).status).toBe(404)
  const oversized = await fetchAs("/api/repository-setup/inspect", { method: "POST", body: "x".repeat(64_001) })
  expect(oversized.status).toBe(413)
  expect(calls).toEqual([])
})
