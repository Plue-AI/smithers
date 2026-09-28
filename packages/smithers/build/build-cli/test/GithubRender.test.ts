import { Smithers as S } from "@smthrs/targets"
import { parseWorkflow } from "@smthrs/targets/GithubWorkflow"
import type * as Target from "@smthrs/targets/Target"
import * as NodeChildProcess from "node:child_process"
import * as Fs from "node:fs/promises"
import { createRequire } from "node:module"
import * as Os from "node:os"
import * as NodePath from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import { makeCli, normalizeArgv } from "../src/Cli.ts"
import * as GithubRender from "../src/GithubRender.ts"
import * as PackageDiscovery from "../src/PackageDiscovery.ts"
import { PackageIndex } from "../src/PackageIndex.ts"
import * as PackageLoader from "../src/PackageLoader.ts"

/** Temp directories this file created; removed after the suite so a run leaves nothing in the OS temp dir. */
const temporaryDirectories: Array<string> = []
const tracked = async (directory: Promise<string>): Promise<string> => {
  const resolved = await directory
  temporaryDirectories.push(resolved)
  return resolved
}
afterAll(async () => {
  await Promise.all(temporaryDirectories.map((directory) => Fs.rm(directory, { recursive: true, force: true })))
})

const forceSpec = NodePath.resolve(import.meta.dirname, "fixtures/force-spec")
const stepsSpec = NodePath.resolve(import.meta.dirname, "fixtures/steps-form")
/**
 * Splits a rendered shell command the way a shell would, honouring the single
 * quotes the renderer puts around a label. Nothing here needs more: a
 * generated command is exec plus a quoted label plus flags.
 */
const shellWords = (command: string): ReadonlyArray<string> =>
  (command.match(/'[^']*'|"[^"]*"|\S+/g) ?? []).map((word) =>
    (word.startsWith("'") && word.endsWith("'")) || (word.startsWith("\"") && word.endsWith("\""))
      ? word.slice(1, -1)
      : word
  )
const goldenRoot = NodePath.resolve(import.meta.dirname, "fixtures/github-render")
const originalRoot = NodePath.join(goldenRoot, "originals")

interface YamlModule {
  readonly parse: (source: string) => unknown
}

const yaml = createRequire(NodePath.resolve(import.meta.dirname, "../../targets/package.json"))("yaml") as YamlModule

/** Normalizes YAML representation details that do not change GitHub's input. */
const normalizeYaml = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(normalizeYaml)
  if (typeof value === "number") return String(value)
  if (typeof value === "string") return value.endsWith("\n") ? value.slice(0, -1) : value
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [key, normalizeYaml(child)])
    )
  }
  return value
}

/** Parses one workflow while omitting its display name, which the build system derives from its file name. */
const comparableWorkflow = (source: string): unknown => {
  const parsed = yaml.parse(source)
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new TypeError("expected a YAML workflow mapping")
  }
  const body: Record<string, unknown> = { ...parsed }
  delete body["name"]
  return normalizeYaml(body)
}

const openIndex = async (): Promise<PackageIndex> => {
  const discovery = await PackageDiscovery.discover(forceSpec)
  const loaded = await PackageLoader.load(discovery)
  return PackageIndex.make(loaded)
}

const renderForce = async (): Promise<GithubRender.CiRender> => {
  const index = await openIndex()
  const [row] = index.resolve("//.github:github")
  return GithubRender.render({
    ciGen: row!.target,
    workspace: index.workspace,
    resolve: index,
    packageDir: row!.packagePath
  })
}

const renderSteps = async (): Promise<GithubRender.CiRender> => {
  const discovery = await PackageDiscovery.discover(stepsSpec)
  const loaded = await PackageLoader.load(discovery)
  const index = PackageIndex.make(loaded)
  const [row] = index.resolve("//.github:github")
  return GithubRender.render({
    ciGen: row!.target,
    workspace: index.workspace,
    resolve: index,
    packageDir: row!.packagePath
  })
}

const temporaryRoot = async (): Promise<string> =>
  tracked(Fs.realpath(await Fs.mkdtemp(NodePath.join(Os.tmpdir(), "smthrs-github-render-"))))

/**
 * A committed build-system workspace whose only target answers to `//:build`,
 * so a rendered job command can be planned by the real CLI.
 */
const parseableWorkspace = async (): Promise<string> => {
  const root = await temporaryRoot()
  const put = async (relative: string, text: string): Promise<void> => {
    const path = NodePath.join(root, relative)
    await Fs.mkdir(NodePath.dirname(path), { recursive: true })
    await Fs.writeFile(path, text, "utf8")
  }
  await put(
    "WORKSPACE.ts",
    `import { Smithers as S } from "@smthrs/targets"
const packageJson = S.file("//package.json")
export const Workspace = S.Workspace("fixture", {
  repository: "git+https://example.invalid/fixture.git",
  cache: S.Cache({ directory: ".flows" }),
  runtime: S.Runtime.Node({ version: "26" }),
  packageManager: S.PackageManager.Yarn({ manifest: packageJson, lockfile: S.file("//yarn.lock") }),
  nodeModules: S.Npm.NodeModules({ packageJson }),
})
`
  )
  await put(
    "PACKAGE.ts",
    `import { Smithers as S } from "@smthrs/targets"
const build = S.Shell.Test({ shell: "true" })
export const Package = S.Package({ targets: { build } })
`
  )
  await put("package.json", `${JSON.stringify({ name: "fixture", private: true }, undefined, 2)}\n`)
  await put("yarn.lock", "# yarn lockfile v1\n")
  const git = (...args: ReadonlyArray<string>): void => {
    NodeChildProcess.execFileSync("git", ["-C", root, ...args], { encoding: "utf8" })
  }
  git("init", "-q")
  git("add", "-A")
  git("-c", "user.email=t@t.t", "-c", "user.name=t", "commit", "-qm", "init")
  return root
}

