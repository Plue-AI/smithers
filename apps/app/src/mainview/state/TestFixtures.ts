import type { StorageApi } from "@tanstack/db"
import type { AgentTurnFrame, StartAgentTurnRequest } from "@smthrs/rpc/NativeAgent"
import type { FetchLike } from "@smthrs/rpc/NativeAgent"
import { resolveApplicationTarget } from "@smthrs/rpc/ApplicationTarget"
import type { ApplicationTarget } from "@smthrs/rpc/ApplicationTarget"

import type { AgentPort } from "../runtime/AgentPort"
import { createApplicationClient } from "../runtime/ApplicationClient"
import type { AppStore } from "./AppStore"

/**
 * Fixtures shared by the state tests. A test that needs a different double
 * keeps its own local copy; these are the ones every suite used to re-declare.
 */

export const memoryStorage = (): StorageApi => {
  const data = new Map<string, string>()
  return {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => void data.set(key, value),
    removeItem: (key) => void data.delete(key)
  }
}

/** Seed a pre-journal installation before opening the store; never bypass a live dispatcher. */
export const writeLegacyCollection = (storage: StorageApi, collectionId: string, rows: ReadonlyArray<{ readonly id: string }>): void => {
  storage.setItem(`smithers-mvp.${collectionId}`, JSON.stringify(Object.fromEntries(rows.map(row => [
    `s:${row.id}`, { versionKey: "legacy-fixture", data: row }
  ]))))
}


export const silentAgent: AgentPort = {
  available: true,
  startTurn: async () => ({ status: "started" }),
  cancelTurn: async () => {},
  subscribe: () => () => {}
}

export const unavailableAgent: AgentPort = {
  available: false,
  startTurn: async () => ({ status: "error", message: "unavailable" }),
  cancelTurn: async () => {},
  subscribe: () => () => {}
}

/** Records every turn request and refuses it, so no frames ever arrive. */
export const recordingAgent = (requests: StartAgentTurnRequest[]): AgentPort => ({
  available: true,
  startTurn: async (request) => {
    requests.push(request)
    return { status: "error", message: "Recorded." }
  },
  cancelTurn: async () => {},
  subscribe: () => () => {}
})

/** Answers turn N with the frames `steps[N]` returns; the last step repeats. */
export const scriptedToolAgent = (
  steps: ReadonlyArray<(request: StartAgentTurnRequest) => ReadonlyArray<Omit<AgentTurnFrame, "runId">>>
): { agent: AgentPort; requests: Array<StartAgentTurnRequest> } => {
  const listeners = new Set<(frame: AgentTurnFrame) => void>()
  const requests: Array<StartAgentTurnRequest> = []
  let step = 0
  return {
    requests,
    agent: {
      available: true,
      startTurn: async (request) => {
        requests.push(request)
        const frames = (steps[Math.min(step, steps.length - 1)] ?? (() => []))(request)
        step += 1
        queueMicrotask(() => {
          for (const frame of frames) {
            for (const listener of listeners) listener({ ...frame, runId: request.runId } as AgentTurnFrame)
          }
        })
        return { status: "started" }
      },
      cancelTurn: async () => {},
      subscribe: (listener) => {
        listeners.add(listener)
        return () => listeners.delete(listener)
      }
    }
  }
}

/** A person's "World" Wiki note (id `world-home`), which link and graph tests point at. */
export const addWorldNote = (store: AppStore, select = false): Promise<unknown> =>
  store.dispatch({
    type: "world.document.upserted", actor: "user", select,
    document: { id: "world-home", path: "World.md", title: "World", body: "# World\n\n", links: [], tags: [], sources: [], confidence: 1 }
  }).isPersisted.promise

/** One macrotask: lets queued microtasks and a zero-delay timer run. */
export const settled = () => new Promise((resolve) => setTimeout(resolve, 0))

/**
 * A fixed number of 1 ms macrotasks. Use it only for negative checks ("no
 * further calls"); wait for a positive condition with `waitFor`.
 */
export const settle = async (ticks = 12): Promise<void> => {
  for (let index = 0; index < ticks; index += 1) await new Promise((resolve) => setTimeout(resolve, 1))
}

/** Polls `condition` every 2 ms until it holds or `timeoutMs` passes. */
export const waitFor = async (condition: () => boolean, timeoutMs = 2_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs
  while (!condition() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 2))
  }
  if (!condition()) throw new Error("condition never held")
}

