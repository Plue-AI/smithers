import type { ServerOptions } from "vite"

const loopbackHosts = new Set(["127.0.0.1", "localhost", "[::1]"])

/**
 * The dev server's relay to SMITHERS_DEV_BACKEND_ORIGIN.
 *
 * A loopback backend is this install (local-own): it authorizes requests
 * against its public origin, which is this dev server, so the Host header
 * passes through. A remote backend (local-plue's Plue deployment) must see
 * its own name: TLS sends the Host as SNI, and an edge routes on it.
 */
export const devBackendProxy = (origin: string | undefined): ServerOptions | undefined => {
  if (!origin) return undefined
  const remote = !loopbackHosts.has(new URL(origin).hostname)
  return {
    proxy: {
      "/api": { target: origin, changeOrigin: remote, ws: true },
      "/readyz": origin
    }
  }
}
