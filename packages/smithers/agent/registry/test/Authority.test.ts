import { Option } from "effect"
import { describe, expect, it } from "vitest"
import * as Descriptor from "../src/Descriptor.ts"
import * as Authority from "../src/internal/Authority.ts"
import { inferEffectTier, maxTier } from "../src/internal/Authority.ts"
import * as ModuleMetadata from "../src/internal/ModuleMetadata.ts"
import * as MarkdownFlow from "../src/MarkdownFlow.ts"

describe("Authority", () => {
  it("returns the more conservative tier and keeps the left value when ranks tie", () => {
    expect(maxTier("sealed", "sealed")).toBe("sealed")
    expect(maxTier("compensable", "compensable")).toBe("compensable")
    expect(maxTier("sealed", "compensable")).toBe("compensable")
    expect(maxTier("compensable", "sealed")).toBe("compensable")
    expect(maxTier("irreversible", "compensable")).toBe("irreversible")
    expect(maxTier("compensable", "irreversible")).toBe("irreversible")
  })

  it("lets a declaration narrow a delegate grant and never widen it", () => {
    expect(Authority.narrowDelegation(["*"], ["fs:read:**", "fs:read:**"])).toEqual(["fs:read:**"])
    expect(Authority.narrowDelegation(["*"], [])).toEqual([])
    expect(Authority.narrowDelegation(["fs:read:**"], ["fs:read:**", "proc:spawn:sh", "*"])).toEqual([
      "fs:read:**"
    ])
    expect(Authority.narrowDelegation([], ["*"])).toEqual([])
  })

  it("treats an empty capability list as sealed", () => {
    expect(inferEffectTier([])).toBe("sealed")
  })

  it.each([
    ["read", "Read"],
    ["grep", "Grep"],
    ["glob", "Glob"],
    ["ls", "LS"],
    ["an exact sealed action", "fs:read"],
    ["a scoped sealed action", "fs:read:src/**"],
    ["a scoped network read", "net:get:api.github.com"],
    ["a model call", "model:call"],
    ["a jj status read", "jj:status"],
    ["a jj diff read", "jj:diff"]
  ])("infers sealed from %s", (_label, capability) => {
    expect(inferEffectTier([capability])).toBe("sealed")
  })

  it.each([
    ["a workspace-relative scope", "fs:write:src/**"],
    ["an ordinary workspace-relative report", "fs:write:out/report.md"],
    ["a leading current-directory segment", "fs:write:./src/./out"],
    ["empty segments from a doubled separator", "fs:write:src//out"],
    ["a parent segment that stays inside the descent", "fs:write:src/nested/../out"],
    ["the workspace root itself", "fs:write:."],
    ["backslash separators", "fs:write:src\\nested"]
  ])("infers compensable from %s", (_label, capability) => {
    expect(inferEffectTier([capability])).toBe("compensable")
  })

  it.each([
    ["an unscoped write", "fs:write"],
    ["an empty scope", "fs:write:"],
    ["a whitespace-only scope", "fs:write:   "],
    ["a leading parent segment", "fs:write:../outside"],
    ["a parent segment that escapes after descending", "fs:write:src/../../outside"],
    ["a posix absolute scope", "fs:write:/tmp/out"],
    ["a windows absolute scope", "fs:write:C:/tmp/out"],
    ["a home-relative scope", "fs:write:~/.ssh/authorized_keys"],
    ["the home directory marker", "fs:write:~"],
    ["a shell variable prefix", "fs:write:$HOME/.bashrc"],
    ["an interpolated shell variable", "fs:write:${HOME}/x"],
    ["a Windows environment variable", "fs:write:%USERPROFILE%/x"],
    ["a file URI", "fs:write:file:///etc/passwd"],
    ["an unrecognised action", "git:push"],
    ["the wildcard", "*"]
  ])("infers irreversible from %s", (_label, capability) => {
    expect(inferEffectTier([capability])).toBe("irreversible")
  })

  it("ignores capability casing", () => {
    expect(inferEffectTier(["READ"])).toBe("sealed")
    expect(inferEffectTier(["FS:READ:SRC"])).toBe("sealed")
    expect(inferEffectTier(["FS:WRITE:SRC"])).toBe("compensable")
  })

  it("takes the most conservative tier across mixed capabilities", () => {
    expect(inferEffectTier(["Read", "fs:write:src/**"])).toBe("compensable")
    expect(inferEffectTier(["fs:write:src/**", "Read"])).toBe("compensable")
    expect(inferEffectTier(["Read", "fs:write:src/**", "Write"])).toBe("irreversible")
  })
})

