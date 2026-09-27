import { createOperationalFailureReporter } from "../OperationalFailures"
import type { StorageApi } from "@tanstack/db"
import { afterEach,describe,expect,test } from "bun:test"
import { createAppStore } from "../AppStore"
import type { ControllerContext } from "./context"
import { TOAST_CANCELLED, createFailureController,humanCommandText } from "./failures"

/*
 * The toast run counter used to be write-only: every withToast set an entry
 * and nothing ever removed one, so the map grew for the session's lifetime.
 * Settling deletes the entry equality-guarded — a newer run of the same key
 * keeps its own slot untouched — and the ok toast's later self-dismissal is
 * guarded by the toast's own state, never by the counter.
 */

const memoryStorage = (): StorageApi => {
  const data = new Map<string, string>()
  return {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => void data.set(key, value),
    removeItem: (key) => void data.delete(key)
  }
}

const disposeContexts = new Set<() => Promise<void>>()
afterEach(async () => {
  for (const dispose of disposeContexts) await dispose()
  disposeContexts.clear()
})

const fakeContext = async (options?: {
  readonly toastDebounceMs?: number
  readonly toastAutoDismissMs?: number
}): Promise<{
  ctx: ControllerContext
  store: Awaited<ReturnType<typeof createAppStore>>
  /** The controller's own teardown, without the store's: a disposed controller still has rows to read. */
  disposeController: () => void
}> => {
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  let disposed = false
  const cleanups: Array<() => void> = []
  const ctx = { failures: createOperationalFailureReporter(),
    store,
    get disposed() { return disposed },
    onDispose: (cleanup: () => void) => { cleanups.push(cleanup) },
    toastRuns: new Map<string, number>(),
    toastDebounceMs: options?.toastDebounceMs ?? 0,
    toastAutoDismissMs: options?.toastAutoDismissMs ?? 0,
    commands: { find: (name: string) => {
      const summary = ({ "auth.sign-in": "Sign in with GitHub", "prs.list": "Read pull requests" } as Record<string, string>)[name]
      return summary ? { metadata: { summary } } : undefined
    } },
    unref: () => {}
  } as unknown as ControllerContext
  const disposeController = (): void => {
    disposed = true
    for (const cleanup of cleanups) cleanup()
  }
  disposeContexts.add(async () => {
    disposeController()
    await store.dispose?.()
  })
  return { ctx, store, disposeController }
}

const settled = () => new Promise((resolve) => setTimeout(resolve, 0))

test("human command references leave diagnostic URLs and file paths intact", async () => {
  const { ctx } = await fakeContext()
  expect(humanCommandText(ctx.commands, "Try /auth.sign-in. See https://host/auth.sign-in and /api/auth.sign-in for details."))
    .toBe("Try Sign in with GitHub. See https://host/auth.sign-in and /api/auth.sign-in for details.")
})

