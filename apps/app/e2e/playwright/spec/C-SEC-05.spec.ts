import { expect, test } from "../browserTest"
import { spawn } from "node:child_process"
import { mkdtemp, writeFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { resolve, join } from "node:path"

// Real terminal lifecycle mint, source CLI, composed install, PostgreSQL and
// private Confirm card. The PTY/file fixture does not qualify guest isolation.
test("C-SEC-05: terminal append waits for its member's private Confirm", { tag: "@install" }, async ({ page }) => {
  test.setTimeout(240_000)
  if (!process.env.SMITHERS_TEST_DATABASE_URL) throw new Error("PostgreSQL is required for C-SEC-05")
  const directory = await mkdtemp(join(tmpdir(), "smithers-terminal-confirm-"))
  const backend = spawn("go", ["test", "-p", "4", "./internal/compose", "-run", "^TestTerminalAppendConfirmationComposedInstall$", "-count=1", "-v"], {
    cwd: resolve("../../packages/backend"),
    env: { ...process.env, GOMAXPROCS: "8", SMITHERS_TERMINAL_CONFIRM_PHASE_DIR: directory },
    stdio: ["ignore", "pipe", "pipe"]
  })
  let logs = "", complete = false
  backend.stdout.on("data", bytes => { logs += String(bytes) })
  backend.stderr.on("data", bytes => { logs += String(bytes) })
  const exited = new Promise<number | null>((done, reject) => { backend.on("exit", done); backend.on("error", reject) })
  try {
    const ready = /TERMINAL_CONFIRM_READY (http:\/\/\S+) (\S+)/
    await expect.poll(() => { if (backend.exitCode !== null) throw new Error(logs); return ready.test(logs) }, { timeout: 120_000 }).toBe(true)
    const [, origin, id] = logs.match(ready)!
    await page.context().addCookies([
      { name: "smithers_session", value: "replacement-cookie", url: origin },
      { name: "__csrf", value: "csrf", url: origin }
    ])
    await page.goto(origin)
    const card = page.locator('[data-kind="confirm"]').last()
    await expect(card).toContainText("Terminal follow-up", { timeout: 60_000 })
    await expect(card).toContainText("Keep the terminal request private")
    const commit = card.getByRole("button", { name: "Commit", exact: true })
    await expect(commit).toBeEnabled()
    await expect(page.getByTestId("composer-input")).toBeEnabled()
    const before = await page.request.get(`${origin}/api/todos`)
    expect(before.status()).toBe(200)
    expect(await before.json()).toEqual([])
    // Reload reattaches the private persisted confirmation rather than issuing
    // another terminal append or showing a seeded DesignWorld card.
    await page.reload()
    await expect(commit).toBeEnabled({ timeout: 60_000 })
    const approved = page.waitForResponse(response => response.url().endsWith(`/api/confirmations/${id}/approve`) && response.request().method() === "POST")
    await commit.press("Enter")
    const approvalResponse = await approved
    expect(approvalResponse.status()).toBe(200)
    const after = await page.request.get(`${origin}/api/todos`)
    expect(after.status()).toBe(200)
    const todos = await after.json()
    expect(todos).toHaveLength(1)
    expect(todos[0]).toMatchObject({ title: "Terminal follow-up" })
    await expect(page.getByTestId("composer-input")).toBeEnabled()
    const key = approvalResponse.request().headers()["idempotency-key"]
    if (!key) throw new Error("The person approval must carry its idempotency key")
    await writeFile(join(directory, "approved"), key)
    complete = true
  } finally {
    await writeFile(join(directory, "done"), "done")
    try { const status = await exited; if (complete) expect(status, logs).toBe(0) } finally { await rm(directory, { recursive: true, force: true }) }
  }
})
