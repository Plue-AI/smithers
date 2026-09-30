import { describe, expect, test } from "bun:test"
import { StorageRecoveryError } from "../chain/StorageRecovery"
import type { StorageRecoverySnapshot } from "../chain/StorageRecovery"
import { invokeStartupRecovery, storageRecoveryExportFlow } from "../flows/StorageRecoveryFlow"
import { createStorageRecoveryAction } from "./StorageRecoveryAction"
import { HeldBrowserStorageError, RECOVERY_HUMAN_ONLY } from "./StorageRecoveryContract"

const raw = "private recovery fixture"
const snapshot: StorageRecoverySnapshot = {
  format: "smithers-ui-recovery",
  version: 1,
  capturedAt: "2026-09-04T00:00:00.000Z",
  localStorage: [{ key: "smithers-mvp.store", value: raw }]
}

const bounded = async <T>(promise: Promise<T>): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("Recovery fixture did not settle")), 3000)
    })])
  } finally { clearTimeout(timer) }
}

describe("the shared private recovery action and Flow", () => {
  test("an admitted erase owns repeated reset/download calls and disposal waits for it", async () => {
    const entered = Promise.withResolvers<void>()
    const erased = Promise.withResolvers<void>()
    const calls: string[] = []
    const action = createStorageRecoveryAction({
      read: async () => { calls.push("read"); return snapshot },
      download: () => { calls.push("download") },
      reset: async () => { calls.push("erase"); entered.resolve(); await erased.promise }
    }, "user")
    let closing: Promise<void> | undefined
    try {
      await action.reset()
      const resetting = action.reset()
      await bounded(entered.promise)
      expect(action.reset()).toBe(resetting)
      expect(action.run()).toBe(resetting)
      expect(action.state.get("reset")).toMatchObject({ phase: "resetting", actor: "user" })
      let disposed = false
      closing = action.dispose().then(() => { disposed = true })
      await new Promise<void>(resolve => setImmediate(resolve))
      expect(disposed).toBe(false)
      expect(calls).toEqual(["erase"])
      erased.resolve()
      await bounded(Promise.all([resetting, closing]))
      expect(disposed).toBe(true)
      expect(await action.reset()).toBe("Recovery was canceled because the app closed. Saved data was not reset.")
      expect(await action.run()).toBe("Recovery was canceled because the app closed. Saved data was not reset.")
      expect(calls).toEqual(["erase"])
    } finally {
      erased.resolve()
      await bounded(closing ?? action.dispose())
    }
  })

  for (const failure of ["held", "private"] as const) {
    test(`${failure} erase failure preserves private-safe state and requires a fresh confirmation to retry`, async () => {
      let attempts = 0
      const action = createStorageRecoveryAction({
        read: async () => snapshot,
        download: () => {},
        reset: async () => {
          attempts++
          if (attempts === 1) throw failure === "held" ? new HeldBrowserStorageError() : new Error(raw)
        }
      }, "user")
      const message = failure === "held"
        ? "This browser's saved data is still open in another Smithers tab, so the reset did not finish. Close the other tabs and try again."
        : "This browser's saved data could not be erased. The reset did not finish; reload and try again."
      try {
        await action.reset()
        expect(await action.reset()).toBe(message)
        expect(action.state.get("reset")).toMatchObject({ phase: "failed", message, actor: "user", revision: 3 })
        expect(JSON.stringify([...action.state.values()])).not.toContain(raw)
        await action.reset()
        expect(attempts).toBe(1)
        expect(action.state.get("reset")?.phase).toBe("armed")
        expect(await action.reset()).toBeUndefined()
        expect(attempts).toBe(2)
        // A successful host erase reloads the page; the local action has no completion receipt to invent.
        expect(action.state.get("reset")?.phase).toBe("resetting")
      } finally { await action.dispose() }
    })
  }

  for (const actor of ["user", "smithers"] as const) {
    test(`a lazy binding refusal is visible only to its ${actor} actor without reading private storage`, async () => {
      const calls: string[] = []
      const action = createStorageRecoveryAction({
        read: async () => { calls.push("read"); return snapshot },
        download: () => { calls.push("download") }
      }, actor)
      try {
        await action.state.preload()
        await action.bindingUnavailable()
        expect(action.state.get("recovery")).toMatchObject(actor === "user"
          ? { phase: "failed", actor: "user", revision: 1, message: "Smithers could not read all of this browser's saved data for the recovery file. Not your fault. Nothing was reset." }
          : { phase: "idle", actor: "system", revision: 0, message: null })
        expect(calls).toEqual([])
      } finally { await action.dispose() }
    })
  }

  test("reset finishes a pending private download before erasing and blocks a later capture", async () => {
    const captured = Promise.withResolvers<StorageRecoverySnapshot>()
    const started = Promise.withResolvers<void>()
    const order: string[] = []
    const action = createStorageRecoveryAction({
      read: async () => { order.push("read"); started.resolve(); return captured.promise },
      download: () => { order.push("download") },
      reset: async () => { order.push("erase") }
    }, "user")
    try {
      await action.reset()
      const downloading = action.run()
      await started.promise
      const resetting = action.reset()
      expect(action.run()).toBe(resetting)
      expect(order).toEqual(["read"])
      captured.resolve(snapshot)
      await Promise.all([downloading, resetting])
      expect(order).toEqual(["read", "download", "erase"])
    } finally { captured.resolve(snapshot); await action.dispose() }
  })

  test("the human's download receives bytes, but the state and Flow result never do", async () => {
    const downloads: string[] = []
    const action = createStorageRecoveryAction({
      read: async () => snapshot,
      download: (json) => {
        downloads.push(json)
      }
    }, "user")
    try {
      const flow = storageRecoveryExportFlow(action.run)
      const result = await invokeStartupRecovery(flow)
      expect(result.outcome).toBe("success")
      expect(result.value).toEqual({})
      expect(downloads).toEqual([JSON.stringify(snapshot)])
      expect(action.state.get("recovery")).toMatchObject({ phase: "ready", actor: "user", revision: 2 })
      expect(JSON.stringify(result)).not.toContain(raw)
      expect(JSON.stringify([...action.state.values()])).not.toContain(raw)
    } finally {
      await action.dispose()
    }
  })

  test("an agent is refused even when it bypasses catalog filtering and directly calls the binding", async () => {
    let reads = 0
    let downloads = 0
    const action = createStorageRecoveryAction({
      read: async () => {
        reads++
        return snapshot
      },
      download: () => {
        downloads++
      }
    }, "smithers")
    try {
      const flow = storageRecoveryExportFlow(action.run)
      expect(flow.binding.descriptor.modelInvocable).toBe(false)
      expect(flow.metadata.userOnlyReason).toContain("storage.recovery")
      const result = await invokeStartupRecovery(flow)
      expect(result.outcome).toBe("failure")
      expect(result.message).toContain(RECOVERY_HUMAN_ONLY)
      expect(reads).toBe(0)
      expect(downloads).toBe(0)
    } finally {
      await action.dispose()
    }
  })

  test("concurrent requests share one capture/download and a later request can prepare a new file", async () => {
    let release!: (value: StorageRecoverySnapshot) => void
    const held = new Promise<StorageRecoverySnapshot>((resolve) => {
      release = resolve
    })
    let reads = 0
    let downloads = 0
    const action = createStorageRecoveryAction({
      read: () => {
        reads++
        return held
      },
      download: () => {
        downloads++
      }
    }, "user")
    try {
      const first = action.run()
      expect(action.run()).toBe(first)
      release(snapshot)
      await first
      expect(reads).toBe(1)
      expect(downloads).toBe(1)
      await action.run()
      expect(reads).toBe(2)
      expect(downloads).toBe(2)
    } finally {
      release(snapshot)
      await action.dispose()
    }
  })

  for (const where of ["read", "download"] as const) {
    test(`${where} failure is reported without raw host errors and a retry can succeed`, async () => {
      let failing = true
      const action = createStorageRecoveryAction({
        read: async () => {
          if (where === "read" && failing) throw new Error(raw)
          return snapshot
        },
        download: () => {
          if (where === "download" && failing) throw new Error(raw)
        }
      }, "user")
      try {
        const flow = storageRecoveryExportFlow(action.run)
        const result = await invokeStartupRecovery(flow)
        expect(result.outcome).toBe("failure")
        expect(result.message).toContain("Nothing was reset")
        expect(JSON.stringify(result)).not.toContain(raw)
        expect(action.state.get("recovery")?.phase).toBe("failed")
        expect(action.state.get("recovery")?.message).toContain("Nothing was reset")
        expect(JSON.stringify([...action.state.values()])).not.toContain(raw)
        failing = false
        expect((await invokeStartupRecovery(flow)).outcome).toBe("success")
      } finally {
        await action.dispose()
      }
    })
  }

  test("even a modified public error's message cannot leak private data into the flow result", async () => {
    const error = new StorageRecoveryError("limit")
    error.message = raw
    const action = createStorageRecoveryAction({
      read: async () => {
        throw error
      },
      download: () => {}
    }, "user")
    try {
      const result = await invokeStartupRecovery(storageRecoveryExportFlow(action.run))
      expect(result.outcome).toBe("failure")
      expect(result.message).toContain("The recovery file is too large to download. Not your fault. Nothing was reset.")
      expect(result.message).not.toContain(raw)
    } finally {
      await action.dispose()
    }
  })

  test("disposing during capture waits for cleanup and suppresses the later browser download", async () => {
    let release!: (value: StorageRecoverySnapshot) => void
    let started!: () => void
    const captured = new Promise<void>((resolve) => {
      started = resolve
    })
    const held = new Promise<StorageRecoverySnapshot>((resolve) => {
      release = resolve
    })
    let downloads = 0
    const action = createStorageRecoveryAction({
      read: () => {
        started()
        return held
      },
      download: () => {
        downloads++
      }
    }, "user")
    const running = action.run()
    await captured
    const closing = action.dispose()
    expect(action.dispose()).toBe(closing)
    release(snapshot)
    expect(await running).toContain("canceled")
    await closing
    expect(downloads).toBe(0)
    expect(await action.run()).toContain("canceled")
  })
})
