import { digest } from "@smthrs/core/Digest"
import { CONVERSATION_REPLAY_PATH, CONVERSATIONS_PATH } from "@smthrs/rpc/AgentApiRoutes"
import {
  type AgentConversationPage,
  type AgentConversationReplay,
  type AgentTurnBatch,
  type AgentTurnCursor,
  agentTurnJournalDigestInput
} from "@smthrs/rpc/AgentTurnJournal"
import type { AppBootstrap } from "@smthrs/rpc/AppBootstrap"
import type { AgentTurnFrame } from "@smthrs/rpc/NativeAgent"
import { afterEach, expect, test } from "bun:test"
import { createWebAgent } from "../native/WebAgent"
import { emptyAppProjection, projectAppEvent, seedAppProjection } from "./AppProjection"
import type { AppTransition } from "./AppState"
import { rootFrameId } from "./AppState"
import { type AppStore, createAppStore } from "./AppStore"
import { scopedControllers } from "./ControllerTestScope"
import {
  type ConversationHistory,
  historyHasNewerUserIntent,
  verifyConversationHistory,
  verifyConversationHistoryPage
} from "./ConversationHistory"
import { memoryStorage, settled, silentAgent } from "./TestFixtures"

const createAppController = scopedControllers()
const cloud: AppBootstrap = {
  apiVersion: 1,
  host: "cloud",
  version: "test",
  buildSha: "test",
  capabilities: ["agent", "identity"],
  authFlow: "redirect",
  sandbox: null
}
const cursor = (runId = "turn", legId = "leg"): AgentTurnCursor => ({
  version: 1,
  runId,
  legId,
  batch: 0,
  position: 0,
  hash: "a".repeat(64)
})
const batch = (before: AgentTurnCursor, frames: AgentTurnFrame[]): AgentTurnBatch => {
  const body = {
    version: 1 as const,
    runId: before.runId,
    legId: before.legId,
    batch: before.batch + 1,
    from: before.position + 1,
    previousHash: before.hash,
    frames
  }
  return { ...body, hash: digest(agentTurnJournalDigestInput("batch", body)) }
}
const next = (value: AgentTurnBatch): AgentTurnCursor => ({
  version: 1,
  runId: value.runId,
  legId: value.legId,
  batch: value.batch,
  position: value.from + value.frames.length - 1,
  hash: value.hash
})
const saved = (id = "branch-saved", runId = "turn"): ConversationHistory => {
  const initial = cursor(runId),
    output = batch(initial, [{ type: "delta", runId, kind: "text", text: "Saved answer" }, {
      type: "done",
      runId,
      reason: "stop"
    }])
  return {
    id,
    legs: [{
      runId,
      legId: "leg",
      userText: "Saved question",
      acceptedAt: 1,
      initial,
      head: next(output),
      terminal: true,
      batches: [output],
      runLinks: [{ repo: "alice/demo", runId: "background-run" }]
    }]
  }
}
const boot = () => seedAppProjection(emptyAppProjection(), { createdAt: 1, theme: "light" })
const step = (state: ReturnType<typeof boot>, transition: AppTransition) =>
  projectAppEvent(state, {
    transition,
    revision: state.sessions[0]!.revision + 1,
    createdAt: 2,
    persistenceMode: "localStorage"
  })
const signed = (owner = "alice") =>
  step(boot(), {
    type: "identity.session.loaded",
    actor: "system",
    state: "signed-in",
    login: owner,
    admin: false,
    scopesPlain: null,
    provider: "github"
  })
const restore = (conversations = [saved()], owner = "alice"): AppTransition => ({
  type: "conversation.restored",
  actor: "system",
  owner,
  afterRevision: 1,
  conversations
})

