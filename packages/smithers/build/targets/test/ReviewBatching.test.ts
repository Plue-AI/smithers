import * as Effect from "effect/Effect"
import { execFileSync } from "node:child_process"
import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as Path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import * as Input from "../src/Input.ts"
import * as ReviewBatches from "../src/internal/ReviewBatches.ts"
import { maximumResponseTokens } from "../src/internal/ReviewModel.ts"
import * as LlmLint from "../src/LlmLint.ts"
import * as SecurityReview from "../src/SecurityReview.ts"
import * as Target from "../src/Target.ts"

let root: string

const write = async (relative: string, text: string): Promise<void> => {
  const path = Path.join(root, relative)
  await Fs.mkdir(Path.dirname(path), { recursive: true })
  await Fs.writeFile(path, text, "utf8")
}

const commit = (): void => {
  execFileSync("git", ["add", "."], { cwd: root })
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-qm", "base"], { cwd: root })
}

beforeEach(async () => {
  root = await Fs.realpath(await Fs.mkdtemp(Path.join(Os.tmpdir(), "review-batching-")))
  execFileSync("git", ["init", "-q", "--initial-branch=main"], { cwd: root })
})

afterEach(async () => {
  await Fs.rm(root, { recursive: true, force: true })
})

/** A fake claude CLI that records every prompt and answers every call with `answer`. */
const recorder = async (answer: string): Promise<{ executable: string; prompts: () => Promise<Array<string>> }> => {
  const executable = Path.join(root, "reviewer.mjs")
  const record = Path.join(root, "prompts.jsonl")
  await Fs.writeFile(
    executable,
    "#!/usr/bin/env node\nimport { appendFileSync } from \"node:fs\"\nlet prompt = \"\"\n" +
      "for await (const chunk of process.stdin) prompt += chunk\n" +
      `appendFileSync(${JSON.stringify(record)}, JSON.stringify(prompt) + "\\n")\n` +
      `process.stdout.write(JSON.stringify({ result: ${JSON.stringify(answer)} }))\n`,
    { mode: 0o755 }
  )
  return {
    executable,
    prompts: async () =>
      (await Fs.readFile(record, "utf8").catch(() => "")).split("\n").filter(Boolean).map((line) =>
        JSON.parse(line) as string
      )
  }
}

const payload = (overrides: Partial<LlmLint.Payload> = {}): LlmLint.Payload => ({
  base: "HEAD",
  include: [Input.glob("src/**")],
  context: [],
  prompt: "Review",
  rubric: "Rubric",
  engine: "claude",
  model: "test",
  batchSize: 2,
  failOn: "error",
  ...overrides
})

const changedIn = (prompt: string): Array<string> =>
  [...prompt.matchAll(/--- CHANGED FILE: "([^"]+)"/g)].map((match) => match[1]!)
const relatedIn = (prompt: string): Array<string> =>
  [...prompt.matchAll(/--- RELATED FILE: "([^"]+)"/g)].map((match) => match[1]!)

