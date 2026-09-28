import { scenario } from "./coverage/types"
import { authenticatedTest } from "./auth-permissions/profile"
import { awaitBoot, closeComposer, expect, productUrl, realApi } from "./support/test"
import { attachJson, runSlash } from "./issues/local"
import { finishFirstVisit } from "./support/first-visit"
import { runningWorkspace, withOwnedRepository } from "./portable/owned-repository"
import type { APIRequestContext, Page } from "@playwright/test"
import type { OwnedRepository } from "./portable/owned-repository"
import { enableVerboseEvidence, expectFlowOutcome } from "./repositories-github/local"

authenticatedTest.setTimeout(240_000)

// Own every box created on this fresh repository, including an unparsed create response.
const withWorkspaceCleanup = async <T>(page: Page, request: APIRequestContext, repo: OwnedRepository, use: () => Promise<T>): Promise<T> => {
  let bodyFailed = false
  let bodyError: unknown
  try {
    return await use()
  } catch (error) {
    bodyFailed = true
    bodyError = error
    throw error
  } finally {
    try {
      const response = await realApi(page, request, "GET", `${repo.path}/workspaces`)
      expect(response.status()).toBe(200)
      const remaining = await response.json() as ReadonlyArray<{ readonly id: string }>
      expect(Array.isArray(remaining)).toBe(true)
      for (const workspace of remaining) {
        expect(workspace.id).toEqual(expect.any(String))
        expect(workspace.id).not.toBe("")
        const path = `${repo.path}/workspaces/${encodeURIComponent(workspace.id)}`
        expect((await realApi(page, request, "DELETE", path)).status()).toBe(204)
        expect((await realApi(page, request, "GET", path)).status()).toBe(404)
      }
    } catch (cleanupError) {
      if (bodyFailed) throw new AggregateError([bodyError, cleanupError], "Workspace lifecycle and cleanup failed")
      throw cleanupError
    }
  }
}

