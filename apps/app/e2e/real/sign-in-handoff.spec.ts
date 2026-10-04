import { readAuthenticatedSession } from "./auth-permissions/profile"
import { scenario } from "./coverage/types"
import { awaitBoot, expect, test } from "./support/test"
import type { Page } from "@playwright/test"

// Handoff responses carry a claim secret. Keep only status/path observations.
test.use({ trace: "off", video: "off" })

test("the hosted sign-in button starts its advertised GitHub handoff", scenario("auth.signed-out-handoff-start", {
  capabilities: ["identity"],
  coverage: ["action:sign-in", "host:production", "path:success", "path:keyboard", "door:button", "door:user-only", "dimension:keyboard", "dimension:handoff-start", "dimension:no-owner-credentials", "evidence:start-status-and-provider-popup"],
  description: "Activate the actual signed-out door with Enter, require a successful handoff start and the bound OAuth popup reaching GitHub, and prove the app did not open owner credentials or claim authenticated completion."
}), async ({ page, context, request }, testInfo) => {
  const bootstrap = await (await request.get("/api/bootstrap")).json() as { authFlow: string }
  expect(["native-handoff", "both"]).toContain(bootstrap.authFlow)
  const started = performance.now()
  await page.goto("/smithersai/smithers", { waitUntil: "domcontentloaded" })
  await awaitBoot(page, "navigate", started)
  expect(await readAuthenticatedSession(page)).toBeUndefined()
  const appURL = page.url()
  const requests: Array<{ method: string; path: string }> = []
  const popupPaths: string[] = []
  const popups: Page[] = []
  let startStatus: number | undefined
  page.on("request", outbound => requests.push({ method: outbound.method(), path: new URL(outbound.url()).pathname }))
  page.on("response", response => {
    if (new URL(response.url()).pathname === "/api/auth/native/start") startStatus = response.status()
  })
  const observePopup = (popup: Page) => {
    popups.push(popup)
    popup.on("request", outbound => popupPaths.push(new URL(outbound.url()).pathname))
  }
  context.on("page", observePopup)
  try {
    await page.getByTestId("login-github").press("Enter")
    await expect.poll(() => startStatus).toBe(200)
    await expect.poll(() => popupPaths.includes("/api/auth/github/start")).toBe(true)
    await expect.poll(() => popups.some(popup => new URL(popup.url()).hostname === "github.com"), { timeout: 30_000 }).toBe(true)
    expect(requests.filter(({ path }) => path.startsWith("/api/auth/local/"))).toEqual([])
    await expect(page.locator(".local-auth-dialog")).toHaveCount(0)
    expect(page.url()).toBe(appURL)
    expect(await readAuthenticatedSession(page)).toBeUndefined()
    await testInfo.attach("handoff-start", { contentType: "application/json", body: Buffer.from(JSON.stringify({ authFlow: bootstrap.authFlow, startStatus, provider: "github.com", popupCount: popups.length, signedIn: false })) })
  } finally {
    context.off("page", observePopup)
    await Promise.all(popups.map(popup => popup.close().catch(() => undefined)))
  }
})
