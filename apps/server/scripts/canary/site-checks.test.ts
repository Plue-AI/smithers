import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import {
  APP_CHUNK_EXPECTATION,
  APP_DOCUMENT_CHECK_PATH,
  appChunkPath,
  FRAME_PATH_SAMPLE,
  originFromHostname,
  REDIRECT_HOP_LIMIT,
  renderTable,
  runSiteChecks,
  observeSiteResponse,
  tally
} from "./site-checks.ts"
import type { Fetcher, Observed } from "./site-checks.ts"

import { COMING_SOON_REPOS } from "../../src/publicRepoCatalog"

const ORIGIN = "https://canary.test"

const html = (status: number, headers: Record<string, string> = {}, body?: string): Observed => ({
  status,
  headers: { "content-type": "text/html; charset=utf-8", ...headers },
  ...(body === undefined ? {} : { body })
})
const ISOLATION = { "cross-origin-opener-policy": "same-origin", "cross-origin-embedder-policy": "require-corp" }
/** The prerendered app page: the island's module script is the chunk the probe grades. */
const APP_CHUNK = "/_astro/AppIsland.B1c2d3e4.js"
const APP_DOCUMENT_BODY =
  `<html><head><link rel="stylesheet" href="/_astro/app.C0ffee.css"></head><body><script type="module" src="${APP_CHUNK}"></script></body></html>`
const isolated = html(200, ISOLATION, APP_DOCUMENT_BODY)
/** A hashed chunk as apps/site/public/_headers serves it. */
const chunk = (headers: Record<string, string> = {}): Observed => ({
  status: 200,
  headers: {
    "content-type": "text/javascript; charset=utf-8",
    "cache-control": "public, max-age=31536000, immutable",
    "cross-origin-embedder-policy": "require-corp",
    "cross-origin-resource-policy": "same-origin",
    ...headers
  }
})
const json = (): Observed => ({ status: 200, headers: { "content-type": "application/json" } })
const redirect = (status: number, location: string): Observed => ({ status, headers: { location } })

/** A deployment that answers exactly what the Worker over the site build should. */
const healthy: Record<string, Observed> = {
  ...Object.fromEntries(COMING_SOON_REPOS.map((repo) => [`/${repo.name.toLowerCase()}/`, html(200, {}, "Coming soon")])),
  "/favicon.ico": { status: 200, headers: { "content-type": "image/png" } },
  "/apple-touch-icon.png": { status: 200, headers: { "content-type": "image/png" } },
  "/": html(200),
  "/docs/": redirect(301, "/docs/installation/"),
  "/docs/installation/": html(200),
  "/nope": html(404),
  "/docs/nope/": html(404),
  "/nope/nope/": isolated,
  "/robots.txt": { status: 200, headers: { "content-type": "text/plain" }, body: "User-agent: *\nAllow: /\nSitemap: https://smithers.sh/sitemap-index.xml\n" },
  [APP_DOCUMENT_CHECK_PATH]: isolated,
  [APP_CHUNK]: chunk(),
  [FRAME_PATH_SAMPLE]: isolated,
  "/api/bootstrap": json(),
  "/api/public/repos": json(),
  "/__build.json": json(),
  "/llms.txt": { status: 200, headers: { "content-type": "text/plain" } },
  "/sitemap-index.xml": { status: 200, headers: { "content-type": "application/xml" } },
  "/agents/codex": redirect(301, "/docs/guides/model-seats/"),
  "/docs/guides/model-seats/": html(200),
  "/reference/journal": redirect(301, "/docs/reference/journal/"),
  "/docs/reference/journal/": html(200)
}

const fakeFetch = (table: Record<string, Observed>): { readonly fetch: Fetcher; readonly requested: Array<string> } => {
  const requested: Array<string> = []
  return {
    requested,
    fetch: async (url) => {
      const { pathname } = new URL(url)
      requested.push(pathname)
      return table[pathname] ?? html(404)
    }
  }
}