test("account replay uses the existing message reducer, frame navigation and run door without execution authority", () => {
  const restored = step(signed(), restore([saved(), saved("branch-second", "turn2")]))
  expect(restored.messages.find((row) => row.id === "message-turn2-user")?.text).toBe("Saved question")
  expect(restored.messages.find((row) => row.id === "message-turn2-smithers")?.text).toBe("Saved answer")
  expect(restored.messages.find((row) => row.action?.flow === "runs.open")?.action).toEqual({
    flow: "runs.open",
    label: "background-run",
    args: "background-run alice/demo"
  })
  expect(restored.messages.at(-1)?.text).toContain("/w/workspace-main/b/branch-saved/f/frame-root%3Abranch-saved")
  expect(restored.httpTurns).toEqual([])
  expect(restored.httpTurnLegs).toEqual([])
  expect(restored.toolCalls).toEqual([])
  expect(restored.sessions[0]).toMatchObject({ phase: "idle", activeBranchId: "branch-second", turnId: null })
  const back = step(restored, {
    type: "frame.navigated",
    actor: "user",
    workspaceId: "workspace-main",
    branchId: "branch-saved",
    frameId: rootFrameId("branch-saved")
  })
  expect(back.messages.find((row) => row.id === "message-turn-user")?.text).toBe("Saved question")
  expect(back.messages.some((row) => row.id === "message-turn2-user")).toBe(false)
  expect(step(back, restore())).toBe(back)
})

test("owner, active conversation and all-byte validation fence restoration before any mutation", () => {
  const initial = signed()
  expect(step(initial, restore(undefined, "other"))).toBe(initial)
  const answering = step(initial, { type: "message.submitted", actor: "user", turnId: "new", text: "New question" })
  expect(step(answering, restore())).toBe(answering)
  const corrupt = saved()
  corrupt.legs[0]!.batches[0]!.frames[0] = { type: "delta", runId: "turn", kind: "text", text: "tampered" }
  expect(() => step(initial, restore([saved("good", "good"), corrupt]))).toThrow("integrity")
  expect(initial.branches.map((row) => row.id)).toEqual(["branch-main"])
  for (const mutation of ["head", "identity", "repeat", "terminal"] as const) {
    const value = saved(), leg = value.legs[0]!
    if (mutation === "head") leg.head = { ...leg.head, hash: "b".repeat(64) }
    if (mutation === "identity") leg.legId = "wrong"
    if (mutation === "repeat") leg.batches.push(leg.batches[0]!)
    if (mutation === "terminal") leg.terminal = false
    expect(() => verifyConversationHistory([value])).toThrow()
  }
  expect(() => verifyConversationHistory([saved(), saved()])).toThrow("Duplicate")
})

test("each replay page verifies its real terminal and cursor chain before a following read", () => {
  const page = responses().replay.page
  expect(() => verifyConversationHistoryPage("turn", "leg", page)).not.toThrow()
  expect(() => verifyConversationHistoryPage("other", "leg", page)).toThrow("identity")
  expect(() => verifyConversationHistoryPage("turn", "leg", { ...page, more: true, head: { ...page.head, batch: 2 } }))
    .toThrow("terminal")
  expect(() => verifyConversationHistoryPage("turn", "leg", { ...page, after: page.next })).toThrow("identity")
  expect(() => verifyConversationHistoryPage("turn", "leg", { ...page, after: page.next }, page.next)).toThrow(
    "terminal"
  )
})

test("tool-ready and running saved turns remain read-only interrupted output; continuations fold once", () => {
  const conversation = saved(), first = conversation.legs[0]!, initial = first.initial
  const output = batch(initial, [{ type: "delta", runId: "turn", kind: "text", text: "Before tool" }, {
    type: "tool_call",
    runId: "turn",
    name: "dangerous.command",
    call_id: "call",
    arguments: "{}"
  }, { type: "done", runId: "turn", reason: "tool_call" }])
  first.batches = [output]
  first.head = next(output)
  const incomplete = step(signed(), restore([conversation]))
  expect(incomplete.messages.find((row) => row.id === "message-turn-smithers")).toMatchObject({
    text: "Before tool",
    status: "interrupted"
  })
  expect(incomplete.toolCalls).toEqual([])
  expect(incomplete.httpTurnLegs).toEqual([])
  const secondInitial = cursor("turn", "continuation"),
    secondOutput = batch(secondInitial, [{ type: "delta", runId: "turn", kind: "text", text: " after tool" }, {
      type: "done",
      runId: "turn",
      reason: "stop"
    }])
  conversation.legs.push({
    ...first,
    legId: "continuation",
    initial: secondInitial,
    head: next(secondOutput),
    batches: [secondOutput]
  })
  const complete = step(signed(), restore([conversation]))
  expect(complete.messages.filter((row) => row.role === "user")).toHaveLength(1)
  expect(complete.messages.find((row) => row.id === "message-turn-smithers")).toMatchObject({
    text: "Before tool after tool",
    status: "complete"
  })
})

