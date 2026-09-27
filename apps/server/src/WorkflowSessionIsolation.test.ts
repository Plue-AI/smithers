import { afterEach, describe, expect, test } from "bun:test"
import worker from "./index"
import { memoryDurableObjects } from "./memoryDurableObjects"

const SETTINGS = {
  ASSETS: { fetch: async () => new Response("SPA") },
  IDENTITY_UPSTREAM_URL: "https://identity.test",
  IDENTITY_SERVICE_TOKEN: "synthetic-identity-service",
  SMITHERS_CLOUD_API_BASE_URL: "https://cloud.test"
}
const durable = memoryDurableObjects({ env: SETTINGS })
const BOX = "83e75ae5-0920-4000-8000-00000000000b"

afterEach(() => durable.reset())

describe("supported per-user workflow relay", () => {
  for (const path of ["/api/workflow/provision", "/api/workflow/rpc"]) {
    for (const caller of ["anonymous", "expired", "not-allowlisted", "alice", "bob"]) {
      test(`${path} derives authority from the validated ${caller} session, never a supplied login`, async () => {
        const now = Date.now()
        for (const login of ["alice", "bob"]) {
          await durable.seedGatewayRecord(login, "org/repo", {
            gatewayId: `gateway-${login}`,
            workspaceId: BOX,
            baseUrl: `https://cloud.test/api/gateways/gateway-${login}`,
            token: `synthetic-${login}-token`,
            vmId: null,
            expiresAt: now + 3_600_000,
            renewAfter: now + 1_800_000,
            provisionedAt: now
          })
        }
        const seen: Array<{ url: string; authorization: string | null }> = []
        const original = globalThis.fetch
        globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
          const request = input instanceof Request ? input : new Request(String(input), init)
          const url = new URL(request.url)
          if (url.hostname === "identity.test") {
            expect(url.pathname).toBe("/api/identity/validate")
            expect(request.headers.get("x-user-login")).toBeNull()
            expect(request.headers.get("authorization")).toBeNull()
            expect(request.headers.get("x-smithers-service-token")).toBe("synthetic-identity-service")
            const login = request.headers.get("cookie")?.split("=")[1]
            if (login === undefined || login === "expired") return Response.json({}, { status: 401 })
            return Response.json({ login, allowlisted: login !== "not-allowlisted", admin: false })
          }
          if (url.hostname !== "cloud.test" || !url.pathname.startsWith("/api/gateways/")) throw new Error("Unexpected upstream in isolation test")
          seen.push({ url: request.url, authorization: request.headers.get("authorization") })
          return new Response(
            JSON.stringify({ _tag: "Exit", requestId: 1, exit: { _tag: "Success", value: { runs: [] } } }) + "\n"
          )
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
            { ...SETTINGS, GATEWAY_SESSIONS: durable.GATEWAY_SESSIONS, TURN_CANCELS: durable.TURN_CANCELS }
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
            if (path.endsWith("/rpc")) {
              expect(seen).toEqual([{
                url: `https://cloud.test/api/gateways/gateway-${caller}/rpc`,
                authorization: `Bearer synthetic-${caller}-token`
              }])
            } else {
              expect(JSON.parse(text)).toMatchObject({ status: "ready", gatewayId: `gateway-${caller}` })
              // `ready` is the gateway's own answer, so provision asks it —
              // on the caller's box, with the caller's credential, never the
              // forged login's.
              expect(seen).toEqual([{
                url: `https://cloud.test/api/gateways/gateway-${caller}/health`,
                authorization: `Bearer synthetic-${caller}-token`
              }])
            }
          }
          expect(text).not.toContain("synthetic-")
        } finally {
          globalThis.fetch = original
        }
      })
    }
  }
})