const failures = (checks: Awaited<ReturnType<typeof runSiteChecks>>) =>
  checks.filter((entry) => entry.status === "fail").map((entry) => `${entry.path}: ${entry.got}`)

describe("the site probe grades a deployment of the Worker over the site build", () => {
  test("a healthy deployment passes every check, and the aliases were followed to a 200", async () => {
    const { fetch, requested } = fakeFetch(healthy)
    const checks = await runSiteChecks(fetch, { origin: ORIGIN, legacyPaths: ["/agents/codex", "/reference/journal"] })
    expect(failures(checks)).toEqual([])
    expect(tally(checks)).toEqual({ passed: 18 + COMING_SOON_REPOS.length, failed: 0 })
    expect(requested).toContain(APP_CHUNK)
    expect(requested).toContain("/docs/guides/model-seats/")
    expect(requested).toContain("/docs/reference/journal/")
  })

  test("the app document without its isolation headers fails, naming the missing header", async () => {
    const { fetch } = fakeFetch({ ...healthy, [APP_DOCUMENT_CHECK_PATH]: html(200, {}, APP_DOCUMENT_BODY) })
    const checks = await runSiteChecks(fetch, { origin: ORIGIN, legacyPaths: [] })
    expect(failures(checks)).toEqual([`${APP_DOCUMENT_CHECK_PATH}: 200 + COOP absent + COEP absent`])
  })

  /*
   * The live regression after the site and the app became one build: the app
   * page was isolated, but its /_astro chunks carried only Cache-Control, so
   * the browser refused the OPFS module worker script
   * (net::ERR_BLOCKED_BY_RESPONSE) and the app fell back to localStorage.
   */
  test("a chunk that only caches fails: the OPFS worker script needs the document's embedder policy", async () => {
    const { fetch } = fakeFetch({
      ...healthy,
      [APP_CHUNK]: {
        status: 200,
        headers: { "content-type": "text/javascript", "cache-control": "public, max-age=31536000, immutable" }
      }
    })
    const checks = await runSiteChecks(fetch, { origin: ORIGIN, legacyPaths: [] })
    expect(failures(checks)).toEqual([`${APP_CHUNK}: 200 + COEP absent + CORP absent`])
    const graded = checks.find((entry) => entry.path === APP_CHUNK)
    expect(graded?.expected).toBe(APP_CHUNK_EXPECTATION)
  })

  test("a chunk with a cross-origin resource policy fails: the worker script is same-origin only", async () => {
    const { fetch } = fakeFetch({ ...healthy, [APP_CHUNK]: chunk({ "cross-origin-resource-policy": "cross-origin" }) })
    const checks = await runSiteChecks(fetch, { origin: ORIGIN, legacyPaths: [] })
    expect(failures(checks)).toEqual([`${APP_CHUNK}: 200 + COEP require-corp + CORP cross-origin`])
  })

  test("an app document that loads no /_astro script fails the chunk check, and a fetcher that read no body says so", async () => {
    const { fetch } = fakeFetch({ ...healthy, [APP_DOCUMENT_CHECK_PATH]: html(200, ISOLATION, "<html><body>no island</body></html>") })
    const checks = await runSiteChecks(fetch, { origin: ORIGIN, legacyPaths: [] })
    expect(failures(checks)).toEqual([`${APP_DOCUMENT_CHECK_PATH} -> /_astro chunk: no /_astro script in the app document`])
    const bodiless = fakeFetch({ ...healthy, [APP_DOCUMENT_CHECK_PATH]: html(200, ISOLATION) })
    const withoutBody = await runSiteChecks(bodiless.fetch, { origin: ORIGIN, legacyPaths: [] })
    expect(failures(withoutBody)).toEqual([`${APP_DOCUMENT_CHECK_PATH} -> /_astro chunk: the fetcher read no document body`])
  })

  test("the chunk is the document's first /_astro module script, never a stylesheet or an external script", () => {
    expect(appChunkPath(APP_DOCUMENT_BODY)).toBe(APP_CHUNK)
    expect(appChunkPath("<script src=\"https://cdn.test/x.js\"></script><script type=\"module\" src=\"/_astro/a.js\"></script>")).toBe("/_astro/a.js")
    expect(appChunkPath("<link rel=\"stylesheet\" href=\"/_astro/a.css\">")).toBeUndefined()
  })

  test("an assets-layer redirect on the app document fails: the Worker did not answer first", async () => {
    const { fetch } = fakeFetch({ ...healthy, [APP_DOCUMENT_CHECK_PATH]: redirect(307, `${APP_DOCUMENT_CHECK_PATH}/`) })
    const checks = await runSiteChecks(fetch, { origin: ORIGIN, legacyPaths: [] })
    expect(failures(checks)).toEqual([
      `${APP_DOCUMENT_CHECK_PATH}: 307 -> ${APP_DOCUMENT_CHECK_PATH}/ + COOP absent + COEP absent`,
      `${APP_DOCUMENT_CHECK_PATH} -> /_astro chunk: the fetcher read no document body`
    ])
  })

  test("a 404 page for the frame path fails: /w/* is not run_worker_first", async () => {
    const { fetch } = fakeFetch({ ...healthy, [FRAME_PATH_SAMPLE]: html(404) })
    const checks = await runSiteChecks(fetch, { origin: ORIGIN, legacyPaths: [] })
    expect(failures(checks)).toEqual([`${FRAME_PATH_SAMPLE}: 404`])
  })

  test("a SPA shell answering an unknown path fails: the build's 404 page is what /nope must serve", async () => {
    const { fetch } = fakeFetch({ ...healthy, "/nope": html(200) })
    const checks = await runSiteChecks(fetch, { origin: ORIGIN, legacyPaths: [] })
    expect(failures(checks)).toEqual(["/nope: 200"])
  })

  test("an HTML answer on an API path fails: the assets layer answered before the Worker", async () => {
    const { fetch } = fakeFetch({ ...healthy, "/api/bootstrap": html(200) })
    const checks = await runSiteChecks(fetch, { origin: ORIGIN, legacyPaths: [] })
    expect(failures(checks)).toEqual(["/api/bootstrap: 200 text/html; charset=utf-8"])
  })

  test("an alias whose redirect lands on a 404 fails and shows the chain", async () => {
    const { fetch } = fakeFetch({ ...healthy, "/reference/journal": redirect(301, "/docs/reference/gone/") })
    const checks = await runSiteChecks(fetch, { origin: ORIGIN, legacyPaths: ["/reference/journal"] })
    expect(failures(checks)).toEqual(["/reference/journal: 301 -> /docs/reference/gone/, 404"])
  })

  test("an alias may take the assets layer's trailing-slash hop after the 301", async () => {
    const { fetch } = fakeFetch({
      ...healthy,
      "/cli/overview": redirect(301, "/docs/reference/cli"),
      "/docs/reference/cli": redirect(308, "/docs/reference/cli/"),
      "/docs/reference/cli/": html(200)
    })
    const checks = await runSiteChecks(fetch, { origin: ORIGIN, legacyPaths: ["/cli/overview"] })
    expect(failures(checks)).toEqual([])
  })

  test("a redirect cycle fails at the hop limit instead of looping", async () => {
    const { fetch, requested } = fakeFetch({ ...healthy, "/loop": redirect(301, "/loop") })
    const checks = await runSiteChecks(fetch, { origin: ORIGIN, legacyPaths: ["/loop"] })
    expect(failures(checks)).toEqual([
      `/loop: ${Array.from({ length: REDIRECT_HOP_LIMIT + 1 }, () => "301 -> /loop").join(", ")} (more than ${REDIRECT_HOP_LIMIT} hops)`
    ])
    expect(requested.filter((path) => path === "/loop")).toHaveLength(REDIRECT_HOP_LIMIT + 1)
  })

  test("a redirect that leaves the site fails", async () => {
    const { fetch } = fakeFetch({ ...healthy, "/away": redirect(301, "https://elsewhere.test/") })
    const checks = await runSiteChecks(fetch, { origin: ORIGIN, legacyPaths: ["/away"] })
    expect(failures(checks)).toEqual(["/away: 301 -> https://elsewhere.test/ (leaves the site)"])
  })

  test("every path in the captured Mintlify sitemap is a same-site path the probe can ask for", () => {
    const legacy = JSON.parse(
      readFileSync(fileURLToPath(new URL("../../../site/src/data/mintlify-paths.json", import.meta.url)), "utf8")
    ) as { readonly paths: ReadonlyArray<string> }
    expect(legacy.paths.length).toBeGreaterThan(100)
    for (const path of legacy.paths) expect(path).toMatch(/^\/[^\s]*$/)
  })
})

