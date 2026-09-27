import type { ServerWebSocket } from "bun"
import { existsSync, statSync } from "node:fs"
import { join, normalize, resolve } from "node:path"

type Tunnel = {
  target: string
  headers: Record<string, string>
  generation: number
  upstream?: WebSocket
  pending: Array<string | Buffer>
  pendingBytes: number
}

// CEF sends terminal keystrokes as individual frames while the first WSS handshake is pending.
const MAX_PENDING_BYTES = 1024 * 1024

type StoredCookie = { name: string; value: string; path: string; expiresAt?: number }

const cookiePathMatches = (requestPath: string, cookiePath: string): boolean =>
  requestPath === cookiePath || requestPath.startsWith(cookiePath.endsWith("/") ? cookiePath : `${cookiePath}/`)

const storeCookies = (jar: Map<string, StoredCookie>, response: Response): void => {
  for (const raw of response.headers.getSetCookie()) {
    const [pair, ...attributes] = raw.split(";")
    const equals = pair?.indexOf("=") ?? -1
    if (equals <= 0) continue
    const name = pair!.slice(0, equals).trim()
    const value = pair!.slice(equals + 1).trim()
    if (!name || /[\s;,=]/.test(name)) continue
    let path = "/"
    let expiresAt: number | undefined
    let maxAge: number | undefined
    for (const attribute of attributes) {
      const [key, ...rest] = attribute.trim().split("=")
      const setting = rest.join("=").trim()
      if (key?.toLowerCase() === "path" && setting.startsWith("/")) path = setting
      if (key?.toLowerCase() === "expires") {
        const parsed = Date.parse(setting)
        if (!Number.isNaN(parsed)) expiresAt = parsed
      }
      if (key?.toLowerCase() === "max-age" && /^-?\d+$/.test(setting)) maxAge = Number(setting)
    }
    if (maxAge !== undefined) expiresAt = Date.now() + maxAge * 1000
    const key = `${name}\0${path}`
    if (value === "" || (expiresAt !== undefined && expiresAt <= Date.now())) jar.delete(key)
    else jar.set(key, { name, value, path, expiresAt })
  }
}

const cookiesFor = (jar: Map<string, StoredCookie>, path: string): string | undefined => {
  const values: string[] = []
  for (const [key, cookie] of jar) {
    if (cookie.expiresAt !== undefined && cookie.expiresAt <= Date.now()) {
      jar.delete(key)
      continue
    }
    if (cookiePathMatches(path, cookie.path)) values.push(`${cookie.name}=${cookie.value}`)
  }
  return values.length === 0 ? undefined : values.join("; ")
}

const rendererCSRF = (jar: Map<string, StoredCookie>): string => {
  const csrf = [...jar.values()].find((cookie) => cookie.name === "__csrf" && cookie.path === "/" &&
    (cookie.expiresAt === undefined || cookie.expiresAt > Date.now()))
  return csrf === undefined
    ? "__csrf=; Path=/; Max-Age=0; SameSite=Strict"
    : `__csrf=${csrf.value}; Path=/; SameSite=Strict${csrf.expiresAt === undefined ? "" :
      `; Max-Age=${Math.max(0, Math.ceil((csrf.expiresAt - Date.now()) / 1000))}`}`
}

const csrfFor = (jar: Map<string, StoredCookie>): string | undefined =>
  [...jar.values()].find((cookie) => cookie.name === "__csrf" && cookie.path === "/" &&
    (cookie.expiresAt === undefined || cookie.expiresAt > Date.now()))?.value

/**
 * The one row this relay adds to a backend's bootstrap: the desktop shell
 * serves this origin (`native.shell`, packages/rpc/src/AppBootstrap.ts). The
 * backend — owned Go or Plue — is a web origin and cannot know which shell
 * shows its page, so the shell says so here and the app reads only this row
 * for native-shell UI. Anything that is not a bootstrap document is relayed
 * untouched, including a 404 for a backend without one.
 */
const withNativeShell = (body: unknown): unknown => {
  if (typeof body !== "object" || body === null || !Array.isArray((body as { capabilities?: unknown }).capabilities)) return body
  const capabilities = (body as { capabilities: Array<unknown> }).capabilities
  return capabilities.includes("native.shell") ? body : { ...body, capabilities: [...capabilities, "native.shell"] }
}

