import * as Schema from "effect/Schema"
import { describe, expect, it } from "vitest"
import * as Bash from "../src/Bash.ts"
import * as Lsp from "../src/Lsp.ts"
import * as Manifest from "../src/Manifest.ts"

const expectedTiers = {
  read: "sealed",
  write: "compensable",
  edit: "compensable",
  ls: "sealed",
  glob: "sealed",
  grep: "sealed",
  bash: "irreversible",
  test: "irreversible",
  shell_command: "irreversible",
  apply_patch: "compensable",
  update_plan: "sealed",
  fetch: "sealed",
  "http-post": "irreversible",
  explore: "sealed",
  webfetch: "sealed",
  websearch: "sealed",
  lsp: "sealed",
  classify: "sealed"
} as const

const imperativeVerbs = new Set([
  "read",
  "write",
  "edit",
  "list",
  "find",
  "match",
  "search",
  "run",
  "execute",
  "fetch",
  "get",
  "post",
  "send",
  "investigate",
  "explore",
  "inspect",
  "ask"
])

describe("effect tiers", () => {
  it("declares the conservative tier expected for every standard flow", () => {
    for (const name of Manifest.names) {
      const declaration = Manifest.flows[name].effects
      expect(declaration, `${name} must declare effects`).toBeDefined()
      expect(declaration?.tier).toBe(expectedTiers[name])
    }
  })

  it("keeps hermetic bash calls irreversible", () => {
    const input = Schema.decodeUnknownSync(Bash.Input)({
      command: "printf ok",
      mode: "hermetic",
      reads: [],
      writes: []
    })

    expect(Bash.effectsFor(input).tier).toBe("irreversible")
  })

  it("keeps every lsp query on the static workspace read envelope", () => {
    // A language server resolves imports, tsconfig, and dependency sources
    // across the workspace, so one queried file under-declares its reads.
    expect(Lsp.effectsFor({ operation: "hover", path: "/workspace/a.ts", line: 1, character: 1 }))
      .toBe(Lsp.effects)
  })

  // Verified byte for byte against the vendor binary at
  // @openai/codex-darwin-arm64 vendor/aarch64-apple-darwin/bin/codex: each
  // string below is the exact run of bytes that binary carries. A clone that
  // paraphrases its original is a different tool wearing its name.
  it("keeps Codex-clone descriptions byte-identical to the Codex CLI", () => {
    expect(Manifest.flows.shell_command.description).toBe(
      "Runs a shell command and returns its output.\n- Always set the `workdir` param when using the shell_command function. Do not use `cd` unless absolutely necessary."
    )
    expect(Manifest.flows.apply_patch.description).toBe(
      "The `apply_patch` tool can be used to edit files. This is a FREEFORM tool, so do not wrap the patch in JSON."
    )
    expect(Manifest.flows.update_plan.description).toBe(
      "Updates the task plan.\nProvide an optional explanation and a list of plan items, each with a step and status.\nAt most one step can be in_progress at a time.\n"
    )
  })

  it("keeps every model-facing description concise and action-first", () => {
    /** Codex clones keep the Codex CLI's exact description text instead. */
    const codexClones = new Set(["shell_command", "apply_patch", "update_plan"])
    for (const [name, flow] of Object.entries(Manifest.flows)) {
      if (codexClones.has(name)) continue
      const description = flow.description ?? ""
      const firstWord = /^[A-Za-z]+/.exec(description)?.[0]?.toLowerCase()

      expect(description.length, name).toBeGreaterThan(0)
      expect(description.length, name).toBeLessThanOrEqual(200)
      expect(description, name).not.toMatch(/^This tool\b/i)
      expect(imperativeVerbs.has(firstWord ?? ""), name).toBe(true)
    }
  })
})
