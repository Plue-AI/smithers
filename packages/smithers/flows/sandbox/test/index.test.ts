/**
 * The package barrel. Every consumer imports through it, so its namespace
 * re-exports are part of the public contract: a renamed or dropped module here
 * breaks callers without any single module's own tests noticing.
 */
import { describe, expect, it } from "vitest"
import * as Sandbox from "../src/index.ts"

describe("@smthrs/sandbox barrel", () => {
  it("re-exports every module as its own namespace", () => {
    expect(Object.keys(Sandbox).sort()).toEqual([
      "AwsSandbox",
      "CloudflareSandbox",
      "CommandSandbox",
      "ContainerSandbox",
      "DaytonaSandbox",
      "DirectorySandbox",
      "JustBashSandbox",
      "KubernetesSandbox",
      "MicrosandboxSandbox",
      "ProviderConformance",
      "RemoteChildProcessSpawner",
      "Sandbox",
      "SandboxConformance",
      "SandboxHealth",
      "SandboxSupervision",
      "VercelSandbox"
    ])
  })

  /**
   * The engine takes a `Sandbox.Provider` value and never resolves a name, so
   * the namespace holds the machine contract and its projections and no name
   * registry beside them.
   */
  it("exposes the machine contract and its projections, and no name registry", () => {
    expect(Object.keys(Sandbox.Sandbox).sort()).toEqual([
      "Provider",
      "TestSession",
      "commandProvider",
      "fanOut",
      "fileSystem",
      "layerHost",
      "maxFanOut"
    ])
  })

  /**
   * The schema `_tag`s round-trip through the journal, so renames here
   * invalidate recorded runs.
   */
  it("pins the identity strings the durable record depends on", () => {
    expect(Sandbox.SandboxHealth.SandboxHealth.key).toBe("@smthrs/sandbox/SandboxHealth")
    expect(Sandbox.RemoteChildProcessSpawner.Provider.key).toBe(
      "@smthrs/sandbox/RemoteChildProcessSpawner/Provider"
    )
    expect(new Sandbox.RemoteChildProcessSpawner.ProviderError({ code: "unknown", message: "x" })._tag)
      .toBe("@smthrs/sandbox/RemoteChildProcessSpawner/ProviderError")
    expect(
      new Sandbox.SandboxSupervision.SandboxUnhealthy({ session: "s", reason: "ping_failed", probes: 1 })._tag
    ).toBe("sandbox-unhealthy")
    expect(Sandbox.Sandbox.Provider.key).toBe("@smthrs/sandbox/Sandbox/Provider")
  })
})
