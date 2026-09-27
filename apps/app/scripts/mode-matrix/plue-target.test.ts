import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { readExecutionReceipt } from "../../e2e/real/coverage/matrix"
import { appEntryPath } from "../../e2e/real/support/app-entry"
import { startWebPlue } from "./plue-target"

const deployed = "b".repeat(40)
const roots: string[] = []
const servers: Array<ReturnType<typeof Bun.serve>> = []

afterEach(() => {
  while (servers.length > 0) servers.pop()!.stop(true)
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true })
})

/** A stand-in Worker origin that serves only the routes it is given and records every request. */
const origin = (routes: Readonly<Record<string, () => Response>>) => {
  const paths: string[] = []
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: (request) => {
      const { pathname } = new URL(request.url)
      paths.push(pathname)
      return routes[pathname]?.() ?? Response.json({ code: "route_not_found" }, { status: 404 })
    }
  })
  servers.push(server)
  const outputDir = mkdtempSync(join(tmpdir(), "smithers-plue-target-"))
  roots.push(outputDir)
  return { url: `http://127.0.0.1:${server.port}`, paths, outputDir }
}

const bootstrap = () => Response.json({
  apiVersion: 1, host: "cloud", version: "1.0.0", buildSha: deployed,
  capabilities: ["agent", "identity", "cloud", "cloud.terminal"], authFlow: "native-handoff", sandbox: null
})
const document = (html = `<!doctype html><meta name="smithers-build-sha" content="${deployed}"><div id="root"></div>`) => () => new Response(html, { headers: { "content-type": "text/html" } })

describe("web-plue launcher", () => {
  test("a current backend cannot certify an old renderer", async () => {
    const web = origin({ "/api/bootstrap": bootstrap, [appEntryPath("production")]: document(`<!doctype html><meta name="smithers-build-sha" content="${"c".repeat(40)}"><div id="root"></div>`) })
    await expect(startWebPlue(web.outputDir, web.url, "PLUE_TOKEN", web.url)).rejects.toThrow("web renderer and backend revisions differ")
  })
  test("records the API endpoint separately and verifies both origins serve the same backend build", async () => {
    const backend = origin({ "/api/bootstrap": bootstrap })
    const web = origin({ "/api/bootstrap": bootstrap, [appEntryPath("production")]: document() })
    const session = await startWebPlue(web.outputDir, web.url, "PLUE_TOKEN", backend.url)
    expect(session.modeConfig.endpoint).toBe(backend.url)
    expect(readExecutionReceipt(session.modeConfig.executionReceipt).endpoint).toBe(backend.url)
    expect(backend.paths).toEqual(["/api/bootstrap"])
  })

  test("refuses a web origin that proxies a different backend revision", async () => {
    const backend = origin({ "/api/bootstrap": () => Response.json({ host: "cloud", buildSha: "c".repeat(40) }) })
    const web = origin({ "/api/bootstrap": bootstrap, [appEntryPath("production")]: document() })
    await expect(startWebPlue(web.outputDir, web.url, "PLUE_TOKEN", backend.url)).rejects.toThrow("web and API backend revisions differ")
  })

  test("records the deployed build it observed on the Worker, never the checkout, and never asks for /api/health", async () => {
    const target = origin({ "/api/bootstrap": bootstrap, [appEntryPath("production")]: document() })
    const session = await startWebPlue(target.outputDir, target.url, "PLUE_TOKEN", target.url)
    const receipt = readExecutionReceipt(session.modeConfig.executionReceipt)
    expect(receipt).toMatchObject({ mode: "web-plue", revision: deployed, origin: target.url, ready: true, startedRoles: ["web"] })
    expect(session.modeConfig).toMatchObject({ mode: "web-plue", origin: target.url, auth: { kind: "application-token", environment: "PLUE_TOKEN" } })
    expect(target.paths).not.toContain("/api/health")
  })

  test("an origin that serves health but no bootstrap is not a Plue target", async () => {
    const target = origin({ "/api/health": () => new Response("ok") })
    await expect(startWebPlue(target.outputDir, target.url, "PLUE_TOKEN", target.url)).rejects.toThrow(`${target.url}/api/bootstrap returned 404`)
  })

  test("a bootstrap without an exact deployed build is refused", async () => {
    const target = origin({
      "/api/bootstrap": () => Response.json({ apiVersion: 1, host: "cloud", buildSha: "dev" }),
      [appEntryPath("production")]: document()
    })
    await expect(startWebPlue(target.outputDir, target.url, "PLUE_TOKEN", target.url)).rejects.toThrow("did not identify a cloud host with an exact build")
  })

  test("an app entry that does not serve the app document is refused by path", async () => {
    const path = appEntryPath("production")
    const target = origin({ "/api/bootstrap": bootstrap, [path]: document("<!doctype html><p>marketing</p>") })
    await expect(startWebPlue(target.outputDir, target.url, "PLUE_TOKEN", target.url)).rejects.toThrow(`${target.url}${path} did not serve the app document`)
  })
})
