import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { MAIN_TAB_ID } from "./AppState"
import type { AgentPort } from "../runtime/AgentPort"
import { scopedControllers } from "./ControllerTestScope"
import { createAppStore } from "./AppStore"
import { memoryStorage, settled, waitFor } from "./TestFixtures"

const createAppController = scopedControllers()

const webStore = () => createAppStore({ kind: "localStorage", storage: memoryStorage() })

/** Mirrors a web-mode agent whose server boundary is unreachable: every turn errors. */
const webAgent = (message = "Could not reach the Smithers web agent."): AgentPort => ({
  available: false,
  startTurn: async () => ({ status: "error", message }),
  cancelTurn: async () => {},
  subscribe: () => () => {}
})

/** HTTP is the shared conversation seam; browser agent execution must stay unused. */
const installedConversation = async (store: Awaited<ReturnType<typeof webStore>>) => {
  await store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-in", login: "owner", memberId: 1, admin: false, scopesPlain: null }).isPersisted.promise
  const requests: Array<{ prompt: string; idempotencyKey: string }> = []
  let nativeStarts = 0
  const controller = createAppController(store, { ...webAgent(), available: true,
    startTurn: async () => { nativeStarts++; return { status: "error", message: "Unexpected browser execution" } }
  }, {
    applicationIdentity: { current: async () => ({ memberId: 1, username: "owner", admin: false, scopes: null }) },
    bootstrap: { apiVersion: 1, host: "cloud", version: "test", buildSha: "test", capabilities: ["install", "identity"], authFlow: "redirect", sandbox: null },
    fetchImpl: async (input, init) => {
      const path = String(input)
      if (path.endsWith("/api/user")) return Response.json({ id: 1, username: "owner", is_admin: false })
      if (path.endsWith("/api/conversations/main/prompt") && init?.method === "POST") {
        requests.push(JSON.parse(String(init.body)))
        return Response.json({ turnId: `turn-${requests.length}`, terminal: true }, { status: 202 })
      }
      if (path.endsWith("/api/conversations/main")) return Response.json({ id: "main", entries: requests.map((request, index) => ({
        id: `turn-${index + 1}`, author: 1, authorLogin: "owner", runId: `run-${index + 1}`, prompt: request.prompt, state: "completed",
        frames: [{ runId: `run-${index + 1}`, type: "delta", kind: "text", text: "Hello from Smithers." }, { runId: `run-${index + 1}`, type: "done" }]
      })) })
      if (path.endsWith("/api/conversations/main/view-state")) return Response.json({})
      return new Response(null, { status: 404 })
    }
  })
  return { controller, requests, nativeStarts: () => nativeStarts }
}

test("parking a gated act dispatches only the durable command, leaving the answer to its prompt", async () => {
  const store = await webStore()
  const controller = createAppController(store, webAgent())
  const before = new Set(store.collections.transitions.keys())
  controller.deferCommand("issues.view", "3", "signed-in")
  const events = [...store.collections.transitions.values()].filter(record => !before.has(record.id))
  expect(events.map(record => record.type)).toEqual(["command.deferred"])
  expect(store.session().pendingCommand).toMatchObject({ name: "issues.view", args: "3", requirement: "signed-in" })
  expect([...store.collections.toasts.values()]).toEqual([])
})

describe("createAppController in pure web mode", () => {
  test("reports the native agent as unavailable without blocking the composer path", async () => {
    const controller = createAppController(await webStore(), webAgent())
    expect(controller.nativeAgentAvailable).toBe(false)
  })

  test("refuses an unadmitted prompt with a visible failure when no conversation provider exists", async () => {
    const store = await webStore()
    const controller = createAppController(store, webAgent(), { toastDebounceMs: 0 })

    expect(await controller.send("hello from the web build")).toBe(false)
    await waitFor(() => [...store.collections.toasts.values()].some(toast => toast.status === "failed"))
    expect([...store.collections.toasts.values()].find(toast => toast.status === "failed")?.detail).toBe("Chat didn't finish — the app hit an unexpected error.")
    expect([...store.collections.messages.values()]).toEqual([])
  })

  test("keeps the composer draft and idle session usable after failed admission", async () => {
    const store = await webStore()
    const controller = createAppController(store, webAgent(), { toastDebounceMs: 0 })

    for (const text of ["first attempt", "second attempt"]) {
      controller.changeDraft(text)
      expect(await controller.send(text)).toBe(false)
      await settled()
      expect(store.session().phase).toBe("idle")
      expect(store.session().draft).toBe(text)
    }
    expect([...store.collections.messages.values()]).toEqual([])
  })

  test("reads completed host frames through the shared conversation without browser execution", async () => {
    const store = await webStore()
    const { controller, requests, nativeStarts } = await installedConversation(store)
    await waitFor(() => store.collections.identitySessions.get("identity")?.state === "signed-in")

    await controller.send("Hello who are you")
    await waitFor(() => controller.sharedConversation?.get().conversation?.entries.length === 1)
    expect(requests[0]?.prompt).toBe("Hello who are you")
    expect(controller.sharedConversation?.get().conversation?.entries[0]).toMatchObject({
      state: "completed", frames: [{ type: "delta", kind: "text", text: "Hello from Smithers." }, { type: "done" }]
    })
    expect(nativeStarts()).toBe(0)
    expect(store.session().phase).toBe("idle")
  })

  test("journals composer and theme transitions with their actor in web mode", async () => {
    const store = await webStore()
    const controller = createAppController(store, webAgent())

    controller.changeDraft("draft in the browser")
    expect(store.session().draft).toBe("draft in the browser")

    const before = store.session().theme
    controller.setTheme()
    expect(store.session().theme).not.toBe(before)

    const journal = [...store.collections.transitions.values()]
    expect(journal.some((record) => record.type === "theme.changed" && record.actor === "user")).toBe(true)
  })
})

