import { afterEach, expect, test } from "bun:test"
import { randomUuid } from "./RandomUuid"

const V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const secure = Object.getOwnPropertyDescriptor(globalThis, "crypto")!
afterEach(() => { Object.defineProperty(globalThis, "crypto", secure) })

test("an id is an RFC 4122 version 4 UUID: version nibble 4, variant bits 10", () => {
  for (let index = 0; index < 1_000; index++) expect(randomUuid()).toMatch(V4)
})

test("10^5 ids never collide", () => {
  const ids = new Set<string>()
  for (let index = 0; index < 100_000; index++) ids.add(randomUuid())
  expect(ids.size).toBe(100_000)
})

test("works where crypto.randomUUID and crypto.subtle do not exist (a plain-HTTP origin)", () => {
  const getRandomValues = globalThis.crypto.getRandomValues.bind(globalThis.crypto)
  Object.defineProperty(globalThis, "crypto", { configurable: true, value: { getRandomValues } })
  expect("randomUUID" in globalThis.crypto).toBe(false)
  expect(randomUuid()).toMatch(V4)
})

test("the bytes come from getRandomValues, with only the version and variant bits forced", () => {
  Object.defineProperty(globalThis, "crypto", { configurable: true, value: { getRandomValues: (array: Uint8Array) => array.fill(255) } })
  expect(randomUuid()).toBe("ffffffff-ffff-4fff-bfff-ffffffffffff")
  Object.defineProperty(globalThis, "crypto", { configurable: true, value: { getRandomValues: (array: Uint8Array) => array.fill(0) } })
  expect(randomUuid()).toBe("00000000-0000-4000-8000-000000000000")
})
