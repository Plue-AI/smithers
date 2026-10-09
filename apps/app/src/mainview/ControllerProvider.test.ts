import { describe, expect, test } from "bun:test"
import { readFile } from "node:fs/promises"
import { canPaintAppBeforeIdentity, createControllerBoot, followSignIn, loadControllerBootInputs } from "./ControllerBootMemo"
import type { AppController } from "./state/AppController"

/*
 * `use(boot)` suspends on the promise it is handed, so every render and every
 * remount of AppIsland has to receive the SAME promise: a fresh promise per
 * render re-suspends forever and the app never mounts.
 */

describe("createControllerBoot", () => {
  test("every call gets the one boot, so a remount does not re-run it", async () => {
    let loads = 0
    const boot = createControllerBoot(() => {
      loads += 1
      return Promise.resolve({ tag: loads } as unknown as AppController)
    })
    const first = boot()
    expect(boot()).toBe(first)
    expect(boot()).toBe(first)
    expect(loads).toBe(1)
    expect(((await first) as unknown as { tag: number }).tag).toBe(1)
  })

  test("the boot starts on the first render, not when the module is imported", () => {
    let loads = 0
    const boot = createControllerBoot(() => {
      loads += 1
      return Promise.resolve({} as unknown as AppController)
    })
    expect(loads).toBe(0)
    boot()
    expect(loads).toBe(1)
  })

  test("a failed boot stays cached, so the error boundary sees one failure", async () => {
    let loads = 0
    const boot = createControllerBoot(() => {
      loads += 1
      return Promise.reject(new Error("boot failed"))
    })
    const first = boot()
    expect(boot()).toBe(first)
    expect(loads).toBe(1)
    await expect(first).rejects.toThrow("boot failed")
  })
})

describe("controller readiness", () => {
  test("bootstrap and persisted state load concurrently, and both are required", async () => {
    const started: string[] = []
    let finishBootstrap!: (value: string) => void
    let finishStore!: (value: { dispose: () => void }) => void
    let ready = false
    const store = { dispose: () => {} }
    const boot = loadControllerBootInputs(
      () => { started.push("bootstrap"); return new Promise<string>(resolve => { finishBootstrap = resolve }) },
      () => { started.push("store"); return new Promise<typeof store>(resolve => { finishStore = resolve }) },
    )
    void boot.then(() => { ready = true })
    expect(started).toEqual(["bootstrap", "store"])
    finishBootstrap("cloud")
    await Promise.resolve()
    expect(ready).toBe(false)
    finishStore(store)
    expect(await boot).toEqual({ bootstrap: "cloud", store })
  })

  test("failed runtime discovery closes the concurrently opened store", async () => {
    let closed = 0
    await expect(loadControllerBootInputs(
      async () => { throw new Error("runtime offline") },
      async () => ({ dispose: async () => { closed++ } }),
    )).rejects.toThrow("runtime offline")
    expect(closed).toBe(1)
  })

  test("only fresh empty public practice skips the identity paint barrier", () => {
    const fresh = { hasTranscript: false, identityState: "unknown", accountOwnerLogin: null }
    expect(canPaintAppBeforeIdentity(fresh)).toBe(true)
    for (const changed of [
      { requestedRepo: "owner/repo" },
      { hasTranscript: true }, { identityState: "signed-in" }, { accountOwnerLogin: "retained-owner" }, { identityLogin: "legacy-owner" },
    ]) expect(canPaintAppBeforeIdentity({ ...fresh, ...changed })).toBe(false)
  })
})

/*
 * `/api/live` refuses an upgrade without a signed-in person (backend
 * routes/live.go answers 401), so a channel opened for anyone else can only
 * be refused and retried. That holds on every host, the site landing's
 * island included, not only on an install.
 */
describe("the live channel follows sign-in", () => {
  const sessions = () => {
    let state: string | undefined
    const listeners = new Set<() => void>()
    return {
      get: (_id: "identity") => state === undefined ? undefined : { state },
      subscribeChanges: (listener: () => void) => { listeners.add(listener); return { unsubscribe: () => { listeners.delete(listener) } } },
      set: (next: string | undefined) => { state = next; for (const listener of [...listeners]) listener() },
      listeners
    }
  }
  const channel = () => {
    const calls: boolean[] = []
    return { calls, setEnabled: (enabled: boolean) => { calls.push(enabled) } }
  }

  test("a page with no signed-in person opens no socket", () => {
    const live = channel()
    const identity = sessions()
    followSignIn(live, identity, new AbortController().signal)
    expect(live.calls).toEqual([false])
    identity.set("signed-out")
    identity.set("unknown")
    expect(live.calls).toEqual([false, false, false])
  })

  test("signing in connects, signing out disconnects", () => {
    const live = channel()
    const identity = sessions()
    followSignIn(live, identity, new AbortController().signal)
    identity.set("signed-in")
    identity.set("signed-out")
    identity.set("signed-in")
    expect(live.calls).toEqual([false, true, false, true])
  })

  test("a remembered sign-in waits for the identity to answer before it connects", () => {
    const live = channel()
    const identity = sessions()
    identity.set("signed-in")
    followSignIn(live, identity, new AbortController().signal)
    expect(live.calls).toEqual([false])
    identity.set("signed-in")
    expect(live.calls).toEqual([false, true])
  })

  test("leaving the page disconnects and stops following", () => {
    const live = channel()
    const identity = sessions()
    const page = new AbortController()
    followSignIn(live, identity, page.signal)
    identity.set("signed-in")
    page.abort()
    expect(live.calls).toEqual([false, true, false])
    expect(identity.listeners.size).toBe(0)
    identity.set("signed-in")
    expect(live.calls).toEqual([false, true, false])
  })
})

/*
 * The app has two browser-only hosts and no server entry: main.tsx renders
 * AppIsland into `#root` for the Vite build, and apps/site renders it as an
 * Astro `client:only` island. The boot chain used to serve a TanStack Start
 * SSR entry that serialized an identity answer into the document; the entry is
 * gone, so no module may name it or carry the session it hydrated.
 */
describe("the boot chain names only the hosts that exist", () => {
  const bootModules = [
    "AppIsland.tsx",
    "ControllerBoot.client.ts",
    "ControllerBootMemo.ts",
    "ControllerProvider.tsx",
    "SessionShell.tsx",
    "StartupWatchdog.ts"
  ]

  test("no module mentions the removed Start entry or its serialized session", async () => {
    const offenders: Array<string> = []
    for (const name of bootModules) {
      const source = await readFile(`${import.meta.dir}/${name}`, "utf8")
      if (/routes\/__root|Start entry|Start document|ClientOnly|react-start|BootSession/.test(source)) {
        offenders.push(name)
      }
    }
    expect(offenders).toEqual([])
  })
})
