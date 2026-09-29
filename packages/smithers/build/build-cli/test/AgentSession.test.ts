import * as AgentTarget from "@smthrs/targets/AgentTarget"
import * as Input from "@smthrs/targets/Input"
import * as Reference from "@smthrs/targets/Reference"
import * as Effect from "effect/Effect"
import { execFileSync, spawnSync } from "node:child_process"
import { createHash, randomUUID } from "node:crypto"
import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as NodePath from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import * as AgentFake from "../src/AgentFake.ts"
import * as AgentSession from "../src/AgentSession.ts"

let root: string

const git = (...args: ReadonlyArray<string>): void => {
  execFileSync("git", ["-c", "user.email=test@test", "-c", "user.name=test", ...args], {
    cwd: root,
    stdio: "pipe"
  })
}

const write = async (relative: string, text: string): Promise<void> => {
  const path = NodePath.join(root, relative)
  await Fs.mkdir(NodePath.dirname(path), { recursive: true })
  await Fs.writeFile(path, text, "utf8")
}

const read = (relative: string): Promise<string> => Fs.readFile(NodePath.join(root, relative), "utf8")

beforeEach(async () => {
  root = await Fs.realpath(await Fs.mkdtemp(NodePath.join(Os.tmpdir(), "smthrs-agent-")))
  await write("prompt.md", "Reject any added TODO comment.\n")
  await write("src/a.ts", "export const a = 1\n")
  await write("docs/readme.md", "readme\n")
  git("init", "-q")
  git("add", "-A")
  git("commit", "-q", "-m", "initial")
})

afterEach(async () => {
  await Fs.rm(root, { recursive: true, force: true })
})

const scripted = (
  responses: ReadonlyArray<AgentFake.ScriptedResponse>,
  identity?: string
): AgentFake.ScriptedSessionFactory =>
  AgentFake.makeScriptedSessionFactory({
    ...(identity === undefined ? {} : { identity }),
    responses
  })

const runtimeOf = (
  overrides: Partial<AgentSession.AgentRuntime> & { readonly sessions: AgentSession.SessionFactory }
): AgentSession.AgentRuntime => ({
  workspaceRoot: root,
  writeSets: AgentSession.makeLocalWriteSetApplier(root),
  gates: AgentSession.unavailableGateRunner,
  verdicts: AgentSession.makeMemoryVerdictStore(),
  ...overrides
})

const lintPayload = (over: Partial<AgentTarget.LintPayload> = {}): AgentTarget.LintPayload => ({
  promptPath: "prompt.md",
  diffs: [Input.gitDiff({ base: "HEAD", paths: ["src/**"] })],
  fixes: ["src/**"],
  mode: "check",
  ...over
})

const diffPayload = (over: Partial<AgentTarget.DiffPayload> = {}): AgentTarget.DiffPayload => ({
  promptPath: "prompt.md",
  payloadSpec: {},
  mcp: [],
  diffs: [],
  changes: ["src/**"],
  gateIdentities: ["Vitest#gate"],
  maxRounds: 3,
  ...over
})

const finding: AgentTarget.Finding = {
  file: "src/a.ts",
  line: 1,
  severity: "error",
  message: "added a TODO"
}

const red: AgentTarget.GateReportEntry = { gate: "Vitest#gate", status: "red", detail: "1 test failed" }
const green: AgentTarget.GateReportEntry = { gate: "Vitest#gate", status: "green" }

describe("expandDiffSlice", () => {
  it("expands to nothing on a clean tree", async () => {
    const slice = await Effect.runPromise(
      AgentSession.expandDiffSlice(root, [Input.gitDiff({ base: "HEAD", paths: ["src/**"] })])
    )
    expect(slice.files).toEqual([])
    expect(slice.patch).toBe("")
  })

  it("lists only changed files matching the declared globs", async () => {
    await write("src/a.ts", "export const a = 2\n")
    await write("docs/readme.md", "changed\n")
    const slice = await Effect.runPromise(
      AgentSession.expandDiffSlice(root, [Input.gitDiff({ base: "HEAD", paths: ["src/**"] })])
    )
    expect(slice.files).toEqual(["src/a.ts"])
    expect(slice.patch).toContain("export const a = 2")
    expect(slice.patch).not.toContain("readme")
  })

  it("narrows to files whose added lines match addedLines", async () => {
    await write("src/a.ts", "export const a = 1\n// TODO later\n")
    await write("src/b.ts", "export const b = 1\n")
    git("add", "src/b.ts")
    const slice = await Effect.runPromise(
      AgentSession.expandDiffSlice(root, [
        Input.gitDiff({ base: "HEAD", paths: ["src/**"], addedLines: "TODO" })
      ])
    )
    expect(slice.files).toEqual(["src/a.ts"])
  })

  it.each([
    ["src/ascii.ts", "true"],
    ["src/space file.ts", "true"],
    ["src/révision.ts", "true"],
    ["src/révision.ts", "false"],
    ["src/tab\tfile.ts", "true"],
    ["src/quote\"file.ts", "true"],
    ["src/back\\slash.ts", "true"]
  ])("reviews added TODO in %s with core.quotePath=%s", async (path, quotePath) => {
    await write(path, "export const value = 1\n")
    git("add", "--", path)
    git("commit", "-qm", "track unusual path")
    git("config", "core.quotePath", quotePath)
    await write(path, "export const value = 1\n// TODO review me\n")
    const diffs = [Input.gitDiff({ base: "HEAD", paths: [path.includes("\\") ? "src/**" : path], addedLines: "TODO" })]
    const slice = await Effect.runPromise(AgentSession.expandDiffSlice(root, diffs))
    expect(slice.files).toEqual([path])
    const factory = scripted([{ findings: [] }])
    const report = await Effect.runPromise(
      AgentSession.runAgentLint(runtimeOf({ sessions: factory }), lintPayload({ diffs }))
    )
    expect(report.vacuous).toBe(false)
    expect(factory.spawns()).toBe(1)
    expect(factory.requests()).toHaveLength(1)
  })
})

describe("diff slice path and byte boundaries", () => {
  const patchFor = (base: string, path: string): string =>
    execFileSync("git", ["diff", "--no-ext-diff", "--no-textconv", "--no-renames", base, "--", path], {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024
    })

  const twoBases = async (): Promise<ReadonlyArray<Input.GitDiff>> => {
    git("tag", "a-base")
    await write("src/a.ts", "middle\n")
    git("add", "src/a.ts")
    git("commit", "-qm", "middle")
    git("tag", "z-base")
    // Declarations are deliberately opposite to the base sort order.
    return [
      Input.gitDiff({ base: "z-base", paths: ["src/**"] }),
      Input.gitDiff({ base: "a-base", paths: ["docs/**"] })
    ]
  }

  it.each([undefined, "TODO"])("handles thousands of paths with addedLines=%s", async (addedLines) => {
    const files = Array.from(
      { length: 6000 },
      (_, index) => `src/${String(index).padStart(4, "0")}-${"x".repeat(220)}.ts`
    )
    for (const file of files) await write(file, "// TODO next\n")
    await write("docs/readme.md", "excluded TODO\n")
    git("add", "src")
    // These long paths require 47 bounded argv batches, twice under addedLines.
    // Each batch launches a real supervised Git process. The aggregate 30 s
    // production deadline expired under host contention, so this argv-boundary
    // test supplies its own bounded budget through the existing timeout seam.
    const slice = await Effect.runPromise(AgentSession.expandDiffSlice(root, [
      Input.gitDiff({ base: "HEAD", paths: ["src/**"], ...(addedLines === undefined ? {} : { addedLines }) })
    ], 120_000))
    expect(slice.files).toEqual(files)
    expect(slice.patch.match(/^diff --git /gm)).toHaveLength(files.length)
    expect(slice.patch).not.toContain("excluded TODO")
    expect(slice.patch.indexOf(files[0]!)).toBeLessThan(slice.patch.indexOf(files.at(-1)!))
    expect(slice.digest).toBe(createHash("sha256").update(slice.patch).digest("hex"))
  }, 300_000)

  it("renders two bases in base order with each patch using its declared base", async () => {
    const diffs = await twoBases()
    await write("src/a.ts", "last\n")
    await write("docs/readme.md", "changed\n")
    const slice = await Effect.runPromise(AgentSession.expandDiffSlice(root, diffs))
    expect(slice.files).toEqual(["docs/readme.md", "src/a.ts"])
    expect(slice.patch).toBe([patchFor("a-base", "docs/readme.md"), patchFor("z-base", "src/a.ts")].join("\n"))
    expect(slice.patch).toContain("-middle\n+last")
    expect(slice.digest).toBe(createHash("sha256").update(slice.patch).digest("hex"))
  })

  it.each([0, 1])("checks the aggregate diff ceiling at N+%i UTF-8 bytes across two bases", async (extra) => {
    const diffs = await twoBases()
    await write("src/a.ts", "é\n")
    await write("docs/readme.md", "é\n")
    const overhead = Buffer.byteLength(
      [patchFor("a-base", "docs/readme.md"), patchFor("z-base", "src/a.ts")].join("\n")
    )
    const padding = AgentSession.maximumDiffSliceBytes + extra - overhead
    await write("src/a.ts", `é${"x".repeat(Math.floor(padding / 2))}\n`)
    await write("docs/readme.md", `é${"x".repeat(Math.ceil(padding / 2))}\n`)
    const parts = [patchFor("a-base", "docs/readme.md"), patchFor("z-base", "src/a.ts")]
    expect(parts.every((part) => Buffer.byteLength(part) < AgentSession.maximumDiffSliceBytes)).toBe(true)
    expect(Buffer.byteLength(parts.join("\n"))).toBe(AgentSession.maximumDiffSliceBytes + extra)
    const effect = AgentSession.expandDiffSlice(root, diffs)
    if (extra === 0) {
      expect((await Effect.runPromise(effect)).patch).toBe(parts.join("\n"))
    } else {
      const error = await Effect.runPromise(Effect.flip(effect))
      expect(error.phase).toBe("diff")
      expect(error.message).toContain(`the expanded diff slice exceeds ${AgentSession.maximumDiffSliceBytes} bytes`)
    }
  })

  it.each([0, 1])("checks the rendered prompt ceiling at N+%i UTF-8 bytes", async (extra) => {
    await write("src/a.ts", "changed\n")
    const dataFiles = Array.from({ length: 16 }, (_, index) => `data/${index}.txt`)
    for (const file of dataFiles) await write(file, "é")
    const probe = scripted([{ findings: [] }])
    await Effect.runPromise(AgentSession.runAgentLint(runtimeOf({ sessions: probe, dataFiles }), lintPayload()))
    const overhead = Buffer.byteLength(probe.requests()[0]!.prompt)
    let padding = AgentSession.maximumSessionPromptBytes + extra - overhead
    for (const file of dataFiles) {
      const size = Math.min(padding, AgentSession.maximumSessionFileBytes - 2)
      await write(file, `é${"x".repeat(size)}`)
      padding -= size
    }
    expect(padding).toBe(0)
    const factory = scripted([{ findings: [] }])
    const effect = AgentSession.runAgentLint(runtimeOf({ sessions: factory, dataFiles }), lintPayload())
    if (extra === 0) {
      await Effect.runPromise(effect)
      expect(Buffer.byteLength(factory.requests()[0]!.prompt)).toBe(AgentSession.maximumSessionPromptBytes)
      expect(factory.spawns()).toBe(1)
    } else {
      const error = await Effect.runPromise(Effect.flip(effect))
      expect(error._tag).toBe("smithers-build/AgentSessionError")
      expect(error.message).toContain(
        `the rendered session prompt exceeds ${AgentSession.maximumSessionPromptBytes} bytes`
      )
      expect(factory.spawns()).toBe(0)
    }
  })
})