const stores: AppStore[] = []
afterEach(async () => {
  for (const store of stores.splice(0)) await store.dispose?.()
})
const open = async (storage = memoryStorage()) => {
  const store = await createAppStore({ kind: "localStorage", storage })
  stores.push(store)
  return store
}
const identify = (store: AppStore, owner = "alice") =>
  store.dispatch({
    type: "identity.session.loaded",
    actor: "system",
    state: "signed-in",
    login: owner,
    admin: false,
    scopesPlain: null,
    provider: "github"
  }).isPersisted.promise
const until = async (predicate: () => boolean) => {
  for (let index = 0; index < 200 && !predicate(); index++) await new Promise((resolve) => setTimeout(resolve, 5))
  expect(predicate()).toBe(true)
}
const responses = (conversation = saved()): { index: AgentConversationPage; replay: AgentConversationReplay } => {
  const leg = conversation.legs[0]!
  return {
    index: {
      status: "ok",
      conversations: [{
        id: conversation.id,
        turns: [{
          runId: leg.runId,
          legId: leg.legId,
          acceptedAt: leg.acceptedAt,
          terminal: leg.terminal,
          runLinks: leg.runLinks
        }]
      }],
      next: null
    },
    replay: {
      status: "ok",
      conversationId: conversation.id,
      userText: leg.userText,
      page: {
        status: "ok",
        after: leg.initial,
        next: leg.head,
        head: leg.head,
        terminal: leg.terminal,
        more: false,
        batches: leg.batches
      }
    }
  }
}
const unrelated = async () => Response.json({})

test("account transport bounds and validates every response without copying server error text", async () => {
  for (const status of [401, 403, 410, 503]) {
    let cancelled = false
    const agent = createWebAgent({
      fetchImpl: async () =>
        new Response(
          new ReadableStream({
            cancel() {
              cancelled = true
            }
          }),
          { status }
        )
    })
    await expect(agent.history!.list()).rejects.toThrow("unavailable")
    expect(cancelled).toBe(true)
  }
  for (const body of [null, "not JSON", "{}", "[]"]) {
    const agent = createWebAgent({ fetchImpl: async () => new Response(body) })
    await expect(agent.history!.list()).rejects.toThrow("Invalid")
  }
  const oversized = createWebAgent({ fetchImpl: async () => new Response(new Uint8Array(8 * 1024 * 1024 + 1)) })
  await expect(oversized.history!.list()).rejects.toThrow("bound")
  const malformedReplay = createWebAgent({ fetchImpl: async () => Response.json({ status: "ok" }) })
  await expect(malformedReplay.history!.replay({ runId: "run", legId: "leg" })).rejects.toThrow(
    "Invalid account replay"
  )
  const queried: string[] = []
  const valid = createWebAgent({
    fetchImpl: async (input) => {
      queried.push(String(input))
      return Response.json({ status: "ok", conversations: [], next: null })
    }
  })
  await expect(valid.history!.list("+/cursor?=")).resolves.toEqual({ status: "ok", conversations: [], next: null })
  expect(queried).toEqual([`${CONVERSATIONS_PATH}?after=%2B%2Fcursor%3F%3D`])
})

test("an unresponsive account response body is cancelled by the finite deadline", async () => {
  let cancelled = false
  const agent = createWebAgent({
    fetchImpl: async () =>
      new Response(
        new ReadableStream({
          cancel() {
            cancelled = true
          }
        })
      )
  })
  await expect(agent.history!.list()).rejects.toThrow("timed out")
  await settled()
  expect(cancelled).toBe(true)
}, 15_000)

