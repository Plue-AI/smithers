import type { AgentTurnFrame } from "@smthrs/rpc/NativeAgent"
import { describe, expect, test } from "bun:test"
import type { AgentPort } from "../runtime/AgentPort"
import { createAppController } from "./AppController"
import { createAppStore } from "./AppStore"
import { createControllerContext } from "./controller/context"
import { createFailureController } from "./controller/failures"
import { ENVELOPE_STORAGE_KEY } from "../chain/TransactionalStorage"
import { memoryStorage } from "./TestFixtures"

/*
 * Ruling B (docs/persistence.md): everything a controller opens is released
 * when its scope closes. Before the disposal scope the agent subscription's
 * unsubscribe was discarded, and the cross-tab identity listeners and
 * BroadcastChannel leaked for the page lifetime.
 */

const countingAgent = (): { agent: AgentPort; listeners: Set<(frame: AgentTurnFrame) => void> } => {
  const listeners = new Set<(frame: AgentTurnFrame) => void>()
  return {
    listeners,
    agent: {
      available: true,
      startTurn: async () => ({ status: "error", message: "unused" }),
      cancelTurn: async () => {},
      subscribe: (listener) => {
        listeners.add(listener)
        return () => {
          listeners.delete(listener)
        }
      }
    }
  }
}

describe("disposing a controller releases what it opened", () => {
  test("toast timers and late work cannot write after their owner closes", async () => {
    const storage = memoryStorage()
    const store = await createAppStore({ kind: "localStorage", storage })
    const { agent } = countingAgent()
    const context = createControllerContext(store, agent, { toastDebounceMs: 20, toastAutoDismissMs: 20 })
    const failures = createFailureController(context)
    await store.dispatch({ type: "toast.shown", actor: "system", key: "done", title: "Finished" }).isPersisted.promise
    failures.resolveToast("done", { status: "ok", detail: "" })
    let release!: (value: boolean) => void
    const pending = failures.withToast("late", "Waiting…", "Finished", () => new Promise<boolean>(resolve => { release = resolve }))
    await context.dispose()
    const closedBytes = storage.getItem(ENVELOPE_STORAGE_KEY)
    await new Promise(resolve => setTimeout(resolve, 40))
    release(true)
    expect(await pending).toBe(true)
    expect(storage.getItem(ENVELOPE_STORAGE_KEY)).toBe(closedBytes)
    expect(context.toastRuns.size).toBe(0)
  })

  test("scope finalizers release in reverse acquisition order and a failure cannot skip later releases", async () => {
    const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
    const { agent } = countingAgent()
    const context = createControllerContext(store, agent, {})
    const released: string[] = []
    const original = new Error("second resource close failed")
    context.onDispose(() => {
      released.push("first")
    })
    context.onDispose(() => {
      released.push("second")
      throw original
    })
    context.onDispose(() => {
      released.push("third")
    })
    let caught: unknown
    try {
      await context.dispose()
    } catch (error) {
      caught = error
    }
    expect(released).toEqual(["third", "second", "first"])
    expect(caught).toBeInstanceOf(AggregateError)
    expect((caught as AggregateError).errors).toEqual([original])
    await expect(context.dispose()).rejects.toBe(caught)
    expect(released).toHaveLength(3)
    context.onDispose(() => {
      released.push("late")
    })
    expect(released).toEqual(["third", "second", "first", "late"])
  })

  test("a failing agent unsubscribe cannot strand persistence and both failures are reported", async () => {
    const released: string[] = []
    const store = {
      ...(await createAppStore({ kind: "localStorage", storage: memoryStorage() })),
      dispose: () => {
        released.push("store")
        throw new Error("store close failed")
      }
    }
    const { agent, listeners } = countingAgent()
    const controller = createAppController(store, {
      ...agent,
      subscribe: (listener) => {
        const unsubscribe = agent.subscribe(listener)
        return () => {
          unsubscribe?.()
          released.push("agent")
          throw new Error("agent unsubscribe failed")
        }
      }
    })
    expect(listeners.size).toBe(1)
    await expect(controller.dispose()).rejects.toThrow(AggregateError)
    expect(released).toEqual(["agent", "store"])
    expect(listeners.size).toBe(0)
    await expect(controller.dispose()).rejects.toThrow(AggregateError)
  })

  test("the persistence resource is released with the controller scope", async () => {
    let releases = 0
    const store = {
      ...(await createAppStore({ kind: "localStorage", storage: memoryStorage() })),
      dispose: () => {
        releases += 1
      }
    }
    const { agent } = countingAgent()
    const controller = createAppController(store, agent)
    await controller.dispose()
    await controller.dispose()
    expect(releases).toBe(1)
  })

  test("the agent subscription is unsubscribed", async () => {
    const { agent, listeners } = countingAgent()
    const controller = createAppController(
      await createAppStore({ kind: "localStorage", storage: memoryStorage() }),
      agent
    )
    expect(listeners.size).toBe(1)
    await controller.dispose()
    expect(listeners.size).toBe(0)
  })

  test("dispose is idempotent", async () => {
    const { agent, listeners } = countingAgent()
    const controller = createAppController(
      await createAppStore({ kind: "localStorage", storage: memoryStorage() }),
      agent
    )
    await controller.dispose()
    await controller.dispose()
    expect(listeners.size).toBe(0)
  })

  test("the cross-tab identity listeners are released", async () => {
    // watchIdentityAcrossTabs only opens its host resources in a DOM, so
    // this journey registers one.
    const { GlobalRegistrator } = await import("@happy-dom/global-registrator")
    GlobalRegistrator.register()
    try {
      let sessionReads = 0
      const { agent } = countingAgent()
      const controller = createAppController(
        await createAppStore({ kind: "localStorage", storage: memoryStorage() }),
        agent,
        {
          applicationIdentity: { current: async () => { sessionReads += 1; return null } },
          fetchImpl: () => {
            return Promise.resolve(
              new Response(JSON.stringify({ status: "signed-out" }), {
                status: 200,
                headers: { "content-type": "application/json" }
              })
            )
          }
        }
      )
      const settled = () => new Promise((resolve) => setTimeout(resolve, 0))
      window.dispatchEvent(new window.Event("focus"))
      await settled()
      await settled()
      const readsAfterFocus = sessionReads
      expect(readsAfterFocus).toBeGreaterThan(0)
      await controller.dispose()
      window.dispatchEvent(new window.Event("focus"))
      await settled()
      await settled()
      expect(sessionReads).toBe(readsAfterFocus)
    } finally {
      GlobalRegistrator.unregister()
    }
  })
})