describe("Agent.Lint", () => {
  it("settles green with an explicit vacuous note and zero session spawns on an empty slice", async () => {
    const factory = scripted([])
    const report = await Effect.runPromise(runAgentLint(factory))
    expect(report.vacuous).toBe(true)
    expect(report.note).toBe("vacuous: agent not invoked")
    expect(report.files).toEqual([])
    expect(factory.opens()).toBe(0)
    expect(factory.spawns()).toBe(0)
  })

  it("refuses loudly when no gitDiff data member is declared", async () => {
    const factory = scripted([])
    const error = await Effect.runPromise(
      Effect.flip(AgentSession.runAgentLint(runtimeOf({ sessions: factory }), lintPayload({ diffs: [] })))
    )
    expect(error._tag).toBe("smithers-build/AgentSessionError")
    expect(error.message).toContain("S.gitDiff")
    expect(factory.spawns()).toBe(0)
  })

  it("fails typed with the findings in check mode", async () => {
    await write("src/a.ts", "export const a = 1\n// TODO later\n")
    const factory = scripted([{ purpose: "lint", findings: [finding] }])
    const error = await Effect.runPromise(Effect.flip(runAgentLint(factory)))
    expect(error._tag).toBe("smithers-build/AgentFindingsError")
    if (error._tag !== "smithers-build/AgentFindingsError") return
    expect(error.findings).toEqual([finding])
    expect(factory.spawns()).toBe(1)
  })

  it("caches a green check verdict and replays it with zero spawns", async () => {
    await write("src/a.ts", "export const a = 2\n")
    const verdicts = AgentSession.makeMemoryVerdictStore()
    const first = scripted([{ purpose: "lint", findings: [] }])
    const report = await Effect.runPromise(runAgentLint(first, { verdicts }))
    expect(report.vacuous).toBe(false)
    expect(report.files).toEqual(["src/a.ts"])
    expect(first.spawns()).toBe(1)
    // An empty script fails loudly on any spawn, so a green replay proves zero.
    const replay = scripted([])
    const replayed = await Effect.runPromise(runAgentLint(replay, { verdicts }))
    expect(replayed).toEqual(report)
    expect(replay.spawns()).toBe(0)
  })

  it("re-spawns when the prompt, the diff, or the agent identity changes the key", async () => {
    await write("src/a.ts", "export const a = 2\n")
    const verdicts = AgentSession.makeMemoryVerdictStore()
    await Effect.runPromise(runAgentLint(scripted([{ findings: [] }]), { verdicts }))

    // Prompt digest change: the empty script proves a session was demanded.
    await write("prompt.md", "Reject any added FIXME comment.\n")
    const afterPrompt = await Effect.runPromise(
      Effect.flip(runAgentLint(scripted([]), { verdicts }))
    )
    expect(afterPrompt.message).toContain("exhausted")

    // Restore the prompt: the original verdict still replays.
    await write("prompt.md", "Reject any added TODO comment.\n")
    const restored = scripted([])
    await Effect.runPromise(runAgentLint(restored, { verdicts }))
    expect(restored.spawns()).toBe(0)

    // Diff digest change.
    await write("src/a.ts", "export const a = 3\n")
    const afterDiff = await Effect.runPromise(
      Effect.flip(runAgentLint(scripted([]), { verdicts }))
    )
    expect(afterDiff.message).toContain("exhausted")
    await write("src/a.ts", "export const a = 2\n")

    // Agent identity change.
    const afterIdentity = await Effect.runPromise(
      Effect.flip(runAgentLint(scripted([], "another-agent"), { verdicts }))
    )
    expect(afterIdentity.message).toContain("exhausted")
  })

  it("treats info findings as advisory: green with them in the report, red on warning or error", async () => {
    await write("src/a.ts", "export const a = 2\n// TODO later\n")
    const info: AgentTarget.Finding = { ...finding, severity: "info", message: "in-memory tally; lost on restart" }
    const advisory = scripted([{ purpose: "lint", findings: [info] }])
    const report = await Effect.runPromise(runAgentLint(advisory))
    expect(report.findings).toEqual([info])
    expect(report.vacuous).toBe(false)

    const mixed = scripted([{ purpose: "lint", findings: [info, { ...finding, severity: "warning" }] }])
    const error = await Effect.runPromise(Effect.flip(runAgentLint(mixed)))
    expect(error._tag).toBe("smithers-build/AgentFindingsError")
    expect(error.message).toBe("the agent reported 1 finding(s)")
    if (error._tag === "smithers-build/AgentFindingsError") expect(error.findings).toHaveLength(2)

    const fixedWithInfo = scripted([{ purpose: "fix", findings: [info], edits: [] }])
    const fixReport = await Effect.runPromise(runAgentLint(fixedWithInfo, {}, lintPayload({ mode: "fix" })))
    expect(fixReport.findings).toEqual([info])
    expect(fixReport.fixed).toEqual([])
  })

  it("applies fix-mode edits confined to the fixes write-set", async () => {
    await write("src/a.ts", "export const a = 2\n// TODO later\n")
    const factory = scripted([
      { purpose: "fix", findings: [], edits: [{ path: "src/a.ts", contents: "export const a = 2\n" }] }
    ])
    const report = await Effect.runPromise(runAgentLint(factory, {}, lintPayload({ mode: "fix" })))
    expect(report.fixed).toEqual(["src/a.ts"])
    expect(await read("src/a.ts")).toBe("export const a = 2\n")
    expect(factory.spawns()).toBe(1)
  })

  it("says whether a fix-mode answer wrote anything when findings remain", async () => {
    await write("src/a.ts", "export const a = 2\n// TODO later\n")
    const silent = scripted([{ purpose: "fix", findings: [finding], edits: [] }])
    const nothing = await Effect.runPromise(
      Effect.flip(runAgentLint(silent, {}, lintPayload({ mode: "fix" })))
    )
    expect(nothing.message).toBe("the agent proposed no edits and reported 1 finding(s)")
    expect(await read("src/a.ts")).toBe("export const a = 2\n// TODO later\n")

    const partial = scripted([
      { purpose: "fix", findings: [finding], edits: [{ path: "src/a.ts", contents: "export const a = 2\n" }] }
    ])
    const remaining = await Effect.runPromise(
      Effect.flip(runAgentLint(partial, {}, lintPayload({ mode: "fix" })))
    )
    expect(remaining.message).toBe("the agent wrote src/a.ts and still reports 1 finding(s)")
    expect(await read("src/a.ts")).toBe("export const a = 2\n")
  })

  it("rejects a fix-mode edit outside the write-set without touching the tree", async () => {
    await write("src/a.ts", "export const a = 2\n")
    const factory = scripted([
      { purpose: "fix", findings: [], edits: [{ path: "docs/readme.md", contents: "escaped" }] }
    ])
    const error = await Effect.runPromise(
      Effect.flip(runAgentLint(factory, {}, lintPayload({ mode: "fix" })))
    )
    expect(error._tag).toBe("smithers-build/AgentWriteEscape")
    expect(await read("docs/readme.md")).toBe("readme\n")
  })

  it("fails typed when fix-mode findings remain after the edits", async () => {
    await write("src/a.ts", "export const a = 2\n// TODO later\n")
    const factory = scripted([
      {
        purpose: "fix",
        findings: [finding],
        edits: [{ path: "src/a.ts", contents: "export const a = 2\n" }]
      }
    ])
    const error = await Effect.runPromise(
      Effect.flip(runAgentLint(factory, {}, lintPayload({ mode: "fix" })))
    )
    expect(error._tag).toBe("smithers-build/AgentFindingsError")
  })

  const runAgentLint = (
    sessions: AgentSession.SessionFactory,
    overrides: Partial<AgentSession.AgentRuntime> = {},
    payload: AgentTarget.LintPayload = lintPayload()
  ) => AgentSession.runAgentLint(runtimeOf({ sessions, ...overrides }), payload)
})

