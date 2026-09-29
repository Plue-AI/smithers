import * as NodeFs from "node:fs"
import * as NodeOs from "node:os"
import * as NodePath from "node:path"
import { describe, expect, it } from "vitest"
import { Smithers } from "../src/index.ts"
import * as Input from "../src/Input.ts"
import type * as LlmLint from "../src/LlmLint.ts"
import * as SecurityReview from "../src/SecurityReview.ts"
import * as Target from "../src/Target.ts"

const check: SecurityReview.Check = {
  id: "upload-path-traversal",
  title: "Upload paths stay inside the upload root",
  threat: "An authenticated user writes files outside their upload directory.",
  lookFor: ["A request-supplied file name joined to the root without a prefix check."],
  paths: ["src/upload/**"]
}

const attrsOf = (target: Target.AnyTarget): LlmLint.Attrs => Target.metadata(target).attrs as LlmLint.Attrs

describe("SecurityReview declaration", () => {
  it("returns a diff review and a manual full audit over one rubric", () => {
    const targets = Smithers.SecurityReview({ cwd: "packages/example", checks: [check] })
    expect(Object.keys(targets)).toEqual(["security", "securityAudit"])
    const security = Target.metadata(targets.security)
    const audit = Target.metadata(targets.securityAudit)
    expect(security.target).toBe("LlmLint")
    expect(audit.target).toBe("LlmLint")
    expect(security.manual).toBe(false)
    expect(audit.manual).toBe(true)
    const diff = attrsOf(targets.security)
    const full = attrsOf(targets.securityAudit)
    expect(diff.changes.base).toBe("origin/main")
    expect(diff.scope).toBe("changed")
    expect(full.scope).toBe("all")
    expect(diff.include).toEqual([Input.Glob.make({ pattern: "//packages/example/src/**", exclude: [] })])
    expect(full.include).toEqual(diff.include)
    expect(diff.changes.paths).toEqual(["packages/example/src/**"])
    expect(diff.engine).toBe("claude")
    expect(diff.model).toBe(SecurityReview.defaultClaudeModel)
    expect(diff.failOn).toBe("error")
    expect(diff.securityChecks).toEqual(["upload-path-traversal", "general"])
    expect(full.securityChecks).toEqual(diff.securityChecks)
    expect(diff.batchSize).toBe(4)
    expect(full.batchSize).toBe(8)
    expect(full.rubric).toBe(diff.rubric)
    expect(diff.prompt).toBe(SecurityReview.securityPrompt)
    expect(security.summary).toContain("1 package checks")
    expect(audit.summary).toContain("Full security audit")
  })

  it("anchors string and glob include, context, and check paths to the package", () => {
    const targets = SecurityReview.SecurityReview({
      cwd: "packages/example",
      checks: [check],
      include: ["internal/**", Input.glob("cmd/**", { exclude: ["cmd/testdata/**"] }), "//shared/auth/**"],
      context: ["README.md"],
      base: "HEAD",
      batchSize: 2,
      auditBatchSize: 16,
      summary: "Custom."
    })
    const diff = attrsOf(targets.security)
    expect(diff.include).toEqual([
      Input.Glob.make({ pattern: "//packages/example/internal/**", exclude: [] }),
      Input.Glob.make({ pattern: "//packages/example/cmd/**", exclude: ["//packages/example/cmd/testdata/**"] }),
      Input.Glob.make({ pattern: "//shared/auth/**", exclude: [] })
    ])
    expect(diff.context).toEqual([Input.Glob.make({ pattern: "//packages/example/README.md", exclude: [] })])
    expect(diff.changes.base).toBe("HEAD")
    expect(diff.batchSize).toBe(2)
    expect(attrsOf(targets.securityAudit).batchSize).toBe(16)
    expect(Target.metadata(targets.security).summary).toBe("Custom.")
    expect(diff.rubric).toContain("Focus: packages/example/src/upload/**")
  })

  it("focuses a check without paths on every reviewed file", () => {
    const { paths: _paths, ...unfocused } = check
    const rubric = attrsOf(SecurityReview.SecurityReview({ cwd: "p", checks: [unfocused] }).security).rubric
    expect(rubric.split("\n").filter((line) => line === "Focus: every reviewed file")).toHaveLength(2)
  })

  it("defaults a codex review to gpt-6-sol and keeps an explicit model", () => {
    expect(attrsOf(SecurityReview.SecurityReview({ cwd: "p", checks: [], engine: "codex" }).security).model)
      .toBe(SecurityReview.defaultCodexModel)
    expect(attrsOf(SecurityReview.SecurityReview({ cwd: "p", checks: [], model: "claude-fable-5-1" }).security).model)
      .toBe("claude-fable-5-1")
  })
})

