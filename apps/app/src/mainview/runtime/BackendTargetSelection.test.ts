import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { afterAll, afterEach, expect, test } from "bun:test"
import { selectedBackendTarget, selectedBackendToken, switchBackendTarget } from "./BackendTargetSelection"
import { loadApplicationTarget } from "./ApplicationTargetRuntime"

GlobalRegistrator.register()
afterAll(() => GlobalRegistrator.unregister())
afterEach(() => sessionStorage.clear())

const PAGE_ORIGIN = "https://smithers.sh"
const FIRST_BACKEND = "https://first.plue.example"
const SECOND_BACKEND = "https://second.plue.example"
const TARGET_KEY = "smithers.backend-target"
const TOKEN_KEY = "smithers.backend-token"

type StorageWrite = "target write" | "token write" | "token removal"

/** Forward every operation to Happy DOM storage, except one requested write. */
const failOneStorageWrite = (operation: StorageWrite, action: () => void): void => {
  const realStorage = sessionStorage
  const originalDescriptor = Object.getOwnPropertyDescriptor(globalThis, "sessionStorage")
  let failed = false
  const storage: Storage = {
    get length() { return realStorage.length },
    clear: () => realStorage.clear(),
    getItem: (key) => realStorage.getItem(key),
    key: (index) => realStorage.key(index),
    removeItem: (key) => {
      if (!failed && operation === "token removal" && key === TOKEN_KEY) {
        failed = true
        throw new DOMException("injected token removal failure", "SecurityError")
      }
      realStorage.removeItem(key)
    },
    setItem: (key, value) => {
      if (!failed && ((operation === "target write" && key === TARGET_KEY)
        || (operation === "token write" && key === TOKEN_KEY))) {
        failed = true
        throw new DOMException(`injected ${operation} failure`, "QuotaExceededError")
      }
      realStorage.setItem(key, value)
    }
  }
  Object.defineProperty(globalThis, "sessionStorage", { configurable: true, value: storage })
  try {
    action()
    expect(failed).toBe(true)
  } finally {
    if (originalDescriptor) Object.defineProperty(globalThis, "sessionStorage", originalDescriptor)
    else Reflect.deleteProperty(globalThis, "sessionStorage")
  }
}

test("web switch validates the external Plue target and clears an old credential", () => {
  switchBackendTarget("https://plue.example.test", "new-token", "https://smithers.sh")
  expect(selectedBackendTarget("https://smithers.sh")?.mode).toBe("web-plue")
  switchBackendTarget("https://smithers.sh", "", "https://smithers.sh")
  expect(selectedBackendToken()).toBeUndefined()
  expect(selectedBackendTarget("https://smithers.sh")?.mode).toBe("web-selfhost")
  expect(() => switchBackendTarget("javascript:alert(1)", "token", "https://smithers.sh")).toThrow()
})

test("a selected Plue document boots through the application target runtime", async () => {
  const origin = "http://127.0.0.1:14080"
  sessionStorage.setItem("smithers.backend-target", JSON.stringify({
    apiVersion: 1, mode: "web-plue", apiOrigin: "", auth: { kind: "bearer" },
    cors: "same-origin", developerExternal: false
  }))
  await expect(loadApplicationTarget({
    document,
    pageOrigin: origin,
    native: async () => selectedBackendTarget(origin)
  })).resolves.toMatchObject({ mode: "web-plue", shell: "web", ownership: "plue" })
})

for (const [origin, expectedOrigin] of [
  [" HTTPS://SMITHERS.SH:443/ ", PAGE_ORIGIN],
  ["", ""]
] as const) {
  test(`a bearer switch to the serving origin ${origin || "(empty)"} boots through the app runtime`, async () => {
    switchBackendTarget(origin, " next-inert-token ", PAGE_ORIGIN)
    expect(selectedBackendTarget(PAGE_ORIGIN)).toMatchObject({
      mode: "web-plue", apiOrigin: expectedOrigin, auth: { kind: "bearer" }, cors: "same-origin"
    })
    expect(selectedBackendToken()).toBe("next-inert-token")
    await expect(loadApplicationTarget({
      document,
      pageOrigin: PAGE_ORIGIN,
      native: async () => selectedBackendTarget(PAGE_ORIGIN)
    })).resolves.toMatchObject({ mode: "web-plue", baseUrl: "" })
  })
}

for (const { name, operation, nextOrigin, nextToken } of [
  { name: "bearer switch when token removal fails", operation: "token removal", nextOrigin: SECOND_BACKEND, nextToken: "second-token" },
  { name: "bearer switch when target write fails", operation: "target write", nextOrigin: SECOND_BACKEND, nextToken: "second-token" },
  { name: "bearer switch when token write fails", operation: "token write", nextOrigin: SECOND_BACKEND, nextToken: "second-token" },
  { name: "tokenless switch when target write fails", operation: "target write", nextOrigin: PAGE_ORIGIN, nextToken: "" },
  { name: "tokenless switch when token removal fails", operation: "token removal", nextOrigin: PAGE_ORIGIN, nextToken: "" }
] as const) {
  test(`failed ${name} never crosses backend credentials, then retries`, () => {
    switchBackendTarget(FIRST_BACKEND, "first-token", PAGE_ORIGIN)
    sessionStorage.setItem("unrelated.setting", "keep-me")

    failOneStorageWrite(operation, () => {
      expect(() => switchBackendTarget(nextOrigin, nextToken, PAGE_ORIGIN))
        .toThrow(`injected ${operation} failure`)
      const selectedOrigin = selectedBackendTarget(PAGE_ORIGIN)?.apiOrigin
      const selectedToken = selectedBackendToken()
      expect(selectedOrigin === FIRST_BACKEND || selectedOrigin === nextOrigin).toBe(true)
      expect([undefined, "first-token", "second-token"]).toContain(selectedToken)
      if (selectedToken === "first-token") expect(selectedOrigin).toBe(FIRST_BACKEND)
      if (selectedToken === "second-token") expect(selectedOrigin).toBe(SECOND_BACKEND)
      expect(sessionStorage.getItem("unrelated.setting")).toBe("keep-me")
    })

    switchBackendTarget(nextOrigin, nextToken, PAGE_ORIGIN)
    expect(selectedBackendTarget(PAGE_ORIGIN)?.apiOrigin).toBe(nextOrigin)
    expect(selectedBackendToken()).toBe(nextToken || undefined)
    expect(sessionStorage.getItem("unrelated.setting")).toBe("keep-me")
  })
}

test("successful bearer switch trims the origin and credential", () => {
  switchBackendTarget(`  ${SECOND_BACKEND}  `, "  second-token  ", PAGE_ORIGIN)
  expect(selectedBackendTarget(PAGE_ORIGIN)?.apiOrigin).toBe(SECOND_BACKEND)
  expect(selectedBackendToken()).toBe("second-token")
})

test("invalid target leaves the selected backend, credential, and unrelated storage unchanged", () => {
  switchBackendTarget(FIRST_BACKEND, "first-token", PAGE_ORIGIN)
  sessionStorage.setItem("unrelated.setting", "keep-me")
  const previousTarget = sessionStorage.getItem(TARGET_KEY)
  expect(() => switchBackendTarget("javascript:alert(1)", "second-token", PAGE_ORIGIN)).toThrow()
  expect(sessionStorage.getItem(TARGET_KEY)).toBe(previousTarget)
  expect(sessionStorage.getItem(TOKEN_KEY)).toBe("first-token")
  expect(sessionStorage.getItem("unrelated.setting")).toBe("keep-me")
})
