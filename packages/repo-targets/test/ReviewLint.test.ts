import { stat } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { maximumContextContentBytes, maximumContextFiles } from "@smthrs/targets/LlmLint"
import { describe, expect, expectTypeOf, it } from "vitest"
import * as Input from "@smthrs/targets/Input"
import { ReviewDocsAgainstCode, ReviewTagsMigrationsAndKeys, ReviewJsdocAgainstCode, smithersReviewPrompt } from "../src/index.ts"
import * as Target from "@smthrs/targets/Target"

/**
 * The three review macros replaced one workspace-wide `lint/PACKAGE.ts` that
 * hand-listed every covered package. What the replacement has to preserve is
 * the rubric, the engine, the failure threshold, and the set of files each
 * review reaches, so these assertions read the emitted attrs rather than the
 * macro's own source.
 */
const attrsOf = (target: Target.AnyTarget): {
  readonly changes: Input.GitDiff
  readonly include: ReadonlyArray<Input.Glob>
  readonly context: ReadonlyArray<Input.Glob>
  readonly prompt: string
  readonly rubric: string
  readonly engine: string
  readonly model: string
  readonly batchSize: number
  readonly failOn: string
} => Target.metadata(target).attrs as never

const workspaceRoot = fileURLToPath(new URL("../../../", import.meta.url))

const expandContext = async (context: ReadonlyArray<Input.Glob>): Promise<ReadonlyArray<string>> => {
  const files = new Set<string>()
  for (const declaration of context) {
    for (const file of await Input.expandGlob(workspaceRoot, "", declaration, { packageScoped: false })) {
      files.add(file)
    }
  }
  return [...files].sort()
}

const contextBytes = async (files: ReadonlyArray<string>): Promise<number> => {
  let bytes = 0
  for (const file of files) bytes += (await stat(new URL(file, new URL("../../../", import.meta.url)))).size
  return bytes
}

describe("ReviewTagsMigrationsAndKeys", () => {
  const target = ReviewTagsMigrationsAndKeys({ cwd: "packages/smithers/flows/journal" })

  it("declares one non-cacheable review-kind LlmLint, gated to that verb", () => {
    const metadata = Target.metadata(target)
    expect(metadata.target).toBe("LlmLint")
    // `review` ALONE. A wildcard `lint`, `test`, `build`, or `ci` pattern
    // selects targets by kind, so a review is invisible to every one of them,
    // and the gate refuses it even through a dependency edge. Both halves
    // matter: the target expands a git diff against `origin/main` at plan
    // time, which the shallow pull-request checkout the other CI jobs take
    // cannot resolve, so planning one under `ci` failed the whole plan.
    expect(metadata.kinds).toEqual(["review"])
    expect(metadata.verbGate).toEqual(["review"])
    expect(metadata.cacheable).toBe(false)
  })

  it("anchors its default include to the declaring package", () => {
    expect(attrsOf(target).include).toEqual([
      { _tag: "Glob", pattern: "//packages/smithers/flows/journal/src/**", exclude: [] }
    ])
  })

  it("narrows the diff to the same paths so an unrelated commit does not re-key it", () => {
    expect(attrsOf(target).changes).toEqual({
      _tag: "GitDiff",
      base: "origin/main",
      paths: ["packages/smithers/flows/journal/src/**"]
    })
  })

  it("bakes the engine, the model tier, the batch size and the failure threshold", () => {
    const attrs = attrsOf(target)
    expect(attrs.engine).toBe("codex")
    expect(attrs.model).toBe("gpt-6-luna")
    expect(attrs.batchSize).toBe(2)
    expect(attrs.failOn).toBe("error")
    expect(attrs.prompt).toBe(smithersReviewPrompt)
    expect(attrs.rubric).toContain("must add a NEW migration")
    expect(attrs.context).toEqual([])
  })

  it("re-roots a caller's package-relative override and leaves a rooted one alone", () => {
    const overridden = ReviewTagsMigrationsAndKeys({
      cwd: "packages/smithers/flows/database",
      include: [Input.glob("src/schema/**", { exclude: ["src/schema/generated/**"] }), Input.glob("//scripts/**")]
    })

    expect(attrsOf(overridden).include).toEqual([
      {
        _tag: "Glob",
        pattern: "//packages/smithers/flows/database/src/schema/**",
        exclude: ["//packages/smithers/flows/database/src/schema/generated/**"]
      },
      { _tag: "Glob", pattern: "//scripts/**", exclude: [] }
    ])
  })

  it("requires cwd, so no declaration falls back to an empty workspace-root //src/** review", () => {
    expectTypeOf(() =>
      // @ts-expect-error cwd is required: every default glob is package-shaped.
      ReviewTagsMigrationsAndKeys({})
    ).toBeFunction()
    expectTypeOf(() =>
      // @ts-expect-error cwd is required: every default glob is package-shaped.
      ReviewDocsAgainstCode()
    ).toBeFunction()
    expectTypeOf(() =>
      // @ts-expect-error cwd is required: every default glob is package-shaped.
      ReviewJsdocAgainstCode({ featured: true })
    ).toBeFunction()
  })

  it("is not featured unless a caller says so", () => {
    expect(Target.metadata(ReviewTagsMigrationsAndKeys({ cwd: "packages/smithers/flows/journal" })).featured).toBe(false)
    expect(Target.metadata(ReviewTagsMigrationsAndKeys({ cwd: "packages/smithers/flows/journal", featured: true })).featured)
      .toBe(true)
  })
})

