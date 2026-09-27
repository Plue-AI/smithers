import { scenario } from "./coverage/types"
import { authenticatedTest } from "./auth-permissions/profile"
import { awaitBoot, closeComposer, expect, productUrl, realApi } from "./support/test"
import { runSlash } from "./issues/local"
import { finishFirstVisit } from "./support/first-visit"
import { runningWorkspace, withOwnedRepository } from "./portable/owned-repository"

authenticatedTest.setTimeout(240_000)

authenticatedTest("a product workspace suspends, resumes, and deletes", scenario("workspaces.product-lifecycle", {
  capabilities: ["identity", "cloud"],
  coverage: ["action:box.open", "action:box.suspend", "action:box.resume", "action:box.delete", "host:local", "host:production", "path:success", "door:slash", "surface:workspace-api", "evidence:state-transitions-and-delete"]
}), async ({ page, request }) => {
  await withOwnedRepository(page, request, (repo) => runningWorkspace(page, request, repo, async (id) => {
    const path = `${repo.path}/workspaces/${encodeURIComponent(id)}`
    const suspended = await realApi(page, request, "POST", `${path}/suspend`)
    expect(suspended.status()).toBe(200)
    await expect.poll(async () => (await (await realApi(page, request, "GET", path)).json() as { readonly status?: string }).status).toBe("suspended")
    const resumed = await realApi(page, request, "POST", `${path}/resume`)
    expect(resumed.status()).toBe(200)
    await expect.poll(async () => (await (await realApi(page, request, "GET", path)).json() as { readonly status?: string }).status, { timeout: 120_000 }).toBe("running")
  }))
})

authenticatedTest("a product terminal accepts keyboard input on its workspace", scenario("workspaces.product-terminal-keyboard-output", {
  capabilities: ["identity", "cloud", "cloud.terminal"],
  coverage: ["action:box.view", "action:box.terminal", "host:local", "host:production", "path:success", "path:keyboard", "door:slash", "dimension:keyboard", "dimension:real-pty", "evidence:terminal-output-and-cleanup"]
}), async ({ page, request }) => {
  await withOwnedRepository(page, request, (repo) => runningWorkspace(page, request, repo, async (id) => {
    const startedAt = performance.now()
    await page.goto(productUrl(page, `/${repo.fullName}`), { waitUntil: "domcontentloaded" })
    await awaitBoot(page, "navigate", startedAt)
    await finishFirstVisit(page)
    await runSlash(page, `/box.view ${id}`)
    const card = page.getByTestId(`card-workspace-${id}`)
    await expect(card).toBeVisible()
    const sessionPath = `${repo.path}/workspace/sessions`
    const created = page.waitForResponse((response) => response.request().method() === "POST" && new URL(response.url()).pathname === sessionPath)
    await runSlash(page, `/box.terminal ${id}`)
    expect((await created).status()).toBe(201)
    await closeComposer(page)
    const terminal = card.locator('[data-testid^="terminal-"]')
    await expect(terminal).toBeVisible()
    const sessionId = (await terminal.getAttribute("data-testid"))!.slice("terminal-".length)
    try {
      const marker = `MATRIX_TERMINAL_${Date.now()}`
      await terminal.locator(".xterm-helper-textarea").focus()
      await page.keyboard.type(`printf '%s\\n' '${marker}'`)
      await page.keyboard.press("Enter")
      await expect(terminal.locator(".xterm-rows")).toContainText(marker, { timeout: 30_000 })
    } finally {
      expect((await realApi(page, request, "POST", `${sessionPath}/${encodeURIComponent(sessionId)}/destroy`)).status()).toBe(204)
    }
  }))
})