/** Publishes a rendered set into a bare temp workspace, preserve files first. */
const seedPreserved = async (root: string, rendered: GithubRender.CiRender): Promise<void> => {
  for (const path of rendered.preserve) {
    const absolute = NodePath.join(root, rendered.packageDir, path)
    await Fs.mkdir(NodePath.dirname(absolute), { recursive: true })
    await Fs.writeFile(absolute, `# hand-written: ${path}\n`, "utf8")
  }
}

/** A minimal workspace declaration for renderer unit tests. */
const unitWorkspace = S.Workspace("unit", {
  repository: "git+https://example.invalid/unit.git",
  cache: S.Cache({ directory: ".flows" }),
  runtime: S.Runtime.Node({ version: "26" }),
  packageManager: S.PackageManager.Pnpm({
    version: "11.21.0",
    runtime: S.Runtime.Node({ version: ">=26.4.0" })
  }),
  nodeModules: S.Npm.NodeModules({ packageJson: S.file("//package.json") })
})

/** A map-backed label resolver for renderer unit tests. */
const resolver = (entries: ReadonlyArray<readonly [Target.AnyTarget, string]>): GithubRender.LabelResolver => {
  const labels = new Map<Target.AnyTarget, string>(entries)
  return { labelOf: (target) => labels.get(target) }
}

const anyTarget = (): Target.AnyTarget => S.Memory.Retain({ source: S.gitCommit("HEAD"), tags: ["unit"] })

/** Runs a renderer call and returns the typed refusal code it throws. */
const thrownCode = (work: () => unknown): GithubRender.ErrorCode => {
  try {
    work()
  } catch (cause) {
    if (GithubRender.isGithubRenderError(cause)) return cause.code
    throw cause
  }
  throw new Error("expected a GithubRenderError")
}

describe("force-spec CI generation goldens", () => {
  it("renders the exact golden file set", async () => {
    const rendered = await renderForce()
    expect(rendered.label).toBe("//.github:github")
    expect(rendered.files.map((file) => file.path)).toEqual([
      "actions/setup/action.yml",
      "workflows/ci.yml",
      "workflows/danger.yml",
      "workflows/review.yml"
    ])
    for (const file of rendered.files) {
      const goldenPath = NodePath.join(goldenRoot, file.path)
      if (process.env["UPDATE_GOLDENS"] === "1") {
        await Fs.mkdir(NodePath.dirname(goldenPath), { recursive: true })
        await Fs.writeFile(goldenPath, file.content, "utf8")
      }
      const golden = await Fs.readFile(goldenPath, "utf8")
      expect(file.content, file.path).toBe(golden)
    }
    expect(rendered.preserve).toEqual([
      "workflows/link-pr-to-notion.yml",
      "workflows/lint-agents-md.yml",
      "workflows/run-conventional-commits-check.yml"
    ])
    expect(rendered.changes).toEqual(["workflows/**", "actions/setup/**"])
  })

  it("is byte-stable across two runs and across working directories", async () => {
    const first = await renderForce()
    const previous = process.cwd()
    const elsewhere = await temporaryRoot()
    process.chdir(elsewhere)
    let second: GithubRender.CiRender
    try {
      second = await renderForce()
    } finally {
      process.chdir(previous)
    }
    expect(second.files).toEqual(first.files)
  })
})

describe("steps-form fixture", () => {
  it("loads the build system and renders the expected workflow YAML", async () => {
    const rendered = await renderSteps()
    expect(rendered.files.map((file) => file.path)).toEqual(["workflows/manual.yml"])
    const golden = await Fs.readFile(NodePath.join(goldenRoot, "workflows/manual.yml"), "utf8")
    expect(rendered.files[0]!.content).toBe(golden)
  })
})

describe("check and write", () => {
  it("reports missing files before the first write, then clean after it", async () => {
    const rendered = await renderForce()
    const root = await temporaryRoot()
    await seedPreserved(root, rendered)
    const before = await GithubRender.check(root, rendered)
    expect(before.clean).toBe(false)
    expect(before.entries.filter((entry) => entry.status === "missing")).toHaveLength(rendered.files.length)
    expect(before.entries.filter((entry) => entry.status === "preserved")).toHaveLength(3)
    const report = await GithubRender.write(root, rendered)
    expect(report.wrote.length).toBe(rendered.files.length)
    expect(report.preserved).toEqual(rendered.preserve)
    const after = await GithubRender.check(root, rendered)
    expect(after.clean).toBe(true)
  })

  it("never overwrites a preserved file and leaves it out of drift", async () => {
    const rendered = await renderForce()
    const root = await temporaryRoot()
    await seedPreserved(root, rendered)
    await GithubRender.write(root, rendered)
    const preserved = NodePath.join(root, ".github", "workflows", "link-pr-to-notion.yml")
    expect(await Fs.readFile(preserved, "utf8")).toBe("# hand-written: workflows/link-pr-to-notion.yml\n")
    const again = await GithubRender.write(root, rendered)
    expect(again.wrote).toEqual([])
    expect(again.unchanged.length).toBe(rendered.files.length)
    expect(await Fs.readFile(preserved, "utf8")).toBe("# hand-written: workflows/link-pr-to-notion.yml\n")
  })

  it("goes red on drift and write repairs it atomically", async () => {
    const rendered = await renderForce()
    const root = await temporaryRoot()
    await seedPreserved(root, rendered)
    await GithubRender.write(root, rendered)
    const drifted = NodePath.join(root, ".github", "workflows", "ci.yml")
    await Fs.appendFile(drifted, "# manual edit\n", "utf8")
    const report = await GithubRender.check(root, rendered)
    expect(report.clean).toBe(false)
    expect(report.entries).toContainEqual({ path: "workflows/ci.yml", status: "stale" })
    await GithubRender.write(root, rendered)
    expect((await GithubRender.check(root, rendered)).clean).toBe(true)
  })

  it("classifies stale generated files inside the write-set and removes them on write", async () => {
    const rendered = await renderForce()
    const root = await temporaryRoot()
    await seedPreserved(root, rendered)
    await GithubRender.write(root, rendered)
    const stale = NodePath.join(root, ".github", "workflows", "no-longer-declared.yml")
    await Fs.writeFile(stale, "name: old\n", "utf8")
    const outside = NodePath.join(root, ".github", "CODEOWNERS")
    await Fs.writeFile(outside, "* @owners\n", "utf8")
    const report = await GithubRender.check(root, rendered)
    expect(report.clean).toBe(false)
    expect(report.entries).toContainEqual({ path: "workflows/no-longer-declared.yml", status: "unexpected" })
    expect(report.entries.some((entry) => entry.path === "CODEOWNERS")).toBe(false)
    const written = await GithubRender.write(root, rendered)
    expect(written.removed).toEqual(["workflows/no-longer-declared.yml"])
    await expect(Fs.access(stale)).rejects.toThrow()
    expect(await Fs.readFile(outside, "utf8")).toBe("* @owners\n")
  })

  it("refuses a rendered path outside the declared write-set", async () => {
    const rendered = await renderForce()
    const narrowed: GithubRender.CiRender = { ...rendered, changes: ["actions/setup/**"] }
    const root = await temporaryRoot()
    await expect(GithubRender.write(root, narrowed)).rejects.toMatchObject({
      name: "GithubRenderError",
      code: "outside_write_set"
    })
  })
})

