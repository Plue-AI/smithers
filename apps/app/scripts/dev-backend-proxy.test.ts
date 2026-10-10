import { expect, test } from "bun:test"
import { devBackendProxy } from "./dev-backend-proxy"

test("without a backend origin the dev server proxies nothing", () => {
  expect(devBackendProxy(undefined)).toBeUndefined()
  expect(devBackendProxy("")).toBeUndefined()
})

test("a loopback backend is this install: the API proxy keeps the dev server's Host for its origin authorizer", () => {
  for (const origin of ["http://127.0.0.1:4000", "http://localhost:4000", "http://[::1]:4000"]) {
    expect(devBackendProxy(origin)).toEqual({
      proxy: {
        "/api": { target: origin, changeOrigin: false, ws: true },
        "/readyz": origin
      }
    })
  }
})

test("a remote backend is reached by its own name, which TLS sends as SNI and the edge routes on", () => {
  for (const origin of ["https://canary.smithers.sh", "http://plue.example.test:8080"]) {
    expect(devBackendProxy(origin)?.proxy?.["/api"]).toEqual({ target: origin, changeOrigin: true, ws: true })
  }
})
