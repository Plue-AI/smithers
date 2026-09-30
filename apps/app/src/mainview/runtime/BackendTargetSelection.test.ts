import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { afterAll, afterEach, beforeAll, expect, mock, test } from "bun:test"
import type { ApplicationTargetDocument } from "@smthrs/rpc/ApplicationTarget"
import { selectedBackendTarget, selectedBackendToken, switchBackendTarget } from "./BackendTargetSelection"
import { loadApplicationTarget } from "./ApplicationTargetRuntime"

const PAGE = "https://smithers.test", TARGET = "smithers.backend-target", TOKEN = "smithers.backend-token", OTHER = "other-preference"
const OLD_ORIGIN = "https://previous-backend.test", OLD_TOKEN = "previous-inert-token", NEW_ORIGIN = "https://next-backend.test", NEW_TOKEN = "next-inert-token"
const oldTarget: ApplicationTargetDocument = {
  apiVersion: 1, mode: "web-plue", apiOrigin: OLD_ORIGIN, auth: { kind: "bearer" }, cors: "credentialed", developerExternal: true
}
beforeAll(() => GlobalRegistrator.register({ url: PAGE }))
afterAll(async () => { await GlobalRegistrator.unregister() })
const cleanups: Array<() => void> = []
afterEach(() => { while (cleanups.length) cleanups.pop()!(); sessionStorage.clear() })
// The real Storage owns data. Only requested browser failure boundaries are
// controlled; restore the exact global descriptor before clearing the fixture.
const storageBoundary = (overrides: Partial<Pick<Storage, "getItem" | "setItem" | "removeItem">>) => {
  const actual = sessionStorage, descriptor = Object.getOwnPropertyDescriptor(globalThis, "sessionStorage")
  if (!descriptor) throw new Error("Missing fixture storage descriptor")
  const boundary: Storage = {
    get length() { return actual.length }, key: index => actual.key(index), clear: () => actual.clear(),
    getItem: overrides.getItem ?? (key => actual.getItem(key)),
    setItem: overrides.setItem ?? ((key, value) => actual.setItem(key, value)),
    removeItem: overrides.removeItem ?? (key => actual.removeItem(key)),
  }
  Object.defineProperty(globalThis, "sessionStorage", { configurable: true, enumerable: descriptor.enumerable, writable: true, value: boundary })
  const restore = () => Object.defineProperty(globalThis, "sessionStorage", descriptor)
  cleanups.push(restore)
  return { actual, restore }
}
const seed = () => {
  sessionStorage.setItem(TARGET, JSON.stringify(oldTarget)); sessionStorage.setItem(TOKEN, OLD_TOKEN); sessionStorage.setItem(OTHER, "keep")
}

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
  switchBackendTarget("https://plue.example.test", "new-inert-token", "https://smithers.sh")
  expect(selectedBackendTarget("https://smithers.sh")).toEqual({ ...oldTarget, apiOrigin: "https://plue.example.test" })
  expect(selectedBackendToken()).toBe("new-inert-token")
  switchBackendTarget("https://smithers.sh", "", "https://smithers.sh")
  expect(selectedBackendToken()).toBeUndefined()
  expect(selectedBackendTarget("https://smithers.sh")).toEqual({ apiVersion: 1, mode: "web-selfhost", apiOrigin: "https://smithers.sh", auth: { kind: "session" }, cors: "same-origin", developerExternal: false })
  expect(() => switchBackendTarget("javascript:invalid", "inert-token", "https://smithers.sh")).toThrow(new Error("Application API origin must use HTTP(S)."))
})

test("a selected Plue document boots through the application target runtime", async () => {
  const origin = "http://127.0.0.1:14080"
  sessionStorage.setItem(TARGET, JSON.stringify({ apiVersion: 1, mode: "web-plue", apiOrigin: "", auth: { kind: "bearer" }, cors: "same-origin", developerExternal: false }))
  await expect(loadApplicationTarget({ document, pageOrigin: origin, native: async () => selectedBackendTarget(origin) }))
    .resolves.toEqual({ apiVersion: 1, mode: "web-plue", apiOrigin: "", auth: { kind: "bearer" }, cors: "same-origin", developerExternal: false, shell: "web", ownership: "plue", launch: "none", baseUrl: "" })
})

test("missing selection is absence and does not erase unrelated tab data", () => {
  sessionStorage.setItem(OTHER, "keep")
  expect(selectedBackendTarget(PAGE)).toBeUndefined()
  expect(selectedBackendToken()).toBeUndefined()
  expect(sessionStorage.getItem(OTHER)).toBe("keep")
})

test("stored schema defaults are filled without rewriting the deployment document", () => {
  const raw = JSON.stringify({ apiVersion: 1, mode: "web-selfhost", auth: { kind: "session" } })
  sessionStorage.setItem(TARGET, raw)
  expect(selectedBackendTarget(PAGE)).toEqual({ apiVersion: 1, mode: "web-selfhost", apiOrigin: "", auth: { kind: "session" }, cors: "same-origin", developerExternal: false })
  expect(sessionStorage.getItem(TARGET)).toBe(raw)
})

