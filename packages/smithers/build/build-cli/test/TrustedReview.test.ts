import * as Input from "@smthrs/targets/Input"
import * as LlmLint from "@smthrs/targets/LlmLint"
import * as Target from "@smthrs/targets/Target"
import { execFileSync } from "node:child_process"
import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as NodePath from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import { prepare, run } from "../src/TrustedReview.ts"
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
      "//:proposed-review-index"
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
    expect(plan).toMatchObject({
      policyRevision: trusted,
      revision: candidate,
      planned: true,
      labels: ["//:security", "//:proposed-security-policy", "//:proposed-review-index"]
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
  })
})
