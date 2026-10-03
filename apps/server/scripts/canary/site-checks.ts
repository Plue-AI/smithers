/*
 * The pure half of the site probe: what one deployment of `smithers-mvp-web`
 * must answer now that its assets are the smithers.sh Astro build, graded from
 * recorded observations. site-probe.ts supplies the real fetch and prints; the
 * tests beside this file supply a fake. The split is the one every probe in
 * this directory uses, so the verdicts are demonstrated without a deployment.
 *
 * Three families, each a claim about a different layer:
 *
 *   the site      / and /docs/ answer 200, /nope answers 404 (the build's 404
 *                 page, not a SPA shell), /llms.txt and /sitemap-index.xml exist
 *   the app       the catalog repository page answers 200 with the isolation
 *                 headers OPFS needs, the /_astro chunk that page loads answers
 *                 200 with the embedder and resource policies the OPFS module
 *                 worker script needs, a frame path answers 200 (a reload
 *                 inside the app), and the Worker, not the assets layer,
 *                 answers /api/*
 *   the aliases   every path the former Mintlify site indexed answers 200, or
 *                 redirects to a path that answers 200 within a few hops
 */
import { DEFAULT_APP_DOCUMENT_PATH } from "../../src/appDocument.ts"
import { COMING_SOON_REPOS, PUBLIC_REPOS_PATH } from "../../src/publicRepoCatalog.ts"
import { BUILD_STAMP_PATH } from "./BuildStamp.ts"

export interface Observed {
  readonly status: number
  readonly headers: Readonly<Record<string, string>>
  /** The response text, when the fetcher read it; the app document's is scanned for its chunks. */
  readonly body?: string
}

/** Read the textual bodies the probe grades; release all other response streams. */
export const observeSiteResponse = async (response: Response): Promise<Observed> => {
  const headers = Object.fromEntries(response.headers.entries())
  if ((headers["content-type"] ?? "").startsWith("text/")) {
    return { status: response.status, headers, body: await response.text() }
  }
  await response.body?.cancel()
  return { status: response.status, headers }
}

/** One fetch, redirects NOT followed: a redirect is a verdict of its own. */
export type Fetcher = (url: string) => Promise<Observed>

export interface SiteCheck {
  readonly path: string
  readonly expected: string
  readonly got: string
  readonly status: "pass" | "fail"
}

export const APP_DOCUMENT_CHECK_PATH = DEFAULT_APP_DOCUMENT_PATH.replace(/\/$/, "")
export const FRAME_PATH_SAMPLE = "/w/a/b/b/f/c"
export const REDIRECT_HOP_LIMIT = 4

const header = (observed: Observed, name: string): string | undefined => {
  const lower = name.toLowerCase()
  for (const [key, value] of Object.entries(observed.headers)) if (key.toLowerCase() === lower) return value
  return undefined
}

const describeStatus = (observed: Observed): string => {
  const location = header(observed, "location")
  return location === undefined ? `${observed.status}` : `${observed.status} -> ${location}`
}

const check = (path: string, expected: string, ok: boolean, got: string): SiteCheck => ({
  path,
  expected,
  got,
  status: ok ? "pass" : "fail"
})

const expectStatus = async (fetch: Fetcher, origin: string, path: string, status: number): Promise<SiteCheck> => {
  const observed = await fetch(`${origin}${path}`)
  return check(path, `${status}`, observed.status === status, describeStatus(observed))
}

const expectAppDocument = (path: string, observed: Observed): SiteCheck => {
  const coop = header(observed, "cross-origin-opener-policy")
  const coep = header(observed, "cross-origin-embedder-policy")
  const ok = observed.status === 200 && coop === "same-origin" && coep === "require-corp"
  return check(
    path,
    "200 + COOP same-origin + COEP require-corp",
    ok,
    `${describeStatus(observed)} + COOP ${coop ?? "absent"} + COEP ${coep ?? "absent"}`
  )
}

/** The first script chunk the app document loads from the build's hashed-asset directory. */
export const appChunkPath = (document: string): string | undefined =>
  /<script[^>]*\ssrc="(\/_astro\/[^"]+\.js)"/.exec(document)?.[1]

