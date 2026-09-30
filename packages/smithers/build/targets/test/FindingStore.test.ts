import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as Path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import * as Input from "../src/Input.ts"
import * as LlmLint from "../src/LlmLint.ts"

let root: string
let store: string

const write = async (relative: string, text: string): Promise<void> => {
  const path = Path.join(root, relative)
  await Fs.mkdir(Path.dirname(path), { recursive: true })
  await Fs.writeFile(path, text, "utf8")
}

beforeEach(async () => {
  root = await Fs.realpath(await Fs.mkdtemp(Path.join(Os.tmpdir(), "finding-store-")))
  store = Path.join(root, ".private", "findings")
  await write("src/a.ts", "export const a = 1\n")
  await write("src/b.ts", "export const b = 1\n")
  execFileSync("git", ["init", "-q", "--initial-branch=main"], { cwd: root })
  await write(".gitignore", ".private/\ncontrol.json\ncalls.log\nengine.mjs\n")
  execFileSync("git", ["add", "."], { cwd: root })
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-qm", "base"], { cwd: root })
  await write("src/a.ts", "export const a = 2\ndanger()\n")
  await write("src/b.ts", "export const b = 2\n")
})

afterEach(async () => {
  await Fs.rm(root, { recursive: true, force: true })
})

interface Control {
  /** Changed files whose request exits non-zero. */
  readonly fail?: ReadonlyArray<string>
  /** Findings answered for each changed file present in a request. */
  readonly findings?: Record<string, ReadonlyArray<LlmLint.Finding>>
}

/** A fake claude CLI steered by `control.json`, recording which changed files each call carried. */
const engine = async (control: Control): Promise<{ executable: string; calls: () => Promise<Array<string>> }> => {
  await Fs.writeFile(Path.join(root, "control.json"), JSON.stringify(control))
  const executable = Path.join(root, "engine.mjs")
  const record = Path.join(root, "calls.log")
  await Fs.rm(record, { force: true })
  await Fs.writeFile(
    executable,
    [
      "#!/usr/bin/env node",
      "import { appendFileSync, readFileSync } from \"node:fs\"",
      "let prompt = \"\"",
      "for await (const chunk of process.stdin) prompt += chunk",
      `const control = JSON.parse(readFileSync(${JSON.stringify(Path.join(root, "control.json"))}, "utf8"))`,
      "const files = [...prompt.matchAll(/--- CHANGED FILE: \"([^\"]+)\"/g)].map((match) => match[1])",
      `appendFileSync(${JSON.stringify(record)}, files.join(",") + "\\n")`,
      "if (files.some((file) => (control.fail ?? []).includes(file))) { process.stderr.write(\"refused\"); process.exit(3) }",
      "const findings = files.flatMap((file) => (control.findings ?? {})[file] ?? [])",
      "process.stdout.write(JSON.stringify({ result: JSON.stringify(findings) }))"
    ].join("\n"),
    { mode: 0o755 }
  )
  return {
    executable,
    calls: async () => (await Fs.readFile(record, "utf8").catch(() => "")).split("\n").filter(Boolean)
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
  batchSize: 1,
  failOn: "error",
  ...overrides
})

const danger: LlmLint.Finding = { file: "src/a.ts", line: 2, severity: "warning", message: "danger() is unsafe" }

const review = (executable: string, overrides: Partial<LlmLint.Payload> = {}, owner = "//pkg:security") =>
  LlmLint.review({ workspaceRoot: root, executable, store: { directory: store, owner } }, payload(overrides))

const runs = async (): Promise<Array<LlmLint.RunRecord>> =>
  Promise.all(
    (await Fs.readdir(Path.join(store, "runs"))).map(async (name) =>
      JSON.parse(await Fs.readFile(Path.join(store, "runs", name), "utf8")) as LlmLint.RunRecord
    )
  )

