/*
 * #3730: `/agent.codex` starts Codex on the host and binds the session it wrote to the conversation, through the
 * production command dispatcher. The slash, form and agent doors reach one flow; the agent's call only asks; a
 * host without the launch door has no flow; the door answers at once and the launch settles under one toast; the
 * binding survives a reload.
 */
import { describe, expect, test } from "bun:test"
import type { StorageApi } from "@tanstack/db"
import type { AppBootstrap } from "@smthrs/rpc/AppBootstrap"
import { EXTERNAL_LAUNCH_PATH } from "@smthrs/rpc/AgentApiRoutes"
import { createAppController } from "../../state/AppController"
import { createAppStore } from "../../state/AppStore"
import { shownInTranscript } from "../../state/ApprovalDeciders"
import { memoryStorage, unavailableAgent } from "../../state/TestFixtures"
import { promptGrammar } from "./agent"

const SESSION = "0199e2e0-0000-7000-8000-00000000a11c"
const bootstrap = (capabilities: AppBootstrap["capabilities"]): AppBootstrap =>
  ({ apiVersion: 1, host: "local", version: "test", buildSha: "test", capabilities, authFlow: "none", sandbox: null })
const LAUNCHER = bootstrap(["launch.codex", "launch.claude-code"])

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
  const controller = createAppController(store, unavailableAgent, {
    bootstrap: options.bootstrap ?? LAUNCHER,
    toastDebounceMs: 0,
    fetchImpl: async (input, init) => {
      const path = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, "http://localhost").pathname
      if (path !== EXTERNAL_LAUNCH_PATH) return Response.json({ error: { code: "not_found", message: "no stub" } }, { status: 404 })
      const body: unknown = JSON.parse(String(init?.body))
      launches.push(body)
      return options.launch?.(body) ?? Response.json({ agent: (body as { agent: string }).agent, session: SESSION })
    }
  })
  const sessions = () => [...store.collections.cards.values()].filter(card => card.kind === "agent-session")
  const toasts = () => [...store.collections.toasts.values()].map(toast => [toast.title, toast.status, toast.detail])
  return { store, controller, launches, sessions, toasts }
}