describe("graph-derived shard matrices", () => {
  it("renders a suite's Shell.Test shard fan-out into the job matrix", () => {
    const test = S.Shell.Test({ shell: "true", shards: 3 })
    const suite = S.Suite({ tests: [test] })
    const workflow = S.Github.Workflow({ name: "verify", on: { pullRequest: true }, run: [suite] })
    const ciGen = S.Github.CiGen({ workflows: [workflow] })
    const rendered = GithubRender.render({
      ciGen,
      workspace: unitWorkspace,
      resolve: resolver([[ciGen, "//:github"], [suite, "//:verify"]]),
      packageDir: ".github"
    })
    const content = rendered.files.find((file) => file.path === "workflows/verify.yml")!.content
    expect(content).toContain("        shard: [1, 2, 3]\n        total-shards: [3]\n")
    expect(content).toContain("      SMTHRS_SHARD: \"${{ matrix.shard }}/${{ matrix.total-shards }}\"\n")
  })
})

describe("render refusals", () => {
  it("refuses an unlabeled CiGen target", () => {
    const workflow = S.Github.Workflow({ name: "ci", on: { pullRequest: true }, run: [] })
    const ciGen = S.Github.CiGen({ workflows: [workflow] })
    expect(
      thrownCode(() =>
        GithubRender.render({ ciGen, workspace: unitWorkspace, resolve: resolver([]), packageDir: ".github" })
      )
    ).toBe("unlabeled_cigen")
  })

  it("refuses a workflows entry that is not a Github.Workflow", () => {
    const ciGen = S.Github.CiGen({ workflows: [anyTarget()] })
    expect(thrownCode(() =>
      GithubRender.render({
        ciGen,
        workspace: unitWorkspace,
        resolve: resolver([[ciGen, "//.github:github"]]),
        packageDir: ".github"
      })
    )).toBe("not_a_workflow")
  })

  it("refuses an unusable workflow file name", () => {
    const workflow = S.Github.Workflow({ name: "bad name", on: { pullRequest: true }, run: [] })
    const ciGen = S.Github.CiGen({ workflows: [workflow] })
    expect(thrownCode(() =>
      GithubRender.render({
        ciGen,
        workspace: unitWorkspace,
        resolve: resolver([[ciGen, "//.github:github"]]),
        packageDir: ".github"
      })
    )).toBe("invalid_workflow_name")
  })

  it("refuses two workflows sharing one name", () => {
    const first = S.Github.Workflow({ name: "ci", on: { pullRequest: true }, run: [] })
    const second = S.Github.Workflow({ name: "ci", on: { workflowDispatch: true }, run: [] })
    const ciGen = S.Github.CiGen({ workflows: [first, second] })
    expect(thrownCode(() =>
      GithubRender.render({
        ciGen,
        workspace: unitWorkspace,
        resolve: resolver([[ciGen, "//.github:github"]]),
        packageDir: ".github"
      })
    )).toBe("duplicate_workflow_name")
  })

  it("refuses two distinct setup targets", () => {
    const setupA = S.Github.Setup({})
    const setupB = S.Github.Setup({})
    const first = S.Github.Workflow({ name: "a", on: { pullRequest: true }, setup: setupA, run: [] })
    const second = S.Github.Workflow({ name: "b", on: { pullRequest: true }, setup: setupB, run: [] })
    const ciGen = S.Github.CiGen({ workflows: [first, second] })
    expect(thrownCode(() =>
      GithubRender.render({
        ciGen,
        workspace: unitWorkspace,
        resolve: resolver([[ciGen, "//.github:github"]]),
        packageDir: ".github"
      })
    )).toBe("multiple_setups")
  })

  it("refuses an unlabeled run target", () => {
    const run = anyTarget()
    const workflow = S.Github.Workflow({ name: "ci", on: { pullRequest: true }, run: [run] })
    const ciGen = S.Github.CiGen({ workflows: [workflow] })
    expect(thrownCode(() =>
      GithubRender.render({
        ciGen,
        workspace: unitWorkspace,
        resolve: resolver([[ciGen, "//.github:github"]]),
        packageDir: ".github"
      })
    )).toBe("unlabeled_run_target")
  })

  it("refuses two run labels mangling to one job id", () => {
    const first = anyTarget()
    const second = anyTarget()
    const workflow = S.Github.Workflow({ name: "ci", on: { pullRequest: true }, run: [first, second] })
    const ciGen = S.Github.CiGen({ workflows: [workflow] })
    expect(thrownCode(() =>
      GithubRender.render({
        ciGen,
        workspace: unitWorkspace,
        resolve: resolver([
          [ciGen, "//.github:github"],
          [first, "//a:b-c"],
          [second, "//a/b:c"]
        ]),
        packageDir: ".github"
      })
    )).toBe("duplicate_job_id")
  })

  it("refuses a cancelInProgress value that is neither boolean nor event name", () => {
    const workflow = S.Github.Workflow({
      name: "ci",
      on: { pullRequest: true },
      concurrency: { group: "ci", cancelInProgress: "Not An Event" },
      run: []
    })
    const ciGen = S.Github.CiGen({ workflows: [workflow] })
    expect(thrownCode(() =>
      GithubRender.render({
        ciGen,
        workspace: unitWorkspace,
        resolve: resolver([[ciGen, "//.github:github"]]),
        packageDir: ".github"
      })
    )).toBe("invalid_event_name")
  })

  it("refuses a workflow whose rendered path is also preserved", () => {
    const workflow = S.Github.Workflow({ name: "hand-written", on: { pullRequest: true }, run: [] })
    const ciGen = S.Github.CiGen({
      workflows: [workflow],
      preserve: ["workflows/hand-written.yml"]
    })
    expect(thrownCode(() =>
      GithubRender.render({
        ciGen,
        workspace: unitWorkspace,
        resolve: resolver([[ciGen, "//.github:github"]]),
        packageDir: ".github"
      })
    )).toBe("preserve_conflict")
  })

  it("refuses a preserve entry that escapes the package directory", () => {
    const workflow = S.Github.Workflow({ name: "ci", on: { pullRequest: true }, run: [] })
    const ciGen = S.Github.CiGen({ workflows: [workflow], preserve: ["../escape.yml"] })
    expect(thrownCode(() =>
      GithubRender.render({
        ciGen,
        workspace: unitWorkspace,
        resolve: resolver([[ciGen, "//.github:github"]]),
        packageDir: ".github"
      })
    )).toBe("invalid_path")
  })
})

