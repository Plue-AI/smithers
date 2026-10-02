import * as Input from "@smthrs/targets/Input"
import * as LlmLint from "@smthrs/targets/LlmLint"
import * as Target from "@smthrs/targets/Target"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"
import { execFileSync } from "node:child_process"
import { existsSync } from "node:fs"
import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as NodePath from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import * as Label from "../src/Label.ts"
import {
  defaultProposedBudget,
  governing,
  prepare,
  prepareSource,
  reviewPrepared,
  type ReviewSource,
  run,
  type SourceEntry
} from "../src/TrustedReview.ts"
import { serve } from "./helpers/ServeCli.ts"

const temporaryDirectories: Array<string> = []
afterAll(async () => {
  await Promise.all(temporaryDirectories.map((directory) => Fs.rm(directory, { recursive: true, force: true })))
})

const git = (root: string, ...args: Array<string>): string =>
  execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim()

const write = async (root: string, path: string, contents: string): Promise<void> => {
  const absolute = NodePath.join(root, path)
  await Fs.mkdir(NodePath.dirname(absolute), { recursive: true })
  await Fs.writeFile(absolute, contents)
}

const policy = (rubric: string, manual = false): string =>
  JSON.stringify(
    Target.metadata(LlmLint.LlmLint({
      changes: Input.gitDiff("HEAD"),
      include: [Input.glob("//src/**")],
      deps: [],
      prompt: "Inspect selected source.",
      rubric,
      model: "review-test-model",
      batchSize: 1,
      manual
    })).attrs as LlmLint.Attrs
  )

const row = (label: string, reviewPolicy?: string) => ({
  label,
  package: label.slice(2, label.indexOf(":")),
  name: label.slice(label.indexOf(":") + 1),
  rule: "LlmLint",
  ...(reviewPolicy === undefined ? {} : { reviewPolicy }),
  kinds: ["review"],
  cacheable: false,
  inputs: [],
  outputs: [],
  dependencies: [],
  source: { file: "PACKAGE.ts" }
})

const index = (reviewPolicy?: string): string => JSON.stringify([row("//:security", reviewPolicy)])

const fixture = async (reviewPolicy: string | null = policy("trusted rubric")) => {
  const root = await Fs.mkdtemp(NodePath.join(Os.tmpdir(), "smithers-trusted-review-"))
  temporaryDirectories.push(root)
  git(root, "init", "-q")
  git(root, "config", "user.name", "Review Test")
  git(root, "config", "user.email", "review@example.invalid")
  await write(root, "WORKSPACE.ts", "export const Workspace = 1\n")
  await write(root, "PACKAGE.ts", "export const Package = 1\n")
  await write(root, "src/service.ts", "export const value = 'trusted'\n")
  await write(root, ".smithers/target-index.json", index(reviewPolicy ?? undefined))
  git(root, "add", ".")
  git(root, "commit", "-qm", "trusted policy")
  return { root, trusted: git(root, "rev-parse", "HEAD") }
}

const options = (root: string, policyRevision: string, revision?: string) => ({
  workspace: root,
  policyRevision,
  revision,
  patterns: ["//..."],
  plan: true
})