test("an empty browser journal restores through HTTP and reloads persisted frame facts without a second read or model call", async () => {
  const storage = memoryStorage(), store = await open(storage)
  await identify(store)
  const requests: string[] = [], payloads: unknown[] = [], source = responses()
  const agent = createWebAgent({
    fetchImpl: async (input, init) => {
      const url = String(input)
      requests.push(url)
      if (url.endsWith(CONVERSATIONS_PATH)) return Response.json(source.index)
      if (url.endsWith(CONVERSATION_REPLAY_PATH)) {
        payloads.push(JSON.parse(String(init?.body)))
        return Response.json(source.replay)
      }
      throw new Error("A read-only restore tried to execute")
    }
  })
  const controller = createAppController(store, agent, { bootstrap: cloud, fetchImpl: unrelated })
  await until(() => store.collections.messages.has("message-turn-smithers"))
  await settled()
  expect(payloads).toEqual([{ runId: "turn", legId: "leg" }])
  expect(requests).toEqual([CONVERSATIONS_PATH, CONVERSATION_REPLAY_PATH])
  expect((await store.verifyState()).valid).toBe(true)
  await controller.dispose()
  await store.dispose?.()
  const reopened = await open(storage)
  createAppController(reopened, agent, { bootstrap: cloud, fetchImpl: unrelated })
  await settled()
  expect(reopened.collections.messages.get("message-turn-smithers")?.text).toBe("Saved answer")
  expect(
    reopened.collections.branches.get("branch-saved")?.snapshot?.messages.some((row) => row.text === "Saved question")
  ).toBe(true)
  expect(requests).toHaveLength(2)
})

test("unresolved history does not block Chat; account replacement and disposal reject late pages", async () => {
  for (const ending of ["owner", "dispose", "new-chat"] as const) {
    const store = await open()
    await identify(store)
    const held = Promise.withResolvers<ReturnType<typeof responses>["index"]>(), source = responses()
    let lists = 0, replays = 0, starts = 0
    const agent = {
      ...silentAgent,
      startTurn: async () => {
        starts++
        return { status: "started" as const }
      },
      history: {
        list: async () => {
          lists++
          return lists === 1 ? held.promise : { status: "ok" as const, conversations: [], next: null }
        },
        replay: async () => {
          replays++
          return source.replay
        }
      }
    }
    const controller = createAppController(store, agent, { bootstrap: cloud, fetchImpl: unrelated })
    await until(() => lists === 1)
    await identify(store)
    await settled()
    expect(lists).toBe(1)
    if (ending === "owner") await identify(store, "bob")
    if (ending === "dispose") await controller.dispose()
    if (ending === "new-chat") {
      controller.send("A new question")
      await until(() => starts === 1)
    }
    held.resolve(source.index)
    await settled()
    expect(store.collections.branches.has("branch-saved")).toBe(false)
    if (ending !== "new-chat") expect(replays).toBe(0)
    await controller.dispose()
  }
})

const realOrigin = process.env.SMITHERS_ACCOUNT_HISTORY_ORIGIN
;(realOrigin ? test : test.skip)(
  "real PostgreSQL server client B hydrates a completely empty browser journal",
  async () => {
    const store = await open()
    await identify(store, process.env.SMITHERS_ACCOUNT_HISTORY_OWNER ?? "alice")
    const seen: string[] = []
    const agent = createWebAgent({
      baseUrl: realOrigin,
      fetchImpl: async (input, init) => {
        seen.push(String(input))
        return fetch(input, init)
      }
    })
    createAppController(store, agent, { bootstrap: cloud, fetchImpl: unrelated })
    await until(() => [...store.collections.messages.values()].some((row) => row.text === "deterministic"))
    expect([...store.collections.messages.values()].some((row) => row.text === "hello from A")).toBe(true)
    expect(store.collections.httpTurns.size).toBe(0)
    expect(store.collections.httpTurnLegs.size).toBe(0)
    expect(store.session().phase).toBe("idle")
    expect(seen.length).toBe(2)
    expect(seen.every((url) => url.includes("/api/agent/conversations"))).toBe(true)
    expect((await store.verifyState()).valid).toBe(true)
  }
)

