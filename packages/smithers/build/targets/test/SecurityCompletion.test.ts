import * as Effect from "effect/Effect"
import { execFile } from "node:child_process"
import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as NodePath from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import * as Input from "../src/Input.ts"
import * as LlmLint from "../src/LlmLint.ts"

let root: string

const git = (...args: ReadonlyArray<string>): Promise<void> =>
  new Promise((resolve, reject) => {
    execFile("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...args], {
      cwd: root
    }, (error) => error === null ? resolve() : reject(error))
  })

const fakeCli = async (answer: string): Promise<string> => {
  const executable = NodePath.join(root, "model.mjs")
  await Fs.writeFile(
    executable,
    `#!/usr/bin/env node\nfor await (const _ of process.stdin) {}\nprocess.stdout.write(${
      JSON.stringify(claude(answer))
    })\n`,
    "utf8"
  )
  await Fs.chmod(executable, 0o755)
  return executable
}

interface CliCall {
  readonly args: ReadonlyArray<string>
  readonly stdin: string
}

const scriptedCli = async (answers: ReadonlyArray<string>): Promise<{
  readonly executable: string
  readonly calls: () => Promise<ReadonlyArray<CliCall>>
}> => {
  const executable = NodePath.join(root, "scripted-model.mjs")
  const record = NodePath.join(root, "model-calls.jsonl")
  await Fs.writeFile(
    executable,
    "#!/usr/bin/env node\n" +
      "import { appendFileSync, readFileSync } from 'node:fs'\n" +
      "let stdin = ''\n" +
      "for await (const chunk of process.stdin) stdin += chunk\n" +
      `const record = ${JSON.stringify(record)}\n` +
      "let calls = []\n" +
      "try { calls = readFileSync(record, 'utf8').trim().split('\\n').map(JSON.parse) } catch {}\n" +
      "appendFileSync(record, JSON.stringify({ args: process.argv.slice(2), stdin }) + '\\n')\n" +
      `const answers = ${JSON.stringify(answers)}\n` +
      "process.stdout.write(answers[Math.min(calls.length, answers.length - 1)])\n",
    "utf8"
  )
  await Fs.chmod(executable, 0o755)
  return {
    executable,
    calls: async () => {
      const lines = await Fs.readFile(record, "utf8").catch(() => "")
      return lines.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as CliCall)
    }
  }
}

const completion = (overrides: Record<string, unknown> = {}): string =>
  JSON.stringify({
    status: "completed",
    coverage: [{
      checkId: "general",
      status: "completed",
      evidence: "Inspected the changed operation and its callers."
    }],
    missingContext: [],
    findings: [],
    ...overrides
  })

const claude = (answer: string, overrides: Record<string, unknown> = {}): string =>
  JSON.stringify({
    type: "result",
    subtype: "success",
    is_error: false,
    stop_reason: "end_turn",
    result: answer,
    ...overrides
  })

const codex = (answer: string, tail: ReadonlyArray<Record<string, unknown>> = []): string =>
  [
    { type: "thread.started", thread_id: "t" },
    { type: "item.completed", item: { id: "item_1", type: "agent_message", text: answer } },
    ...tail,
    { type: "turn.completed" }
  ].map((event) => JSON.stringify(event)).join("\n") + "\n"

const codexEvents = (...events: ReadonlyArray<Record<string, unknown>>): string =>
  events.map((event) => JSON.stringify(event)).join("\n") + "\n"

const payload = (overrides: Partial<LlmLint.Payload> = {}): LlmLint.Payload => ({
  base: "HEAD",
  include: [Input.glob("src/**/*.ts")],
  context: [],
  prompt: "Review the changed file.",
  rubric: "Inspect the general security check.",
  engine: "claude",
  model: "claude-opus-5-5",
  batchSize: 1,
  failOn: "error",
  securityChecks: ["general"],
  ...overrides
})

beforeEach(async () => {
  root = await Fs.realpath(await Fs.mkdtemp(NodePath.join(Os.tmpdir(), "smthrs-security-completion-")))
  await Fs.mkdir(NodePath.join(root, "src"))
  await Fs.writeFile(NodePath.join(root, "src/a.ts"), "export const a = 1\n")
  await git("init", "--initial-branch=main")
  await git("add", ".")
  await git("commit", "-m", "base")
  await Fs.writeFile(NodePath.join(root, "src/a.ts"), "export const a = 2\n")
})

