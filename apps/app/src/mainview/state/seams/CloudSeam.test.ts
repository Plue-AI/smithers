import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { LOCAL_SESSION_HEADER } from "@smthrs/rpc/LocalSession"
import { createCloudAuth } from "../../../bun/CloudAuth"
import { startLocalServer } from "../../../bun/server"
import { createWorkspaceSeam, DEGRADED_WORKSPACE_REFUSAL } from "./WorkspaceSeam"
import type { StorageApi } from "@tanstack/db"
import { describe, expect, test } from "bun:test"
import {
  CLOUD_AUTH_SESSION_PATH,
  CLOUD_AUTH_SIGN_OUT_PATH,
  CLOUD_AUTH_START_PATH
} from "@smthrs/rpc/CloudTunnel"
import { createAppStore } from "../AppStore"
import type { AppStore } from "../AppStore"
import { createCloudSeam } from "./CloudSeam"
import type { SeamContext } from "./SeamContext"

/*
 * The cloud session seam (lane piper step 1b): the renderer mirrors only
 * `{ state, username, expiresAt, scopes? }` — the wire answer carries no
 * token and the store row must not either. Sign-in POSTs start, opens the
 * URL through the injected openExternal door, and polls until the callback
 * lands (or the Bun side's five-minute wait expires back to signed-out).
 */

const memoryStorage = (): StorageApi => {
  const data = new Map<string, string>()
  return {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => void data.set(key, value),
    removeItem: (key) => void data.delete(key)
  }
}

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })

const TOKEN = "smithers_never_in_the_renderer"

const harness = async (route: (path: string, init?: RequestInit) => Response | Promise<Response>, timeoutMs = 2000) => {
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  const requests: Array<{ readonly method: string; readonly url: string }> = []
  const ctx: SeamContext = {
    http: async (input, init) => {
      requests.push({ method: init?.method ?? "GET", url: input })
      return route(input, init)
    },
    baseUrl: "",
    store,
    dispatch: store.dispatch,
    actor: () => "user",
    nextOrdinal: () => 0
  }
  const opened: Array<string> = []
  const seam = createCloudSeam(ctx, {
    openExternal: async (url) => {
      opened.push(url)
      return true
    },
    pollMs: 5,
    timeoutMs
  })
  return { store, seam, requests, opened, ctx }
}

const sessionRow = (store: AppStore) => store.collections.cloudSessions.get("cloud")