describe("Agent.Diff", () => {
  it("renders the runtime's data files under === FILES ===, omitting oversized and binary bodies by name", async () => {
    await Fs.mkdir(NodePath.join(root, "src"), { recursive: true })
    await Fs.writeFile(NodePath.join(root, "src/a.ts"), "export const a = 1\n")
    await Fs.writeFile(NodePath.join(root, "big.txt"), Buffer.alloc(AgentSession.maximumSessionFileBytes + 1, 0x61))
    await Fs.writeFile(NodePath.join(root, "nul.dat"), Buffer.from([0x62, 0x00, 0x63]))
    const dataFiles = ["src/a.ts", "big.txt", "nul.dat"]

    const rendered = await Effect.runPromise(AgentSession.renderDataFiles(root, dataFiles))
    expect(rendered).toBe(
      "\n\n=== FILES ===\n\n--- src/a.ts ---\nexport const a = 1\n\n\n" +
        `--- big.txt (omitted: ${AgentSession.maximumSessionFileBytes + 1} bytes) ---\n\n` +
        "--- nul.dat (omitted: binary) ---"
    )
    expect(await Effect.runPromise(AgentSession.renderDataFiles(root, []))).toBe("")
    const missing = await Effect.runPromise(Effect.flip(AgentSession.renderDataFiles(root, ["absent.ts"])))
    expect(missing._tag).toBe("smithers-build/AgentSessionError")

    const factory = scripted([{ purpose: "diff", edits: [{ path: "src/gen.ts", contents: "v1\n" }] }])
    await Effect.runPromise(
      AgentSession.runAgentDiff(
        runtimeOf({ sessions: factory, gates: AgentFake.makeScriptedGateRunner([[green]]), dataFiles }),
        diffPayload()
      )
    )
    const prompt = factory.requests()[0]!.prompt
    expect(prompt).toContain("=== FILES ===\n\n--- src/a.ts ---\nexport const a = 1\n")
    expect(prompt.indexOf("=== FILES ===")).toBeGreaterThan(prompt.indexOf("Respond with one JSON object"))
    // A tool-less session is told so, before a prompt can imply "check the tree".
    expect(prompt).toContain("You have no tools and no filesystem, shell, or network access in this session")

    // Without data files the prompt carries no section at all.
    const bare = scripted([{ purpose: "diff", edits: [{ path: "src/gen.ts", contents: "v1\n" }] }])
    await Effect.runPromise(
      AgentSession.runAgentDiff(
        runtimeOf({ sessions: bare, gates: AgentFake.makeScriptedGateRunner([[green]]) }),
        diffPayload()
      )
    )
    expect(bare.requests()[0]!.prompt).not.toContain("=== FILES ===")
  })

  it("refuses a missing required payload input before any session exists", async () => {
    const factory = scripted([])
    const error = await Effect.runPromise(
      Effect.flip(AgentSession.runAgentDiff(
        runtimeOf({ sessions: factory }),
        diffPayload({ payloadSpec: { ticket: Reference.inputString("the ticket id") } })
      ))
    )
    expect(error._tag).toBe("smithers-build/AgentNeedsInput")
    if (error._tag !== "smithers-build/AgentNeedsInput") return
    expect(error.field).toBe("ticket")
    expect(factory.opens()).toBe(0)
    expect(factory.spawns()).toBe(0)
  })

  it("refuses an out-of-set literal and an undeclared payload value pre-spawn", async () => {
    const factory = scripted([])
    const spec = { level: Reference.inputLiterals(["low", "high"]) }
    const literal = await Effect.runPromise(
      Effect.flip(AgentSession.runAgentDiff(
        runtimeOf({ sessions: factory, payloadValues: { level: "medium" } }),
        diffPayload({ payloadSpec: spec })
      ))
    )
    expect(literal._tag).toBe("smithers-build/AgentNeedsInput")
    const undeclared = await Effect.runPromise(
      Effect.flip(AgentSession.runAgentDiff(
        runtimeOf({ sessions: factory, payloadValues: { level: "low", extra: "x" } }),
        diffPayload({ payloadSpec: spec })
      ))
    )
    expect(undeclared._tag).toBe("smithers-build/AgentNeedsInput")
    expect(factory.opens()).toBe(0)
  })

  it("refuses an unreachable MCP server before any session exists", async () => {
    const factory = scripted([])
    const error = await Effect.runPromise(
      Effect.flip(AgentSession.runAgentDiff(
        runtimeOf({ sessions: factory, mcpProbeTimeoutMs: 500 }),
        diffPayload({
          mcp: [Reference.Mcp.Http("issues", "http://127.0.0.1:1/mcp")]
        })
      ))
    )
    expect(error._tag).toBe("smithers-build/AgentMcpUnreachable")
    if (error._tag !== "smithers-build/AgentMcpUnreachable") return
    expect(error.name).toBe("issues")
    expect(factory.opens()).toBe(0)
    expect(factory.spawns()).toBe(0)
  })

  it("converges when a later round turns the gates green, feeding red reports back in", async () => {
    const factory = scripted([
      { purpose: "diff", edits: [{ path: "src/gen.ts", contents: "v1\n" }] },
      { purpose: "diff", edits: [{ path: "src/gen.ts", contents: "v2\n" }] }
    ])
    const gates = AgentFake.makeScriptedGateRunner([[red], [green]])
    const result = await Effect.runPromise(
      AgentSession.runAgentDiff(runtimeOf({ sessions: factory, gates }), diffPayload())
    )
    expect(result.rounds).toBe(2)
    expect(result.edits).toEqual([{ path: "src/gen.ts", contents: "v2\n" }])
    expect(result.gateReport).toEqual([green])
    expect(factory.spawns()).toBe(2)
    expect(gates.calls()).toEqual([
      { round: 1, gates: ["Vitest#gate"], files: ["src/gen.ts"] },
      { round: 2, gates: ["Vitest#gate"], files: ["src/gen.ts"] }
    ])
    const feedback = factory.requests()[1]!.prompt
    expect(feedback).toContain("ROUND 1 GATE REPORT")
    expect(feedback).toContain("1 test failed")
    // The candidate never touched the worktree.
    await expect(read("src/gen.ts")).rejects.toThrow()
  })

  it("exhausts maxRounds with the final candidate and gate report as artifacts", async () => {
    const factory = scripted([
      { purpose: "diff", edits: [{ path: "src/gen.ts", contents: "v1\n" }] },
      { purpose: "diff", edits: [{ path: "src/gen.ts", contents: "v2\n" }] }
    ])
    const gates = AgentFake.makeScriptedGateRunner([[red], [red]])
    const error = await Effect.runPromise(
      Effect.flip(AgentSession.runAgentDiff(
        runtimeOf({ sessions: factory, gates }),
        diffPayload({ maxRounds: 2 })
      ))
    )
    expect(error._tag).toBe("smithers-build/AgentRoundsExhausted")
    if (error._tag !== "smithers-build/AgentRoundsExhausted") return
    expect(error.rounds).toBe(2)
    expect(error.diff).toContain("v2")
    expect(error.gateReport).toEqual([red])
    expect(factory.spawns()).toBe(2)
  })

  it("rejects an out-of-set candidate edit as a typed write escape", async () => {
    const factory = scripted([
      { purpose: "diff", edits: [{ path: "docs/readme.md", contents: "escaped" }] }
    ])
    const error = await Effect.runPromise(
      Effect.flip(AgentSession.runAgentDiff(
        runtimeOf({ sessions: factory, gates: AgentFake.makeScriptedGateRunner([[green]]) }),
        diffPayload()
      ))
    )
    expect(error._tag).toBe("smithers-build/AgentWriteEscape")
    if (error._tag !== "smithers-build/AgentWriteEscape") return
    expect(error.path).toBe("docs/readme.md")
    expect(error.writeSet).toEqual(["src/**"])
  })

  it("caches a green verdict under the full key and replays with zero spawns", async () => {
    const verdicts = AgentSession.makeMemoryVerdictStore()
    const first = scripted([{ purpose: "diff", edits: [{ path: "src/gen.ts", contents: "v1\n" }] }])
    const result = await Effect.runPromise(
      AgentSession.runAgentDiff(
        runtimeOf({ sessions: first, gates: AgentFake.makeScriptedGateRunner([[green]]), verdicts }),
        diffPayload()
      )
    )
    expect(first.spawns()).toBe(1)
    const replay = scripted([])
    const replayGates = AgentFake.makeScriptedGateRunner([])
    const replayed = await Effect.runPromise(
      AgentSession.runAgentDiff(
        runtimeOf({ sessions: replay, gates: replayGates, verdicts }),
        diffPayload()
      )
    )
    expect(replayed).toEqual(result)
    expect(replay.spawns()).toBe(0)
    expect(replayGates.calls()).toEqual([])
    // A different gate set is a different key: the loop runs again.
    const rekeyed = scripted([{ purpose: "diff", edits: [{ path: "src/gen.ts", contents: "v1\n" }] }])
    await Effect.runPromise(
      AgentSession.runAgentDiff(
        runtimeOf({
          sessions: rekeyed,
          gates: AgentFake.makeScriptedGateRunner([[{ ...green, gate: "Vitest#other" }]]),
          verdicts
        }),
        diffPayload({ gateIdentities: ["Vitest#other"] })
      )
    )
    expect(rekeyed.spawns()).toBe(1)
  })
})

describe("Agent.Pr", () => {
  it("refuses the settle with the candidate preserved when no opener is bound", async () => {
    const factory = scripted([{ purpose: "diff", edits: [{ path: "src/gen.ts", contents: "v1\n" }] }])
    const error = await Effect.runPromise(
      Effect.flip(AgentSession.runAgentPr(
        runtimeOf({ sessions: factory, gates: AgentFake.makeScriptedGateRunner([[green]]) }),
        diffPayload()
      ))
    )
    expect(error._tag).toBe("smithers-build/AgentPrSettleRefused")
    if (error._tag !== "smithers-build/AgentPrSettleRefused") return
    expect(error.diff).toContain("v1")
    expect(error.gateReport).toEqual([green])
  })

  it("settles through a bound opener with the converged candidate", async () => {
    const opened: Array<string> = []
    const opener: AgentSession.PrOpener = {
      open: (candidate) =>
        Effect.sync(() => {
          opened.push(candidate.diff)
          return "https://example.test/pr/1"
        })
    }
    const factory = scripted([{ purpose: "diff", edits: [{ path: "src/gen.ts", contents: "v1\n" }] }])
    const result = await Effect.runPromise(
      AgentSession.runAgentPr(
        runtimeOf({
          sessions: factory,
          gates: AgentFake.makeScriptedGateRunner([[green]]),
          prOpener: opener
        }),
        diffPayload()
      )
    )
    expect(result.pr).toBe("https://example.test/pr/1")
    expect(opened).toHaveLength(1)
  })
})

describe("write-set applier", () => {
  it("rejects traversal, absolute, and repository-database paths", async () => {
    const applier = AgentSession.makeLocalWriteSetApplier(root)
    for (const path of ["../outside.ts", "/etc/hosts", ".git/config", "src/../../x.ts"]) {
      const error = await Effect.runPromise(
        Effect.flip(applier.apply([{ path, contents: "x" }], ["**"], undefined))
      )
      expect(error._tag).toBe("smithers-build/AgentWriteEscape")
    }
  })

  it("rejects an edit travelling through a symlinked component", async () => {
    await Fs.mkdir(NodePath.join(root, "elsewhere"))
    await Fs.symlink(NodePath.join(root, "elsewhere"), NodePath.join(root, "src", "link"))
    const applier = AgentSession.makeLocalWriteSetApplier(root)
    const error = await Effect.runPromise(
      Effect.flip(applier.apply([{ path: "src/link/b.ts", contents: "x" }], ["src/**"], undefined))
    )
    expect(error._tag).toBe("smithers-build/AgentWriteEscape")
    expect(error.message).toContain("symlink")
  })

  it("layers later edits over earlier ones and commits deletions", async () => {
    const applier = AgentSession.makeLocalWriteSetApplier(root)
    const first = await Effect.runPromise(
      applier.apply([{ path: "src/a.ts", contents: "v1\n" }], ["src/**"], undefined)
    )
    const second = await Effect.runPromise(
      applier.apply([{ path: "src/a.ts", contents: null }], ["src/**"], first)
    )
    await Effect.runPromise(applier.commit(second))
    await expect(read("src/a.ts")).rejects.toThrow()
  })
})

