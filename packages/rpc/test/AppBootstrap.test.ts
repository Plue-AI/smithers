import { describe, expect, test } from "vitest"
import {
  APP_API_VERSION,
  AppBootstrapSchema,
  hasCapability,
  nativeShell,
  RuntimeCapabilitySchema
} from "../src/AppBootstrap.ts"

const cloud = {
  apiVersion: APP_API_VERSION,
  host: "cloud",
  version: "1.0.0",
  buildSha: "abc",
  capabilities: ["identity", "agent"],
  authFlow: "redirect",
  sandbox: null
}

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
    expect(AppBootstrapSchema.safeParse({ ...cloud, apiVersion: 2 }).success).toBe(false)
  })

  test("newer hosts retain known capabilities, their order and duplicates", () => {
    const capabilities = ["workspace", "identity", "workspace.runtime", "agent", "workspace.deploy", "identity"]
    const bootstrap = AppBootstrapSchema.parse({ ...cloud, capabilities })
    expect(bootstrap.capabilities).toEqual(["identity", "agent", "identity"])
    expect(hasCapability(bootstrap, "identity")).toBe(true)
    expect(hasCapability(bootstrap, "agent")).toBe(true)
    expect(hasCapability(bootstrap, "cloud")).toBe(false)
    expect(capabilities).toEqual([
      "workspace",
      "identity",
      "workspace.runtime",
      "agent",
      "workspace.deploy",
      "identity"
    ])
  })

  test("an entirely unknown string capability list is a valid host without known services", () => {
    expect(AppBootstrapSchema.parse({ ...cloud, capabilities: ["future.one", "future.two"] }).capabilities).toEqual([])
  })

  test.each([null, true, 1, {}, [], undefined].map((row) => [row]))(
    "rejects malformed capability rows %j instead of filtering them",
    (row) => {
      expect(AppBootstrapSchema.safeParse({ ...cloud, capabilities: ["identity", row, "future.one"] }).success).toBe(
        false
      )
    }
  )

  test.each([null, {}, "identity", 1])("rejects malformed capability lists %j", (capabilities) => {
    expect(AppBootstrapSchema.safeParse({ ...cloud, capabilities }).success).toBe(false)
  })

  test("all required bootstrap fields remain required", () => {
    for (const key of Object.keys(cloud)) {
      const missing: Record<string, unknown> = { ...cloud }
      delete missing[key]
      expect(AppBootstrapSchema.safeParse(missing).success, key).toBe(false)
    }
  })

  test.each([
    { host: "future-host" },
    { version: 1 },
    { buildSha: null },
    { authFlow: "future-auth" },
    { sandbox: {} },
    { sandbox: { platform: "linux", mode: "future-mode" } },
    { sandbox: { platform: "linux", mode: "enforced", policies: { loader: "future", targetRun: "unenforced" } } }
  ])("unknown capability support does not weaken other fields: %j", (changed) => {
    expect(AppBootstrapSchema.safeParse({ ...cloud, ...changed, capabilities: ["workspace"] }).success).toBe(false)
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