describe("LlmLint.review related-code batching", () => {
  it("reviews related changed files together and carries their unchanged callers and dependencies", async () => {
    await write("src/a-handler.ts", "import { guard } from \"./guard.ts\"\nimport { store } from \"./z-store.ts\"\n")
    await write("src/z-store.ts", "export const store = 1\n")
    await write("src/m.ts", "export const m = 1\n")
    await write("src/guard.ts", "export const guard = (id: string) => id !== \"\"\n")
    await write("src/route.ts", "import { handler } from \"./a-handler.js\"\n")
    await write("src/unrelated.ts", "export const unrelated = 1\n")
    await write("lib/outside.ts", "import { handler } from \"../src/a-handler.ts\"\n")
    await write(".gitignore", "src/ignored.ts\n")
    commit()
    await write(
      "src/a-handler.ts",
      "import { guard } from \"./guard.ts\"\nimport { store } from \"./z-store.ts\"\n// edit\n"
    )
    await write("src/z-store.ts", "export const store = 2\n")
    await write("src/m.ts", "export const m = 2\n")
    await write("src/new-caller.ts", "export { handler } from './a-handler'\n")
    await write("src/ignored.ts", "import { handler } from \"./a-handler.ts\"\n")
    const cli = await recorder("[]")
    const report = await Effect.runPromise(
      LlmLint.review({ workspaceRoot: root, executable: cli.executable }, payload({ batchSize: 3 }))
    )
    expect(report.files).toEqual(["src/a-handler.ts", "src/new-caller.ts", "src/z-store.ts", "src/m.ts"])
    const prompts = await cli.prompts()
    // Alphabetic slicing would have paired a-handler with m and left z-store alone.
    expect(prompts.map(changedIn)).toEqual([["src/a-handler.ts", "src/new-caller.ts", "src/z-store.ts"], ["src/m.ts"]])
    expect(relatedIn(prompts[0]!)).toEqual(["src/guard.ts", "src/route.ts"])
    expect(prompts[0]).toContain("=== RELATED FILES (unchanged callers and dependencies of the changed files) ===")
    expect(relatedIn(prompts[1]!)).toEqual([])
    expect(prompts[1]).not.toContain("RELATED FILES")
    for (const prompt of prompts) {
      expect(prompt).not.toContain("lib/outside.ts")
      expect(prompt).not.toContain("src/ignored.ts")
      expect(prompt).not.toContain("src/unrelated.ts")
    }
  })

  it("relates Go files through their package directory and skips unreadable related files", async () => {
    await write("src/svc/a.go", "package svc\n")
    await write("src/svc/b.go", "package svc\n\nfunc Guard() bool { return true }\n")
    await write("src/svc/nested/c.go", "package nested\n")
    await write("src/main.go", "package main\n")
    await Fs.symlink("b.go", Path.join(root, "src/svc/link.go"))
    commit()
    await write("src/svc/a.go", "package svc\n\nfunc Handler() { Guard() }\n")
    await write("src/main.go", "package main\n\nfunc main() {}\n")
    const cli = await recorder("[]")
    await Effect.runPromise(
      LlmLint.review({ workspaceRoot: root, executable: cli.executable }, payload({ batchSize: 1 }))
    )
    const prompts = await cli.prompts()
    expect(prompts.map(changedIn)).toEqual([["src/main.go"], ["src/svc/a.go"]])
    expect(relatedIn(prompts[0]!)).toEqual([])
    expect(relatedIn(prompts[1]!)).toEqual(["src/svc/b.go"])
  })

  it("relates unchanged snapshot files without reading the workspace", async () => {
    await write("src/placeholder.ts", "export {}\n")
    commit()
    const cli = await recorder("[]")
    await Effect.runPromise(LlmLint.review({
      workspaceRoot: root,
      executable: cli.executable,
      snapshot: [
        { path: "src/api.ts", contents: "export const api = 1\n", changed: true },
        { path: "src/caller.ts", contents: "import { api } from \"./api.ts\"\n", changed: false },
        { path: "src/removed.ts", contents: "import { api } from \"./api.ts\"\n", changed: true, deleted: true },
        { path: "src/other.ts", contents: "export const other = 1\n", changed: false }
      ]
    }, payload()))
    const prompts = await cli.prompts()
    expect(prompts.map(changedIn)).toEqual([["src/api.ts", "src/removed.ts"]])
    expect(relatedIn(prompts[0]!)).toEqual(["src/caller.ts"])
    expect(prompts[0]).toContain("{\"deleted\":true,")
  })

  it("reports a flaw in a file several requests saw once, keeping the strongest severity", async () => {
    await write("src/a.ts", "export const a = 1\n")
    await write("src/b.ts", "export const b = 1\n")
    await write("docs/shared.md", "shared\n")
    commit()
    await write("src/a.ts", "export const a = 2\n")
    await write("src/b.ts", "export const b = 2\n")
    const executable = Path.join(root, "severity.mjs")
    await Fs.writeFile(
      executable,
      "#!/usr/bin/env node\nlet prompt = \"\"\nfor await (const chunk of process.stdin) prompt += chunk\n" +
        "const severity = prompt.includes('CHANGED FILE: \"src/b.ts\"') ? 'warning' : 'info'\n" +
        "const findings = [{ file: 'docs/shared.md', line: 1, severity, message: severity }, " +
        "{ file: 'docs/shared.md', line: 1, severity: 'info', message: 'second' }]\n" +
        "process.stdout.write(JSON.stringify({ result: JSON.stringify(findings) }))\n",
      { mode: 0o755 }
    )
    const report = await Effect.runPromise(LlmLint.review(
      { workspaceRoot: root, executable },
      payload({ batchSize: 1, context: [Input.glob("//docs/shared.md")] })
    ))
    expect(report.findings).toEqual([{ file: "docs/shared.md", line: 1, severity: "warning", message: "warning" }])
  })
})

