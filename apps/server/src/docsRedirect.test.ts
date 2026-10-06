import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { describe, expect, test } from "bun:test"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import { buildRedirectMap, legacySites, README_URL as SCRIPT_README_URL, renderModule } from "../../../scripts/package-docs.mjs"
import { answerIsUnclaimed, decide, handleDocsRedirect, UNCLAIMED_MARKER } from "./docsRedirect"
import type { DocsRedirectEnv } from "./docsRedirect"
import { DOCS_REDIRECTS, README_URL } from "./docsRedirectMap"
import { Transport, transportFrom } from "./Http"
import { parseWranglerConfig } from "./wranglerConfig"

const REPO = "https://github.com/smithersai/smithers/"
const ZONE_ID = "8ebd98d2f0dc7d8db2e61f31ebc19c14"

type Seen = { readonly url: string; readonly host: string | null }

/** Runs the handler over a recording transport; `answer` stands in for origins and DNS. */
const run = (request: Request, env: DocsRedirectEnv, answer: (url: URL) => Response = () => new Response("origin", { status: 200 })) => {
  const seen: Array<Seen> = []
  const transport = transportFrom((input) => {
    const outgoing = input instanceof Request ? input : new Request(input)
    seen.push({ url: outgoing.url, host: new URL(outgoing.url).host })
    return Promise.resolve(answer(new URL(outgoing.url)))
  })
  return Effect.runPromise(handleDocsRedirect(request, env).pipe(Effect.provide(Layer.succeed(Transport, transport))))
    .then(response => ({ response, seen }))
}

const OFF: DocsRedirectEnv = { UNKNOWN_SLUGS: "off" }
const ON: DocsRedirectEnv = { UNKNOWN_SLUGS: "txt-marker" }

const dnsAnswer = (hostname: string, data: string, status = 0) =>
  Response.json({ Status: status, Answer: [{ name: `${hostname}.`, type: 16, TTL: 300, data: JSON.stringify(data) }] })

describe("known slugs", () => {
  test("a slug and a deep path answer 301 to exactly that package's docs folder", async () => {
    const { response, seen } = await run(new Request("https://engine.smithers.sh/concepts/retries/?x=1#y"), OFF)
    expect(response.status).toBe(301)
    expect(response.headers.get("location")).toBe("https://github.com/smithersai/smithers/tree/main/packages/smithers/flows/engine/docs")
    expect(seen).toEqual([])
  })

  test("the legacy aliases keep their old hostnames", async () => {
    for (const [host, dir] of [["smithers-patterns", "packages/smithers/flows/patterns"], ["smithers-sync", "packages/smithers/flows/sync"], ["cli", "packages/smithers"]]) {
      const { response } = await run(new Request(`https://${host}.smithers.sh/`), OFF)
      expect(response.headers.get("location")).toBe(`${REPO}tree/main/${dir}/docs`)
    }
  })

  test("the path never reaches the Location: traversal, encoded and scheme-relative paths", async () => {
    const expected = DOCS_REDIRECTS.get("flow")
    for (const path of ["/../../evil", "/%2e%2e/%2e%2e/evil", "/..%2f..%2fevil", "//evil.example/x", "/%0d%0aSet-Cookie:x=1", "/@evil.example", "/\\evil.example"]) {
      const { response } = await run(new Request(`https://flow.smithers.sh${path}`), OFF)
      expect(response.status).toBe(301)
      expect(response.headers.get("location")).toBe(expected!)
    }
  })

  test("every Location is the repository, built from the map, never from the Host", () => {
    for (const [slug, location] of DOCS_REDIRECTS) {
      expect(location.startsWith(`${REPO}tree/main/`)).toBe(true)
      expect(location.endsWith("/docs")).toBe(true)
      expect(location).not.toContain(`${slug}.smithers.sh`)
      expect(new URL(location).host).toBe("github.com")
    }
    expect(README_URL).toBe(`${REPO}blob/main/README.md`)
  })

  test("hostname casing and an explicit default port select the same slug", async () => {
    const { response } = await run(new Request("https://FLOW.Smithers.SH:443/"), OFF)
    expect(response.headers.get("location")).toBe(DOCS_REDIRECTS.get("flow")!)
  })
})