describe("SecurityReview rubric", () => {
  const rubric = attrsOf(SecurityReview.SecurityReview({ cwd: "packages/example", checks: [check] }).security).rubric

  it("renders every declared check before the built-in general check", () => {
    expect(rubric).toContain("[upload-path-traversal] Upload paths stay inside the upload root")
    expect(rubric).toContain("Threat: An authenticated user writes files outside their upload directory.")
    expect(rubric).toContain("- A request-supplied file name joined to the root without a prefix check.")
    expect(rubric.indexOf("[upload-path-traversal]")).toBeLessThan(rubric.indexOf("[general]"))
    expect(rubric).toContain("[general] Any other vulnerability")
    expect(rubric).toContain("Focus: every reviewed file")
  })

  it("appends the general check even when no check is declared", () => {
    const general = SecurityReview.renderRubric([SecurityReview.generalCheck])
    expect(attrsOf(SecurityReview.SecurityReview({ cwd: "p", checks: [] }).security).rubric).toBe(general)
    for (
      const vulnerability of [
        "Injection",
        "Authorization",
        "Secrets",
        "Path traversal",
        "SSRF",
        "deserialization",
        "Command execution",
        "Crypto misuse",
        "Prompt injection",
        "Supply chain",
        "Denial of service",
        "Information leaks"
      ]
    ) {
      expect(general).toContain(vulnerability)
    }
  })

  it("asks for structured evidence and a release recommendation", () => {
    for (
      const field of [
        "checkId",
        "impact",
        "verification",
        "releaseRecommendation",
        "attackerPreconditions",
        "evidence",
        "nextConfirmationStep"
      ]
    ) expect(rubric).toContain(field)
    expect(rubric).toContain("suspected")
    expect(rubric).toContain("file and line point at the vulnerable operation")
  })

  it("frames the run as the owner's authorized defensive review without exploit weaponization", () => {
    expect(SecurityReview.securityPrompt).toContain("authorized defensive security review")
    expect(SecurityReview.securityPrompt).toContain("commissioned by the repository owner")
    expect(SecurityReview.securityPrompt).toContain("Do not write exploit code")
  })
})

describe("SecurityReview check validation", () => {
  const declare = (overrides: Partial<SecurityReview.Check>, extra: ReadonlyArray<SecurityReview.Check> = []) =>
    SecurityReview.SecurityReview({ cwd: "p", checks: [{ ...check, ...overrides }, ...extra] })

  it("rejects a non-kebab, reserved, or duplicate id", () => {
    expect(() => declare({ id: "Upload_Path" })).toThrow("security check id must be kebab-case")
    expect(() => declare({ id: "general" })).toThrow("reserved for the built-in check")
    expect(() => declare({}, [check])).toThrow("security check id is declared twice: upload-path-traversal")
  })

  it("rejects empty or multi-line text and an empty lookFor", () => {
    expect(() => declare({ id: "" })).toThrow("security check id must be one nonempty line")
    expect(() => declare({ title: "two\nlines" })).toThrow("title must be one nonempty line")
    expect(() => declare({ threat: " " })).toThrow("threat must be one nonempty line")
    expect(() => declare({ lookFor: [] })).toThrow("must list at least one lookFor item")
    expect(() => declare({ lookFor: ["ok", ""] })).toThrow("lookFor[1] must be one nonempty line")
    expect(() => declare({ paths: ["../../escape/**"] })).toThrow("escapes the workspace")
  })
})