describe("TrustedReview Git boundary", () => {
  it("uses the pinned policy and committed source without executing candidate declarations", async () => {
    const { root, trusted } = await fixture()
    const marker = NodePath.join(root, "candidate-executed")
    await write(
      root,
      "PACKAGE.ts",
      `import { writeFileSync } from "node:fs"\nwriteFileSync(${
        JSON.stringify(marker)
      }, "executed")\nthrow new Error("candidate declaration ran")\n`
    )
    await write(root, "security.ts", "export const proposedPolicy = 'new'\n")
    await write(root, "src/service.ts", "export const value = 'committed candidate'\n")
    await write(root, ".smithers/target-index.json", index(policy("candidate rubric")))
    git(root, "add", ".")
    git(root, "commit", "-qm", "candidate policy and source")
    const candidate = git(root, "rev-parse", "HEAD")
    await write(root, "src/service.ts", "export const value = 'dirty worktree'\n")
    await write(root, ".smithers/target-index.json", index(policy("dirty rubric")))

    const prepared = await prepare(options(root, trusted, candidate))
    expect(prepared.policies.find(({ label }) => label === "//:security")?.payload.rubric).toBe("trusted rubric")
    expect(prepared.policies.find(({ label }) => label === "//:security")?.payload.base).toBe(trusted)
    expect(prepared.snapshot.find(({ path }) => path === "src/service.ts")?.contents)
      .toBe("export const value = 'committed candidate'\n")
    expect(prepared.snapshot.find(({ path }) => path === "src/service.ts")?.changed).toBe(true)
    expect(prepared.policies.map(({ label }) => label)).toEqual([
      "//:security",
      "//:proposed-security-policy",
      "//:proposed-review-index",
      "//:security#proposed-checks"
    ])
    expect(prepared.policies[1]?.payload.include.map(({ pattern }) => pattern)).toEqual(["//**/*"])
    expect(prepared.policies[1]?.snapshot?.map(({ path }) => path).sort()).toEqual(["PACKAGE.ts", "security.ts"])
    expect(prepared.policyChanges).toEqual([".smithers/target-index.json", "PACKAGE.ts", "security.ts"])
    const projection = prepared.policies.find(({ label }) => label === "//:proposed-review-index")?.snapshot
    expect(projection).toHaveLength(1)
    expect(projection?.[0]?.path).toBe(".smithers/target-index.json")
    expect(JSON.parse(projection?.[0]?.contents ?? "null")).toEqual({
      representation: "review-policy-changes",
      changes: [{ label: "//:security", before: policy("trusted rubric"), after: policy("candidate rubric") }]
    })
    expect(prepared.snapshot.map(({ path }) => path)).not.toContain(".smithers/target-index.json")
    expect(await Fs.stat(marker).then(() => true, () => false)).toBe(false)

    const plan = await run(options(root, trusted, candidate))
    if (!plan.planned) throw new Error("expected a planned review")
    expect(plan).toMatchObject({
      policyRevision: trusted,
      revision: candidate,
      planned: true,
      labels: ["//:security", "//:proposed-security-policy", "//:proposed-review-index", "//:security#proposed-checks"]
    })
    expect(plan.files).toContain("src/service.ts")
    expect(await Fs.stat(marker).then(() => true, () => false)).toBe(false)
  })

  it("includes changed declarations with glob metacharacters in the bounded policy review", async () => {
    const { root, trusted } = await fixture()
    const declarations = ["evil[1]/PACKAGE.ts", "evil{a,b}/PACKAGE.ts", "!x/security.ts", "#x/WORKSPACE.ts"]
    for (const path of declarations) await write(root, path, "export const candidatePolicy = true\n")
    git(root, "add", ".")
    git(root, "commit", "-qm", "add declarations with literal glob characters")
    const candidate = git(root, "rev-parse", "HEAD")

    const plan = await run(options(root, trusted, candidate))
    if (!plan.planned) throw new Error("expected a planned review")
    expect(plan.policyChanges).toEqual(declarations.slice().sort())
    expect(plan.files).toEqual(expect.arrayContaining(declarations))
    const prepared = await prepare(options(root, trusted, candidate))
    expect(
      prepared.policies.find(({ label }) => label === "//:proposed-security-policy")?.snapshot
        ?.map(({ path }) => path).sort()
    ).toEqual(declarations.slice().sort())
  })

  it("refuses malformed, abbreviated, and noncommit policy pins", async () => {
    const { root, trusted } = await fixture()
    const blob = git(root, "rev-parse", "HEAD:src/service.ts")
    await expect(prepare(options(root, trusted.slice(0, 12)))).rejects.toThrow("full trusted commit SHA")
    await expect(prepare(options(root, blob))).rejects.toThrow("Cannot read the pinned review revision")
    await expect(prepare(options(root, trusted, trusted.slice(0, 12)))).rejects.toThrow("full commit SHA")
  })

  it("refuses a selected symlink before any source can enter the review snapshot", async () => {
    const { root, trusted } = await fixture()
    await Fs.symlink("service.ts", NodePath.join(root, "src", "link.ts"))
    git(root, "add", "src/link.ts")
    git(root, "commit", "-qm", "candidate symlink")
    await expect(prepare(options(root, trusted))).rejects.toThrow("only regular files")
  })

  it("reviews a deleted source file from its trusted contents and reports the deletion", async () => {
    const { root, trusted } = await fixture()
    await Fs.rm(NodePath.join(root, "src", "service.ts"))
    git(root, "add", "-u")
    git(root, "commit", "-qm", "delete reviewed source")
    const candidate = git(root, "rev-parse", "HEAD")

    const prepared = await prepare(options(root, trusted, candidate))
    expect(prepared.snapshot.find(({ path }) => path === "src/service.ts")).toEqual({
      path: "src/service.ts",
      contents: "export const value = 'trusted'\n",
      changed: true,
      deleted: true
    })
    const receipt = await run(options(root, trusted, candidate))
    expect(receipt).toMatchObject({
      policyRevision: trusted,
      revision: candidate,
      files: ["src/service.ts"],
      deletedFiles: ["src/service.ts"],
      planned: true
    })
  })

  it("adds unchanged included callers and dependencies of changed source to the pinned snapshot", async () => {
    const { root } = await fixture()
    await write(root, "src/guard.ts", "export const guard = true\n")
    await write(root, "src/route.ts", "import { value } from \"./service.js\"\nexport const route = value\n")
    await write(root, "src/unrelated.ts", "export const unrelated = 1\n")
    await write(root, "lib/caller.ts", "import { value } from \"../src/service.ts\"\n")
    git(root, "add", ".")
    git(root, "commit", "-qm", "trusted neighbours")
    const trusted = git(root, "rev-parse", "HEAD")
    await write(root, "src/service.ts", "import { guard } from \"./guard.ts\"\nexport const value = guard\n")
    git(root, "add", ".")
    git(root, "commit", "-qm", "candidate source")
    const candidate = git(root, "rev-parse", "HEAD")
    await write(root, "src/guard.ts", "export const guard = 'dirty worktree'\n")

    const prepared = await prepare(options(root, trusted, candidate))
    expect(prepared.snapshot.map(({ path, changed }) => [path, changed]).sort()).toEqual([
      ["src/guard.ts", false],
      ["src/route.ts", false],
      ["src/service.ts", true]
    ])
    expect(prepared.snapshot.find(({ path }) => path === "src/guard.ts")?.contents).toBe("export const guard = true\n")
  })

  it("reviews every file a changed check governs with the proposed checks on the trusted engine", async () => {
    const { root, trusted } = await fixture()
    await write(root, ".smithers/target-index.json", index(policy("stricter rubric")))
    git(root, "add", ".")
    git(root, "commit", "-qm", "policy-only change")
    const candidate = git(root, "rev-parse", "HEAD")
    const prepared = await prepare(options(root, trusted, candidate))
    const proposed = prepared.policies.find(({ label }) => label === "//:security#proposed-checks")!
    const active = prepared.policies.find(({ label }) => label === "//:security")!
    expect(proposed.payload).toMatchObject({
      rubric: "stricter rubric",
      scope: "all",
      engine: active.payload.engine,
      model: active.payload.model
    })
    expect(active.payload.rubric).toBe("trusted rubric")
    // No source changed, yet the governed source is selected for the changed check.
    expect(proposed.snapshot?.find(({ path }) => path === "src/service.ts")).toMatchObject({ changed: false })

    const added = await fixture()
    await write(
      added.root,
      ".smithers/target-index.json",
      JSON.stringify([
        row("//:security", policy("trusted rubric")),
        row("//:audit", policy("new audit rubric")),
        row("//:manual", policy("manual rubric", true))
      ])
    )
    git(added.root, "add", ".")
    git(added.root, "commit", "-qm", "new review targets")
    const next = await prepare(options(added.root, added.trusted, git(added.root, "rev-parse", "HEAD")))
    expect(next.policies.find(({ label }) => label === "//:audit#proposed-checks")?.payload).toMatchObject({
      rubric: "new audit rubric",
      engine: "claude",
      model: "claude-opus-5-5"
    })
    expect(next.policies.map(({ label }) => label)).not.toContain("//:manual#proposed-checks")

    // A proposed policy cannot widen what reaches the provider beyond the trusted scope.
    const widened = await fixture()
    await write(widened.root, "private/notes.md", "private roadmap\n")
    git(widened.root, "add", ".")
    git(widened.root, "commit", "-qm", "private notes")
    const base = git(widened.root, "rev-parse", "HEAD")
    const wide = JSON.parse(policy("wide rubric")) as Record<string, unknown>
    await write(
      widened.root,
      ".smithers/target-index.json",
      JSON.stringify([
        row("//:security", JSON.stringify({ ...wide, include: [{ _tag: "Glob", pattern: "//**/*", exclude: [] }] }))
      ])
    )
    git(widened.root, "add", ".")
    git(widened.root, "commit", "-qm", "widen the policy")
    const limited = await prepare(options(widened.root, base, git(widened.root, "rev-parse", "HEAD")))
    const proposedFiles = limited.policies.find(({ label }) => label === "//:security#proposed-checks")?.snapshot
    expect(proposedFiles?.map(({ path }) => path)).toEqual(["src/service.ts"])
    expect(limited.snapshot.map(({ path }) => path)).not.toContain("private/notes.md")
  })

  it("pins a proposed-check review to the trusted budget and requirement", async () => {
    const trustedPolicy = JSON.parse(policy("trusted rubric")) as Record<string, unknown>
    const { root, trusted } = await fixture(
      JSON.stringify({ ...trustedPolicy, required: true, budget: { modelCalls: 3, wallMs: 60_000 } })
    )
    // The candidate lifts the cap, drops the requirement and shrinks the batches.
    await write(
      root,
      ".smithers/target-index.json",
      index(JSON.stringify({ ...JSON.parse(policy("looser rubric")), budget: { modelCalls: 5_000 } }))
    )
    git(root, "add", ".")
    git(root, "commit", "-qm", "lift the review budget")
    const prepared = await prepare(options(root, trusted, git(root, "rev-parse", "HEAD")))
    const proposed = prepared.policies.find(({ label }) => label === "//:security#proposed-checks")!
    expect(proposed.payload).toMatchObject({
      rubric: "looser rubric",
      required: true,
      budget: { modelCalls: 3, wallMs: 60_000 }
    })

    // A proposed target with no trusted counterpart runs under the trusted default budget, never its own.
    const added = await fixture()
    await write(
      added.root,
      ".smithers/target-index.json",
      JSON.stringify([
        row("//:security", policy("trusted rubric")),
        row("//:audit", JSON.stringify({ ...JSON.parse(policy("new rubric")), budget: { modelCalls: 5_000 } }))
      ])
    )
    git(added.root, "add", ".")
    git(added.root, "commit", "-qm", "new review target with its own budget")
    const next = await prepare(options(added.root, added.trusted, git(added.root, "rev-parse", "HEAD")))
    const audit = next.policies.find(({ label }) => label === "//:audit#proposed-checks")!.payload as object
    expect(audit).toMatchObject({ budget: defaultProposedBudget })
    expect(defaultProposedBudget).toEqual({ modelCalls: 128, promptTokens: 8_000_000, wallMs: 1_800_000 })
    expect(Object.hasOwn(audit, "required")).toBe(false)
  })

  it("masks credential-bearing paths in the receipt", async () => {
    const { root } = await fixture()
    const token = `ghp_${"P".repeat(36)}`
    await write(root, `src/${token}.ts`, "export const leaked = 1\n")
    git(root, "add", ".")
    git(root, "commit", "-qm", "credential file name")
    const trusted = git(root, "rev-parse", "HEAD")
    git(root, "rm", "-q", `src/${token}.ts`)
    git(root, "commit", "-qm", "remove it")
    const plan = await run(options(root, trusted, git(root, "rev-parse", "HEAD")))
    if (!plan.planned) throw new Error("expected a planned review")
    expect(plan.deletedFiles).toEqual(["src/<credential:github-token:1>.ts"])
    expect(JSON.stringify(plan)).not.toContain(token)
  })

  it("fails closed when the trusted index omits review policy data", async () => {
    const { root, trusted } = await fixture(null)
    await expect(prepare(options(root, trusted))).rejects.toThrow("Trusted revision has no review policy")
  })

  it.each(["duplicate", "inconsistent"] as const)(
    "refuses %s labels in trusted and proposed indexes",
    async (caseName) => {
      const malformed = caseName === "duplicate" ?
        JSON.stringify([row("//:security", policy("first")), row("//:security", policy("second"))]) :
        JSON.stringify([{ ...row("//:security", policy("first")), name: "other" }])

      const trustedFixture = await fixture()
      await write(trustedFixture.root, ".smithers/target-index.json", malformed)
      git(trustedFixture.root, "add", ".smithers/target-index.json")
      git(trustedFixture.root, "commit", "-qm", "malformed trusted index")
      await expect(prepare(options(trustedFixture.root, git(trustedFixture.root, "rev-parse", "HEAD"))))
        .rejects.toThrow("duplicate or inconsistent labels")

      const proposedFixture = await fixture()
      await write(proposedFixture.root, ".smithers/target-index.json", malformed)
      git(proposedFixture.root, "add", ".smithers/target-index.json")
      git(proposedFixture.root, "commit", "-qm", "malformed proposed index")
      await expect(prepare(options(proposedFixture.root, proposedFixture.trusted)))
        .rejects.toThrow("duplicate or inconsistent labels")
    }
  )

  it("represents a removed review row as a deletion while retaining its pinned policy", async () => {
    const { root, trusted } = await fixture()
    await write(root, ".smithers/target-index.json", "[]\n")
    git(root, "add", ".smithers/target-index.json")
    git(root, "commit", "-qm", "remove review row")
    const prepared = await prepare(options(root, trusted))
    expect(prepared.policies.find(({ label }) => label === "//:security")?.payload.rubric).toBe("trusted rubric")
    const projection = prepared.policies.find(({ label }) => label === "//:proposed-review-index")?.snapshot
    expect(JSON.parse(projection?.[0]?.contents ?? "null")).toEqual({
      representation: "review-policy-changes",
      changes: [{ label: "//:security", before: policy("trusted rubric"), after: null }]
    })
  })

  it("ignores Git replacement refs when reading the pinned policy commit", async () => {
    const { root, trusted } = await fixture()
    await write(root, ".smithers/target-index.json", index(policy("replacement rubric")))
    git(root, "add", ".smithers/target-index.json")
    git(root, "commit", "-qm", "replacement commit")
    const replacement = git(root, "rev-parse", "HEAD")
    git(root, "replace", trusted, replacement)
    expect(git(root, "show", `${trusted}:.smithers/target-index.json`)).toContain("replacement rubric")
    const prepared = await prepare(options(root, trusted))
    expect(prepared.policies.find(({ label }) => label === "//:security")?.payload.rubric).toBe("trusted rubric")
  })

  it("selects manual audits only when explicitly named within their package", async () => {
    const { root, trusted } = await fixture()
    await write(
      root,
      ".smithers/target-index.json",
      JSON.stringify([
        row("//:security", policy("root rubric")),
        row("//pkg:securityAudit", policy("package audit", true))
      ])
    )
    git(root, "add", ".smithers/target-index.json")
    git(root, "commit", "-qm", "approved manual audit")
    const approved = git(root, "rev-parse", "HEAD")
    expect((await prepare(options(root, approved))).policies.map(({ label }) => label)).toEqual(["//:security"])
    expect((await prepare({ ...options(root, approved), patterns: ["//pkg/...:securityAudit"] }))
      .policies.map(({ label }) => label)).toEqual(["//pkg:securityAudit"])
    expect(trusted).not.toBe(approved)
  })

  it("serves review --plan from the CLI without executing candidate declarations", async () => {
    const { root, trusted } = await fixture()
    const marker = NodePath.join(root, "cli-candidate-executed")
    await write(
      root,
      "PACKAGE.ts",
      `import { writeFileSync } from "node:fs"\nwriteFileSync(${
        JSON.stringify(marker)
      }, "executed")\nthrow new Error("candidate declaration ran")\n`
    )
    await write(root, "src/service.ts", "export const value = 'candidate'\n")
    git(root, "add", ".")
    git(root, "commit", "-qm", "candidate")
    const result = await serve(root, ["review", "//...", "--plan", "--policy-revision", trusted])
    expect(result.exitCode, result.logs).toBe(0)
    expect(result.output).toContain(trusted)
    expect(result.output).toContain("//:security")
    expect(result.output).toContain("src/service.ts")
    expect(await Fs.stat(marker).then(() => true, () => false)).toBe(false)
  })

  it("refuses a CLI review with no trusted policy revision before loading candidate declarations", async () => {
    const { root } = await fixture()
    const marker = NodePath.join(root, "unpinned-candidate-executed")
    await write(
      root,
      "PACKAGE.ts",
      `import { writeFileSync } from "node:fs"\nwriteFileSync(${
        JSON.stringify(marker)
      }, "executed")\nthrow new Error("candidate declaration ran")\n`
    )

    const result = await serve(root, ["review", "//...", "--plan"])
    expect(result.exitCode).toBe(1)
    expect(result.output + result.logs).toMatch(/policyRevision|policy-revision/)
    expect(await Fs.stat(marker).then(() => true, () => false)).toBe(false)
  })

  it("passes an empty optional selection but fails it when the review is required", async () => {
    const { root, trusted } = await fixture()
    const optional = await run({ ...options(root, trusted), plan: false })
    if (optional.planned) throw new Error("expected executed reviews")
    expect(optional).toMatchObject({ ok: true, required: false, reviews: [{ label: "//:security", files: [] }] })
    const prepared = await prepare({ ...options(root, trusted), required: true })
    expect(prepared.policies.every(({ payload }) => payload.required === true)).toBe(true)
    const result = await serve(root, ["review", "//...", "--policy-revision", trusted, "--required"])
    const receipt = result.output + result.logs
    expect(result.exitCode, receipt).toBe(1)
    expect(receipt).toContain("Required review selected no files")
  })

  it("returns a failed review receipt when the required provider key is absent", async () => {
    const { root, trusted } = await fixture()
    await write(root, "src/service.ts", "export const value = 'candidate'\n")
    git(root, "add", "src/service.ts")
    git(root, "commit", "-qm", "source to review")
    const candidate = git(root, "rev-parse", "HEAD")
    const previousAnthropic = process.env["ANTHROPIC_API_KEY"]
    const previousOpenai = process.env["OPENAI_API_KEY"]
    let result: Awaited<ReturnType<typeof serve>>
    try {
      delete process.env["ANTHROPIC_API_KEY"]
      delete process.env["OPENAI_API_KEY"]
      result = await serve(root, ["review", "//...", "--policy-revision", trusted, "--revision", candidate])
    } finally {
      if (previousAnthropic === undefined) delete process.env["ANTHROPIC_API_KEY"]
      else process.env["ANTHROPIC_API_KEY"] = previousAnthropic
      if (previousOpenai === undefined) delete process.env["OPENAI_API_KEY"]
      else process.env["OPENAI_API_KEY"] = previousOpenai
    }

    const receipt = result.output + result.logs
    expect(result.exitCode, receipt).toBe(1)
    expect(receipt).toContain(trusted)
    expect(receipt).toContain(candidate)
    expect(receipt).toContain("//:security")
    expect(receipt).toContain("ANTHROPIC_API_KEY")
    expect(receipt).not.toContain("skipped")
    // The failed run persists in the private default store inside the Git directory.
    const store = NodePath.join(await Fs.realpath(NodePath.join(root, ".git")), "smithers", "review-findings")
    expect(receipt).toContain(store)
    const [run] = await Fs.readdir(NodePath.join(store, "runs"))
    const record = JSON.parse(await Fs.readFile(NodePath.join(store, "runs", run!), "utf8")) as {
      status: string
      owner: string
    }
    expect(record).toMatchObject({ status: "failed", owner: "//:security" })
    expect((await Fs.stat(store)).mode & 0o777).toBe(0o700)
  })
})

