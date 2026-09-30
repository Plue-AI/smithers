import { describe, expect, test, spyOn } from "bun:test"
import { readFileSync } from "node:fs"
import { memoryDurableObjects } from "./memoryDurableObjects"
import worker, { type WorkerEnv } from "./index"
import { AVAILABLE_REPOS, COMING_SOON_REPOS } from "./publicRepoCatalog"
import { readWranglerConfig } from "./wranglerConfig"

const app = '<html><body><div id="root">app shell</div></body></html>'
const html = { "content-type": "text/html; charset=utf-8" }
const siteEnv = (): WorkerEnv => ({
  ...memoryDurableObjects(),
  ASSETS: { fetch: async (request) => {
    const path = new URL(request.url).pathname
    if (path === "/smithersai/smithers/") return new Response(app, { headers: html })
    if (COMING_SOON_REPOS.some((repo) => path === `/${repo.name.toLowerCase()}/`)) {
      return new Response("<html><body>Coming soon</body></html>", { headers: html })
    }
    if (["/", "/docs/", "/docs/pricing/"].includes(path)) return new Response("<html>site</html>", { headers: html })
    if (path === "/__build.json") return Response.json({ gitSha: "a".repeat(40), builtAt: "2026-09-14" })
    if (path === "/favicon.png" || path === "/icon.png") return new Response(readFileSync(new URL(`../../site/public${path}`, import.meta.url)), { headers: { "content-type": "image/png" } })
    return new Response("<html>There is no page at this address</html>", { status: 404, headers: html })
  } }
})

// Model the deployment's navigation decision too: a handler alone cannot prove
// these pages are reachable when assets_navigation_prefers_asset_serving is on.
const navigate = (path: string, env: WorkerEnv) => {
  const request = new Request(`https://smithers.sh${path}`, { headers: { "sec-fetch-mode": "navigate" } })
  const patterns = readWranglerConfig().assets.run_worker_first
  const first = patterns.some((pattern) => new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`).test(path))
  return first ? worker.fetch(request, env) : env.ASSETS.fetch(request)
}

describe("repository navigation regressions", () => {
  test("any GitHub repository slug reaches the app for visitors and signed-in users", async () => {
    for (const path of ["/codeplanesmithers/canary-sandbox/", "/Someone/Their.Repo_1", "/smithersai/other/", "/wevm/other/", `/${"a".repeat(39)}/${"r".repeat(100)}/`]) {
      for (const signedIn of [false, true]) {
        const response = await worker.fetch(new Request(`https://smithers.sh${path}`, { headers: signedIn ? { cookie: "smithers_session=fixture" } : {} }), siteEnv())
        expect([path, response.status, await response.text()]).toEqual([path, 200, app])
        expect(response.headers.get("cross-origin-embedder-policy")).toBe("require-corp")
      }
      expect((await navigate(path, siteEnv())).status).toBe(200)
    }
  })

  test("malformed repository paths keep the real 404 and real site pages still win", async () => {
    for (const path of ["/missing", "/owner/repo/extra", "/smithersai/", "/bad_owner/repo/", "/-owner/repo/", "/owner-/repo/", "/two--hyphens/repo/", "/owner/not%20a-slug/", `/${"a".repeat(40)}/repo/`, `/owner/${"r".repeat(101)}/`]) {
      expect([path, (await worker.fetch(new Request(`https://smithers.sh${path}`), siteEnv())).status]).toEqual([path, 404])
    }
    const response = await worker.fetch(new Request("https://smithers.sh/docs/pricing/"), siteEnv())
    expect(await response.text()).toBe("<html>site</html>")
    expect(response.headers.get("cross-origin-embedder-policy")).toBeNull()
  })

  test("every coming-soon page reaches its own site document", async () => {
    for (const repo of COMING_SOON_REPOS) {
      const response = await navigate(`/${repo.name.toLowerCase()}/`, siteEnv())
      expect([repo.name, response.status, await response.text()]).toEqual([repo.name, 200, "<html><body>Coming soon</body></html>"])
      expect(response.headers.get("cross-origin-embedder-policy")).toBeNull()
    }
  })

  test("all catalog casing variants redirect permanently to lowercase, keeping the query", async () => {
    for (const repo of [...AVAILABLE_REPOS, ...COMING_SOON_REPOS]) {
      const response = await navigate(`/${repo.name.toUpperCase()}/?tutorial`, siteEnv())
      expect([response.status, response.headers.get("location")]).toEqual([301, `https://smithers.sh/${repo.name.toLowerCase()}/?tutorial`])
    }
  })
})