describe("the toast run counter's terminal cleanup", () => {
  test("an ok run's entry leaves at settle; the toast then dismisses itself on its own state", async () => {
    const { ctx, store } = await fakeContext()
    const failures = createFailureController(ctx)
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const pending = failures.withToast("flow.ok", "Working…", "Done", () => gate.then(() => true))
    await settled()
    release()
    await pending
    // Settling is the slot's terminal act: the entry is gone at once. The
    // ok toast's self-dismissal is guarded by the toast's own state
    // (resolveToast), not by the counter, so nothing stale can misfire.
    expect(ctx.toastRuns.has("flow.ok")).toBe(false)
    expect(store.collections.toasts.get("toast-flow.ok")?.status).toBe("ok")
    await settled()
    expect(store.collections.toasts.get("toast-flow.ok")).toBeUndefined()
  })

  test("a confirmed cancellation stays neutral and dismisses without claiming completion", async () => {
    const { ctx, store } = await fakeContext()
    const failures = createFailureController(ctx)
    const gate = Promise.withResolvers<typeof TOAST_CANCELLED>()
    const pending = failures.withToast("flow.cancel", "Review", "Review completed", () => gate.promise)
    await settled()
    gate.resolve(TOAST_CANCELLED)
    await pending
    expect(store.collections.toasts.get("toast-flow.cancel")).toMatchObject({ status: "cancelled", title: "Review", detail: "Cancelled" })
    expect(ctx.toastRuns.has("flow.cancel")).toBe(false)
    await settled()
    expect(store.collections.toasts.get("toast-flow.cancel")).toBeUndefined()
  })

  test("a failed run's entry leaves at settle even though its toast stays", async () => {
    const { ctx, store } = await fakeContext()
    const failures = createFailureController(ctx)
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const pending = failures.withToast("flow.bad", "Working…", "Done", () => gate.then(() => "it broke"))
    await settled()
    release()
    const outcome = await pending
    expect(outcome).toBe("it broke")
    expect(ctx.toastRuns.has("flow.bad")).toBe(false)
    // The failure toast itself still waits for the user.
    expect(store.collections.toasts.get("toast-flow.bad")?.status).toBe("failed")
  })

  test("work settled before the debounce leaves no entry behind", async () => {
    const { ctx, store } = await fakeContext({ toastDebounceMs: 10_000 })
    const failures = createFailureController(ctx)
    await failures.withToast("flow.quick", "Working…", "Done", async () => true)
    expect(store.collections.toasts.size).toBe(0)
    expect(ctx.toastRuns.has("flow.quick")).toBe(false)
  })

  test("a superseding run keeps its own slot when the stale run settles", async () => {
    const { ctx } = await fakeContext({ toastAutoDismissMs: 10_000 })
    const failures = createFailureController(ctx)
    let releaseStale!: () => void
    let releaseCurrent!: () => void
    const staleGate = new Promise<void>((resolve) => {
      releaseStale = resolve
    })
    const currentGate = new Promise<void>((resolve) => {
      releaseCurrent = resolve
    })
    const stale = failures.withToast("flow.race", "Working…", "Done", () => staleGate.then(() => "stale line"))
    const current = failures.withToast("flow.race", "Working…", "Done", () => currentGate.then(() => true))
    await settled()
    releaseStale()
    await stale
    // The current run owns the slot; the stale run settled without touching it.
    expect(ctx.toastRuns.get("flow.race")).toBe(2)
    releaseCurrent()
    await current
    // The current run's settle is the slot's terminal act.
    expect(ctx.toastRuns.has("flow.race")).toBe(false)
  })
})

/*
 * Work the user never asked for has no result they can see, so it says
 * nothing until it fails: no running notice, no done title, and no claim on
 * the key's slot — the run a user did ask for keeps its notice and states
 * its own result. A failure it does state is temporary like every other one:
 * the next quiet run that succeeds takes it down.
 */
