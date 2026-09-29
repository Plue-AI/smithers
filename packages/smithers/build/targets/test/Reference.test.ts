/**
 * Constructors for inert MCP and payload-input references.
 *
 * These declarations cross from author code into target attrs, so each one
 * must validate bounded names, freeze its result, and let callable reference
 * surfaces fall back to ordinary function properties without minting refs.
 */
import { describe, expect, it } from "vitest"
import * as Reference from "../src/Reference.ts"

describe("Mcp.Http", () => {
  it("declares and freezes the exact server name and URL", () => {
    const server = Reference.Mcp.Http("github", "https://mcp.example.test/github")

    expect(server).toEqual({
      _tag: "McpHttp",
      name: "github",
      url: "https://mcp.example.test/github"
    })
    expect(Object.isFrozen(server)).toBe(true)
  })

  it.each([
    ["", "https://mcp.example.test", "Mcp.Http name"],
    ["github", "", "Mcp.Http url"]
  ])("refuses an empty declared endpoint field", (name, url, field) => {
    expect(() => Reference.Mcp.Http(name, url)).toThrow(new RegExp(field))
  })
})

describe("bounded names", () => {
  const constructors: ReadonlyArray<[string, (value: string) => unknown, string]> = [
    ["NodeModule", Reference.NodeModule, "NodeModule package"],
    ["NodeModule.Bin package", (value) => Reference.NodeModule.Bin(value, "cli"), "NodeModule.Bin package"],
    ["NodeModule.Bin binary", (value) => Reference.NodeModule.Bin("pkg", value), "NodeModule.Bin binary"],
    ["hostBin", Reference.hostBin, "Host.bin name"],
    ["runtimeNpx", Reference.runtimeNpx, "Runtime.npx spec"],
    ["miseBin", Reference.miseBin, "Mise.bin name"],
    ["goRun", Reference.goRun, "Go.run spec"],
    ["nixBin", Reference.nixBin, "Nix.bin name"],
    ["symlink", Reference.symlink, "symlink path"],
    ["gitCommit", Reference.gitCommit, "gitCommit ref"]
  ]
  const refused: ReadonlyArray<[string, string]> = [
    ["empty", ""],
    ["whitespace only", "  "],
    ["over 512 code units", "x".repeat(513)],
    ["control character", "a\u0000b"],
    ["lone surrogate", "\ud800"]
  ]

  describe.each(constructors)("%s", (_, construct, field) => {
    it.each(refused)("refuses %s text naming the field", (_, value) => {
      expect(() => construct(value)).toThrow(new RegExp(field))
    })

    it("trims surrounding whitespace and keeps 512 code units", () => {
      const longest = "x".repeat(512)
      expect(JSON.stringify(construct(`  ${longest}  `))).toContain(JSON.stringify(longest))
    })
  })

  it("keeps the binary name only when NodeModule.Bin is given one", () => {
    expect(Reference.NodeModule.Bin("typescript", " tsc ")).toEqual({
      _tag: "NodeModuleBin",
      package: "typescript",
      bin: "tsc"
    })
    expect(Reference.NodeModule.Bin("typescript")).toEqual({ _tag: "NodeModuleBin", package: "typescript" })
  })

  it("keeps a Host.bin selecting variable only when given one, and only a portable name", () => {
    expect(Reference.hostBin("jj")).toEqual({ _tag: "HostBin", name: "jj" })
    const selected = Reference.hostBin(" exporter ", { env: "EXPORTER_BINARY" })
    expect(selected).toEqual({ _tag: "HostBin", name: "exporter", env: "EXPORTER_BINARY" })
    expect(Object.isFrozen(selected)).toBe(true)
    for (const env of ["", "1ST", "A-B", "A B", "A=B"]) {
      expect(() => Reference.hostBin("exporter", { env })).toThrow()
    }
  })
})

describe("callableReferences", () => {
  it("mints references only for portable, non-reserved, absent string properties", () => {
    const minted: Array<string> = []
    const constructor = Object.assign(() => "called", { existing: "kept" })
    const surface = Reference.callableReferences(constructor, (name) => {
      minted.push(name)
      return { name }
    })

    expect(surface.luna).toEqual({ name: "luna" })
    expect(surface.existing).toBe("kept")
    expect(surface.name).toBe(constructor.name)
    expect(surface.then).toBeUndefined()
    expect(surface["bad name"]).toBeUndefined()
    expect(Reflect.get(surface, Symbol.toStringTag)).toBeUndefined()
    expect(minted).toEqual(["luna"])
  })
})

describe("payload input declarations", () => {
  it("freezes string, literal, and optional input specifications", () => {
    const string = Reference.inputString("release identifier")
    const literals = Reference.inputLiterals(["preview", "production"])
    const optional = Reference.inputOptional(literals)

    expect(string).toEqual({ _tag: "InputString", description: "release identifier" })
    expect(literals).toEqual({ _tag: "InputLiterals", values: ["preview", "production"] })
    expect(optional).toEqual({ _tag: "InputOptional", inner: literals })
    expect(Object.isFrozen(string)).toBe(true)
    expect(Object.isFrozen(literals)).toBe(true)
    expect(Object.isFrozen(optional)).toBe(true)
  })

  it("validates every literal before constructing the list", () => {
    expect(() => Reference.inputLiterals(["preview", ""])).toThrow(/Input.Literals value/)
    expect(() => Reference.inputOptional(Reference.inputOptional(Reference.inputString("nested")) as never))
      .toThrow()
  })
})