describe("scripted fake and environment selection", () => {
  it("fails loudly on a purpose mismatch and on script exhaustion", async () => {
    const factory = scripted([{ purpose: "fix", findings: [] }])
    const session = await Effect.runPromise(factory.open(undefined))
    const mismatch = await Effect.runPromise(
      Effect.flip(session.run({ purpose: "lint", prompt: "p" }))
    )
    expect(mismatch.message).toContain("purpose")
    const exhausted = await Effect.runPromise(
      Effect.flip(session.run({ purpose: "lint", prompt: "p" }))
    )
    expect(exhausted.message).toContain("exhausted")
  })

  it("replays a scripted failure as a typed session error", async () => {
    const factory = scripted([{ fail: "scripted flake" }])
    const session = await Effect.runPromise(factory.open(undefined))
    const error = await Effect.runPromise(Effect.flip(session.run({ purpose: "diff", prompt: "p" })))
    expect(error._tag).toBe("smithers-build/AgentSessionError")
    expect(error.message).toBe("scripted flake")
  })

  it("selects the fake from SMTHRS_AGENT_FAKE and logs every spawn beside the script", async () => {
    const script = NodePath.join(root, "fake.json")
    await Fs.writeFile(
      script,
      JSON.stringify({ identity: "env-fake", responses: [{ findings: [] }, { findings: [] }] }),
      "utf8"
    )
    const factory = AgentFake.sessionFactoryFromEnvironment(
      { workspaceRoot: root, agents: undefined },
      { SMTHRS_AGENT_FAKE: "fake.json" }
    )
    const session = await Effect.runPromise(factory.open(undefined))
    expect(session.identity).toBe("env-fake")
    await Effect.runPromise(session.run({ purpose: "lint", prompt: "one" }))
    await Effect.runPromise(session.run({ purpose: "lint", prompt: "two" }))
    const log = await Fs.readFile(`${script}.spawns.jsonl`, "utf8")
    const lines = log.trim().split("\n").map((line) => JSON.parse(line) as { seq: number; purpose: string })
    expect(lines).toHaveLength(2)
    expect(lines[0]).toMatchObject({ seq: 1, purpose: "lint" })
  })

  it("answers the real CLI factory when the variable is unset", async () => {
    const factory = AgentFake.sessionFactoryFromEnvironment(
      { workspaceRoot: root, agents: undefined },
      {}
    )
    const error = await Effect.runPromise(Effect.flip(factory.open(undefined)))
    expect(error._tag).toBe("smithers-build/AgentSessionError")
    expect(error.phase).toBe("resolve")
    expect(error.message).toContain("S.Agents")
  })

  it("takes the session ceiling from SMTHRS_AGENT_TIMEOUT_MS for the real CLI factory", async () => {
    const claude = NodePath.join(root, "fake-claude-slow")
    await Fs.writeFile(claude, "#!/bin/sh\nsleep 30\n", { mode: 0o755 })
    const factory = AgentFake.sessionFactoryFromEnvironment(
      {
        workspaceRoot: root,
        agents: AgentTarget.Agents({ default: AgentTarget.ClaudeCode({ model: "m" }) }),
        executables: { claude }
      },
      { SMTHRS_AGENT_TIMEOUT_MS: "500" }
    )
    const session = await Effect.runPromise(factory.open(undefined))
    const error = await Effect.runPromise(Effect.flip(session.run({ purpose: "lint", prompt: "p" })))
    expect(error.message).toContain("timed out after 500ms")
    expect(AgentFake.sessionTimeoutFromEnvironment({})).toBeUndefined()
    expect(AgentFake.sessionTimeoutFromEnvironment({ SMTHRS_AGENT_TIMEOUT_MS: "" })).toBeUndefined()
    expect(() => AgentFake.sessionTimeoutFromEnvironment({ SMTHRS_AGENT_TIMEOUT_MS: "5m" })).toThrow(
      /positive integer of milliseconds/
    )
    expect(() => AgentFake.sessionTimeoutFromEnvironment({ SMTHRS_AGENT_TIMEOUT_MS: "0" })).toThrow()
  })

  it("refuses an unreadable or invalid script loudly", async () => {
    expect(() => AgentFake.loadFakeScript(NodePath.join(root, "missing.json"))).toThrow()
    const invalid = NodePath.join(root, "invalid.json")
    await Fs.writeFile(invalid, JSON.stringify({ responses: [{ findings: "nope" }] }), "utf8")
    expect(() => AgentFake.loadFakeScript(invalid)).toThrow()
  })
})

describe("agent resolution", () => {
  const agents = AgentTarget.Agents({
    default: AgentTarget.Pool(["luna", "sol"]),
    luna: AgentTarget.ClaudeCode({ model: "claude-luna-1" }),
    sol: AgentTarget.Codex({ model: "gpt-5.6-sol" }),
    both: AgentTarget.Pool(["sol", "default"])
  })

  it("expands pools in declared order, recursively and deduplicated", () => {
    expect(AgentSession.resolveAgents(agents, undefined).map((agent) => agent.name)).toEqual([
      "luna",
      "sol"
    ])
    const both = AgentSession.resolveAgents(agents, { _tag: "AgentRef", name: "both" })
    expect(both.map((agent) => agent.name)).toEqual(["sol", "luna"])
    expect(AgentSession.agentIdentityOf(both)).toBe("codex:gpt-5.6-sol|claude:claude-luna-1")
  })

  it("refuses an unknown name and a pool that resolves to nothing", () => {
    expect(() => AgentSession.resolveAgents(agents, { _tag: "AgentRef", name: "nope" })).toThrow(
      /names no declared workspace agent/
    )
    const selfish = AgentTarget.Agents({ default: AgentTarget.Pool(["default"]) })
    expect(() => AgentSession.resolveAgents(selfish, undefined)).toThrow(/no concrete agent/)
    expect(() => AgentSession.resolveAgents(undefined, undefined)).toThrow(/S\.Agents/)
  })

  it("falls through a pool of unspawnable CLIs and reports every failure", async () => {
    const factory = AgentSession.makeCliSessionFactory({
      workspaceRoot: root,
      agents,
      executables: {
        claude: NodePath.join(root, "no-such-claude"),
        codex: NodePath.join(root, "no-such-codex")
      },
      timeoutMs: 5_000
    })
    const session = await Effect.runPromise(factory.open(undefined))
    const error = await Effect.runPromise(Effect.flip(session.run({ purpose: "lint", prompt: "p" })))
    expect(error.message).toContain("every agent in the pool failed")
    expect(error.message).toContain("luna")
    expect(error.message).toContain("sol")
  })
})