describe("every other hostname passes through unchanged", () => {
  test("non-slug hosts, look-alikes and deeper names reach their origin untouched", async () => {
    for (const url of ["https://smithers.sh/docs", "https://build.smithers.sh/cache", "https://status.smithers.sh/",
      "https://flow.smithers.sh.evil.example/", "https://evilflow.smithers.sh/", "https://x.flow.smithers.sh/",
      "https://flow.smithers.sh./", "https://flow.example.com/"]) {
      for (const env of [OFF, ON]) {
        // Under txt-marker a single-label name is first checked in DNS; no marker, so it still passes.
        const { response, seen } = await run(new Request(url, { method: "POST", body: "payload" }), env,
          target => target.host === "cloudflare-dns.com" ? Response.json({ Status: 0 }) : new Response("origin", { status: 207 }))
        expect(response.status).toBe(207)
        expect(await response.text()).toBe("origin")
        expect(seen.filter(s => s.host !== "cloudflare-dns.com")).toEqual([{ url, host: new URL(url).host }])
        if (env === OFF) expect(seen).toHaveLength(1)
      }
    }
  })

  test("a method, body and headers arrive at the origin as sent", async () => {
    let received: { method: string; body: string; cookie: string | null } | undefined
    const transport = transportFrom(async (input) => {
      const request = input as Request
      received = { method: request.method, body: await request.text(), cookie: request.headers.get("cookie") }
      return new Response(null, { status: 204 })
    })
    const response = await Effect.runPromise(handleDocsRedirect(
      new Request("https://status.smithers.sh/api", { method: "PUT", body: "x=1", headers: { cookie: "a=b" } }), OFF
    ).pipe(Effect.provide(Layer.succeed(Transport, transport))))
    expect(response.status).toBe(204)
    expect(received).toEqual({ method: "PUT", body: "x=1", cookie: "a=b" })
  })

  test("an unreachable origin is a 502, not a redirect", async () => {
    const transport = transportFrom(() => Promise.reject(new Error("connect refused")))
    const response = await Effect.runPromise(handleDocsRedirect(new Request("https://status.smithers.sh/"), OFF)
      .pipe(Effect.provide(Layer.succeed(Transport, transport))))
    expect(response.status).toBe(502)
  })
})

describe("unknown slugs", () => {
  test("off by default: an unknown single-label host passes through and DNS is never asked", async () => {
    for (const env of [OFF, {}]) {
      const { response, seen } = await run(new Request("https://unknown-docs-slug.smithers.sh/deep"), env)
      expect(response.status).toBe(200)
      expect(seen.map(s => s.host)).toEqual(["unknown-docs-slug.smithers.sh"])
    }
  })

  test("txt-marker: a name that only the wildcard answers goes to the README", async () => {
    const { response, seen } = await run(new Request("https://unknown-a.smithers.sh/deep/path"), ON,
      url => dnsAnswer(url.searchParams.get("name")!, UNCLAIMED_MARKER))
    expect(response.status).toBe(301)
    expect(response.headers.get("location")).toBe(README_URL)
    expect(seen.map(s => s.host)).toEqual(["cloudflare-dns.com"])
  })

  test("txt-marker: a name with its own record (no marker) passes through", async () => {
    const { response, seen } = await run(new Request("https://claimed-b.smithers.sh/"), ON,
      url => url.host === "cloudflare-dns.com" ? Response.json({ Status: 0 }) : new Response("claimed", { status: 401 }))
    expect(response.status).toBe(401)
    expect(seen.map(s => s.host)).toEqual(["cloudflare-dns.com", "claimed-b.smithers.sh"])
  })

  test("txt-marker: DNS failure reads as claimed and passes through", async () => {
    for (const [host, dns] of [["dns-down-c", () => new Response("", { status: 503 })], ["dns-garbage-d", () => new Response("not json")]] as const) {
      const { response, seen } = await run(new Request(`https://${host}.smithers.sh/`), ON,
        url => url.host === "cloudflare-dns.com" ? dns() : new Response("origin"))
      expect(response.status).toBe(200)
      expect(seen.at(-1)?.host).toBe(`${host}.smithers.sh`)
    }
  })

  test("the marker must answer for the queried name, with the exact data and NOERROR", () => {
    expect(answerIsUnclaimed("a.smithers.sh", { Status: 0, Answer: [{ name: "a.smithers.sh.", type: 16, data: `"${UNCLAIMED_MARKER}"` }] })).toBe(true)
    expect(answerIsUnclaimed("a.smithers.sh", { Status: 0, Answer: [{ name: "b.smithers.sh.", type: 16, data: `"${UNCLAIMED_MARKER}"` }] })).toBe(false)
    expect(answerIsUnclaimed("a.smithers.sh", { Status: 0, Answer: [{ name: "a.smithers.sh.", type: 16, data: `"other"` }] })).toBe(false)
    expect(answerIsUnclaimed("a.smithers.sh", { Status: 3, Answer: [{ name: "a.smithers.sh.", type: 16, data: `"${UNCLAIMED_MARKER}"` }] })).toBe(false)
    expect(answerIsUnclaimed("a.smithers.sh", null)).toBe(false)
  })
})

