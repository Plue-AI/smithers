import { describe, expect, test } from "bun:test"
import { realHost } from "./host"

describe("real host bootstrap classification", () => {

  test("keeps hosted redirect and combined sign-in flows in production", () => {
    for (const authFlow of ["redirect", "both"]) {
      expect(realHost({ host: "cloud", authFlow })).toBe("production")
    }
  })

  test("classifies self-hosting by install capability independently of sign-in", () => {
    for (const authFlow of ["credentials", "redirect", "both", undefined]) {
      expect(realHost({ host: "cloud", authFlow, capabilities: ["install"] })).toBe("local")
    }
    for (const authFlow of ["credentials", "none", undefined, "future-auth-flow"]) {
      expect(realHost({ host: "cloud", authFlow })).toBe("production")
    }
  })

  test("does not accept malformed capabilities", () => {
    for (const capabilities of [null, "install", {}, ["other"]]) expect(realHost({ host: "cloud", capabilities })).toBe("production")
    expect(realHost({ host: "local" })).toBe("local")
  })

  test("refuses unsupported identities even when credentials are advertised", () => {
    for (const host of [undefined, null, "production", "unknown", 1]) {
      expect(realHost({ host, authFlow: "credentials" })).toBeUndefined()
    }
  })
})
