import { act } from "react"
import { expect, test } from "bun:test"
import { createRoot } from "./views/testDom"
import { LiveChannel, type LiveSocket } from "../runtime/LiveChannel"
import { createDesignWorld } from "../state/seams/DesignWorld"
import type { AppController } from "../state/AppController"
import { ControllerTestProvider } from "../ControllerContext"
import { CARD_RENDERERS } from "./CardRenderers"
const actions = { onDecideApproval: () => {}, onConnectGitHub: () => {}, onRunWorkflow: () => {}, onStopRun: () => {}, onRetryRun: () => {}, onChooseWorkflowRepo: () => {}, worldDocuments: [], onChangeWorldDocument: () => {}, onRunCommand: () => {} }

test("a demo keeps its seed on refused topics, then prefers a complete live projection", async () => {
  const socket: LiveSocket = { readyState: 1, onopen: null, onclose: null, onmessage: null, send: () => {}, close: () => {} }
  const live = new LiveChannel({ socket: () => socket })
  const controller = { live, bootstrap: { capabilities: [] }, design: createDesignWorld({ timers: { set: () => 0, clear: () => {} } }) } as unknown as AppController
  const host = document.createElement("div"), root = createRoot(host)
  const card = { id: "branch:b-retry", kind: "branch", title: "Branch", status: "active", createdAt: 1, ordinal: 1, payload: { id: "b-retry" } } as const
  try {
    await act(async () => root.render(<ControllerTestProvider controller={controller}>{CARD_RENDERERS.branch.render(card, actions)}</ControllerTestProvider>))
    expect(host.textContent).toContain("retry-webhooks")
    await act(async () => socket.onmessage?.({ data: JSON.stringify({ t: "err", id: 1, code: "unknown_topic" }) }))
    expect(host.textContent).toContain("Retry failed webhooks")
    const snap = async (id: number, data: unknown) => act(async () => socket.onmessage?.({ data: JSON.stringify({ t: "snap", id, cursor: 1, data }) }))
    await snap(1, { id: "b-retry", name: "Captured live branch", machine: { state: "asleep" }, terminals: [], presence: [], ssh_line: "ssh -p 2222 live@localhost" })
    await snap(2, [])
    await snap(3, [])
    expect(host.textContent).toContain("Captured live branch")
    expect(host.textContent).not.toContain("Retry failed webhooks")
    expect(host.querySelector("[data-flow]")).toBeNull()
  } finally { await act(async () => root.unmount()); live.dispose(); controller.design.dispose() }
})

