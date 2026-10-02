import { expect, test } from "./browserTest"
import type { Page } from "./browserTest"
import { readFile } from "node:fs/promises"
import type { StorageRecoverySnapshot } from "../../src/mainview/chain/StorageRecovery"

const downloadRecovery = async (page: Page): Promise<StorageRecoverySnapshot> => {
  await expect(page.getByText("Recovery files can include private conversations", { exact: false })).toBeVisible()
  const downloaded = page.waitForEvent("download")
  await page.getByRole("button", { name: "Download local recovery file" }).click()
  const file = await downloaded
  expect(file.suggestedFilename()).toBe("smithers-local-recovery.json")
  expect(await file.failure()).toBeNull()
  const snapshot = JSON.parse(await readFile((await file.path())!, "utf8")) as StorageRecoverySnapshot
  expect(snapshot.format).toBe("smithers-ui-recovery")
  expect(snapshot.version).toBe(1)
  await expect(page.getByRole("status").filter({ hasText: "Recovery download prepared." })).toBeVisible()
  return snapshot
}

// Test-only access to the shipped worker protocol. No application debug API is
// added: mutations target only this test's isolated browser-profile database.
type ProbeWindow = Window & typeof globalThis & {
  sqliteProbe?: { readonly worker?: Worker; readonly url: string; readonly options?: WorkerOptions }
}

const trackDatabaseWorker = (page: Page) =>
  page.addInitScript(() => {
    const NativeWorker = window.Worker
    const instances = new WeakMap<Worker, { readonly url: string; readonly options?: WorkerOptions }>()
    window.Worker = class extends NativeWorker {
      constructor(url: string | URL, options?: WorkerOptions) {
        super(url, options)
        instances.set(this, { url: String(url), options })
      }
      override postMessage(message: unknown, options?: StructuredSerializeOptions | Transferable[]): void {
        if (
          typeof message === "object" && message !== null && "type" in message && message.type === "init" &&
          "databaseName" in message && message.databaseName === "smithers-mvp.sqlite"
        ) {
          const script = instances.get(this)!
          ;(window as ProbeWindow).sqliteProbe = { worker: this, ...script }
        }
        Reflect.apply(NativeWorker.prototype.postMessage, this, [message, options])
      }
    }
  })

/** Use the actual initialized worker, or reopen its raw database after boot refused/closed it. */
const queryDatabase = (page: Page, sql: string, reopen = false, executeTimeoutMs = 10_000) =>
  page.evaluate(async ({ sql, reopen, executeTimeoutMs }) => {
    const probe = (window as ProbeWindow).sqliteProbe
    if (probe === undefined) throw new Error("The app never opened its SQLite worker")
    const worker = reopen ? new Worker(probe.url, probe.options) : probe.worker
    if (worker === undefined) throw new Error("The live app worker is closed; explicitly reopen the physical database")
    const send = (request: Record<string, unknown>, timeoutMs = 10_000): Promise<unknown> =>
      new Promise((resolve, reject) => {
        const requestId = `storage-test-${crypto.randomUUID()}`
        const cleanup = () => {
          clearTimeout(timer)
          worker.removeEventListener("message", receive)
          worker.removeEventListener("error", failed)
          worker.removeEventListener("messageerror", unreadable)
        }
        const receive = (event: MessageEvent) => {
          if (event.data.requestId !== requestId) return
          cleanup()
          if (event.data.ok) resolve(event.data.rows ?? [])
          else reject(new Error(event.data.error))
        }
        const failed = (event: ErrorEvent) => {
          cleanup()
          reject(new Error(`SQLite test worker failed: ${event.message}`))
        }
        const unreadable = () => {
          cleanup()
          reject(new Error("SQLite test worker returned an unreadable response"))
        }
        const timer = setTimeout(() => {
          cleanup()
          reject(new Error(`SQLite test ${String(request.type)} request timed out after ${timeoutMs} ms`))
        }, timeoutMs)
        worker.addEventListener("message", receive)
        worker.addEventListener("error", failed)
        worker.addEventListener("messageerror", unreadable)
        try {
          worker.postMessage({ ...request, requestId })
        } catch (error) {
          cleanup()
          reject(error)
        }
      })
    let initialized = !reopen
    try {
      if (reopen) {
        await send({ type: "init", databaseName: "smithers-mvp.sqlite", vfsName: "opfs" })
        initialized = true
      }
      return await send({ type: "execute", sql, params: [] }, executeTimeoutMs)
    } finally {
      if (reopen) {
        try {
          if (initialized) await send({ type: "close" })
        } finally {
          worker.terminate()
        }
      }
    }
  }, { sql, reopen, executeTimeoutMs })

