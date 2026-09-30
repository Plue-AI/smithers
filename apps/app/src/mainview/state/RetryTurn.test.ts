import type { AgentTurnFrame,StartAgentTurnRequest,StartAgentTurnResult } from "@smthrs/rpc/NativeAgent"
import { describe,expect,spyOn,test } from "bun:test"
import type { AgentPort } from "../runtime/AgentPort"
import type { AppStore } from "./AppStore"
import { createAppStore } from "./AppStore"
import { scopedControllers } from "./ControllerTestScope"
import { memoryStorage, settled } from "./TestFixtures"

const createAppController = scopedControllers()

/*
 * /retry re-RUNS the last turn. Re-SENDING the prompt appended a second user
 * bubble per attempt, so the transcript grew a duplicate pair every time and
 * each retry shipped a longer history than the one before it.
 */

/** An agent that records every leg it is asked to run and ends turns on demand. */
const recordingAgent = (overrides: Partial<AgentPort> = {}) => {
  const launches: StartAgentTurnRequest[] = []
  const listeners = new Set<(frame: AgentTurnFrame) => void>()
  const agent: AgentPort = {
    available: true,
    startTurn: async (request) => {
      launches.push(request)
      return overrides.startTurn?.(request) ?? { status: "started" }
    },
    cancelTurn: overrides.cancelTurn ?? (async () => {}),
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    }
  }
  const emit = (frame: AgentTurnFrame) => {
    for (const listener of listeners) listener(frame)
  }
  return {
    agent,
    launches,
    emit,
    fail: (runId: string, error: string) => emit({ runId, type: "done", error }),
    answer: (runId: string, text: string) => {
      emit({ runId, type: "delta", kind: "text", text })
      emit({ runId, type: "done", reason: "stop" })
    }
  }
}

const signedInStore = async (): Promise<AppStore> => {
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  store.dispatch({
    type: "identity.session.loaded",
    actor: "system",
    state: "signed-in",
    login: "will",
    admin: false,
    scopesPlain: null
  })
  return store
}

const userBubbles = (store: AppStore, text: string) =>
  [...store.collections.messages.values()].filter(
    (message) => message.role === "user" && message.text === text
  )

describe("/retry re-runs the last turn", () => {
  test("the user message is never duplicated, however many times retry runs", async () => {
    const store = await signedInStore()
    const { agent, launches, fail } = recordingAgent()
    const controller = createAppController(store, agent, {
      fetchImpl: async () => new Response("{}", { status: 200 })
    })
    controller.send("Reply with one random uncommon English noun, nothing else.")
    await settled()
    const turnId = launches[0]?.runId
    expect(turnId).toBeDefined()
    fail(turnId as string, "the upstream fell over")
    await settled()

    await controller.commands.run("chat.retry")
    await settled()
    expect(userBubbles(store, "Reply with one random uncommon English noun, nothing else.").length).toBe(1)

    fail(turnId as string, "again")
    await settled()
    await controller.commands.run("chat.retry")
    await settled()
    expect(userBubbles(store, "Reply with one random uncommon English noun, nothing else.").length).toBe(1)
    // Three legs: the original send plus two re-runs, all on the same turn.
    expect(launches.length).toBe(3)
    expect(launches.every((launch) => launch.runId === turnId)).toBe(true)
  })

  for (const practice of [false, true]) test(`the failed answer makes way for the re-run in ${practice ? "a retained legacy selection" : "the workspace"}`, async () => {
    const store = await signedInStore()
    const { agent, launches, fail } = recordingAgent()
    const controller = createAppController(store, agent, {
      fetchImpl: async () => new Response("{}", { status: 200 })
    })
    if (practice) await controller.selectRepo("practice:smithersai/hello-server")
    controller.send("what is my balance?")
    await settled()
    const turnId = launches[0]?.runId as string
    fail(turnId, "the upstream fell over")
    await settled()
    expect(store.collections.messages.get(`message-${turnId}-smithers`)).toBeDefined()

    await controller.commands.run("chat.retry")
    await settled()
    expect(store.collections.messages.get(`message-${turnId}-smithers`)).toBeUndefined()
    const retried = launches[1]
    expect(JSON.stringify(retried?.messages)).not.toContain("practice:smithersai/hello-server")
    expect(
      retried?.messages.map((message) => ("content" in message ? message.content : message.type))
    ).toEqual(["what is my balance?"])
  })

  test("retry with nothing to retry refuses by name instead of executing silently", async () => {
    const store = await signedInStore()
    const { agent, launches } = recordingAgent()
    const controller = createAppController(store, agent, {
      fetchImpl: async () => new Response("{}", { status: 200 })
    })
    const outcome = await controller.commands.run("chat.retry")
    expect(outcome).toEqual({ status: "failed", error: "Nothing to retry yet — send a message first." })
    expect(launches.length).toBe(0)
  })

  test("retry mid-turn does nothing — there is nothing settled to re-run", async () => {
    const store = await signedInStore()
    const { agent, launches } = recordingAgent()
    const controller = createAppController(store, agent, {
      fetchImpl: async () => new Response("{}", { status: 200 })
    })
    controller.send("still running")
    await settled()
    expect(store.session().phase).toBe("responding")
    const outcome = await controller.commands.run("chat.retry")
    await settled()
    expect(launches.length).toBe(1)
    expect(outcome.status).toBe("failed")
  })
})

const deferred = <T,>() => {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((done, failed) => { resolve = done; reject = failed })
  return { promise, resolve, reject }
}