describe("cloud session seam", () => {
  test("loadSession mirrors the definitive answer — and no token-shaped field", async () => {
    const { store, seam } = await harness((path) =>
      path === CLOUD_AUTH_SESSION_PATH
        ? json(200, { state: "signed-in", username: "will", expiresAt: "2027-01-01T00:00:00Z", scopes: "degraded", token: TOKEN })
        : json(404, {}))
    await seam.loadSession()
    expect(sessionRow(store)).toMatchObject({
      id: "cloud",
      state: "signed-in",
      username: "will",
      expiresAt: "2027-01-01T00:00:00Z",
      scopes: "degraded"
    })
    expect(JSON.stringify(sessionRow(store))).not.toContain(TOKEN)
  })

  test("a failed read changes nothing (the seam gates on answers, not silence)", async () => {
    const { store, seam } = await harness(() => json(502, {}))
    await seam.loadSession()
    expect(sessionRow(store)?.state).toBe("unknown")
  })

  test("sign-in opens the start answer's URL and settles when the callback lands", async () => {
    let signedIn = false
    const { store, seam, requests, opened } = await harness((path, init) => {
      if (path === CLOUD_AUTH_START_PATH && init?.method === "POST") {
        queueMicrotask(() => {
          signedIn = true
        })
        return json(200, { url: "https://api.smithers-cloud.test/api/auth/github/cli?callback_port=4321" })
      }
      if (path === CLOUD_AUTH_SESSION_PATH) {
        return signedIn
          ? json(200, { state: "signed-in", username: "will", expiresAt: null })
          : json(200, { state: "signed-out", username: null, expiresAt: null })
      }
      return json(404, {})
    })
    const refusal = await seam.signIn()
    expect(refusal).toBeUndefined()
    expect(opened).toEqual(["https://api.smithers-cloud.test/api/auth/github/cli?callback_port=4321"])
    expect(sessionRow(store)?.state).toBe("signed-in")
    expect(requests[0]).toEqual({ method: "GET", url: CLOUD_AUTH_SESSION_PATH })
    expect(requests[1]).toEqual({ method: "POST", url: CLOUD_AUTH_START_PATH })
  })

  test("sign-in answers honestly when the browser step never completes", async () => {
    const { store, seam } = await harness((path) =>
      path === CLOUD_AUTH_SESSION_PATH
        ? json(200, { state: "signed-out", username: null, expiresAt: null })
        : path === CLOUD_AUTH_START_PATH
        ? json(200, { url: "https://api.smithers-cloud.test/api/auth/github/cli?callback_port=1" })
        : json(404, {}))
    const refusal = await seam.signIn()
    expect(typeof refusal).toBe("string")
    expect(refusal).toContain("/cloud.sign-in")
    expect(sessionRow(store)?.state).toBe("signed-out")
  })

  test("sign-in is a no-op answer when the session is already signed in", async () => {
    const { seam, requests } = await harness((path) =>
      path === CLOUD_AUTH_SESSION_PATH
        ? json(200, { state: "signed-in", username: "will", expiresAt: null })
        : json(404, {}))
    const refusal = await seam.signIn()
    expect(refusal).toBe("Already signed in to Smithers Cloud as will.")
    expect(requests.filter((request) => request.url === CLOUD_AUTH_START_PATH)).toEqual([])
  })

  test("sign-in mirrors and answers when already signed in with an unknown username", async () => {
    const { store, seam, requests } = await harness((path) =>
      path === CLOUD_AUTH_SESSION_PATH
        ? json(200, { state: "signed-in", username: null, expiresAt: "2027-01-01T00:00:00Z" })
        : json(404, {}))
    const refusal = await seam.signIn()
    expect(refusal).toBe("Already signed in to Smithers Cloud.")
    expect(sessionRow(store)).toMatchObject({ state: "signed-in", username: null, expiresAt: "2027-01-01T00:00:00Z" })
    expect(requests.filter((request) => request.url === CLOUD_AUTH_START_PATH)).toEqual([])
  })

  for (const failure of ["network", "http", "malformed"] as const) {
    test(`sign-in stops at its deadline when session polls fail (${failure})`, async () => {
      let started = false
      const { store, seam } = await harness((path) => {
        if (path === CLOUD_AUTH_START_PATH) {
          started = true
          return json(200, { url: "https://cloud.test/login" })
        }
        if (!started) return json(200, { state: "signed-out", username: null, expiresAt: null })
        if (failure === "network") throw new Error("local service stopped")
        return failure === "http" ? json(503, {}) : json(200, { state: "invalid" })
      }, 20)
      expect(await seam.signIn()).toContain("timed out")
      expect(sessionRow(store)?.state).toBe("signed-out")
    })
  }

  test("a thrown sign-in or sign-out request answers a product sentence, never the thrown text", async () => {
    const { seam } = await harness((path) => {
      if (path === CLOUD_AUTH_SESSION_PATH) return json(200, { state: "signed-out", username: null, expiresAt: null })
      throw new Error("ECONNREFUSED secret-socket-detail")
    })
    expect(await seam.signIn()).toBe("Could not reach the local app to start cloud sign-in.")
    expect(await seam.signOut()).toBe("Could not reach the local app to sign out.")
  })

  test("sign-out posts the route and mirrors signed-out", async () => {
    const { store, seam, requests } = await harness((path, init) =>
      path === CLOUD_AUTH_SIGN_OUT_PATH && init?.method === "POST" ? json(200, { ok: true }) : json(404, {}))
    const refusal = await seam.signOut()
    expect(refusal).toBeUndefined()
    expect(sessionRow(store)?.state).toBe("signed-out")
    expect(requests).toEqual([{ method: "POST", url: CLOUD_AUTH_SIGN_OUT_PATH }])
  })
})