describe("LlmLint.review related-file discovery boundaries", () => {
  it("names snapshot hosts' related candidates and caller patterns", () => {
    const candidates = LlmLint.relatedCandidates(
      [
        { path: "src/a.ts", contents: "import { b } from \"./b.js\"\nimport { gone } from \"./gone.ts\"\n" },
        { path: "svc/x.go", contents: "package svc\n" }
      ],
      new Set(["src/a.ts", "src/b.ts", "svc/x.go", "svc/y.go", "svc/deep/z.go", "other/w.go"])
    )
    expect(candidates).toEqual({ paths: ["src/b.ts", "svc/y.go"], callerPatterns: ["/a(\\.[A-Za-z]+)?[\"']"] })
  })

  it("relates root Go files, skips unusable related text and names budget-omitted relations", async () => {
    await write("main.go", "package main\n")
    await write("util.go", "package main\n\nfunc util() {}\n")
    await write("src/a.ts", "import { big } from \"./big.ts\"\nimport { bad } from \"./bad.ts\"\n")
    await write("src/big.ts", `export const big = ${JSON.stringify("x".repeat(60_000))}\n`)
    await Fs.writeFile(Path.join(root, "src/bad.ts"), Buffer.from([0x65, 0x78, 0xff, 0x0a]))
    commit()
    await write("main.go", "package main\n\nfunc main() { util() }\n")
    await write(
      "src/a.ts",
      "import { big } from \"./big.ts\"\nimport { bad } from \"./bad.ts\"\n" +
        "import { odd } from \"./odd\u0001name\"\n// edit\n"
    )
    const cli = await recorder("[]")
    await Effect.runPromise(LlmLint.review(
      { workspaceRoot: root, executable: cli.executable },
      payload({ include: [Input.glob("**/*.{ts,go}")], batchSize: 1, contextTokens: 32_768 })
    ))
    const prompts = await cli.prompts()
    expect(prompts.map(changedIn)).toEqual([["main.go"], ["src/a.ts"]])
    expect(relatedIn(prompts[0]!)).toEqual(["util.go"])
    expect(relatedIn(prompts[1]!)).toEqual([])
    expect(prompts[1]).toContain("Related files omitted by the token budget: [\"src/big.ts\"]")
    expect(prompts[1]).not.toContain("src/bad.ts\"")
  })

  it("stops reading related files at their aggregate byte cap", async () => {
    const callers = Math.ceil(LlmLint.maximumRelatedContentBytes / (LlmLint.maximumReviewFileBytes - 64)) + 1
    const padding = "/".repeat(LlmLint.maximumReviewFileBytes - 128)
    await write("src/core.ts", "export const core = 1\n")
    for (let index = 0; index < callers; index++) {
      await write(`src/caller-${String(index).padStart(2, "0")}.ts`, `import { core } from "./core.ts"\n//${padding}\n`)
    }
    commit()
    await write("src/core.ts", "export const core = 2\n")
    const cli = await recorder("[]")
    await Effect.runPromise(LlmLint.review({ workspaceRoot: root, executable: cli.executable }, payload()))
    const [prompt] = await cli.prompts()
    const omitted = JSON.parse(/Related files omitted by the token budget: (.*)/.exec(prompt!)![1]!) as Array<string>
    // Every loaded caller is too large for the default window; the ones past the byte cap were never read.
    expect(omitted.length).toBeGreaterThan(0)
    expect(omitted.length).toBeLessThan(callers)
  })

  describe("with a substituted git grep", () => {
    const withGrep = async <A>(body: string, use: () => Promise<A>): Promise<A> => {
      const real = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim()
      const directory = Path.join(root, "git-bin")
      await Fs.mkdir(directory, { recursive: true })
      await Fs.writeFile(
        Path.join(directory, "git"),
        "#!/usr/bin/env node\nimport { spawnSync } from \"node:child_process\"\n" +
          "if (process.argv.includes(\"grep\")) {\n" + body + "\n} else {\n" +
          `const result = spawnSync(${JSON.stringify(real)}, process.argv.slice(2), { stdio: "inherit" })\n` +
          "process.exit(result.status ?? 1)\n}\n",
        { mode: 0o755 }
      )
      const previous = process.env["PATH"]
      process.env["PATH"] = `${directory}${Path.delimiter}${previous ?? ""}`
      try {
        return await use()
      } finally {
        process.env["PATH"] = previous
      }
    }
    const changedScript = async () => {
      await write("src/a.ts", "export const a = 1\n")
      commit()
      await write("src/a.ts", "export const a = 2\n")
    }

    it("skips listed paths a review cannot use", async () => {
      await changedScript()
      const cli = await recorder("[]")
      await withGrep(
        "process.stdout.write(\"src/bad\\u0001.ts\\0../escape.ts\\0\")",
        () => Effect.runPromise(LlmLint.review({ workspaceRoot: root, executable: cli.executable }, payload()))
      )
      const [prompt] = await cli.prompts()
      expect(relatedIn(prompt!)).toEqual([])
    })

    it("fails the review on a git grep error or unreadable listing", async () => {
      await changedScript()
      const cli = await recorder("[]")
      const exited = await withGrep(
        "process.stderr.write(\"grep broke\"); process.exit(2)",
        () =>
          Effect.runPromise(Effect.flip(LlmLint.review({ workspaceRoot: root, executable: cli.executable }, payload())))
      )
      expect(exited).toBeInstanceOf(LlmLint.LlmReviewError)
      expect(exited.message).toContain("git grep exited 2: grep broke")
      const invalid = await withGrep(
        "process.stdout.write(Buffer.from([0xff, 0]))",
        () =>
          Effect.runPromise(Effect.flip(LlmLint.review({ workspaceRoot: root, executable: cli.executable }, payload())))
      )
      expect(invalid).toBeInstanceOf(LlmLint.LlmReviewError)
      expect(invalid.message).toContain("not valid UTF-8")
      expect(await cli.prompts()).toEqual([])
    })
  })
})