/** Immutable revisions held in memory: a host's source that is not a Git repository. */
const memorySource = (revisions: Record<string, Record<string, string>>, symlinks: ReadonlyArray<string> = []) => {
  const reads: Array<string> = []
  const source: ReviewSource = {
    tree: async (revision) =>
      new Map(
        Object.entries(revisions[revision]!).map(([path, contents]): [string, SourceEntry] => [
          path,
          { id: `${symlinks.includes(path) ? "link" : "file"}:${contents}`, regular: !symlinks.includes(path) }
        ])
      ),
    read: async (revision, path) => {
      reads.push(`${revision}:${path}`)
      return revisions[revision]![path]!
    },
    grep: async (revision, patterns, candidate) =>
      Object.entries(revisions[revision]!).filter(([path, contents]) =>
        candidate(path) && patterns.some((pattern) => new RegExp(pattern).test(contents))
      ).map(([path]) => path)
  }
  return { source, reads }
}

const trustedFiles: Record<string, string> = {
  "PACKAGE.ts": "export const Package = 1\n",
  "src/service.ts": "export const value = 'trusted'\n",
  "src/removed.ts": "export const guard = true\n",
  "src/caller.ts": "import { value } from \"./service.ts\"\nexport const caller = value\n",
  "src/unrelated.ts": "export const unrelated = 1\n",
  "docs/readme.md": "unreviewed\n",
  ".smithers/target-index.json": index(policy("trusted rubric"))
}
const { "src/removed.ts": _removed, ...kept } = trustedFiles
const headFiles: Record<string, string> = {
  ...kept,
  "src/service.ts": "export const value = 'candidate'\n",
  "docs/readme.md": "changed but ungoverned\n"
}