test.each(["local-own", "local-plue", "native-own", "native-plue"] as const)("stored %s is never selected as a web backend", mode => {
  const target: ApplicationTargetDocument = {
    apiVersion: 1, mode, apiOrigin: mode.endsWith("own") ? "http://127.0.0.1:14080" : "", auth: { kind: "session" }, cors: "same-origin", developerExternal: false
  }
  sessionStorage.setItem(TARGET, JSON.stringify(target)); sessionStorage.setItem(OTHER, "keep")
  expect(selectedBackendTarget(PAGE)).toBeUndefined()
  expect(sessionStorage.getItem(OTHER)).toBe("keep")
})

test.each([
  { name: "malformed JSON", raw: "{invalid" },
  { name: "null document", raw: "null" },
  { name: "unknown mode", raw: JSON.stringify({ ...oldTarget, mode: "future" }) },
  { name: "secret-bearing document", raw: JSON.stringify({ ...oldTarget, token: "inert-embedded-token" }) },
  { name: "unsupported protocol", raw: JSON.stringify({ ...oldTarget, apiOrigin: "ftp://next-backend.test" }) },
  { name: "implicit external Plue", raw: JSON.stringify({ ...oldTarget, developerExternal: false }) },
])("$name selection clears its target and credential while preserving unrelated storage", ({ raw }) => {
  seed(); sessionStorage.setItem(TARGET, raw)
  expect(selectedBackendTarget(PAGE)).toBeUndefined()
  expect(sessionStorage.getItem(TARGET)).toBeNull()
  expect(selectedBackendToken()).toBeUndefined()
  expect(sessionStorage.getItem(OTHER)).toBe("keep")
})

test("unavailable storage reads fall back after clearing only the selection keys", () => {
  seed()
  const actual = sessionStorage, remove = mock((key: string) => actual.removeItem(key))
  const boundary = storageBoundary({ getItem: () => { throw new DOMException("Storage unavailable", "SecurityError") }, removeItem: remove })
  expect(selectedBackendTarget(PAGE)).toBeUndefined()
  expect(remove.mock.calls).toEqual([[TARGET], [TOKEN]])
  boundary.restore()
  expect(sessionStorage.getItem(TARGET)).toBeNull(); expect(sessionStorage.getItem(TOKEN)).toBeNull()
  expect(sessionStorage.getItem(OTHER)).toBe("keep")
})

test("unavailable cleanup does not replace deployment fallback with a storage exception", () => {
  seed(); sessionStorage.setItem(TARGET, "{invalid")
  const remove = mock((_: string) => { throw new DOMException("Storage unavailable", "SecurityError") })
  storageBoundary({ removeItem: remove })
  expect(selectedBackendTarget(PAGE)).toBeUndefined()
  expect(remove.mock.calls).toEqual([[TARGET]])
  expect(sessionStorage.getItem(OTHER)).toBe("keep")
})

test.each([
  { origin: " HTTPS://NEXT-BACKEND.TEST:443/ ", token: "  next-inert-token \n", expectedOrigin: NEW_ORIGIN, expectedToken: NEW_TOKEN, mode: "web-plue" },
  { origin: " HTTPS://SMITHERS.TEST:443/ ", token: " \n\t ", expectedOrigin: PAGE, expectedToken: undefined, mode: "web-selfhost" },
  { origin: "", token: "", expectedOrigin: "", expectedToken: undefined, mode: "web-selfhost" },
])("switch to $origin normalizes input and owns only target and credential storage", ({ origin, token, expectedOrigin, expectedToken, mode }) => {
  seed(); switchBackendTarget(origin, token, PAGE)
  expect(selectedBackendTarget(PAGE)).toEqual({ apiVersion: 1, mode, apiOrigin: expectedOrigin, auth: { kind: expectedToken ? "bearer" : "session" }, cors: expectedToken ? "credentialed" : "same-origin", developerExternal: expectedToken !== undefined })
  expect(selectedBackendToken()).toBe(expectedToken)
  expect(sessionStorage.getItem(OTHER)).toBe("keep")
  expect(JSON.parse(sessionStorage.getItem(TARGET)!)).not.toHaveProperty("token")
})

test.each([
  { origin: "ftp://next-backend.test", token: NEW_TOKEN, message: "Application API origin must use HTTP(S)." },
  { origin: "/relative", token: NEW_TOKEN, message: "Application API origin must be an absolute HTTP(S) origin." },
  { origin: "https://next-backend.test/path", token: NEW_TOKEN, message: "Application API origin cannot contain credentials, a path, a query, or a fragment." },
  { origin: NEW_ORIGIN, token: "", message: "web-selfhost must use its serving origin." },
])("invalid switch $origin with token $token preserves the previous pair exactly", ({ origin, token, message }) => {
  seed(); const previous = sessionStorage.getItem(TARGET)
  expect(() => switchBackendTarget(origin, token, PAGE)).toThrow(new Error(message))
  expect(sessionStorage.getItem(TARGET)).toBe(previous)
  expect(selectedBackendTarget(PAGE)).toEqual(oldTarget)
  expect(selectedBackendToken()).toBe(OLD_TOKEN)
  expect(sessionStorage.getItem(OTHER)).toBe("keep")
})

