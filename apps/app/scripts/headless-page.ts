/*
 * Launch checklist (U7) — the real headless page driver.
 *
 * Implements scripts/launch-checklist/Types.ts's ProbePage over the Chrome
 * DevTools protocol against a system Chrome, the same way
 * scripts/web-chat-e2e.ts already drives the app. No Playwright, no download,
 * no new dependency: a checklist run either finds a browser or the browser
 * rows honestly report not-testable-yet.
 *
 * One browser is launched per run and one page is opened per distinct session
 * cookie, so a full §A-F pass costs one process, not thirty.
 */
import { existsSync } from "node:fs"
import { setTimeout as delay } from "node:timers/promises"
import { browserArgv, findBrowser, NO_BROWSER_REASON } from "./launch-checklist/BrowserLaunch.ts"
import { BrowserUnavailableError, type ProbePage } from "./launch-checklist/Types.ts"

const wait = (ms: number, signal?: AbortSignal): Promise<void> => delay(ms, undefined, { signal })

interface CdpConnection {
  send(method: string, params?: Record<string, unknown>, signal?: AbortSignal, sessionId?: string): Promise<any>
  close(): void
}

const connect = async (socketUrl: string, timeoutMs = 30_000, signal?: AbortSignal): Promise<CdpConnection> => {
  signal?.throwIfAborted()
  const socket = new WebSocket(socketUrl)
  let nextId = 0
  let disconnected: Error | undefined
  const pending = new Map<number, {
    method: string
    resolve(result: unknown): void
    reject(error: unknown): void
  }>()
  let rejectOpen: (error: unknown) => void = () => {}
  const disconnect = (error: Error): void => {
    disconnected ??= error
    rejectOpen(disconnected)
    for (const request of pending.values()) request.reject(disconnected)
  }
  socket.addEventListener("close", () => disconnect(new Error("CDP socket close")))
  socket.addEventListener("error", () => disconnect(new Error("CDP socket error")))
  socket.addEventListener("message", (event) => {
    let message: { id?: number; result?: unknown; error?: { code: number; message: string } }
    try {
      message = JSON.parse(String(event.data))
      if (message === null || typeof message !== "object") throw new Error("invalid message")
    } catch {
      disconnect(new Error("invalid CDP socket message"))
      socket.close()
      return
    }
    if (message.id === undefined) return
    const request = pending.get(message.id)
    if (request === undefined) return
    if (message.error !== undefined) {
      request.reject(new Error(`CDP ${request.method} request ${message.id} failed (${message.error.code}): ${message.error.message}`))
    } else if (!Object.hasOwn(message, "result")) {
      request.reject(new Error(`CDP ${request.method} request ${message.id} has no result`))
    } else {
      request.resolve(message.result)
    }
  })
  await new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer)
      signal?.removeEventListener("abort", abort)
      socket.removeEventListener("open", open)
      rejectOpen = () => {}
    }
    const open = () => { cleanup(); resolve() }
    rejectOpen = (error) => { cleanup(); reject(error) }
    const abort = () => { rejectOpen(signal?.reason); socket.close() }
    const timer = setTimeout(() => {
      disconnect(new Error(`CDP socket open timed out after ${timeoutMs}ms`))
      socket.close()
    }, timeoutMs)
    socket.addEventListener("open", open)
    signal?.addEventListener("abort", abort, { once: true })
    if (signal?.aborted) abort()
  })
  return {
    send: (method, params = {}, requestSignal, sessionId) =>
      new Promise((resolve, reject) => {
        if (disconnected !== undefined) return reject(disconnected)
        if (requestSignal?.aborted) return reject(requestSignal.reason)
        const id = (nextId += 1)
        const cleanup = () => {
          pending.delete(id)
          clearTimeout(timer)
          requestSignal?.removeEventListener("abort", abort)
        }
        const fail = (error: unknown) => { cleanup(); reject(error) }
        const abort = () => fail(requestSignal?.reason)
        const timer = setTimeout(() => fail(new Error(`CDP ${method} request ${id} timed out after ${timeoutMs}ms`)), timeoutMs)
        pending.set(id, {
          method,
          resolve: (result) => { cleanup(); resolve(result) },
          reject: fail
        })
        requestSignal?.addEventListener("abort", abort, { once: true })
        try {
          socket.send(JSON.stringify({ id, method, params, ...(sessionId === undefined ? {} : { sessionId }) }))
        } catch (error) {
          disconnect(new Error(`CDP socket send failed: ${String(error)}`))
        }
      }),
    close: () => {
      disconnect(new Error("CDP socket close"))
      socket.close()
    }
  }
}