/** End the app's writer lifetime before injecting a committed physical change.
 * Sending raw SQL to its live worker could accidentally join an app transaction
 * and then roll back with that transaction when the page reloads. */
const closeAppForPhysicalMutation = async (appPage: Page): Promise<Page> => {
  const descriptor = await appPage.evaluate(() => {
    const probe = (window as ProbeWindow).sqliteProbe
    if (probe === undefined) throw new Error("The app never opened its SQLite worker")
    return { url: probe.url, options: probe.options }
  })
  const context = appPage.context()
  // Navigation can retain the outgoing document and its worker in BFCache.
  // Closing its Page ends that owner before a different Page opens SQLite.
  await appPage.close()
  const page = await context.newPage()
  await trackDatabaseWorker(page)
  await page.route("**/__storage-mutation-fixture", route => route.fulfill({
    status: 200,
    contentType: "text/html",
    // Match the native document policy. Adding isolation headers here blocks
    // its unchanged worker response before SQLite can initialize.
    headers: { "Cache-Control": "no-store" },
    body: "<!doctype html><title>Isolated storage fixture</title>"
  }))
  await page.goto("/__storage-mutation-fixture")
  await page.evaluate(descriptor => { (window as ProbeWindow).sqliteProbe = descriptor }, descriptor)
  return page
}

test("a newer physical OPFS store refuses the normal app boot without replacing its version", async ({ page: appPage }) => {
  await trackDatabaseWorker(appPage)
  await appPage.goto("/")
  await expect(appPage.getByTestId("composer-input")).toBeAttached()
  expect(await appPage.evaluate(() => localStorage.getItem("smithers-mvp.persistenceBackend"))).toBe("opfs")
  const page = await closeAppForPhysicalMutation(appPage)
  await queryDatabase(page, "UPDATE smithers_metadata SET value = '2147483647' WHERE key = 'schema-version'", true)
  // The separate reader proves the independent writer committed before boot.
  expect(await queryDatabase(page, "SELECT value FROM smithers_metadata WHERE key = 'schema-version'", true))
    .toEqual([{ value: "2147483647" }])
  await page.goto("/")
  await expect(page.getByRole("heading", { name: "This browser's saved data is from a newer Smithers. Update Smithers to open it." })).toBeVisible()
  await expect(page.getByTestId("composer-input")).toHaveCount(0)
  expect(await page.evaluate(() => localStorage.getItem("smithers-mvp.persistenceBackend"))).toBe("opfs")
  expect(await queryDatabase(page, "SELECT value FROM smithers_metadata WHERE key = 'schema-version'", true))
    .toEqual([{ value: "2147483647" }])
  const recovered = await downloadRecovery(page)
  expect(recovered.session).toBe("unopened")
  expect(recovered.sqlite?.find((table) => table.name === "smithers_metadata")?.rows)
    .toContainEqual([{ type: "text", value: "schema-version" }, { type: "text", value: "2147483647" }])
  expect(await queryDatabase(page, "SELECT value FROM smithers_metadata WHERE key = 'schema-version'", true))
    .toEqual([{ value: "2147483647" }])
})