describe("CLI engine adapters", () => {
  const fakeExecutable = async (name: string, script: string): Promise<string> => {
    const path = NodePath.join(root, name)
    await Fs.writeFile(path, `#!/bin/sh\n${script}\n`, { mode: 0o755 })
    return path
  }

  const poolAgents = AgentTarget.Agents({
    default: AgentTarget.Pool(["luna", "sol"]),
    luna: AgentTarget.ClaudeCode({ model: "claude-luna-1" }),
    sol: AgentTarget.Codex({ model: "gpt-5.6-sol" })
  })

  it.each([0, 1])("checks CLI stdout at N+%i UTF-8 bytes including its envelope", async (extra) => {
    const encode = (note: string): string => JSON.stringify({ result: JSON.stringify({ findings: [], note }) })
    const note = "é".repeat(8000)
    // JSON whitespace counts toward stdout without exceeding the note schema limit.
    const output = encode(note) +
      " ".repeat(AgentSession.maximumSessionOutputBytes + extra - Buffer.byteLength(encode(note)))
    expect(Buffer.byteLength(output)).toBe(AgentSession.maximumSessionOutputBytes + extra)
    await write("response.json", output)
    const claude = await fakeExecutable("large-claude", "cat > /dev/null\ncat response.json")
    const session = await Effect.runPromise(
      AgentSession.makeCliSessionFactory({
        workspaceRoot: root,
        agents: AgentTarget.Agents({ default: AgentTarget.ClaudeCode({ model: "m" }) }),
        executables: { claude },
        timeoutMs: 10_000
      }).open(undefined)
    )
    const effect = session.run({ purpose: "lint", prompt: "p" })
    if (extra === 0) {
      expect((await Effect.runPromise(effect)).note).toBe(note)
    } else {
      const error = await Effect.runPromise(Effect.flip(effect))
      expect(error.phase).toBe("spawn")
      expect(error.message).toContain(
        `agent subprocess stdout exceeded ${AgentSession.maximumSessionOutputBytes} bytes`
      )
    }
  })

  it("reports stdinFailure when a silent child closes stdin before reading the prompt", async () => {
    const claude = await fakeExecutable("closed-stdin", "exec 0<&-\nsleep 0.1")
    const session = await Effect.runPromise(
      AgentSession.makeCliSessionFactory({
        workspaceRoot: root,
        agents: AgentTarget.Agents({ default: AgentTarget.ClaudeCode({ model: "m" }) }),
        executables: { claude },
        timeoutMs: 10_000
      }).open(undefined)
    )
    const error = await Effect.runPromise(Effect.flip(session.run({
      purpose: "lint",
      prompt: "x".repeat(AgentSession.maximumSessionPromptBytes)
    })))
    expect(error.phase).toBe("spawn")
    expect(error.message).toContain("stdin could not be written:")
  })

  it("parses the claude JSON envelope from a fake claude CLI", async () => {
    const claude = await fakeExecutable(
      "fake-claude",
      `echo '{"result": "{\\"findings\\": [], \\"note\\": \\"from claude\\"}"}'`
    )
    const factory = AgentSession.makeCliSessionFactory({
      workspaceRoot: root,
      agents: AgentTarget.Agents({ default: AgentTarget.ClaudeCode({ model: "m" }) }),
      executables: { claude },
      timeoutMs: 10_000
    })
    const session = await Effect.runPromise(factory.open(undefined))
    const envelope = await Effect.runPromise(session.run({ purpose: "lint", prompt: "p" }))
    expect(envelope.note).toBe("from claude")
  })

  it("hands claude a mcpServers record: empty without declared servers, the lane's S.Mcp.Http entries with them", async () => {
    const argvPath = NodePath.join(root, "fake-claude-argv.txt")
    const claude = await fakeExecutable(
      "fake-claude-argv",
      `printf '%s\\n' "$@" > "${argvPath}"\necho '{"result": "{\\"findings\\": []}"}'`
    )
    const factory = AgentSession.makeCliSessionFactory({
      workspaceRoot: root,
      agents: AgentTarget.Agents({ default: AgentTarget.ClaudeCode({ model: "m" }) }),
      executables: { claude },
      timeoutMs: 10_000
    })
    const configAfter = async (): Promise<unknown> => {
      const argv = (await Fs.readFile(argvPath, "utf8")).trimEnd().split("\n")
      const flag = argv.indexOf("--mcp-config")
      expect(flag).toBeGreaterThan(-1)
      expect(argv).toContain("--strict-mcp-config")
      return JSON.parse(argv[flag + 1]!)
    }

    const bare = await Effect.runPromise(factory.open(undefined))
    await Effect.runPromise(bare.run({ purpose: "lint", prompt: "p" }))
    // The CLI rejects `{}` ("mcpServers: Invalid input: expected record, received undefined").
    expect(await configAfter()).toEqual({ mcpServers: {} })

    const declared = await Effect.runPromise(
      factory.open(undefined, [Reference.Mcp.Http("issues", "https://example.test/mcp")])
    )
    await Effect.runPromise(declared.run({ purpose: "diff", prompt: "p" }))
    expect(await configAfter()).toEqual({
      mcpServers: { issues: { type: "http", url: "https://example.test/mcp" } }
    })
  })

  it.each(["direct", "fallback"] as const)("hands codex declared MCP config on %s selection", async (selection) => {
    const argvPath = NodePath.join(root, "fake-codex-argv.txt")
    const codex = await fakeExecutable(
      "fake-codex-argv",
      `printf '%s\\n' "$@" > "${argvPath}"\ncat > /dev/null\necho '{"type":"item.completed","item":{"type":"agent_message","text":"{}"}}'`
    )
    const claude = await fakeExecutable("fake-claude-red", `echo "quota exhausted" >&2\nexit 3`)
    const factory = AgentSession.makeCliSessionFactory({
      workspaceRoot: root,
      agents: selection === "fallback"
        ? poolAgents
        : AgentTarget.Agents({ default: AgentTarget.Codex({ model: "m" }) }),
      executables: { claude, codex },
      timeoutMs: 10_000
    })
    for (
      const mcp of [[
        Reference.Mcp.Http("issues", "https://example.test/mcp?q=\"quoted\"&path=\\issues"),
        Reference.Mcp.Http("docs.api", "https://docs.example.test/mcp")
      ], []]
    ) {
      const session = await Effect.runPromise(factory.open(undefined, mcp))
      await Effect.runPromise(session.run({ purpose: "diff", prompt: "p" }))
      const argv = (await Fs.readFile(argvPath, "utf8")).trimEnd().split("\n")
      expect(argv).toContain("--ignore-user-config")
      expect(argv).toContain("--strict-config")
      const flag = argv.indexOf("--config")
      expect(flag).toBeGreaterThan(-1)
      expect(argv[flag + 1]).toBe(
        mcp.length === 0 ?
          "mcp_servers={}" :
          "mcp_servers={\"issues\"={url=\"https://example.test/mcp?q=\\\"quoted\\\"&path=\\\\issues\"},\"docs.api\"={url=\"https://docs.example.test/mcp\"}}"
      )
    }
  })

  it.each(["direct", "pool"] as const)(
    "refuses unsupported Codex MCP names before %s model spend",
    async (selection) => {
      const marker = NodePath.join(root, "unsupported-mcp-spawned")
      const executable = await fakeExecutable("must-not-spawn", `touch "${marker}"\nexit 1`)
      const factory = AgentSession.makeCliSessionFactory({
        workspaceRoot: root,
        agents: selection === "pool" ? poolAgents : AgentTarget.Agents({ default: AgentTarget.Codex({ model: "m" }) }),
        executables: { claude: executable, codex: executable },
        timeoutMs: 10_000
      })
      const outcome = await Effect.runPromise(
        factory.open(undefined, [
          Reference.Mcp.Http("issues with spaces", "https://example.test/mcp")
        ]).pipe(Effect.match({ onFailure: (error) => error, onSuccess: () => undefined }))
      )
      expect(outcome).toMatchObject({
        _tag: "smithers-build/AgentSessionError",
        phase: "resolve",
        message: expect.stringContaining("unsupported MCP capability")
      })
      expect(outcome?.message).toContain("issues with spaces")
      expect(await Fs.access(marker).then(() => true, () => false)).toBe(false)
    }
  )

  it("reports codex's stdout error events when it exits non-zero with an empty stderr", async () => {
    const stream = [
      `{"type":"thread.started","thread_id":"t"}`,
      `{"type":"item.completed","item":{"id":"item_0","type":"error","message":"Model metadata for \`luna\` not found."}}`,
      `{"type":"turn.started"}`,
      `{"type":"error","message":"The luna model is not supported when using Codex with a ChatGPT account."}`,
      `{"type":"turn.failed","error":{"message":"The luna model is not supported when using Codex with a ChatGPT account."}}`
    ]
    const codex = await fakeExecutable(
      "fake-codex-error",
      `cat > /dev/null\n${stream.map((line) => `echo '${line}'`).join("\n")}\nexit 1`
    )
    const factory = AgentSession.makeCliSessionFactory({
      workspaceRoot: root,
      agents: AgentTarget.Agents({ default: AgentTarget.Codex({ model: "luna" }) }),
      executables: { codex },
      timeoutMs: 10_000
    })
    const session = await Effect.runPromise(factory.open(undefined))
    const error = await Effect.runPromise(Effect.flip(session.run({ purpose: "lint", prompt: "p" })))
    expect(error.message).toContain("exited 1: Model metadata for `luna` not found.; The luna model is not supported")
    expect(AgentSession.codexErrorMessages("not json\n{\"type\":\"turn.completed\"}")).toEqual([])
  })

  it("falls back to the stdout tail when claude exits non-zero with nothing on stderr", async () => {
    const claude = await fakeExecutable("fake-claude-quiet", `echo 'rate limited, try later'\nexit 2`)
    const factory = AgentSession.makeCliSessionFactory({
      workspaceRoot: root,
      agents: AgentTarget.Agents({ default: AgentTarget.ClaudeCode({ model: "m" }) }),
      executables: { claude },
      timeoutMs: 10_000
    })
    const session = await Effect.runPromise(factory.open(undefined))
    const error = await Effect.runPromise(Effect.flip(session.run({ purpose: "lint", prompt: "p" })))
    expect(error.message).toContain("exited 2: rate limited, try later")
  })

  it("claudeMcpConfig renders every declared server as a streamable-HTTP entry", () => {
    expect(JSON.parse(AgentSession.claudeMcpConfig([]))).toEqual({ mcpServers: {} })
    expect(
      JSON.parse(
        AgentSession.claudeMcpConfig([
          Reference.Mcp.Http("github", "https://api.githubcopilot.com/mcp/"),
          Reference.Mcp.Http("sentry", "https://mcp.sentry.dev/mcp")
        ])
      )
    ).toEqual({
      mcpServers: {
        github: { type: "http", url: "https://api.githubcopilot.com/mcp/" },
        sentry: { type: "http", url: "https://mcp.sentry.dev/mcp" }
      }
    })
  })

  it("parses the last codex agent_message from a fake codex JSONL stream", async () => {
    const codex = await fakeExecutable(
      "fake-codex",
      `cat > /dev/null
echo '{"type":"item.started","item":{"type":"reasoning"}}'
echo '{"type":"item.completed","item":{"type":"agent_message","text":"{\\"edits\\": []}"}}'
echo '{"type":"item.completed","item":{"type":"agent_message","text":"{\\"note\\": \\"from codex\\"}"}}'`
    )
    const factory = AgentSession.makeCliSessionFactory({
      workspaceRoot: root,
      agents: AgentTarget.Agents({ default: AgentTarget.Codex({ model: "m" }) }),
      executables: { codex },
      timeoutMs: 10_000
    })
    const session = await Effect.runPromise(factory.open(undefined))
    const envelope = await Effect.runPromise(session.run({ purpose: "diff", prompt: "p" }))
    expect(envelope.note).toBe("from codex")
  })

  it("falls through a red-exit claude to the codex pool member", async () => {
    const claude = await fakeExecutable("fake-claude", `echo "quota exhausted" >&2\nexit 3`)
    const codex = await fakeExecutable(
      "fake-codex",
      `cat > /dev/null
echo '{"type":"item.completed","item":{"type":"agent_message","text":"{\\"note\\": \\"fallback\\"}"}}'`
    )
    const factory = AgentSession.makeCliSessionFactory({
      workspaceRoot: root,
      agents: poolAgents,
      executables: { claude, codex },
      timeoutMs: 10_000
    })
    const session = await Effect.runPromise(factory.open(undefined))
    expect(session.identity).toBe("claude:claude-luna-1|codex:gpt-5.6-sol")
    const envelope = await Effect.runPromise(session.run({ purpose: "lint", prompt: "p" }))
    expect(envelope.note).toBe("fallback")
  })

  it("falls through unparseable output and reports both failures when the pool is spent", async () => {
    const claude = await fakeExecutable("fake-claude", `echo 'not json at all'`)
    const codex = await fakeExecutable("fake-codex", `cat > /dev/null\necho '{"type":"turn.completed"}'`)
    const factory = AgentSession.makeCliSessionFactory({
      workspaceRoot: root,
      agents: poolAgents,
      executables: { claude, codex },
      timeoutMs: 10_000
    })
    const session = await Effect.runPromise(factory.open(undefined))
    const error = await Effect.runPromise(Effect.flip(session.run({ purpose: "lint", prompt: "p" })))
    expect(error.message).toContain("luna")
    expect(error.message).toContain("sol")
    expect(error.message).toContain("unexpected codex CLI output")
  })

  it.skipIf(process.platform === "win32")(
    "settles a model that exits naturally while its child holds stdout",
    async () => {
      const token = randomUUID()
      const heartbeat = NodePath.join(root, "natural-exit-heartbeat.json")
      const child = [
        "const fs = require(\"node:fs\")",
        "const { execFileSync } = require(\"node:child_process\")",
        `const token = ${JSON.stringify(token)}`,
        `const path = ${JSON.stringify(heartbeat)}`,
        "const start = execFileSync(\"/bin/ps\", [\"-o\", \"lstart=\", \"-p\", String(process.pid)], { encoding: \"utf8\", env: { LC_ALL: \"C\", PATH: \"/usr/bin:/bin\" } }).trim()",
        "let tick = 0",
        "process.on(\"SIGTERM\", () => {})",
        "const beat = () => { fs.writeFileSync(path + \".tmp\", JSON.stringify({ token, pid: process.pid, start, tick: tick++ })); fs.renameSync(path + \".tmp\", path) }",
        "beat()",
        "setInterval(beat, 25)"
      ].join("\n")
      const body = [
        "import { spawn } from \"node:child_process\"",
        "import { existsSync } from \"node:fs\"",
        "for await (const chunk of process.stdin) {}",
        `spawn(process.execPath, ["-e", ${JSON.stringify(child)}], { stdio: ["ignore", "inherit", "inherit"] })`,
        `const ready = setInterval(() => { if (existsSync(${
          JSON.stringify(heartbeat)
        })) { clearInterval(ready); process.stdout.write(${
          JSON.stringify(JSON.stringify({ result: JSON.stringify({ note: "contained" }) }))
        }, () => process.exit(0)) } }, 5)`
      ].join("\n")
      const readBeat = async (): Promise<{ token: string; pid: number; start: string; tick: number } | undefined> => {
        try {
          return JSON.parse(await Fs.readFile(heartbeat, "utf8"))
        } catch {
          return undefined
        }
      }
      const identity = (pid: number): string => {
        const result = spawnSync("/bin/ps", ["-ww", "-o", "pid=,stat=,lstart=,command=", "-p", String(pid)], {
          encoding: "utf8",
          timeout: 2000,
          env: { LC_ALL: "C", PATH: "/usr/bin:/bin" }
        })
        if (result.status === 1 && result.stdout.trim() === "") return "gone"
        if (result.status !== 0 || result.stdout.trim() === "") {
          throw new Error(
            `ps failed: ${result.error ?? result.stderr}`
          )
        }
        return result.stdout.trim()
      }
      const claude = NodePath.join(root, "natural-exit-claude.mjs")
      await Fs.writeFile(claude, `#!/usr/bin/env node\n${body}\n`, { mode: 0o755 })
      const factory = AgentSession.makeCliSessionFactory({
        workspaceRoot: root,
        agents: AgentTarget.Agents({ default: AgentTarget.ClaudeCode({ model: "m" }) }),
        executables: { claude },
        timeoutMs: 5000
      })
      const session = await Effect.runPromise(factory.open(undefined))
      try {
        const envelope = await Effect.runPromise(session.run({ purpose: "lint", prompt: "p" }))
        expect(envelope.note).toBe("contained")
        const before = await readBeat()
        expect(before?.token).toBe(token)
        await new Promise((resolve) => setTimeout(resolve, 150))
        const after = await readBeat()
        expect(after).toEqual(before)
        const state = identity(after!.pid)
        expect(state === "gone" || /^\d+\s+Z/.test(state), state).toBe(true)
      } finally {
        const beat = await readBeat()
        if (beat?.token === token) {
          const current = identity(beat.pid)
          // A failing lifetime assertion must clean up only this UUID fixture,
          // with its start identity rechecked immediately before signalling.
          if (current.includes(token) && current.includes(beat.start)) {
            try {
              process.kill(beat.pid, "SIGKILL")
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error
            }
          }
        }
      }
    }
  )

  it("kills a session that outlives the deadline", async () => {
    const claude = await fakeExecutable("fake-claude", `sleep 30`)
    const factory = AgentSession.makeCliSessionFactory({
      workspaceRoot: root,
      agents: AgentTarget.Agents({ default: AgentTarget.ClaudeCode({ model: "m" }) }),
      executables: { claude },
      timeoutMs: 300
    })
    const session = await Effect.runPromise(factory.open(undefined))
    const error = await Effect.runPromise(Effect.flip(session.run({ purpose: "lint", prompt: "p" })))
    expect(error.message).toContain("timed out")
  })
})

