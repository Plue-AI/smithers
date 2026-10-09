/* Retained host launch API lifecycle. Provider-specific app commands are retired;
 * unit fixtures probe the public controller API, not a catalog door. */
import { describe, expect, test } from "bun:test"
import type { StorageApi } from "@tanstack/db"
import type { AppBootstrap } from "@smthrs/rpc/AppBootstrap"
import { EXTERNAL_LAUNCH_PATH } from "@smthrs/rpc/AgentApiRoutes"
import { scopedControllers } from "./ControllerTestScope"
import { createAppStore } from "./AppStore"
import { shownInTranscript } from "./ApprovalDeciders"
import { memoryStorage, unavailableAgent } from "./TestFixtures"

const SESSION = "0199e2e0-0000-7000-8000-00000000a11c"
const bootstrap = (capabilities: AppBootstrap["capabilities"]): AppBootstrap =>
  ({ apiVersion: 1, host: "local", version: "test", buildSha: "test", capabilities, authFlow: "none", sandbox: null })
const LAUNCHER = bootstrap(["launch.codex", "launch.claude-code"])
const createAppController = scopedControllers()

const until = async (done: () => boolean): Promise<void> => {
  for (let i = 0; i < 200 && !done(); i++) await new Promise(resolve => setTimeout(resolve, 1))
  expect(done()).toBe(true)
}

const harness = async (options: {
  readonly bootstrap?: AppBootstrap
  readonly storage?: StorageApi
  readonly launch?: (body: unknown) => Promise<Response> | Response
} = {}) => {
  const store = await createAppStore({ kind: "localStorage", storage: options.storage ?? memoryStorage() })
  const launches: unknown[] = []
  let stops = 0
  const controller = createAppController(store, unavailableAgent, {
    bootstrap: options.bootstrap ?? LAUNCHER,
    toastDebounceMs: 0,
    fetchImpl: async (input, init) => {
      const path = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, "http://localhost").pathname
      if (path !== EXTERNAL_LAUNCH_PATH) return Response.json({ error: { code: "not_found", message: "no stub" } }, { status: 404 })
      if (init?.method === "DELETE") { stops++; return Response.json({ ok: true }) }
      const body: unknown = JSON.parse(String(init?.body))
      launches.push(body)
      return options.launch?.(body) ?? Response.json({ agent: (body as { agent: string }).agent, session: SESSION })
    }
  })
  const sessions = () => [...store.collections.cards.values()].filter(card => card.kind === "agent-session")
  const toasts = () => [...store.collections.toasts.values()].map(toast => [toast.title, toast.status, toast.detail])
  return { store, controller, launches, sessions, toasts, stops: () => stops }
}