describe("shared effects projection", () => {
  const markdownEffects = (frontmatter: ReadonlyArray<string>) =>
    Option.getOrThrow(
      MarkdownFlow.fromMarkdown({
        text: ["---", "description: Review", ...frontmatter, "---", "body"].join("\n"),
        path: "/flows/review/SKILL.md",
        baseDirectory: "/flows/review",
        naming: "frontmatter",
        name: Option.some("review"),
        dirBasename: "review",
        provenance: new Descriptor.Provenance({ source: "test", root: "/flows" })
      }).descriptor
    ).effects

  const moduleEffects = (members: ReadonlyArray<string>) =>
    ModuleMetadata.parse(
      ["export default ({", "  description: \"Review\",", ...members, "})"].join("\n")
    ).effects

  it.each([
    [
      "a bounded envelope every member declares",
      [
        "capabilities: [fs:write:src]",
        "effects:",
        "  reads: [src]",
        "  writes: [src/out]",
        "  mode: hermetic",
        "  onConflict: fail",
        "  tier: compensable"
      ],
      [
        "  capabilities: [\"fs:write:src\"],",
        "  effects: { reads: [\"src\"], writes: [\"src/out\"], mode: \"hermetic\", onConflict: \"fail\", tier: \"compensable\" }"
      ],
      { reads: ["src"], writes: ["src/out"], mode: "hermetic", onConflict: "fail", tier: "compensable" }
    ],
    [
      "a declaration that omits reads and writes under bounded authority",
      ["capabilities: [fs:read]", "effects:", "  tier: sealed"],
      ["  capabilities: [\"fs:read\"],", "  effects: { tier: \"sealed\" }"],
      { reads: [], writes: [], mode: "hermetic", onConflict: "serialize", tier: "sealed" }
    ],
    [
      "declared wildcard capabilities under a narrow envelope",
      [
        "capabilities: ['*']",
        "effects:",
        "  reads: []",
        "  writes: []",
        "  mode: hermetic",
        "  onConflict: serialize",
        "  tier: sealed"
      ],
      [
        "  capabilities: [\"*\"],",
        "  effects: { reads: [], writes: [], mode: \"hermetic\", onConflict: \"serialize\", tier: \"sealed\" }"
      ],
      Authority.conservativeEffects
    ],
    [
      "a delegate list narrowed by its declared capabilities",
      [
        "flows: [dangerous/write]",
        "capabilities: [fs:read]",
        "effects:",
        "  reads: []",
        "  writes: []",
        "  mode: hermetic",
        "  tier: sealed"
      ],
      [
        "  capabilities: [\"fs:read\"],",
        "  flows: [\"dangerous/write\"],",
        "  effects: { reads: [], writes: [], mode: \"hermetic\", tier: \"sealed\" }"
      ],
      { reads: [], writes: [], mode: "hermetic", onConflict: "serialize", tier: "sealed" }
    ],
    [
      "an effects value that is not an object",
      ["capabilities: [fs:read]", "effects: none"],
      ["  capabilities: [\"fs:read\"],", "  effects: baseEffects"],
      Authority.conservativeEffects
    ],
    [
      "a conflict policy the schema does not allow",
      ["capabilities: [fs:read]", "effects:", "  reads: []", "  writes: []", "  onConflict: whenever"],
      ["  capabilities: [\"fs:read\"],", "  effects: { reads: [], writes: [], onConflict: \"whenever\" }"],
      Authority.conservativeEffects
    ]
  ])("projects %s the same way for markdown and module bodies", (_label, frontmatter, members, effects) => {
    expect(markdownEffects(frontmatter)).toEqual(effects)
    expect(moduleEffects(members)).toEqual(markdownEffects(frontmatter))
  })

  // Markdown discovery refuses a capability list it cannot read (see
  // MarkdownFlow.test.ts), so only the module body has effects to project.
  it("projects a module capability list discovery cannot read as the widest effects", () => {
    expect(
      moduleEffects(["  capabilities,", "  effects: { reads: [], writes: [], mode: \"hermetic\", tier: \"sealed\" }"])
    )
      .toEqual(Authority.conservativeEffects)
  })
})