for (const authority of ["corrupt", "missing"] as const) test(`${authority} OPFS application authority preserves damaged execution evidence through refused boot`, async ({ page: appPage }) => {
  await trackDatabaseWorker(appPage)
  await appPage.goto("/")
  await expect(appPage.getByTestId("composer-input")).toBeAttached()
  expect(await appPage.evaluate(() => localStorage.getItem("smithers-mvp.persistenceBackend"))).toBe("opfs")
  const page = await closeAppForPhysicalMutation(appPage)
  await queryDatabase(page, "INSERT INTO smithers_collection_rows VALUES ('app-events', 's:private-fixture', 'v1', 'private raw recovery fixture')", true)
  await queryDatabase(page, authority === "corrupt"
    ? "UPDATE smithers_collection_rows SET value = 'private invalid authority fixture' WHERE collection_id = 'app-event-heads'"
    : "DELETE FROM smithers_collection_rows WHERE collection_id IN ('app-event-heads', 'app-event-checkpoints', 'app-event-retirements')", true)
  const original = await queryDatabase(page, "SELECT * FROM smithers_collection_rows ORDER BY collection_id, row_key", true)
  expect(JSON.stringify(original)).toContain("private raw recovery fixture")
  if (authority === "corrupt") expect(JSON.stringify(original)).toContain("private invalid authority fixture")
  else expect(await queryDatabase(page, "SELECT value FROM smithers_collection_rows WHERE collection_id = 'app-event-heads'", true)).toEqual([])
  await page.goto("/")
  await expect(page.getByRole("heading", { name: "Smithers could not read this browser's saved data. Not your fault. It was kept as it was." })).toBeVisible()
  await expect(page.getByTestId("composer-input")).toHaveCount(0)
  await expect(page.locator("body")).not.toContainText("private raw recovery fixture")
  await expect(page.locator("body")).not.toContainText("private invalid authority fixture")
  expect(await queryDatabase(page, "SELECT * FROM smithers_collection_rows ORDER BY collection_id, row_key", true)).toEqual(original)
  expect(await queryDatabase(page, "SELECT value FROM smithers_row_quarantine WHERE row_key = 's:private-fixture'", true)).toEqual([])
  expect(JSON.stringify((await downloadRecovery(page)).sqlite)).toContain("private raw recovery fixture")
  await expect(page.locator("body")).not.toContainText("private raw recovery fixture")
})

for (const authority of ["corrupt", "missing"] as const) test(`${authority} localStorage authority refuses unreadable evidence without revealing private fixture bytes`, async ({ page }) => {
  await page.addInitScript(() => { localStorage.setItem("smithers-mvp.persistenceBackend", "localStorage") })
  await page.goto("/")
  await expect(page.getByTestId("composer-input")).toBeAttached()
  const original = await page.evaluate(authority => {
    const key = "smithers-mvp.store", envelope = JSON.parse(localStorage.getItem(key)!) as { version: number; entries: Record<string, string> }
    envelope.entries["smithers-mvp.app-events"] = "private local execution fixture"
    if (authority === "corrupt") envelope.entries["smithers-mvp.app-event-heads"] = "private local authority fixture"
    if (authority === "missing") for (const id of ["app-event-heads", "app-event-checkpoints", "app-event-retirements"]) {
      delete envelope.entries[`smithers-mvp.${id}`]
    }
    const raw = JSON.stringify(envelope)
    localStorage.setItem(key, raw)
    return raw
  }, authority)
  await page.reload()

  await expect(page.getByRole("heading", { name: "Smithers could not read this browser's saved data. Not your fault. It was kept as it was." })).toBeVisible()
  await expect(page.getByTestId("composer-input")).toHaveCount(0)
  expect(await page.evaluate(() => localStorage.getItem("smithers-mvp.store"))).toBe(original)
  expect((await downloadRecovery(page)).localStorage).toContainEqual({ key: "smithers-mvp.store", value: original })
  for (const fixture of ["private local execution fixture", "private local authority fixture"]) {
    await expect(page.locator("body")).not.toContainText(fixture)
  }
})

