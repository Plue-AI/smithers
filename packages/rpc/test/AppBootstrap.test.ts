import { describe, expect, test } from "vitest"
import {
  APP_API_VERSION,
  AppBootstrapSchema,
  hasCapability,
  nativeShell,
  RuntimeCapabilitySchema
} from "../src/AppBootstrap.ts"

describe("app bootstrap contract", () => {
  test("validates a local offline host without inventing cloud services", () => {
    const bootstrap = AppBootstrapSchema.parse({
      apiVersion: APP_API_VERSION,
      host: "local",
      version: "1.0.0",
      buildSha: "abc",
      capabilities: [],
      authFlow: "none",
      sandbox: { platform: "darwin", mode: "enforced" }
    })
    expect(hasCapability(bootstrap, "cloud")).toBe(false)
    expect(hasCapability(bootstrap, "agent")).toBe(false)
  })

  test("rejects an API version the client does not understand", () => {
    expect(AppBootstrapSchema.safeParse({ apiVersion: 2 }).success).toBe(false)
  })
})

describe("runtime capabilities", () => {
  test("names the two cloud doors and rejects a capability no host emits", () => {
    expect(RuntimeCapabilitySchema.parse("cloud.terminal")).toBe("cloud.terminal")
    expect(RuntimeCapabilitySchema.parse("cloud.pat")).toBe("cloud.pat")
    expect(RuntimeCapabilitySchema.safeParse("cloud.unknown").success).toBe(false)
  })

  test("native.shell is the desktop shell's row: a self-hosted web bootstrap never carries it", () => {
    // The Go backend's self-host answer (packages/backend/internal/compose/bootstrap.go): a web origin with owner credentials.
    const selfHost = AppBootstrapSchema.parse({
      apiVersion: APP_API_VERSION,
      host: "cloud",
      version: "dev",
      buildSha: "abc",
      capabilities: ["identity", "cloud", "cloud.terminal"],
      authFlow: "credentials",
      sandbox: { platform: "darwin", mode: "trusted-only" }
    })
    expect(nativeShell(selfHost)).toBe(false)
    expect(nativeShell(undefined)).toBe(false)
    expect(nativeShell({ capabilities: ["native.shell"] })).toBe(true)
    expect(RuntimeCapabilitySchema.parse("native.shell")).toBe("native.shell")
  })

  test("the retired local backend's doors are no longer capabilities any host can name", () => {
    for (const retired of ["local.lsp", "local.targets", "local.terminal", "local.harnesses", "local.repositories"]) {
      expect(RuntimeCapabilitySchema.safeParse(retired).success).toBe(false)
    }
  })
})