for (const unavailable of [[], [2], [3], [2, 3]]) test(`registry renders real branch facts with unsupported streams ${unavailable.join(",")} and clears a refused subscription`, async () => {
  const frames: unknown[] = []
  const socket: LiveSocket = { readyState: 0, onopen: null, onclose: null, onmessage: null, send: frame => frames.push(JSON.parse(String(frame))), close: () => {} }
  const timers: { callback: () => void; cancelled: boolean }[] = []
  const live = new LiveChannel({ socket: () => socket, schedule: callback => { const timer = { callback, cancelled: false }; timers.push(timer); return timer }, cancel: timer => { (timer as typeof timers[number]).cancelled = true } })
  const controller = { live, design: createDesignWorld({ enabled: false, timers: { set: () => 0, clear: () => {} } }) } as unknown as AppController
  const host = document.createElement("div"), root = createRoot(host)
  const card = { id: "branch:b-retry", kind: "branch", title: "Branch", status: "active", createdAt: 1, ordinal: 1, payload: { id: "b-retry" } } as const
  try {
    await act(async () => root.render(<ControllerTestProvider controller={controller}>{CARD_RENDERERS.branch.render(card, actions)}</ControllerTestProvider>))
    expect(host.textContent).toBe("")
    socket.readyState = 1; socket.onopen?.()
    expect(frames).toEqual([{ t: "sub", id: 1, topic: "branch:b-retry" }, { t: "sub", id: 2, topic: "branch:b-retry:activity" }, { t: "sub", id: 3, topic: "branch:b-retry:files" }, { t: "presence", id: 4, where: { branch: "b-retry" } }])
    const snap = async (id: number, data: unknown) => act(async () => socket.onmessage?.({ data: JSON.stringify({ t: "snap", id, cursor: 1, data }) }))
    const maya = { kind: "person", login: "maya", name: "Maya", avatar_url: "https://github.com/identicons/placeholder.png", color_index: 1, via: "ssh" }
    await snap(1, { id: "b-retry", name: "Captured live branch", machine: { state: "asleep" },
      item: { n: 12, title: "Retained branch work", state: "needs_you", place: 2 },
      moved_off: { by: maya, item: 12 },
      terminals: [{ id: "checks", title: "Checks", owner: maya, agents: [], watchers: [], command: "pnpm check", frozen: false }],
      presence: [{ actor: maya, where: { kind: "file", path: "retry.ts", line: 12 } },
        { actor: { ...maya, login: "ben", name: "Ben", via: undefined }, where: { kind: "terminal", id: "checks" } }],
      ssh_line: "ssh -p 2222 live@localhost" })
    const optional = async (id: number) => unavailable.includes(id)
      ? act(async () => socket.onmessage?.({ data: JSON.stringify({ t: "err", id, code: "unsupported" }) }))
      : snap(id, [])
    await optional(2)
    expect(host.textContent).toBe("")
    await optional(3)
    expect(host.textContent).toContain("Captured live branch")
    expect(host.textContent).toContain("Asleep")
    expect(host.textContent).toContain("Maya via SSH moved this branch off T12")
    expect(host.querySelectorAll(".branch-location")[0]!.textContent).toBe("editingretry.ts:12")
    expect(host.querySelectorAll(".branch-location")[1]!.textContent).toBe("runningChecks · pnpm check")
    expect(host.textContent).not.toContain("Retry failed webhooks")
    expect(host.querySelector("[data-flow]")).toBeNull()
    expect(frames.at(-1)).toEqual({ t: "presence", id: 4, where: { branch: "b-retry" } })
    // Authorization failures remain fatal even with unavailable optional streams.
    await act(async () => socket.onmessage?.({ data: JSON.stringify({ t: "err", id: 1, code: "forbidden" }) }))
    expect(host.textContent).toBe("")
    await act(async () => root.unmount())
    expect(timers.at(-1)?.cancelled).toBe(true)
  } finally { await act(async () => root.unmount()); live.dispose() }
})


