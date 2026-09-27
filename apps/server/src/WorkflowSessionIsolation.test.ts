import { describe, expect, test } from "bun:test"
import worker from "./index"
import { memoryDurableObjects } from "./memoryDurableObjects"

const SETTINGS = {
  ASSETS: { fetch: async () => new Response("SPA") },
  IDENTITY_UPSTREAM_URL: "https://identity.test",
  IDENTITY_SERVICE_TOKEN: "synthetic-identity-service",
  SMITHERS_CLOUD_API_BASE_URL: "https://cloud.test"
}
const BOX = "83e75ae5-0920-4000-8000-00000000000b"

describe("the per-user workflow and setup routes", () => {
  for (const path of ["/api/workflow/provision", "/api/workflow/rpc", "/api/repository-setup/inspect"]) {
    for (const caller of ["anonymous", "expired", "not-allowlisted", "alice", "bob"]) {
      test(`${path} derives authority from the validated ${caller} session, never a supplied login`, async () => {
        const seen: Array<{ url: string; authorization: string | null; login: string | null }> = []
        const original = globalThis.fetch
        globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
          const request = input instanceof Request ? input : new Request(String(input), init)
          const url = new URL(request.url)
          if (url.hostname === "identity.test") {
            expect(request.headers.get("x-user-login")).toBeNull()
            expect(request.headers.get("authorization")).toBeNull()
            expect(request.headers.get("x-smithers-service-token")).toBe("synthetic-identity-service")
            if (url.pathname === "/api/identity/cloud-token") {
              const { login } = await request.json() as { login: string }
              return Response.json({ found: true, token: `synthetic-${login}-token` })
            }
            expect(url.pathname).toBe("/api/identity/validate")
            const login = request.headers.get("cookie")?.split("=")[1]
            if (login === undefined || login === "expired") return Response.json({}, { status: 401 })
            return Response.json({ login, allowlisted: login !== "not-allowlisted", admin: false })
          }
          if (url.hostname !== "cloud.test") throw new Error("Unexpected upstream in isolation test")
          seen.push({ url: request.url, authorization: request.headers.get("authorization"), login: request.headers.get("x-user-login") })
          return Response.json({ ok: true, payload: { runs: [] } })
        }) as typeof fetch
        try {
          const forgedLogin = caller === "alice" ? "bob" : "alice"
          const headers = new Headers({
            "content-type": "application/json",
            "x-user-login": forgedLogin,
            "x-user-id": forgedLogin,
            authorization: "Bearer forged"
          })
          if (caller !== "anonymous") headers.set("cookie", `smithers_session=${caller}`)
          const response = await worker.fetch(
            new Request(`https://app.test${path}`, {
              method: "POST",
              headers,
              body: JSON.stringify({ repo: "org/repo", workspaceId: BOX, procedure: "List", payload: {}, login: forgedLogin })
            }),
            { ...SETTINGS, ...memoryDurableObjects() }
          )
          const text = await response.text()
          if (caller === "anonymous" || caller === "expired") {
            expect(response.status).toBe(401)
            expect(seen).toEqual([])
          } else if (caller === "not-allowlisted") {
            expect(response.status).toBe(403)
            expect(seen).toEqual([])
          } else {
            expect(response.status).toBe(200)
            expect(seen).toEqual([{ url: `https://cloud.test${path}`, authorization: `Bearer synthetic-${caller}-token`, login: null }])
          }
          expect(text).not.toContain("synthetic-")
        } finally {
          globalThis.fetch = original
        }
      })
    }
  }
})
