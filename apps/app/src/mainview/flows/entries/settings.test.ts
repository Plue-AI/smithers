import { MessageSchema, ToastSchema } from "../../state/AppState"
import { describe, expect, test } from "bun:test"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { SettingsContainer } from "../../cards/SettingsContainer"
import { SettingsView } from "../../cards/views/SettingsView"
import type { SettingsViewProps } from "@smthrs/rpc/SettingsCard"
import type { StorageApi } from "@tanstack/db"
import type { AgentPort } from "../../runtime/AgentPort"
import { createAppController } from "../../state/AppController"
import { createAppStore } from "../../state/AppStore"
import { credentialReceipt, installFixture } from "../../state/seams/InstallFixtures.test-support"
import type { AppBootstrap } from "@smthrs/rpc/AppBootstrap"
import { modelInvocable, nameOf } from "../registry"
import { cardActions } from "../cardActions"
import { installKeyAction, type InstallCardDispatch } from "../../cards/installKeyAction"

const memoryStorage = (): StorageApi => {
  const values = new Map<string, string>()
  return { getItem: key => values.get(key) ?? null, setItem: (key, value) => { values.set(key, value) }, removeItem: key => { values.delete(key) } }
}
const agent: AgentPort = { available: false, startTurn: async () => ({ status: "error", message: "unavailable" }), cancelTurn: async () => {}, subscribe: () => () => {} }
const tick = async () => { for (let i = 0; i < 4; i++) await new Promise(done => setTimeout(done, 0)) }
const harness = async (bootstrap?: AppBootstrap, install: () => Promise<Response> | Response = () => Response.json(installFixture())) => {
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  const requests: Array<{ path: string; method: string; body?: string | null }> = []
  const cards: string[] = []
  const controller = createAppController(store, agent, {
    ...(bootstrap === undefined ? {} : { bootstrap }),
    presentInstallCard: kind => { cards.push(kind) },
    fetchImpl: async (input, init) => {
      const path = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, "http://localhost:4000").pathname
      requests.push({ path, method: init?.method ?? "GET", body: init?.body?.toString() })
      return path === "/api/install" ? install()
        : path === "/api/model/credential" ? Response.json(credentialReceipt(JSON.parse(init!.body!.toString()).name))
        : Response.json({ code: "unknown", class: "infra", message: "Not available" }, { status: 404 })
    }
  })
  return { store, controller, requests, cards }
}
describe("T-APP-03 settings command doors", () => {
  test("settings opens an embedded card through the person doors and refuses an agent", async () => {
    const h = await harness()
    try {
      expect((await h.controller.commands.run("settings")).status).toBe("executed"); await tick()
      expect([...h.store.collections.cards.keys()]).toEqual(["settings"])
      expect((await h.controller.commands.submit({ name: "settings", payload: {}, actor: "user" })).status).toBe("executed"); await tick()
      expect(await h.controller.commands.executeForAgent({ name: "commands", arguments: JSON.stringify({ action: "execute", name: "settings" }) })).toContain("person"); await tick()
      expect([...h.store.collections.cards.keys()]).toEqual(["settings"])
      expect(h.store.session().maximizedCardId).toBeNull()
    } finally { await h.controller.dispose() }
  })
  test("hidden owner controls refuse agents and remain absent from slash suggestions", async () => {
    const h = await harness()
    try {
      for (const name of ["settings.address", "settings.daily-admissions", "settings.capacity", "settings.parallel", "settings.obsidian", "settings.model-key", "settings.setup"]) {
        expect(h.controller.commands.find(name)).toBeUndefined()
      }
      expect(nameOf(h.controller.commands.find("settings")!)).toBe("settings")
      expect(modelInvocable(h.controller.commands.find("settings")!)).toBe(false)
      expect(h.controller.slashItems("settings").some(row => row.flow.name.startsWith("settings."))).toBe(false)
    } finally { await h.controller.dispose() }
  })
  test("an install that serves no model keeps the seeded Settings and its writes; nothing reaches /api/install", async () => {
    const h = await harness(undefined, () => Response.json({ code: "unavailable", class: "infra", message: "Install unavailable" }, { status: 503 }))
    try {
      expect(h.controller.design.world().repo.capacity).not.toBe(2)
      expect((await h.controller.commands.run("settings")).status).toBe("executed"); await tick()
      // MOCK SEAM (DesignWorld/settings.ts designInstall): the card stays mounted on the seed until the install serves a model.
      expect([...h.store.collections.cards.keys()]).toEqual(["settings"])
      expect(h.cards).toEqual([])
      expect(h.controller.installSnapshots.get()).toEqual({ error: { code: "unavailable", class: "infra", message: "Install unavailable" } })
      expect((await h.controller.commands.run("settings", JSON.stringify({ operation: "capacity", capacity: Number("2") }))).status).toBe("executed"); await tick()
      expect(h.requests.filter(request => request.method === "PUT")).toEqual([])
      expect(h.controller.design.world().repo.capacity).toBe(2)
    } finally { await h.controller.dispose() }
  })
  test("Settings shows the seed before an unresolved install read, coalesces repeated opens, then reads the live install", async () => {
    let resolve!: (response: Response) => void
    const read = new Promise<Response>(done => { resolve = done })
    const h = await harness(undefined, () => read)
    try {
      expect((await h.controller.commands.run("settings")).status).toBe("executed")
      expect((await h.controller.commands.run("settings")).status).toBe("executed"); await tick()
      expect(h.requests.filter(request => request.path === "/api/install")).toHaveLength(1)
      expect([...h.store.collections.cards.keys()]).toEqual(["settings"])
      expect(h.controller.installSnapshots.get().model).toBeUndefined()
      resolve(Response.json(installFixture())); await tick()
      expect([...h.store.collections.cards.keys()]).toEqual(["settings"])
      expect(h.controller.installSnapshots.get().model).toEqual(installFixture())
      expect(h.cards).toEqual(["settings"])
    } finally { resolve(Response.json(installFixture())); await h.controller.dispose() }
  })
  test.each(["slash", "button"] as const)("capacity writes share the same flow from %s", async door => {
    const h = await harness()
    try {
      await h.controller.commands.run("settings"); await tick()
      const result = door === "slash" ? await h.controller.commands.run("settings", JSON.stringify({ operation: "capacity", capacity: Number("3") }))
        : await h.controller.commands.submit({ name: "settings", payload: { operation: "capacity", capacity: 3 }, actor: "user" })
      expect(result.status).toBe("executed")
      await tick()
      expect(h.requests.filter(request => request.path === "/api/install" && request.method === "PUT").map(request => JSON.parse(request.body!))).toEqual([{ capacity: 3 }])
    } finally { await h.controller.dispose() }
  })
  test.each([["settings.capacity", "1", "capacity"], ["settings.parallel", "1", "parallel"]] as const)("%s writes the live install, not the seed, once the card shows it", async (_name, args, field) => {
    const h = await harness({ apiVersion: 1, host: "local", version: "1.0.0", buildSha: "abcdef1234567890", capabilities: ["agent", "install"], authFlow: "none", sandbox: { platform: "darwin", mode: "enforced" } })
    try {
      await tick()
      expect(h.controller.installSnapshots.get().model).toBeDefined()
      const seeded = h.controller.design.world().repo[field]
      expect((await h.controller.commands.run("settings", JSON.stringify({ operation: field, [field]: Number(args) }))).status).toBe("executed"); await tick()
      const writes = h.requests.filter(request => request.path === "/api/install" && request.method === "PUT")
      expect(writes.map(request => JSON.parse(request.body!))).toEqual([{ [field]: 1 }])
      expect(h.controller.design.world().repo[field]).toBe(seeded)
    } finally { await h.controller.dispose() }
  })
  test("T-STK-03 mounted Parallel control dispatches once and waits for the install receipt", async () => {
    let resolve!: (response: Response) => void
    const pending = new Promise<Response>(done => { resolve = done })
    let reads = 0
    const h = await harness(undefined, () => ++reads === 1 ? Response.json(installFixture()) : pending)
    try {
      await h.controller.commands.run("settings"); await tick()
      const seeded = h.controller.design.world().repo.parallel
      let props!: SettingsViewProps
      const render = (owner = true) => renderToStaticMarkup(createElement(SettingsContainer, {
        View: input => { props = input; return createElement(SettingsView, input) },
        install: h.controller.installSnapshots, owner, origin: "http://localhost", view: { maximized: false }, onView: () => {},
        dispatch: (name, payload, gesture) => h.controller.commands.submit({ name, payload: payload ?? {}, actor: "user", gesture })
      }))
      expect(render()).toContain('data-operation="parallel"')
      const onAction = props.onAction
      onAction("settings", { ...props.actions.find(action => action.tag === "settings" && action.args?.operation === "parallel")?.args, field: "parallel", operation: "parallel", value: "8" })
      onAction("settings", { ...props.actions.find(action => action.tag === "settings" && action.args?.operation === "parallel")?.args, field: "parallel", operation: "parallel", value: "8" }); await tick()
      expect(h.requests.filter(request => request.method === "PUT")).toEqual([{ path: "/api/install", method: "PUT", body: '{"parallel":8}' }])
      expect(h.controller.installSnapshots.get().model?.parallel).toBe(2)
      // An unresolved setting write leaves unrelated chat commands usable.
      expect((await h.controller.commands.run("settings")).status).toBe("executed")
      resolve(Response.json({ ...installFixture(), parallel: 8 })); await tick()
      render()
      expect(h.controller.installSnapshots.get().model?.parallel).toBe(8)
      expect(props.actions.find(action => action.tag === "settings" && action.args?.operation === "parallel")?.input?.[0]?.value).toBe("8")
      expect(h.controller.design.world().repo.parallel).toBe(seeded)
      expect(render(false)).toBe("")
      await h.controller.commands.submit({ name: "settings", payload: { operation: "parallel", parallel: 1 }, actor: "agent" }); await tick()
      expect(h.requests.filter(request => request.method === "PUT")).toHaveLength(1)
    } finally { resolve(Response.json(installFixture())); await h.controller.dispose() }
  })
  test("settings.address writes the seed while no install serves a model; nothing reaches /api/install", async () => {
    const h = await harness(undefined, () => Response.json({ code: "unavailable", class: "infra", message: "Install unavailable" }, { status: 503 }))
    try {
      await h.controller.commands.run("settings"); await tick()
      expect(h.controller.installSnapshots.get().model).toBeUndefined()
      const outcome = await h.controller.commands.submit({ name: "settings", actor: "user",
        payload: { operation: "address", listen: "network", bind: "0.0.0.0:4000", origins: ["https://maya-mini.tail1234.ts.net"] } })
      expect(outcome.status).toBe("executed"); await tick()
      expect(h.requests.filter(request => request.method === "PUT")).toEqual([])
      expect(h.controller.design.world().repo.setup.addresses).toEqual(["https://maya-mini.tail1234.ts.net"])
      expect(h.controller.design.world().repo.setup.listen).toBe("network")
    } finally { await h.controller.dispose() }
  })
  test("settings.address writes the live install, not the seed, once the card shows it", async () => {
    const h = await harness({ apiVersion: 1, host: "local", version: "1.0.0", buildSha: "abcdef1234567890", capabilities: ["agent", "install"], authFlow: "none", sandbox: { platform: "darwin", mode: "enforced" } })
    try {
      await tick()
      expect(h.controller.installSnapshots.get().model).toBeDefined()
      const seeded = h.controller.design.world().repo.setup.addresses
      const address = { listen: "network", bind: "0.0.0.0:4000", origins: ["https://maya-mini.tail1234.ts.net"] }
      expect((await h.controller.commands.submit({ name: "settings", actor: "user", payload: { ...address, operation: "address" } })).status).toBe("executed"); await tick()
      expect(h.requests.filter(request => request.path === "/api/install" && request.method === "PUT").map(request => JSON.parse(request.body!))).toEqual([{ bind: address.bind, origins: address.origins }])
      expect(h.controller.design.world().repo.setup.addresses).toEqual(seeded)
    } finally { await h.controller.dispose() }
  })
  test("an advertised install with no route opens quietly; an unreachable install shows its failure", async () => {
    const local: AppBootstrap = { apiVersion: 1, host: "local", version: "1.0.0", buildSha: "abcdef1234567890", capabilities: ["agent", "install"], authFlow: "none", sandbox: { platform: "darwin", mode: "enforced" } }
    const missing = await harness(local, () => new Response("Not found", { status: 404 }))
    try {
      await tick()
      expect([...missing.store.collections.toasts.values()].filter(toast => toast.status === "failed")).toEqual([])
    } finally { await missing.controller.dispose() }
    const offline = await harness(local, () => { throw new Error("offline") })
    try {
      await tick()
      expect([...offline.store.collections.toasts.values()].map(toast => [toast.title, toast.status, toast.detail])).toEqual([["Setup", "failed", "Could not reach this install"]])
    } finally { await offline.controller.dispose() }
  })
  test.each([
    ['{"step":"address"}', ["bind", "origins"]],
    ['{"step":"address","bind":"127.0.0.1:4000"}', ["origins"]],
    ['{"step":"app_manifest"}', ["owner"]],
    ['{"step":"repository"}', ["repository"]]
  ] as const)("THE FORM LAW: /settings.setup %s renders the step's missing inputs instead of a refusal", async (args, missing) => {
    const h = await harness()
    try {
      const outcome = await h.controller.commands.run("settings", JSON.stringify({ ...JSON.parse(args), operation: "setup" }))
      expect(outcome).toMatchObject({ status: "form", flow: "settings", fields: missing })
      const form = [...h.store.collections.cards.values()].find(card => card.kind === "flow-form")
      expect(form?.kind === "flow-form" ? form.payload.fields.map(field => field.name) : []).toEqual([...missing])
      expect(h.requests.some(request => request.path.startsWith("/api/install/setup"))).toBe(false)
    } finally { await h.controller.dispose() }
  })
  test("a setup step that needs no input runs without a form", async () => {
    const h = await harness()
    try {
      const outcome = await h.controller.commands.run("settings", JSON.stringify({ ...JSON.parse('{"step":"models"}'), operation: "setup" }))
      expect(outcome.status).not.toBe("form")
      expect([...h.store.collections.cards.values()].some(card => card.kind === "flow-form")).toBe(false)
    } finally { await h.controller.dispose() }
  })
  test("missing model key inputs render the shared write-only form without keeping values", async () => {
    const h = await harness()
    try {
      await h.controller.commands.run("settings"); await tick()
      await h.controller.commands.run("settings", JSON.stringify({ ...JSON.parse('{"role":"jev","provider":"AI Gateway","value":"private-key","key":"old-private-key","token":"older-private-key"}'), operation: "model-key" }))
      const form = [...h.store.collections.cards.values()].find(card => card.kind === "flow-form")
      expect(form?.kind).toBe("flow-form")
      expect(JSON.stringify(form)).not.toContain("private-key")
      expect(h.requests.some(request => request.path === "/api/model/credential")).toBe(false)
    } finally { await h.controller.dispose() }
  })
  test("a card key field reaches the same command once without entering durable card state", async () => {
    // The install capability reads the install at start, so the key write has a model to check against.
    const h = await harness({ apiVersion: 1, host: "local", version: "1.0.0", buildSha: "abcdef1234567890", capabilities: ["agent", "install"], authFlow: "none", sandbox: { platform: "darwin", mode: "enforced" } })
    try {
      await h.controller.commands.run("settings"); await tick()
      const dispatch: InstallCardDispatch = (tag, input, gesture) =>
        h.controller.commands.submit({ name: tag, payload: input ?? {}, actor: "user", gesture })
      const key = installKeyAction(dispatch, installFixture())
      const bindings = cardActions(key.dispatch, [key.definition])
      bindings.onAction("settings", { operation: "model-key", role: "jev", provider: "AI Gateway", value: "private-key" })
      await tick()
      const writes = h.requests.filter(request => request.path === "/api/model/credential")
      expect(writes).toHaveLength(1)
      expect(JSON.parse(writes[0]!.body!)).toEqual({ action: "rotate", name: "AI_GATEWAY_API_KEY", requestId: expect.any(String), value: "private-key" })
      expect(JSON.stringify([...h.store.collections.cards.values()])).not.toContain("private-key")
      expect(JSON.stringify([...h.store.collections.commandIntents.values()])).not.toContain("private-key")
      expect(JSON.stringify(h.controller.installSnapshots.get())).not.toContain("private-key")
    } finally { await h.controller.dispose() }
  })
})