/** The packaged native UI always serves locally and relays only API paths. */
export const startNativeRendererServer = (distDirectory: string, apiOrigin: string, apiToken = ""): {
  readonly origin: string
  readonly stop: () => void
  readonly setTarget: (apiOrigin: string, apiToken?: string) => void
} => {
  const dist = resolve(distDirectory)
  const index = join(dist, "index.html")
  if (!existsSync(index)) throw new Error(`The packaged UI is missing ${index}.`)
  const parseTarget = (value: string): URL => {
    let target: URL
    try { target = new URL(value) }
    catch { throw new Error("Native API origin must be a credential-free HTTP(S) origin.") }
    if (!/^https?:$/.test(target.protocol) || target.username || target.password ||
      target.pathname !== "/" || target.search || target.hash) {
      throw new Error("Native API origin must be a credential-free HTTP(S) origin.")
    }
    return target
  }
  let remote = parseTarget(apiOrigin)
  let credential = apiToken.trim()
  let generation = 0
  let origin = ""
  // A target's cookies live only in this process and never enter the shared renderer jar.
  const jars = new Map<string, Map<string, StoredCookie>>()
  const identity = (target: URL, token: string): string => `${target.origin}\0${token}`
  const jarFor = (target: URL, token: string): Map<string, StoredCookie> => {
    const key = identity(target, token)
    let jar = jars.get(key)
    if (jar === undefined) { jar = new Map(); jars.set(key, jar) }
    return jar
  }
  const selectedAuthorization = (request: Request, token: string): string | undefined => {
    if (token === "") return undefined
    const value = request.headers.get("authorization")
    return value === `Bearer ${token}` || value === `token ${token}` ? value : undefined
  }
  const tunnels = new Set<ServerWebSocket<Tunnel>>()
  const inFlight = new Set<AbortController>()
  const activeBodies = new Set<() => void>()
  const server = Bun.serve<Tunnel>({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request, server) => {
      const url = new URL(request.url)
      if (url.pathname.startsWith("/api/")) {
        const selected = remote
        const selectedToken = credential
        const selectedGeneration = generation
        const jar = jarFor(selected, selectedToken)
        const target = new URL(url.pathname + url.search, selected)
        if (request.headers.get("upgrade")?.toLowerCase() === "websocket") {
          if (request.headers.get("origin") !== origin) return new Response("Invalid origin", { status: 403 })
          target.protocol = target.protocol === "https:" ? "wss:" : "ws:"
          const headers: Record<string, string> = { origin: selected.origin }
          const cookie = cookiesFor(jar, url.pathname)
          if (cookie !== undefined) headers.cookie = cookie
          const authorization = selectedAuthorization(request, selectedToken)
          if (authorization !== undefined) headers.authorization = authorization
          return server.upgrade(request, { data: { target: target.toString(), headers,
            generation: selectedGeneration, pending: [], pendingBytes: 0 } })
            ? undefined : new Response("Upgrade required", { status: 426 })
        }
        const headers = new Headers(request.headers)
        headers.delete("host")
        headers.delete("origin")
        headers.delete("cookie")
        headers.delete("authorization")
        const authorization = selectedAuthorization(request, selectedToken)
        if (authorization !== undefined) headers.set("authorization", authorization)
        const cookie = cookiesFor(jar, url.pathname)
        if (cookie !== undefined) headers.set("cookie", cookie)
        // The renderer may still hold the previous target's readable CSRF cookie.
        if (headers.get("x-csrf-token") !== csrfFor(jar)) headers.delete("x-csrf-token")
        const controller = new AbortController()
        inFlight.add(controller)
        let response: Response
        try {
          response = await fetch(new Request(target, {
            method: request.method,
            headers,
            body: request.method === "GET" || request.method === "HEAD" ? undefined : request.body,
            redirect: "manual",
            signal: controller.signal
          }))
        } catch (error) {
          inFlight.delete(controller)
          if (selectedGeneration !== generation) return new Response("Backend changed", { status: 409 })
          throw error
        }
        if (selectedGeneration !== generation) {
          inFlight.delete(controller)
          await response.body?.cancel()
          return new Response("Backend changed", { status: 409 })
        }
        inFlight.delete(controller)
        storeCookies(jar, response)
        // fetch has already decoded the body; the original encoding and
        // length would make the renderer decode it a second time.
        const relayed = new Headers(response.headers)
        relayed.delete("set-cookie")
        relayed.set("set-cookie", rendererCSRF(jar))
        relayed.delete("content-encoding")
        relayed.delete("content-length")
        if (url.pathname === "/api/bootstrap" && request.method === "GET" && response.ok) {
          let body: unknown
          try { body = await response.json() }
          catch { return new Response("Backend returned an invalid Smithers bootstrap.", { status: 502 }) }
          if (selectedGeneration !== generation) return new Response("Backend changed", { status: 409 })
          relayed.set("content-type", "application/json")
          return new Response(JSON.stringify(withNativeShell(body)), { status: response.status, statusText: response.statusText, headers: relayed })
        }
        const reader = response.body?.getReader()
        let finished = false
        let outputController: ReadableStreamDefaultController<Uint8Array> | undefined
        const invalidate = () => {
          if (finished) return
          finished = true
          activeBodies.delete(invalidate)
          outputController?.close()
          void reader?.cancel().catch(() => {})
        }
        const body = reader === undefined ? null : new ReadableStream<Uint8Array>({
          start(output) { outputController = output; activeBodies.add(invalidate) },
          async pull(output) {
            try {
              if (selectedGeneration !== generation) throw new Error("Backend changed")
              const chunk = await reader.read()
              if (selectedGeneration !== generation) throw new Error("Backend changed")
              if (finished) return
              if (chunk.done) { finished = true; activeBodies.delete(invalidate); output.close() }
              else output.enqueue(chunk.value)
            } catch (error) {
              if (finished) return
              finished = true
              activeBodies.delete(invalidate)
              void reader.cancel().catch(() => {})
              output.error(error)
            }
          },
          async cancel(reason) {
            finished = true
            activeBodies.delete(invalidate)
            await reader.cancel(reason)
          }
        })
        return new Response(body, { status: response.status, statusText: response.statusText, headers: relayed })
      }
      let decoded: string
      try { decoded = decodeURIComponent(url.pathname) }
      catch { return new Response("Invalid path", { status: 400 }) }
      const relative = normalize(decoded).replace(/^\/+/, "")
      const file = resolve(dist, relative)
      if (relative !== "" && file.startsWith(dist + "/") && statSync(file, { throwIfNoEntry: false })?.isFile()) {
        return new Response(Bun.file(file), { headers: { "cache-control": relative.startsWith("assets/")
          ? "public, max-age=31536000, immutable" : "no-store" } })
      }
      return new Response(Bun.file(index), { headers: { "cache-control": "no-store", "content-type": "text/html; charset=utf-8" } })
    },
    websocket: {
      maxPayloadLength: 1024 * 1024,
      backpressureLimit: 1024 * 1024,
      closeOnBackpressureLimit: true,
      open(socket) {
        tunnels.add(socket)
        const tunnel = socket.data
        if (tunnel.generation !== generation) { socket.terminate(); return }
        const upstream = new WebSocket(tunnel.target, { headers: tunnel.headers } as never)
        tunnel.upstream = upstream
        upstream.binaryType = "arraybuffer"
        upstream.addEventListener("open", () => {
          if (tunnel.generation !== generation) { upstream.close(); return }
          for (const frame of tunnel.pending) upstream.send(frame)
          tunnel.pending.length = 0
          tunnel.pendingBytes = 0
        })
        upstream.addEventListener("message", (event) => {
          if (tunnel.generation === generation) socket.send(event.data as string | ArrayBuffer)
        })
        upstream.addEventListener("close", (event) => {
          tunnels.delete(socket)
          if (event.code === 1005 || event.code === 1006 || event.code === 1001) socket.terminate()
          else socket.close(event.code, event.reason)
        })
        upstream.addEventListener("error", () => {
          tunnels.delete(socket)
          socket.terminate()
        })
      },
      message(socket, frame) {
        const tunnel = socket.data
        if (tunnel.generation !== generation) { socket.terminate(); return }
        if (tunnel.upstream?.readyState === WebSocket.OPEN) {
          if (tunnel.upstream.bufferedAmount > MAX_PENDING_BYTES) socket.close(1009, "Terminal input outran backend")
          else tunnel.upstream.send(frame)
        } else if (tunnel.upstream?.readyState === WebSocket.CONNECTING) {
          const bytes = typeof frame === "string" ? Buffer.byteLength(frame) : frame.byteLength
          if (tunnel.pendingBytes + bytes > MAX_PENDING_BYTES) socket.close(1009, "Terminal input outran backend")
          else {
            tunnel.pending.push(frame)
            tunnel.pendingBytes += bytes
          }
        } else socket.close(1011, "Backend socket did not open")
      },
      close(socket) {
        tunnels.delete(socket)
        try { socket.data.upstream?.close() }
        catch { /* The backend socket may have failed before its handshake completed. */ }
      }
    }
  })
  origin = `http://127.0.0.1:${server.port}`
  return {
    origin,
    stop: () => {
      for (const controller of inFlight) controller.abort()
      for (const invalidate of activeBodies) invalidate()
      for (const socket of tunnels) socket.terminate()
      jars.clear()
      server.stop(true)
    },
    setTarget: (apiOrigin, apiToken = "") => {
      const next = parseTarget(apiOrigin)
      const nextToken = apiToken.trim()
      if (identity(next, nextToken) === identity(remote, credential)) return
      remote = next
      credential = nextToken
      generation++
      for (const controller of inFlight) controller.abort()
      for (const invalidate of activeBodies) invalidate()
      for (const socket of tunnels) socket.terminate()
    }
  }
}