describe("SecurityReview path validation", () => {
  const workspace = (files: ReadonlyArray<string>): string => {
    const root = NodeFs.mkdtempSync(NodePath.join(NodeOs.tmpdir(), "security-review-paths-"))
    for (const file of files) {
      NodeFs.mkdirSync(NodePath.dirname(NodePath.join(root, file)), { recursive: true })
      NodeFs.writeFileSync(NodePath.join(root, file), "x\n")
    }
    return root
  }
  const root = workspace(["pkg/src/upload/save.ts", "pkg/README.md", "pkg/docs/guide.md", "shared/auth.ts"])
  const declare = (options: Partial<SecurityReview.Options>) =>
    SecurityReview.SecurityReview({ cwd: "pkg", checks: [check], workspaceRoot: root, ...options })

  it("accepts context globs and check paths that match reviewed files", () => {
    expect(() =>
      declare({
        context: ["README.md", "//shared/*.ts"],
        checks: [check, { ...check, id: "auth", paths: ["//shared/auth.ts"] }]
      })
    ).not.toThrow()
  })

  it("rejects a context entry that is prose rather than a file glob", () => {
    expect(() => declare({ context: ["Ops assets for the hosted backend and its load tests."] })).toThrow(
      /context "pkg\/Ops assets for the hosted backend and its load tests\." matches no file/
    )
  })

  it("rejects a context glob that matches nothing", () => {
    expect(() => declare({ context: ["k8s/**"] })).toThrow(/context "pkg\/k8s\/\*\*" matches no file/)
  })

  it("ignores dependency and VCS directories and honours include exclusions", () => {
    const deps = workspace(["pkg/node_modules/x/index.js", "pkg/.git/config.js", "pkg/src/a.ts", "pkg/src/gen/b.ts"])
    NodeFs.symlinkSync(NodePath.join(deps, "pkg/src/a.ts"), NodePath.join(deps, "pkg/src/link.ts"))
    const at = (options: Partial<SecurityReview.Options>) => () =>
      SecurityReview.SecurityReview({ cwd: "pkg", checks: [], workspaceRoot: deps, ...options })
    expect(at({ context: ["**/*.js"] })).toThrow(/context "pkg\/\*\*\/\*\.js" matches no file/)
    expect(at({ context: ["src/link.ts"] })).not.toThrow()
    expect(at({
      include: [Input.glob("src/**", { exclude: ["src/gen/**"] })],
      checks: [{ ...check, paths: ["src/gen/**"] }]
    })).toThrow(/matches no file the review reads/)
  })

  it("rejects a check path that matches no file", () => {
    expect(() => declare({ checks: [{ ...check, paths: ["src/missing/**"] }] })).toThrow(
      /security check upload-path-traversal path "pkg\/src\/missing\/\*\*" matches no file$/
    )
  })

  it("rejects a check path whose files the review never reads", () => {
    expect(() => declare({ checks: [{ ...check, paths: ["docs/*.md"] }] })).toThrow(
      /path "pkg\/docs\/\*\.md" matches no file the review reads/
    )
    expect(() => declare({ context: ["docs/**"], checks: [{ ...check, paths: ["docs/*.md"] }] })).not.toThrow()
  })

  it("derives the root from the declaring PACKAGE.ts and checks its paths", async () => {
    const source = NodePath.resolve(import.meta.dirname, "../src/SecurityReview.ts")
    const declaration = (cwd: string, context: string) =>
      `import { SecurityReview } from ${JSON.stringify(source)}\n` +
      `export const targets = () => SecurityReview({ cwd: ${JSON.stringify(cwd)}, checks: [], ` +
      `context: [${JSON.stringify(context)}] })\n`
    const nested = workspace([])
    NodeFs.mkdirSync(NodePath.join(nested, "a/b"), { recursive: true })
    NodeFs.writeFileSync(NodePath.join(nested, "a/b/README.md"), "x\n")
    NodeFs.writeFileSync(NodePath.join(nested, "a/b/PACKAGE.ts"), declaration("a/b", "README.md"))
    NodeFs.writeFileSync(NodePath.join(nested, "PACKAGE.ts"), declaration(".", "prose, not a glob"))
    const inner = await import(NodePath.join(nested, "a/b/PACKAGE.ts"))
    expect(() => inner.targets()).not.toThrow()
    const outer = await import(NodePath.join(nested, "PACKAGE.ts"))
    expect(() => outer.targets()).toThrow(/context "prose, not a glob" matches no file/)
    NodeFs.mkdirSync(NodePath.join(nested, "c"))
    NodeFs.writeFileSync(NodePath.join(nested, "c/PACKAGE.ts"), declaration("elsewhere", "README.md"))
    const wrong = await import(NodePath.join(nested, "c/PACKAGE.ts"))
    expect(() => wrong.targets()).toThrow(/cwd "elsewhere" does not name the directory of its declaring/)
  })

  it("skips the check outside a PACKAGE.ts when no root is given", () => {
    expect(() => SecurityReview.SecurityReview({ cwd: "pkg", checks: [check], context: ["nothing here"] })).not
      .toThrow()
  })
})
