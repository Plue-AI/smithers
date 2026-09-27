import { describe, expect, test } from "vitest"
import * as LocalApp from "../src/LocalApp.ts"
import { HarnessSchema, RepoSchema, splitLabel, TargetSchema } from "../src/LocalApp.ts"

/*
 * The local-app wire model (apps/app/docs/LOCAL-APP.md "Targets: load and
 * run"): a repository carries its detected workspaces, and a target carries
 * the workspace its loader ran in plus the presentation its declaration
 * stated. There is no repository manifest: a target's summary and featured
 * flag ride the PACKAGE.ts declaration and arrive through the loader listing.
 */

describe("multi-workspace repo wire model", () => {
  test("Repo.smithers carries the detected workspaces and the repo carries warnings", () => {
    const repo = RepoSchema.parse({
      id: "r1",
      path: "/work/aomi",
      name: "aomi",
      git: null,
      warnings: [],
      smithers: {
        detected: true,
        workspaceFile: ".smithers/WORKSPACE.ts",
        declarationFiles: [".smithers/WORKSPACE.ts"],
        reason: "2 workspaces detected",
        workspaces: [
          { path: ".", title: "aomi" },
          { path: "aomi-sdk", title: "aomi-sdk" }
        ]
      }
    })
    expect(repo.smithers.workspaces).toHaveLength(2)
    expect("plugin" in repo).toBe(false)
  })

  test("a Target carries the workspace its loader ran in, and the declaration's summary and featured flag when stated", () => {
    const bare = TargetSchema.parse({
      id: "target-capability",
      label: "//src:lint",
      target: "Shell.Test",
      kinds: ["lint"],
      package: "//src",
      name: "lint",
      workspace: "aomi-sdk"
    })
    expect(bare.workspace).toBe("aomi-sdk")
    expect(bare.summary).toBeUndefined()
    expect(bare.featured).toBeUndefined()
    const annotated = TargetSchema.parse({ ...bare, summary: "ESLint over the sdk.", featured: true })
    expect(annotated.summary).toBe("ESLint over the sdk.")
    expect(annotated.featured).toBe(true)
    expect(TargetSchema.safeParse({ ...bare, summary: 7 }).success).toBe(false)
  })
})

/*
 * The harness table (`HarnessModels` in @smthrs/harness-detect): a row
 * says which binary the app found, whether that binary is signed in, and
 * whether it can be pointed at a model. The account and the model table are
 * the two facts a row may not have, and they say so differently: `account`
 * is present and null when nobody is signed in, while `models` is absent
 * when the app has verified no model flag, so a row persisted before custom
 * agents still parses.
 */
describe("the harness wire model", () => {
  const harness = {
    id: "claude" as const,
    displayName: "Claude Code",
    binary: "/opt/homebrew/bin/claude",
    version: "2.0.14",
    status: "signed-in" as const,
    account: { email: "will@smithers.sh", label: "Max" },
    launch: { argv: ["claude", "--print"] },
    models: { suggestions: ["claude-opus-5"], listable: true }
  }

  test("a row carries the binary, the sign-in state, the account and the model table", () => {
    expect(HarnessSchema.parse(harness)).toEqual(harness)
  })

  test("a harness with no binary, no account and no verified model flag is a row, not a parse failure", () => {
    const unavailable = {
      id: "hermes" as const,
      displayName: "Hermes",
      binary: null,
      version: null,
      status: "unavailable" as const,
      account: null,
      launch: { argv: [] }
    }
    const parsed = HarnessSchema.parse(unavailable)
    expect(parsed).toEqual(unavailable)
    expect(parsed.models).toBeUndefined()
  })

  test("an unknown harness id or sign-in state is refused, and a missing account is not the same as no account", () => {
    expect(HarnessSchema.safeParse({ ...harness, id: "claude-code" }).success).toBe(false)
    expect(HarnessSchema.safeParse({ ...harness, status: "logged-in" }).success).toBe(false)
    const { account: _account, ...withoutAccount } = harness
    expect(HarnessSchema.safeParse(withoutAccount).success).toBe(false)
    const { launch: _launch, ...withoutLaunch } = harness
    expect(HarnessSchema.safeParse(withoutLaunch).success).toBe(false)
    expect(HarnessSchema.safeParse({ ...harness, models: { suggestions: ["x"] } }).success).toBe(false)
  })
})

describe("splitLabel", () => {
  test("splitting a label gives back the package and the name; a label with no colon keeps its last segment as the name", () => {
    expect(splitLabel("//:x")).toEqual({ package: "//", name: "x" })
    expect(splitLabel("//a/b:c")).toEqual({ package: "//a/b", name: "c" })
    expect(splitLabel("//packages/rpc:check")).toEqual({ package: "//packages/rpc", name: "check" })
    expect(splitLabel("//a/b")).toEqual({ package: "//a/b", name: "b" })
    expect(splitLabel("//pkg")).toEqual({ package: "//pkg", name: "pkg" })
  })
})

/* Code intelligence and the Smithers Cloud seam live in their own modules; LocalApp exports none of their names. */
describe("the names that moved out of LocalApp", () => {
  test("LocalApp exports no code-intelligence or Cloud name", () => {
    const domain = /^(?:LSP_|Lsp|lsp|CLOUD_|Cloud|withRetryAfter$|retryAfterOf$|LINEAR_|Linear)/
    expect(Object.keys(LocalApp).filter((name) => domain.test(name))).toEqual([])
  })
})
