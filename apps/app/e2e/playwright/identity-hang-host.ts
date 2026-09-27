/*
 * The boot-blocking fixture (boot-identity.spec.ts): the real local origin in
 * hybrid mode — identity capability ON — with the identity upstream behind a
 * socket that accepts and never answers, so `/api/user` pends for as
 * long as the server runs. The spec proves first paint never waits on it.
 * Prints SMITHERS_LOCAL_ORIGIN=http://127.0.0.1:<port> when listening.
 */
import { fileURLToPath } from "node:url"
import { startLocalServer } from "../../src/bun/server"

const hanging = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  // 255s is Bun's ceiling: the answer outlives every test budget, so the spec
  // can only pass with first paint that never waited on the identity seam.
  idleTimeout: 255,
  fetch: () => new Promise<Response>(() => {})
})

const server = await startLocalServer({
  port: 0,
  distDir: fileURLToPath(new URL("../../dist/", import.meta.url)),
  // No agent is injected, so the hybrid seam proxies to the hanging socket
  // above. No chat turn is ever started, so the real agent construction
  // never touches the network.
  cloudMode: "hybrid",
  identityUpstream: `http://127.0.0.1:${hanging.port}`,
  cloudApi: null,
  /*
   * The host now gives an upstream 20s to answer and then refuses with
   * `upstream_timeout` (server.ts DEFAULT_UPSTREAM_TIMEOUT_MS). This fixture's
   * whole premise is a seam that never answers WITHIN THE SPEC'S BUDGET, so
   * its deadline is pushed past the socket's own ceiling: a first paint that
   * waited on identity here still never paints.
   */
  upstreamTimeoutMs: 255_000
})

let shuttingDown = false
const shutdown = async (): Promise<void> => {
  if (shuttingDown) return
  shuttingDown = true
  hanging.stop(true)
  await server.stop()
  process.exit(0)
}
process.on("SIGINT", () => void shutdown())
process.on("SIGTERM", () => void shutdown())