describe("triggers", () => {
  it("renders schedule and release triggers in GitHub's shape", () => {
    const workflow = S.Github.Workflow({
      name: "nightly",
      on: { schedule: ["0 6 * * *"], release: ["published"], workflowDispatch: true },
      run: []
    })
    const ciGen = S.Github.CiGen({ workflows: [workflow] })
    const rendered = GithubRender.render({
      ciGen,
      workspace: unitWorkspace,
      resolve: resolver([[ciGen, "//.github:github"]]),
      packageDir: ".github"
    })
    const nightly = rendered.files.find((file) => file.path === "workflows/nightly.yml")
    expect(nightly).toBeDefined()
    expect(nightly!.content).toContain(
      "on:\n  schedule:\n    - cron: \"0 6 * * *\"\n  release:\n    types:\n      - \"published\"\n  workflow_dispatch:\n"
    )
  })

  it("refuses a schedule entry that is not a five-field cron expression", () => {
    const workflow = S.Github.Workflow({ name: "nightly", on: { schedule: ["daily"] }, run: [] })
    const ciGen = S.Github.CiGen({ workflows: [workflow] })
    expect(thrownCode(() =>
      GithubRender.render({
        ciGen,
        workspace: unitWorkspace,
        resolve: resolver([[ciGen, "//.github:github"]]),
        packageDir: ".github"
      })
    )).toBe("invalid_schedule")
  })

  it("rejects a release activity GitHub does not define", () => {
    expect(() => S.Github.Workflow({ name: "release", on: { release: ["tagged"] }, run: [] } as never)).toThrow()
  })

  it("renders workflow policy, typed inputs, and raw steps before target-derived jobs", () => {
    const run = anyTarget()
    const workflow = S.Github.Workflow({
      name: "coordinate",
      on: {
        pullRequest: { types: ["opened", "ready_for_review"] },
        pullRequestTarget: { types: ["opened", "synchronize"] },
        issues: { types: ["opened", "labeled"] },
        workflowDispatch: {
          inputs: {
            force_publish: {
              description: "Publish even when unchanged",
              required: true,
              default: false,
              type: "boolean"
            }
          }
        }
      },
      permissions: { contents: "read", "pull-requests": "write", issues: "read" },
      env: { CARGO_TERM_COLOR: "always" },
      environment: "prod",
      condition: "github.event_name != 'pull_request' || github.event.pull_request.state == 'open'",
      jobName: "Coordinate",
      runsOn: "blacksmith-4vcpu-ubuntu-2404",
      steps: [
        { uses: "actions/checkout@v4", with: { "fetch-depth": "0" } },
        {
          name: "Coordinate",
          id: "coordinate",
          if: "inputs.force_publish",
          run: ["echo first", "echo second"],
          shell: "bash",
          workingDirectory: ".smithers",
          env: { GH_TOKEN: "${{ github.token }}" }
        }
      ],
      run: [run]
    })
    const ciGen = S.Github.CiGen({ workflows: [workflow] })
    const rendered = GithubRender.render({
      ciGen,
      workspace: unitWorkspace,
      resolve: resolver([
        [ciGen, "//.github:github"],
        [run, "//:verify"]
      ]),
      packageDir: ".github"
    })
    const content = rendered.files.find((file) => file.path === "workflows/coordinate.yml")!.content

    expect(content).toContain(
      "  pull_request:\n    types:\n      - \"opened\"\n      - \"ready_for_review\"\n" +
        "  pull_request_target:\n    types:\n      - \"opened\"\n      - \"synchronize\"\n" +
        "  issues:\n    types:\n      - \"opened\"\n      - \"labeled\"\n"
    )
    expect(content).toContain(
      "  workflow_dispatch:\n    inputs:\n      \"force_publish\":\n" +
        "        description: \"Publish even when unchanged\"\n        required: true\n" +
        "        default: false\n        type: boolean\n"
    )
    expect(content).toContain(
      "permissions:\n  \"contents\": \"read\"\n  \"pull-requests\": \"write\"\n  \"issues\": \"read\"\n"
    )
    expect(content).toContain("env:\n  \"CARGO_TERM_COLOR\": \"always\"\n")
    expect(content).toContain(
      "  coordinate:\n    name: \"Coordinate\"\n" +
        "    if: \"github.event_name != 'pull_request' || github.event.pull_request.state == 'open'\"\n" +
        "    runs-on: \"blacksmith-4vcpu-ubuntu-2404\"\n    environment: \"prod\"\n"
    )
    expect(content).toContain(
      "      - name: \"Coordinate\"\n        id: \"coordinate\"\n        if: \"inputs.force_publish\"\n        run: |\n" +
        "          echo first\n          echo second\n        shell: \"bash\"\n" +
        "        working-directory: \".smithers\"\n        env:\n          \"GH_TOKEN\": \"${{ github.token }}\"\n"
    )
    expect(content.indexOf("  coordinate:\n")).toBeLessThan(content.indexOf("  verify:\n"))
  })
})