describe("turn continuation ownership", () => {
  test("Stop mid-tool then retry ignores the old tool completion", async () => {
    const store = await signedInStore()
    const { agent, launches, emit, answer } = recordingAgent({
      startTurn: async () => launches.length > 2
        ? { status: "error", message: "That Smithers turn is already running." }
        : { status: "started" }
    })
    const controller = createAppController(store, agent)
    const tool = deferred<string>()
    const execute = spyOn(controller.commands, "executeForAgent").mockImplementation(() => tool.promise)
    try {
      controller.send("read the page")
      const runId = launches[0]!.runId
      emit({ runId, type: "tool_call", call_id: "old-call", name: "commands", arguments: "{}" })
      emit({ runId, type: "done", reason: "tool_call" })
      expect(execute).toHaveBeenCalledTimes(1)
      controller.stop()
      await controller.commands.run("chat.retry")
      await settled()
      expect(launches).toHaveLength(2)
      tool.resolve("executed /browser")
      await settled()
      expect(launches).toHaveLength(2)
      expect(store.collections.toolCalls.size).toBe(0)
      expect([...store.collections.messages.values()].some((message) => message.act !== undefined)).toBe(false)
      expect(store.session().phase).toBe("responding")
      answer(runId, "fresh answer")
      expect(store.collections.messages.get(`message-${runId}-smithers`)?.text).toBe("fresh answer")
    } finally {
      execute.mockRestore()
      await controller.dispose()
    }
  })

  test("retry immediately after Stop waits for cancellation and ignores its terminal frame", async () => {
    const store = await signedInStore()
    const cancellation = deferred<void>()
    let cancelling = false
    const { agent, launches, emit, answer } = recordingAgent({
      cancelTurn: () => { cancelling = true; return cancellation.promise },
      startTurn: async () => cancelling
        ? { status: "error", message: "That Smithers turn is already running." }
        : { status: "started" }
    })
    const controller = createAppController(store, agent)
    try {
      controller.send("keep going")
      const runId = launches[0]!.runId
      controller.stop()
      await controller.commands.run("chat.retry")
      await settled()
      expect(launches).toHaveLength(1)
      emit({ runId, type: "done", reason: "cancelled" })
      cancelling = false
      cancellation.resolve()
      await settled()
      expect(launches).toHaveLength(2)
      expect(launches[1]!.runId).toBe(runId)
      expect(store.session().phase).toBe("responding")
      answer(runId, "retried successfully")
      expect(store.collections.messages.get(`message-${runId}-smithers`)?.text).toBe("retried successfully")
    } finally {
      await controller.dispose()
    }
  })

  for (const action of ["stop", "reset"] as const) {
    test(`${action} discards a retry waiting for cancellation`, async () => {
      const store = await signedInStore()
      const cancellation = deferred<void>()
      const { agent, launches, answer } = recordingAgent({ cancelTurn: () => cancellation.promise })
      const controller = createAppController(store, agent)
      try {
        controller.send("original question")
        controller.stop()
        await controller.commands.run("chat.retry")
        controller[action]()
        controller.send("replacement question")
        const replacement = launches.at(-1)!.runId
        cancellation.resolve()
        await settled()
        expect(launches).toHaveLength(2)
        expect(store.session().phase).toBe("responding")
        answer(replacement, "replacement answer")
        expect(store.collections.messages.get(`message-${replacement}-smithers`)?.text).toBe("replacement answer")
      } finally {
        await controller.dispose()
      }
    })
  }

  for (const failure of ["resolved", "rejected"] as const) {
    test(`a late ${failure} launch error cannot fail a same-id retry`, async () => {
      const store = await signedInStore()
      const original = deferred<StartAgentTurnResult>()
      const { agent, launches, answer } = recordingAgent({
        startTurn: async () => launches.length === 1 ? original.promise : { status: "started" }
      })
      const controller = createAppController(store, agent)
      try {
        controller.send("first attempt")
        const runId = launches[0]!.runId
        controller.stop()
        await controller.commands.run("chat.retry")
        await settled()
        expect(launches).toHaveLength(2)
        if (failure === "resolved") original.resolve({ status: "error", message: "old launch failed" })
        else original.reject(new Error("old launch failed"))
        await settled()
        expect(store.session().phase).toBe("responding")
        answer(runId, "retry survived")
        expect(store.collections.messages.get(`message-${runId}-smithers`)?.text).toBe("retry survived")
      } finally {
        await controller.dispose()
      }
    })

  }
})

test("a non-admission submit whose durable write fails cancels its launched turn", async () => {
  const durable = memoryStorage()
  let rejectSubmit = false
  const store = await createAppStore({ kind: "localStorage", storage: { ...durable, setItem(key, value) {
    if (rejectSubmit && value.includes("unsaved prompt")) { rejectSubmit = false; throw Error("disk unavailable") }
    durable.setItem(key, value)
  } } })
  await store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-in", login: "will", admin: false, scopesPlain: null }).isPersisted.promise
  const cancelled: string[] = []
  const remote = recordingAgent({ cancelTurn: async id => { cancelled.push(id) } })
  const controller = createAppController(store, remote.agent)
  try {
    rejectSubmit = true
    await expect(Promise.resolve(controller.send("unsaved prompt"))).rejects.toThrow("disk unavailable")
    await settled()
    expect(remote.launches).toHaveLength(1)
    expect(cancelled).toContain(remote.launches[0]!.runId)
  } finally { await controller.dispose(); await store.dispose?.() }
})
