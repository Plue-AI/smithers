import { describe, expect, test } from "vitest"
import {
  LSP_DIAGNOSTICS_CAP,
  LSP_HOVER_CAP_CHARS,
  LSP_LANGUAGE_SERVER_MISSING,
  LSP_LOCATIONS_CAP,
  LSP_SEVERITIES,
  LspDefinitionResponseSchema,
  LspDiagnosticSchema,
  LspDiagnosticsMessageSchema,
  LspDiagnosticsResponseSchema,
  LspErrorResponseSchema,
  LspFileRequestSchema,
  LspHoverResponseSchema,
  lspLanguageFor,
  LspLocationSchema,
  LspPositionRequestSchema,
  LspRangeSchema,
  LspServersResponseSchema,
  LspSeveritySchema
} from "../src/LocalLsp.ts"

/*
 * Code intelligence on the local origin (apps/app/docs/code-intel/PLAN.md §3):
 * positions are 1-based on the wire, paths are repository-relative, and the
 * host's caps are the schemas' bounds, so an answer past them fails to parse
 * instead of rendering.
 */
describe("the code-intelligence wire model", () => {
  const position = { repoId: "r1", path: "src/index.ts", line: 12, character: 5 }
  const range = { line: 12, character: 5, endLine: 12, endCharacter: 9 }
  const diagnostic = { ...range, severity: "error" as const, message: "boom", source: "ts", code: "2551" }
  const digest = "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08"

  test("a position request is 1-based and carries nothing the routes did not ask for", () => {
    expect(LspPositionRequestSchema.parse(position)).toEqual(position)
    expect(LspPositionRequestSchema.safeParse({ ...position, line: 0 }).success).toBe(false)
    expect(LspPositionRequestSchema.safeParse({ ...position, character: 0 }).success).toBe(false)
    expect(LspPositionRequestSchema.safeParse({ ...position, line: 1.5 }).success).toBe(false)
    expect(LspPositionRequestSchema.safeParse({ ...position, cwd: "/" }).success).toBe(false)
    expect(LspFileRequestSchema.parse({ repoId: "r1", path: "src/index.ts" })).toEqual({
      repoId: "r1",
      path: "src/index.ts"
    })
    expect(LspFileRequestSchema.safeParse({ repoId: "r1", path: "" }).success).toBe(false)
    expect(LspFileRequestSchema.safeParse({ repoId: "r1", path: "a".repeat(4097) }).success).toBe(false)
    for (
      const path of [
        "/etc/passwd",
        "../secrets",
        "src/../../x",
        "./src/a.ts",
        "src//a.ts",
        "src\\a.ts",
        "a\u0000b",
        "src/"
      ]
    ) {
      expect(LspFileRequestSchema.safeParse({ repoId: "r1", path }).success).toBe(false)
      expect(LspPositionRequestSchema.safeParse({ ...position, path }).success).toBe(false)
    }
    expect(LspFileRequestSchema.safeParse({ repoId: "r1", path: "src/a b#c%2e:d.ts" }).success).toBe(true)
  })

  test("a range is four 1-based ordinals, a location is a repository-relative path plus that range, and severity is a closed set", () => {
    expect(LspRangeSchema.parse(range)).toEqual(range)
    // Every ordinal is whole and at least 1; column 0 and a fractional line are protocol errors, not "near enough".
    for (const key of ["line", "character", "endLine", "endCharacter"] as const) {
      expect(LspRangeSchema.safeParse({ ...range, [key]: 0 }).success).toBe(false)
      expect(LspRangeSchema.safeParse({ ...range, [key]: 1.5 }).success).toBe(false)
    }
    const location = { path: "src/lib.ts", ...range }
    expect(LspLocationSchema.parse(location)).toEqual(location)
    expect(LspLocationSchema.safeParse({ ...location, path: "" }).success).toBe(false)
    expect(LspLocationSchema.safeParse(range).success).toBe(false)
    expect(LSP_SEVERITIES).toEqual(["error", "warning", "information", "hint"])
    for (const severity of LSP_SEVERITIES) expect(LspSeveritySchema.parse(severity)).toBe(severity)
    expect(LspSeveritySchema.safeParse("fatal").success).toBe(false)
  })

  test("a hover is the server's markdown cut at the cap and says when it was cut, or null when the server had nothing there", () => {
    expect(LspHoverResponseSchema.parse({ hover: null, digest })).toEqual({ hover: null, digest })
    const hover = { contents: "const x: number", truncated: false, range }
    expect(LspHoverResponseSchema.parse({ hover, digest })).toEqual({ hover, digest })
    expect(
      LspHoverResponseSchema.safeParse({
        hover: { contents: "x".repeat(LSP_HOVER_CAP_CHARS + 1), truncated: true },
        digest
      }).success
    ).toBe(false)
    // The cut is stated, never inferred from the length; an answer without a digest names no file.
    expect(LspHoverResponseSchema.safeParse({ hover: { contents: "x" }, digest }).success).toBe(false)
    expect(LspHoverResponseSchema.safeParse({ hover }).success).toBe(false)
  })

  test("definitions are repository-relative locations, at most the cap, with the server's total and the count outside the repository", () => {
    const location = { path: "src/lib.ts", ...range }
    expect(LspDefinitionResponseSchema.parse({ locations: [location], total: 1, omitted: 0, digest }).locations)
      .toEqual([location])
    // An empty list with omitted targets is a definition elsewhere, and the shape carries that fact.
    expect(LspDefinitionResponseSchema.parse({ locations: [], total: 1, omitted: 1, digest }).omitted).toBe(1)
    expect(LspDefinitionResponseSchema.safeParse({ locations: [], digest }).success).toBe(false)
    expect(
      LspDefinitionResponseSchema.safeParse({
        locations: Array.from({ length: LSP_LOCATIONS_CAP + 1 }, () => location),
        total: 21,
        omitted: 0,
        digest
      }).success
    )
      .toBe(false)
  })

  test("diagnostics distinguish an empty publication from none within the wait, and carry the total behind the cap", () => {
    expect(
      LspDiagnosticsResponseSchema.parse({ path: "src/index.ts", version: 1, items: [diagnostic], total: 1, digest })
        .items
    ).toEqual([diagnostic])
    expect(LspDiagnosticsResponseSchema.parse({ path: "src/index.ts", version: 2, items: [], total: 0, digest }).items)
      .toEqual([])
    expect(
      LspDiagnosticsResponseSchema.parse({ path: "src/index.ts", version: null, items: null, total: null, digest })
        .items
    ).toBeNull()
    expect(
      LspDiagnosticsResponseSchema.parse({ path: "src/index.ts", version: 1, items: [diagnostic], total: 132, digest })
        .total
    ).toBe(132)
    expect(
      LspDiagnosticsResponseSchema.safeParse({ path: "src/index.ts", version: 1, items: [diagnostic], digest }).success
    ).toBe(false)
    expect(
      LspDiagnosticsResponseSchema.safeParse({
        path: "src/index.ts",
        version: 1,
        items: Array.from({ length: LSP_DIAGNOSTICS_CAP + 1 }, () => diagnostic),
        total: LSP_DIAGNOSTICS_CAP + 1,
        digest
      }).success
    ).toBe(false)
    expect(LspDiagnosticSchema.safeParse({ ...diagnostic, severity: 1 }).success).toBe(false)
  })

  test("the language table names the extensions each server handles, so the renderer knows which cards code intelligence serves", () => {
    expect(lspLanguageFor("src/App.tsx")).toBe("typescript")
    expect(lspLanguageFor("lib/index.MJS")).toBe("typescript")
    expect(lspLanguageFor("README.md")).toBeNull()
    expect(lspLanguageFor("package.json")).toBeNull()
    expect(lspLanguageFor("Makefile")).toBeNull()
  })

  test("the bus frame and the server list carry the same shapes", () => {
    const frame = {
      type: "lsp.diagnostics" as const,
      repoId: "r1",
      path: "src/index.ts",
      version: 3,
      items: [diagnostic],
      total: 3,
      digest
    }
    expect(LspDiagnosticsMessageSchema.parse(frame)).toEqual(frame)
    expect(
      LspServersResponseSchema.parse({ servers: [{ repoId: "r1", language: "typescript", state: "ready" }] }).servers[0]
        ?.state
    )
      .toBe("ready")
    expect(
      LspServersResponseSchema.safeParse({ servers: [{ repoId: "r1", language: "cobol", state: "ready" }] }).success
    ).toBe(false)
  })

  test("a failure names its code, and a missing server carries the install line verbatim", () => {
    const missing = LspErrorResponseSchema.parse({
      error: {
        code: LSP_LANGUAGE_SERVER_MISSING,
        message: "No TypeScript language server on this machine.",
        install: "npm i -g typescript-language-server typescript"
      }
    })
    expect(missing.error.code).toBe("language_server_missing")
    expect(missing.error.install).toBe("npm i -g typescript-language-server typescript")
    expect(LspErrorResponseSchema.parse({ error: { code: "timeout", message: "No answer within 5 s." } }).error.install)
      .toBeUndefined()
  })
})
