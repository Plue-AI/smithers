import { expect, it } from "@effect/vitest"
import { vi } from "vitest"
import { renderDiagnostic } from "../src/internal/Diagnostic.ts"

it("redacts sensitive fields before traversing object and array values", () => {
  const secret = "sensitive-container-XYZ123"
  const value = { token: { value: secret }, password: [secret], apiKey: { message: secret } }
  expect(renderDiagnostic(value)).not.toContain(secret)
  expect(JSON.parse(renderDiagnostic(value))).toEqual({
    token: "[REDACTED]",
    password: "[REDACTED]",
    apiKey: "[REDACTED]"
  })
})

it("never traverses a proxy stored under a sensitive field", () => {
  let calls = 0
  const secret = new Proxy({}, {
    getOwnPropertyDescriptor: () => {
      calls++
      throw new Error("private")
    }
  })
  expect(renderDiagnostic({ token: secret })).toBe("{\"token\":\"[REDACTED]\"}")
  expect(calls).toBe(0)
})

it("never runs a proxy's traps, at the top or nested", () => {
  let calls = 0
  const trap = new Proxy({}, {
    getOwnPropertyDescriptor: () => {
      calls++
      return undefined
    }
  })
  expect(renderDiagnostic(trap)).toBe("[proxy]")
  expect(renderDiagnostic({ message: "failed", cause: trap })).toBe(
    JSON.stringify({ message: "failed", cause: "[proxy]" })
  )
  expect(calls).toBe(0)
})

it("renders the constant fallback when a runtime cannot tell a proxy and a trap throws", async () => {
  const getBuiltinModule = process.getBuiltinModule
  vi.resetModules()
  Object.defineProperty(process, "getBuiltinModule", { value: undefined, configurable: true, writable: true })
  try {
    const { renderDiagnostic: render } = await import("../src/internal/Diagnostic.ts")
    const hostile = new Proxy({}, {
      getOwnPropertyDescriptor: () => {
        throw new Error("secret-from-trap")
      }
    })
    expect(render({ message: "failed", cause: hostile })).toBe("[unrenderable]")
  } finally {
    Object.defineProperty(process, "getBuiltinModule", { value: getBuiltinModule, configurable: true, writable: true })
    vi.resetModules()
  }
})