describe("T-FLW-12 Obsidian control", () => {
  test("one owner PUT preserves the literal folder contract and projects sync status", async () => {
    const fixture = { ...installFixture(), wiki_sync: { obsidian: { path: "/Users/owner/Vault", last_sync_at: "2026-10-04T12:00:00Z", error: "Folder unavailable" } } }
    const h = await harness(undefined, () => Response.json(fixture))
    try {
      await h.controller.commands.run("settings"); await tick()
      let onAction!: SettingsViewProps["onAction"]
      const html = renderToStaticMarkup(createElement(SettingsContainer, {
        View: props => { onAction = props.onAction; return createElement(SettingsView, props) },
        install: h.controller.installSnapshots, owner: true, origin: "http://localhost", view: { maximized: false }, onView: () => {},
        dispatch: (name, payload, gesture) => h.controller.commands.submit({ name, payload: payload ?? {}, actor: "user", gesture })
      }))
      expect(html).toContain('data-operation="obsidian"')
      onAction("settings", { field: "obsidian", operation: "obsidian", path: "/Users/owner/Notes" }); await tick()
      expect(h.requests.filter(request => request.method === "PUT")).toEqual([{ path: "/api/install", method: "PUT", body: '{"wiki_sync.obsidian":{"path":"/Users/owner/Notes"}}' }])
      expect(h.controller.installSnapshots.get().model?.wiki_sync).toEqual({ obsidian: { path: "/Users/owner/Vault", last_sync_at: "2026-10-04T12:00:00Z", error: "Folder unavailable" } })
      await h.controller.commands.submit({ name: "settings", payload: { operation: "obsidian", path: "/Users/owner/Agent" }, actor: "agent" }); await tick()
      expect(h.requests.filter(request => request.method === "PUT")).toHaveLength(1)
    } finally { await h.controller.dispose() }
  })
  test.each(["missing", "non-owner", "relative", "nul"])("%s refuses without PUT or seed mutation", async kind => {
    const fixture = { ...installFixture(), ...(kind === "missing" ? {} : { wiki_sync: {} }), github: { ...installFixture().github, signed_in: kind !== "non-owner" } }
    const h = await harness(undefined, () => Response.json(fixture))
    try {
      await h.controller.commands.run("settings"); await tick()
      await h.controller.commands.submit({ name: "settings", payload: { operation: "obsidian", path: kind === "relative" ? "Vault" : kind === "nul" ? "/Vault\0bad" : "/Vault" }, actor: "user" }); await tick()
      expect(h.requests.filter(request => request.method === "PUT")).toEqual([])
    } finally { await h.controller.dispose() }
  })
  test("rejected changes retain the active folder and show the refusal", async () => {
    let reads = 0
    const h = await harness(undefined, () => ++reads === 1 ? Response.json({ ...installFixture(), wiki_sync: { obsidian: { path: "/Vault" } } })
      : Response.json({ code: "folder_refused", class: "user", message: "Obsidian folder refused" }, { status: 400 }))
    try {
      await h.controller.commands.run("settings"); await tick()
      await h.controller.commands.submit({ name: "settings", payload: { operation: "obsidian", path: "/state" }, actor: "user" }); await tick()
      expect(h.controller.installSnapshots.get().model?.wiki_sync?.obsidian).toEqual({ path: "/Vault", error: "Obsidian folder refused" })
      expect(h.controller.installSnapshots.get().error?.message).toBe("Obsidian folder refused")
      expect(h.controller.installSnapshots.get().model?.wiki_sync?.obsidian?.error).toBe("Obsidian folder refused")
    } finally { await h.controller.dispose() }
  })
})

 test("daily allowance uses the person flow and rejects invalid counts before transport", async () => {
    const h = await harness()
    try {
      await h.controller.commands.run("settings"); await tick()
      for (const value of [0, -1, 1.5]) {
        const result = await h.controller.commands.run("settings", JSON.stringify({ operation: "daily-admissions", todo_daily_admissions: Number(String(value)) }))
        expect(result.status).not.toBe("executed")
      }
      expect((await h.controller.commands.submit({ name: "settings", payload: { operation: "daily-admissions", todo_daily_admissions: 18 }, actor: "user" })).status).toBe("executed")
      await tick()
      expect(h.requests.filter(request => request.method === "PUT").map(request => JSON.parse(request.body!))).toEqual([{ todo_daily_admissions: 18 }])
    } finally { await h.controller.dispose() }
  })