test("/branch T2 mounts live facts and its Fork enters the production dispatcher without a wake", async () => {
  const { createAppController } = await import("../state/AppController")
  const { createAppStore } = await import("../state/AppStore")
  const { memoryStorage, signupProfileFetch, unavailableAgent } = await import("../state/TestFixtures")
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  const requests: Array<[string, string, unknown]> = []
  const profile = signupProfileFetch(async (input, init) => {
    const path = new URL(String(input), "https://install.test").pathname
    if (path === "/api/todos/2") {
      requests.push(["GET", path, undefined])
      return Response.json({ branch: { name: "smithers/retry-webhooks" } })
    }
    if (path === "/api/branches/smithers%2Fretry-webhooks") {
      requests.push(["GET", path, undefined])
      return Response.json({ name: "smithers/retry-webhooks", machine: { id: "b-live" } })
    }
    if (path === "/api/branches/smithers%2Fretry-webhooks/files/retry.ts") {
      requests.push(["GET", path, undefined])
      return Response.json({ branch: "smithers/retry-webhooks", path: "retry.ts", language: "typescript", digest: "captured-digest",
        content: { kind: "text", text: "retained bytes\n" }, mode: "read_only", diagnostics: [], authors: [], editors: [] })
    }
    if (path === "/api/branches/b-live/add-to-stack" && init?.method === "POST") {
      requests.push(["POST", path, JSON.parse(String(init.body))])
      return Response.json({state:"accepted",n:3,rev:1},{status:202})
    }
    if (path === "/api/branches" && init?.method === "POST") {
      requests.push(["POST", path, JSON.parse(String(init.body))])
      return Response.json({ name: "scratch/ben/retry", kind: "scratch" }, { status: 201 })
    }
    return new Response("{}", { status: 404 })
  })
  const frames: unknown[] = []
  const socket: LiveSocket = { readyState: 0, onopen: null, onclose: null, onmessage: null, send: frame => frames.push(JSON.parse(String(frame))), close() {} }
  const live = new LiveChannel({ socket: () => socket })
  const controller = createAppController(store, unavailableAgent, { fetchImpl: profile.fetchImpl, live,
    branchOptions: { ready: () => true, scope: () => ({ branch: "smithers/retry-webhooks", member: "ben", revision: 1, sleeping: true, capturedHead: "captured-7" }) },
    bootstrap: { apiVersion: 1, host: "local", version: "test", buildSha: "test", capabilities: ["install"], authFlow: "redirect", sandbox: null } })
  const host = document.createElement("div"), root = createRoot(host)
  try {
    await store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-in", login: "ben", admin: false, scopesPlain: null }).isPersisted.promise
    expect(await controller.runCommandForResult("branch", "T2")).toMatchObject({ status: "executed", value: "Opened smithers/retry-webhooks" })
    const card = store.collections.cards.get("branch:b-live")!
    if (card.kind !== "branch") throw new Error("Expected Branch")
    await act(async () => root.render(<ControllerTestProvider controller={controller}>{CARD_RENDERERS.branch.render(card, actions)}</ControllerTestProvider>))
    socket.readyState = 1; socket.onopen?.()
    const snap = async (topic: string, data: unknown, cursor = 1) => {
      const frame = frames.find(frame => (frame as { topic?: string }).topic === topic) as { id: number }
      await act(async () => socket.onmessage?.({ data: JSON.stringify({ t: "snap", id: frame.id, cursor, data }) }))
    }
    await snap("branch:b-live", { id: "b-live", name: "smithers/retry-webhooks", machine: { state: "asleep" }, item: { n: 2, title: "Retry webhooks", state: "working", place: 2 }, presence: [{ actor: { kind: "person", login: "alice", name: "Alice", avatar_url: "https://example.test/alice.png", color_index: 1 }, where: { kind: "file", path: "retry.ts", line: 12 } }], terminals: [], ssh_line: "ssh -p 2222 retry-webhooks@localhost" })
    await snap("branch:b-live:activity", [])
    await snap("branch:b-live:files", [])
    expect(host.textContent).toContain("Asleep")
    for (const tab of ["files", "terminals", "activity"] as const) {
      await act(async () => {
        (host.querySelector(`[data-tab="${tab}"]`) as HTMLButtonElement).click()
      })
      const saved = store.collections.cards.get(card.id)!
      if (saved.kind !== "branch") throw new Error("Expected Branch")
      expect(saved.payload.tab).toBe(tab)
      await act(async () => root.render(<ControllerTestProvider controller={controller}>{CARD_RENDERERS.branch.render(saved, actions)}</ControllerTestProvider>))
      expect(host.querySelector(`[data-tab="${tab}"]`)?.getAttribute("aria-selected")).toBe("true")
    }
    expect(host.querySelector('[data-flow="box.resume"]')).toBeNull()
    await act(async () => {
      (host.querySelector('.branch-location [data-flow="file"]') as HTMLButtonElement).click()
      for (let i = 0; i < 20 && requests.length < 3; i++) await new Promise(resolve => setTimeout(resolve, 5))
    })
    const opened = [...store.collections.cards.values()].find(each => each.kind === "file")
    expect(opened?.payload).toMatchObject({ path: "retry.ts", line: 12 })
    expect(requests.at(-1)).toEqual(["GET", "/api/branches/smithers%2Fretry-webhooks/files/retry.ts", undefined])
    await act(async () => {
      (host.querySelector('[data-flow="branch.fork"]') as HTMLButtonElement).click()
      for (let i = 0; i < 20 && requests.length < 4; i++) await new Promise(resolve => setTimeout(resolve, 5))
    })
    expect(requests).toEqual([["GET", "/api/todos/2", undefined], ["GET", "/api/branches/smithers%2Fretry-webhooks", undefined], ["GET", "/api/branches/smithers%2Fretry-webhooks/files/retry.ts", undefined], ["POST", "/api/branches", { from: "T2" }]])
    await snap("branch:b-live", { id:"b-live",name:"scratch/ben/try",scratch:{forked_from:{kind:"item",n:2,title:"Retry webhooks"}},machine:{state:"asleep"},presence:[],terminals:[],ssh_line:"" },2)
    expect(host.querySelector('[data-flow="branch.fork"]')).toBeNull()
    await act(async () => {
      (host.querySelector('[data-flow="branch.add-to-stack"]') as HTMLButtonElement).click()
      for(let i=0;i<30 && requests.length<5;i++) await new Promise(resolve=>setTimeout(resolve,5))
    })
    expect(requests.at(-1)).toEqual(["POST","/api/branches/b-live/add-to-stack",{text:"scratch/ben/try"}])
    expect(controller.design.enabled).toBe(false)
  } finally { await act(async () => root.unmount()); await controller.dispose(); live.dispose() }
})
