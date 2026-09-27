import { readFile } from "node:fs/promises"
import { setTimeout as delay } from "node:timers/promises"
import { Schema } from "effect"
import { Configuration, openHost } from "./runtime.ts"
import { runDeliveries } from "./delivery.ts"

const required = (name: string) => {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`Missing ${name}`)
  return value
}

export const serve = async () => {
  process.umask(0o077)
  const config = Schema.decodeUnknownSync(Configuration)(JSON.parse(await readFile(required("SMITHERS_CHAT_CONNECTOR_CONFIG"), "utf8")))
  const origin = new URL(required("SMITHERS_CHAT_CONNECTOR_URL"))
  if (origin.protocol !== "http:" || origin.hostname !== "127.0.0.1" || origin.username || origin.password) throw new Error("Connector backend must be loopback")
  const credential = required("SMITHERS_CHAT_CONNECTOR_TOKEN_FILE")
  const stopped = new AbortController()
  const stop = () => stopped.abort()
  process.once("SIGTERM", stop)
  process.once("SIGINT", stop)
  process.stdin.resume()
  process.stdin.once("end", stop)
  const request = async (path: string, init?: RequestInit) => {
    if (!path.startsWith("/api/repos/") || path.startsWith("//")) throw new Error("Invalid connector API path")
    const headers = new Headers(init?.headers)
    headers.set("Authorization", `token ${(await readFile(credential, "utf8")).trim()}`)
    return fetch(new URL(path, origin), { ...init, headers, redirect: "error", signal: AbortSignal.any([stopped.signal, init?.signal ?? AbortSignal.timeout(30_000)]) })
  }
  let host: Awaited<ReturnType<typeof openHost>> | undefined
  try {
    // The backend starts its critical workers before opening its HTTP listener.
    for (let attempt = 0; ; attempt++) {
      if (stopped.signal.aborted) return
      const ready = await fetch(new URL("/healthz", origin), { signal: AbortSignal.timeout(1000) }).then(r => r.ok, () => false)
      if (ready) break
      if (attempt === 59) throw new Error("Connector backend did not become available")
      await delay(1000, undefined, { signal: stopped.signal })
    }
    host = await openHost({ config, env: process.env, stateRoot: required("SMITHERS_CHAT_CONNECTOR_STATE"), request })
    console.info("Chat connectors: durable store opened")
    await Promise.all([host.run(stopped.signal), runDeliveries({
      ...config, request, drain: host.drain, signal: stopped.signal,
      // Never log raw provider errors: they may contain credentials.
      onError: () => console.error("Chat connector delivery unavailable; backing off")
    })])
  } catch (error) {
    if (!stopped.signal.aborted) throw error
  } finally {
    stopped.abort()
    await host?.close()
    process.removeListener("SIGTERM", stop)
    process.removeListener("SIGINT", stop)
    process.stdin.removeListener("end", stop)
  }
}

if (process.argv.includes("--help")) {
  console.info("Smithers chat connector host; configured by SMITHERS_CHAT_CONNECTOR_* settings")
} else {
  serve().catch(() => {
    // Signal cancellation is a clean stop; all other failures make the
    // backend's critical worker unavailable and let its supervisor recover.
    console.error("Chat connector host stopped")
    process.exitCode = 1
  })
}