describe("prompt files and verdict stores", () => {
  it("reads a plain prompt file inside the workspace", async () => {
    await write("src/a.ts", "export const a = 2\n")
    const factory = scripted([{ findings: [] }])
    await Effect.runPromise(
      AgentSession.runAgentLint(runtimeOf({ sessions: factory }), lintPayload())
    )
    expect(factory.requests()[0]!.prompt).toContain("Reject any added TODO comment.")
  })

  it.skipIf(process.platform === "win32")(
    "refuses a prompt whose final component is a symlink outside the workspace",
    async () => {
      const outside = await Fs.mkdtemp(NodePath.join(Os.tmpdir(), "smthrs-agent-outside-"))
      try {
        const hostPrompt = NodePath.join(outside, "prompt.md")
        await Fs.writeFile(hostPrompt, "host prompt\n", "utf8")
        await Fs.symlink(hostPrompt, NodePath.join(root, "linked-prompt.md"))
        await write("src/a.ts", "export const a = 2\n")
        const factory = scripted([])
        const error = await Effect.runPromise(
          Effect.flip(
            AgentSession.runAgentLint(
              runtimeOf({ sessions: factory }),
              lintPayload({ promptPath: "linked-prompt.md" })
            )
          )
        )
        expect(error._tag).toBe("smithers-build/AgentSessionError")
        expect(error).toMatchObject({ phase: "read" })
        expect(factory.opens()).toBe(0)
      } finally {
        await Fs.rm(outside, { recursive: true, force: true })
      }
    }
  )

  it.skipIf(process.platform === "win32")(
    "refuses a prompt whose parent is a symlink outside the workspace",
    async () => {
      const outside = await Fs.mkdtemp(NodePath.join(Os.tmpdir(), "smthrs-agent-outside-"))
      try {
        await Fs.writeFile(NodePath.join(outside, "prompt.md"), "host prompt\n", "utf8")
        await Fs.symlink(outside, NodePath.join(root, "linked-parent"), "dir")
        await write("src/a.ts", "export const a = 2\n")
        const factory = scripted([])
        const error = await Effect.runPromise(
          Effect.flip(
            AgentSession.runAgentLint(
              runtimeOf({ sessions: factory }),
              lintPayload({ promptPath: "linked-parent/prompt.md" })
            )
          )
        )
        expect(error._tag).toBe("smithers-build/AgentSessionError")
        expect(error).toMatchObject({ phase: "read" })
        expect(error.message).toContain("prompt file linked-parent/prompt.md resolves outside the workspace")
        expect(factory.opens()).toBe(0)
      } finally {
        await Fs.rm(outside, { recursive: true, force: true })
      }
    }
  )

  it.skipIf(process.platform === "win32")(
    "refuses a rendered data file whose parent is a symlink outside the workspace",
    async () => {
      const outside = await Fs.mkdtemp(NodePath.join(Os.tmpdir(), "smthrs-agent-outside-"))
      try {
        await Fs.writeFile(NodePath.join(outside, "data.txt"), "host data\n", "utf8")
        await Fs.symlink(outside, NodePath.join(root, "linked-data"), "dir")
        const error = await Effect.runPromise(
          Effect.flip(AgentSession.renderDataFiles(root, ["linked-data/data.txt"]))
        )
        expect(error._tag).toBe("smithers-build/AgentSessionError")
        expect(error.phase).toBe("read")
        expect(error.message).toContain("data file linked-data/data.txt resolves outside the workspace")
      } finally {
        await Fs.rm(outside, { recursive: true, force: true })
      }
    }
  )

  it("resolves //-prefixed prompt paths from the workspace root", async () => {
    await write("src/a.ts", "export const a = 2\n")
    const factory = scripted([{ findings: [] }])
    const report = await Effect.runPromise(
      AgentSession.runAgentLint(
        runtimeOf({ sessions: factory }),
        lintPayload({ promptPath: "//prompt.md", packageDirectory: NodePath.join(root, "src") })
      )
    )
    expect(report.files).toEqual(["src/a.ts"])
  })

  it("refuses a prompt path escaping the workspace and an oversized prompt file", async () => {
    await write("src/a.ts", "export const a = 2\n")
    const escape = await Effect.runPromise(
      Effect.flip(AgentSession.runAgentLint(
        runtimeOf({ sessions: scripted([]) }),
        lintPayload({ promptPath: "../outside.md" })
      ))
    )
    expect(escape.message).toContain("outside the workspace")
    await write("big.md", "x".repeat(AgentTarget.maximumPromptBytes + 1))
    const oversized = await Effect.runPromise(
      Effect.flip(AgentSession.runAgentLint(
        runtimeOf({ sessions: scripted([]) }),
        lintPayload({ promptPath: "big.md" })
      ))
    )
    expect(oversized.message).toContain("exceeds")
  })

  it("stores verdicts in files, atomically, and treats junk entries as misses", async () => {
    const directory = NodePath.join(root, ".cache", "agent")
    const store = AgentSession.makeFileVerdictStore(directory)
    expect(await Effect.runPromise(store.get("missing"))).toBeUndefined()
    await Effect.runPromise(store.put("key", JSON.stringify({ value: 1 })))
    expect(await Effect.runPromise(store.get("key"))).toBe(JSON.stringify({ value: 1 }))
    // A corrupted persisted verdict is a miss, never a crash: the lint runs.
    await write("src/a.ts", "export const a = 2\n")
    const verdicts = AgentSession.makeMemoryVerdictStore()
    const first = scripted([{ findings: [] }])
    await Effect.runPromise(AgentSession.runAgentLint(runtimeOf({ sessions: first, verdicts }), lintPayload()))
    const garbled: AgentSession.AgentVerdictStore = {
      get: () => Effect.succeed("not json"),
      put: () => Effect.void
    }
    const rerun = scripted([{ findings: [] }])
    const report = await Effect.runPromise(
      AgentSession.runAgentLint(runtimeOf({ sessions: rerun, verdicts: garbled }), lintPayload())
    )
    expect(report.vacuous).toBe(false)
    expect(rerun.spawns()).toBe(1)
  })

  it("refuses declared gates without a bound runner, loudly", async () => {
    const error = await Effect.runPromise(
      Effect.flip(AgentSession.unavailableGateRunner.run(["g1"], {
        files: new Map(),
        read: () => Promise.resolve(undefined),
        render: () => ""
      }, 1))
    )
    expect(error.message).toContain("no gate runner is bound")
    expect(
      await Effect.runPromise(AgentSession.unavailableGateRunner.run([], {
        files: new Map(),
        read: () => Promise.resolve(undefined),
        render: () => ""
      }, 1))
    ).toEqual([])
  })

  it("decodes optional and empty payload values precisely", async () => {
    const spec = {
      ticket: Reference.inputString("the ticket"),
      level: Reference.inputOptional(Reference.inputLiterals(["low", "high"]))
    }
    expect(
      await Effect.runPromise(AgentSession.decodePayloadValues(spec, { ticket: "T-1" }))
    ).toEqual({ ticket: "T-1" })
    expect(
      await Effect.runPromise(AgentSession.decodePayloadValues(spec, { ticket: "T-1", level: "low" }))
    ).toEqual({ ticket: "T-1", level: "low" })
    const empty = await Effect.runPromise(
      Effect.flip(AgentSession.decodePayloadValues(spec, { ticket: "" }))
    )
    expect(empty.message).toContain("empty")
    const badLevel = await Effect.runPromise(
      Effect.flip(AgentSession.decodePayloadValues(spec, { ticket: "T-1", level: "medium" }))
    )
    expect(badLevel.message).toContain("must be one of")
  })

  it("unions multiple gitDiff declarations and honors the added filter", async () => {
    await write("src/a.ts", "export const a = 2\n")
    await write("src/new.ts", "export const fresh = 1\n")
    git("add", "src/new.ts")
    const slice = await Effect.runPromise(
      AgentSession.expandDiffSlice(root, [
        Input.gitDiff({ base: "HEAD", paths: ["src/a.ts"] }),
        Input.gitDiff({ base: "HEAD", added: ["src/**"] })
      ])
    )
    expect(slice.files).toEqual(["src/a.ts", "src/new.ts"])
    const addedOnly = await Effect.runPromise(
      AgentSession.expandDiffSlice(root, [Input.gitDiff({ base: "HEAD", added: ["src/**"] })])
    )
    expect(addedOnly.files).toEqual(["src/new.ts"])
  })
})

