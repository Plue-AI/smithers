import { Option, Schema } from "effect"
import { describe, expect, it } from "vitest"
import * as Descriptor from "../src/Descriptor.ts"
import * as MarkdownFlow from "../src/MarkdownFlow.ts"

const provenance = new Descriptor.Provenance({ source: "test", root: "/flows" })

const fromMarkdown = (text: string, overrides: Partial<MarkdownFlow.FromMarkdownOptions> = {}) =>
  MarkdownFlow.fromMarkdown({
    text,
    path: "/flows/review/SKILL.md",
    baseDirectory: "/flows/review",
    naming: "frontmatter",
    name: Option.some("review"),
    dirBasename: "review",
    provenance,
    ...overrides
  })

describe("MarkdownFlow", () => {
  it("loads a minimal SKILL.md descriptor", () => {
    const result = fromMarkdown("---\nname: review\ndescription: Review a pull request\n---\nUse the available tools.")
    const descriptor = Option.getOrThrow(result.descriptor)

    expect(descriptor).toMatchObject({
      name: "review",
      description: "Review a pull request",
      body: { _tag: "Markdown", path: "/flows/review/SKILL.md" },
      input: { _tag: "MarkdownArgs" },
      output: { _tag: "MarkdownOutput" },
      flows: [],
      capabilities: ["*"],
      effects: {
        reads: ["**"],
        writes: ["**"],
        mode: "expected",
        onConflict: "serialize",
        tier: "irreversible"
      },
      modelInvocable: true,
      frontmatter: { name: "review", description: "Review a pull request" }
    })
    expect(Option.isNone(descriptor.placement)).toBe(true)
    expect(result.warnings).toContainEqual(expect.objectContaining({ code: "unprojectable_authority" }))
  })

  it("retains unmodified agentskills.io-shaped frontmatter", () => {
    const result = fromMarkdown(
      [
        "---",
        "name: review-pr",
        "description: Review a pull request",
        "license: 2.0",
        "allowed-tools: Read Bash",
        "metadata:",
        "  author: Example",
        "  version: 1.0",
        "---",
        "Review the pull request."
      ].join("\n"),
      {
        path: "/flows/review-pr/SKILL.md",
        dirBasename: "review-pr"
      }
    )
    const descriptor = Option.getOrThrow(result.descriptor)

    expect(descriptor.name).toBe("review-pr")
    expect(descriptor.flows).toEqual(["Read", "Bash"])
    expect(descriptor.capabilities).toEqual(["*"])
    expect(descriptor.frontmatter).toEqual({
      name: "review-pr",
      description: "Review a pull request",
      license: "2.0",
      "allowed-tools": "Read Bash",
      metadata: { author: "Example", version: "1.0" }
    })
    expect(result.warnings).toContainEqual(expect.objectContaining({ code: "unprojectable_authority" }))
  })

  it("keeps reserved frontmatter keys own and identical across descriptor encoding", () => {
    const result = fromMarkdown([
      "---",
      "description: Review a pull request",
      "capabilities: []",
      "__proto__:",
      "  name: inherited",
      "constructor:",
      "  prototype: retained",
      "prototype:",
      "  value: retained",
      "---",
      "Review it."
    ].join("\n"))
    const descriptor = Option.getOrThrow(result.descriptor)
    const encoded = Schema.encodeUnknownSync(Descriptor.FlowDescriptor)(descriptor)
    const decoded = Schema.decodeUnknownSync(Descriptor.FlowDescriptor)(encoded)

    expect(descriptor.name).toBe("review")
    expect(Object.hasOwn(descriptor.frontmatter, "__proto__")).toBe(true)
    expect(Object.hasOwn(descriptor.frontmatter, "name")).toBe(false)
    expect("name" in descriptor.frontmatter).toBe(false)
    expect(JSON.parse(JSON.stringify(decoded.frontmatter))).toEqual(
      JSON.parse(JSON.stringify(descriptor.frontmatter))
    )
    expect(Object.keys(decoded.frontmatter).sort()).toEqual(Object.keys(descriptor.frontmatter).sort())
    expect(Object.hasOwn(decoded.frontmatter, "__proto__")).toBe(true)
    expect(Object.hasOwn(decoded.frontmatter, "name")).toBe(false)
    expect("name" in decoded.frontmatter).toBe(false)
  })

  it("drops only entries with a missing description", () => {
    const result = fromMarkdown("---\nname: review\ndescription: '   '\n---\nbody")

    expect(result.descriptor).toEqual(Option.none())
    expect(result.warnings).toContainEqual(expect.objectContaining({ code: "missing_description" }))
  })

  it("uses path names and warns when path-regime frontmatter declares a name", () => {
    const result = fromMarkdown("---\nname: ignored\ndescription: Review\n---\nbody", {
      naming: "path",
      name: Option.some("review/read-pr")
    })
    const descriptor = Option.getOrThrow(result.descriptor)

    expect(descriptor.name).toBe("review/read-pr")
    expect(result.warnings).toContainEqual(expect.objectContaining({ code: "name_field_ignored" }))
  })

  it("warns and falls back to the directory name for frontmatter-regime entries without names", () => {
    const result = fromMarkdown("---\ndescription: Review\n---\nbody")
    const descriptor = Option.getOrThrow(result.descriptor)

    expect(descriptor.name).toBe("review")
    expect(result.warnings).toContainEqual(expect.objectContaining({ code: "missing_name" }))
  })

  it("keeps agentskills allowed-tools as preapproved tool metadata", () => {
    const result = fromMarkdown(
      "---\nname: review\ndescription: Review\nallowed-tools: Bash(git:*) Bash(jq:*) Read\n---\nbody"
    )

    const descriptor = Option.getOrThrow(result.descriptor)
    expect(descriptor.flows).toEqual([
      "Bash(git:*)",
      "Bash(jq:*)",
      "Read"
    ])
    expect(descriptor.capabilities).toEqual(["*"])
    expect(descriptor.effects.tier).toBe("irreversible")
  })

  it("does not treat commas as allowed-tools separators", () => {
    const result = fromMarkdown(
      "---\nname: review\ndescription: Review\nallowed-tools: Read, Bash\n---\nbody"
    )

    expect(Option.getOrThrow(result.descriptor).flows).toEqual(["Read,", "Bash"])
  })

  it("hides disable-model-invocation entries only from model invocation", () => {
    const descriptor = Option.getOrThrow(
      fromMarkdown("---\ndescription: Review\ndisable-model-invocation: true\n---\nbody").descriptor
    )

    expect(descriptor.modelInvocable).toBe(false)
  })

  it("defaults invalid effect tiers to irreversible with a warning", () => {
    const result = fromMarkdown("---\ndescription: Review\neffects:\n  tier: dangerous\n---\nbody")
    const descriptor = Option.getOrThrow(result.descriptor)

    expect(descriptor.effects.tier).toBe("irreversible")
    expect(result.warnings).toContainEqual(expect.objectContaining({ code: "invalid_effect_tier" }))
  })

  it("infers authority tiers only from explicit capabilities", () => {
    const read = fromMarkdown("---\ndescription: Read files\ncapabilities: [Read]\n---\nbody")
    const write = fromMarkdown("---\ndescription: Write files\ncapabilities: [Write]\n---\nbody")
    const edit = fromMarkdown("---\ndescription: Edit files\ncapabilities: [Edit]\n---\nbody")
    const unscopedWrite = fromMarkdown("---\ndescription: Write files\ncapabilities: [fs:write]\n---\nbody")
    const unknownWrite = fromMarkdown("---\ndescription: Write git state\ncapabilities: [git:write]\n---\nbody")
    const unknownRead = fromMarkdown("---\ndescription: Read unknown state\ncapabilities: [arbitrary:read]\n---\nbody")
    const escapingWrite = fromMarkdown(
      "---\ndescription: Write outside\ncapabilities: [fs:write:../outside]\n---\nbody"
    )
    const absoluteWrite = fromMarkdown(
      "---\ndescription: Write outside\ncapabilities: [fs:write:/tmp/out]\n---\nbody"
    )
    const workspaceWrite = fromMarkdown(
      "---\ndescription: Write source files\ncapabilities: [fs:write:src/**]\n---\nbody"
    )
    const shell = fromMarkdown("---\ndescription: Run a command\ncapabilities: [Bash(git:*)]\n---\nbody")

    expect(Option.getOrThrow(read.descriptor).effects.tier).toBe("sealed")
    expect(Option.getOrThrow(write.descriptor).effects.tier).toBe("irreversible")
    expect(Option.getOrThrow(edit.descriptor).effects.tier).toBe("irreversible")
    expect(Option.getOrThrow(unscopedWrite.descriptor).effects.tier).toBe("irreversible")
    expect(Option.getOrThrow(unknownWrite.descriptor).effects.tier).toBe("irreversible")
    expect(Option.getOrThrow(unknownRead.descriptor).effects.tier).toBe("irreversible")
    expect(Option.getOrThrow(escapingWrite.descriptor).effects.tier).toBe("irreversible")
    expect(Option.getOrThrow(absoluteWrite.descriptor).effects.tier).toBe("irreversible")
    expect(Option.getOrThrow(workspaceWrite.descriptor).effects.tier).toBe("compensable")
    expect(Option.getOrThrow(shell.descriptor).effects.tier).toBe("irreversible")
  })

  it("accepts a description of exactly the Agent Skills limit and warns one character over", () => {
    const atLimit = fromMarkdown(`---\ndescription: ${"a".repeat(1024)}\n---\nbody`)
    const overLimit = fromMarkdown(`---\ndescription: ${"a".repeat(1025)}\n---\nbody`)

    expect(Option.isSome(atLimit.descriptor)).toBe(true)
    expect(atLimit.warnings).not.toContainEqual(expect.objectContaining({ code: "invalid_description" }))
    expect(overLimit.warnings).toContainEqual(expect.objectContaining({ code: "invalid_description" }))
  })

  it.each([
    ["is absent", "---\nname: review\n---\nbody"],
    ["is an empty string", "---\ndescription: ''\n---\nbody"],
    ["is not a string", "---\ndescription:\n  - Review\n---\nbody"],
    ["has no frontmatter at all", "Just a body."]
  ])("drops an entry whose description %s", (_label, text) => {
    const result = fromMarkdown(text)

    expect(result.descriptor).toEqual(Option.none())
    expect(result.warnings).toContainEqual(expect.objectContaining({
      code: "missing_description",
      name: "review",
      message: "Markdown flows require a non-empty frontmatter description"
    }))
  })

  it("falls back to the directory name when a path-named source derives no name", () => {
    const result = fromMarkdown("---\ndescription: Review\n---\nbody", {
      naming: "path",
      name: Option.none(),
      dirBasename: "fallback"
    })

    expect(Option.getOrThrow(result.descriptor).name).toBe("fallback")
    expect(result.warnings).not.toContainEqual(expect.objectContaining({ code: "name_field_ignored" }))
  })

  it.each([
    ["a declared seat", "model: opus", "opus"],
    ["a blank seat", "model: '   '", undefined],
    ["a single-seat list", "model:\n  - opus", ["opus"]],
    ["ordered fallback seats", "model: [opus, sol]", ["opus", "sol"]],
    ["no seat at all", "capabilities: []", undefined]
  ])("reads %s from frontmatter", (_label, member, model) => {
    const result = fromMarkdown(`---\ndescription: Review\n${member}\n---\nbody`)

    expect(Option.getOrUndefined(Option.getOrThrow(result.descriptor).model)).toEqual(model)
  })

  it.each([
    ["an explicit list", "capabilities: [Read, fs:write:src]", ["Read", "fs:write:src"], "compensable"],
    ["an empty list", "capabilities: []", [], "sealed"],
    ["a space-separated string", "capabilities: Read  Grep", ["Read", "Grep"], "sealed"],
    ["a whitespace-only string", "capabilities: '   '", [], "sealed"]
  ])("bounds authority from %s", (_label, member, capabilities, tier) => {
    const descriptor = Option.getOrThrow(fromMarkdown(`---\ndescription: Review\n${member}\n---\nbody`).descriptor)

    expect(descriptor.capabilities).toEqual(capabilities)
    expect(descriptor.effects.tier).toBe(tier)
  })

  it.each([
    ["a string", "capabilities: Read Grep"],
    ["a mapping", "capabilities:\n  read: true"],
    ["a list of mappings", "capabilities:\n  - name: Read"]
  ])("warns when capabilities are declared as %s", (_label, member) => {
    const result = fromMarkdown(`---\ndescription: Review\n${member}\n---\nbody`)

    expect(result.warnings).toContainEqual(expect.objectContaining({ code: "invalid_capabilities" }))
  })

  it.each([
    ["a mapping", "capabilities:\n  read: true", "{\"read\":\"true\"}"],
    ["a list of mappings", "capabilities:\n  - name: Read", "[{\"name\":\"Read\"}]"]
  ])("refuses to discover a flow whose capabilities are %s", (_label, member, shown) => {
    const result = fromMarkdown(`---\ndescription: Review\n${member}\n---\nbody`)

    expect(Option.isNone(result.descriptor)).toBe(true)
    expect(result.warnings).toContainEqual(expect.objectContaining({
      code: "invalid_capabilities",
      path: "/flows/review/SKILL.md",
      message: expect.stringContaining(shown)
    }))
  })

  it("says an undeclared capability list grants every capability", () => {
    const result = fromMarkdown("---\ndescription: Review\n---\nbody")

    expect(Option.getOrThrow(result.descriptor).capabilities).toEqual(["*"])
    const warning = result.warnings.find((item) => item.code === "unprojectable_authority")
    expect(warning?.message).toContain("every capability")
    expect(warning?.message).not.toContain("conservative")
  })

  it.each([
    ["a list", "flows: [read-pr, write-pr]", ["read-pr", "write-pr"]],
    ["a string", "flows: read-pr write-pr", ["read-pr", "write-pr"]],
    ["an empty list", "flows: []", []],
    ["neither flows nor allowed-tools", "capabilities: []", []]
  ])("reads the callable flow list from %s", (_label, member, flows) => {
    const descriptor = Option.getOrThrow(fromMarkdown(`---\ndescription: Review\n${member}\n---\nbody`).descriptor)

    expect(descriptor.flows).toEqual(flows)
  })

  it("prefers flows over allowed-tools when both are declared", () => {
    const descriptor = Option.getOrThrow(
      fromMarkdown("---\ndescription: Review\nflows: [read-pr]\nallowed-tools: Read Bash\n---\nbody").descriptor
    )

    expect(descriptor.flows).toEqual(["read-pr"])
  })

  it.each([
    ["true", "disable-model-invocation: true", false],
    ["the string true", "disable-model-invocation: 'true'", false],
    ["false", "disable-model-invocation: false", true],
    ["the string false", "disable-model-invocation: 'false'", true],
    ["absent", "capabilities: []", true]
  ])("reads model invocability when disable-model-invocation is %s", (_label, member, modelInvocable) => {
    const result = fromMarkdown(`---\ndescription: Review\n${member}\n---\nbody`)

    expect(Option.getOrThrow(result.descriptor).modelInvocable).toBe(modelInvocable)
    expect(result.warnings).not.toContainEqual(expect.objectContaining({ code: "invalid_model_invocation" }))
  })

  it("keeps an entry visible when disable-model-invocation is not a boolean", () => {
    const result = fromMarkdown("---\ndescription: Review\ndisable-model-invocation: maybe\n---\nbody")

    expect(Option.getOrThrow(result.descriptor).modelInvocable).toBe(true)
    expect(result.warnings).toContainEqual(expect.objectContaining({ code: "invalid_model_invocation" }))
  })

  it("reads a fully declared effect envelope", () => {
    const result = fromMarkdown([
      "---",
      "description: Review",
      "capabilities: [fs:write:src]",
      "effects:",
      "  reads: [src]",
      "  writes: [src/out]",
      "  mode: hermetic",
      "  onConflict: fail",
      "  tier: compensable",
      "---",
      "body"
    ].join("\n"))

    expect(Option.getOrThrow(result.descriptor).effects).toEqual({
      reads: ["src"],
      writes: ["src/out"],
      mode: "hermetic",
      onConflict: "fail",
      tier: "compensable"
    })
    expect(result.warnings.map((warning) => warning.code)).toEqual(["missing_name"])
  })

  it("narrows a delegating flow's wildcard grant to its declared capabilities", () => {
    const result = fromMarkdown([
      "---",
      "description: Delegates a check",
      "flows: [coding/CommandCheck]",
      "capabilities: [\"fs:read:**\", \"proc:spawn:sh -c *\", \"fs:read:**\"]",
      "effects:",
      "  reads: [\"**\"]",
      "  writes: []",
      "  mode: expected",
      "  tier: sealed",
      "---",
      "body"
    ].join("\n"))
    const descriptor = Option.getOrThrow(result.descriptor)

    expect(descriptor.capabilities).toEqual(["fs:read:**", "proc:spawn:sh -c *"])
    expect(descriptor.effects).toEqual({
      reads: ["**"],
      writes: [],
      mode: "expected",
      onConflict: "serialize",
      tier: "irreversible"
    })
    expect(result.warnings.map((warning) => warning.code)).not.toContain("unprojectable_authority")
    expect(result.warnings).toContainEqual(expect.objectContaining({
      code: "invalid_effect_tier",
      message: "Effect tier sealed under-classifies declared authority; using irreversible"
    }))
  })

  it("keeps the wildcard for a delegating flow that declares no capabilities", () => {
    const result = fromMarkdown("---\ndescription: Delegates\nflows: [coding/CommandCheck]\n---\nbody")

    expect(Option.getOrThrow(result.descriptor).capabilities).toEqual(["*"])
    expect(result.warnings).toContainEqual(expect.objectContaining({ code: "unprojectable_authority" }))
  })

  it.each([
    ["lane", "lane"],
    ["serialize", "serialize"]
  ])("keeps the %s conflict policy", (declared, onConflict) => {
    const descriptor = Option.getOrThrow(
      fromMarkdown([
        "---",
        "description: Review",
        "capabilities: []",
        "effects:",
        "  reads: []",
        "  writes: []",
        "  mode: expected",
        `  onConflict: ${declared}`,
        "---",
        "body"
      ].join("\n")).descriptor
    )

    expect(descriptor.effects.onConflict).toBe(onConflict)
    expect(descriptor.effects.mode).toBe("expected")
  })

  it("raises an under-classifying declared tier to the inferred tier", () => {
    const result = fromMarkdown([
      "---",
      "description: Review",
      "capabilities: [Write]",
      "effects:",
      "  reads: []",
      "  writes: []",
      "  tier: sealed",
      "---",
      "body"
    ].join("\n"))

    expect(Option.getOrThrow(result.descriptor).effects.tier).toBe("irreversible")
    expect(result.warnings).toContainEqual(expect.objectContaining({
      code: "invalid_effect_tier",
      message: "Effect tier sealed under-classifies declared authority; using irreversible"
    }))
  })

  it.each([
    [
      "the declaration is not an object",
      "effects: none",
      "Frontmatter effects must be an object; using conservative effects"
    ],
    [
      "reads is not a string array",
      "effects:\n  reads: everything\n  writes: []",
      "Frontmatter effects.reads must be a string array; using the conservative wildcard"
    ],
    [
      "writes is not a string array",
      "effects:\n  reads: []\n  writes:\n    - path: src",
      "Frontmatter effects.writes must be a string array; using the conservative wildcard"
    ],
    [
      "mode is unknown",
      "effects:\n  reads: []\n  writes: []\n  mode: loose",
      "Frontmatter effects.mode must be hermetic or expected; using expected"
    ],
    [
      "mode is not a string",
      "effects:\n  reads: []\n  writes: []\n  mode: [parallel]",
      "Frontmatter effects.mode must be hermetic or expected; using expected"
    ],
    [
      "the conflict policy is unknown",
      "effects:\n  reads: []\n  writes: []\n  onConflict: whenever",
      "Frontmatter effects.onConflict must be serialize, lane, or fail; using serialize"
    ]
  ])("falls back to conservative effects when %s", (_label, member, message) => {
    const result = fromMarkdown(`---\ndescription: Review\ncapabilities: []\n${member}\n---\nbody`)

    expect(Option.getOrThrow(result.descriptor).effects).toEqual({
      reads: ["**"],
      writes: ["**"],
      mode: "expected",
      onConflict: "serialize",
      tier: "irreversible"
    })
    expect(result.warnings).toContainEqual(expect.objectContaining({
      code: "invalid_effect_declaration",
      message
    }))
  })

  it("omits reads and writes that are not declared under bounded authority", () => {
    const descriptor = Option.getOrThrow(
      fromMarkdown("---\ndescription: Review\ncapabilities: [Read]\neffects:\n  tier: sealed\n---\nbody").descriptor
    )

    expect(descriptor.effects).toEqual({
      reads: [],
      writes: [],
      mode: "hermetic",
      onConflict: "serialize",
      tier: "sealed"
    })
  })

  // Driven by the descriptor's own literals, so a placement added there is
  // read here without a second edit rather than passing an untouched list.
  it.each(Descriptor.Placement.literals)("reads the %s placement", (declared) => {
    const result = fromMarkdown(`---\ndescription: Review\nplacement: ${declared}\n---\nbody`)

    expect(Option.getOrThrow(Option.getOrThrow(result.descriptor).placement)).toBe(declared)
    expect(result.warnings).not.toContainEqual(expect.objectContaining({ code: "unsupported_module_metadata" }))
    expect(result.warnings).not.toContainEqual(expect.objectContaining({ code: "invalid_placement" }))
  })

  it("ignores an unknown placement and keeps the entry unplaced", () => {
    const result = fromMarkdown("---\ndescription: Review\nplacement: orbit\n---\nbody")

    expect(Option.isNone(Option.getOrThrow(result.descriptor).placement)).toBe(true)
    // Frontmatter is the markdown side, which spends its own codes;
    // `unsupported_module_metadata` is the module-side umbrella
    // (docs/concepts/authority.md).
    expect(result.warnings).toContainEqual(expect.objectContaining({
      code: "invalid_placement",
      message: "Ignoring invalid placement; expected client, local, sandbox, or remote"
    }))
    expect(result.warnings).not.toContainEqual(expect.objectContaining({ code: "unsupported_module_metadata" }))
  })

  it("warns once for each unsupported schema key", () => {
    const result = fromMarkdown("---\ndescription: Review\ninput: {}\nschema: {}\n---\nbody")

    expect(
      result.warnings.filter((warning) => warning.code === "unsupported_input_schema").map((warning) => warning.message)
    ).toEqual([
      "Ignoring unsupported markdown flow input frontmatter",
      "Ignoring unsupported markdown flow schema frontmatter"
    ])
  })

  it("warns about unknown keys and keeps every field on the descriptor", () => {
    const result = fromMarkdown("---\ndescription: Review\nunexpected: value\n---\nbody")

    expect(Option.getOrThrow(result.descriptor).frontmatter).toEqual({
      description: "Review",
      unexpected: "value"
    })
    expect(result.warnings).toContainEqual(expect.objectContaining({
      code: "unknown_frontmatter_key",
      message: "Unknown frontmatter key: unexpected"
    }))
  })

  it.each([
    ["an empty string", "effort: ''"],
    ["an unrecognised spelling", "effort: ludicrous"],
    ["a known spelling", "effort: high"]
  ])("carries an effort declaration through discovery when it is %s", (_label, member) => {
    const result = fromMarkdown(`---\ndescription: Review\n${member}\n---\nbody`)

    expect(Option.isSome(result.descriptor)).toBe(true)
    expect(result.warnings.map((warning) => warning.code)).not.toContain("unknown_frontmatter_key")
  })

  it.each(["[]", "[opus, {}]", "[opus, '   ']"])("rejects an invalid model list %s", (value) => {
    const result = fromMarkdown(`---
description: Review
model: ${value}
---
body`)
    expect(Option.isNone(result.descriptor)).toBe(true)
    expect(result.warnings).toContainEqual(expect.objectContaining({ code: "invalid_model" }))
  })

  it("preserves ordered fallback seats when lowering frontmatter", () => {
    const descriptor = Option.getOrThrow(
      fromMarkdown("---\ndescription: Review\nmodel: [opus, sol]\n---\nbody").descriptor
    )
    expect(MarkdownFlow.toCoreFrontmatter(descriptor).model).toEqual(["opus", "sol"])
  })

  it("projects the model seat and placement into the core authoring value", () => {
    const placed = Option.getOrThrow(
      fromMarkdown(
        "---\ndescription: Review\nmodel: opus\nplacement: sandbox\ncapabilities: [Read]\nflows: [read-pr]\n---\nbody"
      ).descriptor
    )
    const unplaced = Option.getOrThrow(fromMarkdown("---\ndescription: Review\ncapabilities: []\n---\nbody").descriptor)

    expect(MarkdownFlow.toCoreFrontmatter(placed)).toEqual({
      name: "review",
      description: "Review",
      flows: ["read-pr"],
      capabilities: ["Read"],
      effects: placed.effects,
      model: "opus",
      placement: "sandbox"
    })
    expect(MarkdownFlow.toCoreFrontmatter(unplaced)).toEqual({
      name: "review",
      description: "Review",
      flows: [],
      capabilities: [],
      effects: unplaced.effects
    })
  })

  it("warns with field-specific codes for malformed known frontmatter", () => {
    const result = fromMarkdown([
      "---",
      "name: review",
      `description: ${"a".repeat(1025)}`,
      "license:",
      "  - MIT",
      `compatibility: ${"b".repeat(501)}`,
      "metadata:",
      "  version:",
      "    nested: invalid",
      "allowed-tools:",
      "  command: bash",
      "disable-model-invocation: yes",
      "---",
      "body"
    ].join("\n"))

    expect(Option.isSome(result.descriptor)).toBe(true)
    expect(result.warnings.map((warning) => warning.code)).toEqual(expect.arrayContaining([
      "invalid_description",
      "invalid_license",
      "invalid_compatibility",
      "invalid_metadata",
      "invalid_allowed_tools",
      "invalid_model_invocation"
    ]))
    expect(result.warnings).not.toContainEqual(expect.objectContaining({ code: "unknown_frontmatter_key" }))
  })

  it.each([
    ["a short string", "compatibility: Claude Code", false],
    ["a string of exactly 500 characters", `compatibility: ${"b".repeat(500)}`, false],
    ["a string of 501 characters", `compatibility: ${"b".repeat(501)}`, true],
    ["a list", "compatibility:\n  - Claude Code", true]
  ])("accepts a compatibility declaration that is %s", (_label, member, warns) => {
    const result = fromMarkdown(`---\ndescription: Review\n${member}\n---\nbody`)

    expect(Option.isSome(result.descriptor)).toBe(true)
    expect(result.warnings.some((warning) => warning.code === "invalid_compatibility")).toBe(warns)
  })

  it("keeps descriptors serializable when YAML aliases are cyclic", () => {
    const result = fromMarkdown([
      "---",
      "name: review",
      "description: Review",
      "capabilities: []",
      "metadata: &metadata",
      "  author: Example",
      "  self: *metadata",
      "---",
      "body"
    ].join("\n"))
    const descriptor = Option.getOrThrow(result.descriptor)

    expect(result.warnings).toContainEqual(expect.objectContaining({
      code: "non_serializable_frontmatter"
    }))
    expect(descriptor.frontmatter.metadata).toEqual({
      author: "Example",
      self: null
    })
    expect(() => JSON.stringify(descriptor)).not.toThrow()
  })

  it("reads the tokens and milliseconds a flow declares", () => {
    const result = fromMarkdown(
      [
        "---",
        "description: Review a pull request",
        "budget:",
        "  tokens: 120000",
        "  milliseconds: 900000",
        "---",
        "Review the pull request."
      ].join("\n")
    )
    const descriptor = Option.getOrThrow(result.descriptor)

    // Frontmatter is parsed on YAML's failsafe schema, so both arrive as
    // strings and reach the descriptor as the numbers an envelope carries.
    expect(descriptor.budget).toEqual({ tokens: 120000, milliseconds: 900000 })
    expect(Descriptor.budgetOf(descriptor)).toEqual({ tokens: 120000, milliseconds: 900000 })
    expect(result.warnings).not.toContainEqual(expect.objectContaining({ code: "invalid_budget" }))
    expect(result.warnings).not.toContainEqual(expect.objectContaining({ code: "unknown_frontmatter_key" }))
  })

  it("keeps each ceiling on its own, so declaring one does not imply the other", () => {
    const tokensOnly = Option.getOrThrow(
      fromMarkdown(["---", "description: Review", "budget:", "  tokens: 500", "---", "Review."].join("\n")).descriptor
    )
    const latencyOnly = Option.getOrThrow(
      fromMarkdown(
        ["---", "description: Review", "budget:", "  milliseconds: 500", "---", "Review."].join("\n")
      ).descriptor
    )

    expect(tokensOnly.budget).toEqual({ tokens: 500 })
    expect(latencyOnly.budget).toEqual({ milliseconds: 500 })
  })

  it("reads a dollar ceiling on its own or beside the others, and parks on it", () => {
    const result = fromMarkdown(
      ["---", "description: Review", "budget:", "  usd: 2.5", "  onExceeded: park", "---", "Review."].join("\n")
    )
    const descriptor = Option.getOrThrow(result.descriptor)

    expect(descriptor.budget).toEqual({ usd: 2.5, onExceeded: "park" })
    expect(Descriptor.budgetOf(descriptor)).toEqual({ usd: 2.5, onExceeded: "park" })
    expect(result.warnings.filter((warning) => warning.code === "invalid_budget")).toEqual([])
    const all = fromMarkdown(
      ["---", "description: Review", "budget:", "  tokens: 500", "  usd: 0.25", "---", "Review."].join("\n")
    )
    expect(Option.getOrThrow(all.descriptor).budget).toEqual({ tokens: 500, usd: 0.25 })
  })

  it.each(["0", "-1", "free", "''", "Infinity"])("drops a dollar ceiling of %s and says so", (value) => {
    const result = fromMarkdown(
      ["---", "description: Review", "budget:", "  tokens: 500", `  usd: ${value}`, "---", "Review."].join("\n")
    )

    expect(Option.getOrThrow(result.descriptor).budget).toEqual({ tokens: 500 })
    expect(result.warnings).toContainEqual(expect.objectContaining({
      code: "invalid_budget",
      message: "Frontmatter budget.usd must be a positive dollar amount; ignoring it"
    }))
  })

  it("leaves an undeclared budget absent, which reads back as unbounded", () => {
    const descriptor = Option.getOrThrow(
      fromMarkdown("---\ndescription: Review a pull request\n---\nReview.").descriptor
    )

    // Absent rather than an empty object nobody named: `budgetOf` is where the
    // absence becomes a decision a reader can see.
    expect(descriptor.budget).toBeUndefined()
    expect(Descriptor.budgetOf(descriptor)).toBe(Descriptor.budgetUnbounded)
  })

  it("drops a budget that is not an object, and says so", () => {
    for (const declaration of ["budget:", "budget: soon", "budget:\n  - 1000"]) {
      const result = fromMarkdown(["---", "description: Review", declaration, "---", "Review."].join("\n"))

      expect(Option.getOrThrow(result.descriptor).budget).toBeUndefined()
      expect(result.warnings).toContainEqual(expect.objectContaining({ code: "invalid_budget" }))
    }
  })

  it("drops a ceiling that is not a positive safe integer, and keeps the one that is", () => {
    const result = fromMarkdown(
      [
        "---",
        "description: Review",
        "budget:",
        "  tokens: 0",
        "  milliseconds: 900000",
        "---",
        "Review."
      ].join("\n")
    )

    // A budget has no conservative reading. Its conservative number is zero,
    // which refuses the run's first call, so an unreadable ceiling is reported
    // and dropped rather than enforced.
    expect(Option.getOrThrow(result.descriptor).budget).toEqual({ milliseconds: 900000 })
    expect(result.warnings).toContainEqual(expect.objectContaining({
      code: "invalid_budget",
      message: "Frontmatter budget.tokens must be a positive safe integer; ignoring it"
    }))
  })

  it("reads what exceeding the budget does, and drops a choice it does not know", () => {
    const parked = fromMarkdown(
      ["---", "description: Review", "budget:", "  tokens: 500", "  onExceeded: park", "---", "Review."].join("\n")
    )
    expect(Option.getOrThrow(parked.descriptor).budget).toEqual({ tokens: 500, onExceeded: "park" })
    expect(parked.warnings.filter((warning) => warning.code === "invalid_budget")).toEqual([])

    const unknown = fromMarkdown(
      ["---", "description: Review", "budget:", "  tokens: 500", "  onExceeded: sulk", "---", "Review."].join("\n")
    )
    // The ceiling still binds under the default, `fail`.
    expect(Option.getOrThrow(unknown.descriptor).budget).toEqual({ tokens: 500 })
    expect(unknown.warnings).toContainEqual(expect.objectContaining({
      code: "invalid_budget",
      message: "Frontmatter budget.onExceeded must be one of fail, warn, skip-remaining, park; ignoring it"
    }))
  })

  it("names a budget key it does not know, so a misspelled ceiling is not silence", () => {
    const result = fromMarkdown(
      ["---", "description: Review", "budget:", "  token: 500", "---", "Review."].join("\n")
    )

    expect(Option.getOrThrow(result.descriptor).budget).toBeUndefined()
    expect(result.warnings).toContainEqual(expect.objectContaining({
      code: "invalid_budget",
      message: "Unknown frontmatter budget key: token"
    }))
  })

  it("drops a budget whose every ceiling is unreadable", () => {
    const result = fromMarkdown(
      [
        "---",
        "description: Review",
        "budget:",
        "  tokens: soon",
        "  milliseconds:",
        "    at: noon",
        "---",
        "Review."
      ].join("\n")
    )

    expect(Option.getOrThrow(result.descriptor).budget).toBeUndefined()
    expect(result.warnings.filter((warning) => warning.code === "invalid_budget")).toHaveLength(2)
  })

  it("strips frontmatter exactly when loading a body", () => {
    expect(MarkdownFlow.loadBody(
      "---\ndescription: Review\n---\nLine one\n\nLine two",
      "/flows/review"
    )).toEqual(
      new Descriptor.FlowBodyPrompt({
        text: "Line one\n\nLine two",
        baseDirectory: "/flows/review"
      })
    )
  })

  it("hands a loaded body to renderPrompt without narrowing it first", () => {
    const rendered = MarkdownFlow.renderPrompt(
      MarkdownFlow.loadBody("---\ndescription: Review\n---\nLine one", "/flows/review"),
      { args: "" }
    )

    expect(rendered).toContain("Line one")
    expect(rendered).toContain("- Base directory: /flows/review")
  })

  it("renders the resource base directory and appends arguments when present", () => {
    const body = new Descriptor.FlowBodyPrompt({
      text: "Review the pull request.",
      baseDirectory: "/flows/review"
    })

    const withoutArguments = MarkdownFlow.renderPrompt(body, { args: "" })
    const withArguments = MarkdownFlow.renderPrompt(body, { args: "4821" })

    expect(withoutArguments).toContain("Review the pull request.")
    expect(withoutArguments).toContain("- Base directory: /flows/review")
    expect(withArguments).toContain("- Base directory: /flows/review")
    expect(withArguments.endsWith("\n\n4821")).toBe(true)
  })
})
