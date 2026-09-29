import { describe, expect, it } from "vitest"
import * as Kernel from "../src/index.ts"

describe("kernel package barrel", () => {
  it("exports every public namespace", () => {
    expect(Object.keys(Kernel).sort()).toEqual([
      "Capability",
      "CapabilitySet",
      "ChildProcessEnvironment",
      "ChildProcessSpawner",
      "CommandLine",
      "ContainedSpawner",
      "FileSystem",
      "GrantEvent",
      "GrantStore",
      "HostServices",
      "HttpClient",
      "Jj",
      "JournalGrantStore",
      "Path",
      "Permission",
      "ProcessConfinement",
      "ProcessLedger",
      "Rooted",
      "Workspace"
    ])
  })
})