describe("the map, the routes and the package list agree", () => {
  const config = parseWranglerConfig(readFileSync(fileURLToPath(new URL("../wrangler.docs-redirect.jsonc", import.meta.url)), "utf8"))

  test("docsRedirectMap.ts is what scripts/package-docs.mjs generates from the package list", () => {
    const generated = readFileSync(fileURLToPath(new URL("./docsRedirectMap.ts", import.meta.url)), "utf8")
    expect(generated).toBe(renderModule(buildRedirectMap()))
    expect(README_URL).toBe(SCRIPT_README_URL)
  })

  test("the Worker claims exactly the retired docs-site hostnames: no wildcard, no other host", () => {
    expect(config.name).toBe("smithers-docs-redirect")
    expect(config.main).toBe("src/docsRedirectWorker.ts")
    expect(config.routes).toEqual(legacySites.map(([slug]) => ({ pattern: `${slug}.smithers.sh/*`, zone_id: ZONE_ID })))
    expect([...DOCS_REDIRECTS.keys()]).toEqual(legacySites.map(([slug]) => slug))
    expect(config.vars).toEqual({ UNKNOWN_SLUGS: "off" })
  })

  test("no route names a hostname that serves something other than a docs site", () => {
    // Inventoried 2026-10-06 (docs/docs-redirect.md); each answers for another service.
    const others = ["smithers.sh", "www", "canary", "api", "aomi", "backend.aomi", "automate", "baml-unplugin-pr", "billing",
      "bug", "bugs", "build", "capabilities-and-segments", "chat", "code", "connectors", "cron", "cron-schedules", "ddd",
      "deck", "docs-next", "download", "eliza", "ferric", "hermes", "identity", "init", "kimibenchmarks", "monitor",
      "openclaw", "plugins", "reco", "self-healing", "signal", "status", "storybook", "sync", "technical-deck",
      "telegram", "ui", "ui-preview", "webhooks", "patterns", "build-cli", "targets"]
    const hosts = config.routes.map(route => route.pattern.replace(/\/\*$/, ""))
    for (const other of others) expect(hosts).not.toContain(other === "smithers.sh" ? other : `${other}.smithers.sh`)
  })

  test("decide reads the hostname only", () => {
    expect(decide(new URL("https://flow.smithers.sh/anything"))).toEqual({ kind: "redirect", location: DOCS_REDIRECTS.get("flow")! })
    expect(decide(new URL("https://nope.smithers.sh/"))).toEqual({ kind: "unknown-slug", hostname: "nope.smithers.sh" })
    expect(decide(new URL("https://a.b.smithers.sh/"))).toEqual({ kind: "pass" })
  })
})
