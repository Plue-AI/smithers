import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { afterAll, describe, expect, test } from "bun:test"
import type { StorageRecoverySnapshot } from "./chain/StorageRecovery"
import { createStartupRecovery } from "./StartupRecovery"
import {
  HeldBrowserStorageError,
  RECOVERY_RESET_CONFIRM_LABEL,
  RECOVERY_RESET_LABEL
} from "./state/StorageRecoveryContract"

GlobalRegistrator.register()
afterAll(async () => {
  await GlobalRegistrator.unregister()
})

const snapshot: StorageRecoverySnapshot = {
  format: "smithers-ui-recovery",
  version: 1,
  capturedAt: "fixture",
  localStorage: [{ key: "smithers-mvp.store", value: "private original" }]
}
const until = async (condition: () => boolean) => {
  for (let turn = 0; turn < 100; turn++) {
    if (condition()) return
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  throw new Error("projection did not settle")
}

describe("startup recovery's non-React projection", () => {
  test("an unavailable lazy binding produces a visible safe failure and can be retried", async () => {
    let fails = true
    let downloads = 0
    const recovery = createStartupRecovery(document, {
      read: async () => snapshot,
      download: () => {
        downloads++
      }
    }, async () => {
      if (fails) throw new Error("private bundle failure")
      return import("./flows/StorageRecoveryFlow")
    })
    try {
      const button = recovery.element.querySelector("button")!
      button.click()
      await until(() => recovery.element.textContent?.includes("could not read all of this browser's saved data") === true)
      expect(recovery.element.textContent).not.toContain("private bundle failure")
      expect(downloads).toBe(0)
      fails = false
      button.click()
      await until(() => downloads === 1)
    } finally {
      await recovery.dispose()
    }
  })
  test("shows safe failure, supports retry, and never renders the private file", async () => {
    let fails = true
    const downloads: string[] = []
    const recovery = createStartupRecovery(document, {
      read: async () => {
        if (fails) throw new Error("private original")
        return snapshot
      },
      download: (json) => {
        downloads.push(json)
      }
    })
    try {
      const button = recovery.element.querySelector("button")!
      button.click()
      await until(() => recovery.element.textContent?.includes("could not read all of this browser's saved data") === true)
      expect(button.disabled).toBe(false)
      expect(recovery.element.textContent).not.toContain("private original")
      expect(downloads).toEqual([])
      fails = false
      button.click()
      await until(() => recovery.element.textContent?.includes("Recovery download prepared.") === true)
      expect(downloads).toEqual([JSON.stringify(snapshot)])
      expect(recovery.element.textContent).not.toContain("private original")
    } finally {
      await recovery.dispose()
    }
  })

  /*
   * The second door out of a failed boot. Before it, a profile too large to
   * load — "prepare runtime and persisted state: Invalid string length" against
   * 890415370 bytes of OPFS fileSystem usage, smithers.sh build 8e55636b — could
   * only download itself and then had to be erased from a different page.
   */
  describe("the reset action", () => {
    const panel = (reset: () => Promise<void>) =>
      createStartupRecovery(document, { read: async () => snapshot, download: () => {}, reset })
    const resetButton = (recovery: ReturnType<typeof createStartupRecovery>): HTMLButtonElement =>
      recovery.element.querySelector<HTMLButtonElement>(`button[data-flow="storage.recovery.reset"]`)!

    test("arms on the first press and erases on the second", async () => {
      let erased = 0
      const recovery = panel(async () => {
        erased += 1
      })
      try {
        const button = resetButton(recovery)
        expect(button.textContent).toBe(RECOVERY_RESET_LABEL)
        button.click()
        await until(() => button.textContent === RECOVERY_RESET_CONFIRM_LABEL)
        // Arming states what it takes with it, and takes nothing yet.
        expect(recovery.element.textContent).toContain("erases this browser's saved Smithers conversation")
        expect(erased).toBe(0)
        button.click()
        await until(() => erased === 1)
      } finally {
        await recovery.dispose()
      }
    })

    test("a store another tab still holds says so and erases nothing", async () => {
      const recovery = panel(async () => {
        throw new HeldBrowserStorageError()
      })
      try {
        const button = resetButton(recovery)
        button.click()
        await until(() => button.textContent === RECOVERY_RESET_CONFIRM_LABEL)
        button.click()
        await until(() => recovery.element.textContent?.includes("still open in another Smithers tab") === true)
        expect(button.disabled).toBe(false)
      } finally {
        await recovery.dispose()
      }
    })

    test("a host that cannot erase refuses without arming a second press", async () => {
      const recovery = createStartupRecovery(document, { read: async () => snapshot, download: () => {} })
      try {
        const button = resetButton(recovery)
        button.click()
        await until(() => recovery.element.textContent?.includes("could not be erased") === true)
        expect(button.textContent).toBe(RECOVERY_RESET_LABEL)
      } finally {
        await recovery.dispose()
      }
    })

    test("the download button is untouched by the reset action", async () => {
      const recovery = panel(async () => {})
      try {
        const buttons = [...recovery.element.querySelectorAll("button")]
        expect(buttons.map((button) => button.dataset.flow))
          .toEqual(["storage.recovery.export", "storage.recovery.reset"])
      } finally {
        await recovery.dispose()
      }
    })
  })

  test("closing the panel during capture disables the action, removes the subscription, and suppresses the late download", async () => {
    let release!: (snapshot: StorageRecoverySnapshot) => void
    let reads = 0
    let downloads = 0
    const held = new Promise<StorageRecoverySnapshot>((resolve) => {
      release = resolve
    })
    const recovery = createStartupRecovery(document, {
      read: () => {
        reads++
        return held
      },
      download: () => {
        downloads++
      }
    })
    try {
      const button = recovery.element.querySelector("button")!
      button.click()
      await until(() => reads === 1)
      expect(button.disabled).toBe(true)
      const closing = recovery.dispose()
      expect(recovery.dispose()).toBe(closing)
      expect(button.onclick).toBeNull()
      const before = recovery.element.textContent
      release(snapshot)
      await closing
      expect(downloads).toBe(0)
      expect(recovery.element.textContent).toBe(before)
    } finally {
      release(snapshot)
      await recovery.dispose()
    }
  })
})