/** A scripted seat that answers each review request with `answer` and records the seats it served. */
const seat =
  (answer: (prompt: string) => string, seats: Array<LlmLint.ReviewSeat>): LlmLint.ReviewTransport => (requested) =>
    Effect.succeed({
      modelId: requested.model,
      model: {
        stream: (request) =>
          Stream.suspend(() => {
            seats.push(requested)
            const prompt = request.messages.flatMap((message) =>
              message.content.flatMap((part) => part.type === "text" ? [part.text] : [])
            ).join("\n")
            return Stream.fromIterable([
              { type: "text-delta" as const, id: "t", text: answer(prompt) },
              { type: "settle" as const, stopReason: "stop" as const }
            ])
          })
      }
    })

describe("TrustedReview on another host's immutable source", () => {
  const all = [Label.parse("//...", "")]

  it("selects trusted policy, changed and deleted source and their callers without Git", async () => {
    const { source, reads } = memorySource({ base: trustedFiles, head: headFiles })
    const prepared = await prepareSource(source, { policyRevision: "base", revision: "head", patterns: all })
    expect(prepared.policies.map(({ label, payload }) => [label, payload.rubric, payload.base])).toEqual([
      ["//:security", "trusted rubric", "base"]
    ])
    expect(prepared.policyChanges).toEqual([])
    expect(prepared.changed).toEqual(["docs/readme.md", "src/removed.ts", "src/service.ts"])
    expect(governing(prepared).policies.map(({ label }) => label)).toEqual(["//:security"])
    expect(prepared.snapshot).toEqual([
      { path: "src/service.ts", contents: "export const value = 'candidate'\n", changed: true },
      { path: "src/removed.ts", contents: "export const guard = true\n", changed: true, deleted: true },
      { path: "src/caller.ts", contents: trustedFiles["src/caller.ts"], changed: false }
    ])
    // Only the trusted index and selected source are read; the removed file from the trusted revision.
    expect(reads.sort()).toEqual([
      "base:.smithers/target-index.json",
      "base:src/removed.ts",
      "head:src/caller.ts",
      "head:src/service.ts"
    ])
  })

  it("keeps only the policies that govern a changed file", async () => {
    const { source } = memorySource({
      base: trustedFiles,
      head: { ...trustedFiles, "docs/readme.md": "only documentation changed\n" }
    })
    const prepared = await prepareSource(source, { policyRevision: "base", revision: "head", patterns: all })
    expect(prepared.changed).toEqual(["docs/readme.md"])
    expect(prepared.policies.map(({ label }) => label)).toEqual(["//:security"])
    expect(governing(prepared).policies).toEqual([])
    const audit = await prepareSource(memorySource({ base: trustedFiles, head: trustedFiles }).source, {
      policyRevision: "base",
      revision: "head",
      patterns: all
    })
    expect(audit.changed).toEqual([])
    expect(governing(audit).policies).toEqual([])
  })

  it("marks every selected review required and refuses a selected non-regular entry", async () => {
    const { source } = memorySource({ base: trustedFiles, head: headFiles })
    const required = await prepareSource(source, {
      policyRevision: "base",
      revision: "head",
      patterns: all,
      required: true
    })
    expect(required.policies.every(({ payload }) => payload.required === true)).toBe(true)
    const linked = memorySource({ base: trustedFiles, head: headFiles }, ["src/service.ts"])
    await expect(prepareSource(linked.source, { policyRevision: "base", revision: "head", patterns: all }))
      .rejects.toThrow("only regular files")
    const unusable = memorySource({ base: trustedFiles, head: { ...headFiles, "src/bell\u0007.ts": "x\n" } })
    await expect(prepareSource(unusable.source, { policyRevision: "base", revision: "head", patterns: all }))
      .rejects.toThrow("Invalid review snapshot path")
  })

  it("refuses a trusted revision without a target index", async () => {
    const { ".smithers/target-index.json": _index, ...bare } = trustedFiles
    const { source } = memorySource({ base: bare, head: headFiles })
    await expect(prepareSource(source, { policyRevision: "base", revision: "head", patterns: all }))
      .rejects.toThrow("The pinned review revision has no target index")
  })

  it("reviews through a host seat and returns only public summaries of stored findings", async () => {
    const { source } = memorySource({ base: trustedFiles, head: headFiles })
    const prepared = await prepareSource(source, { policyRevision: "base", revision: "head", patterns: all })
    const root = await Fs.realpath(await Fs.mkdtemp(NodePath.join(Os.tmpdir(), "smithers-seat-review-")))
    const store = await Fs.mkdtemp(NodePath.join(Os.tmpdir(), "smithers-seat-store-"))
    temporaryDirectories.push(root, store)
    const seats: Array<LlmLint.ReviewSeat> = []
    const secret = "the guard removal lets any caller skip authorization"
    const result = await reviewPrepared(prepared, {
      root,
      findingsStore: store,
      transport: seat(
        (prompt) =>
          prompt.includes("CHANGED FILE: \"src/removed.ts\"")
            ? JSON.stringify([{ file: "src/removed.ts", line: 1, severity: "error", message: secret }])
            : "[]",
        seats
      )
    })
    expect(seats.length).toBeGreaterThan(0)
    expect(seats.every(({ model }) => model === "review-test-model")).toBe(true)
    expect(result.ok).toBe(false)
    const [review] = result.reviews
    expect(review).toMatchObject({ label: "//:security", status: "failed" })
    expect(JSON.stringify(result)).not.toContain(secret)
    const stored = await Effect.runPromise(LlmLint.storedFindings(store))
    expect(stored.map(({ finding }) => finding.message)).toEqual([secret])
    expect(review && "error" in review ? review.error : undefined).toMatchObject({
      findings: [{
        fingerprint: stored[0]!.fingerprint,
        reference: `restricted-finding:${stored[0]!.fingerprint}`,
        state: "open",
        severity: "error",
        owner: "//:security"
      }]
    })

    const aborted = new AbortController()
    aborted.abort()
    const unasked: Array<LlmLint.ReviewSeat> = []
    await expect(
      reviewPrepared(prepared, {
        root,
        findingsStore: store,
        transport: seat(() => "[]", unasked),
        signal: aborted.signal
      })
    ).rejects.toThrow()
    expect(unasked).toEqual([])
    // Aborting during a model request interrupts it; no later review starts.
    const running = new AbortController()
    const hung: Array<LlmLint.ReviewSeat> = []
    const hanging: LlmLint.ReviewTransport = (requested) =>
      Effect.succeed({
        modelId: requested.model,
        model: {
          stream: () =>
            Stream.suspend(() => {
              hung.push(requested)
              running.abort()
              return Stream.never
            })
        }
      })
    await expect(reviewPrepared(prepared, { root, findingsStore: store, transport: hanging, signal: running.signal }))
      .rejects.toThrow()
    expect(hung).toHaveLength(1)

    const clean = await reviewPrepared(prepared, { root, findingsStore: store, transport: seat(() => "[]", []) })
    expect(clean).toMatchObject({ ok: true, reviews: [{ label: "//:security", status: "completed", findings: [] }] })
  })
})