describe("the probe's shell helpers", () => {
  test("a bare hostname, an origin, and a local dev URL each name one origin", () => {
    expect(originFromHostname("canary.smithers.sh")).toBe("https://canary.smithers.sh")
    expect(originFromHostname("https://canary.smithers.sh/")).toBe("https://canary.smithers.sh")
    expect(originFromHostname("http://localhost:8787")).toBe("http://localhost:8787")
  })

  test("the table has one row per check under a header, columns aligned", () => {
    const table = renderTable([
      { path: "/", expected: "200", got: "200", status: "pass" },
      { path: "/nope", expected: "404", got: "200", status: "fail" }
    ])
    expect(table.split("\n")).toEqual([
      "verdict  path   expected  got",
      "ok       /      200       200",
      "FAIL     /nope  404       200"
    ])
  })
})


test("the site probe pins every coming-soon page and rejects an app shell in its place", async () => {
  for (const repo of COMING_SOON_REPOS) {
    const path = `/${repo.name.toLowerCase()}/`
    for (const broken of [html(404), isolated]) {
      const { fetch, requested } = fakeFetch({ ...healthy, [path]: broken })
      const checks = await runSiteChecks(fetch, { origin: ORIGIN, legacyPaths: [] })
      expect(requested).toContain(path)
      expect(checks.find((check) => check.path === path)?.status).toBe("fail")
    }
  }
})