export const APP_CHUNK_EXPECTATION = "200 + COEP require-corp + CORP same-origin (a /_astro chunk, as the OPFS worker script)"

/*
 * The app document is cross-origin isolated, and its OPFS SQLite persistence
 * starts a dedicated module worker from a chunk under /_astro. The browser
 * refuses a worker script whose response carries no embedder policy at least
 * as strict as its owner's (net::ERR_BLOCKED_BY_RESPONSE), and the app falls
 * back to localStorage without failing. The worker chunk is named only inside
 * another chunk, so the probe grades the first chunk the document itself
 * loads: apps/site/public/_headers gives every /_astro path the same headers,
 * so one chunk stands for all of them, the worker script included.
 */
const expectAppChunk = async (fetch: Fetcher, origin: string, documentPath: string, document: Observed): Promise<SiteCheck> => {
  const path = document.body === undefined ? undefined : appChunkPath(document.body)
  if (path === undefined) {
    const got = document.body === undefined ? "the fetcher read no document body" : "no /_astro script in the app document"
    return check(`${documentPath} -> /_astro chunk`, APP_CHUNK_EXPECTATION, false, got)
  }
  const observed = await fetch(`${origin}${path}`)
  const coep = header(observed, "cross-origin-embedder-policy")
  const corp = header(observed, "cross-origin-resource-policy")
  const ok = observed.status === 200 && coep === "require-corp" && corp === "same-origin"
  return check(path, APP_CHUNK_EXPECTATION, ok, `${describeStatus(observed)} + COEP ${coep ?? "absent"} + CORP ${corp ?? "absent"}`)
}

const expectWorkerJson = async (fetch: Fetcher, origin: string, path: string): Promise<SiteCheck> => {
  // The assets layer never answers JSON for these paths; a 200 with a JSON
  // content type is the Worker's, and proves run_worker_first covers /api/.
  const observed = await fetch(`${origin}${path}`)
  const type = header(observed, "content-type") ?? "absent"
  const ok = observed.status === 200 && type.includes("application/json")
  return check(path, "200 application/json (the Worker, not the assets layer)", ok, `${describeStatus(observed)} ${type}`)
}

/**
 * A legacy alias answers 200 itself, or redirects (301/308) into a path that
 * answers 200 within REDIRECT_HOP_LIMIT hops. The assets layer adds a
 * trailing-slash hop of its own (308) after a _redirects 301, so one hop is
 * not enough and an unbounded chain is a cycle.
 */
const expectAlias = async (fetch: Fetcher, origin: string, path: string): Promise<SiteCheck> => {
  const hops: Array<string> = []
  let current = path
  for (let hop = 0; hop <= REDIRECT_HOP_LIMIT; hop += 1) {
    const observed = await fetch(`${origin}${current}`)
    hops.push(describeStatus(observed))
    if (observed.status === 200) return check(path, "200, or a redirect chain ending in 200", true, hops.join(", "))
    const location = header(observed, "location")
    if (![301, 302, 307, 308].includes(observed.status) || location === undefined) {
      return check(path, "200, or a redirect chain ending in 200", false, hops.join(", "))
    }
    const next = new URL(location, origin)
    if (next.origin !== new URL(origin).origin) {
      return check(path, "200, or a redirect chain ending in 200", false, `${hops.join(", ")} (leaves the site)`)
    }
    current = `${next.pathname}${next.search}`
  }
  return check(path, "200, or a redirect chain ending in 200", false, `${hops.join(", ")} (more than ${REDIRECT_HOP_LIMIT} hops)`)
}

const expectComingSoon = async (fetch: Fetcher, origin: string, path: string): Promise<SiteCheck> => {
  const observed = await fetch(`${origin}${path}`)
  const ok = observed.status === 200 && (header(observed, "content-type") ?? "").includes("text/html") &&
    /coming soon/i.test(observed.body ?? "") && header(observed, "cross-origin-embedder-policy") === undefined
  return check(path, "200 coming-soon page", ok, `${describeStatus(observed)} ${ok ? "coming soon" : "missing coming-soon page"}`)
}