describe("the retained host launch API", () => {
  test("Codex launch answers at once and binds the session Codex wrote to the conversation", async () => {
    const h = await harness()
    try {
      expect(await h.controller.startAgent("codex", "Fix the flaky test")).toEqual({ value: "Requested" })
      await until(() => h.sessions().length === 1)
      expect(h.launches).toEqual([{ agent: "codex", prompt: "Fix the flaky test" }])
      const [card] = h.sessions()
      expect(card).toMatchObject({ id: `agent-session:${SESSION}`, kind: "agent-session", title: "Codex", payload: { agent: "codex", session: SESSION } })
      // The binding is never a card frame: the session's own entries are what the conversation shows.
      expect(shownInTranscript(card!, false)).toBe(false)
    } finally { await h.controller.dispose() }
  })

  test("Claude launch starts Claude Code and binds its session the same way", async () => {
    const h = await harness()
    try {
      expect(await h.controller.startAgent("claude-code", "Fix the flaky test")).toEqual({ value: "Requested" })
      await until(() => h.sessions().length === 1)
      expect(h.launches).toEqual([{ agent: "claude-code", prompt: "Fix the flaky test" }])
      expect(h.sessions()[0]).toMatchObject({ kind: "agent-session", title: "Claude Code", payload: { agent: "claude-code", session: SESSION } })

    } finally { await h.controller.dispose() }
  })



  test("the door returns before the host answers, and the toast settles only with the launch", async () => {
    let answer!: (response: Response) => void
    const h = await harness({ launch: () => new Promise<Response>(resolve => { answer = resolve }) })
    try {
      expect(await h.controller.startAgent("codex", "Fix it")).toEqual({ value: "Requested" })
      await until(() => h.toasts().length === 1)
      expect(h.toasts()).toEqual([["Starting Codex", "running", ""]])
      expect(h.sessions()).toEqual([])
      answer(Response.json({ agent: "codex", session: SESSION }))
      await until(() => h.sessions().length === 1)
      await until(() => h.toasts()[0]?.[1] === "ok")
      expect(h.toasts()[0]?.slice(0, 2)).toEqual(["Codex started", "ok"])
    } finally { await h.controller.dispose() }
  })









  test("a launch the host refuses settles its toast as failed in the app's words and binds nothing", async () => {
    // The local host's refusal envelope (src/bun/routes.ts jsonError); its message carries the CLI's stderr.
    const message = "Codex exited with 1 before it wrote a session: Error: not logged in"
    const refusal = (reason?: string) => () => Response.json({ error: { code: "agent_unavailable", message, ...(reason ? { reason } : {}) },
      status: "error", code: "native_agent_unavailable", message, origin: "local" }, { status: 503 })
    for (const [reason, words] of [
      ["exited", "Codex exited before it started a session."],
      ["timeout", "Codex started no session in time."],
      ["stopping", "This machine is stopping."],
      [undefined, undefined]
    ] as const) {
      const h = await harness({ launch: refusal(reason) })
      try {
        expect(await h.controller.startAgent("codex", "Fix it")).toEqual({ value: "Requested" })
        await until(() => h.toasts()[0]?.[1] === "failed")
        const [toast] = h.toasts()
        expect(toast?.slice(0, 2)).toEqual(["Starting Codex", "failed"])
        if (words === undefined) expect(toast?.[2]).toContain("Codex did not start.")
        else expect(toast?.[2]).toBe(words)
        // The CLI's own stderr is the host's diagnostics, never rendered in the app.
        expect(JSON.stringify(h.toasts())).not.toContain("not logged in")
        expect(h.toasts()).toHaveLength(1)
        expect(h.sessions()).toEqual([])
      } finally { await h.controller.dispose() }
    }
  })

  test("an answer without a session binds nothing and says so", async () => {
    const h = await harness({ launch: () => Response.json({ agent: "codex" }) })
    try {
      await h.controller.startAgent("codex", "Fix it")
      await until(() => h.toasts()[0]?.[1] === "failed")
      expect(h.toasts()[0]?.[2]).toBe("Codex started, but the host did not name its session.")
      expect(h.sessions()).toEqual([])
    } finally { await h.controller.dispose() }
  })

  test("a second press of the same launch while it runs joins it; another prompt is its own launch", async () => {
    let release!: () => void
    const held = new Promise<void>(resolve => { release = resolve })
    let n = 0
    const h = await harness({ launch: async () => { await held; n += 1; return Response.json({ agent: "codex", session: `${SESSION.slice(0, -1)}${n}` }) } })
    try {
      const outcomes = await Promise.all([
        h.controller.startAgent("codex", "Fix it"),
        h.controller.startAgent("codex", "  Fix it "),
        h.controller.startAgent("codex", "Something else")
      ])
      expect(outcomes.map(outcome => outcome && typeof outcome === "object" && "value" in outcome ? outcome.value : undefined)).toEqual(["Requested", "Requested", "Requested"])
      release()
      await until(() => h.sessions().length === 2)
      expect(h.launches).toEqual([{ agent: "codex", prompt: "Fix it" }, { agent: "codex", prompt: "Something else" }])
      // Once settled, the same prompt is a new launch.
      await until(() => h.toasts().every(toast => toast[1] === "ok"))
      await h.controller.startAgent("codex", "Fix it")
      await until(() => h.launches.length === 3)
    } finally { await h.controller.dispose() }
  })

  for (const change of ["sign-out", "account switch"] as const) {
    test(`${change} stops launched agents and ignores the old owner's late response (#3736)`, async () => {
      let answer!: (response: Response) => void
      const h = await harness({ launch: () => new Promise<Response>(resolve => { answer = resolve }) })
      try {
        await h.store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-in", login: "alice", admin: false, scopesPlain: null }).isPersisted.promise
        await h.controller.startAgent("codex", "Alice's launch")
        await until(() => h.launches.length === 1)
        await h.store.dispatch({ type: "identity.session.loaded", actor: "system", state: change === "sign-out" ? "signed-out" : "signed-in", login: change === "sign-out" ? null : "bob", admin: false, scopesPlain: null }).isPersisted.promise
        await until(() => h.stops() > 0)
        answer(Response.json({ agent: "codex", session: SESSION }))
        await until(() => h.stops() === 2)
        expect(h.sessions()).toEqual([])
        await until(() => h.toasts().length === 0)
      } finally { answer?.(Response.json({ agent: "codex", session: SESSION })); await h.controller.dispose() }
    })
  }

  test("the binding survives a reload", async () => {
    const storage = memoryStorage()
    const first = await harness({ storage })
    try {
      await first.controller.startAgent("codex", "Fix the flaky test")
      await until(() => first.sessions().length === 1)
      await first.store.settled?.()
    } finally { await first.controller.dispose() }
    const reloaded = await createAppStore({ kind: "localStorage", storage })
    expect([...reloaded.collections.cards.values()].filter(card => card.kind === "agent-session"))
      .toMatchObject([{ kind: "agent-session", payload: { agent: "codex", session: SESSION } }])
  })
})