test("the recorded Account door opens Settings with the same owner authority", async () => {
 const h = await harness()
 try {
   expect((await h.controller.commands.run("account.show")).status).toBe("executed"); await tick()
   expect([...h.store.collections.cards.keys()]).toEqual(["settings"])
   expect(h.controller.commands.find("account.show")!.metadata.minimumRole).toBe("owner")
   expect(modelInvocable(h.controller.commands.find("account.show")!)).toBe(false)
 } finally { await h.controller.dispose() }
})

test("recorded environment doors decode to Settings and discard retired assignments", async () => {
 const h = await harness()
 try {
   for (const [name, args] of [["env.view", "old/repository"], ["env.set", "API_KEY=private-value"], ["env.remove-token", "old/repository"]]) {
     expect(h.controller.commands.find(name!)).toBeUndefined()
     expect((await h.controller.commands.run(name!, args!)).status).toBe("unknown-command")
     const input = { flow: name!, args: args!, label: "Settings" }
     const saved = MessageSchema.shape.action.parse(input)!
     const toast = ToastSchema.shape.action.parse(input)!
     expect(saved.flow).toBe("settings")
     expect(toast).toEqual(saved)
     if (name === "env.set") {
       expect(saved.args).toBeUndefined()
       expect(JSON.stringify(saved)).not.toContain("private-value")
       const answered = MessageSchema.shape.answeredAction.parse({ ...input, answer: "Done", answeredAt: 1 })!
       expect(answered.flow).toBe("settings")
       expect(answered.args).toBeUndefined()
       expect(ToastSchema.shape.answeredAction.parse({ ...input, answer: "Done", answeredAt: 1 })).toEqual(answered)
     }
     expect((await h.controller.commands.run(saved.flow, saved.args)).status).toBe("executed"); await tick()
     expect([...h.store.collections.cards.keys()]).toEqual(["settings"])
     expect(modelInvocable(h.controller.commands.find("settings")!)).toBe(false)
   }
   expect(ToastSchema.shape.action.safeParse({ flow: "unlisted.env.write", args: "API_KEY=private-value", label: "Run" }).success).toBe(false)
   expect(h.requests.every(request => !request.path.includes("agent-environment"))).toBe(true)
 } finally { await h.controller.dispose() }
})