describe("codex smoke", () => {
  /**
   * The real CLI path, driven end to end against a stand-in binary.
   *
   * The live smoke below spends model tokens and is opt-in, which left the
   * whole `makeCliSessionFactory` codex branch — the argv it builds, the stdin
   * it writes the prompt to, and the JSONL event stream it reads the envelope
   * back out of — unexercised in every default run. The stand-in is the real
   * contract minus the model: it records the argv and the prompt it was given
   * and answers the documented `item.completed` / `agent_message` events.
   */
  it.skipIf(process.platform === "win32")(
    "drives the real codex argv and event stream against a stand-in binary",
    async () => {
      const directory = await Fs.mkdtemp(NodePath.join(Os.tmpdir(), "smthrs-codex-stub-"))
      try {
        const observed = NodePath.join(directory, "observed.json")
        const executable = NodePath.join(directory, "codex-stub.mjs")
        await Fs.writeFile(
          executable,
          "#!/usr/bin/env node\n" +
            "import { readFileSync, writeFileSync } from \"node:fs\"\n" +
            `const prompt = readFileSync(0, "utf8")\n` +
            `writeFileSync(${JSON.stringify(observed)}, JSON.stringify({ argv: process.argv.slice(2), prompt }))\n` +
            "const envelope = { findings: [], edits: [], note: \"stub\" }\n" +
            // A leading non-message event and a trailing one: the extractor
            // takes the last agent_message and ignores everything else.
            "process.stdout.write(JSON.stringify({ type: \"turn.started\" }) + \"\\n\")\n" +
            "process.stdout.write(JSON.stringify({\n" +
            "  type: \"item.completed\",\n" +
            "  item: { type: \"agent_message\", text: JSON.stringify(envelope) }\n" +
            "}) + \"\\n\")\n",
          "utf8"
        )
        await Fs.chmod(executable, 0o755)

        const factory = AgentSession.makeCliSessionFactory({
          workspaceRoot: root,
          agents: AgentTarget.Agents({ default: AgentTarget.Codex({ model: "gpt-5.6-sol" }) }),
          executables: { codex: executable },
          timeoutMs: 30_000
        })
        const session = await Effect.runPromise(factory.open(undefined))
        expect(session.identity).toBe("codex:gpt-5.6-sol")
        const envelope = await Effect.runPromise(session.run({ purpose: "lint", prompt: "answer the contract" }))
        expect(envelope.findings).toEqual([])
        expect(envelope.edits).toEqual([])
        expect(envelope.note).toBe("stub")

        const seen = JSON.parse(await Fs.readFile(observed, "utf8")) as {
          argv: Array<string>
          prompt: string
        }
        // The prompt travels over stdin, never argv.
        expect(seen.prompt).toBe("answer the contract")
        expect(seen.argv.join(" ")).not.toContain("answer the contract")
        expect(seen.argv.slice(0, 3)).toEqual(["exec", "--json", "--skip-git-repo-check"])
        expect(seen.argv).toContain("--sandbox")
        expect(seen.argv).toContain("read-only")
        expect(seen.argv[seen.argv.length - 1]).toBe("-")
        expect(seen.argv[seen.argv.indexOf("--model") + 1]).toBe("gpt-5.6-sol")
      } finally {
        await Fs.rm(directory, { recursive: true, force: true })
      }
    }
  )

  // One real session through the codex CLI, opt-in only: SMTHRS_CODEX_SMOKE=1.
  // Kept out of the default run so the suite spends no model tokens.
  it.skipIf(process.env["SMTHRS_CODEX_SMOKE"] !== "1")(
    "answers the envelope contract through a real codex session",
    { timeout: 130_000 },
    async () => {
      const factory = AgentSession.makeCliSessionFactory({
        workspaceRoot: root,
        agents: AgentTarget.Agents({ default: AgentTarget.Codex({ model: "gpt-5.6-sol" }) }),
        timeoutMs: 120_000
      })
      const session = await Effect.runPromise(factory.open(undefined))
      expect(session.identity).toBe("codex:gpt-5.6-sol")
      const envelope = await Effect.runPromise(
        session.run({
          purpose: "lint",
          prompt: "Respond with exactly this JSON object and nothing else - no prose, no code fences: " +
            "{\"findings\": [], \"edits\": [], \"note\": \"smoke\"}"
        })
      )
      expect(envelope.findings).toEqual([])
      expect(envelope.edits).toEqual([])
      expect(envelope.note).toBe("smoke")
    }
  )
})

describe("session envelope", () => {
  it("normalizes optional fields and refuses junk", () => {
    expect(AgentSession.parseEnvelope("{}")).toEqual({ findings: [], edits: [], note: undefined })
    expect(() => AgentSession.parseEnvelope("not json")).toThrow()
    expect(() => AgentSession.parseEnvelope(JSON.stringify({ findings: [{ file: "" }] }))).toThrow()
  })

  it("keys verdicts on every component of the material", () => {
    const base = {
      kind: "lint" as const,
      diffDigest: "d",
      promptDigest: "p",
      agentIdentity: "a",
      mode: "check",
      gateIdentities: ["g1"]
    }
    const key = AgentSession.verdictKey(base)
    expect(AgentSession.verdictKey({ ...base })).toBe(key)
    expect(AgentSession.verdictKey({ ...base, kind: "diff" })).not.toBe(key)
    expect(AgentSession.verdictKey({ ...base, diffDigest: "x" })).not.toBe(key)
    expect(AgentSession.verdictKey({ ...base, promptDigest: "x" })).not.toBe(key)
    expect(AgentSession.verdictKey({ ...base, agentIdentity: "x" })).not.toBe(key)
    expect(AgentSession.verdictKey({ ...base, mode: "fix" })).not.toBe(key)
    expect(AgentSession.verdictKey({ ...base, gateIdentities: ["g2"] })).not.toBe(key)
  })
})