const expectIcon = async (fetch: Fetcher, origin: string, path: string): Promise<SiteCheck> => {
  const observed = await fetch(`${origin}${path}`)
  const type = header(observed, "content-type") ?? "absent"
  return check(path, "200 image", observed.status === 200 && type.startsWith("image/"), `${describeStatus(observed)} ${type}`)
}

const expectRobots = async (fetch: Fetcher, origin: string): Promise<SiteCheck> => {
  const path = "/robots.txt"
  const observed = await fetch(`${origin}${path}`)
  const sitemap = (observed.body ?? "").includes("Sitemap:")
  return check(path, "200 with Sitemap:", observed.status === 200 && sitemap, `${describeStatus(observed)} + Sitemap: ${sitemap ? "present" : "absent"}`)
}

export interface SiteProbeInput {
  readonly origin: string
  readonly legacyPaths: ReadonlyArray<string>
}

export const runSiteChecks = async (fetch: Fetcher, input: SiteProbeInput): Promise<ReadonlyArray<SiteCheck>> => {
  const { origin } = input
  const appDocument = await fetch(`${origin}${APP_DOCUMENT_CHECK_PATH}`)
  const fixed = await Promise.all([
    ...COMING_SOON_REPOS.map((repo) => expectComingSoon(fetch, origin, `/${repo.name.toLowerCase()}/`)),
    expectIcon(fetch, origin, "/favicon.ico"),
    expectIcon(fetch, origin, "/apple-touch-icon.png"),
    expectStatus(fetch, origin, "/", 200),
    // /docs/ redirects to the docs entry page since #3458; any on-site chain to a 200 passes.
    expectAlias(fetch, origin, "/docs/"),
    expectStatus(fetch, origin, "/nope", 404),
    expectStatus(fetch, origin, "/docs/nope/", 404),
    expectStatus(fetch, origin, "/nope/nope/", 200),
    expectRobots(fetch, origin),
    expectAppDocument(APP_DOCUMENT_CHECK_PATH, appDocument),
    expectAppChunk(fetch, origin, APP_DOCUMENT_CHECK_PATH, appDocument),
    expectStatus(fetch, origin, FRAME_PATH_SAMPLE, 200),
    expectWorkerJson(fetch, origin, "/api/bootstrap"),
    expectWorkerJson(fetch, origin, PUBLIC_REPOS_PATH),
    expectStatus(fetch, origin, BUILD_STAMP_PATH, 200),
    expectStatus(fetch, origin, "/llms.txt", 200),
    expectStatus(fetch, origin, "/sitemap-index.xml", 200)
  ])
  const aliases: Array<SiteCheck> = []
  // Sequential on purpose: a few hundred paths in one burst is a load test of
  // the deployment, and this probe grades routing, not capacity.
  for (const path of input.legacyPaths) aliases.push(await expectAlias(fetch, origin, path))
  return [...fixed, ...aliases]
}

/** `canary.smithers.sh`, `https://canary.smithers.sh/`, or `http://localhost:8787` all name one origin. */
export const originFromHostname = (value: string): string => {
  const withScheme = /^[a-z]+:\/\//i.test(value) ? value : `https://${value}`
  return new URL(withScheme).origin
}

/** The table the probe prints: one row per check, columns padded to the widest value. */
export const renderTable = (checks: ReadonlyArray<SiteCheck>): string => {
  const rows = [["verdict", "path", "expected", "got"], ...checks.map((entry) => [
    entry.status === "pass" ? "ok" : "FAIL",
    entry.path,
    entry.expected,
    entry.got
  ])]
  const widths = rows[0]!.map((_, column) => Math.max(...rows.map((row) => row[column]!.length)))
  return rows.map((row) => row.map((cell, column) => cell.padEnd(widths[column]!)).join("  ").trimEnd()).join("\n")
}

export const tally = (checks: ReadonlyArray<SiteCheck>): { readonly passed: number; readonly failed: number } => ({
  passed: checks.filter((entry) => entry.status === "pass").length,
  failed: checks.filter((entry) => entry.status === "fail").length
})