test("late restoration preserves unrelated user actions, queued input and compacted intent uncertainty", () => {
  const initial = signed()
  const themed = step(initial, { type: "theme.changed", actor: "user", theme: "dark" })
  expect(step(themed, restore())).toBe(themed)
  const drafting = step(initial, { type: "composer.changed", actor: "user", draft: "Keep typing" })
  expect(step(drafting, restore())).toBe(drafting)
  expect(historyHasNewerUserIntent([{ revision: 2, actor: "system" }, { revision: 3, actor: "system" }], 1)).toBe(false)
  expect(historyHasNewerUserIntent([{ revision: 3, actor: "system" }], 1)).toBe(true)
  expect(historyHasNewerUserIntent([], 1)).toBe(false)
})

test("an unresolved account read cannot erase a card created by an unrelated slash action", async () => {
  const store = await open()
  await identify(store)
  const source = responses(), held = Promise.withResolvers<AgentConversationPage>()
  let reads = 0
  const controller = createAppController(store, {
    ...silentAgent,
    history: {
      list: () => held.promise,
      replay: async () => {
        reads++
        return source.replay
      }
    }
  }, { bootstrap: cloud, fetchImpl: unrelated })
  expect((await controller.commands.run("account.show")).status).toBe("executed")
  const before = [...store.collections.cards.values()].map((row) => row.id)
  expect(before.length).toBeGreaterThan(0)
  held.resolve(source.index)
  await settled()
  expect(store.collections.branches.has("branch-saved")).toBe(false)
  expect([...store.collections.cards.values()].map((row) => row.id)).toEqual(before)
  await controller.dispose()
})

test("paginated conversations and replay prefixes are assembled once, then navigable by the original frame URL", async () => {
  const store = await open()
  await identify(store)
  const first = saved(), second = saved("branch-second", "second"), initial = first.legs[0]!.initial
  const one = batch(initial, [{ type: "delta", runId: "turn", kind: "text", text: "Saved " }]),
    two = batch(next(one), [{ type: "delta", runId: "turn", kind: "text", text: "answer" }, {
      type: "done",
      runId: "turn",
      reason: "stop"
    }])
  first.legs[0]!.batches = [one, two]
  first.legs[0]!.head = next(two)
  const a = responses(first), b = responses(second), accesses: unknown[] = [], pages: unknown[] = []
  const location = { workspaceId: "workspace-main", branchId: "branch-saved", frameId: rootFrameId("branch-saved") }
  let current = location
  createAppController(store, {
    ...silentAgent,
    history: {
      list: async (after) => {
        pages.push(after)
        return after === undefined ? { ...a.index, next: "next-page" } : b.index
      },
      replay: async (access) => {
        accesses.push(access)
        if (access.runId === "second") return b.replay
        return {
          ...a.replay,
          page: access.after === undefined ?
            {
              status: "ok",
              after: initial,
              next: next(one),
              head: next(two),
              terminal: true,
              more: true,
              batches: [one]
            }
            : {
              status: "ok",
              after: next(one),
              next: next(two),
              head: next(two),
              terminal: true,
              more: false,
              batches: [two]
            }
        }
      }
    }
  }, {
    bootstrap: cloud,
    fetchImpl: unrelated,
    frameHistory: {
      current: () => current,
      replace: (value) => {
        current = value
      },
      push: (value) => {
        current = value
      },
      back: () => {},
      forward: () => {},
      subscribe: () => () => {}
    }
  })
  await until(() => store.collections.messages.get("message-turn-smithers")?.text === "Saved answer")
  expect(pages).toEqual([undefined, "next-page"])
  expect(accesses).toEqual([{ runId: "turn", legId: "leg" }, { runId: "turn", legId: "leg", after: next(one) }, {
    runId: "second",
    legId: "leg"
  }])
  expect(store.session().activeBranchId).toBe("branch-saved")
  expect(current).toEqual(location)
})

