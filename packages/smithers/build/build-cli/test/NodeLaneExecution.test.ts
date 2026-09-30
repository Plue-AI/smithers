import * as NodeChildProcess from "node:child_process"
import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as NodePath from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import { serve } from "./helpers/ServeCli.ts"
import { write } from "./helpers/WriteFile.ts"

const temporaryDirectories: Array<string> = []
afterAll(async () => {
  await Promise.all(temporaryDirectories.map((directory) => Fs.rm(directory, { recursive: true, force: true })))
})

const workspace = `import { Smithers as S } from "@smthrs/targets"
const packageJson = S.file("//package.json")
export const Workspace = S.Workspace("node-lane", {
  repository: "git+https://example.invalid/node-lane.git",
  cache: S.Cache({ directory: ".flows" }),
  runtime: S.Runtime.Node({ version: ">=26.4.0" }),
  packageManager: S.PackageManager.Pnpm({ manifest: packageJson, lockfile: S.file("//pnpm-lock.yaml") }),
  nodeModules: S.Npm.NodeModules({ packageJson }),
  host: S.Host({ bins: ["git"] }),
})
`

const packageModule = `import { Smithers as S } from "@smthrs/targets"
const manifest = S.file("//package.json")
const gate = S.Shell.Test({ shell: "true" })
const pack = S.Npm.Pack({ manifest, data: [S.file("//input.txt")] })
const literal = S.Literal({ path: "out/literal.txt", content: "literal" })
const copy = S.Copy({ from: S.file("//input.txt"), to: "out/copied.txt" })
const markdown = S.Markdown.CodeBlocks({ file: S.file("//README.md"), lang: ["ts"] })
const version = S.Changesets.Version({ config: S.file("//changeset.json"), changes: ["version.txt"] })
const size = S.Size.Budgets({ manifest })
const digestBuild = S.Shell.Build({ shell: "mkdir -p digest && printf hi > digest/a.txt", outDirs: ["digest"] })
const digest = S.Test({ expect: S.Files.digest(digestBuild), toBe: S.file("//digest-baseline.json") })
const cron = S.Cron({ schedule: "0 6 * * 1", run: [gate] })
const ci = S.Github.Ci({
  workflows: { test: { on: { pullRequest: true }, run: gate } },
  changes: [".github/workflows/**"]
})
const overlayBase = S.Filegroup({ srcs: [S.file("//overlay/base.txt")] })
const overlay = S.Overlay({ base: overlayBase, replace: { "overlay/base.txt": S.file("//overlay/replacement.txt") } })
const overlayBuild = S.Shell.Build({
  shell: "mkdir -p overlay-out && cp overlay/base.txt overlay-out/result.txt",
  data: [overlay],
  outDirs: ["overlay-out"]
})
const overlayConflict = S.Overlay({
  base: overlayBase,
  replace: { "overlay/base.txt": S.file("//input.txt") }
})
const overlayConflictBuild = S.Shell.Build({
  shell: "mkdir -p conflict-out && cp overlay/base.txt conflict-out/result.txt",
  data: [overlay, overlayConflict],
  outDirs: ["conflict-out"]
})
// Takes the overlay build's outputs, not its inputs: the substitution stays
// private to the build, so this consumer must see the real source bytes.
const overlayOutputs = S.Filegroup({ srcs: [overlayBuild] })
const overlayDownstream = S.Shell.Test({
  shell: "grep -qx base overlay/base.txt && grep -qx replacement overlay-out/result.txt",
  data: [overlayOutputs]
})
// A rule with no overlay scratch mount: the substitution cannot be honoured,
// so the target is refused rather than run against the unreplaced sources.
const overlayPack = S.Npm.Pack({ manifest, data: [overlay] })
const downstream = S.Npm.Downstream({
  repository: "https://example.invalid/repo",
  overrides: { fixture: literal },
  run: ["test"]
})
const publishMissing = S.Npm.Publish({ pack, gates: [gate] })
const publishApproval = S.Npm.Publish({
  pack,
  gates: [gate],
  secrets: [S.HttpSecret(S.Secret("NPM_TOKEN"), ["https://registry.npmjs.org"])],
  approval: "required"
})
const pages = S.Github.Pages({
  site: literal,
  secrets: [S.HttpSecret(S.Secret("GITHUB_TOKEN"), ["https://api.github.com"])]
})
const pr = S.Git.Pr({
  gates: [gate],
  secrets: [S.HttpSecret(S.Secret("GITHUB_TOKEN"), ["https://api.github.com"])]
})
const githubPr = S.Github.Pr({
  gates: [gate],
  secrets: [S.HttpSecret(S.Secret("GITHUB_TOKEN"), ["https://api.github.com"])]
})
const release = S.Github.Release({
  manifest,
  notes: "notes",
  gates: [gate],
  secrets: [S.HttpSecret(S.Secret("GITHUB_TOKEN"), ["https://api.github.com"])]
})
const changesetsPublish = S.Changesets.Publish({
  config: S.file("//changeset.json"),
  pack,
  gates: [gate],
  secrets: [S.HttpSecret(S.Secret("NPM_TOKEN"), ["https://registry.npmjs.org"])]
})
export const Package = S.Package({ targets: {
  changesetsPublish, githubPr, release, ci, copy, cron, digest, digestBuild, downstream, gate, literal, markdown, overlay, overlayBuild,
  overlayConflictBuild, overlayDownstream, overlayPack, pack, pages, pr,
  publishApproval, publishMissing, size, version
} })
`

