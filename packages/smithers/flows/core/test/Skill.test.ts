import * as Result from "effect/Result"
import { describe, expect, it } from "vitest"
import * as Markdown from "../src/Markdown.ts"

const parse = (text: string): Markdown.SkillDocument => Result.getOrThrow(Markdown.parseSkill(text))

const errorCode = (text: string): Markdown.MarkdownErrorCode => {
  const result = Markdown.parseSkill(text)
  expect(Result.isFailure(result)).toBe(true)
  return Result.isFailure(result) ? result.failure.code : "skill_invalid_frontmatter"
}

const failure = (text: string): Markdown.MarkdownError => {
  const result = Markdown.parseSkill(text)
  if (Result.isSuccess(result)) throw new Error("expected parseSkill to fail")
  return result.failure
}

const document = (frontmatter: ReadonlyArray<string>): string => ["---", ...frontmatter, "---", "Prompt"].join("\n")

describe("Skill", () => {
  it("parses quoted scalars and a whitespace-separated hyphenated allowed-tools key", () => {
    const skill = parse(
      "---\nname: 'pdf-tools'\ndescription: \"Extract\\nfiles\"\nallowed-tools: Read Bash(pdfinfo:*)\n---\nPrompt"
    )

    expect(skill).toMatchObject({
      name: "pdf-tools",
      description: "Extract\nfiles",
      allowedTools: ["Read", "Bash(pdfinfo:*)"]
    })
  })

  it("rejects a flow sequence for allowed-tools because the specification requires a scalar", () => {
    const error = failure(
      "---\nname: pdf\ndescription: Extract files\nallowed-tools: [Read, \"Write\", 'Bash(qpdf:*)']\n---\nPrompt"
    )

    expect(error.code).toBe("skill_invalid_allowed_tools")
    expect(error.message).toBe("SKILL.md allowed-tools must be a space-separated scalar")
  })

  it("rejects a block sequence for allowed-tools", () => {
    expect(
      errorCode(
        "---\nname: pdf\ndescription: Extract files\nallowed-tools:\n  - Read\n  - 'Bash(pdfinfo:*)'\n---\nPrompt"
      )
    )
      .toBe("skill_invalid_allowed_tools")
  })

  it("lowers an empty allowed-tools scalar to no tools", () => {
    expect(parse(document(["name: pdf", "description: Extract files", "allowed-tools: \"\""])).allowedTools).toEqual([])
  })

  it("accepts a name at the 64 character boundary and rejects 65", () => {
    const boundary = "a".repeat(64)

    expect(parse(document([`name: ${boundary}`, "description: d"])).name).toBe(boundary)
    expect(errorCode(document([`name: ${boundary}a`, "description: d"]))).toBe("skill_invalid_name")
  })

  it.each([
    ["uppercase letters", "PDF-Processing"],
    ["a leading hyphen", "-pdf"],
    ["a trailing hyphen", "pdf-"],
    ["consecutive hyphens", "pdf--processing"],
    ["an underscore", "pdf_processing"],
    ["an apostrophe", "'pdf''s'"],
    ["inner whitespace", "'pdf processing'"],
    ["a non-ASCII lowercase letter", "café"]
  ])("rejects a name with %s without echoing it", (_, name) => {
    const error = failure(document([`name: ${name}`, "description: d"]))

    expect(error.code).toBe("skill_invalid_name")
    expect(error.message).toBe(
      "SKILL.md name must be 1 to 64 lowercase ASCII letters, digits, or single hyphens, and cannot start or end with a hyphen"
    )
    expect(error.message).not.toContain(name.replaceAll("'", ""))
  })

  it("rejects a mapping-valued name as invalid rather than missing", () => {
    expect(errorCode(document(["name:", "  nested: value", "description: d"]))).toBe("skill_invalid_name")
  })

  it("treats an empty name scalar as missing", () => {
    expect(errorCode(document(["name:", "description: d"]))).toBe("skill_missing_name")
    expect(errorCode(document(["name: '  '", "description: d"]))).toBe("skill_missing_name")
  })

  it("treats an empty description scalar as missing", () => {
    expect(errorCode(document(["name: pdf", "description:"]))).toBe("skill_missing_description")
    expect(errorCode(document(["name: pdf", "description: '  '"]))).toBe("skill_missing_description")
  })

  it("validates already-parsed frontmatter without a document", () => {
    const valid = Markdown.validateSkillFrontmatter({
      name: "pdf-tools",
      description: "Extract files",
      "allowed-tools": "Read  Bash(pdfinfo:*)",
      license: "MIT",
      metadata: { author: "me" }
    })
    expect(valid).toMatchObject({
      _tag: "Success",
      success: {
        name: "pdf-tools",
        description: "Extract files",
        allowedTools: ["Read", "Bash(pdfinfo:*)"],
        extra: { license: "MIT", metadata: { author: "me" } }
      }
    })
    if (Result.isSuccess(valid)) {
      expect(Object.getPrototypeOf(valid.success.extra)).toBeNull()
      expect(Object.isFrozen(valid.success.extra)).toBe(true)
      expect(Object.keys(valid.success.extra)).toEqual(["license", "metadata"])
    }

    // Directory-name equality is the registry's rule, so a spec-valid name
    // passes here whatever directory the document came from.
    expect(Result.isSuccess(Markdown.validateSkillFrontmatter({ name: "other", description: "d" }))).toBe(true)
    expect(Markdown.validateSkillFrontmatter({ description: "d" })).toMatchObject({
      _tag: "Failure",
      failure: { code: "skill_missing_name" }
    })
    expect(Markdown.validateSkillFrontmatter({ name: ["pdf"], description: "d" })).toMatchObject({
      _tag: "Failure",
      failure: { code: "skill_invalid_name" }
    })
  })

  it("counts description length in Unicode code points at the 1024 boundary", () => {
    const boundary = "\u{1F600}".repeat(1024)

    expect(boundary.length).toBe(2048)
    expect(parse(document(["name: pdf", `description: "${boundary}"`])).description).toBe(boundary)
    const error = failure(document(["name: pdf", `description: "${boundary}\u{1F600}"`]))
    expect(error.code).toBe("skill_invalid_description")
    expect(error.message).toBe("SKILL.md description must be a scalar of 1 to 1024 characters")
  })

  it("rejects a mapping-valued description as invalid rather than missing", () => {
    expect(errorCode(document(["name: pdf", "description:", "  nested: value"]))).toBe("skill_invalid_description")
  })

  it("checks compatibility length at the 500 character boundary when present", () => {
    const boundary = "c".repeat(500)

    expect(parse(document(["name: pdf", "description: d", `compatibility: ${boundary}`])).extra.compatibility)
      .toBe(boundary)
    expect(errorCode(document(["name: pdf", "description: d", `compatibility: ${boundary}c`])))
      .toBe("skill_invalid_compatibility")
    expect(errorCode(document(["name: pdf", "description: d", "compatibility: \"\""])))
      .toBe("skill_invalid_compatibility")
    const error = failure(document(["name: pdf", "description: d", "compatibility:", "  - git"]))
    expect(error.code).toBe("skill_invalid_compatibility")
    expect(error.message).toBe("SKILL.md compatibility must be a scalar of 1 to 500 characters")
  })

  it("requires metadata to map string keys to scalar values", () => {
    const valid = parse(document(["name: pdf", "description: d", "metadata:", "  author: me", "  version: \"1.0\""]))
    expect(valid.extra.metadata).toEqual({ author: "me", version: "1.0" })

    const nested = failure(document(["name: pdf", "description: d", "metadata:", "  author:", "    name: me"]))
    expect(nested.code).toBe("skill_invalid_metadata")
    expect(nested.message).toBe("SKILL.md metadata must be a mapping from string keys to scalar values")
    expect(errorCode(document(["name: pdf", "description: d", "metadata:", "  - author"]))).toBe(
      "skill_invalid_metadata"
    )
    expect(errorCode(document(["name: pdf", "description: d", "metadata: loose"]))).toBe("skill_invalid_metadata")
  })

  it("requires license to be a scalar when present", () => {
    expect(parse(document(["name: pdf", "description: d", "license: Apache-2.0"])).extra.license).toBe("Apache-2.0")
    const error = failure(document(["name: pdf", "description: d", "license:", "  spdx: MIT"]))
    expect(error.code).toBe("skill_invalid_license")
    expect(error.message).toBe("SKILL.md license must be a scalar")
  })

  it("parses folded and literal YAML block scalars", () => {
    const skill = parse([
      "---",
      "name: document-review",
      "description: >-",
      "  Reviews a document for correctness,",
      "  clarity, and missing evidence.",
      "allowed-tools: >-",
      "  Read",
      "  Grep",
      "metadata:",
      "  instructions: |-",
      "    Keep citations.",
      "    Report uncertainty.",
      "---",
      "Review the supplied document."
    ].join("\n"))

    expect(skill.description).toBe("Reviews a document for correctness, clarity, and missing evidence.")
    expect(skill.allowedTools).toEqual(["Read", "Grep"])
    expect(skill.extra.metadata).toEqual({
      instructions: "Keep citations.\nReport uncertainty."
    })
  })

  it("accepts a UTF-8 BOM and CRLF fences without normalizing the body", () => {
    const skill = parse(
      "\uFEFF---\r\nname: pdf\r\ndescription: Extract files\r\nallowed-tools: Read Write\r\n---\r\nLine one\r\n\r\nLine two"
    )

    expect(skill.allowedTools).toEqual(["Read", "Write"])
    expect(skill.body).toBe("Line one\r\n\r\nLine two")
  })

  it("fails when frontmatter is missing", () => {
    expect(errorCode("# PDF\n")).toBe("skill_missing_frontmatter")
  })

  it("fails when name is missing", () => {
    expect(errorCode("---\ndescription: Extract files\n---\nPrompt")).toBe("skill_missing_name")
  })

  it("fails when description is missing", () => {
    expect(errorCode("---\nname: pdf\n---\nPrompt")).toBe("skill_missing_description")
  })

  it("fails malformed frontmatter without throwing", () => {
    expect(errorCode("---\nname: 'pdf\ndescription: Extract files\n---\nPrompt")).toBe("skill_invalid_frontmatter")
  })

  it("redacts source text from bounded YAML parser diagnostics", () => {
    const result = Markdown.parseSkill(
      "---\nname: n\ndescription: d\nmetadata: [sk-live-SECRETVALUE\n---\nPrompt"
    )

    expect(Result.isFailure(result)).toBe(true)
    if (Result.isSuccess(result)) return
    expect(result.failure.code).toBe("skill_invalid_frontmatter")
    expect(result.failure.message).not.toContain("sk-live-SECRETVALUE")
    expect(result.failure.message).toContain("line 4")
    expect(result.failure.message.length).toBeLessThanOrEqual(200)
  })

  describe.each(["parseSkill", "lowerSkill"] as const)("%s YAML aliases", (entrypoint) => {
    it.each([
      ["unresolved alias", ["extra: *sk-live-SECRETVALUE"]],
      ["forward alias", ["extra: *sk-live-SECRETVALUE", "anchor: &sk-live-SECRETVALUE value"]],
      ["alias expansion limit", [
        "a: &a [sk-live-SECRETVALUE,x,x,x,x,x,x,x,x,x]",
        "b: &b [*a,*a,*a,*a,*a,*a,*a,*a,*a,*a]",
        "c: [*b,*b,*b,*b,*b,*b,*b,*b,*b,*b]"
      ]]
    ])("returns a bounded, redacted failure for %s", (_, fields) => {
      const result: Result.Result<unknown, Markdown.MarkdownError> = Markdown[entrypoint](
        document(["name: example", "description: Example", ...fields])
      )

      expect(Result.isFailure(result)).toBe(true)
      if (Result.isSuccess(result)) return
      expect(result.failure).toBeInstanceOf(Markdown.MarkdownError)
      expect(result.failure.code).toBe("skill_invalid_frontmatter")
      expect(result.failure.message).toBe("Skill frontmatter could not be parsed or converted from YAML")
      expect(result.failure.message).not.toContain("sk-live-SECRETVALUE")
      expect(result.failure.message.length).toBeLessThanOrEqual(200)
    })

    it("accepts a resolved alias below the expansion limit", () => {
      const result: Result.Result<unknown, Markdown.MarkdownError> = Markdown[entrypoint](
        document(["name: example", "description: &description Example", "extra: *description"])
      )

      expect(Result.isSuccess(result)).toBe(true)
    })
  })

  it("keeps the stable code for a second malformed YAML document", () => {
    expect(errorCode("---\nname: n\ndescription: d\nmetadata: {unterminated\n---\nPrompt")).toBe(
      "skill_invalid_frontmatter"
    )
  })

  it.each([
    ["__proto__", ["__proto__:", "  admin: yes"]],
    ["constructor", ["constructor: construct"]],
    ["prototype", ["prototype:", "  enabled: true"]],
    ["__proto__", ["nested:", "  - __proto__:", "      admin: yes"]],
    ["constructor", ["metadata:", "  constructor: construct"]]
  ])("refuses the reserved key %s at any depth", (key, fields) => {
    const text = document(["name: guarded", "description: Guard hostile keys", ...fields])
    const refused = failure(text)

    expect(refused.code).toBe("skill_invalid_frontmatter")
    expect(refused.message).toBe(`Skill frontmatter must not use the reserved key ${key}`)
    expect(Result.isFailure(Markdown.lowerSkill(text))).toBe(true)
  })

  it.each([
    ["a mapping", ["loop: &a", "  c: *a"]],
    ["a sequence", ["loop: &a [*a]"]],
    ["a nested mapping", ["metadata:", "  outer: &a", "    inner:", "      again: *a"]]
  ])("refuses a recursive alias through %s instead of throwing", (_shape, fields) => {
    const text = document(["name: cyclic", "description: Guard recursive aliases", ...fields])
    const refused = failure(text)

    expect(refused.code).toBe("skill_invalid_frontmatter")
    expect(refused.message).toBe("Skill frontmatter must not contain a recursive alias")
    expect(Result.isFailure(Markdown.lowerSkill(text))).toBe(true)
  })

  it("accepts one anchored mapping reused by sibling aliases", () => {
    const skill = parse(document(["name: shared", "description: Reuse an anchor", "a: &m", "  k: v", "b: *m", "c: *m"]))

    expect({ ...skill.extra }).toEqual({ a: { k: "v" }, b: { k: "v" }, c: { k: "v" } })
  })

  it("retains unknown keys without treating them as errors", () => {
    const skill = parse([
      "---",
      "name: pdf",
      "description: Extract files",
      "license: Apache-2.0",
      "metadata:",
      "  author: document-tools",
      "  version: \"1.0\"",
      "---",
      "Prompt"
    ].join("\n"))

    expect(Object.keys(skill.extra)).toEqual(["license", "metadata"])
    expect(Object.hasOwn(skill.extra, "license")).toBe(true)
    expect(Object.hasOwn(skill.extra, "metadata")).toBe(true)
    expect({ ...skill.extra }).toEqual({
      license: "Apache-2.0",
      metadata: {
        author: "document-tools",
        version: "1.0"
      }
    })
  })

  it("preserves the markdown body exactly after removing frontmatter", () => {
    const body = "\n# PDF Processing\n\nUse `pdfinfo`.\n"
    const skill = parse(`---\nname: pdf\ndescription: Extract files\n---\n${body}`)

    expect(skill.body).toBe(body)
  })

  it("lowers a skill to the ordinary markdown flow shape", () => {
    const flow = Result.getOrThrow(Markdown.lowerSkill(
      "---\nname: pdf\ndescription: Extract files\nallowed-tools: Read Write\n---\nPrompt"
    ))

    expect(flow.name).toBe("pdf")
    expect(flow.description).toBe("Extract files")
    expect(flow.model).toBe("smart")
    expect(flow.flows).toEqual(["Read", "Write"])
    expect(flow.prompt).toBe("Prompt")
    // The allowed tools are declarations the harness resolves, so lowering
    // leaves them as names and attaches no implementation.
    expect(flow.action?.name).toBe("pdf")
  })
})