describe("LlmLint.review finding store", () => {
  it("persists each completed batch so a later failure keeps it, then resumes only the rest", async () => {
    const failing = await engine({ fail: ["src/b.ts"], findings: { "src/a.ts": [danger] } })
    const failure = await Effect.runPromise(Effect.flip(review(failing.executable)))
    expect(failure).toBeInstanceOf(LlmLint.LlmReviewError)
    const [failed] = await runs()
    expect(failed).toMatchObject({ status: "failed", total: 2, owner: "//pkg:security" })
    expect(failed!.error).toContain("exited 3")
    expect(failed!.batches).toEqual([{ index: 0, files: ["src/a.ts"], findings: [danger], attempts: [] }])
    const [stored] = await Effect.runPromise(LlmLint.storedFindings(store))
    expect(stored).toMatchObject({ state: "open", owner: "//pkg:security", finding: danger })

    const fixed = await engine({ findings: { "src/a.ts": [danger] } })
    const report = await Effect.runPromise(review(fixed.executable))
    expect(await fixed.calls()).toEqual(["src/b.ts"])
    expect(report.files).toEqual(["src/a.ts", "src/b.ts"])
    expect(report.findings).toEqual([danger])
    expect(report.run).toBe(failed!.run)
    expect(report.fingerprints).toEqual([stored!.fingerprint])
    expect((await runs()).map(({ status }) => status)).toEqual(["completed"])

    // A completed run is never reused as a verdict: the same inputs are reviewed again.
    const repeat = await engine({ findings: { "src/a.ts": [danger] } })
    await Effect.runPromise(review(repeat.executable))
    expect(await repeat.calls()).toEqual(["src/a.ts", "src/b.ts"])
  })

  it("schedules batches past the per-invocation limit across invocations", async () => {
    for (let index = 0; index <= LlmLint.maximumReviewBatches; index++) {
      await write(`src/many-${String(index).padStart(2, "0")}.ts`, `export const value${index} = ${index}\n`)
    }
    await Fs.rm(Path.join(root, "src/a.ts"))
    await Fs.rm(Path.join(root, "src/b.ts"))
    const cli = await engine({})
    const incomplete = await Effect.runPromise(Effect.flip(review(cli.executable)))
    expect(incomplete.message).toBe(
      `Review incomplete: 1 of ${LlmLint.maximumReviewBatches + 1} batches remain; ` +
        "run it again with the same finding store to resume"
    )
    expect((await cli.calls()).length).toBe(LlmLint.maximumReviewBatches)
    expect((await runs())[0]).toMatchObject({ status: "incomplete" })
    const next = await engine({})
    const report = await Effect.runPromise(review(next.executable))
    expect(await next.calls()).toEqual([`src/many-${LlmLint.maximumReviewBatches}.ts`])
    expect(report.files).toHaveLength(LlmLint.maximumReviewBatches + 1)
  }, 300_000)

  it("tracks a fix until a reproduced retest closes it, and reopens a regression", async () => {
    const first = await engine({ findings: { "src/a.ts": [danger] } })
    const failure = await Effect.runPromise(Effect.flip(review(first.executable, { failOn: "warning" })))
    expect(failure).toBeInstanceOf(LlmLint.FindingsError)
    const fingerprint = (failure as LlmLint.FindingsError).fingerprints![0]!
    expect((failure as LlmLint.FindingsError).run).toMatch(/^[a-f0-9]{64}$/)

    // The flagged line moves; its fingerprint does not.
    await write("src/a.ts", "export const a = 3\n\ndanger()\n")
    const moved = await engine({ findings: { "src/a.ts": [{ ...danger, line: 3 }] } })
    const again = await Effect.runPromise(review(moved.executable))
    expect(again.fingerprints).toEqual([fingerprint])

    const receipt = { revision: "a".repeat(40), command: "npm test -- danger", observedResult: "rejects the input" }
    const early = await Effect.runPromise(Effect.flip(LlmLint.closeFinding(store, fingerprint, receipt)))
    expect(early).toMatchObject({ phase: "store", message: expect.stringContaining("is open") })

    await write("src/a.ts", "export const a = 4\nsafe()\n")
    const clean = await engine({})
    await Effect.runPromise(review(clean.executable))
    const [pending] = await Effect.runPromise(LlmLint.storedFindings(store))
    expect(pending).toMatchObject({ fingerprint, state: "fixed-pending-retest" })
    expect(LlmLint.publicSummary(pending!)).toEqual({
      fingerprint,
      reference: `restricted-finding:${fingerprint}`,
      state: "fixed-pending-retest",
      severity: "warning",
      owner: "//pkg:security"
    })
    const closed = await Effect.runPromise(LlmLint.closeFinding(store, fingerprint, receipt))
    expect(closed).toMatchObject({ state: "closed", closure: receipt })
    expect(LlmLint.publicSummary(closed)).toMatchObject({ state: "closed", file: "src/a.ts" })
    expect(JSON.stringify(LlmLint.publicSummary(closed))).not.toContain("unsafe")

    await write("src/a.ts", "export const a = 5\ndanger()\n")
    const regression = await engine({ findings: { "src/a.ts": [danger] } })
    await Effect.runPromise(review(regression.executable))
    const [reopened] = await Effect.runPromise(LlmLint.storedFindings(store))
    expect(reopened).toMatchObject({ state: "open", firstSeenRun: (failure as LlmLint.FindingsError).run })
    expect(reopened!.closure).toBeUndefined()
  })

  it("retires a finding only by its own owner and policy after reviewing its file", async () => {
    const first = await engine({ findings: { "src/a.ts": [danger] } })
    await Effect.runPromise(review(first.executable, {}, "//other:security"))
    await write("src/a.ts", "export const a = 9\nsafe()\n")
    const clean = await engine({})
    await Effect.runPromise(review(clean.executable, { include: [Input.glob("src/b.ts")] }, "//other:security"))
    await Effect.runPromise(review(clean.executable))
    await Effect.runPromise(review(clean.executable, { rubric: "Another rubric" }, "//other:security"))
    const [record] = await Effect.runPromise(LlmLint.storedFindings(store))
    expect(record).toMatchObject({ state: "open", owner: "//other:security" })
    await Effect.runPromise(review(clean.executable, {}, "//other:security"))
    const [retired] = await Effect.runPromise(LlmLint.storedFindings(store))
    expect(retired).toMatchObject({ state: "fixed-pending-retest" })
  })

  it("persists security attempts and derives reproduction steps from the finding", async () => {
    const evidence = {
      checkId: "general",
      impact: "medium" as const,
      verification: "suspected" as const,
      releaseRecommendation: "review" as const,
      attackerPreconditions: "Controls the input.",
      evidence: "danger() receives it.",
      nextConfirmationStep: "Call danger() with a synthetic payload."
    }
    const completion = JSON.stringify({
      status: "completed",
      coverage: [{ checkId: "general", status: "completed", evidence: "Inspected the file." }],
      missingContext: [],
      findings: [{ ...danger, security: evidence }]
    })
    const executable = Path.join(root, "security.mjs")
    await Fs.writeFile(
      executable,
      "#!/usr/bin/env node\nfor await (const _ of process.stdin) {}\n" +
        `const answer = ${JSON.stringify(completion)}\n` +
        "process.stdout.write(process.argv[2] === \"exec\"\n" +
        "  ? JSON.stringify({ type: \"item.completed\", item: { type: \"agent_message\", text: answer } }) + " +
        "\"\\n\" + JSON.stringify({ type: \"turn.completed\" }) + \"\\n\"\n" +
        "  : JSON.stringify({ type: \"result\", subtype: \"success\", is_error: false, result: answer }))\n",
      { mode: 0o755 }
    )
    const report = await Effect.runPromise(
      review(executable, { securityChecks: ["general"], include: [Input.glob("src/a.ts")] })
    )
    const [run] = await runs()
    expect(run!.batches[0]!.attempts.length).toBe(report.attempts!.length)
    const [record] = await Effect.runPromise(LlmLint.storedFindings(store))
    expect(record!.reproductionSteps).toBe("Call danger() with a synthetic payload.")
    expect(LlmLint.publicSummary(record!)).toMatchObject({ checkId: "general", impact: "medium" })
  })

  it("keeps the store private and refuses unusable locations and records", async () => {
    const cli = await engine({ findings: { "src/a.ts": [danger] } })
    const report = await Effect.runPromise(review(cli.executable))
    expect(report.findings).toEqual([danger])
    const { mode } = await Fs.stat(store)
    expect(mode & 0o777).toBe(0o700)
    for (const name of await Fs.readdir(Path.join(store, "findings"))) {
      expect((await Fs.stat(Path.join(store, "findings", name))).mode & 0o777).toBe(0o600)
    }
    expect(await Effect.runPromise(Effect.flip(LlmLint.storedFindings("relative/store")))).toMatchObject({
      phase: "store",
      message: expect.stringContaining("must be absolute")
    })
    const link = Path.join(root, "linked-store")
    await Fs.symlink(store, link)
    expect((await Effect.runPromise(Effect.flip(LlmLint.storedFindings(link)))).message).toContain("not a directory")
    const receipt = { revision: "b".repeat(40), command: "retest", observedResult: "passes" }
    expect((await Effect.runPromise(Effect.flip(LlmLint.closeFinding(store, "../escape", receipt)))).message)
      .toContain("not usable")
    expect((await Effect.runPromise(Effect.flip(LlmLint.closeFinding(store, "c".repeat(64), receipt)))).message)
      .toContain("no finding")
    await Fs.mkdir(Path.join(store, "findings", `${"d".repeat(64)}.json`))
    expect((await Effect.runPromise(Effect.flip(LlmLint.storedFindings(store)))).message).toContain(
      "not a regular file"
    )
    await Fs.rm(store, { recursive: true })
    await Fs.writeFile(store, "not a directory")
    const blocked = await Effect.runPromise(Effect.flip(review(cli.executable)))
    expect(blocked).toMatchObject({ phase: "store" })
  })
})