describe("HTML headers and platform gaps", () => {
  test("every HTML response, including the site 404, gets the common security headers", async () => {
    for (const path of ["/", "/docs/", "/docs/pricing/", "/smithersai/smithers/", "/someone/repo/", "/wevm/incur/", "/missing"]) {
      const response = await navigate(path, siteEnv())
      expect(response.headers.get("strict-transport-security")).toBe("max-age=31536000; includeSubDomains")
      expect(response.headers.get("x-content-type-options")).toBe("nosniff")
      expect(response.headers.get("referrer-policy")).toBe("strict-origin-when-cross-origin")
      expect(response.headers.get("content-security-policy")).toBeNull()
    }
  })

  test("icon aliases return the site's actual PNG bytes instead of HTML", async () => {
    for (const [path, asset] of [["/favicon.ico", "favicon.png"], ["/apple-touch-icon.png", "icon.png"]]) {
      const response = await navigate(path!, siteEnv())
      expect(response.status).toBe(200)
      expect(response.headers.get("content-type")).toBe("image/png")
      expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array(readFileSync(new URL(`../../site/public/${asset}`, import.meta.url))))
    }
  })

  test("bootstrap reports the same build stamp as the deployed asset, even with a stale binding", async () => {
    for (const configured of [undefined, "old-build"]) {
      const env = { ...siteEnv(), ...(configured ? { SMITHERS_BUILD_SHA: configured } : {}) }
      const stamp = await (await worker.fetch(new Request("https://smithers.sh/__build.json"), env)).json() as { gitSha: string }
      const bootstrap = await (await worker.fetch(new Request("https://smithers.sh/api/bootstrap"), env)).json() as { buildSha: string }
      expect(bootstrap.buildSha).toBe(stamp.gitSha)
    }
  })

  test("requests without a cf-visitor http scheme never redirect", async () => {
    for (const origin of ["http://localhost:8788", "http://canary.smithers.sh", "https://smithers.sh"]) {
      for (const visitor of [undefined, "invalid JSON", "null", "{}", '{"scheme":"https"}', '{"scheme":false}']) {
        // This checkout has no health handler; preserve its 404 instead of redirecting.
        for (const [path, status] of [["/api/health", 404], ["/api/bootstrap", 200]] as const) {
          const response = await worker.fetch(new Request(origin + path, { headers: visitor === undefined ? {} : { "cf-visitor": visitor } }), siteEnv())
          expect([origin, visitor, response.status, response.headers.get("location")]).toEqual([origin, visitor, status, null])
        }
      }
    }
    const response = await worker.fetch(new Request("http://smithers.sh/x", { headers: { "cf-visitor": '{"scheme":"https"}' } }), siteEnv())
    expect([response.status, response.headers.get("location")]).toEqual([404, null])
  })

  test("HTTP and www redirect before the assets or API execute, retaining path and query", async () => {
    for (const origin of ["http://smithers.sh", "http://www.smithers.sh", "https://www.smithers.sh"]) {
      for (const path of ["/x", "/docs/?q=hello", "/api/bootstrap"]) {
        const headers: HeadersInit = origin.startsWith("http:") ? { "cf-visitor": '{"scheme":"http"}' } : {}
        const response = await worker.fetch(new Request(origin + path, { headers }), { ...memoryDurableObjects(), ASSETS: { fetch: async () => { throw new Error("must redirect first") } } })
        expect([response.status, response.headers.get("location")]).toEqual([301, "https://smithers.sh" + path])
      }
    }
    const devResponse = await worker.fetch(new Request("http://canary.smithers.sh/api/bootstrap"), siteEnv())
    expect([devResponse.status, devResponse.headers.get("location")]).toEqual([200, null])
    expect(readWranglerConfig().routes.some((route) => route.pattern === "www.smithers.sh/*")).toBe(true)
  })
})

describe("catalog reads use one mirror regardless of session", () => {
  test("tree, file, factory, and bridge reads alias only the catalog and preserve query and credentials", async () => {
    const seen: Request[] = []
    const mock = spyOn(globalThis, "fetch").mockImplementation((async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init)
      const url = new URL(request.url)
      if (url.pathname === "/api/identity/validate") return Response.json({ valid: true, login: "codeplanesmithers", admin: false })
      if (url.pathname === "/api/identity/cloud-token") return Response.json({ found: true, token: "fixture-cloud-token" })
      seen.push(request)
      return Response.json({ path: url.pathname })
    }) as typeof fetch)
    try {
      const env = { ...siteEnv(), IDENTITY_UPSTREAM_URL: "https://identity.test", IDENTITY_SERVICE_TOKEN: "fixture-service-token", SMITHERS_CLOUD_API_BASE_URL: "https://cloud.test" }
      for (const prefix of ["/api", "/api/cloud/api"]) for (const signedIn of [false, true]) {
        for (const repo of ["smithersai/smithers", "SmithersAI/Smithers", "codeplanesmithers/canary-sandbox"]) {
          for (const suffix of ["/contents", "/contents/Cargo.toml", "/contents/.smithers/factory.json", "/git/trees/main"]) {
            const response = await worker.fetch(new Request(`https://smithers.sh${prefix}/repos/${repo}${suffix}?ref=main`, { headers: signedIn ? { cookie: "smithers_session=fixture" } : {} }), env)
            expect(response.status).toBe(200)
            const sent = seen.at(-1)!
            const expected = repo.toLowerCase() === "smithersai/smithers" ? "smithers-canary/smithers" : repo
            expect(sent.url).toBe(`https://cloud.test/api/repos/${expected}${suffix}?ref=main`)
            expect(sent.headers.get("authorization")).toBe(signedIn ? "Bearer fixture-cloud-token" : null)
          }
        }
      }
    } finally { mock.mockRestore() }
  })
})