describe("ReviewDocsAgainstCode", () => {
  const attrs = attrsOf(ReviewDocsAgainstCode({ cwd: "packages/smithers/flows/journal" }))

  it("reads the package prose and the site pages into every batch", () => {
    expect(attrs.context).toEqual([
      { _tag: "Glob", pattern: "//packages/smithers/flows/journal/README.md", exclude: [] },
      { _tag: "Glob", pattern: "//packages/smithers/flows/journal/docs/*.md", exclude: [] },
      { _tag: "Glob", pattern: "//apps/site/src/content/docs/docs/reference/api/journal*.mdx", exclude: [] }
    ])
  })

  it("omits site context at the workspace root", () => {
    expect(attrsOf(ReviewDocsAgainstCode({ cwd: "." })).context).toEqual([
      Input.glob("//README.md"), Input.glob("//docs/*.md")
    ])
  })

  it("derives the reference prefix from a normalized cwd", () => {
    expect(attrsOf(ReviewDocsAgainstCode({ cwd: "./packages/smithers/flows/journal/" })).context)
      .toEqual(attrs.context)
  })

  it("expands the default context across real package boundaries", async () => {
    const files = await expandContext(attrs.context)
    expect(files).toContain("packages/smithers/flows/journal/README.md")
    expect(files).toContain("apps/site/src/content/docs/docs/reference/api/journal.mdx")
  })

  it("keeps the default context within the executor limits", async () => {
    const files = await expandContext(attrs.context)
    expect(files.length).toBeGreaterThan(0)
    expect(files.length).toBeLessThanOrEqual(maximumContextFiles)
    expect(await contextBytes(files)).toBeLessThanOrEqual(maximumContextContentBytes)
  })

  it("keeps the featured root review context within the executor limits", async () => {
    const { Package } = await import(new URL("../../../PACKAGE.ts", import.meta.url).href)
    const files = await expandContext(attrsOf(Package.reviewDocsAgainstCode).context)
    expect(files).toContain("packages/smithers/flows/journal/README.md")
    expect(files).toContain("apps/site/src/content/docs/docs/reference/api/journal.mdx")
    expect(files.length).toBeLessThanOrEqual(maximumContextFiles)
    expect(await contextBytes(files)).toBeLessThanOrEqual(maximumContextContentBytes)
  }, 60_000)

  it("reports at warning while its rubric is tuned", () => {
    expect(attrs.failOn).toBe("warning")
    expect(attrs.batchSize).toBe(3)
    expect(attrs.include).toEqual([{ _tag: "Glob", pattern: "//packages/smithers/flows/journal/src/**", exclude: [] }])
  })
})

describe("ReviewJsdocAgainstCode", () => {
  const attrs = attrsOf(ReviewJsdocAgainstCode({ cwd: "packages/smithers/flows/journal" }))

  it("covers the package's TypeScript sources alone", () => {
    expect(attrs.include).toEqual([{
      _tag: "Glob",
      pattern: "//packages/smithers/flows/journal/src/**/*.ts",
      exclude: []
    }])
    expect(attrs.context).toEqual([])
  })

  it("reports at warning and names truthfulness, not presence, as its scope", () => {
    expect(attrs.failOn).toBe("warning")
    expect(attrs.rubric).toContain("only truthfulness is in scope")
  })
})

describe("the macros take a caller's summary and context", () => {
  it("replaces the baked summary and the baked context set", () => {
    const target = ReviewDocsAgainstCode({
      cwd: "packages/smithers/flows/journal",
      summary: "Journal prose review.",
      context: [Input.glob("//README.md")]
    })

    expect(Target.metadata(target).summary).toBe("Journal prose review.")
    expect(attrsOf(target).context).toEqual([{ _tag: "Glob", pattern: "//README.md", exclude: [] }])
  })
})

describe("the macros take a caller's base revision, model tier and dependencies", () => {
  it("threads all three into the emitted target", () => {
    const dependency = ReviewJsdocAgainstCode({ cwd: "packages/smithers/flows/journal" })
    const target = ReviewTagsMigrationsAndKeys({
      cwd: "packages/smithers/flows/journal",
      base: "origin/next",
      model: "gpt-6-sol",
      deps: [dependency]
    })
    const attrs = attrsOf(target)

    expect(attrs.changes.base).toBe("origin/next")
    expect(attrs.model).toBe("gpt-6-sol")
    expect(Target.metadata(target).dependencies).toEqual([dependency])
  })
})

describe("the macros pair the engine with the model id it runs", () => {
  it("defaults to codex with the codex tier, matching the README's Ask Codex wording", () => {
    const attrs = attrsOf(ReviewJsdocAgainstCode({ cwd: "packages/smithers/flows/journal" }))
    expect(attrs.engine).toBe("codex")
    expect(attrs.model).toBe("gpt-6-luna")
  })

  it("threads a claude engine and its model id through to the emitted attrs", () => {
    const attrs = attrsOf(ReviewTagsMigrationsAndKeys({
      cwd: "packages/smithers/flows/journal",
      engine: "claude",
      model: "claude-opus-5"
    }))
    expect(attrs.engine).toBe("claude")
    expect(attrs.model).toBe("claude-opus-5")
  })

  it("refuses a non-codex engine without a model, so the codex default never reaches another CLI", () => {
    expectTypeOf(() =>
      // @ts-expect-error a claude review must name a Claude model id.
      ReviewDocsAgainstCode({ cwd: "packages/smithers/flows/journal", engine: "claude" })
    ).toBeFunction()
  })

  it("rejects an empty model or an unknown engine at declaration time, as the README's failure contracts state", () => {
    expect(() => ReviewJsdocAgainstCode({ cwd: "packages/smithers/flows/journal", model: "" }))
      .toThrow(/declaration.* is invalid/)
    expect(() =>
      ReviewDocsAgainstCode({ cwd: "packages/smithers/flows/journal", engine: "gemini" as never, model: "m" })
    ).toThrow(/declaration.* is invalid/)
  })
})