describe("the codex flow", () => {
  test("/agent.codex <prompt> answers at once and binds the session Codex wrote to the conversation", async () => {
    const h = await harness()
    try {
      expect(await h.controller.runCommandForResult("agent.codex", "Fix the flaky test")).toEqual({ status: "executed", value: "Requested" })
      await until(() => h.sessions().length === 1)
      expect(h.launches).toEqual([{ agent: "codex", prompt: "Fix the flaky test" }])
      const [card] = h.sessions()
      expect(card).toMatchObject({ id: `agent-session:${SESSION}`, kind: "agent-session", title: "Codex", payload: { agent: "codex", session: SESSION } })
      // The binding is never a card frame: the session's own entries are what the conversation shows.
      expect(shownInTranscript(card!, false)).toBe(false)
    } finally { await h.controller.dispose() }
  })

  test("/agent.claude <prompt> starts Claude Code and binds its session the same way", async () => {
    const h = await harness()
    try {
      expect(await h.controller.runCommandForResult("agent.claude", "Fix the flaky test")).toEqual({ status: "executed", value: "Requested" })
      await until(() => h.sessions().length === 1)
      expect(h.launches).toEqual([{ agent: "claude-code", prompt: "Fix the flaky test" }])
      expect(h.sessions()[0]).toMatchObject({ kind: "agent-session", title: "Claude Code", payload: { agent: "claude-code", session: SESSION } })
      // The agent's call asks first, in the agent's own name.
      expect(await h.controller.commands.runForAgent("agent.claude", "Add a retry")).toMatchObject({ status: "executed", value: expect.stringContaining("asked the user to confirm") })
      expect([...h.store.collections.messages.values()].find(message => message.action?.flow === "agent.claude")?.text).toContain("Claude Code")
      expect(h.launches).toHaveLength(1)
    } finally { await h.controller.dispose() }
  })

  test("each agent's door follows its own capability", async () => {
    const h = await harness({ bootstrap: bootstrap(["launch.codex"]) })
    try {
      expect(h.controller.commands.find("agent.codex")).toBeDefined()
      expect(h.controller.commands.find("agent.claude")).toBeUndefined()
      expect(await h.controller.commands.run("agent.claude", "Fix it")).toMatchObject({ status: "unavailable", door: "origin" })
    } finally { await h.controller.dispose() }
  })

  test("the door returns before the host answers, and the toast settles only with the launch", async () => {
    let answer!: (response: Response) => void
    const h = await harness({ launch: () => new Promise<Response>(resolve => { answer = resolve }) })
    try {
      expect(await h.controller.runCommandForResult("agent.codex", "Fix it")).toEqual({ status: "executed", value: "Requested" })
      await until(() => h.toasts().length === 1)
      expect(h.toasts()).toEqual([["Starting Codex", "running", ""]])
      expect(h.sessions()).toEqual([])
      answer(Response.json({ agent: "codex", session: SESSION }))
      await until(() => h.sessions().length === 1)
      await until(() => h.toasts()[0]?.[1] === "ok")
      expect(h.toasts()[0]?.slice(0, 2)).toEqual(["Codex started", "ok"])
    } finally { await h.controller.dispose() }
  })

  test("the button door sends the same flow its prompt, and a person's call needs no confirmation", async () => {
    const h = await harness()
    try {
      expect((await h.controller.commands.submit({ name: "agent.codex", payload: { prompt: "Add a retry" }, actor: "user" })).status).toBe("executed")
      await until(() => h.sessions().length === 1)
      expect(h.launches).toEqual([{ agent: "codex", prompt: "Add a retry" }])
      expect([...h.store.collections.messages.values()].some(message => message.action?.flow === "agent.codex")).toBe(false)
    } finally { await h.controller.dispose() }
  })

  test("THE FORM LAW: /agent.codex without a prompt renders a form for it and starts nothing", async () => {
    const h = await harness()
    try {
      expect(await h.controller.commands.run("agent.codex", "")).toMatchObject({ status: "form", flow: "agent.codex", fields: ["prompt"] })
      const form = [...h.store.collections.cards.values()].find(card => card.kind === "flow-form")
      expect(form?.kind === "flow-form" ? form.payload.fields.map(field => field.name) : []).toEqual(["prompt"])
      expect(h.launches).toEqual([])
    } finally { await h.controller.dispose() }
  })

  test("the agent's call asks the person and starts nothing; the person's press starts it", async () => {
    const h = await harness()
    try {
      expect(await h.controller.commands.runForAgent("agent.codex", "Fix the flaky test")).toMatchObject({ status: "executed", value: expect.stringContaining("asked the user to confirm") })
      await new Promise(resolve => setTimeout(resolve, 20))
      expect(h.launches).toEqual([])
      expect(h.sessions()).toEqual([])
      const ask = [...h.store.collections.messages.values()].find(message => message.action?.flow === "agent.codex")!
      expect(JSON.parse(ask.action!.args!)).toEqual({ prompt: "Fix the flaky test" })
      expect((await h.controller.runCommandForResult("agent.codex", ask.action!.args)).status).toBe("executed")
      await until(() => h.sessions().length === 1)
      expect(h.launches).toEqual([{ agent: "codex", prompt: "Fix the flaky test" }])
    } finally { await h.controller.dispose() }
  })

  test("a host without the launch door has no codex flow, and every door names the missing door", async () => {
    for (const capabilities of [[], ["agent", "cloud", "cloud.terminal"]] as const) {
      const h = await harness({ bootstrap: bootstrap([...capabilities]) })
      try {
        for (const name of ["agent.codex", "agent.claude"]) {
          expect(h.controller.commands.find(name)).toBeUndefined()
          expect(h.controller.slashItems(name.slice("agent.".length)).some(row => row.flow.name === name)).toBe(false)
          expect(await h.controller.commands.run(name, "Fix it")).toMatchObject({ status: "unavailable", door: "origin" })
          expect(await h.controller.commands.runForAgent(name, "Fix it")).toMatchObject({ status: "unavailable", door: "origin" })
        }
        await new Promise(resolve => setTimeout(resolve, 20))
        expect(h.launches).toEqual([])
      } finally { await h.controller.dispose() }
    }
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
        expect((await h.controller.runCommandForResult("agent.codex", "Fix it")).status).toBe("executed")
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
      await h.controller.runCommandForResult("agent.codex", "Fix it")
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
        h.controller.runCommandForResult("agent.codex", "Fix it"),
        h.controller.runCommandForResult("agent.codex", "  Fix it "),
        h.controller.runCommandForResult("agent.codex", "Something else")
      ])
      expect(outcomes.map(outcome => outcome.status)).toEqual(["executed", "executed", "executed"])
      release()
      await until(() => h.sessions().length === 2)
      expect(h.launches).toEqual([{ agent: "codex", prompt: "Fix it" }, { agent: "codex", prompt: "Something else" }])
      // Once settled, the same prompt is a new launch.
      await until(() => h.toasts().every(toast => toast[1] === "ok"))
      await h.controller.runCommandForResult("agent.codex", "Fix it")
      await until(() => h.launches.length === 3)
    } finally { await h.controller.dispose() }
  })

  test("the binding survives a reload", async () => {
    const storage = memoryStorage()
    const first = await harness({ storage })
    try {
      await first.controller.runCommandForResult("agent.codex", "Fix the flaky test")
      await until(() => first.sessions().length === 1)
      await first.store.settled?.()
    } finally { await first.controller.dispose() }
    const reloaded = await createAppStore({ kind: "localStorage", storage })
    expect([...reloaded.collections.cards.values()].filter(card => card.kind === "agent-session"))
      .toMatchObject([{ kind: "agent-session", payload: { agent: "codex", session: SESSION } }])
  })
})

describe("the prompt grammar", () => {
  test("the rest of the line is the prompt; a button's JSON is the payload; nothing is no prompt", () => {
    expect(promptGrammar("  Fix the flaky test  ")).toEqual({ payload: { prompt: "Fix the flaky test" } })
    expect(promptGrammar('{"prompt":"Add a retry"}')).toEqual({ payload: { prompt: "Add a retry" } })
    expect(promptGrammar("")).toEqual({ payload: {} })
    expect(promptGrammar(undefined)).toEqual({ payload: {} })
    // A prompt that starts with a brace but is not an object stays the prompt.
    expect(promptGrammar("{fix} the braces")).toEqual({ payload: { prompt: "{fix} the braces" } })
    expect(promptGrammar('["a"]')).toEqual({ payload: { prompt: '["a"]' } })
  })
})