/** One named key press, as real key events. */
const KEYS: Record<string, { key: string; code: string; keyCode: number; text?: string }> = {
  Enter: { key: "Enter", code: "Enter", keyCode: 13 },
  Escape: { key: "Escape", code: "Escape", keyCode: 27 },
  Tab: { key: "Tab", code: "Tab", keyCode: 9 },
  "/": { key: "/", code: "Slash", keyCode: 191, text: "/" }
}

export interface HeadlessBrowser {
  /** A page on `target` carrying `cookie`, cached per cookie for the run. */
  page(cookie: string | undefined, signal?: AbortSignal): Promise<ProbePage>
  close(): Promise<void>
}

export interface HeadlessBrowserOptions {
  readonly target: string
  readonly explicitBinary: string | undefined
  readonly env: Readonly<Record<string, string | undefined>>
  readonly port?: number
  readonly requestTimeoutMs?: number
}

export const createHeadlessBrowser = ({
  target,
  explicitBinary,
  env,
  port = 9444,
  requestTimeoutMs = 30_000
}: HeadlessBrowserOptions): HeadlessBrowser => {
  if (!Number.isFinite(requestTimeoutMs) || requestTimeoutMs <= 0) throw new Error("requestTimeoutMs must be positive and finite")
  const lifetime = new AbortController()
  const binary = findBrowser({ explicit: explicitBinary, env, exists: existsSync })
  const pages = new Map<string | undefined, Promise<ProbePage>>()
  let process: { kill(): void } | undefined
  const connections: Array<CdpConnection> = []

  const launchOnce = (): void => {
    if (process !== undefined || binary === undefined) return
    process = Bun.spawn(
      [...browserArgv(binary, port, `${env.TMPDIR ?? "/tmp"}/smithers-launch-checklist-profile`)],
      { stdout: "ignore", stderr: "ignore" }
    )
  }

  let browserConnection: Promise<CdpConnection> | undefined
  const openBrowser = async (signal: AbortSignal): Promise<CdpConnection> => {
    for (let attempt = 0; attempt < 80; attempt += 1) {
      signal.throwIfAborted()
      let socketUrl: string | undefined
      try {
        const response = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.any([signal, AbortSignal.timeout(requestTimeoutMs)]) })
        const descriptor = (await response.json()) as { webSocketDebuggerUrl?: string }
        socketUrl = descriptor.webSocketDebuggerUrl
      } catch {
        signal.throwIfAborted()
        // Chrome is still starting up; each HTTP attempt is also bounded.
      }
      if (socketUrl !== undefined) {
        const connection = await connect(socketUrl, requestTimeoutMs, signal)
        connections.push(connection)
        return connection
      }
      await wait(250, signal)
    }
    throw new BrowserUnavailableError(`the browser at ${binary} never exposed a DevTools endpoint on port ${port}`)
  }

  const createPage = async (cookie: string | undefined, signal: AbortSignal): Promise<ProbePage> => {
    launchOnce()
    if (browserConnection === undefined) {
      const opening = openBrowser(signal)
      browserConnection = opening
      const abort = () => {
        if (browserConnection === opening) browserConnection = undefined
      }
      signal.addEventListener("abort", abort, { once: true })
      void opening.then(
        () => signal.removeEventListener("abort", abort),
        () => {
          abort()
          signal.removeEventListener("abort", abort)
        }
      )
    }
    const root = await browserConnection
    const { browserContextId } = await root.send("Target.createBrowserContext", { disposeOnDetach: true }, signal)
    const { targetId } = await root.send("Target.createTarget", { url: "about:blank", browserContextId }, signal)
    const { sessionId } = await root.send("Target.attachToTarget", { targetId, flatten: true }, signal)
    const cdp: CdpConnection = {
      send: (method, params, signal) => root.send(method, params, signal, sessionId),
      close: () => root.close()
    }
    await cdp.send("Page.enable", {}, signal)
    await cdp.send("Runtime.enable", {}, signal)
    await cdp.send("Network.enable", {}, signal)
    if (cookie !== undefined) {
      const cookies = cookie.split(";").map((part) => {
        const separator = part.indexOf("=")
        if (separator <= 0 || part.slice(0, separator).trim() === "") throw new Error("invalid session cookie pair")
        return {
          name: part.slice(0, separator).trim(),
          value: part.slice(separator + 1).trim(),
          url: target,
          path: "/",
          secure: true,
          httpOnly: true
        }
      })
      await cdp.send("Network.setCookies", { cookies }, signal)
    }
    // A fresh slate: a previous run's persisted transcript must never be read as this run's.
    await cdp.send("Storage.clearDataForOrigin", {
      origin: new URL(target).origin,
      storageTypes: "file_systems,local_storage,indexeddb,cache_storage,websql,service_workers"
    }, signal)
    const evaluate = async <T>(expression: string, signal?: AbortSignal): Promise<T> => {
      const answer = await cdp.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, signal)
      if (answer?.exceptionDetails !== undefined) {
        throw new Error(`page evaluation failed: ${JSON.stringify(answer.exceptionDetails).slice(0, 300)}`)
      }
      const remote = answer?.result
      if (remote?.type === "undefined" && !Object.hasOwn(remote, "value")) return undefined as T
      if (remote === null || typeof remote !== "object" || !Object.hasOwn(remote, "value") ||
        !["string", "number", "boolean", "object"].includes(remote.type) ||
        (remote.value !== null && typeof remote.value !== remote.type) ||
        (remote.value === null && (remote.type !== "object" || remote.subtype !== "null"))) {
        throw new Error("invalid Runtime.evaluate response: expected a value returned by value")
      }
      return remote.value as T
    }
    const navigate = async (signal?: AbortSignal): Promise<void> => {
      await cdp.send("Page.navigate", { url: target }, signal)
      for (let attempt = 0; attempt < 80; attempt += 1) {
        const ready = await evaluate<boolean>(`document.readyState === "complete"`, signal)
        if (ready === true) return
        await wait(250, signal)
      }
      throw new Error("page navigation timed out waiting for document readiness")
    }
    await navigate(signal)
    const dispatch = async (
      descriptor: { key: string; code: string; keyCode: number; text?: string },
      signal?: AbortSignal
    ): Promise<void> => {
      for (const type of ["keyDown", "keyUp"]) {
        await cdp.send("Input.dispatchKeyEvent", {
          type,
          key: descriptor.key,
          code: descriptor.code,
          windowsVirtualKeyCode: descriptor.keyCode,
          nativeVirtualKeyCode: descriptor.keyCode,
          ...(type === "keyDown" && descriptor.text !== undefined ? { text: descriptor.text } : {})
        }, signal)
      }
    }
    return {
      text: (signal) => evaluate<string>("document.body.innerText", signal),
      evaluate,
      type: async (value: string, signal?: AbortSignal) => {
        for (const character of value) {
          await dispatch({
            key: character,
            code: `Key${character.toUpperCase()}`,
            keyCode: character.charCodeAt(0),
            text: character
          }, signal)
        }
      },
      press: async (key: string, signal?: AbortSignal) => {
        const descriptor = KEYS[key]
        if (descriptor === undefined) throw new Error(`no key descriptor for ${key}`)
        await dispatch(descriptor, signal)
      },
      reload: navigate
    }
  }

  return {
    page: (cookie, rowSignal) => {
      const signal = rowSignal === undefined ? lifetime.signal : AbortSignal.any([lifetime.signal, rowSignal])
      if (signal.aborted) return Promise.reject(signal.reason)
      if (binary === undefined) return Promise.reject(new BrowserUnavailableError(NO_BROWSER_REASON))
      const key = cookie
      const existing = pages.get(key)
      if (existing !== undefined) return existing
      const created = createPage(cookie, signal).catch((error) => {
        pages.delete(key)
        throw error
      })
      pages.set(key, created)
      signal.addEventListener("abort", () => {
        if (pages.get(key) === created) pages.delete(key)
      }, { once: true })
      return created
    },
    close: async () => {
      lifetime.abort(new Error("headless browser closed"))
      try {
        for (const connection of connections) connection.close()
      } finally {
        process?.kill()
      }
    }
  }
}