test("recorded coding-account doors open Settings without enrolling or reordering accounts", async () => {
  const h = await harness()
  try {
    for (const name of ["secrets.connect", "secrets.connect.codex", "secrets.connections", "secrets.move", "secrets.revoke"]) {
      expect(h.controller.commands.find(name)).toBeUndefined()
      expect((await h.controller.commands.run(name)).status).toBe("unknown-command")
      const action = MessageSchema.shape.action.parse({ flow: name, args: "saved-connection", label: "Settings" })!
      expect(action.flow).toBe("settings")
      expect((await h.controller.commands.run(action.flow, action.args)).status).toBe("executed"); await tick()
      expect([...h.store.collections.cards.keys()]).toEqual(["settings"])
      expect(modelInvocable(h.controller.commands.find("settings")!)).toBe(false)
    }
    expect(h.requests.every(request => !request.path.includes("provider-connections"))).toBe(true)
    expect(h.store.session().codingProviderRequests ?? []).toEqual([])
  } finally { await h.controller.dispose() }
})

test("recorded GitHub status retains admission and repository-choice doors use Setup", async () => {
  const h = await harness()
  try {
    expect((await h.controller.commands.run("github.app")).status).toBe("unknown-command")
    const saved = MessageSchema.shape.action.parse({ flow: "github.app", args: "old/repository", label: "Settings" })!
    expect(saved.flow).toBe("github")
    expect(JSON.parse(saved.args!)).toEqual({ operation: "app-status" })
    // d72c762b27: a recorded setup door uses GitHub's existing admission,
    // rather than silently opening owner Settings for a signed-out reader.
    expect(await h.controller.commands.run(saved.flow, saved.args)).toMatchObject({ status: "failed", error: "Sign in to Smithers Cloud to continue." })
    expect(h.store.collections.cards.has("settings")).toBe(false)
    for (const name of ["repo.choose", "repo.create"]) {
      expect((await h.controller.commands.run(name)).status).toBe("executed"); await tick()
      expect(h.store.collections.cards.has("setup")).toBe(true)
      expect(modelInvocable(h.controller.commands.find(name)!)).toBe(false)
    }
    expect(h.requests.every(request => !request.path.includes("github-app") && !request.path.includes("user/repos"))).toBe(true)
  } finally { await h.controller.dispose() }
})