authenticatedTest("a product workspace suspends, resumes, and deletes", scenario("workspaces.product-lifecycle", {
  capabilities: ["identity", "cloud"],
  coverage: ["action:box.open", "action:box.suspend", "action:box.resume", "action:box.delete", "host:local", "host:production", "path:success", "door:slash", "surface:workspace-api", "evidence:state-transitions-and-delete"]
}), async ({ page, request }, testInfo) => {
  testInfo.setTimeout(600_000)
  await withOwnedRepository(page, request, async (repo) => {
    const startedAt = performance.now()
    await page.goto(productUrl(page, `/${repo.fullName}`), { waitUntil: "domcontentloaded" })
    await awaitBoot(page, "navigate", startedAt)
    await finishFirstVisit(page)

    await enableVerboseEvidence(page)

    const collectionPath = `${repo.path}/workspaces`
    await withWorkspaceCleanup(page, request, repo, async () => {
      const openArgs = `main ${repo.fullName} --kind container`
      const openedInBrowser = page.waitForResponse((response) =>
        response.request().method() === "POST" && new URL(response.url()).pathname === collectionPath, { timeout: 120_000 })
      await runSlash(page, `/box.open ${openArgs}`)
      const opened = await openedInBrowser
      expect(opened.request().postDataJSON()).toMatchObject({ source_bookmark: "main", kind: "container" })
      expect([201, 202], `open ${repo.fullName}: ${await opened.text()}`).toContain(opened.status())
      const created = await opened.json() as { readonly id?: unknown; readonly name?: unknown; readonly slug?: unknown; readonly status?: unknown }
      expect(created.id, "the browser's box.open response must identify the created box").toEqual(expect.any(String))
      const id = created.id as string
      expect(id).not.toBe("")
      const path = `${collectionPath}/${encodeURIComponent(id)}`
      await expectFlowOutcome(page, "box.open", openArgs, "executed")
      const card = page.getByTestId(`card-workspace-${id}`)
      await expect(card).toBeVisible({ timeout: 60_000 })
      await expect(card).toContainText(repo.fullName)

      type WorkspaceWire = { readonly id?: unknown; readonly name?: unknown; readonly slug?: unknown; readonly status?: unknown }
      const readWorkspace = async (): Promise<WorkspaceWire> => {
        const response = await realApi(page, request, "GET", path)
        expect(response.status(), `read ${id}`).toBe(200)
        const row = await response.json() as WorkspaceWire
        expect(row.id).toBe(id)
        expect(row.name).toEqual(expect.any(String))
        return row
      }
      let running: WorkspaceWire | undefined
      await expect.poll(async () => {
        running = await readWorkspace()
        return running.status
      }, { timeout: 120_000, intervals: [500, 1_000, 2_000] }).toBe("running")
      const name = String(running!.name || running!.slug || id)
      expect(name).not.toBe("")
      await expect(card).toContainText(name)
      await expect(card).toContainText(/Running/i)

      const suspendInBrowser = page.waitForResponse((response) =>
        response.request().method() === "POST" && new URL(response.url()).pathname === `${path}/suspend`, { timeout: 120_000 })
      await runSlash(page, `/box.suspend ${id}`)
      const suspendedResponse = await suspendInBrowser
      expect(suspendedResponse.status()).toBe(200)
      await expectFlowOutcome(page, "box.suspend", id, "executed")
      let suspended: WorkspaceWire | undefined
      await expect.poll(async () => {
        suspended = await readWorkspace()
        return suspended.status
      }, { timeout: 180_000, intervals: [1_000, 2_000, 5_000] }).toBe("suspended")
      await expect(card).toContainText(/Suspended/i)

      const resumeInBrowser = page.waitForResponse((response) =>
        response.request().method() === "POST" && new URL(response.url()).pathname === `${path}/resume`, { timeout: 120_000 })
      await runSlash(page, `/box.resume ${id}`)
      const resumedResponse = await resumeInBrowser
      expect(resumedResponse.status()).toBe(200)
      await expectFlowOutcome(page, "box.resume", id, "executed")
      let resumed: WorkspaceWire | undefined
      await expect.poll(async () => {
        resumed = await readWorkspace()
        return resumed.status
      }, { timeout: 180_000, intervals: [1_000, 2_000, 5_000] }).toBe("running")
      await expect(card).toContainText(/Running/i)

      const deleteArgs = `${id} ${name}`
      const deleteInBrowser = page.waitForResponse((response) =>
        response.request().method() === "DELETE" && new URL(response.url()).pathname === path, { timeout: 120_000 })
      await runSlash(page, `/box.delete ${deleteArgs}`)
      const deletedResponse = await deleteInBrowser
      expect(deletedResponse.status()).toBe(204)
      await expectFlowOutcome(page, "box.delete", deleteArgs, "executed")
      let finalStatus = 0
      await expect.poll(async () => finalStatus = (await realApi(page, request, "GET", path)).status(),
        { timeout: 60_000, intervals: [500, 1_000, 2_000] }).toBe(404)
      await expect(card).toHaveCount(0)
      await attachJson(testInfo, "product-workspace-lifecycle", {
        repo: repo.fullName, id, name,
        open: { status: opened.status(), response: created, readback: running },
        suspend: { status: suspendedResponse.status(), response: await suspendedResponse.json().catch(() => null), readback: suspended },
        resume: { status: resumedResponse.status(), response: await resumedResponse.json().catch(() => null), readback: resumed },
        delete: { status: deletedResponse.status(), readbackStatus: finalStatus, cardCount: await card.count() }
      })
    })
  })
})

authenticatedTest("a failed UI workspace creation check still cleans up its box", scenario("workspaces.product-lifecycle-cleanup", {
  capabilities: ["identity", "cloud"],
  coverage: ["action:box.open", "host:local", "host:production", "path:success", "door:slash", "evidence:owned-cleanup-after-create"]
}), async ({ page, request }) => {
  await withOwnedRepository(page, request, async (repo) => {
    const startedAt = performance.now()
    await page.goto(productUrl(page, `/${repo.fullName}`), { waitUntil: "domcontentloaded" })
    await awaitBoot(page, "navigate", startedAt)
    await finishFirstVisit(page)
    const path = `${repo.path}/workspaces`
    const failure = new Error("fail before parsing the created workspace id")
    await expect(withWorkspaceCleanup(page, request, repo, async () => {
      const created = page.waitForResponse(response => response.request().method() === "POST" && new URL(response.url()).pathname === path)
      await runSlash(page, `/box.open main ${repo.fullName} --kind container`)
      expect([201, 202]).toContain((await created).status())
      throw failure
    })).rejects.toBe(failure)
    const remaining = await realApi(page, request, "GET", path)
    expect(remaining.status()).toBe(200)
    expect(await remaining.json()).toEqual([])
  })
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