for (
  const broken of [
    "duplicate-index",
    "repeated-next",
    "wrong-conversation",
    "no-progress",
    "changed-prompt",
    "bad-bytes",
    "empty-advances",
    "tampered-first-page"
  ] as const
) {
  test(`account history refuses ${broken} visibly before hydration`, async () => {
    const store = await open()
    await identify(store)
    const source = responses()
    let reads = 0, lists = 0
    const controller = createAppController(store, {
      ...silentAgent,
      history: {
        list: async () => {
          lists++
          return broken === "duplicate-index" ?
            { ...source.index, conversations: [...source.index.conversations, ...source.index.conversations] }
            : broken === "repeated-next"
            ? { ...source.index, conversations: lists === 1 ? source.index.conversations : [], next: "same-page" }
            : source.index
        },
        replay: async () => {
          reads++
          if (broken === "wrong-conversation") return { ...source.replay, conversationId: "different" }
          if (broken === "no-progress") {
            return {
              ...source.replay,
              page: {
                ...source.replay.page,
                status: "ok",
                after: cursor(),
                next: cursor(),
                head: cursor(),
                more: true,
                batches: []
              }
            }
          }
          if (broken === "changed-prompt" || broken === "empty-advances" || broken === "tampered-first-page") {
            const one = batch(cursor(), [{ type: "delta", runId: "turn", kind: "text", text: "one" }]),
              two = batch(next(one), [{ type: "done", runId: "turn", reason: "stop" }])
            if (broken === "tampered-first-page") one.hash = "b".repeat(64)
            return {
              ...source.replay,
              userText: reads === 1 ? "before" : "after",
              page: {
                status: "ok",
                after: reads === 1 ? cursor() : next(one),
                next: reads === 1 ? next(one) : next(two),
                head: next(two),
                terminal: true,
                more: reads === 1,
                batches: broken === "empty-advances" ? [] : reads === 1 ? [one] : [two]
              }
            }
          }
          if (broken === "bad-bytes") {
            const reply = structuredClone(source.replay)
            if (reply.page.status === "ok") reply.page.batches[0]!.hash = "b".repeat(64)
            return reply
          }
          return source.replay
        }
      }
    }, { bootstrap: cloud, fetchImpl: unrelated })
    await until(() => [...store.collections.toasts.values()].some((row) => row.status === "failed"))
    expect(store.collections.branches.has("branch-saved")).toBe(false)
    expect(store.collections.messages.get("message-turn-smithers")).toBeUndefined()
    expect(reads).toBe(
      broken === "duplicate-index" || broken === "repeated-next" ? 0 : broken === "changed-prompt" ? 2 : 1
    )
    await controller.dispose()
  })
}

test("saved continuation steering uses the same visible user bubble and claim controls", () => {
  const conversation = saved(), first = conversation.legs[0]!
  const one = batch(first.initial, [{ type: "delta", runId: "turn", kind: "text", text: "Initial" }, {
    type: "tool_call",
    runId: "turn",
    name: "commands",
    call_id: "call",
    arguments: "{}"
  }, { type: "done", runId: "turn", reason: "tool_call" }])
  first.batches = [one]
  first.head = next(one)
  const initial = cursor("turn", "next"),
    two = batch(initial, [{ type: "delta", runId: "turn", kind: "text", text: " revised" }, {
      type: "done",
      runId: "turn",
      reason: "stop"
    }])
  conversation.legs.push({
    ...first,
    legId: "next",
    initial,
    head: next(two),
    batches: [two],
    userText: "Change the answer"
  })
  const restored = step(signed(), restore([conversation]))
  expect(restored.messages.filter((row) => row.role === "user").map((row) => row.text)).toEqual([
    "Saved question",
    "Change the answer"
  ])
  expect(restored.messages.find((row) => row.id === "message-turn-smithers")?.text).toBe("Initial revised")
  const email = saved()
  email.legs[0]!.userText = "Send an email to Pat"
  const claim = batch(email.legs[0]!.initial, [{
    type: "delta",
    runId: "turn",
    kind: "text",
    text: "I can send an email."
  }, { type: "done", runId: "turn", reason: "stop" }])
  email.legs[0]!.batches = [claim]
  email.legs[0]!.head = next(claim)
  expect(step(signed(), restore([email])).messages.find((row) => row.id === "message-turn-smithers")?.text).toContain(
    "I can't send or draft email yet"
  )
})