test("an unreadable localStorage envelope stops boot without erasing the original or displaying its contents", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("smithers-mvp.persistenceBackend", "localStorage")
    localStorage.setItem("smithers-mvp.store", "private unreadable envelope")
  })
  await page.goto("/")
  await expect(page.getByRole("heading", { name: "Smithers could not read this browser's saved data. Not your fault. It was kept as it was." })).toBeVisible()
  await expect(page.getByTestId("composer-input")).toHaveCount(0)
  await expect(page.locator("body")).not.toContainText("private unreadable envelope")
  expect(await page.evaluate(() => localStorage.getItem("smithers-mvp.store"))).toBe("private unreadable envelope")
  expect(await page.evaluate(() => localStorage.getItem("smithers-mvp.persistenceBackend"))).toBe("localStorage")
  expect((await downloadRecovery(page)).localStorage).toContainEqual({
    key: "smithers-mvp.store",
    value: "private unreadable envelope"
  })
  await expect(page.locator("body")).not.toContainText("private unreadable envelope")
})

test("a pre-backend-stamp localStorage conversation survives boot without creating fresh OPFS history", async ({ page }) => {
  await page.route("**/api/public/repos", route => route.fulfill({ json: { repos: [{ name: "smithersai/smithers" }] } }))
  await page.addInitScript(() => {
    if (sessionStorage.getItem("legacy-fixture-created") === null) {
      localStorage.setItem("smithers-mvp.persistenceBackend", "localStorage")
      sessionStorage.setItem("legacy-fixture-created", "1")
    }
  })
  await page.goto("/")
  await page.getByRole("button", { name: "Dismiss", exact: true }).click()
  await page.getByRole("button", { name: "Chat", exact: true }).click()
  await page.getByTestId("composer-input").fill("/agent.list")
  await page.getByTestId("composer-send").click()
  await expect(page.getByTestId("composer-input")).toHaveValue("")
  await page.getByTestId("composer-input").press("Escape")
  const card = page.getByTestId("transcript").locator(".smithers-card[data-kind=\"agents\"]")
  await expect(card).toBeVisible()
  const cardId = await card.getAttribute("data-testid")
  await page.evaluate(() => localStorage.removeItem("smithers-mvp.persistenceBackend"))
  await page.reload()
  await expect(page.getByTestId(cardId!)).toBeVisible()
  expect(await page.evaluate(() => localStorage.getItem("smithers-mvp.persistenceBackend"))).toBe("localStorage")
  const fileExists = await page.evaluate(async () => {
    const root = await navigator.storage.getDirectory()
    try {
      await root.getFileHandle("smithers-mvp.sqlite")
      return true
    } catch (error) {
      if (error instanceof DOMException && error.name === "NotFoundError") return false
      throw error
    }
  })
  expect(fileExists).toBe(false)
})

test("two unstamped stores refuse an arbitrary choice and leave the legacy original alone", async ({ page }) => {
  await trackDatabaseWorker(page)
  await page.goto("/")
  await expect(page.getByTestId("composer-input")).toBeAttached()
  expect(await page.evaluate(() => localStorage.getItem("smithers-mvp.persistenceBackend"))).toBe("opfs")
  await page.evaluate(() => {
    localStorage.setItem("smithers-mvp.app-messages", "separate legacy original")
    localStorage.removeItem("smithers-mvp.persistenceBackend")
  })
  await page.reload()
  await expect(page.getByRole("heading", { name: "This browser holds two copies of Smithers' saved data. Not your fault. Neither was changed." })).toBeVisible()
  await expect(page.getByTestId("composer-input")).toHaveCount(0)
  // The raw refusal stays behind Details; opening it is a keyboard-reachable act.
  await page.getByText("Details", { exact: true }).click()
  await expect(page.locator("details pre")).toContainText("another database may exist")
  expect(await page.evaluate(() => localStorage.getItem("smithers-mvp.app-messages"))).toBe("separate legacy original")
  expect(await page.evaluate(() => localStorage.getItem("smithers-mvp.persistenceBackend"))).toBeNull()
  expect(await page.evaluate(() => (window as ProbeWindow).sqliteProbe === undefined)).toBe(true)
  const recovered = await downloadRecovery(page)
  expect(recovered.localStorage).toContainEqual({ key: "smithers-mvp.app-messages", value: "separate legacy original" })
  expect(recovered.sqlite?.some((table) => table.name === "smithers_collection_rows")).toBe(true)
  expect(await page.evaluate(() => localStorage.getItem("smithers-mvp.persistenceBackend"))).toBeNull()
})