const fixture = async (): Promise<string> => {
  const root = await Fs.mkdtemp(NodePath.join(Os.tmpdir(), "smthrs-node-lane-"))
  temporaryDirectories.push(root)
  await write(root, "WORKSPACE.ts", workspace)
  await write(root, "PACKAGE.ts", packageModule)
  await write(
    root,
    "package.json",
    JSON.stringify({
      name: "node-lane-fixture",
      version: "1.0.0",
      packageManager: "pnpm@11.25.0",
      files: ["input.txt"]
    })
  )
  // This manifest has no dependencies. Declare its complete lockfile without
  // launching a package-manager shim merely to generate the empty importer.
  await write(
    root,
    "pnpm-lock.yaml",
    "lockfileVersion: '9.0'\nsettings:\n  autoInstallPeers: true\n  excludeLinksFromLockfile: false\nimporters:\n  .: {}\n"
  )
  await write(root, "input.txt", "input")
  await write(root, "overlay/base.txt", "base")
  await write(root, "overlay/replacement.txt", "replacement")
  await write(root, "README.md", "```ts\nconst answer: number = 42\n```\n")
  await write(
    root,
    "docs/PACKAGE.ts",
    `import { Smithers as S } from "@smthrs/targets"
const markdown = S.Markdown.CodeBlocks({ file: S.file("README.md"), lang: ["ts"] })
const tutorial = S.Markdown.CodeBlocks({ file: S.file("tutorial.md"), lang: ["ts"], context: [S.file("engine.md")] })
export const Package = S.Package({ targets: { markdown, tutorial } })
`
  )
  await write(
    root,
    "docs/README.md",
    "```ts\nimport { answer } from \"docs-fixture\"\nexport const twice: number = answer * 2\n```\n"
  )
  // A tutorial page: one file grown across two titled fences, a fragment the
  // lane skips, and a second titled file in a subdirectory that imports the
  // first and a file the context page declares.
  await write(
    root,
    "docs/tutorial.md",
    [
      "```ts title=\"greeting.ts\"",
      "import { answer } from \"docs-fixture\"",
      "export const greet = answer",
      "```",
      "```ts fragment",
      "    return greet",
      "```",
      "```ts title=\"greeting.ts\"",
      "export const twice = greet * 2",
      "```",
      "```ts title=\"src/run.ts\"",
      "import { engine } from \"../engine.ts\"",
      "import { twice } from \"../greeting.ts\"",
      "console.log(twice, engine)",
      "```",
      ""
    ].join("\n")
  )
  await write(root, "docs/engine.md", "```ts title=\"engine.ts\"\nexport const engine = \"docs-fixture\"\n```\n")
  await write(root, "changeset.json", "{}")
  await write(
    root,
    "digest-baseline.json",
    JSON.stringify([
      { path: "digest/a.txt", digest: "8f434346648f6b96df89dda901c5176b10a6d83961dd3c1ac88b59b2dc327aa4" }
    ])
  )
  await write(root, "version.txt", "old")
  for (
    const [name, body] of [
      [
        "tsc",
        // The block file is the last argument. A block that names the nested
        // package (`docs-fixture`) has to sit below `docs/`, every other block
        // below the root package, or the compiler could not resolve a bare
        // specifier the block imports. Tool runs execute in a scratch copy, so
        // the check lives in the fake rather than in a file the test reads back.
        [
          "#!/bin/sh",
          "for last; do :; done",
          "case \"$*\" in *engine.ts*) echo \"fake tsc: context file compiled as a block: $*\" >&2; exit 1 ;; esac",
          "case \"$last\" in",
          "  docs/node_modules/.cache/smithers-build/markdown-*/src/run.ts)",
          "    dir=$(dirname \"$(dirname \"$last\")\")",
          "    grep -q 'export const greet' \"$dir/greeting.ts\" && grep -q 'export const twice' \"$dir/greeting.ts\" &&",
          "      grep -q docs-fixture \"$dir/engine.ts\" && ! grep -rq 'return greet' \"$dir\" && exit 0",
          "    echo \"fake tsc: tutorial scratch files wrong in $dir\" >&2; exit 1 ;;",
          "  docs/node_modules/.cache/smithers-build/markdown-*/block-0.ts) grep -q docs-fixture \"$last\" && exit 0 ;;",
          "  node_modules/.cache/smithers-build/markdown-*/block-0.ts) grep -q docs-fixture \"$last\" || exit 0 ;;",
          "esac",
          "echo \"fake tsc: block outside its package: $last\" >&2",
          "exit 1",
          ""
        ].join("\n")
      ],
      ["size-limit", "#!/bin/sh\nexit 0\n"],
      ["changeset", "#!/bin/sh\nprintf next > version.txt\n"]
    ] as const
  ) {
    await write(root, `node_modules/.bin/${name}`, body)
    await Fs.chmod(NodePath.join(root, "node_modules", ".bin", name), 0o755)
  }
  NodeChildProcess.execFileSync("git", ["-C", root, "init", "-q"])
  NodeChildProcess.execFileSync("git", ["-C", root, "add", "-A"])
  NodeChildProcess.execFileSync("git", [
    "-C",
    root,
    "-c",
    "user.email=test@example.invalid",
    "-c",
    "user.name=test",
    "commit",
    "-qm",
    "fixture"
  ])
  return root
}