describe("LlmLint.review provenance manifest", () => {
  const sha = (text: string | Buffer) => createHash("sha256").update(text).digest("hex")

  it("binds the run to the policy, revisions, engine identity, batch layout and reviewed bytes", async () => {
    await write("docs/context.md", "context\n")
    const cli = await engine({ findings: { "src/a.ts": [danger] } })
    const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim()
    const report = await Effect.runPromise(review(cli.executable, { context: [Input.glob("//docs/context.md")] }))
    const manifest = report.manifest!
    expect(report.run).toBe(sha(JSON.stringify(manifest)))
    expect(manifest).toEqual({
      version: 1,
      revisions: { base: head, head },
      policy: {
        digest: sha(JSON.stringify(["Review", "Rubric", null])),
        prompt: sha("Review"),
        rubric: sha("Rubric"),
        failOn: "error",
        scope: "changed",
        batchSize: 1,
        contextTokens: LlmLint.defaultContextTokens
      },
      engine: {
        transport: "cli",
        seats: [{ engine: "claude", model: "test" }],
        executable: { path: cli.executable, sha256: sha(await Fs.readFile(cli.executable)) }
      },
      context: [{ path: "docs/context.md", sha256: sha("context\n"), bytes: 8 }],
      batches: [
        {
          changed: [{ path: "src/a.ts", firstLine: 1, lastLine: 3, sha256: sha("export const a = 2\ndanger()\n") }],
          related: [],
          omittedRelated: []
        },
        {
          changed: [{ path: "src/b.ts", firstLine: 1, lastLine: 2, sha256: sha("export const b = 2\n") }],
          related: [],
          omittedRelated: []
        }
      ]
    })
    const [run] = await runs()
    expect(run!.manifest).toEqual(manifest)

    // One reviewed byte, or a host-pinned revision, makes a different run.
    const pinned = await Effect.runPromise(LlmLint.review({
      workspaceRoot: root,
      executable: cli.executable,
      store: { directory: store },
      revisions: { base: "a".repeat(40), head: "b".repeat(40) }
    }, payload({ context: [Input.glob("//docs/context.md")] })))
    expect(pinned.manifest!.revisions).toEqual({ base: "a".repeat(40), head: "b".repeat(40) })
    expect(pinned.run).not.toBe(report.run)
    await write("src/b.ts", "export const b = 3\n")
    const edited = await Effect.runPromise(review(cli.executable, { context: [Input.glob("//docs/context.md")] }))
    expect(edited.run).not.toBe(report.run)
  })

  it("names every security seat and fails closed on an unreadable executable or base", async () => {
    const cli = await engine({})
    await Fs.chmod(cli.executable, 0o111)
    const unreadable = await Effect.runPromise(Effect.flip(review(cli.executable)))
    expect(unreadable.message).toContain("Review executable identity")
    const missing = await Effect.runPromise(Effect.flip(review(Path.join(root, "absent-engine"))))
    expect(missing).toBeInstanceOf(LlmLint.ModelCliMissing)
    const onPath = await Effect.runPromise(Effect.flip(review("smithers-absent-engine")))
    expect(onPath).toBeInstanceOf(LlmLint.ModelCliMissing)
    const base = await Effect.runPromise(Effect.flip(LlmLint.review({
      workspaceRoot: root,
      executable: cli.executable,
      store: { directory: store },
      snapshot: [{ path: "src/a.ts", contents: "export const a = 1\n", changed: true }]
    }, payload({ base: "c".repeat(40) }))))
    expect(base).toMatchObject({ phase: "diff", message: expect.stringContaining("git rev-parse exited") })
  })
})

