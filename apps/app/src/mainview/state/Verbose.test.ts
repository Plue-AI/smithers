/*
 * /verbose — the maintainer's view of everything Smithers does.
 *
 * On, every flow invocation (listed or hidden, user or agent, deferred or
 * settled) and every non-user transition renders as a trace line in the
 * transcript, and the transition logger writes to the console. Off, the
 * transcript reads exactly as it would have without the switch.
 */
import { createCommandRegistry } from "../flows/Commands"
import type { CommandActions } from "../flows/Flows"
import { afterEach, describe, expect, test } from "bun:test"
import { scopedControllers } from "./ControllerTestScope"
import { createAppStore, TRACE_MESSAGE_PREFIX, VERBOSE_OFF_TEXT, VERBOSE_ON_TEXT, verboseTrace } from "./AppStore"
import { memoryStorage, unavailableAgent } from "./TestFixtures"

const createAppController = scopedControllers()

const fresh = async () => {
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  return { store, controller: createAppController(store, unavailableAgent) }
}

const traces = (store: Awaited<ReturnType<typeof fresh>>["store"]): Array<string> =>
  [...store.collections.messages.values()]
    .filter((message) => message.id.startsWith(TRACE_MESSAGE_PREFIX))
    .sort((left, right) => left.ordinal - right.ordinal)
    .map((message) => message.act ?? "")

const originalDebug = console.debug
afterEach(() => {
  console.debug = originalDebug
})

describe("/verbose", () => {
  test("registers for every session as a listed, model-invocable flow", async () => {
    const { controller } = await fresh()
    const entry = controller.commands.find("debug.verbose")
    expect(entry).toBeDefined()
    expect(entry?.metadata.hidden).not.toBe(true)
    expect(entry?.binding.descriptor.modelInvocable).toBe(true)
    expect(controller.slashItems("verb").map((item) => item.flow.name)).toContain("debug.verbose")
  })

  test("toggles the session flag and states it in the transcript", async () => {
    const { store, controller } = await fresh()
    expect(store.session().verbose).toBe(false)
    expect((await controller.commands.run("debug.verbose")).status).toBe("executed")
    expect(store.session().verbose).toBe(true)
    const texts = [...store.collections.messages.values()].map((message) => message.text)
    expect(texts).toContain(VERBOSE_ON_TEXT)
    expect((await controller.commands.run("debug.verbose")).status).toBe("executed")
    expect(store.session().verbose).toBe(false)
    expect([...store.collections.messages.values()].map((message) => message.text)).toContain(VERBOSE_OFF_TEXT)
  })

  test("a hidden flow leaves a trace line only while verbose is on", async () => {
    const { store, controller } = await fresh()
    // When verbosity is off, a hidden presentation action leaves no line.
    await controller.commands.run("card.minimize")
    expect(traces(store)).toEqual([])
    const before = [...store.collections.messages.values()].length

    await controller.commands.run("debug.verbose")
    await controller.commands.run("card.minimize")
    const lines = traces(store)
    expect(lines.some((line) => line.startsWith("You ran /card.minimize [hidden] → executed"))).toBe(true)
    // Every act is recorded as a transition whether or not it is rendered.
    const invoked = [...store.collections.transitions.values()].filter((record) => record.type === "flow.invoked")
    expect(invoked.length).toBeGreaterThanOrEqual(2)

    await controller.commands.run("debug.verbose")
    // Off removes every trace line; the on/off statements are the only additions.
    expect(traces(store)).toEqual([])
    expect([...store.collections.messages.values()].length).toBe(before + 2)
  })

  test("an unknown name and a failed flow trace their outcome", async () => {
    const { store, controller } = await fresh()
    await controller.commands.run("debug.verbose")
    await controller.commands.run("no.such.flow")
    await controller.commands.run("card.maximize", "missing-card")
    const lines = traces(store)
    expect(lines.some((line) => line.startsWith("You ran /no.such.flow → unknown-command"))).toBe(true)
    expect(lines.some((line) => line.startsWith("You ran /card.maximize missing-card [hidden] → failed ("))).toBe(true)
  })

  test("agent invocations trace as Smithers", async () => {
    const { store, controller } = await fresh()
    await controller.commands.run("debug.verbose")
    await controller.commands.runForAgent("wiki")
    expect(traces(store).some((line) => line.startsWith("Smithers ran /wiki → executed"))).toBe(true)
  })

  test("background and system transitions trace; keystrokes and deltas never do", async () => {
    const { store, controller } = await fresh()
    await controller.commands.run("debug.verbose")
    store.dispatch({ type: "toast.shown", actor: "system", key: "toast-1", title: "Working…" })
    controller.changeDraft("hello")
    const lines = traces(store)
    expect(lines.some((line) => line.startsWith("system: toast.shown"))).toBe(true)
    expect(lines.some((line) => line.includes("composer.changed"))).toBe(false)
    expect(verboseTrace({ type: "composer.changed", actor: "user", draft: "x" })).toBeUndefined()
    expect(verboseTrace({ type: "message.response.delta", actor: "smithers", turnId: "t", channel: "text", delta: "x" })).toBeUndefined()
  })

  test("the logger writes every trace to the console only while on", async () => {
    const { store, controller } = await fresh()
    const logged: Array<string> = []
    console.debug = (...args: Array<unknown>) => {
      logged.push(String(args[0]))
    }
    await controller.commands.run("appearance.dark-mode")
    await store.settled?.()
    expect(logged).toEqual([])
    await controller.commands.run("debug.verbose")
    await store.settled?.()
    await controller.commands.run("appearance.dark-mode")
    await store.settled?.()
    expect(logged.some((line) => line.includes("ran /appearance.dark-mode"))).toBe(true)
    const count = logged.length
    await controller.commands.run("debug.verbose")
    await store.settled?.()
    await controller.commands.run("appearance.dark-mode")
    await store.settled?.()
    expect(logged.length).toBe(count)
  })
})