const credential = "Zk9vQmFyQmF6UXV4UXV1eENvcmdlR3JhdWx0"
const leak = `export const REPOHOST_TOKEN = "${credential}"\n`

/** A receiver that records its argv and stdin, writes detail to both pipes, and exits with `code`. */
const receiver = async (code: number) => {
  const directory = await Fs.realpath(await Fs.mkdtemp(NodePath.join(Os.tmpdir(), "smithers-credential-receiver-")))
  temporaryDirectories.push(directory)
  const path = NodePath.join(directory, "receiver.mjs")
  const record = NodePath.join(directory, "deliveries.jsonl")
  await Fs.writeFile(
    path,
    "#!/usr/bin/env node\nimport { appendFileSync } from \"node:fs\"\nlet stdin = \"\"\n" +
      "for await (const chunk of process.stdin) stdin += chunk\n" +
      `appendFileSync(${JSON.stringify(record)}, JSON.stringify({ argv: process.argv.slice(2), stdin }) + "\\n")\n` +
      "process.stdout.write(\"receiver stdout detail\\n\")\nprocess.stderr.write(\"receiver stderr detail\\n\")\n" +
      `process.exitCode = ${code}\n`
  )
  await Fs.chmod(path, 0o755)
  return {
    path,
    record,
    deliveries: async (): Promise<Array<{ argv: Array<string>; stdin: string }>> =>
      (await Fs.readFile(record, "utf8").catch(() => "")).split("\n").filter((line) => line !== "").map((line) =>
        JSON.parse(line)
      )
  }
}