describe("LlmLint.review review hardening", () => {
  const token = `ghp_${"Q".repeat(36)}`

  it("never sends, stores or reports a credential named by a file path", async () => {
    await write(`src/${token}.ts`, `export const leaked = "${token}"\n`)
    const cli = await engine({})
    const prompts = Path.join(root, "prompts.log")
    await Fs.writeFile(
      cli.executable,
      (await Fs.readFile(cli.executable, "utf8")).replace(
        "const files =",
        `appendFileSync(${JSON.stringify(prompts)}, prompt)\nconst files =`
      )
    )
    const failure = await Effect.runPromise(Effect.flip(review(cli.executable)))
    expect(failure).toBeInstanceOf(LlmLint.FindingsError)
    const text = JSON.stringify(failure) + (await Fs.readFile(prompts, "utf8"))
    const stored = await Promise.all(
      ["runs", "findings"].flatMap((collection) => [collection]).map(async (collection) =>
        Promise.all(
          (await Fs.readdir(Path.join(store, collection))).map((file) =>
            Fs.readFile(Path.join(store, collection, file), "utf8")
          )
        )
      )
    )
    expect(text + stored.flat().join("")).not.toContain(token)
    expect((failure as LlmLint.FindingsError).findings.map(({ file }) => file)).toContain(
      "src/<credential:github-token:1>.ts"
    )
  })

  it("keeps the strongest report of one flaw within a run", async () => {
    const cli = await engine({
      findings: { "src/a.ts": [{ ...danger, severity: "error" }, { ...danger, severity: "info", message: "fine" }] }
    })
    const failure = await Effect.runPromise(Effect.flip(review(cli.executable, { include: [Input.glob("src/a.ts")] })))
    const fingerprints = (failure as LlmLint.FindingsError).fingerprints!
    expect(new Set(fingerprints).size).toBe(1)
    const [record] = await Effect.runPromise(LlmLint.storedFindings(store))
    expect(record!.finding).toMatchObject({ severity: "error", message: danger.message })
  })

  it("charges a resumed run for the calls its earlier invocations spent", async () => {
    const cli = await engine({})
    const first = await Effect.runPromise(Effect.flip(review(cli.executable, { budget: { modelCalls: 1 } })))
    expect(first.message).toBe("Review budget exhausted: 1 model calls")
    const again = await Effect.runPromise(Effect.flip(review(cli.executable, { budget: { modelCalls: 1 } })))
    expect(again.message).toBe("Review budget exhausted: 1 model calls")
    expect(await cli.calls()).toEqual(["src/a.ts"])
    const report = await Effect.runPromise(review(cli.executable, { budget: { modelCalls: 2 } }))
    expect(report.usage).toMatchObject({ modelCalls: 2 })
    expect(await cli.calls()).toEqual(["src/a.ts", "src/b.ts"])
    expect((await runs())[0]!.usage.modelCalls).toBe(2)
  })

  it("refuses store collections and records reached through links", async () => {
    const cli = await engine({ findings: { "src/a.ts": [danger] } })
    await Effect.runPromise(review(cli.executable))
    const outside = Path.join(root, "outside")
    await Fs.rename(Path.join(store, "findings"), outside)
    await Fs.symlink(outside, Path.join(store, "findings"))
    expect((await Effect.runPromise(Effect.flip(LlmLint.storedFindings(store)))).message).toContain(
      "collection is not a directory"
    )
    await Fs.rm(Path.join(store, "findings"))
    await Fs.mkdir(Path.join(store, "findings"), { mode: 0o700 })
    const [name] = await Fs.readdir(outside)
    await Fs.symlink(Path.join(outside, name!), Path.join(store, "findings", name!))
    expect((await Effect.runPromise(Effect.flip(LlmLint.storedFindings(store)))).message).toContain(
      "not a regular file"
    )
  })
})

