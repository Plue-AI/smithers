import { expect, test } from "../browserTest"
import { spawn } from "node:child_process"
import { mkdtemp, writeFile, stat, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { resolve, join } from "node:path"
import { createServer } from "vite"

type ParallelAdmissionWindow = Window & { parallelAdmission: { seeded(): boolean; effective(): number | undefined } }

// Real PostgreSQL, composed install router, engine/scheduler, live projections
// and mounted Settings dispatch. Guest/clock injection is Linux conformance;
// C-SEC-02 and physical-machine qualification remain separate receipts.
test("C-STK-02: admission follows stack order and capacity", async ({ page }) => {
  test.setTimeout(300_000)
  if (!process.env.SMITHERS_FFI_LIBRARY_PATH || !process.env.SMITHERS_TEST_DATABASE_URL) throw new Error("Native FFI and PostgreSQL are required for C-STK-02")
  const directory = await mkdtemp(join(tmpdir(), "smithers-parallel-browser-"))
  const backend = spawn("go", ["test", "-p", "4", "./internal/compose", "-run", "^TestParallelAdmissionInstallBoundary$", "-count=1", "-v"], {
    cwd: resolve("../../packages/backend"), env: { ...process.env, GOMAXPROCS: "8", SMITHERS_PARALLEL_BROWSER_DIR: directory }, stdio: ["ignore", "pipe", "pipe"]
  })
  let logs = "", origin = ""
  backend.stdout.on("data", bytes => { logs += String(bytes); origin = logs.match(/PARALLEL_BROWSER_READY (http:\/\/[^\s]+)/)?.[1] ?? "" })
  backend.stderr.on("data", bytes => { logs += String(bytes) })
  const exited = new Promise<number | null>((done, reject) => { backend.on("exit", done); backend.on("error", reject) })
  let vite: Awaited<ReturnType<typeof createServer>> | undefined
  const checkpoint = async (step: string, check: () => Promise<void>) => {
    await expect.poll(async () => {
      if (backend.exitCode !== null || backend.signalCode !== null) throw new Error(logs)
      return stat(join(directory, `${step}.ready`)).then(() => true, () => false)
    }, { timeout: 70_000 }).toBe(true).catch(error => { throw new Error(`${String(error)}\n${logs}`) })
    await check()
    await writeFile(join(directory, `${step}.done`), "observed")
  }
  try {
    await expect.poll(() => { if (backend.exitCode !== null || backend.signalCode !== null) throw new Error(logs); return origin }, { timeout: 150_000 }).not.toBe("")
    const fixture = resolve("e2e/real/parallel-admission.fixture.tsx")
    vite = await createServer({ configLoader: "runner", logLevel: "error", plugins: [{
      name: "parallel-acceptance-mount",
      configureServer(server) {
        server.middlewares.use(async (req, res, next) => {
          if (!req.url?.startsWith("/__parallel")) return next()
          const html = await server.transformIndexHtml(req.url, `<html><body><div id="root"></div><script type="module" src="/@fs/${fixture}"></script></body></html>`)
          res.setHeader("Content-Type", "text/html")
          res.end(html)
        })
      }
    }], server: { host: "127.0.0.1", port: 0, proxy: { "/api": {
      target: origin, ws: true, changeOrigin: true,
      headers: { Origin: "http://127.0.0.1:4000", Host: "127.0.0.1:4000" }
    } } } })
    await vite.listen()
    const address = vite.httpServer!.address()
    if (!address || typeof address === "string") throw new Error("Vite did not bind")
    const base = `http://127.0.0.1:${address.port}`
    await page.context().addCookies([{ name: "smithers_session", value: "maya-parallel-session", url: base, httpOnly: true }, { name: "__csrf", value: "parallel-card", url: base }])
    const errors: string[] = []
    page.on("pageerror", error => errors.push(error.message))
    await page.goto(`${base}/__parallel`)
    const stack = page.getByRole("list", { name: "Stack", exact: true })
    const row = (n: number) => stack.getByRole("listitem").filter({ has: page.getByRole("button", { name: `T${n}`, exact: true }) })
    const queue = async (order: number[]) => {
      for (const [index, n] of order.entries()) await expect(row(n)).toContainText(`waiting for a machine #${index + 1}`)
    }
    await checkpoint("working", async () => {
      await expect(row(1)).toContainText("Working", { timeout: 30_000 })
      await expect(row(2)).toContainText("Working")
      await queue([3, 4, 5])
    })
    await checkpoint("placed", async () => { await queue([6, 3, 4, 5]) })
    await checkpoint("reviewed", async () => {
      await expect(row(1)).toContainText("In review")
      await queue([6, 3, 4, 5])
    })
    await checkpoint("stopping", async () => {
      await expect(row(1)).toContainText("In review")
      await expect(row(6)).toContainText("Queued")
      await queue([6, 3, 4, 5])
    })
    await checkpoint("released", async () => {
      await expect(row(6)).toContainText("Working")
      await queue([3, 4, 5])
    })
    await checkpoint("settings", async () => {
      for (const parallel of [3, 4, 5, 6, 7, 8]) {
        await page.getByRole("button", { name: "More TODOs at once", exact: true }).press("Enter")
        await expect(page.locator("dt").filter({ hasText: /^TODOs at once$/ }).locator("xpath=following-sibling::dd[1]")).toContainText(String(parallel))
      }
      await expect(page.getByRole("button", { name: "More TODOs at once", exact: true })).toBeDisabled()
      expect(await page.evaluate(() => (window as unknown as ParallelAdmissionWindow).parallelAdmission.seeded())).toBe(false)
    })
    await checkpoint("raised", async () => {
      await expect(row(3)).toContainText("Working")
      await queue([4, 5])
      await page.reload()
      await expect(page.locator("dt").filter({ hasText: /^TODOs at once$/ }).locator("xpath=following-sibling::dd[1]")).toContainText("8")
      expect(await page.evaluate(() => (window as unknown as ParallelAdmissionWindow).parallelAdmission.effective())).toBe(3)
    })
    await checkpoint("zero", async () => {
      for (const n of [2, 3, 6]) await expect(row(n)).toContainText("Working")
      await queue([4, 5])
      await page.reload()
      await expect.poll(() => page.evaluate(() => (window as unknown as ParallelAdmissionWindow).parallelAdmission.effective())).toBe(0)
      await expect(page.locator("dt").filter({ hasText: /^TODOs at once$/ }).locator("xpath=following-sibling::dd[1]")).toContainText("8")
    })
    await checkpoint("person", async () => {
      await expect(row(4)).toContainText("waiting for a machine #2")
      await expect(row(5)).toContainText("waiting for a machine #3")
    })
    await checkpoint("granted", async () => {
      await expect(row(4)).toContainText("waiting for a machine #1")
      await expect(row(5)).toContainText("waiting for a machine #2")
      expect(errors).toEqual([])
    })
    expect(await exited, logs).toBe(0)
  } finally {
    // Release only this test's observation waits so Go can clean up its guests.
    for (const step of ["working", "placed", "reviewed", "stopping", "released", "settings", "raised", "zero", "person", "granted"]) await writeFile(join(directory, `${step}.done`), "finished")
    await exited
    await vite?.close()
    await rm(directory, { recursive: true, force: true })
  }
})