describe("TrustedReview credential receiver", () => {
  const all = [Label.parse("//...", "")]
  const base = "a".repeat(40)
  const head = "b".repeat(40)
  const leaked = async () => {
    const { source } = memorySource({ [base]: trustedFiles, [head]: { ...headFiles, "src/service.ts": leak } })
    const prepared = await prepareSource(source, { policyRevision: base, revision: head, patterns: all })
    const root = await Fs.realpath(await Fs.mkdtemp(NodePath.join(Os.tmpdir(), "smithers-receiver-review-")))
    const store = await Fs.mkdtemp(NodePath.join(Os.tmpdir(), "smithers-receiver-store-"))
    temporaryDirectories.push(root, store)
    return { prepared, root, store }
  }

  it("delivers the revision and each discovery's name and location on stdin before inference", async () => {
    const { prepared, root, store } = await leaked()
    const target = await receiver(0)
    const deliveredFirst: Array<boolean> = []
    const result = await reviewPrepared(prepared, {
      root,
      findingsStore: store,
      credentialReceiver: target.path,
      transport: seat(() => {
        deliveredFirst.push(existsSync(target.record))
        return "[]"
      }, [])
    })
    const deliveries = await target.deliveries()
    expect(deliveries).toHaveLength(1)
    expect(deliveries[0]!.argv).toEqual([])
    const document = JSON.parse(deliveries[0]!.stdin) as unknown
    expect(document).toEqual({
      revision: head,
      discoveries: [{ file: "src/service.ts", line: 1, name: "REPOHOST_TOKEN" }]
    })
    expect(Schema.decodeUnknownSync(LlmLint.CredentialDelivery)(document, { onExcessProperty: "error" })).toEqual(
      document
    )
    expect(deliveries[0]!.stdin).not.toContain(credential)
    expect(deliveredFirst.length).toBeGreaterThan(0)
    expect(deliveredFirst.every(Boolean)).toBe(true)
    // The discovery is still a blocking finding; delivery does not replace the review.
    expect(result.reviews[0]).toMatchObject({ label: "//:security", status: "failed" })
    const receipt = JSON.stringify(result)
    expect(receipt).not.toContain("Private credential rotation delivery failed")
    for (const text of [credential, "receiver stdout detail", "receiver stderr detail"]) {
      expect(receipt).not.toContain(text)
    }
  })

  it("fails the review on a nonzero receiver exit before inference, without the receiver's output", async () => {
    const { prepared, root, store } = await leaked()
    const target = await receiver(3)
    const seats: Array<LlmLint.ReviewSeat> = []
    const result = await reviewPrepared(prepared, {
      root,
      findingsStore: store,
      credentialReceiver: target.path,
      transport: seat(() => "[]", seats)
    })
    expect(await target.deliveries()).toHaveLength(1)
    expect(seats).toEqual([])
    expect(result).toMatchObject({
      ok: false,
      reviews: [{
        label: "//:security",
        status: "failed",
        error: { phase: "review", message: "Private credential rotation delivery failed" }
      }]
    })
    const receipt = JSON.stringify(result)
    for (const text of [credential, "receiver stdout detail", "receiver stderr detail", "exited 3"]) {
      expect(receipt).not.toContain(text)
    }
  })

  it("does not start the receiver when the review discovers no credential", async () => {
    const { source } = memorySource({ [base]: trustedFiles, [head]: headFiles })
    const prepared = await prepareSource(source, { policyRevision: base, revision: head, patterns: all })
    const { root, store } = await leaked()
    const target = await receiver(0)
    const result = await reviewPrepared(prepared, {
      root,
      findingsStore: store,
      credentialReceiver: target.path,
      transport: seat(() => "[]", [])
    })
    expect(result.ok).toBe(true)
    expect(await target.deliveries()).toEqual([])
  })

  it("refuses a receiver that is not an absolute executable file before reviewing", async () => {
    const { root, trusted } = await fixture()
    await write(root, "notes.txt", "not executable\n")
    for (const credentialReceiver of ["receiver.mjs", NodePath.join(root, "notes.txt"), NodePath.join(root, "src")]) {
      await expect(run({ ...options(root, trusted), plan: false, credentialReceiver })).rejects.toThrow(
        "--credential-receiver must be an absolute path to an executable file"
      )
    }
  })

  it("serves review --credential-receiver and fails the command when the receiver fails", async () => {
    const { root, trusted } = await fixture()
    await write(root, "src/service.ts", leak)
    git(root, "add", "src/service.ts")
    git(root, "commit", "-qm", "leak a credential")
    const candidate = git(root, "rev-parse", "HEAD")
    const target = await receiver(7)
    const previousAnthropic = process.env["ANTHROPIC_API_KEY"]
    let result: Awaited<ReturnType<typeof serve>>
    try {
      // No provider key: if delivery did not stop the review, inference would fail instead of calling out.
      delete process.env["ANTHROPIC_API_KEY"]
      result = await serve(root, [
        "review",
        "//...",
        "--policy-revision",
        trusted,
        "--revision",
        candidate,
        "--credential-receiver",
        target.path
      ])
    } finally {
      if (previousAnthropic === undefined) delete process.env["ANTHROPIC_API_KEY"]
      else process.env["ANTHROPIC_API_KEY"] = previousAnthropic
    }
    const receipt = result.output + result.logs
    expect(result.exitCode, receipt).toBe(1)
    expect(receipt).toContain("Private credential rotation delivery failed")
    expect(receipt).not.toContain("ANTHROPIC_API_KEY")
    for (const text of [credential, "receiver stdout detail", "receiver stderr detail"]) {
      expect(receipt).not.toContain(text)
    }
    const deliveries = await target.deliveries()
    expect(deliveries.map(({ argv, stdin }) => ({ argv, document: JSON.parse(stdin) as unknown }))).toEqual([{
      argv: [],
      document: { revision: candidate, discoveries: [{ file: "src/service.ts", line: 1, name: "REPOHOST_TOKEN" }] }
    }])
  })
})
