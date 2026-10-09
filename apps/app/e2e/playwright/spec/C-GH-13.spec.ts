import { expect, test } from "../browserTest"
import type { Page } from "@playwright/test"
import { spawn } from "node:child_process"
import { mkdtemp, writeFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { resolve, join } from "node:path"

// PostgreSQL, signed webhook, polling, delivery replay and install reads are real.
// The backend also asserts the transaction and runtime acknowledgement fences.
test("C-GH-13: GitHub facts use one pure decision seam", { tag: "@install" }, async ({ page, baseURL }) => {
  test.setTimeout(240_000)
  await factsBrowser(page, baseURL, false)
})

test("C-GH-13: synced GitHub approvals appear on the PR and survive reload", { tag: "@install" }, async ({ page, baseURL }) => {
  test.setTimeout(240_000)
  await factsBrowser(page, baseURL, true)
})

async function factsBrowser(page: Page, baseURL: string | undefined, approved: boolean) {
  if (!process.env.SMITHERS_FFI_LIBRARY_PATH || !process.env.SMITHERS_TEST_DATABASE_URL) throw new Error("Native FFI and PostgreSQL are required")
  const directory = await mkdtemp(join(tmpdir(), "smithers-review-browser-"))
  const doneFile = join(directory, "done")
  const backend = spawn("go", ["test", "./internal/compose", "-run", approved ? "^TestGitHubApprovedFactsBrowserPostgres$" : "^TestGitHubFactsBrowserPostgres$", "-count=1", "-v"], {
    cwd: resolve("../../packages/backend"), env: { ...process.env, SMITHERS_REVIEW_ASSETS_URL: baseURL!, SMITHERS_REVIEW_DONE_FILE: doneFile }, stdio: ["pipe", "pipe", "pipe"]
  })
  let logs = "", origin = ""
  backend.stdout.on("data", bytes => { logs += String(bytes); origin = logs.match(/REVIEW_BROWSER_READY (http:\/\/[^\s]+)/)?.[1] ?? "" })
  backend.stderr.on("data", bytes => { logs += String(bytes) })
  const exited = new Promise<number | null>((done, reject) => { backend.on("exit", done); backend.on("error", reject) })
  try {
    await expect.poll(() => { if (backend.exitCode !== null) throw new Error(logs); return origin }, { timeout: 120_000 }).not.toBe("")
    await page.context().addCookies([{ name: "session", value: "review-browser-session", url: origin }])
    await page.goto(`${origin}/owner/app`)
    await page.getByRole("button", { name: "Review fixture", exact: true }).first().click()
    const card = page.locator(".smithers-card").last()
    await expect(card).toContainText(approved ? "In review" : "Working")
    if (approved) {
      await expect(card).toContainText("Approved by")
      await expect(card).toContainText("@dana")
      await expect(card.getByText("Approved by", { exact: false })).toHaveCount(2)
    }
    const response = await page.request.get(`${origin}/api/todos/1/events`)
    expect(response.status()).toBe(200)
    const events = await response.json()
    expect(JSON.stringify(events)).toContain("Use the existing backoff helper")
    await page.reload()
    await page.getByRole("button", { name: "Review fixture", exact: true }).first().click()
    await expect(page.locator(".smithers-card").last()).toContainText(approved ? "In review" : "Working")
    if (approved) await expect(page.locator(".smithers-card").last()).toContainText("Approved by")
    const replay = await page.request.get(`${origin}/api/todos/1/events`)
    expect(await replay.json()).toEqual(events)
  } finally {
    await writeFile(doneFile, "done")
    try { expect(await exited, logs).toBe(0) } finally { await rm(directory, { recursive: true, force: true }) }
  }
}
