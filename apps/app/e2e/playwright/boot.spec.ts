import { expect,test } from "./browserTest"
import { localApiGet } from "./localApi"
import { AppBootstrapSchema } from "@smthrs/rpc/AppBootstrap"

/*
 * M0 boot (LOCAL-APP.md, "Test tiers"): the local origin answers, the SPA
 * mounts (the guide shell owns first paint), and advertises only the
 * services in bootstrap.
 */

test("health reports the host and bootstrap reports its sandbox capabilities", async ({ page, request }) => {
  const response = await request.get("/api/health")
  expect(response.status()).toBe(200)
  const body = (await response.json()) as {
    ok: boolean
    version: string
    pid: number
    home: string
  }
  expect(body.ok).toBe(true)
  expect(typeof body.version).toBe("string")
  expect(typeof body.pid).toBe("number")
  expect(body.home).toContain("smithers-browser-test-")
  expect((await request.get("/api/bootstrap")).status()).toBe(401)
  await page.goto("/")
  const bootstrap = await localApiGet(page, request, "/api/bootstrap")
  expect(bootstrap.status()).toBe(200)
  const host = AppBootstrapSchema.parse(await bootstrap.json())
  expect(host.host).toBe("local")
  expect(host.sandbox).toMatchObject({
    platform: process.platform,
    mode: "unavailable",
    policies: { loader: "unenforced", targetRun: "unenforced" }
  })
})

test("the isolated browser host exposes no retired harness discovery route", async ({ page, request }) => {
  test.skip(process.env.SMITHERS_E2E_HOST_HARNESSES === "1", "explicit real-host harness lane")
  await page.goto("/")
  const health = await (await request.get("/api/health")).json() as { home: string }
  expect(health.home).toContain("smithers-browser-test-")
  const response = await localApiGet(page, request, "/api/harnesses")
  expect(response.status()).toBe(404)
  expect(await response.json()).not.toHaveProperty("harnesses")
})