describe("sensitive flow traces", () => {
  for (const verbose of [false, true]) {
    for (const fails of [false, true]) {
      test(`env.set redacts persisted and console diagnostics (verbose=${verbose}, fails=${fails})`, async () => {
        const secret = "review-synthetic-secret-9c814"
        const assignment = `DATABASE_PASSWORD=${secret}`
        const persisted = new Map<string, string>()
        const store = await createAppStore({ kind: "localStorage", storage: {
          getItem: (key) => persisted.get(key) ?? null,
          setItem: (key, value) => { persisted.set(key, value) },
          removeItem: (key) => { persisted.delete(key) }
        } })
        if (verbose) await store.dispatch({ type: "verbose.toggled", actor: "user", on: true }).isPersisted.promise
        const logged: unknown[][] = []
        console.debug = (...args) => { logged.push(args) }
        const writes: Promise<unknown>[] = []
        const received: string[] = []
        const actions = {
          repositoryFlows: () => undefined,
          knownRepositories: () => new Set(["owner/repo"]),
          snapshot: () => ({ surface: "chat", typing: false, hasConnectors: true, admin: false, signedOut: false }),
          noteCommandRun: () => {},
          traceFlow: (record) => { writes.push(store.dispatch(record).isPersisted.promise) },
          setEnvironmentVar: async (value, repo) => {
            received.push(value)
            expect(repo).toBe("owner/repo")
            // A seam may echo input in its error detail.
            if (fails) return `Could not save ${value}`
          }
        } satisfies Partial<CommandActions>
        const commands = createCommandRegistry(actions as unknown as CommandActions)
        const outcome = await commands.run("env.set", `${assignment} owner/repo`)
        await Promise.all(writes)
        expect(outcome.status).toBe(fails ? "failed" : "executed")
        expect(received).toEqual([assignment])
        const rows = [...store.collections.transitions.values()].filter((row) => row.type === "flow.invoked")
        expect(rows).toHaveLength(1)
        expect(JSON.stringify(rows)).not.toContain(secret)
        expect(JSON.stringify([...persisted])).not.toContain(secret)
        const loggedBeforeReopen = logged.length
        await store.dispose?.()
        const restored = await createAppStore({ kind: "localStorage", storage: {
          getItem: (key) => persisted.get(key) ?? null,
          setItem: (key, value) => { persisted.set(key, value) },
          removeItem: (key) => { persisted.delete(key) }
        } })
        expect([...restored.collections.transitions.values()].filter((row) => row.type === "flow.invoked")).toHaveLength(1)
        expect(JSON.stringify([...restored.collections.transitions.values()])).not.toContain(secret)
        expect(JSON.stringify(logged)).not.toContain(secret)
        expect(logged.length).toBe(loggedBeforeReopen)
        if (verbose) {
          expect(logged.length).toBeGreaterThan(0)
          expect(traces(store).join("\n")).toContain("DATABASE_PASSWORD=[REDACTED]")
          expect(traces(store).join("\n")).not.toContain(secret)
        } else {
          expect(logged).toEqual([])
        }
      })
    }
  }
})