// These fixtures test extraction and compiler placement with local tool stubs.
const markdownFixture = async (): Promise<string> => {
  const root = await fixture()
  await write(
    root,
    "WORKSPACE.ts",
    workspace.replace("  cache:", "  sandboxes: S.Sandboxes({ default: S.Sandbox.None() }),\n  cache:")
  )
  return root
}

describe("Node lane package execution", () => {
  it("writes, caches, and CAS-restores Literal, Copy, and Npm.Pack files", async () => {
    const root = await fixture()
    expect((await serve(root, ["//:literal"])).exitCode).toBe(0)
    expect(await Fs.readFile(NodePath.join(root, "out/literal.txt"), "utf8")).toBe("literal")
    await Fs.rm(NodePath.join(root, "out/literal.txt"))
    const restored = await serve(root, ["//:literal"])
    expect(restored.exitCode).toBe(0)
    expect(restored.logs).toContain("//:literal  hit")
    expect(await Fs.readFile(NodePath.join(root, "out/literal.txt"), "utf8")).toBe("literal")

    expect((await serve(root, ["//:copy"])).exitCode).toBe(0)
    expect(await Fs.readFile(NodePath.join(root, "out/copied.txt"), "utf8")).toBe("input")

    expect((await serve(root, ["//:pack"])).exitCode).toBe(0)
    const tarball = NodePath.join(root, "node-lane-fixture-1.0.0.tgz")
    expect((await Fs.stat(tarball)).isFile()).toBe(true)
    await Fs.rm(tarball)
    const packHit = await serve(root, ["//:pack"])
    expect(packHit.exitCode).toBe(0)
    expect(packHit.logs).toContain("//:pack  hit")
    expect((await Fs.stat(tarball)).isFile()).toBe(true)
  })

  it("compiles Markdown blocks from inside the declaring package", async () => {
    const root = await markdownFixture()
    const result = await serve(root, ["//docs:markdown"])
    expect(result.logs).not.toContain("block outside its package")
    expect(result.exitCode).toBe(0)
    expect(result.logs).toContain("checked 1 fenced code block")
  })

  it("concatenates titled Markdown fences into files, writes context pages beside them, and skips fragments", async () => {
    const root = await markdownFixture()
    const result = await serve(root, ["//docs:tutorial"])
    expect(result.logs).not.toContain("fake tsc")
    expect(result.exitCode).toBe(0)
    expect(result.logs).toContain("checked 4 fenced code block(s): 0 standalone, 2 file(s), 1 fragment(s) skipped")
  })

  it("removes Markdown scratch trees across content versions and cache hits", async () => {
    const root = await markdownFixture()
    for (const value of [42, 43]) {
      await write(root, "README.md", "```ts\nconst answer: number = " + value + "\n```\n")
      const result = await serve(root, ["//:markdown"])
      expect(result.exitCode, result.output + result.logs).toBe(0)
      expect(result.logs).toContain("//:markdown  ran")
    }
    expect((await serve(root, ["//:markdown"])).logs).toContain("//:markdown  hit")
    const scratch = await Fs.readdir(NodePath.join(root, "node_modules/.cache/smithers-build"))
    expect(scratch.filter((name) => name.startsWith("markdown-"))).toEqual([])
  })

  it("removes Markdown scratch trees when the compiler fails", async () => {
    const root = await markdownFixture()
    await write(root, "node_modules/.bin/tsc", "#!/bin/sh\necho compiler-failed >&2\nexit 1\n")
    const result = await serve(root, ["//:markdown"])
    expect(result.exitCode).toBe(1)
    expect(result.logs).toContain("compiler-failed")
    const scratch = await Fs.readdir(NodePath.join(root, "node_modules/.cache/smithers-build"))
    expect(scratch.filter((name) => name.startsWith("markdown-"))).toEqual([])
  })

  it("checks Markdown blocks and size budgets with cache hits", async () => {
    const root = await markdownFixture()
    const before = await serve(root, ["//:markdown", "--plan"])
    const markdown = await serve(root, ["//:markdown"])
    expect(markdown.exitCode).toBe(0)
    expect(markdown.logs).toContain("checked 1 fenced code block")
    const after = await serve(root, ["//:markdown", "--plan"])
    expect(after.output, `${before.output}\n--- after ---\n${after.output}`).toBe(before.output)
    expect((await serve(root, ["//:markdown"])).logs).toContain("//:markdown  hit")
    expect((await serve(root, ["//:size"])).exitCode).toBe(0)
    expect((await serve(root, ["//:size"])).logs).toContain("//:size  hit")
    expect((await serve(root, ["//:digest"])).exitCode).toBe(0)
    expect((await serve(root, ["//:digest"])).logs).toContain("//:digest  hit")
    await write(root, "digest-baseline.json", "[]")
    expect((await serve(root, ["//:digest"])).logs).toContain("file digest differs")
  })

  it("confines Changesets.Version writes and distinguishes check/write", async () => {
    const root = await fixture()
    const red = await serve(root, ["//:version"])
    expect(red.exitCode).toBe(1)
    expect(red.logs).toContain("drift in declared write-set")
    expect(await Fs.readFile(NodePath.join(root, "version.txt"), "utf8")).toBe("old")
    const applied = await serve(root, ["//:version", "--write"])
    expect(applied.exitCode, applied.logs).toBe(0)
    expect(await Fs.readFile(NodePath.join(root, "version.txt"), "utf8")).toBe("next")
    expect((await serve(root, ["//:version"])).exitCode).toBe(0)
  })

  it("builds overlay consumers in scratch, caches outputs, and leaves source bytes untouched", async () => {
    const root = await fixture()
    const source = NodePath.join(root, "overlay/base.txt")
    const before = await Fs.readFile(source)
    const firstPlan = JSON.parse((await serve(root, ["//:overlayBuild", "--plan", "--format", "json"])).output) as {
      readonly targets: ReadonlyArray<{ readonly label: string; readonly key: string }>
    }
    const first = await serve(root, ["//:overlayBuild"])
    expect(first.exitCode, first.logs).toBe(0)
    expect(await Fs.readFile(NodePath.join(root, "overlay-out/result.txt"), "utf8")).toBe("replacement")
    expect(await Fs.readFile(source)).toEqual(before)
    const second = await serve(root, ["//:overlayBuild"])
    expect(second.exitCode, second.logs).toBe(0)
    expect(second.logs).toContain("//:overlayBuild  hit")
    await Fs.rm(NodePath.join(root, "overlay-out"), { recursive: true })
    const restored = await serve(root, ["//:overlayBuild"])
    expect(restored.exitCode, restored.logs).toBe(0)
    expect(restored.logs).toContain("//:overlayBuild  hit")
    expect(await Fs.readFile(NodePath.join(root, "overlay-out/result.txt"), "utf8")).toBe("replacement")
    expect(await Fs.readFile(source)).toEqual(before)

    await write(root, "overlay/replacement.txt", "changed")
    const nextPlan = JSON.parse(
      (await serve(root, ["//:overlayBuild", "--plan", "--format", "json"])).output
    ) as {
      readonly targets: ReadonlyArray<{ readonly label: string; readonly key: string }>
    }
    const keyOf = (plan: typeof firstPlan): string => plan.targets.find((row) => row.label === "//:overlayBuild")!.key
    expect(keyOf(nextPlan)).not.toBe(keyOf(firstPlan))
    expect((await serve(root, ["//:overlayBuild"])).exitCode).toBe(0)
    expect(await Fs.readFile(NodePath.join(root, "overlay-out/result.txt"), "utf8")).toBe("changed")
    expect(await Fs.readFile(source)).toEqual(before)

    const conflict = await serve(root, ["//:overlayConflictBuild", "--plan"])
    expect(conflict.exitCode).toBe(0)
    expect(conflict.output).toContain("Overlay conflict")
  })

  it("keeps an overlay private to its own consumer and refuses rules with no scratch mount", async () => {
    const root = await fixture()
    // //:overlayDownstream reads the build's outputs. Its own command asserts
    // both that the real source bytes are intact and that the build did apply
    // the replacement, so an overlay leaking down the output edge fails it.
    const downstream = await serve(root, ["//:overlayDownstream"])
    expect(downstream.exitCode, downstream.logs).toBe(0)
    expect(await Fs.readFile(NodePath.join(root, "overlay/base.txt"), "utf8")).toBe("base")

    const packed = await serve(root, ["//:overlayPack"])
    expect(packed.exitCode).not.toBe(0)
    expect(packed.logs).toContain("no consumer-scoped overlay mount")
    expect(packed.logs).toContain("overlay/base.txt")
  })

  it("keeps Cron and Overlay values inert", async () => {
    const root = await fixture()
    const cron = await serve(root, ["//:cron"])
    expect(cron.exitCode).toBe(0)
    expect(cron.logs).toContain("inert schedule 0 6 * * 1")
    const drift = await serve(root, ["//:ci"])
    expect(drift.exitCode).toBe(1)
    expect(drift.logs).toContain("drift in generated GitHub files")
    expect((await serve(root, ["//:ci", "--write"])).exitCode).toBe(0)
    expect((await serve(root, ["//:ci"])).exitCode).toBe(0)
    expect(await Fs.readFile(NodePath.join(root, ".github/workflows/cron-cron.yml"), "utf8"))
      .toContain("cron: \"0 6 * * 1\"")
    expect((await serve(root, ["//:overlay"])).exitCode).toBe(0)
  })

  it("refuses Npm.Downstream in the plan until its remote checkout runner exists", async () => {
    const root = await fixture()
    const planned = await serve(root, ["//:downstream", "--plan"])
    expect(planned.output).toContain("Npm.Downstream: not implemented by this executor")
    const run = await serve(root, ["//:downstream"])
    expect(run.exitCode).toBe(1)
    expect(run.logs).toContain("Npm.Downstream: not implemented by this executor")
    expect(run.logs).not.toContain("isolated remote checkout runner")
  })

  it("refuses every outward rule without a transport in the plan, before any gate runs", async () => {
    const root = await fixture()
    for (
      const [label, rule] of [
        ["publishMissing", "Npm.Publish"],
        ["publishApproval", "Npm.Publish"],
        ["changesetsPublish", "Changesets.Publish"],
        ["githubPr", "Github.Pr"],
        ["release", "Github.Release"],
        ["pages", "Github.Pages"],
        ["pr", "Git.Pr"]
      ] as const
    ) {
      const planned = await serve(root, [`//:${label}`, "--plan"])
      expect(planned.output).toContain(`${rule}: not implemented by this executor`)
      const run = await serve(root, [`//:${label}`])
      expect(run.exitCode).toBe(1)
      expect(run.logs).toContain(`${rule}: not implemented by this executor`)
      expect(run.logs).not.toContain("//:gate ")
      expect(run.logs).not.toContain("NotImplemented")
    }
  })
})
