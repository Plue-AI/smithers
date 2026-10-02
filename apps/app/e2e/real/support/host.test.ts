import { describe, expect, test } from "bun:test"
import { realHost } from "./host"

describe("real host bootstrap classification", () => {

  test("keeps hosted redirect and combined sign-in flows in production", () => {
    for (const authFlow of ["redirect", "both"]) {
      expect(realHost({ host: "cloud", authFlow })).toBe("production")
    }
  })

  test("requires explicit owner credentials to classify a cloud API as self-hosted", () => {
    expect(realHost({ host: "cloud", authFlow: "credentials" })).toBe("local")
    for (const authFlow of ["none", undefined, "future-auth-flow"]) {
      expect(realHost({ host: "cloud", authFlow })).toBe("production")
    }
  })

  test("refuses unsupported identities even when credentials are advertised", () => {
    for (const host of [undefined, null, "production", "unknown", 1]) {
      expect(realHost({ host, authFlow: "credentials" })).toBeUndefined()
    }
  })
})