// Exercise the renderer through the native host and a real HTTP backend.
// Only the OS keychain port is in memory, so tests never touch user credentials.
for (const state of ["signed-in", "signed-out", "degraded"] as const) {
  test(`local app session reaches the Cloud row and workspace gate: ${state}`, async () => {
    const upstream: Request[] = []
    const backend = Bun.serve({
      hostname: "127.0.0.1", port: 0,
      fetch: request => {
        upstream.push(request.clone())
        const path = new URL(request.url).pathname
        if (path === "/api/repos/will/smithers/workspaces" && request.method === "POST") {
          return json(409, { message: "fixture VM create reached backend" })
        }
        if (path === "/api/user/workspaces") return state === "degraded"
          ? json(403, { code: "forbidden", fault: "user", message: "insufficient token scope" }) : json(200, [])
        return json(404, {})
      }
    })
    const directory = await mkdtemp(join(tmpdir(), "smithers-cloud-seam-"))
    await writeFile(join(directory, "index.html"), "<!doctype html>")
    const api = `http://127.0.0.1:${backend.port}`
    const auth = await createCloudAuth({
      api,
      keychain: {
        read: async () => state === "signed-out" ? null : JSON.stringify({ token: TOKEN, username: "will", email: null, expiresAt: null }),
        write: async () => {}, remove: async () => {}
      },
      log: () => {}
    })
    const host = await startLocalServer({
      port: 0, distDir: directory, stateDir: directory, home: directory,
      cloudMode: "hybrid", cloudApi: api, identityUpstream: api, cloudAuth: auth,
      log: () => {}
    })
    const probeCount = upstream.length
    try {
      const { store, seam, ctx, requests } = await harness((path, init) => {
        const headers = new Headers(init?.headers)
        headers.set(LOCAL_SESSION_HEADER, host.sessionToken)
        return fetch(`${host.origin}${path}`, { ...init, headers })
      })
      await seam.loadSession()
      expect(requests).toEqual([{ method: "GET", url: CLOUD_AUTH_SESSION_PATH }])
      expect(sessionRow(store)).toMatchObject({
        state: state === "signed-out" ? "signed-out" : "signed-in",
        username: state === "signed-out" ? null : "will",
        scopes: state === "degraded" ? "degraded" : null
      })
      expect(JSON.stringify(sessionRow(store))).not.toContain(TOKEN)
      expect(probeCount).toBe(state === "signed-out" ? 0 : 1)
      if (probeCount > 0) {
        expect(new URL(upstream[0]!.url).pathname).toBe("/api/user/workspaces")
        expect(upstream[0]!.headers.get("authorization")).toBe(`Bearer ${TOKEN}`)
      }
      const workspace = createWorkspaceSeam(ctx)
      try {
        const result = await workspace.listWorkspaces()
        if (state === "signed-in") {
          expect(result).toEqual({ value: "No boxes." })
          expect(await workspace.openWorkspace("main", "will/smithers", "vm")).toContain("fixture VM create reached backend")
          expect(upstream.some(request => request.method === "POST" && new URL(request.url).pathname === "/api/repos/will/smithers/workspaces")).toBe(true)
          expect(requests.some(request => request.url.startsWith("/api/user/workspaces"))).toBe(true)
          expect(upstream.every(request => !request.headers.has(LOCAL_SESSION_HEADER))).toBe(true)
        } else {
          expect(result).toBe(state === "degraded" ? DEGRADED_WORKSPACE_REFUSAL : "Sign in to Smithers Cloud to continue.")
          expect(requests).toHaveLength(1)
          expect(upstream).toHaveLength(probeCount)
        }
      } finally { workspace.dispose() }
    } finally {
      await host.stop()
      backend.stop(true)
      await rm(directory, { recursive: true, force: true })
    }
  })
}

test("an outstanding Cloud read cannot restore the account after app sign-out", async () => {
  const { ctx, store } = await harness(() => json(404, {}))
  let epoch = 1
  let resolve!: (response: Response) => void
  const response = new Promise<Response>(done => { resolve = done })
  const seam = createCloudSeam({ ...ctx, http: () => response }, { sessionEpoch: () => epoch })
  const pending = seam.loadSession()
  epoch += 1
  store.dispatch({ type: "cloud.session.loaded", actor: "system", state: "signed-out", username: null, expiresAt: null, scopes: null })
  resolve(json(200, { state: "signed-in", username: "old-account", expiresAt: null }))
  await pending
  expect(sessionRow(store)).toMatchObject({ state: "signed-out", username: null })
})
