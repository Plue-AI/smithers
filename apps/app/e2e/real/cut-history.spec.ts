import { test, expect } from "@playwright/test"
import { scenario } from "./coverage/types"
import { fillComposer } from "../playwright/composer"

// No route interception: the Go rehearsal supplies authenticated journals,
// the shipped app, and the actual model host with a scripted provider.
test("C-CUT-02: authenticated Earlier keeps mixed historical cards inert through reload and a model turn", scenario("cut-history.install-privacy", {
  capabilities: [],
  coverage: ["action:branches", "action:chat.send", "host:local", "path:success", "path:persistence", "path:error", "door:slash", "dimension:reload", "evidence:authenticated-journal-readback"]
}), async ({ browser, baseURL }) => {
  if (!baseURL) throw new Error("Run through TestCutHistoryInstallBrowserModelPrivacy")
  const origin = new URL(baseURL)
  const member = async (login: string) => {
    const context = await browser.newContext()
    await context.addCookies([{ name: "session", value: `w17-${login}`, domain: origin.hostname, path: "/" },
      { name: "__csrf", value: "csrf", domain: origin.hostname, path: "/" }])
    return context
  }
  const ben = await member("ben"), alice = await member("alice")
  try {
    const page = await ben.newPage()
    await page.goto("/chatowner/chatrepo")
    await fillComposer(page, "/branches")
    await page.keyboard.press("Enter")
    await page.locator('[data-node="earlier"]').press("Enter")
    const earlier = page.getByRole("region", { name: "Earlier", exact: true })
    await expect(earlier.getByRole("button", { name: "Old prompt", exact: true })).toHaveCount(1)
    await earlier.locator('[data-archive="earlier:journal:legacy-journal"]').press("Enter")
    const entries = earlier.locator(".archive-entries")
    for (const kind of ["admin-health", "agent", "connect", "grant-confirm", "notifications", "registration", "repository-setup"]) {
      await expect(entries.getByText(`Saved ${kind}`, { exact: true })).toBeVisible()
    }
    for (const title of ["Old prompt", "Old answer", "Saved File", "Saved Run", "<script>archiveCanary()</script>"]) await expect(entries.getByText(title, { exact: true })).toBeVisible()
    for (const secret of ["private-body-canary", "private-payload-canary", "retained-file-body-canary"]) await expect(entries).not.toContainText(secret)
    await expect(entries.locator("button,input,textarea,script")).toHaveCount(0)
    await expect(page.locator("[data-branch-navigation]")).toHaveAttribute("aria-busy", "false")
    await page.reload()
    await expect(entries.getByText("Saved admin-health", { exact: true })).toBeVisible()
    await page.locator('[data-node="earlier"]').press("Escape")
    await fillComposer(page, "Current cut qualification question")
    await page.keyboard.press("Enter")
    await expect(page.locator("[data-shared-turn]").getByText("Host answer.", { exact: true })).toBeVisible({ timeout: 30_000 })
    const reader = await alice.newPage()
    await reader.goto("/chatowner/chatrepo")
    await fillComposer(reader, "/branches")
    await reader.keyboard.press("Enter")
    await reader.locator('[data-node="earlier"]').press("Enter")
    const aliceEarlier = reader.getByRole("region", { name: "Earlier", exact: true })
    await expect(aliceEarlier.locator("[data-archive]")).toHaveCount(0)
    await expect(aliceEarlier).not.toContainText("Saved admin-health")
    const csrf = (await alice.cookies()).find(cookie => cookie.name === "__csrf")!.value
    const forbidden = await alice.request.post(`${baseURL}/api/agent/conversations/replay`, {
      headers: { "X-CSRF-Token": csrf, Origin: baseURL }, data: { runId: "legacy-turn", legId: "legacy-leg" }
    })
    expect(forbidden.status(), await forbidden.text()).toBe(404)
  } finally { await ben.close(); await alice.close() }
})
