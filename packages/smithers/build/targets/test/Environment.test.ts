import * as Schema from "effect/Schema"
import { describe, expect, it } from "vitest"
import * as Attr from "../src/Attr.ts"
import * as Environment from "../src/Environment.ts"
import { Smithers } from "../src/index.ts"
import * as Input from "../src/Input.ts"
import * as Target from "../src/Target.ts"
import * as TargetIndex from "../src/TargetIndex.ts"
import { plannedCalls } from "./plan.ts"

const jq = {
  version: "1.7.1",
  url: "https://github.com/jqlang/jq/releases/download/jq-1.7.1/jq-linux-arm64",
  sha256: "4dd2d8a0661df0b22f1bb9a1f9830f06b6f3b8f7d91211a1ef5d7c4f06a8b4a5"
}

const declaration = {
  downloads: { jq },
  rust: { channel: "1.98.0", components: ["clippy"], targets: ["wasm32-wasip1"] },
  postgres: "18",
  destinations: ["github.com", "release-assets.githubusercontent.com"]
}

describe("Attr.Destinations", () => {
  const decode = Schema.decodeUnknownSync(Attr.Destinations)

  it("accepts lowercase DNS names and an empty list", () => {
    expect(decode(["github.com", "mr-z01.tm-azurefd.net", "a.b.c.d"])).toEqual([
      "github.com",
      "mr-z01.tm-azurefd.net",
      "a.b.c.d"
    ])
    expect(decode([])).toEqual([])
  })

  it.each([
    ["a bare label", "localhost"],
    ["uppercase", "GitHub.com"],
    ["a scheme", "https://github.com"],
    ["a port", "github.com:443"],
    ["a wildcard", "*.githubusercontent.com"],
    ["a trailing dot", "github.com."],
    ["a leading hyphen", "-a.example.com"],
    ["a path", "github.com/owner"],
    ["an empty name", ""],
    ["an overlong label", `${"a".repeat(64)}.com`]
  ])("rejects %s", (_name, host) => {
    expect(() => decode([host])).toThrow()
  })
})

describe("S.Environment.Toolchain", () => {
  it("is a verbless data target whose attrs are the declaration", () => {
    const target = Environment.Toolchain(declaration)
    const metadata = Target.metadata(target)
    expect(metadata.target).toBe("Environment.Toolchain")
    expect(metadata.kinds).toEqual([])
    expect(metadata.inputs).toEqual([])
    expect(metadata.dependencies).toEqual([])
    expect(metadata.attrs).toEqual(declaration)
    expect(plannedCalls(target)).toEqual([
      { action: "smithers-build/not-implemented", payload: { target: "Environment.Toolchain" } }
    ])
    expect(Smithers.Environment.Toolchain).toBe(Environment.Toolchain)
  })

  it("projects the index data without the destinations", () => {
    expect(Environment.toolchainData(Target.metadata(Environment.Toolchain(declaration)).attrs as never)).toEqual({
      downloads: { jq },
      rust: declaration.rust,
      postgres: "18"
    })
    const minimal = Environment.Toolchain({ downloads: { jq }, destinations: [] })
    expect(Environment.toolchainData(Target.metadata(minimal).attrs as never)).toEqual({ downloads: { jq } })
  })

  it.each([
    ["an http artifact", { ...declaration, downloads: { jq: { ...jq, url: "http://github.com/jq" } } }],
    ["an uppercase digest", { ...declaration, downloads: { jq: { ...jq, sha256: jq.sha256.toUpperCase() } } }],
    ["a short digest", { ...declaration, downloads: { jq: { ...jq, sha256: "abc" } } }],
    ["an empty version", { ...declaration, downloads: { jq: { ...jq, version: "" } } }],
    ["no destinations", { downloads: { jq } }],
    ["an invalid destination", { ...declaration, destinations: ["https://github.com"] }]
  ])("rejects %s", (_name, attrs) => {
    expect(() => Environment.Toolchain(attrs as never)).toThrow()
  })
})

describe("destinations on download-performing rules", () => {
  const hosts = ["proxy.golang.org"]

  it("are declared attrs of NodeBinary, Install, Go.ModDownload and the Cargo rules", () => {
    const targets = [
      Smithers.NodeBinary({ entry: Input.file("tool.mjs"), args: [], srcs: [], deps: [], destinations: hosts }),
      Smithers.Install({ lockfilePath: "pnpm-lock.yaml", destinations: hosts }),
      Smithers.Go.ModDownload({
        mod: Input.file("go.mod"),
        sum: Input.file("go.sum"),
        outDirs: ["//m"],
        destinations: hosts
      }),
      Smithers.Cargo.Test({ package: "a", destinations: hosts }),
      Smithers.Cargo.Clippy({ package: "a", destinations: hosts })
    ]
    for (const target of targets) {
      expect((Target.metadata(target).attrs as { destinations?: unknown }).destinations).toEqual(hosts)
    }
  })

  it("reject a malformed host", () => {
    expect(() =>
      Smithers.NodeBinary({ entry: Input.file("t.mjs"), args: [], srcs: [], deps: [], destinations: ["Bad Host"] })
    )
      .toThrow()
  })

  it("are part of the checked-in row schema", () => {
    const decode = Schema.decodeUnknownSync(TargetIndex.Row)
    const base = {
      label: "//:t",
      package: "",
      name: "t",
      rule: "NodeBinary",
      kinds: ["build"],
      cacheable: false,
      inputs: [],
      outputs: [],
      dependencies: []
    }
    expect(decode({ ...base, destinations: ["github.com"] }).destinations).toEqual(["github.com"])
    expect(decode({ ...base, toolchain: { downloads: { jq } } }).toolchain).toEqual({ downloads: { jq } })
    expect(() => decode({ ...base, destinations: ["not a host"] })).toThrow()
  })
})