describe("design-partner workflow originals", () => {
  it("preserves publish-sdk job and step structure through YAML", async () => {
    const workflow = S.Github.Workflow({
      name: "publish-sdk",
      on: {
        push: { branches: ["main"] },
        workflowDispatch: {
          inputs: {
            force_publish: {
              description: "Publish the current SDK version even if it was already present on main",
              required: true,
              default: false,
              type: "boolean"
            }
          }
        }
      },
      env: { CARGO_TERM_COLOR: "always" },
      environment: "prod",
      jobName: "Publish aomi-sdk",
      runsOn: "blacksmith-4vcpu-ubuntu-2404",
      steps: [
        { uses: "actions/checkout@v4", with: { "fetch-depth": "0" } },
        {
          name: "Check SDK version bump",
          id: "sdk-version",
          env: {
            SDK_BASE_SHA: "${{ github.event_name == 'push' && github.event.before || github.sha }}",
            FORCE_PUBLISH: "${{ inputs.force_publish || false }}"
          },
          run: [
            "args=(",
            "  --base \"$SDK_BASE_SHA\"",
            "  --head \"${{ github.sha }}\"",
            "  --github-output \"$GITHUB_OUTPUT\"",
            ")",
            "if [ \"$FORCE_PUBLISH\" = \"true\" ]; then",
            "  args+=(--force-publish)",
            "fi",
            "python3 scripts/check_sdk_version_bump.py \"${args[@]}\""
          ]
        },
        {
          name: "Install Rust",
          if: "steps.sdk-version.outputs.publish_sdk == 'true'",
          uses: "dtolnay/rust-toolchain@stable",
          with: { toolchain: "1.91" }
        },
        {
          name: "Restore cargo cache",
          if: "steps.sdk-version.outputs.publish_sdk == 'true'",
          uses: "Swatinem/rust-cache@v2"
        },
        {
          name: "Publish summary",
          if: "steps.sdk-version.outputs.publish_sdk == 'true'",
          run: "echo \"Publishing aomi-sdk v${{ steps.sdk-version.outputs.sdk_version }}\""
        },
        {
          name: "Publish aomi-sdk",
          if: "steps.sdk-version.outputs.publish_sdk == 'true'",
          run: "cargo publish -p aomi-sdk",
          env: { CARGO_REGISTRY_TOKEN: "${{ secrets.CARGO_REGISTRY_TOKEN }}" }
        },
        {
          name: "Skip publish when SDK is unchanged",
          if: "steps.sdk-version.outputs.publish_sdk != 'true'",
          run: "echo \"SDK unchanged on this main push; skipping publish.\""
        }
      ]
    })
    const ciGen = S.Github.CiGen({ workflows: [workflow] })
    const rendered = GithubRender.render({
      ciGen,
      workspace: unitWorkspace,
      resolve: resolver([[ciGen, "//.github:github"]]),
      packageDir: ".github"
    })
    const original = await Fs.readFile(NodePath.join(originalRoot, "publish-sdk.yml"), "utf8")
    expect(comparableWorkflow(rendered.files[0]!.content)).toEqual(comparableWorkflow(original))
  })

  it("preserves coordinate job and step structure through YAML", async () => {
    const workflow = S.Github.Workflow({
      name: "coordinate",
      on: {
        pullRequest: { types: ["opened", "reopened", "ready_for_review", "labeled"] },
        issues: { types: ["opened", "labeled"] }
      },
      permissions: { contents: "read", "pull-requests": "write", issues: "read" },
      concurrency: { group: "coordinate-${{ github.repository }}", cancelInProgress: false },
      condition: "github.event_name != 'pull_request' || github.event.pull_request.state == 'open'",
      steps: [
        {
          name: "Checkout coordinator",
          uses: "actions/checkout@v4",
          with: {
            repository: "aomi-labs/aomi-scrum",
            token: "${{ secrets.SMITHER_COORDINATOR_TOKEN }}"
          }
        },
        { uses: "oven-sh/setup-bun@v2", with: { "bun-version": "1.3" } },
        {
          uses: "actions/cache@v4",
          with: {
            path: ".smithers/state",
            key: "coordinate-state-${{ github.repository }}-${{ github.run_id }}",
            "restore-keys": "coordinate-state-${{ github.repository }}-"
          }
        },
        { name: "Install workflow deps", workingDirectory: ".smithers", run: "bun install" },
        {
          name: "Run coordinate (this repo only)",
          env: {
            SMITHER_OPENAI_API_KEY: "${{ secrets.SMITHER_OPENAI_API_KEY }}",
            ANTHROPIC_API_KEY: "${{ secrets.SMITHER_ANTHROPIC_API_KEY }}",
            SMITHER_DISCORD_WEBHOOK_URL: "${{ secrets.SMITHER_DISCORD_WEBHOOK_URL }}",
            GH_TOKEN: "${{ github.token }}",
            PR_NUMBER: "${{ github.event.pull_request.number }}"
          },
          run: [
            "INPUT=\"{\\\"dryRun\\\":false,\\\"minSeverity\\\":\\\"high\\\",\\\"repos\\\":[\\\"${{ github.repository }}\\\"]\"",
            "[ -n \"$PR_NUMBER\" ] && INPUT=\"$INPUT,\\\"prNumber\\\":$PR_NUMBER\"",
            "INPUT=\"$INPUT}\"",
            "echo \"input: $INPUT\"",
            "bunx smithers-orchestrator up .smithers/workflows/coordinate.tsx --input \"$INPUT\""
          ]
        }
      ]
    })
    const ciGen = S.Github.CiGen({ workflows: [workflow] })
    const rendered = GithubRender.render({
      ciGen,
      workspace: unitWorkspace,
      resolve: resolver([[ciGen, "//.github:github"]]),
      packageDir: ".github"
    })
    const original = await Fs.readFile(NodePath.join(originalRoot, "coordinate.yaml"), "utf8")
    expect(comparableWorkflow(rendered.files[0]!.content)).toEqual(comparableWorkflow(original))
  })

  it("renders typed pull request and issue triggers plus dispatch inputs", () => {
    const workflow = S.Github.Workflow({
      name: "coordinate",
      on: {
        pullRequest: { types: ["opened", "ready_for_review", "labeled"] },
        issues: { types: ["opened", "labeled"] },
        workflowDispatch: {
          inputs: {
            force_publish: {
              description: "Publish even when unchanged",
              required: true,
              default: false,
              type: "boolean"
            }
          }
        }
      },
      run: []
    })
    const ciGen = S.Github.CiGen({ workflows: [workflow] })
    const rendered = GithubRender.render({
      ciGen,
      workspace: unitWorkspace,
      resolve: resolver([[ciGen, "//.github:github"]]),
      packageDir: ".github"
    })
    const content = rendered.files.find((file) => file.path === "workflows/coordinate.yml")!.content
    expect(content).toContain(
      "  pull_request:\n    types:\n      - \"opened\"\n      - \"ready_for_review\"\n      - \"labeled\"\n"
    )
    expect(content).toContain("  issues:\n    types:\n      - \"opened\"\n      - \"labeled\"\n")
    expect(content).toContain(
      "  workflow_dispatch:\n    inputs:\n      \"force_publish\":\n        description: \"Publish even when unchanged\"\n" +
        "        required: true\n        default: false\n        type: boolean\n"
    )
  })

  it("renders permissions, job policy, and custom steps", () => {
    const workflow = S.Github.Workflow({
      name: "coordinate",
      on: { issues: { types: ["opened"] } },
      permissions: { contents: "read", "pull-requests": "write", issues: "read" },
      env: { CARGO_TERM_COLOR: "always" },
      environment: "prod",
      condition: "github.event_name != 'pull_request' || github.event.pull_request.state == 'open'",
      jobName: "Coordinate",
      runsOn: "blacksmith-4vcpu-ubuntu-2404",
      steps: [
        {
          uses: "actions/checkout@v4",
          with: { repository: "aomi-labs/aomi-scrum", token: "${{ secrets.COORDINATOR_TOKEN }}" }
        },
        { name: "Install", run: "bun install", workingDirectory: ".smithers" },
        { name: "Coordinate", run: "bun run coordinate", env: { GH_TOKEN: "${{ github.token }}" } }
      ],
      run: []
    })
    const ciGen = S.Github.CiGen({ workflows: [workflow] })
    const rendered = GithubRender.render({
      ciGen,
      workspace: unitWorkspace,
      resolve: resolver([[ciGen, "//.github:github"]]),
      packageDir: ".github"
    })
    const content = rendered.files.find((file) => file.path === "workflows/coordinate.yml")!.content
    expect(content).toContain(
      "permissions:\n  \"contents\": \"read\"\n  \"pull-requests\": \"write\"\n  \"issues\": \"read\"\n"
    )
    expect(content).toContain("env:\n  \"CARGO_TERM_COLOR\": \"always\"\n")
    expect(content).toContain("    name: \"Coordinate\"\n")
    expect(content).toContain("    environment: \"prod\"\n")
    expect(content).toContain("    runs-on: \"blacksmith-4vcpu-ubuntu-2404\"\n")
    expect(content).toContain("      - uses: \"actions/checkout@v4\"\n        with:\n")
    expect(content).toContain("          \"repository\": \"aomi-labs/aomi-scrum\"\n")
    expect(content).toContain("        working-directory: \".smithers\"\n")
    expect(content).toContain("        env:\n          \"GH_TOKEN\": \"${{ github.token }}\"\n")
  })
})