export const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })

/** Run identity fixtures through the same selected-backend `/api/user` parser as the browser. */
export const applicationIdentityFromFetch = (
  fetchImpl: FetchLike, pageOrigin = "https://app.test", target?: ApplicationTarget
) => createApplicationClient(target ?? resolveApplicationTarget({
    apiVersion: 1, mode: "web-selfhost", apiOrigin: "", auth: { kind: "session" },
    cors: "same-origin", developerExternal: false
  }, pageOrigin), {
    // Some test doubles accept only absolute URLs; browser fetch resolves the
    // selected origin's relative `/api/user` request before reaching them.
    fetchImpl: (input, init) => fetchImpl(typeof input === "string" && input.startsWith("/")
      ? new URL(input, pageOrigin).toString() : input, init),
    pageOrigin
  }).identity

/** A fetch double that answers by pathname and 404s everything else. */
export const backend = (
  routes: Record<string, Response>
): { fetchImpl: (input: unknown) => Promise<Response> } => ({
  fetchImpl: async (input) => {
    const url = typeof input === "string" ? input : String(input)
    const path = new URL(url, "https://app.test").pathname
    return (routes[path] ?? json(404, { status: "error" })).clone()
  }
})

/** Stateful HTTP fixture for repository navigation and persisted read receipts. */
export const repositoryHttpFixture = (): import("./seams/SeamContext").SeamContext["http"] => {
  const issues = [2, 3].map(number => ({ number, title: `Issue ${number}`, state: "open", body: "Details", author: { login: "ada" }, updated_at: "2026-09-13T00:00:00Z" }))
  const comments = new Map<number, Array<{ body: string; commenter: string; created_at: string }>>()
  const landing = { number: 4, title: "Review", state: "open", body: "Changes", author: { login: "ada" }, updated_at: "2026-09-13T00:00:00Z", change_ids: [] }
  return async (input, init) => {
    const url = new URL(input, "https://app.test")
    if (url.pathname.startsWith("/api/user/github-repos/") || url.pathname === "/api/notifications/list") return Response.json([])
    const path = url.pathname.replace("/api/repos/owner/repo", "")
    if (path === "/issues") return Response.json(issues.filter(issue => url.searchParams.get("state") === "all" || issue.state === (url.searchParams.get("state") ?? "open")))
    const match = /^\/issues\/(\d+)(\/comments)?$/.exec(path)
    if (match) {
      const number = Number(match[1])
      const issue = issues.find(row => row.number === number)
      if (!issue) return Response.json({ message: `No issue #${number}`, code: "not_found" }, { status: 404 })
      if (match[2]) {
        const rows = comments.get(number) ?? []
        if (init?.method === "POST") {
          const body = JSON.parse(String(init.body)) as { body: string }
          rows.push({ body: body.body, commenter: "ada", created_at: "2026-09-13T01:00:00Z" })
          comments.set(number, rows)
          return Response.json(rows.at(-1), { status: 201 })
        }
        return Response.json(rows)
      }
      if (init?.method === "PATCH") issue.state = (JSON.parse(String(init.body)) as { state: string }).state
      return Response.json(issue)
    }
    if (path === "/landings") return Response.json([landing])
    if (path === "/landings/4") return Response.json(landing)
    if (path === "/landings/4/reviews" || path === "/landings/4/comments") return Response.json([])
    throw new Error(`Unexpected repository fixture request: ${input}`)
  }
}

/** The box {@link loadBox} loads unless a test names another: every flow call names a box. */
export const TEST_BOX = "0b0c0d0e-0000-4000-8000-000000000001"

/** One box of `repo` in the store — running unless a test asks otherwise — so a flow test has a box to name. */
export const loadBox = (
  store: Pick<AppStore, "dispatch">,
  repo: string,
  id: string = TEST_BOX,
  status: "running" | "suspended" | "stopped" | "pending" | "starting" | "failed" = "running"
): Promise<unknown> =>
  store.dispatch({ type: "workspace.updated", actor: "system", workspace: {
    id, repoId: repo, name: "Box", targetBookmark: "main", status, provisioningStage: null, suspendedAt: null, createdAt: null
  } }).isPersisted.promise
