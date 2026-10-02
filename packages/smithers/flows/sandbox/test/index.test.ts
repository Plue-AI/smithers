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
      "SandboxMerge",
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
      "CaptureError",
      "Changed",
      "JobHandle",
      "JobResult",
      "Provider",
      "Sandboxed",
      "TestSession",
      "Unchanged",
      "Work",
      "capture",
      "commandProvider",
      "fanOut",
      "fileSystem",
      "hostContext",
      "job",
      "layerHost",
      "maxFanOut",
      "resolveBase",
      "run"
    ])
  })

  /**
   * The host half of a session's work: applying it knows no provider, and the
   * machine half knows no merge strategy.
   */
  it("exposes the host merge of a session's work beside its strategies", () => {
    expect(Object.keys(Sandbox.SandboxMerge).sort()).toEqual([
      "Conflicted",
      "MergeError",
      "Merged",
      "Outcome",
      "apply",
      "changeIdOf",
      "failOnConflict",
      "recordConflicts",
      "resolveWith"
    ])
  })

  it("exposes the session conformance suite and the work seed it checks capture against", () => {
    expect(Object.keys(Sandbox.SandboxConformance).sort()).toEqual([
      "check",
      "posixCommands",
      "uniquePosixCommands",
      "workSeedFiles"
    ])
    // `WorkSeed` is a type; naming it here fails the type check if the barrel drops it.
    const seed: Sandbox.SandboxConformance.WorkSeed = { bundle: new Uint8Array(), base: "" }
    expect(seed.base).toBe("")
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
    // A journaled `Sandboxed` result records the work, and an outcome its tag, by these strings.
    expect(new Sandbox.Sandbox.Changed({ session: "s", base: "b", patch: "p" })._tag).toBe("Changed")
    expect(new Sandbox.Sandbox.Unchanged({ session: "s", base: "b" })._tag).toBe("Unchanged")
    expect(new Sandbox.Sandbox.CaptureError({ reason: "capture_failed", message: "x" })._tag)
      .toBe("@smthrs/sandbox/Sandbox/CaptureError")
    expect(new Sandbox.SandboxMerge.Merged({ change: "c", commit: "x", onto: "o" })._tag).toBe("Merged")
    expect(new Sandbox.SandboxMerge.Conflicted({ change: "c", commit: "x", onto: "o", paths: [] })._tag)
      .toBe("Conflicted")
    expect(new Sandbox.SandboxMerge.MergeError({ reason: "conflict", message: "x" })._tag)
      .toBe("@smthrs/sandbox/SandboxMerge/MergeError")
  })
})