describe("toolchain variants", () => {
  it("renders a toolchain-only Go workspace with setup-go and no Node install", () => {
    const nix = S.Nix.DevShell({ flake: S.file("//flake.nix"), lock: S.file("//flake.lock") })
    const go = S.Go.Toolchain({ mod: S.file("//go.mod"), sum: S.file("//go.sum"), versions: nix })
    const workspace = S.Workspace("go", {
      repository: "git+https://example.invalid/go.git",
      cache: S.Cache({ directory: ".flows" }),
      toolchains: [nix, go]
    })
    const setup = S.Github.Setup({})
    const workflow = S.Github.Workflow({ name: "ci", on: { pullRequest: true }, setup, run: [] })
    const ciGen = S.Github.CiGen({ workflows: [workflow] })
    const rendered = GithubRender.render({
      ciGen,
      workspace,
      resolve: resolver([[ciGen, "//.github:github"]]),
      packageDir: ".github"
    })
    const action = rendered.files.find((file) => file.path === "actions/setup/action.yml")!
    expect(action.content).toContain("actions/setup-go@924ae3a1cded613372ab5595356fb5720e22ba16 # v6.5.0")
    expect(action.content).toContain("\"go-version-file\": \"go.mod\"")
    expect(action.content).not.toContain("setup-node")
    expect(action.content).not.toContain("pnpm install")
  })

  it("renders every third-party action pinned to a commit, the Rust channel explicit", () => {
    const rust = S.Rust.Toolchain({ toolchain: S.file("//rust-toolchain.toml"), lockfile: S.file("//Cargo.lock") })
    const workspace = S.Workspace("rust", {
      repository: "git+https://example.invalid/rust.git",
      cache: S.Cache({ directory: ".flows" }),
      toolchains: [rust]
    })
    const setup = S.Github.Setup({})
    const workflow = S.Github.Workflow({ name: "ci", on: { pullRequest: true }, setup, run: [] })
    const ciGen = S.Github.CiGen({ workflows: [workflow] })
    const rendered = GithubRender.render({
      ciGen,
      workspace,
      resolve: resolver([[ciGen, "//.github:github"]]),
      packageDir: ".github"
    })
    const action = rendered.files.find((file) => file.path === "actions/setup/action.yml")!
    // A SHA-pinned rust-toolchain cannot read the channel from its ref.
    expect(action.content).toContain(
      "    - uses: dtolnay/rust-toolchain@6bed0761d98439e5a578e2877258200ad565ba87 # stable\n      with:\n        \"toolchain\": \"stable\"\n"
    )
    const node = GithubRender.render({
      ciGen,
      workspace: unitWorkspace,
      resolve: resolver([[ciGen, "//.github:github"]]),
      packageDir: ".github"
    })
    const lines = [...node.files, ...rendered.files].flatMap((file) =>
      file.content.split("\n").filter((row) => /^\s*- uses: [^.]/.test(row))
    )
    // pnpm, setup-node, cache, rust-toolchain; the goldens cover checkout.
    expect(lines.length).toBeGreaterThanOrEqual(4)
    for (const line of lines) expect(line).toMatch(/^\s*- uses: [\w.-]+\/[\w.-]+@[0-9a-f]{40} # \S+$/)
  })

  it("renders the pnpm setup action with the pinned manager and lockfile key", () => {
    const setup = S.Github.Setup({})
    const workflow = S.Github.Workflow({ name: "ci", on: { pullRequest: true }, setup, run: [] })
    const ciGen = S.Github.CiGen({ workflows: [workflow] })
    const rendered = GithubRender.render({
      ciGen,
      workspace: unitWorkspace,
      resolve: resolver([[ciGen, "//.github:github"]]),
      packageDir: ".github"
    })
    const action = rendered.files.find((file) => file.path === "actions/setup/action.yml")
    expect(action).toBeDefined()
    expect(action!.content).toContain("pnpm/action-setup@b906affcce14559ad1aafd4ab0e942779e9f58b1 # v4.3.0")
    expect(action!.content).toContain("\"version\": \"11.21.0\"")
    expect(action!.content).toContain("\"node-version\": \"26\"")
    expect(action!.content).toContain("pnpm-store-${{ hashFiles('pnpm-lock.yaml') }}")
    expect(action!.content).toContain("pnpm install --frozen-lockfile")
    // No secrets declared: no inputs block and no env-export step.
    expect(action!.content).not.toContain("inputs:")
    expect(action!.content).not.toContain("GITHUB_ENV")
  })

  it("renders the workspace-era pnpm declaration with the workspace runtime and its declared lockfile", () => {
    const pnpmWorkspace = S.Workspace("pnpmunit", {
      repository: "git+https://example.invalid/pnpmunit.git",
      cache: S.Cache({ directory: ".flows" }),
      runtime: S.Runtime.Node({ version: "26" }),
      packageManager: S.PackageManager.Pnpm({
        manifest: S.file("//package.json"),
        lockfile: S.file("//pnpm-lock.yaml"),
        version: "8"
      }),
      nodeModules: S.Npm.NodeModules({ packageJson: S.file("//package.json") })
    })
    const setup = S.Github.Setup({})
    const workflow = S.Github.Workflow({ name: "ci", on: { pullRequest: true }, setup, run: [] })
    const ciGen = S.Github.CiGen({ workflows: [workflow] })
    const rendered = GithubRender.render({
      ciGen,
      workspace: pnpmWorkspace,
      resolve: resolver([[ciGen, "//.github:github"]]),
      packageDir: ".github"
    })
    const action = rendered.files.find((file) => file.path === "actions/setup/action.yml")
    expect(action).toBeDefined()
    expect(action!.content).toContain("pnpm/action-setup@b906affcce14559ad1aafd4ab0e942779e9f58b1 # v4.3.0")
    expect(action!.content).toContain("\"version\": \"8\"")
    expect(action!.content).toContain("\"node-version\": \"26\"")
    expect(action!.content).toContain("pnpm-store-${{ hashFiles('pnpm-lock.yaml') }}")
    expect(action!.content).toContain("pnpm install --frozen-lockfile")
  })

  it("renders an unpinned workspace-era pnpm without a version input", () => {
    const pnpmWorkspace = S.Workspace("pnpmunit", {
      repository: "git+https://example.invalid/pnpmunit.git",
      cache: S.Cache({ directory: ".flows" }),
      runtime: S.Runtime.Node({ manifest: S.file("//package.json") }),
      packageManager: S.PackageManager.Pnpm({
        manifest: S.file("//package.json"),
        lockfile: S.file("//pnpm-lock.yaml")
      }),
      nodeModules: S.Npm.NodeModules({ packageJson: S.file("//package.json") })
    })
    const setup = S.Github.Setup({})
    const workflow = S.Github.Workflow({ name: "ci", on: { pullRequest: true }, setup, run: [] })
    const ciGen = S.Github.CiGen({ workflows: [workflow] })
    const rendered = GithubRender.render({
      ciGen,
      workspace: pnpmWorkspace,
      resolve: resolver([[ciGen, "//.github:github"]]),
      packageDir: ".github"
    })
    const action = rendered.files.find((file) => file.path === "actions/setup/action.yml")
    expect(action).toBeDefined()
    // No declared pin: pnpm/action-setup reads the manifest's packageManager field.
    expect(action!.content).toContain("pnpm/action-setup@b906affcce14559ad1aafd4ab0e942779e9f58b1 # v4.3.0")
    expect(action!.content).not.toContain("\"version\": \"8\"")
    // The workspace runtime arrives as the manifest-derived node-version-file.
    expect(action!.content).toContain("\"node-version-file\": \"package.json\"")
  })

  it.each(["//:test'quote", "//pack'age:test", "//:test;echo", "//:test\n"])(
    "refuses the invalid run label %j before rendering a shell command",
    (label) => {
      const run = anyTarget()
      const workflow = S.Github.Workflow({ name: "ci", on: { pullRequest: true }, run: [run] })
      const ciGen = S.Github.CiGen({ workflows: [workflow] })
      expect(thrownCode(() =>
        GithubRender.render({
          ciGen,
          workspace: unitWorkspace,
          resolve: resolver([[ciGen, "//.github:github"], [run, label]]),
          packageDir: ".github"
        })
      )).toBe("invalid_label")
    }
  )

  it("renders a pnpm run step through pnpm exec", () => {
    const run = anyTarget()
    const workflow = S.Github.Workflow({ name: "ci", on: { pullRequest: true }, run: [run] })
    const ciGen = S.Github.CiGen({ workflows: [workflow] })
    const rendered = GithubRender.render({
      ciGen,
      workspace: unitWorkspace,
      resolve: resolver([
        [ciGen, "//.github:github"],
        [run, "//:test"]
      ]),
      packageDir: ".github"
    })
    const ci = rendered.files.find((file) => file.path === "workflows/ci.yml")
    expect(ci!.content).toContain("pnpm exec smithers-build '//:test'")
  })

  it("renders job commands the real argument parser accepts", async () => {
    // The renderer used to append `--affected-base "$(git merge-base ...)"`,
    // which no command defines, so every generated job died at argument
    // parsing. Nothing noticed because the only assertion about that flag was
    // that it was absent from a workflow that never asked for it. Reading the
    // rendered command back through the parser that will actually run it is
    // the check whose absence let an unrunnable workflow ship.
    const run = anyTarget()
    const workflow = S.Github.Workflow({ name: "ci", on: { pullRequest: true }, run: [run] })
    const ciGen = S.Github.CiGen({ workflows: [workflow] })
    const rendered = GithubRender.render({
      ciGen,
      workspace: unitWorkspace,
      resolve: resolver([[ciGen, "//.github:github"], [run, "//:build"]]),
      packageDir: ".github"
    })
    const ci = rendered.files.find((file) => file.path === "workflows/ci.yml")!

    const root = await parseableWorkspace()

    const commands = parseWorkflow(ci.content).jobs.flatMap((job) =>
      job.steps.flatMap((step) => step.run === undefined ? [] : [step.run])
    )
    expect(commands).toHaveLength(1)
    for (const command of commands) {
      // Drop the package-manager exec prefix the workflow uses to reach the
      // binary; what is under test is the argv smithers-build itself receives.
      const argv = shellWords(command).slice(3)
      let exitCode = 0
      let output = ""
      await makeCli({}).serve([...normalizeArgv([...argv, "--workspace", root, "--plan"])], {
        exit: (code) => {
          exitCode = code
        },
        stdout: (text) => {
          output += text
        }
      })
      expect(output, command).not.toContain("Unknown flag")
      expect(exitCode, `${command}\n${output}`).toBe(0)
    }
  })

  it("refuses affected: true rather than rendering a flag the CLI cannot parse", () => {
    const run = anyTarget()
    const workflow = S.Github.Workflow({ name: "ci", on: { pullRequest: true }, affected: true, run: [run] })
    const ciGen = S.Github.CiGen({ workflows: [workflow] })
    expect(
      thrownCode(() =>
        GithubRender.render({
          ciGen,
          workspace: unitWorkspace,
          resolve: resolver([[ciGen, "//.github:github"], [run, "//:build"]]),
          packageDir: ".github"
        })
      )
    ).toBe("unsupported_affected")
  })
})

describe("the generated setup action never interpolates an input into bash", () => {
  const rendered = (): string => {
    const setup = S.Github.Setup({
      cacheUrl: S.Secret("SMITHERS_CACHE_URL"),
      cacheToken: S.Secret("SMITHERS_CACHE_TOKEN")
    })
    const workflow = S.Github.Workflow({ name: "ci", on: { pullRequest: true }, setup, run: [] })
    const ciGen = S.Github.CiGen({ workflows: [workflow] })
    const files = GithubRender.render({
      ciGen,
      workspace: unitWorkspace,
      resolve: resolver([[ciGen, "//.github:github"]]),
      packageDir: ".github"
    }).files
    return files.find((file) => file.path === "actions/setup/action.yml")!.content
  }

  /** The `run:` script's body, everything between `- run: |` and the next `shell:` line. */
  const runScript = (content: string): string => {
    const lines = content.split("\n")
    const start = lines.findIndex((line) => line.trim() === "- run: |" && line.includes("    -"))
    const rest = lines.slice(start + 1)
    const end = rest.findIndex((line) => line.trim() === "shell: bash")
    return rest.slice(0, end).join("\n")
  }

  /**
   * GitHub substitutes `${{ ... }}` textually before bash parses the script, so
   * an input carrying a double quote, `$(...)`, a backtick, or a newline used
   * to escape the string and either run commands on the runner or inject extra
   * `NAME=VALUE` records into $GITHUB_ENV. The values here are cache
   * credentials.
   */
  it("keeps every expression out of the script and binds inputs through env", () => {
    const content = rendered()
    expect(runScript(content)).not.toContain("${{")
    expect(content).toContain("      env:")
    expect(content).toContain("        SMTHRS_INPUT_CACHE_URL: ${{ inputs.cache-url }}")
    expect(content).toContain("        SMTHRS_INPUT_CACHE_TOKEN: ${{ inputs.cache-token }}")
  })

  /** The documented multiline form under a delimiter drawn at runtime. */
  it("writes each record with a heredoc under an unpredictable delimiter", () => {
    const script = runScript(rendered())
    expect(script).toMatch(/delimiter="smthrs_\$\(openssl rand -hex 16/)
    expect(script).toContain("printf '%s<<%s\\n' SMITHERS_CACHE_URL \"$delimiter\" >> \"$GITHUB_ENV\"")
    expect(script).toContain("printf '%s\\n' \"$SMTHRS_INPUT_CACHE_URL\" >> \"$GITHUB_ENV\"")
    expect(script).toContain("case \"$SMTHRS_INPUT_CACHE_URL\" in *\"$delimiter\"*) exit 1 ;; esac")
    expect(script).not.toContain("echo \"SMITHERS_CACHE_URL=")
  })
})
