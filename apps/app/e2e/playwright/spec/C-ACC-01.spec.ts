import { expect, test } from "../browserTest"
import { say } from "./j1-fixtures"
import { spawn } from "node:child_process"
import { mkdtemp, writeFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { resolve, join } from "node:path"

// UI projection of .specs/engineering/checks/C-ACC-01.md.
// PostgreSQL, the full install composition, session auth and live transport are real.
test("C-ACC-01: a Member can read people and secret names but cannot merge or administer", async ({ page, baseURL }) => {
  test.setTimeout(240_000)
  if (!process.env.SMITHERS_FFI_LIBRARY_PATH || !process.env.SMITHERS_TEST_DATABASE_URL) throw new Error("Native FFI and PostgreSQL are required for C-ACC-01")
  const directory = await mkdtemp(join(tmpdir(), "smithers-access-browser-"))
  const doneFile = join(directory, "done")
  const backend = spawn("go", ["test", "./internal/compose", "-run", "^TestAccessMembersBrowserPostgres$", "-count=1", "-v"], {
    cwd: resolve("../../packages/backend"), env: { ...process.env, SMITHERS_ACCESS_ASSETS_URL: baseURL!, SMITHERS_ACCESS_DONE_FILE: doneFile }, stdio: ["pipe", "pipe", "pipe"]
  })
  let logs = "", origin = ""
  backend.stdout.on("data", bytes => { logs += String(bytes); origin = logs.match(/ACCESS_BROWSER_READY (http:\/\/[^\s]+)/)?.[1] ?? "" })
  backend.stderr.on("data", bytes => { logs += String(bytes) })
  const exited = new Promise<number | null>((done, reject) => { backend.on("exit", done); backend.on("error", reject) })
  try {
    await expect.poll(() => { if (backend.exitCode !== null) throw new Error(logs); return origin }, { timeout: 120_000 }).not.toBe("")
    await page.context().addCookies([{ name: "session", value: "alice-browser-session", url: origin }, { name: "__csrf", value: "csrf", url: origin }])
    await page.goto(`${origin}/maya/demo`)
    await say(page, "/members")
    await expect(page.getByText("@alice", { exact: true }).last()).toBeVisible()
    await expect(page.getByRole("button", { name: "Add", exact: true })).toHaveCount(0)
    await expect(page.getByRole("button", { name: "Remove", exact: true })).toHaveCount(0)
    await say(page, "/secrets")
    await expect(page.getByText("TEST_TOKEN", { exact: true }).last()).toBeVisible()
    await expect(page.getByLabel("Value", { exact: true })).toHaveCount(0)
    await expect(page.getByRole("button", { name: "Replace", exact: true })).toHaveCount(0)
    await expect(page.getByRole("button", { name: "Delete", exact: true })).toHaveCount(0)
    await say(page, "/todo T1")
    await expect(page.getByText(/^Ready · a maintainer merges/).last()).toBeVisible()
    await expect(page.getByRole("button", { name: "Merge", exact: true })).toHaveCount(0)
    await say(page, "/merge T1")
    await expect(page.getByText("Merged", { exact: true })).toHaveCount(0)
    await expect(page.getByRole("button", { name: "Review & merge", exact: true })).toHaveCount(0)
    await say(page, "/todo.new")
    await expect(page.getByLabel("Title", { exact: true }).last()).toBeVisible()
    await expect(page.getByRole("button", { name: "Commit", exact: true }).last()).toBeVisible()
    const csrf = (await page.context().cookies(origin)).find(cookie => cookie.name === "__csrf")!.value
    // UI refusals cannot substitute for server enforcement.
    for (const [path, data] of [["/api/todos/1/merge", {}], ["/api/secrets", { name: "TEST_TOKEN", value: "replaced" }]] as const) {
      const response = await page.request.fetch(`${origin}${path}`, { method: path === "/api/secrets" ? "PUT" : "POST", data,
        headers: { Origin: origin, "X-CSRF-Token": csrf } })
      expect(response.status()).toBe(403)
      expect(await response.json()).toMatchObject({ class: "permission", code: "permission" })
    }
  } finally {
    await writeFile(doneFile, "done")
    try { expect(await exited, logs).toBe(0) } finally { await rm(directory, { recursive: true, force: true }) }
  }
})
