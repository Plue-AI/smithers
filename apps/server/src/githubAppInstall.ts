import * as Effect from "effect/Effect"
import * as Result from "effect/Result"
import { ServerConfig } from "./Config"
import { cloudTokenRefusal, fetchCloudToken, isRelayRepoName } from "./cloudToken"
import { discardBody, fetchWithDeadline, readBoundedJson } from "./Http"
import { requireTurnSession } from "./identity"
import { json, refuse, upstreamUnreachable } from "./Responses"

export const INSTALLATIONS_PATH = "/api/user/github-app/installations"
// At most 2 identity reads + 10 inventory pages + 900 diagnoses per request.
const ACCESS_BUDGET = 900
const INVENTORY_MAX_BYTES = 4 * 1024 * 1024
const DIAGNOSIS_MAX_BYTES = 64 * 1024
const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value)

/** Verify against the caller's GitHub inventory and live App/user access diagnosis.
 * The callback id is a filter, never permission to read someone else's install.
 */
export const handleGitHubAppInstall = (request: Request, installationId?: string) => Effect.gen(function* () {
  // Validate the session and mint the Cloud token ONCE. Routing every read
  // through handlePlatformProxy cost three subrequests per repository and
  // tripped the Worker's 1000-subrequest ceiling at a few hundred repos.
  const config = yield* ServerConfig
  const gate = yield* requireTurnSession(request)
  if (gate instanceof Response) return gate
  const token = yield* fetchCloudToken(gate.login)
  if (token.status !== "ok") {
    const refusal = cloudTokenRefusal(token, `Smithers Cloud isn't reachable for your account right now (${token.status}).`)
    return refuse(refusal.code, refusal.message)
  }
  const headers = { authorization: `Bearer ${token.token}`, accept: "application/json" }
  const read = (path: string) => Effect.gen(function* () {
    const fetched = yield* Effect.result(fetchWithDeadline("Smithers Cloud", new URL(path, config.cloudApiBaseUrl).toString(), { headers }, config.upstreamTimeoutMs))
    return Result.isFailure(fetched) ? upstreamUnreachable("Smithers Cloud", fetched.failure) : fetched.success
  })
  const repos: Array<{ fullName: string; pushedAt: string; installationId: number }> = []
  const seen = new Set<string>()
  const blockers: string[] = []
  const candidates: Array<{ name: string; pushedAt: string }> = []
  let complete = false
  for (let page = 1; page <= 10; page++) {
    const inventory = yield* read(`/api/user/github-repos?sort=pushed&direction=desc&per_page=100&page=${page}`)
    // Upstream prose never passes through (the proxy's rule): restate it.
    if (!inventory.ok) {
      yield* discardBody(inventory)
      return json(inventory.status, { message: "Smithers Cloud could not verify the GitHub App installation. Try again." })
    }
    const body: unknown = yield* readBoundedJson(inventory, INVENTORY_MAX_BYTES).pipe(Effect.catch(() => Effect.succeed(undefined)))
    const rows = Array.isArray(body) ? body : record(body) && Array.isArray(body.repos) ? body.repos : record(body) && Array.isArray(body.items) ? body.items : undefined
    if (rows === undefined) return refuse("upstream_malformed", "Smithers Cloud returned an unreadable repository list.")
    candidates.push(...rows.flatMap(row => {
      if (!record(row)) return []
      const name = typeof row.full_name === "string" ? row.full_name : undefined
      // A dot segment would resolve the access read to another Cloud path under the user's bearer.
      if (name === undefined || !isRelayRepoName(name) || seen.has(name)) return []
      seen.add(name)
      return [{ name, pushedAt: typeof row.pushed_at === "string" ? row.pushed_at : "" }]
    }))
    if (rows.length < 100) { complete = true; break }
  }
  if (!complete || candidates.length > ACCESS_BUDGET) return refuse(
    "service_temporarily_unavailable", "Smithers Cloud could not verify this repository inventory within its request budget."
  )
  const diagnoses = yield* Effect.result(Effect.forEach(candidates, candidate => Effect.gen(function* () {
    const response = yield* read(`/api/user/github-access/${candidate.name.split("/").map(encodeURIComponent).join("/")}?surface=issues`)
    if (response.status === 403 || response.status === 404) { yield* discardBody(response); return undefined }
    if (!response.ok) {
      yield* discardBody(response)
      return yield* Effect.fail(json(response.status, { message: "Smithers Cloud could not verify the GitHub App installation. Try again." }))
    }
    const body = yield* readBoundedJson(response, DIAGNOSIS_MAX_BYTES).pipe(Effect.catch(() => Effect.succeed(undefined)))
    if (!record(body) || typeof body.verdict !== "string") return yield* Effect.fail(refuse("upstream_malformed", "Smithers Cloud returned an unreadable GitHub access diagnosis."))
    return { ...candidate, body }
  }), { concurrency: 6 }))
  if (Result.isFailure(diagnoses)) return diagnoses.failure
  for (const status of diagnoses.success) {
    if (status === undefined) continue
    const app = status.body
    if (app.verdict !== "ok" && app.verdict !== "app-not-installed" && typeof app.detail === "string" &&
      (installationId === undefined || String(app.installation_id) === installationId)) blockers.push(app.detail)
    if (app.verdict === "ok" &&
      typeof app.installation_id === "number" && Number.isSafeInteger(app.installation_id) && app.installation_id > 0 &&
      (installationId === undefined || String(app.installation_id) === installationId)) {
      repos.push({ fullName: status.name, pushedAt: status.pushedAt, installationId: app.installation_id })
    }
  }
  return repos.length === 0 && blockers.length > 0 ? refuse("request_conflict", blockers[0] ?? "") : json(200, { repos })
})