describe("quiet work", () => {
  const gate = () => {
    let release!: () => void
    const promise = new Promise<void>((resolve) => {
      release = resolve
    })
    return { promise, release }
  }

  test("a slow quiet run shows nothing while it runs and nothing when it lands", async () => {
    const { ctx, store } = await fakeContext()
    const failures = createFailureController(ctx)
    const work = gate()
    const pending = failures.withToast("flow.quiet", "Working…", "Done", () => work.promise.then(() => true), true)
    await settled()
    expect(store.collections.toasts.size).toBe(0)
    work.release()
    expect(await pending).toBe(true)
    await settled()
    expect(store.collections.toasts.size).toBe(0)
    expect(ctx.toastRuns.has("flow.quiet")).toBe(false)
  })

  test("a slow quiet run that fails states the failure and keeps it up", async () => {
    const { ctx, store } = await fakeContext({ toastAutoDismissMs: 10_000 })
    const failures = createFailureController(ctx)
    const work = gate()
    const pending = failures.withToast("flow.quiet", "Working…", "Done", () => work.promise.then(() => "it broke"), true)
    await settled()
    expect(store.collections.toasts.size).toBe(0)
    work.release()
    expect(await pending).toBe("it broke")
    expect(store.collections.toasts.get("toast-flow.quiet")).toMatchObject({
      title: "Working…",
      status: "failed",
      detail: "it broke"
    })
    await settled()
    expect(store.collections.toasts.get("toast-flow.quiet")?.status).toBe("failed")
  })

  test("a quiet run that throws states the same unexpected failure an announcing one does", async () => {
    const { ctx, store } = await fakeContext({ toastAutoDismissMs: 10_000 })
    const failures = createFailureController(ctx)
    const outcome = await failures.withToast("flow.quiet", "Working…", "Done", () => Promise.reject(new Error("boom")), true)
    expect(outcome).toBe("Working didn't finish — the app hit an unexpected error.")
    expect(store.collections.toasts.get("toast-flow.quiet")).toMatchObject({
      status: "failed",
      detail: "Working didn't finish — the app hit an unexpected error."
    })
  })

  test("a quiet run that fails after dispose says nothing", async () => {
    const { ctx, store, disposeController } = await fakeContext({ toastAutoDismissMs: 10_000 })
    const failures = createFailureController(ctx)
    const work = gate()
    const pending = failures.withToast("flow.quiet", "Working…", "Done", () => work.promise.then(() => "it broke"), true)
    disposeController()
    work.release()
    expect(await pending).toBe("it broke")
    expect(store.collections.toasts.size).toBe(0)
  })

  test("a quiet run that succeeds takes down the failure an earlier quiet run left", async () => {
    const { ctx, store } = await fakeContext({ toastAutoDismissMs: 10_000 })
    const failures = createFailureController(ctx)
    expect(await failures.withToast("flow.quiet", "Working…", "Done", async () => "it broke", true)).toBe("it broke")
    expect(store.collections.toasts.get("toast-flow.quiet")?.status).toBe("failed")
    expect(await failures.withToast("flow.quiet", "Working…", "Done", async () => true, true)).toBe(true)
    expect(store.collections.toasts.get("toast-flow.quiet")).toBeUndefined()
  })

  test("a quiet run that succeeds leaves the announcing run's failure alone", async () => {
    const { ctx, store } = await fakeContext({ toastAutoDismissMs: 10_000 })
    const failures = createFailureController(ctx)
    const failing = gate()
    const first = failures.withToast("flow.share", "Working…", "Done", () => failing.promise.then(() => "it broke"))
    await settled()
    failing.release()
    await first
    expect(store.collections.toasts.get("toast-flow.share")?.status).toBe("failed")
    const asked = gate()
    const announcing = failures.withToast("flow.share", "Working…", "Done", () => asked.promise.then(() => true))
    // The asked-for retry owns the key now; the quiet answer is not the
    // evidence that its failure is over.
    expect(await failures.withToast("flow.share", "Working…", "Done", async () => true, true)).toBe(true)
    expect(store.collections.toasts.get("toast-flow.share")?.status).toBe("failed")
    asked.release()
    await announcing
    expect(store.collections.toasts.get("toast-flow.share")).toMatchObject({ title: "Done", status: "ok" })
  })

  test("a quiet run answering first leaves the announcing run its notice and its result", async () => {
    const { ctx, store } = await fakeContext({ toastAutoDismissMs: 10_000 })
    const failures = createFailureController(ctx)
    const asked = gate()
    const quiet = gate()
    const announcing = failures.withToast("flow.share", "Working…", "Done", () => asked.promise.then(() => true))
    await settled()
    expect(store.collections.toasts.get("toast-flow.share")?.status).toBe("running")
    const silent = failures.withToast("flow.share", "Working…", "Done", () => quiet.promise.then(() => true), true)
    quiet.release()
    await silent
    // The quiet run neither dismissed the notice nor took the slot that says
    // who may resolve it.
    expect(store.collections.toasts.get("toast-flow.share")?.status).toBe("running")
    expect(ctx.toastRuns.get("flow.share")).toBe(1)
    asked.release()
    await announcing
    expect(store.collections.toasts.get("toast-flow.share")).toMatchObject({ title: "Done", status: "ok" })
  })

  test("a quiet run that succeeds leaves the asked-for read's confirmation standing", async () => {
    const { ctx, store } = await fakeContext({ toastAutoDismissMs: 10_000 })
    const failures = createFailureController(ctx)
    const asked = gate()
    const announcing = failures.withToast("flow.share", "Working…", "Done", () => asked.promise.then(() => true))
    await settled()
    asked.release()
    await announcing
    expect(store.collections.toasts.get("toast-flow.share")).toMatchObject({ title: "Done", status: "ok" })
    expect(await failures.withToast("flow.share", "Working…", "Done", async () => true, true)).toBe(true)
    expect(store.collections.toasts.get("toast-flow.share")).toMatchObject({ title: "Done", status: "ok" })
  })
})