describe("LlmLint.review token budget", () => {
  const functions = (count: number) =>
    Array.from(
      { length: count },
      (_, index) =>
        `export function handler${index}(input: string): string {\n${
          "  return input.trim().toLowerCase().replaceAll(\"a\", \"b\")\n".repeat(20)
        }}\n`
    ).join("")

  it("splits an oversized changed file at symbol boundaries so every request fits the declared window", async () => {
    await write("src/large.ts", "export {}\n")
    commit()
    const source = functions(120)
    await write("src/large.ts", source)
    const totalLines = source.split("\n").length
    const cli = await recorder(JSON.stringify([
      { file: "src/large.ts", line: totalLines - 3, severity: "warning", message: "late flaw" }
    ]))
    const report = await Effect.runPromise(LlmLint.review(
      { workspaceRoot: root, executable: cli.executable },
      payload({ contextTokens: 32_768 })
    ))
    const prompts = await cli.prompts()
    expect(prompts.length).toBeGreaterThan(1)
    const slices: Array<string> = []
    for (const prompt of prompts) {
      expect(ReviewBatches.estimateTokens(prompt) + ReviewBatches.estimateTokens("Review\nRubric:\nRubric"))
        .toBeLessThanOrEqual(32_768 - maximumResponseTokens)
      expect(prompt).toContain("Report whole-file line numbers.")
      const header = /--- CHANGED FILE: "src\/large.ts" \(lines (\d+)-(\d+) of (\d+)\) ---\n(.*)/.exec(prompt)!
      expect(Number(header[3])).toBe(totalLines)
      const body = JSON.parse(header[4]!) as { firstLine: number; contents: string }
      expect(body.firstLine).toBe(Number(header[1]))
      expect(body.contents.startsWith("export function")).toBe(true)
      slices.push(body.contents)
    }
    expect(slices.join("")).toBe(source)
    expect(report.files).toEqual(["src/large.ts"])
    expect(report.findings).toEqual([
      { file: "src/large.ts", line: totalLines - 3, severity: "warning", message: "late flaw" }
    ])
  })

  it("masks credentials before slicing so no request carries a fragment of one", async () => {
    await write("src/min.js", "export {}\n")
    commit()
    const token = `ghp_${"Z".repeat(36)}`
    // One overlong line of repeated tokens forces character slices, so raw slicing would cut through one.
    await write("src/min.js", `${`${token} `.repeat(3_000)}\n`)
    const cli = await recorder("[]")
    await Effect.runPromise(Effect.flip(LlmLint.review(
      { workspaceRoot: root, executable: cli.executable },
      payload({ contextTokens: 32_768 })
    )))
    const prompts = await cli.prompts()
    expect(prompts.length).toBeGreaterThan(1)
    for (let start = 0; start + 8 <= token.length; start += 4) {
      for (const prompt of prompts) expect(prompt).not.toContain(token.slice(start, start + 8))
    }
    expect(prompts.join("")).toContain("<credential:github-token:1>")
  })

  it("fails before inference when instructions and context leave no room for source", async () => {
    await write("src/a.ts", "export const a = 1\n")
    await write("docs/big.md", "context line\n".repeat(12_000))
    commit()
    await write("src/a.ts", "export const a = 2\n")
    const cli = await recorder("[]")
    const failure = await Effect.runPromise(Effect.flip(LlmLint.review(
      { workspaceRoot: root, executable: cli.executable },
      payload({ contextTokens: 32_768, context: [Input.glob("//docs/big.md")] })
    )))
    expect(failure).toBeInstanceOf(LlmLint.LlmReviewError)
    expect(failure.message).toMatch(/of the 32768-token context window, leaving no room for source/)
    expect(await cli.prompts()).toEqual([])
  })

  it("refuses a request that outgrows the window after planning instead of sending it", async () => {
    await write("src/a.ts", "export const a = 1\n")
    commit()
    await write("src/a.ts", "export const a = 2\n")
    // A verification request quotes its candidate, which can outgrow the room planning reserved.
    const long = "e".repeat(16_000)
    const completion = JSON.stringify({
      status: "completed",
      coverage: [{ checkId: "general", status: "completed", evidence: "Inspected." }],
      missingContext: [],
      findings: [{
        file: "src/a.ts",
        line: 1,
        severity: "warning",
        message: long,
        security: {
          checkId: "general",
          impact: "low",
          verification: "suspected",
          releaseRecommendation: "allow",
          attackerPreconditions: long,
          evidence: long,
          nextConfirmationStep: long
        }
      }]
    })
    const executable = Path.join(root, "verbose.mjs")
    const record = Path.join(root, "verbose.calls")
    await Fs.writeFile(
      executable,
      "#!/usr/bin/env node\nimport { appendFileSync } from \"node:fs\"\nfor await (const _ of process.stdin) {}\n" +
        `appendFileSync(${JSON.stringify(record)}, "call\\n")\n` +
        `const answer = ${JSON.stringify(completion)}\n` +
        "process.stdout.write(process.argv[2] === \"exec\"\n" +
        "  ? JSON.stringify({ type: \"item.completed\", item: { type: \"agent_message\", text: answer } }) + " +
        "\"\\n\" + JSON.stringify({ type: \"turn.completed\" }) + \"\\n\"\n" +
        "  : JSON.stringify({ type: \"result\", subtype: \"success\", is_error: false, result: answer }))\n",
      { mode: 0o755 }
    )
    const failure = await Effect.runPromise(Effect.flip(LlmLint.review(
      { workspaceRoot: root, executable },
      payload({ contextTokens: 32_768, securityChecks: ["general"] })
    )))
    expect(failure).toBeInstanceOf(LlmLint.LlmReviewError)
    expect(failure.message).toMatch(/exceeding the 32768-token context window/)
    // The three review passes ran; no oversized verification request was sent.
    expect((await Fs.readFile(record, "utf8")).split("\n").filter(Boolean)).toHaveLength(3)
  })

  it("declares and validates the context window", () => {
    expect(() => LlmLint.Attrs.make({ ...attrs(), contextTokens: LlmLint.minimumContextTokens - 1 })).toThrow()
    expect(() => LlmLint.Attrs.make({ ...attrs(), contextTokens: LlmLint.maximumContextTokens + 1 })).toThrow()
    expect(LlmLint.Attrs.make({ ...attrs(), contextTokens: 400_000 }).contextTokens).toBe(400_000)
    const declared = SecurityReview.SecurityReview({ cwd: "pkg", checks: [], contextTokens: 400_000 })
    expect(Target.metadata(declared.security).attrs).toMatchObject({ contextTokens: 400_000 })
    expect(Target.metadata(declared.securityAudit).attrs).toMatchObject({ contextTokens: 400_000 })
    const defaulted = SecurityReview.SecurityReview({ cwd: "pkg", checks: [] })
    expect(Object.hasOwn(Target.metadata(defaulted.security).attrs as object, "contextTokens")).toBe(false)
  })
})

const attrs = () => ({
  changes: Input.gitDiff("HEAD"),
  include: [Input.glob("src/**")],
  deps: [],
  prompt: "Review",
  rubric: "Rubric",
  model: "test",
  batchSize: 1
})