test("the running app offers the same private download through an embedded slash reply", async ({ page }) => {
  await page.route("**/api/public/repos", route => route.fulfill({ json: { repos: [{ name: "smithersai/smithers" }] } }))
  await page.goto("/")
  await expect(page.getByTestId("composer-input")).toBeAttached()
  await page.evaluate(() =>
    localStorage.setItem("smithers-mvp-quarantine.private-test", "older quarantined private fixture")
  )
  await page.getByRole("button", { name: "Dismiss", exact: true }).click()
  await page.getByRole("button", { name: "Chat", exact: true }).click()
  await page.getByTestId("composer-input").fill("/storage.recovery")
  await page.getByTestId("composer-send").click()
  await expect(page.getByTestId("composer-input")).toHaveValue("")
  await page.getByTestId("composer-input").press("Escape")
  const recovered = await downloadRecovery(page)
  expect(recovered.session).toBe("opfs")
  expect(recovered.localStorage).toContainEqual({
    key: "smithers-mvp-quarantine.private-test",
    value: "older quarantined private fixture"
  })
  expect(recovered.sqlite?.some((table) => table.name === "smithers_collection_rows")).toBe(true)
  await expect(page.getByTestId("composer-input")).toBeAttached()
  await expect(page.locator("body")).not.toContainText("older quarantined private fixture")
})

test("oversized physical event authority refuses without loading its bytes and the human reset reopens a fresh OPFS store", async ({ page: appPage }) => {
  await trackDatabaseWorker(appPage)
  await appPage.goto("/")
  await expect(appPage.getByTestId("composer-input")).toBeAttached()
  const page = await closeAppForPhysicalMutation(appPage)
  const bytes = 64 * 1024 * 1024 + 1
  // Writing the 64 MiB fixture can exceed a metadata request's budget on CI.
  // Wait for its commit once; a timeout must never retry this physical mutation.
  await queryDatabase(page, `INSERT INTO smithers_collection_rows (collection_id, row_key, version_key, value)
    VALUES ('app-events', 's:oversized-evidence', 'oversized-v1', CAST(zeroblob(${bytes}) AS TEXT))`, true, 30_000)
  const sizeQuery = "SELECT length(CAST(value AS BLOB)) AS bytes, version_key FROM smithers_collection_rows WHERE collection_id = 'app-events' AND row_key = 's:oversized-evidence'"
  expect(await queryDatabase(page, sizeQuery, true)).toEqual([{ bytes, version_key: "oversized-v1" }])
  await page.goto("/")
  // CI observed the 64 MiB OPFS refusal at 4.9 s, just before the default
  // assertion expired. Allow the physical read and React error panel to settle.
  await expect(page.getByRole("heading", { name: "This browser's saved data is too large for Smithers to open. Not your fault. It was kept as it was." })).toBeVisible({ timeout: 15_000 })
  await expect(page.getByText("The app-events store exceeds", { exact: false })).toBeHidden()
  await page.getByText("Details", { exact: true }).click()
  await expect(page.getByText("The app-events store exceeds", { exact: false })).toBeVisible()
  await expect(page.getByTestId("composer-input")).toHaveCount(0)
  expect(await queryDatabase(page, sizeQuery, true)).toEqual([{ bytes, version_key: "oversized-v1" }])
  await page.getByRole("button", { name: "Reset this browser's data", exact: true }).click()
  await expect(page.getByRole("button", { name: "Confirm: erase this browser's data", exact: true })).toBeVisible()
  // Arming the action alone does not change the committed physical source.
  expect(await queryDatabase(page, sizeQuery, true)).toEqual([{ bytes, version_key: "oversized-v1" }])
  await page.getByRole("button", { name: "Confirm: erase this browser's data", exact: true }).click()
  await expect(page.getByTestId("composer-input")).toBeAttached()
  expect(await page.evaluate(() => localStorage.getItem("smithers-mvp.persistenceBackend"))).toBe("opfs")
  expect(await queryDatabase(page, sizeQuery)).toEqual([])
  await page.close()
})