describe("LlmLint.review containment follow-up", () => {
  it("scans paths as text, never as source expressions", async () => {
    const executable = Path.join(root, "paths.mjs")
    const prompts = Path.join(root, "paths.log")
    await Fs.writeFile(
      executable,
      "#!/usr/bin/env node\nimport { appendFileSync } from \"node:fs\"\nlet prompt = \"\"\n" +
        "for await (const chunk of process.stdin) prompt += chunk\n" +
        `appendFileSync(${JSON.stringify(prompts)}, prompt)\n` +
        "process.stdout.write(JSON.stringify({ result: \"[]\" }))\n",
      { mode: 0o755 }
    )
    const failure = await Effect.runPromise(Effect.flip(LlmLint.review({
      workspaceRoot: root,
      executable,
      snapshot: [{ path: "src/password=MiXeD42.ts", contents: "export const harmless = 1\n", changed: true }]
    }, payload())))
    expect(failure).toBeInstanceOf(LlmLint.FindingsError)
    expect(await Fs.readFile(prompts, "utf8")).not.toContain("MiXeD42")
    expect(JSON.stringify(failure)).not.toContain("MiXeD42")
    expect(LlmLint.redactCredentials(`src/ghp_${"R".repeat(36)}.ts`)).toBe("src/<credential:github-token:1>.ts")
  })

  it("records spend and elapsed time on failure and charges both on resume", async () => {
    const failing = await engine({ fail: ["src/a.ts"] })
    const first = await Effect.runPromise(Effect.flip(review(failing.executable, { budget: { modelCalls: 1 } })))
    expect(first.message).toContain("exited 3")
    const [failed] = await runs()
    expect(failed!.usage.modelCalls).toBe(1)
    const again = await Effect.runPromise(Effect.flip(review(failing.executable, { budget: { modelCalls: 1 } })))
    expect(again.message).toBe("Review budget exhausted: 1 model calls")
    expect(await failing.calls()).toEqual(["src/a.ts"])

    const name = Path.join(store, "runs", `${failed!.run}.json`)
    const record = JSON.parse(await Fs.readFile(name, "utf8")) as LlmLint.RunRecord
    await Fs.writeFile(name, JSON.stringify({ ...record, usage: { ...record.usage, elapsedMs: 60_000 } }))
    const late = await Effect.runPromise(Effect.flip(review(failing.executable, { budget: { wallMs: 60_000 } })))
    expect(late.message).toBe("Review budget exhausted: 60000 ms")
  })

  it("persists the spend of an interrupted call so a resume still charges it", async () => {
    const executable = Path.join(root, "slow.mjs")
    const record = Path.join(root, "slow.log")
    await Fs.writeFile(
      executable,
      "#!/usr/bin/env node\nimport { appendFileSync } from \"node:fs\"\n" +
        "for await (const _ of process.stdin) {}\n" +
        `appendFileSync(${JSON.stringify(record)}, "call\\n")\n` +
        "await new Promise((resolve) => setTimeout(resolve, 30_000))\n" +
        "process.stdout.write(JSON.stringify({ result: \"[]\" }))\n",
      { mode: 0o755 }
    )
    const calls = async () => (await Fs.readFile(record, "utf8").catch(() => "")).split("\n").filter(Boolean).length
    const fiber = Effect.runFork(review(executable, { budget: { modelCalls: 1 } }))
    const started = Date.now()
    while ((await calls()) < 1) {
      if (Date.now() - started > 20_000) throw new Error("the slow engine never started")
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
    await Effect.runPromise(Fiber.interrupt(fiber))
    const [interrupted] = await runs()
    expect(interrupted).toMatchObject({ status: "failed", usage: { modelCalls: 1 } })
    expect(interrupted!.usage.elapsedMs).toBeGreaterThan(0)
    const again = await Effect.runPromise(Effect.flip(review(executable, { budget: { modelCalls: 1 } })))
    expect(again.message).toBe("Review budget exhausted: 1 model calls")
    expect(await calls()).toBe(1)
  })

  it("records each call's charge before issuing it, so a killed process never frees its spend", async () => {
    const executable = Path.join(root, "engine.mjs")
    const seen = Path.join(root, "calls.log")
    // The engine captures the run record as it stands when the call arrives, then is killed.
    await Fs.writeFile(
      executable,
      "#!/usr/bin/env node\nimport { appendFileSync, readdirSync, readFileSync } from \"node:fs\"\n" +
        "for await (const _ of process.stdin) {}\n" +
        `const runs = ${JSON.stringify(Path.join(store, "runs"))}\n` +
        "for (const name of readdirSync(runs)) {\n" +
        "  const usage = JSON.parse(readFileSync(`${runs}/${name}`, \"utf8\")).usage\n" +
        `  appendFileSync(${JSON.stringify(seen)}, JSON.stringify(usage) + "\\n")\n` +
        "}\n" +
        "process.kill(process.pid, \"SIGKILL\")\n",
      { mode: 0o755 }
    )
    await Effect.runPromise(Effect.flip(review(executable, { budget: { modelCalls: 3 } })))
    const usages = (await Fs.readFile(seen, "utf8")).split("\n").filter(Boolean).map((line) =>
      JSON.parse(line) as LlmLint.RunRecord["usage"]
    )
    // The call found its own charge already on disk.
    expect(usages.map(({ modelCalls }) => modelCalls)).toEqual([1])
    expect(usages[0]!.promptTokens).toBeGreaterThan(0)
  })

  it("never feeds a finding store inside the workspace back into a prompt", async () => {
    // Not ignored by Git, so an all-scope include over the whole tree lists its records.
    const visible = Path.join(root, "review-store")
    const cli = await engine({ findings: { "src/a.ts": [danger] } })
    const everything = { include: [Input.glob("//**/*")], scope: "all" as const, batchSize: 4 }
    const reviewOnce = () =>
      LlmLint.review(
        { workspaceRoot: root, executable: cli.executable, store: { directory: visible } },
        payload(everything)
      )
    await Effect.runPromise(reviewOnce())
    expect((await Fs.readdir(Path.join(visible, "findings"))).length).toBe(1)
    const report = await Effect.runPromise(reviewOnce())
    expect(report.files).toEqual([".gitignore", "src/a.ts", "src/b.ts"])
    expect((await cli.calls()).join(",")).not.toContain("review-store")

    // A store holding the whole workspace leaves nothing to review; one outside it excludes nothing.
    const whole = await Effect.runPromise(
      LlmLint.review(
        { workspaceRoot: root, executable: cli.executable, store: { directory: root } },
        payload(everything)
      )
    )
    expect(whole.files).toEqual([])
    const outside = await Fs.mkdtemp(Path.join(Os.tmpdir(), "finding-store-outside-"))
    try {
      const separate = await Effect.runPromise(
        LlmLint.review({
          workspaceRoot: root,
          executable: cli.executable,
          store: { directory: Path.join(outside, "not", "yet", "created") }
        }, payload(everything))
      )
      expect(separate.files).toContain("review-store/findings/" + (await Fs.readdir(Path.join(visible, "findings")))[0])
    } finally {
      await Fs.rm(outside, { recursive: true, force: true })
    }
  })

  it("refuses a FIFO record without waiting for a writer", async () => {
    const cli = await engine({ findings: { "src/a.ts": [danger] } })
    await Effect.runPromise(review(cli.executable))
    execFileSync("mkfifo", [Path.join(store, "findings", `${"e".repeat(64)}.json`)])
    expect((await Effect.runPromise(Effect.flip(LlmLint.storedFindings(store)))).message).toContain(
      "not a regular file"
    )
  })
})