test.each(["target write", "token write", "token removal"] as const)("%s refusal cannot mix credentials between targets and a later switch can recover", boundary => {
  seed()
  const origin = boundary === "token removal" ? PAGE : NEW_ORIGIN, token = boundary === "token removal" ? "" : NEW_TOKEN
  const failure = new DOMException("Storage write refused", "QuotaExceededError"), setItem = sessionStorage.setItem.bind(sessionStorage)
  const actual = sessionStorage
  const set = mock((key: string, value: string) => {
    if (key === (boundary === "target write" ? TARGET : TOKEN) && boundary !== "token removal") throw failure
    setItem(key, value)
  })
  const remove = mock((key: string) => { if (boundary === "token removal") throw failure; actual.removeItem(key) })
  const controlled = storageBoundary({ setItem: set, removeItem: remove })
  expect(() => switchBackendTarget(origin, token, PAGE)).toThrow(failure)
  const pair = { origin: selectedBackendTarget(PAGE)?.apiOrigin, token: selectedBackendToken() }
  // Rollback and fail-closed clearing are both valid; crossing credentials is not.
  expect(pair).not.toEqual({ origin, token: OLD_TOKEN })
  expect(pair).not.toEqual({ origin: OLD_ORIGIN, token: NEW_TOKEN })
  expect(sessionStorage.getItem(OTHER)).toBe("keep")
  controlled.restore()
  switchBackendTarget(origin, token, PAGE)
  expect(selectedBackendTarget(PAGE)?.apiOrigin).toBe(origin)
  expect(selectedBackendToken()).toBe(token || undefined)
  expect(sessionStorage.getItem(OTHER)).toBe("keep")
})


test("an unavailable sessionStorage getter still permits deployment fallback", () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "sessionStorage")
  if (!descriptor) throw new Error("Missing fixture storage descriptor")
  Object.defineProperty(globalThis, "sessionStorage", { configurable: true, get: () => { throw new DOMException("Storage unavailable", "SecurityError") } })
  cleanups.push(() => Object.defineProperty(globalThis, "sessionStorage", descriptor))
  expect(selectedBackendTarget(PAGE)).toBeUndefined()
})

test.each([
  { origin: " HTTPS://SMITHERS.TEST:443/ ", expectedOrigin: PAGE },
  { origin: "", expectedOrigin: "" },
])("a token switch to serving origin $origin uses same-origin web Plue", async ({ origin, expectedOrigin }) => {
  seed()
  expect(() => switchBackendTarget(origin, NEW_TOKEN, PAGE)).not.toThrow()
  expect(selectedBackendTarget(PAGE)).toMatchObject({ apiVersion: 1, mode: "web-plue", apiOrigin: expectedOrigin, auth: { kind: "bearer" }, cors: "same-origin" })
  expect(selectedBackendToken()).toBe(NEW_TOKEN)
  await expect(loadApplicationTarget({ document, pageOrigin: PAGE, native: async () => selectedBackendTarget(PAGE) }))
    .resolves.toMatchObject({ mode: "web-plue", apiOrigin: expectedOrigin, auth: { kind: "bearer" }, cors: "same-origin", shell: "web", ownership: "plue", launch: "none", baseUrl: "" })
  expect(sessionStorage.getItem(OTHER)).toBe("keep")
})

for (const pageOrigin of ["null", "/invalid-serving-origin"]) test.each([
  { origin: "ftp://backend.example", message: "Application API origin must use HTTP(S)." },
  { origin: "https://backend.example", message: "Application API origin must be an absolute HTTP(S) origin." },
  { origin: "", message: "Application API origin must be an absolute HTTP(S) origin." },
])(`the shared resolver owns $origin diagnostics with serving origin ${pageOrigin}`, ({ origin, message }) => {
  seed()
  const previous = sessionStorage.getItem(TARGET)
  expect(() => switchBackendTarget(origin, NEW_TOKEN, pageOrigin)).toThrow(new Error(message))
  expect(sessionStorage.getItem(TARGET)).toBe(previous)
  expect(sessionStorage.getItem(TOKEN)).toBe(OLD_TOKEN)
})

test("an unspecified serving origin retains the resolver's external-target contract", () => {
  switchBackendTarget(NEW_ORIGIN, NEW_TOKEN, "")
  expect(selectedBackendTarget("")).toEqual({ ...oldTarget, apiOrigin: NEW_ORIGIN })
  expect(selectedBackendToken()).toBe(NEW_TOKEN)
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