afterEach(async () => {
  await Fs.rm(root, { recursive: true, force: true })
})

describe("LlmLint.review security completion", () => {
  it("rejects a bare clean array without explicit completed coverage", async () => {
    const executable = await fakeCli("[]")
    const result = await Effect.runPromise(Effect.exit(LlmLint.review({ workspaceRoot: root, executable }, payload())))
    expect(result._tag).toBe("Failure")
  })

  it("records one failed attempt when the security CLI is missing", async () => {
    const failure = await Effect.runPromise(Effect.flip(LlmLint.review(
      { workspaceRoot: root, executable: NodePath.join(root, "absent-model") },
      payload()
    )))
    expect(failure).toMatchObject({ _tag: "smithers-build/LlmReviewError", phase: "review" })
    expect((failure as LlmLint.LlmReviewError).attempts).toMatchObject([
      { batch: 0, pass: 1, engine: "claude", attempt: 1, status: "failed" }
    ])
  })

  it("requires completed coverage for every declared check exactly once", async () => {
    const incomplete = [
      completion({ coverage: [] }),
      completion({ coverage: [{ checkId: "general", status: "incomplete", evidence: "Need the caller." }] }),
      completion({
        coverage: [
          { checkId: "general", status: "completed", evidence: "Reviewed." },
          { checkId: "general", status: "completed", evidence: "Reviewed twice." }
        ]
      }),
      completion({ coverage: [{ checkId: "general", status: "completed", evidence: "   " }] }),
      completion({ missingContext: ["Caller implementation"] }),
      completion({ status: "refused" })
    ]
    for (const answer of incomplete) {
      const cli = await scriptedCli([claude(answer)])
      const exit = await Effect.runPromise(
        Effect.exit(LlmLint.review({ workspaceRoot: root, executable: cli.executable }, payload()))
      )
      expect(exit._tag).toBe("Failure")
      expect(await cli.calls()).toHaveLength(2)
      await Fs.rm(NodePath.join(root, "model-calls.jsonl"), { force: true })
    }
  })

  it("runs primary, other engine, then primary and retains all completed attempts", async () => {
    const cli = await scriptedCli([claude(completion()), codex(completion()), claude(completion())])
    const report = await Effect.runPromise(
      LlmLint.review({ workspaceRoot: root, executable: cli.executable }, payload())
    )
    const calls = await cli.calls()
    expect(calls).toHaveLength(3)
    expect(calls.map(({ args }) => args.includes("exec") ? "codex" : "claude")).toEqual(["claude", "codex", "claude"])
    expect(report.files).toEqual(["src/a.ts"])
    expect(report.findings).toEqual([])
    expect(report.attempts).toMatchObject([
      { batch: 0, pass: 1, purpose: "review", engine: "claude", attempt: 1, status: "completed" },
      { batch: 0, pass: 2, purpose: "review", engine: "codex", attempt: 1, status: "completed" },
      { batch: 0, pass: 3, purpose: "review", engine: "claude", attempt: 1, status: "completed" }
    ])
  })

  it("retries a failed pass once and records the failed attempt", async () => {
    const cli = await scriptedCli([claude("[]"), claude(completion()), codex(completion()), claude(completion())])
    const report = await Effect.runPromise(
      LlmLint.review({ workspaceRoot: root, executable: cli.executable }, payload())
    )
    expect(await cli.calls()).toHaveLength(4)
    expect(report.attempts?.map(({ pass, attempt, status }) => [pass, attempt, status])).toEqual([
      [1, 1, "failed"],
      [1, 2, "completed"],
      [2, 1, "completed"],
      [3, 1, "completed"]
    ])
  })

  it("rejects an explicit Claude refusal despite a valid completion body", async () => {
    const cli = await scriptedCli([claude(completion(), { subtype: "error_during_execution", is_error: true })])
    const exit = await Effect.runPromise(
      Effect.exit(LlmLint.review({ workspaceRoot: root, executable: cli.executable }, payload()))
    )
    expect(exit._tag).toBe("Failure")
    expect(await cli.calls()).toHaveLength(2)
  })

  it("retains refusal text in the final failure", async () => {
    const cli = await scriptedCli([claude(completion({ status: "refused" }))])
    const failure = await Effect.runPromise(
      Effect.flip(LlmLint.review({ workspaceRoot: root, executable: cli.executable }, payload()))
    )
    expect(failure._tag).toBe("smithers-build/LlmReviewError")
    expect((failure as LlmLint.LlmReviewError).message).toContain("refused")
    expect((failure as LlmLint.LlmReviewError).attempts).toHaveLength(2)
  })

  it("rejects a Claude api_error stop reason even with a success subtype", async () => {
    const cli = await scriptedCli([claude(completion(), { stop_reason: "api_error" })])
    const failure = await Effect.runPromise(
      Effect.flip(LlmLint.review({ workspaceRoot: root, executable: cli.executable }, payload()))
    )
    expect(failure._tag).toBe("smithers-build/LlmReviewError")
    expect(await cli.calls()).toHaveLength(2)
  })

  it("rejects a Codex failed turn despite a valid completion body", async () => {
    const cli = await scriptedCli([
      claude(completion()),
      codex(completion(), [{ type: "turn.failed", error: { message: "provider stopped" } }])
    ])
    const exit = await Effect.runPromise(
      Effect.exit(LlmLint.review({ workspaceRoot: root, executable: cli.executable }, payload()))
    )
    expect(exit._tag).toBe("Failure")
    expect(await cli.calls()).toHaveLength(3)
  })

  it.each([
    [
      "a new unfinished turn after completion",
      codexEvents(
        { type: "item.completed", item: { id: "m1", type: "agent_message", text: completion() } },
        { type: "turn.completed" },
        { type: "turn.started" }
      )
    ],
    [
      "the final agent message after completion",
      codexEvents(
        { type: "turn.completed" },
        { type: "item.completed", item: { id: "m1", type: "agent_message", text: completion() } }
      )
    ],
    [
      "an explicit error event",
      codexEvents(
        { type: "item.completed", item: { id: "m1", type: "agent_message", text: completion() } },
        { type: "error", message: "provider failure" },
        { type: "turn.completed" }
      )
    ]
  ])("rejects Codex %s", async (_description, invalidCodex) => {
    const cli = await scriptedCli([claude(completion()), invalidCodex])
    const failure = await Effect.runPromise(
      Effect.flip(LlmLint.review({ workspaceRoot: root, executable: cli.executable }, payload()))
    )
    expect(failure._tag).toBe("smithers-build/LlmReviewError")
    expect(await cli.calls()).toHaveLength(3)
  })

  it("accepts a completed Codex turn with an ordinary failed command item", async () => {
    const withFailedCommand = codexEvents(
      { type: "item.completed", item: { id: "cmd", type: "command_execution", status: "failed", exit_code: 1 } },
      { type: "item.completed", item: { id: "m1", type: "agent_message", text: completion() } },
      { type: "turn.completed" }
    )
    const cli = await scriptedCli([claude(completion()), withFailedCommand, claude(completion())])
    const report = await Effect.runPromise(
      LlmLint.review({ workspaceRoot: root, executable: cli.executable }, payload())
    )
    expect(report.findings).toEqual([])
    expect(report.attempts?.map(({ status }) => status)).toEqual(["completed", "completed", "completed"])
  })

  it("rejects prose around an otherwise valid completion envelope", async () => {
    const cli = await scriptedCli([claude(`Review complete.\n${completion()}`)])
    const failure = await Effect.runPromise(
      Effect.flip(LlmLint.review({ workspaceRoot: root, executable: cli.executable }, payload()))
    )
    expect(failure).toMatchObject({ _tag: "smithers-build/LlmReviewError", phase: "parse" })
    expect(await cli.calls()).toHaveLength(2)
  })

  it("requires coverage of every declared check, including general", async () => {
    const onlyGeneral = await scriptedCli([claude(completion())])
    const failure = await Effect.runPromise(Effect.flip(LlmLint.review(
      { workspaceRoot: root, executable: onlyGeneral.executable },
      payload({ securityChecks: ["authorization", "general"] })
    )))
    expect(failure).toMatchObject({ _tag: "smithers-build/LlmReviewError", phase: "parse" })
    expect(await onlyGeneral.calls()).toHaveLength(2)
  })

  it("accepts one completed evidence entry for each declared check", async () => {
    const answer = completion({
      coverage: [
        { checkId: "authorization", status: "completed", evidence: "Traced the caller identity into this operation." },
        { checkId: "general", status: "completed", evidence: "Inspected other input and output boundaries." }
      ]
    })
    const cli = await scriptedCli([claude(answer), codex(answer), claude(answer)])
    const report = await Effect.runPromise(LlmLint.review(
      { workspaceRoot: root, executable: cli.executable },
      payload({ securityChecks: ["authorization", "general"] })
    ))
    expect(report.findings).toEqual([])
    expect(report.attempts).toHaveLength(3)
    expect(report.attempts?.every((entry) => entry.completion?.coverage.length === 2)).toBe(true)
  })

  it("keeps a blocking candidate when later passes and verification report clean", async () => {
    const finding = {
      file: "src/a.ts",
      line: 1,
      severity: "error",
      message: "Authorization is missing at this operation.",
      security: {
        checkId: "general",
        impact: "high",
        verification: "suspected",
        releaseRecommendation: "block",
        attackerPreconditions: "An untrusted caller invokes this operation.",
        evidence: "The operation has no caller identity check.",
        nextConfirmationStep: "Exercise the operation with a caller from another tenant."
      }
    }
    const cli = await scriptedCli([
      claude(completion({ findings: [finding] })),
      codex(completion()),
      claude(completion()),
      codex(completion())
    ])
    const failure = await Effect.runPromise(
      Effect.flip(LlmLint.review({ workspaceRoot: root, executable: cli.executable }, payload()))
    )
    expect(failure._tag).toBe("smithers-build/FindingsError")
    expect((failure as LlmLint.FindingsError).findings).toMatchObject([finding])
    expect((failure as LlmLint.FindingsError).attempts?.map(({ purpose, engine }) => [purpose, engine])).toEqual([
      ["review", "claude"],
      ["review", "codex"],
      ["review", "claude"],
      ["verify", "codex"]
    ])
    expect(await cli.calls()).toHaveLength(4)
  })

  it("retains a verifier escalation for the original candidate", async () => {
    const candidate = {
      file: "src/a.ts",
      line: 1,
      severity: "info",
      message: "The caller identity may be unchecked.",
      security: {
        checkId: "general",
        impact: "low",
        verification: "suspected",
        releaseRecommendation: "allow",
        attackerPreconditions: "An untrusted caller invokes this operation.",
        evidence: "The operation does not show a local identity check.",
        nextConfirmationStep: "Inspect the caller identity handoff."
      }
    }
    const escalated = {
      ...candidate,
      severity: "error",
      message: "The operation accepts a caller from another tenant.",
      security: {
        ...candidate.security,
        impact: "high",
        releaseRecommendation: "block",
        evidence: "The supplied caller path reaches this operation without an identity check."
      }
    }
    const cli = await scriptedCli([
      claude(completion({ findings: [candidate] })),
      codex(completion()),
      claude(completion()),
      codex(completion({ findings: [escalated] }))
    ])
    const result = await Effect.runPromise(
      Effect.result(LlmLint.review({ workspaceRoot: root, executable: cli.executable }, payload()))
    )
    expect(result._tag).toBe("Failure")
    if (result._tag === "Failure") {
      expect(result.failure._tag).toBe("smithers-build/FindingsError")
      expect((result.failure as LlmLint.FindingsError).findings).toEqual(expect.arrayContaining([candidate, escalated]))
    }
  })

  it("rejects a verifier finding for an unrelated check", async () => {
    const coverage = [
      { checkId: "authorization", status: "completed", evidence: "Traced caller identity." },
      { checkId: "general", status: "completed", evidence: "Inspected other trust boundaries." }
    ]
    const original = {
      file: "src/a.ts",
      line: 1,
      severity: "info",
      message: "General input boundary concern.",
      security: {
        checkId: "general",
        impact: "low",
        verification: "suspected",
        releaseRecommendation: "allow",
        attackerPreconditions: "A caller supplies input.",
        evidence: "The input reaches the operation.",
        nextConfirmationStep: "Trace its validation."
      }
    }
    const unrelated = {
      ...original,
      message: "A separate authorization concern.",
      security: { ...original.security, checkId: "authorization" }
    }
    const cli = await scriptedCli([
      claude(completion({ coverage, findings: [original] })),
      codex(completion({ coverage })),
      claude(completion({ coverage })),
      codex(completion({ coverage, findings: [unrelated] }))
    ])
    const result = await Effect.runPromise(Effect.result(LlmLint.review(
      { workspaceRoot: root, executable: cli.executable },
      payload({ securityChecks: ["authorization", "general"] })
    )))
    expect(result._tag).toBe("Failure")
    if (result._tag === "Failure") {
      expect(result.failure).toMatchObject({ _tag: "smithers-build/LlmReviewError", phase: "parse" })
    }
  })

  it("rejects explicit provider failures for generic lint", async () => {
    const generic = payload({ securityChecks: undefined })
    for (
      const [engine, output] of [
        ["claude", claude("[]", { subtype: "error_during_execution", is_error: true })],
        ["codex", codex("[]", [{ type: "turn.failed", error: { message: "provider stopped" } }])]
      ] as const
    ) {
      const cli = await scriptedCli([output])
      const failure = await Effect.runPromise(Effect.flip(LlmLint.review(
        { workspaceRoot: root, executable: cli.executable },
        generic.engine === engine
          ? generic
          : payload({ securityChecks: undefined, engine, model: "generic-model" })
      )))
      expect(failure._tag).toBe("smithers-build/LlmReviewError")
      await Fs.rm(NodePath.join(root, "model-calls.jsonl"), { force: true })
    }
  })

  describe("deleted files", () => {
    const passes = () => [claude(completion()), codex(completion()), claude(completion())]

    it("sends a deletion-only change through three completed passes with its base contents", async () => {
      await git("checkout", "--", "src/a.ts")
      await Fs.rm(NodePath.join(root, "src/a.ts"))
      const cli = await scriptedCli(passes())
      const report = await Effect.runPromise(
        LlmLint.review({ workspaceRoot: root, executable: cli.executable }, payload({ required: true }))
      )
      expect(report.files).toEqual(["src/a.ts"])
      expect(report.attempts?.map(({ pass, status }) => [pass, status])).toEqual([
        [1, "completed"],
        [2, "completed"],
        [3, "completed"]
      ])
      const calls = await cli.calls()
      expect(calls).toHaveLength(3)
      for (const { stdin } of calls) {
        expect(stdin).toContain("--- CHANGED FILE: \"src/a.ts\" ---")
        expect(stdin).toContain(JSON.stringify({ deleted: true, contents: "export const a = 1\n" }))
        expect(stdin).toContain("A CHANGED FILE marked deleted was removed by this change")
      }
    })

    it("fails a deletion-only change whose pass is incomplete instead of passing it", async () => {
      await git("checkout", "--", "src/a.ts")
      await Fs.rm(NodePath.join(root, "src/a.ts"))
      const cli = await scriptedCli([claude(completion({ status: "incomplete" }))])
      const exit = await Effect.runPromise(
        Effect.exit(LlmLint.review({ workspaceRoot: root, executable: cli.executable }, payload()))
      )
      expect(exit._tag).toBe("Failure")
      expect(await cli.calls()).toHaveLength(2)
    })

    it("reviews a deleted file beside an edited one in its own batch", async () => {
      await Fs.writeFile(
        NodePath.join(root, "src/guard.ts"),
        "export const allow = (role: string) => role === 'admin'\n"
      )
      await git("add", "src/guard.ts")
      await git("commit", "-m", "guard")
      await Fs.rm(NodePath.join(root, "src/guard.ts"))
      const cli = await scriptedCli([...passes(), ...passes()])
      const report = await Effect.runPromise(
        LlmLint.review({ workspaceRoot: root, executable: cli.executable }, payload())
      )
      expect(report.files).toEqual(["src/a.ts", "src/guard.ts"])
      const calls = await cli.calls()
      expect(calls).toHaveLength(6)
      const deleted = calls.filter(({ stdin }) => stdin.includes("--- CHANGED FILE: \"src/guard.ts\" ---"))
      expect(deleted).toHaveLength(3)
      for (const { stdin } of deleted) expect(stdin).toContain("role === 'admin'")
      for (const { stdin } of calls.filter((call) => !deleted.includes(call))) {
        expect(stdin).not.toContain("marked deleted")
      }
    })

    it.each([
      ["larger than the per-file bound", Buffer.alloc(LlmLint.maximumReviewFileBytes + 1, 0x61)],
      ["not UTF-8", Buffer.from([0x65, 0xff, 0xfe, 0x0a])]
    ])("fails the review when a deleted file's base contents are %s", async (_label, bytes) => {
      await git("checkout", "--", "src/a.ts")
      await Fs.writeFile(NodePath.join(root, "src/big.ts"), bytes)
      await git("add", "src/big.ts")
      await git("commit", "-m", "big")
      await Fs.rm(NodePath.join(root, "src/big.ts"))
      const cli = await scriptedCli(passes())
      const failure = await Effect.runPromise(
        Effect.flip(LlmLint.review({ workspaceRoot: root, executable: cli.executable }, payload()))
      )
      expect(failure).toMatchObject({ _tag: "smithers-build/LlmReviewError", phase: "read" })
      expect(await cli.calls()).toEqual([])
    })

    it("bounds deleted files by the aggregate content limit before reading past it", async () => {
      await git("checkout", "--", "src/a.ts")
      const size = 1_040_000
      const count = Math.floor(LlmLint.maximumReviewContentBytes / size) + 1
      for (let index = 0; index < count; index++) {
        await Fs.writeFile(NodePath.join(root, `src/big-${index}.ts`), Buffer.alloc(size, 0x61))
      }
      await git("add", "src")
      await git("commit", "-m", "big")
      await Fs.rm(NodePath.join(root, "src"), { recursive: true })
      const cli = await scriptedCli(passes())
      const failure = await Effect.runPromise(
        Effect.flip(LlmLint.review({ workspaceRoot: root, executable: cli.executable }, payload()))
      )
      expect(failure).toMatchObject({ _tag: "smithers-build/LlmReviewError", phase: "read" })
      expect((failure as LlmLint.LlmReviewError).message).toMatch(/aggregate limit/)
      expect(await cli.calls()).toEqual([])
    }, 120_000)

    it.skipIf(process.platform === "win32")("carries no source for a deleted symlink", async () => {
      await git("checkout", "--", "src/a.ts")
      await Fs.symlink("a.ts", NodePath.join(root, "src/link.ts"))
      await git("add", "src/link.ts")
      await git("commit", "-m", "link")
      await Fs.rm(NodePath.join(root, "src/link.ts"))
      const cli = await scriptedCli(passes())
      const failure = await Effect.runPromise(
        Effect.flip(LlmLint.review({ workspaceRoot: root, executable: cli.executable }, payload({ required: true })))
      )
      expect(failure).toMatchObject({ _tag: "smithers-build/LlmReviewError", phase: "diff" })
      expect(await cli.calls()).toEqual([])
    })

    it("leaves a file deleted from the working tree out of an all-scope audit", async () => {
      await Fs.writeFile(NodePath.join(root, "src/gone.ts"), "export const gone = 1\n")
      await git("add", "src/gone.ts")
      await git("commit", "-m", "gone")
      await Fs.rm(NodePath.join(root, "src/gone.ts"))
      const cli = await scriptedCli(passes())
      const report = await Effect.runPromise(
        LlmLint.review({ workspaceRoot: root, executable: cli.executable }, payload({ scope: "all" }))
      )
      expect(report.files).toEqual(["src/a.ts"])
      for (const { stdin } of await cli.calls()) expect(stdin).not.toContain("src/gone.ts")
    })
  })
})