/*
 * Ownership of a toast slot is an allocation question, not a counting one:
 * the number a run holds must never be handed back out while that run is
 * still in flight. Deriving it from the map made the newest run's terminal
 * delete recycle it — three overlapping runs was enough to hand run 1's
 * number to run 3.
 */
describe("toast slot ownership across three overlapping runs", () => {
  test("a stale run that settles last cannot resolve the newest run's toast", async () => {
    const { ctx, store } = await fakeContext({ toastAutoDismissMs: 10_000 })
    const failures = createFailureController(ctx)
    const gate = () => {
      let release!: () => void
      const promise = new Promise<void>((resolve) => {
        release = resolve
      })
      return { promise, release }
    }
    const first = gate()
    const second = gate()
    const third = gate()
    // A is still running when B settles; C starts afterwards and owns the slot.
    const a = failures.withToast("flow.overlap", "Working…", "Done", () => first.promise.then(() => "old A failed"))
    const b = failures.withToast("flow.overlap", "Working…", "Done", () => second.promise.then(() => true))
    await settled()
    second.release()
    await b
    const c = failures.withToast("flow.overlap", "Working…", "Done", () => third.promise.then(() => true))
    await settled()
    expect(store.collections.toasts.get("toast-flow.overlap")?.status).toBe("running")

    first.release()
    await a
    // A is two runs stale: C's running notice names work still in flight.
    expect(store.collections.toasts.get("toast-flow.overlap")?.status).toBe("running")
    expect(ctx.toastRuns.has("flow.overlap")).toBe(true)

    third.release()
    await c
    const done = store.collections.toasts.get("toast-flow.overlap")
    expect(done?.status).toBe("ok")
    expect(done?.title).toBe("Done")
  })
})

test("a refused command's notice dismisses itself after stating the refusal", async () => {
  const { ctx, store } = await fakeContext()
  const failures = createFailureController(ctx)
  failures.surfaceCommandFailure("prs.list", { status: "failed", error: "The read was refused." })
  expect(store.collections.toasts.get("toast-command.failed.prs.list")?.detail).toBe("The read was refused.")
  expect(store.collections.toasts.get("toast-command.failed.prs.list")?.title).toBe("Read pull requests didn't run")
  await settled()
  expect(store.collections.toasts.get("toast-command.failed.prs.list")).toBeUndefined()
})

test("a seam's sign-in notice uses human summaries and dismisses even with an action", async () => {
  const { ctx, store } = await fakeContext()
  createFailureController(ctx).surfaceCommandFailure("prs.list", { status: "failed", error: "Use /auth.sign-in to continue." })
  const toast = store.collections.toasts.get("toast-command.failed.prs.list")
  expect(toast?.title).toBe("Read pull requests didn't run")
  expect(toast?.detail).toBe("Use Sign in with GitHub to continue.")
  expect(toast?.action).toEqual({ flow: "auth.sign-in", label: "Sign in with GitHub" })
  await settled()
  expect(store.collections.toasts.size).toBe(0)
})




test("a failure before debounce is visible, persistent, and belongs to its source card", async () => {
  const { ctx, store } = await fakeContext({ toastDebounceMs: 300, toastAutoDismissMs: 1 })
  const failures = createFailureController(ctx)
  await failures.withToast("fast", "Working", "Done", async () => "Launch refused", false, undefined, "source")
  expect(store.collections.toasts.get("toast-fast")).toMatchObject({ status: "failed", detail: "Launch refused", sourceCard: "source" })
  expect(ctx.toastRuns.has("fast")).toBe(false)
  await settled()
  expect(store.collections.toasts.get("toast-fast")?.status).toBe("failed")
  failures.dismissToast("toast-fast")
  expect(store.collections.toasts.get("toast-fast")).toBeUndefined()
})