describe("the controller's command surface", () => {
  test("runCommand takes optional args in one member, with the split members gone", async () => {
    const controller = createAppController(await webStore(), webAgent())

    expect(controller.runCommand("definitely-not-a-command")).toBe(false)
    expect(controller.runCommand("definitely-not-a-command", "with args")).toBe(false)
    expect(controller.commands.find("palette.open")).toBeDefined()
    expect(controller.runCommand("palette.open")).toBe(true)
    expect(controller.runCommand("palette.open", "ignored args")).toBe(true)

    expect("runCommandArgs" in controller).toBe(false)
    expect("withAgentActor" in controller).toBe(false)
    // The registry's state read stays internal to it.
    expect("snapshot" in controller).toBe(false)
  })

  test("runCommandForResult reports an unknown command and a closed controller", async () => {
    const controller = createAppController(await webStore(), webAgent())
    expect(await controller.runCommandForResult("definitely-not-a-command")).toEqual({ status: "unknown-command" })
    await controller.dispose()
    expect(await controller.runCommandForResult("chat.copy-message", "text")).toEqual({
      status: "failed", error: "The controller is closed."
    })
  })

  /*
   * ui-state-store/maintainability/1: the returned controller must BE the
   * command registry's action map plus the composition root's own members —
   * one spread, so every controller key is the same function reference the
   * registry bound. A hand-wired member in the return block can drift from
   * the registry's binding; fail on any member that is not the spread or a
   * named composition-root extra.
   */
  test("every controller key is the registry binding by construction (one spread, no re-enumeration)", () => {
    const source = readFileSync(fileURLToPath(new URL("./AppController.ts", import.meta.url)), "utf8")
    expect(source).toContain("const { snapshot: _snapshot, ...sharedActions } = commandActions")
    expect(source).not.toContain("withAgentActor")
    expect(source).not.toContain("runCommandArgs")

    const returned = source.slice(source.indexOf("...sharedActions"))
    const block = returned.slice(0, returned.indexOf("\n  }\n}"))
    const members = block.split("\n")
      .map((line) => /^\s{4}(?:readonly )?([A-Za-z_$][\w$]*)\b/.exec(line)?.[1])
      .filter((key): key is string => key !== undefined)
    const compositionRoot = [
      "observeReviewConfirmation",
      "contextLine",
      "store",
      "stackSnapshots",
      "homeView",
      "runMonitors",
      "listRunMonitors",
      "openRunMonitor",
      "openBranchTerminal",
      "setRunView",
      "secretsProviders",
      "sharedConversation",
      "installSnapshots",
      "todoList",
      "fileDocuments",
      "flowCatalog",
      "membersRole",
      "membersRoster",
      "githubSyncSnapshots",
      "externalSession",
      "timelineTitles",
      "wikiIndexes",
      "wikiAttachments",
      "controlFocus",
      "formFocus",
      "storageRecoveryState",
      "privacyNotices",
      "features",
      "nativeAgentAvailable",
      "design",
      "live",
      "presentCard",
      "presentBranchCard",
      "presentRun",
      "contextRun",
      "presentFlow",
      "tappedFetch",
      "commands",
      "slashItems",
      "slashTree",
      "runCommand",
      "runCommandForResult",
      "submitCommand",
      "dispose"
    ]
    expect(members.sort()).toEqual([...compositionRoot].sort())
  })
})

test("restored tombstones refuse maximize and tab activation and never enter a shared prompt", async () => {
  const storage = memoryStorage()
  const original = await createAppStore({ kind: "localStorage", storage })
  await original.dispatch({ type: "card.upsert", actor: "system", card: {
    id: "legacy", kind: "retired", title: "PRIVATE_LEGACY_TITLE", body: "PRIVATE_LEGACY_BODY",
    status: "acted", createdAt: 1, ordinal: 1, payload: {}
  } }).isPersisted.promise
  await original.dispatch({ type: "card.upsert", actor: "system", card: {
    id: "live", kind: "file", title: "CURRENT_LIVE_TITLE", status: "active", createdAt: 1, ordinal: 2,
    payload: { repo: "org/repo", path: "a.ts", content: "Live", truncated: false }
  } }).isPersisted.promise
  await original.dispatch({ type: "card.maximized", actor: "user", id: "legacy" }).isPersisted.promise
  await original.dispatch({ type: "tab.opened", actor: "user", tab: {
    id: "legacy-tab", kind: "card", cardId: "legacy", title: "PRIVATE_LEGACY_TAB"
  } }).isPersisted.promise
  await original.dispatch({ type: "tab.selected", actor: "user", id: "legacy-tab" }).isPersisted.promise
  await original.dispose?.()
  const store = await createAppStore({ kind: "localStorage", storage })
  const { controller, requests, nativeStarts } = await installedConversation(store)
  await waitFor(() => store.collections.identitySessions.get("identity")?.state === "signed-in")
  expect(store.session().maximizedCardId).toBeNull()
  expect(store.session().activeTabId).toBe(MAIN_TAB_ID)
  expect(controller.maximizeCard("legacy")).toBe("This feature is not enabled.")
  const outcome = await controller.runCommandForResult("card.maximize", "legacy")
  expect(outcome.status).toBe("failed")
  expect(store.session().maximizedCardId).toBeNull()
  await controller.send("Read the current conversation")
  await waitFor(() => requests.length === 1)
  expect(requests[0]?.prompt).toBe("Read the current conversation")
  expect(Object.keys(requests[0]!).sort()).toEqual(["idempotencyKey", "prompt"])
  expect(JSON.stringify(requests)).not.toContain("PRIVATE_LEGACY")
  expect(nativeStarts()).toBe(0)
})
