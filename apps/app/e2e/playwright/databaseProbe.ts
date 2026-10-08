import type { Page } from "./browserTest"

// Test-only access to the shipped worker protocol. No application debug API is
// added: mutations target only this test's isolated browser-profile database.
export type ProbeWindow = Window & typeof globalThis & {
  sqliteProbe?: { readonly worker?: Worker; readonly url: string; readonly options?: WorkerOptions }
}

export const trackDatabaseWorker = (page: Page) =>
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
export const queryDatabase = (page: Page, sql: string, reopen = false, executeTimeoutMs = 10_000) =>
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
          // Closing can flush the physical write; it needs that write's budget.
          if (initialized) await send({ type: "close" }, executeTimeoutMs)
        } finally {
          worker.terminate()
        }
      }
    }
  }, { sql, reopen, executeTimeoutMs })

