import { expect, test, type Page } from "../browserTest"
import { spawn } from "node:child_process"
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { resolve, join } from "node:path"

type Host = { origin: string; number: number; fixingIssue?: number; referenceIssue?: number; phase: string; cookies: Array<{ name: string; value: string; url: string }> }
interface Fixture {
  phase: (name: string) => Promise<Host>
  open: (host: Host) => Promise<void>
  acknowledge: (phase: string) => Promise<void>
}

/** Real install and card data; completed accepted trees are the Go fixture's input. */
export async function withGitHubInstall(page: Page, run: string, enable: string, observe: (fixture: Fixture) => Promise<void>, phase = "", phaseTimeoutMs = 480_000) {
  if (!process.env.SMITHERS_FFI_LIBRARY_PATH || !process.env.SMITHERS_TEST_DATABASE_URL) throw new Error("Native FFI and PostgreSQL are required")
  const dir = await mkdtemp(join(tmpdir(), "smithers-gh03-browser-")), config = join(dir, "host.json")
  const backend = spawn("go", ["test", "-p", "4", "-v", "./internal/compose", "-run", `^${run}$`, "-count=1"], {
    cwd: resolve("../../packages/backend"), env: { ...process.env, [enable]: "1",
      SMITHERS_GH03_BROWSER_HARNESS: config, SMITHERS_GH03_BROWSER_PHASE: phase, SMITHERS_REHEARSAL_SPA_DIR: resolve("dist") }, stdio: ["ignore", "pipe", "pipe"]
  })
  let logs = "", opened = false
  backend.stdout.on("data", bytes => { logs += String(bytes) })
  backend.stderr.on("data", bytes => { logs += String(bytes) })
  const exited = new Promise<number | null>(done => backend.on("exit", done))
  try {
    await observe({
      phase: async name => {
        let host!: Host
        await expect.poll(async () => {
          if (backend.exitCode !== null) throw new Error(logs)
          try { host = JSON.parse(await readFile(config, "utf8")); return host.phase } catch { return "starting" }
        }, { timeout: phaseTimeoutMs }).toBe(name)
        return host
      },
      open: async host => {
        if (!opened) {
          await page.context().addCookies(host.cookies)
          await page.addInitScript(() => localStorage.setItem("smithers-mvp.persistenceBackend", "localStorage"))
          await page.goto(`${host.origin}/rehearsal-owner/app`)
          opened = true
        } else await page.reload()
        await expect(page.getByRole("button", { name: "Chat", exact: true })).toBeVisible({ timeout: 30_000 })
      },
      acknowledge: phase => writeFile(config + ".ack", phase)
    })
    expect(await exited, logs).toBe(0)
  } finally {
    if (backend.exitCode === null) { backend.kill("SIGTERM"); await exited }
    await test.info().attach("composed-install-backend", { body: logs, contentType: "text/plain" })
    await rm(dir, { recursive: true, force: true })
  }
}