describe("standalone store regressions", () => {
  for (const kind of ["lint", "diff", "pr"] as const) {
    it.each(["contents", "paths"])(`${kind} rekeys when rendered data %s change`, async (change) => {
      await write("src/a.ts", "changed\n")
      await write("context.txt", "first context")
      await write("other.txt", "other context")
      const verdicts = AgentSession.makeMemoryVerdictStore()
      const run = (
        sessions: AgentSession.SessionFactory,
        dataFiles: ReadonlyArray<string>
      ): Effect.Effect<AgentTarget.LintReport | AgentTarget.PrResult, AgentTarget.LintError | AgentTarget.PrError> => {
        const runtime = runtimeOf({
          sessions,
          verdicts,
          dataFiles,
          gates: AgentFake.makeScriptedGateRunner([[green]]),
          prOpener: { open: () => Effect.succeed("https://example.test/pr/1") }
        })
        return kind === "lint"
          ? AgentSession.runAgentLint(runtime, lintPayload())
          : kind === "diff"
          ? AgentSession.runAgentDiff(runtime, diffPayload())
          : AgentSession.runAgentPr(runtime, diffPayload())
      }
      await Effect.runPromise(run(scripted([{}]), ["context.txt"]))
      if (change === "contents") await write("context.txt", "second context")
      const second = scripted([{}])
      await Effect.runPromise(run(second, [change === "paths" ? "other.txt" : "context.txt"]))
      expect(second.spawns()).toBe(1)
    })
  }

  it.each(["diff", "pr"] as const)("%s rekeys after narrowing the write-set", async (kind) => {
    const verdicts = AgentSession.makeMemoryVerdictStore()
    const run = (sessions: AgentSession.SessionFactory, changes: ReadonlyArray<string>) => {
      const runtime = runtimeOf({
        sessions,
        verdicts,
        gates: AgentFake.makeScriptedGateRunner([[green]]),
        prOpener: { open: () => Effect.succeed("https://example.test/pr/1") }
      })
      return kind === "diff" ?
        AgentSession.runAgentDiff(runtime, diffPayload({ changes }))
        : AgentSession.runAgentPr(runtime, diffPayload({ changes }))
    }
    await Effect.runPromise(run(scripted([{ edits: [{ path: "src/a.ts", contents: "a" }] }]), ["src/**"]))
    const second = scripted([{ edits: [{ path: "src/b.ts", contents: "b" }] }])
    const result = await Effect.runPromise(run(second, ["src/b.ts"]))
    expect(result.edits).toEqual([{ path: "src/b.ts", contents: "b" }])
    expect(second.spawns()).toBe(1)
  })

  it("rekeys when the candidate round policy changes", async () => {
    const verdicts = AgentSession.makeMemoryVerdictStore()
    for (const maxRounds of [3, 1]) {
      const sessions = scripted([{}])
      await Effect.runPromise(
        AgentSession.runAgentDiff(
          runtimeOf({ sessions, verdicts, gates: AgentFake.makeScriptedGateRunner([[green]]) }),
          diffPayload({ maxRounds })
        )
      )
      expect(sessions.spawns()).toBe(1)
    }
  })

  it("revalidates cached edits against the current write-set", async () => {
    const verdicts: AgentSession.AgentVerdictStore = {
      get: () =>
        Effect.succeed(
          JSON.stringify({
            vacuous: false,
            rounds: 1,
            diff: "outside",
            edits: [{ path: "docs/readme.md", contents: "outside" }],
            gateReport: [green]
          })
        ),
      put: () => Effect.void
    }
    const result = await Effect.runPromise(Effect.result(AgentSession.runAgentDiff(
      runtimeOf({ sessions: scripted([]), verdicts }),
      diffPayload()
    )))
    expect(result).toMatchObject({ _tag: "Failure", failure: { _tag: "smithers-build/AgentWriteEscape" } })
  })

  it.each([
    { name: "empty", identities: ["Vitest#gate"], report: [] },
    { name: "partial", identities: ["Vitest#gate", "Vitest#other"], report: [green] },
    { name: "unknown", identities: ["Vitest#gate"], report: [{ ...green, gate: "Vitest#other" }] },
    { name: "duplicate", identities: ["Vitest#gate"], report: [green, green] },
    { name: "duplicate request", identities: ["Vitest#gate", "Vitest#gate"], report: [green] }
  ])("rejects a $name gate report before caching or opening a PR", async ({ identities, report }) => {
    let puts = 0
    let opens = 0
    const result = await Effect.runPromise(Effect.result(AgentSession.runAgentPr(
      runtimeOf({
        sessions: scripted([{}]),
        gates: AgentFake.makeScriptedGateRunner([report]),
        verdicts: {
          get: () => Effect.succeed(undefined),
          put: () =>
            Effect.sync(() => {
              puts++
            })
        },
        prOpener: {
          open: () =>
            Effect.sync(() => {
              opens++
              return "https://example.test/pr/1"
            })
        }
      }),
      diffPayload({ gateIdentities: identities })
    )))
    expect(result).toMatchObject({
      _tag: "Failure",
      failure: {
        _tag: "smithers-build/AgentSessionError",
        phase: "gate",
        message: expect.stringContaining("gate protocol")
      }
    })
    expect(puts).toBe(0)
    expect(opens).toBe(0)
  })

  it("publishes 16 concurrent different-length verdicts without temp collisions", async () => {
    const directory = NodePath.join(root, "verdicts")
    const store = AgentSession.makeFileVerdictStore(directory)
    const values = Array.from({ length: 16 }, (_, i) => JSON.stringify({ text: "x".repeat(i * 8192), i }))
    const results = await Promise.allSettled(values.map((value) => Effect.runPromise(store.put("same", value))))
    expect(results.filter((result) => result.status === "rejected")).toEqual([])
    expect(values).toContain(await Effect.runPromise(store.get("same")))
    expect(await Fs.readdir(directory)).toEqual(["same.json"])
  })

  it("treats malformed JSON in the file store as a miss", async () => {
    await write("verdicts/broken.json", "{broken")
    expect(await Effect.runPromise(AgentSession.makeFileVerdictStore(NodePath.join(root, "verdicts")).get("broken")))
      .toBeUndefined()
  })

  it("does not overwrite an out-of-workspace hard-link alias", async () => {
    const outside = await Fs.mkdtemp(NodePath.join(Os.tmpdir(), "smthrs-victim-"))
    try {
      const victim = NodePath.join(outside, "victim.txt")
      await Fs.writeFile(victim, "original")
      await Fs.link(victim, NodePath.join(root, "src/allowed.txt"))
      const applier = AgentSession.makeLocalWriteSetApplier(root)
      const overlay = await Effect.runPromise(
        applier.apply([{ path: "src/allowed.txt", contents: "replacement" }], ["src/**"])
      )
      await Effect.runPromise(applier.commit(overlay))
      expect(await Fs.readFile(victim, "utf8")).toBe("original")
      expect(await read("src/allowed.txt")).toBe("replacement")
    } finally {
      await Fs.rm(outside, { recursive: true, force: true })
    }
  })

  it.each(["parent", "destination"])("rechecks a symlinked %s at deferred commit", async (component) => {
    const applier = AgentSession.makeLocalWriteSetApplier(root)
    const overlay = await Effect.runPromise(applier.apply([{ path: "src/a.ts", contents: "escaped" }], ["src/**"]))
    await write("outside/a.ts", "original")
    if (component === "parent") {
      await Fs.rename(NodePath.join(root, "src"), NodePath.join(root, "saved-src"))
      await Fs.symlink(NodePath.join(root, "outside"), NodePath.join(root, "src"))
    } else {
      await Fs.unlink(NodePath.join(root, "src/a.ts"))
      await Fs.symlink(NodePath.join(root, "outside/a.ts"), NodePath.join(root, "src/a.ts"))
    }
    const result = await Effect.runPromise(Effect.result(applier.commit(overlay)))
    expect(result).toMatchObject({ _tag: "Failure", failure: { phase: "apply" } })
    expect(await read("outside/a.ts")).toBe("original")
  })
})

describe("deferred candidate identity", () => {
  it("rejects a destination replaced by a different regular inode", async () => {
    const applier = AgentSession.makeLocalWriteSetApplier(root)
    const overlay = await Effect.runPromise(applier.apply([{ path: "src/a.ts", contents: "candidate" }], ["src/**"]))
    await write("src/replacement.ts", "new owner")
    await Fs.rename(NodePath.join(root, "src/replacement.ts"), NodePath.join(root, "src/a.ts"))
    const result = await Effect.runPromise(Effect.result(applier.commit(overlay)))
    expect(result).toMatchObject({
      _tag: "Failure",
      failure: { phase: "apply", message: expect.stringContaining("changed") }
    })
    expect(await read("src/a.ts")).toBe("new owner")
  })
})

describe("cached candidate confinement", () => {
  it("checks a real cached candidate again after a destination becomes a symlink", async () => {
    const verdicts = AgentSession.makeMemoryVerdictStore()
    await Effect.runPromise(AgentSession.runAgentDiff(
      runtimeOf({
        sessions: scripted([{ edits: [{ path: "src/a.ts", contents: "candidate" }] }]),
        verdicts,
        gates: AgentFake.makeScriptedGateRunner([[green]])
      }),
      diffPayload()
    ))
    await Fs.unlink(NodePath.join(root, "src/a.ts"))
    await Fs.symlink(NodePath.join(root, "docs/readme.md"), NodePath.join(root, "src/a.ts"))
    const result = await Effect.runPromise(Effect.result(AgentSession.runAgentDiff(
      runtimeOf({ sessions: scripted([]), verdicts }),
      diffPayload()
    )))
    expect(result).toMatchObject({ _tag: "Failure", failure: { _tag: "smithers-build/AgentWriteEscape" } })
    expect(await read("docs/readme.md")).toBe("readme\n")
  })
})

describe("gate report identity mapping", () => {
  it("validates mapped labels on production and cache replay", async () => {
    const verdicts = AgentSession.makeMemoryVerdictStore()
    for (const replay of [false, true]) {
      const sessions = scripted(replay ? [] : [{}])
      const gates = AgentFake.makeScriptedGateRunner(replay ? [] : [[{ gate: "//pkg:test", status: "green" }]])
      const result = await Effect.runPromise(
        AgentSession.runAgentDiff(
          runtimeOf({
            sessions,
            verdicts,
            gates: { ...gates, reportIdentity: (identity) => identity === "digest" ? "//pkg:test" : identity }
          }),
          diffPayload({ gateIdentities: ["digest"] })
        )
      )
      expect(result.gateReport).toEqual([{ gate: "//pkg:test", status: "green" }])
      expect(sessions.spawns()).toBe(replay ? 0 : 1)
    }
  })

  it("accepts an empty gate report for an empty requested set", async () => {
    const result = await Effect.runPromise(AgentSession.runAgentDiff(
      runtimeOf({ sessions: scripted([{}]) }),
      diffPayload({ gateIdentities: [] })
    ))
    expect(result.gateReport).toEqual([])
  })

  it("rejects ambiguous report mappings", async () => {
    const result = await Effect.runPromise(Effect.result(AgentSession.runAgentDiff(
      runtimeOf({
        sessions: scripted([{}]),
        gates: { run: () => Effect.succeed([green]), reportIdentity: () => green.gate }
      }),
      diffPayload({ gateIdentities: ["first", "second"] })
    )))
    expect(result).toMatchObject({ _tag: "Failure", failure: { phase: "gate" } })
  })

  it("rejects incomplete cached gate reports", async () => {
    const result = await Effect.runPromise(Effect.result(AgentSession.runAgentDiff(
      runtimeOf({
        sessions: scripted([]),
        verdicts: {
          get: () => Effect.succeed(JSON.stringify({ vacuous: false, rounds: 1, diff: "", edits: [], gateReport: [] })),
          put: () => Effect.void
        }
      }),
      diffPayload()
    )))
    expect(result).toMatchObject({ _tag: "Failure", failure: { phase: "gate" } })
  })
})

describe("atomic candidate publication", () => {
  it("preserves executable permissions and removes temporary siblings", async () => {
    await Fs.chmod(NodePath.join(root, "src/a.ts"), 0o755)
    const applier = AgentSession.makeLocalWriteSetApplier(root)
    const overlay = await Effect.runPromise(
      applier.apply([{ path: "src/a.ts", contents: "replacement" }, { path: "src/new/file.ts", contents: "new" }], [
        "src/**"
      ])
    )
    await Effect.runPromise(applier.commit(overlay))
    expect((await Fs.stat(NodePath.join(root, "src/a.ts"))).mode & 0o777).toBe(0o755)
    expect(await read("src/new/file.ts")).toBe("new")
    expect((await Fs.readdir(NodePath.join(root, "src"))).sort()).toEqual(["a.ts", "new"])
  })

  it("cleans up only its temporary file when rename fails", async () => {
    await Fs.mkdir(NodePath.join(root, "verdicts/key.json"), { recursive: true })
    await write("verdicts/unrelated.tmp", "owned elsewhere")
    const result = await Effect.runPromise(
      Effect.result(AgentSession.makeFileVerdictStore(NodePath.join(root, "verdicts")).put("key", "{}"))
    )
    expect(result).toMatchObject({ _tag: "Failure", failure: { phase: "cache" } })
    expect((await Fs.readdir(NodePath.join(root, "verdicts"))).sort()).toEqual(["key.json", "unrelated.tmp"])
  })
})
