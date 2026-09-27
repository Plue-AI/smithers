const minimumDelay = 30_000
const maximumDelay = 300_000

// Retry-After can be delta seconds or an HTTP date. Receipt failures may be
// aggregated by the durable bridge; honor the longest refusal in the batch.
const retryDelay = (error: unknown): number => {
  if (error instanceof AggregateError) return Math.max(0, ...error.errors.map(retryDelay))
  if (!error || typeof error !== "object" || !("retryAfter" in error) || typeof error.retryAfter !== "string") return 0
  const value = error.retryAfter.trim()
  const milliseconds = /^\d+(\.\d+)?$/.test(value) ? Number(value) * 1000 : Date.parse(value) - Date.now()
  return Number.isFinite(milliseconds) ? Math.max(0, milliseconds) : 0
}

/** Signals are hints; only the existing durable drain claims and settles work. */
export const runDeliveries = async (options: {
  owner: string
  repo: string
  request: (path: string, init?: RequestInit) => Promise<Response>
  drain: () => Promise<number>
  signal: AbortSignal
  onError?: () => void
}) => {
  const { signal } = options
  let pending = true
  let notify: (() => void) | undefined
  let blockedUntil = 0
  const wake = () => { pending = true; notify?.() }
  const wait = (milliseconds: number, interruptible = false) => new Promise<void>(resolve => {
    if (signal.aborted || (interruptible && pending)) return resolve()
    const finish = () => {
      clearTimeout(timer)
      signal.removeEventListener("abort", finish)
      if (notify === finish) notify = undefined
      resolve()
    }
    // Recheck long server deadlines in bounded slices: Node turns a delay
    // above its signed 32-bit timer limit into a one-millisecond busy loop.
    const timer = setTimeout(finish, Math.min(milliseconds, maximumDelay))
    if (interruptible) notify = finish
    signal.addEventListener("abort", finish, { once: true })
  })
  const backoff = (error: unknown, delay: number) => {
    const duration = Math.max(delay, retryDelay(error))
    blockedUntil = Math.max(blockedUntil, Date.now() + retryDelay(error))
    return duration
  }
  const stream = async () => {
    let cursor = "", delay = minimumDelay
    const path = `/api/repos/${encodeURIComponent(options.owner)}/${encodeURIComponent(options.repo)}/issues/state-events/stream`
    while (!signal.aborted) {
      let retry = delay
      let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
      try {
        while (!signal.aborted && Date.now() < blockedUntil) await wait(blockedUntil - Date.now())
        if (signal.aborted) break
        const response = await options.request(path, {
          signal, headers: { Accept: "text/event-stream", ...(cursor ? { "Last-Event-ID": cursor } : {}) }
        })
        if (!response.ok || !response.body || !response.headers.get("content-type")?.includes("text/event-stream")) {
          await response.body?.cancel()
          throw Object.assign(new Error("Issue stream unavailable"), { retryAfter: response.headers.get("Retry-After") })
        }
        // Catch anything committed between the startup drain and subscription,
        // and anything missed across a stream disconnection.
        wake()
        reader = response.body.getReader()
        const activeReader = reader
        const cancel = () => { void activeReader.cancel().catch(() => {}) }
        signal.addEventListener("abort", cancel, { once: true })
        try {
          const decoder = new TextDecoder()
          let buffer = "", event = "", id = "", data = false
          while (!signal.aborted) {
            const chunk = await reader.read()
            if (chunk.done) break
            delay = minimumDelay
            buffer += decoder.decode(chunk.value, { stream: true })
            if (buffer.length > 4 * 1024 * 1024) throw new Error("Issue stream frame too large")
            let end: number
            while ((end = buffer.indexOf("\n")) >= 0) {
              const line = buffer.slice(0, end).replace(/\r$/, "")
              buffer = buffer.slice(end + 1)
              if (line === "") {
                if ((event === "issue.fact" || event === "issue.sync") && data) {
                  if (/^\d+$/.test(id)) cursor = id
                  wake()
                }
                if (event === "stream.error" || event === "revoked") throw new Error("Issue stream interrupted")
                event = ""; id = ""; data = false
              } else if (line.startsWith("event:")) event = line.slice(6).trim()
              else if (line.startsWith("id:")) id = line.slice(3).trim()
              else if (line.startsWith("data:")) data = true
            }
          }
        } finally {
          signal.removeEventListener("abort", cancel)
        }
      } catch (error) {
        retry = backoff(error, delay)
        if (!signal.aborted) options.onError?.()
      } finally {
        await reader?.cancel().catch(() => {})
        reader?.releaseLock()
      }
      await wait(retry)
      delay = Math.min(maximumDelay, delay * 2)
    }
  }
  const drain = async () => {
    let delay = minimumDelay
    while (!signal.aborted) {
      // Wakes are latched during rate-limit backoff, never allowed to shorten it.
      if (Date.now() < blockedUntil) { await wait(blockedUntil - Date.now()); continue }
      pending = false
      let retry = delay
      try {
        const completed = await options.drain()
        delay = completed > 0 ? minimumDelay : Math.min(maximumDelay, delay * 2)
      } catch (error) {
        retry = backoff(error, delay)
        blockedUntil = Math.max(blockedUntil, Date.now() + retry)
        delay = Math.min(maximumDelay, delay * 2)
        if (!signal.aborted) options.onError?.()
      }
      await wait(retry, true)
    }
  }
  await Promise.all([stream(), drain()])
}