test("the site probe rejects HTML at both icon URLs, even a 200 page", async () => {
  for (const path of ["/favicon.ico", "/apple-touch-icon.png"]) {
    const { fetch, requested } = fakeFetch({ ...healthy, [path]: html(200) })
    const checks = await runSiteChecks(fetch, { origin: ORIGIN, legacyPaths: [] })
    expect(requested).toContain(path)
    expect(checks.find((check) => check.path === path)?.status).toBe("fail")
  }
})

for (const [path, broken] of [["/docs/nope/", html(200)], ["/nope/nope/", html(404)], ["/robots.txt", { status: 200, headers: { "content-type": "text/plain" }, body: "User-agent: *\nAllow: /" }]] as const) {
  test(`the site probe rejects the routing regression at ${path}`, async () => {
    const { fetch, requested } = fakeFetch({ ...healthy, [path]: broken })
    const checks = await runSiteChecks(fetch, { origin: ORIGIN, legacyPaths: [] })
    expect(requested).toContain(path)
    expect(checks.find((check) => check.path === path)?.status).toBe("fail")
    expect(failures(checks)).toHaveLength(1)
  })
}

test("the live probe reads robots text as well as app HTML, and cancels binary bodies", async () => {
  for (const type of ["text/plain; charset=utf-8", "text/html"]) {
    const observed = await observeSiteResponse(new Response("Sitemap: https://smithers.sh/sitemap-index.xml", { headers: { "content-type": type } }))
    expect(observed.body).toContain("Sitemap:")
  }
  const binary = new Response("image", { headers: { "content-type": "image/png" } })
  expect((await observeSiteResponse(binary)).body).toBeUndefined()
  expect(binary.bodyUsed).toBe(true)
})