test("recorded Settings writes keep their operation and discard a persisted model key", () => {
  for (const [operation, input] of [
    ["address", { listen: "network", bind: "0.0.0.0:4000", origins: ["https://team.test"] }],
    ["capacity", { capacity: 2 }], ["parallel", { parallel: 3 }],
    ["preapprove-default", { todo_preapprove_default: true }], ["daily-admissions", { todo_daily_admissions: 12 }],
    ["fast-model", { action: "sign-out" }], ["obsidian", { path: "/Vault" }], ["setup", { step: "repository", repository: "owner/repo" }]
  ] as const) {
    const old = { flow: `settings.${operation}`, label: "Save", args: JSON.stringify(input) }
    const action = MessageSchema.shape.action.parse(old)!
    expect(action.flow).toBe("settings")
    expect(JSON.parse(action.args!)).toEqual({ ...input, operation })
    expect(ToastSchema.shape.action.parse(old)).toEqual(action)
  }
  const key = MessageSchema.shape.action.parse({ flow: "settings.model-key", label: "Save", args: JSON.stringify({ role: "fast", provider: "Cerebras", value: "retired-private-value", key: "retired-private-key", token: "retired-private-token" }) })!
  expect(JSON.parse(key.args!)).toEqual({ operation: "model-key", role: "fast", provider: "Cerebras" })
  expect(JSON.stringify(key)).not.toContain("retired-private-value")
})


test("saved Smithers sign-in controls decode without exposing a retired executable", async () => {
  const h = await harness()
  try {
    expect(h.controller.commands.find("settings.fast-model")).toBeUndefined()
    expect((await h.controller.commands.run("settings.fast-model", "sign-in")).status).toBe("unknown-command")
    for (const action of ["sign-in", "sign-out"]) {
      const saved = MessageSchema.shape.action.parse({ flow: "settings.fast-model", label: "Continue", args: action })!
      expect(saved.flow).toBe("settings")
      expect(JSON.parse(saved.args!)).toEqual({ operation: "fast-model", action })
      expect(ToastSchema.shape.action.parse({ flow: "settings.fast-model", label: "Continue", args: action })).toEqual(saved)
    }
    expect((await h.controller.commands.submit({ name: "settings", payload: { operation: "fast-model", action: "sign-out" }, actor: "agent" })).status).toBe("failed")
    expect(h.requests).toEqual([])
  } finally { await h.controller.dispose() }
})
