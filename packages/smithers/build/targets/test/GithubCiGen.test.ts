/**
 * The generated CI workflow: what a PACKAGE.ts file may declare, and what the
 * generator renders from it.
 *
 * The load-bearing assertion in this file is the first one. Every other test
 * here checks that the render is correct; that one checks that there is no way
 * to declare a command at all, which is the property the whole module exists
 * for.
 */
import * as Schema from "effect/Schema"
import { spawnSync } from "node:child_process"
import * as Fs from "node:fs/promises"
import { tmpdir } from "node:os"
import * as NodePath from "node:path"
import { describe, expect, it } from "vitest"
import * as Yaml from "yaml"
import * as CiToolchain from "../src/CiToolchain.ts"
import {
  actionlintImages,
  actions,
  artifactSteps,
  Attrs,
  Gate,
  GithubCiGen,
  independentGate,
  Job,
  MatrixRow,
  render,
  renderStep,
  satisfiesGate,
  TargetStep,
  toolchainSteps
} from "../src/GithubCiGen.ts"
import { parseWorkflow as parseStrictWorkflow } from "../src/GithubWorkflow.ts"
import * as RustToolchain from "../src/RustToolchain.ts"
import { Secret } from "../src/Secret.ts"
import * as Target from "../src/Target.ts"
import * as Verb from "../src/Verb.ts"
import { plannedCalls } from "./plan.ts"
import { packageManager, runtime } from "./toolchain.ts"

/** Most focused fixtures omit trigger prose; supply the smallest real trigger. */
const parseWorkflow = (source: string): ReturnType<typeof parseStrictWorkflow> =>
  parseStrictWorkflow(/^on\s*:/m.test(source) ? source : `on: workflow_dispatch\n${source}`)

const node = CiToolchain.Node({ runtime, release: "26.4.0" })
const bareNode = CiToolchain.Node({ runtime, release: "26.4.0", cachePackageStore: false })
const rust = CiToolchain.Rust({ toolchain: RustToolchain.Pinned({}) })

describe("CI concurrency", () => {
  it("keeps one run in flight per branch, the newest commit next, and cancels superseded PR runs", () => {
    const workflow = render(goldenAttrs)
    // A commit-keyed group (#2071) queued a run per push faster than runners
    // drained them, so no main run completed for hours (#2085). A ref-keyed
    // group holds one running and one pending run; each push replaces the
    // pending one, and only PR runs cancel the one in progress.
    expect(workflow).toContain(
      "concurrency:\n  group: ${{ github.workflow }}-${{ github.event_name == 'pull_request' && format('pr-{0}', github.event.pull_request.number) || github.ref }}\n  cancel-in-progress: ${{ github.event_name == 'pull_request' }}\n"
    )
    expect(workflow).not.toContain("github.sha)")
    expect(render({ ...goldenAttrs, cancelInProgress: false })).toContain("cancel-in-progress: false")
  })

  it("defaults to ref concurrency and renders explicit ref identically", () => {
    expect(render({ ...goldenAttrs, concurrency: "ref" })).toBe(render(goldenAttrs))
  })

  it("isolates commit concurrency by workflow, event, ref, and sha without cancellation", () => {
    for (const cancelInProgress of [true, false]) {
      const source = render({ ...goldenAttrs, concurrency: "commit", cancelInProgress })
      parseWorkflow(source)
      const workflow = Yaml.parse(source) as { concurrency: { group: string; "cancel-in-progress": boolean } }
      const group = workflow.concurrency.group
      expect(group).toBeDefined()
      for (const context of ["github.workflow", "github.event_name", "github.ref", "github.sha"]) {
        expect(group).toContain(context)
      }
      expect(workflow.concurrency["cancel-in-progress"]).toBe(false)
      expect(group).not.toContain("github.event.pull_request.number")
      expect(group).not.toBe((Yaml.parse(render(goldenAttrs)) as { concurrency: { group: string } }).concurrency.group)
    }
  })

  it("rejects unsupported concurrency through the schema and direct renderer", () => {
    for (const concurrency of ["branch", "", "sha", 42]) {
      expect(() => attrsOf({ ...goldenAttrs, concurrency })).toThrow()
      expect(() => render({ ...goldenAttrs, concurrency } as never)).toThrow(/concurrency must be ref or commit/)
    }
  })
})

describe("CI token permissions", () => {
  it("grants every job read-only repository contents and nothing more", () => {
    const workflow = render(goldenAttrs)
    // Without a permissions block every job gets the repository's default
    // token, which may write; no generated job writes through it.
    expect(workflow).toContain("\npermissions:\n  contents: read\njobs:\n")
    expect(workflow.match(/^\s*permissions:/gm)).toEqual(["permissions:"])
    expect(workflow).not.toMatch(/:\s*write\b|id-token/)
  })
})

describe("independent gate steps", () => {
  it("runs every gate after a red one, but never after failed setup", () => {
    const workflow = parseWorkflow(render(goldenAttrs))
    const isGate = (step: { readonly run?: string | undefined }): boolean => step.run?.includes(" smthrs ") === true
    for (const job of workflow.jobs) {
      const first = job.steps.findIndex(isGate)
      const gates = job.steps.filter(isGate)
      // A red `//packages/...` step must not hide a later drift gate (#2071),
      // and `!cancelled()` alone would also run the gates over a failed install.
      expect(gates.map((step) => step.condition)).toEqual(gates.map(() => independentGate))
      // The setup step the gates read is the last step before them, and runs
      // under the implicit success(), so any earlier setup failure skips it.
      expect(job.steps[first - 1]).toMatchObject({ id: "setup", condition: undefined })
      expect(job.steps.filter((step) => step.id === "setup")).toHaveLength(1)
      expect(job.steps.slice(0, first).map((step) => step.condition))
        .toEqual(job.steps.slice(0, first).map(() => undefined))
    }
    expect(workflow.jobs.find((job) => job.id === "test")!.steps.filter(isGate).length).toBeGreaterThan(1)
  })
})

describe("CiToolchain.Needs", () => {
  it("defaults to no runtime setup and preserves an explicit ripgrep pin", () => {
    expect(CiToolchain.Needs()).toMatchObject({ install: true, runtimes: [], submodules: false })
    const ripgrep = CiToolchain.Ripgrep({ release: "14.1.1" })
    expect(CiToolchain.Needs({ ripgrep }).ripgrep).toEqual(ripgrep)
  })

  it.skipIf(process.platform === "win32").each(["Linux", "Darwin", "MINGW64_NT-10.0", "MSYS_NT-10.0"])(
    "installs declared native tools outside the checkout and exports their absolute paths on %s",
    async (platform) => {
      const root = await Fs.mkdtemp(NodePath.join(tmpdir(), "ci native tools "))
      try {
        const bin = NodePath.join(root, "bin")
        const runnerTemp = NodePath.join(root, "runner temp")
        await Fs.mkdir(bin)
        await Fs.mkdir(runnerTemp)
        await Fs.writeFile(NodePath.join(root, "env"), "")
        await Fs.writeFile(NodePath.join(bin, "uname"), `#!/bin/sh\nprintf '%s\\n' '${platform}'\n`, { mode: 0o755 })
        await Fs.writeFile(
          NodePath.join(bin, "cygpath"),
          "#!/bin/sh\nprintf '%s\\n' \"$*\" > cygpath-args\nprintf 'C:/native helper/native-helper.exe\\n'\n",
          { mode: 0o755 }
        )
        await Fs.writeFile(NodePath.join(bin, "rustup"), "#!/bin/sh\nprintf '%s\\n' \"$*\" >> rustup-args\n", {
          mode: 0o755
        })
        await Fs.writeFile(
          NodePath.join(bin, "cargo"),
          "#!/bin/sh\nprintf '%s\\n' \"$*\" >> cargo-args\nmkdir -p target/debug\nprintf '#!/bin/sh\\nexit 0\\n' > target/debug/native-helper\ncp target/debug/native-helper target/debug/native-helper.exe\n",
          { mode: 0o755 }
        )
        const job = {
          ...goldenAttrs.jobs[0]!,
          toolchain: CiToolchain.Needs({
            cargoBinaries: [{
              package: "native-package",
              binary: "native-helper",
              toolchain: "1.98.0",
              environment: "NATIVE_HELPER",
              platforms: ["linux", "darwin", "win32"]
            }]
          })
        }
        const step = toolchainSteps(goldenAttrs, job).find((step) => step.name === "Install native native-helper")!
        const result = spawnSync("/bin/bash", ["--noprofile", "--norc", "-e", "-c", step.run!], {
          cwd: root,
          env: {
            // Use the system shell, bypassing runner-installed bash wrappers.
            // Only the declared shim search path belongs to this fixture.
            PATH: `${bin}:${process.env.PATH}`,
            RUNNER_TEMP: runnerTemp,
            GITHUB_ENV: NodePath.join(root, "env")
          },
          encoding: "utf8"
        })
        expect(result.stderr).toBe("")
        expect(result.status).toBe(0)
        const windows = platform.startsWith("MINGW") || platform.startsWith("MSYS")
        const installed = NodePath.join(runnerTemp, `smithers-native/native-helper${windows ? ".exe" : ""}`)
        expect(await Fs.readFile(NodePath.join(root, "env"), "utf8")).toBe(
          `NATIVE_HELPER=${windows ? "C:/native helper/native-helper.exe" : installed}\n`
        )
        if (windows) expect(await Fs.readFile(NodePath.join(root, "cygpath-args"), "utf8")).toBe(`-w ${installed}\n`)
        expect(spawnSync(installed).status).toBe(0)
        expect(await Fs.readFile(NodePath.join(root, "rustup-args"), "utf8")).toBe(
          "toolchain install 1.98.0 --profile minimal\n"
        )
        expect(await Fs.readFile(NodePath.join(root, "cargo-args"), "utf8")).toBe(
          "+1.98.0 build --locked -p native-package --bin native-helper\n"
        )
      } finally {
        await Fs.rm(root, { recursive: true, force: true })
      }
    }
  )
})

/** Any `if:` other than the one every independent gate step carries. */
const otherCondition = new RegExp(`if: (?!${independentGate.replace(/[$()[\]{}|.*+?^\\]/g, "\\$&")}$)`, "m")

/** The golden pipeline `write` mode renders. */
const goldenAttrs = {
  packageManager,
  workflowName: "CI",
  pushBranches: ["main"],
  pullRequest: true,
  workflowDispatch: true,
  cancelInProgress: true,
  requiredJobs: [],
  gates: [
    { name: "workspace graph", verb: Verb.Test, pattern: "//packages/...", job: "test" },
    { name: "browser contract", verb: Verb.Test, pattern: "//scripts:browserContract", job: "browser" }
  ],
  jobs: [
    {
      id: "test",
      name: "workspace graph",
      runsOn: "ubuntu-latest",
      toolchain: CiToolchain.Needs({
        runtimes: [node],
        jj: CiToolchain.Jj({ release: "0.39.0" }),
        workflowLint: CiToolchain.Actionlint({ release: "1.7.11", workflows: [".github/workflows/ci.yml"] })
      }),
      steps: [
        { name: "Workspace targets", verb: Verb.Ci, pattern: "//packages/...", parallelism: 2 },
        { name: "Script gates", verb: Verb.Test, pattern: "//scripts/..." }
      ]
    },
    {
      id: "browser",
      runsOn: "ubuntu-latest",
      timeoutMinutes: 10,
      toolchain: CiToolchain.Needs({ runtimes: [node] }),
      steps: [{ name: "Browser bundle guard", verb: Verb.Test, pattern: "//scripts:browserContract" }]
    },
    {
      id: "rust",
      runsOn: "ubuntu-latest",
      continueOnError: false,
      toolchain: CiToolchain.Needs({ submodules: true, runtimes: [bareNode], rust }),
      steps: [{ name: "Cargo gates", verb: Verb.Lint, pattern: "//crates/flows-jj" }]
    }
  ],
  output: ".github/workflows/generated.yml",
  mode: "write" as const
}

const golden = `name: "CI"
on:
  push:
    branches: ["main"]
  pull_request:
  workflow_dispatch:
concurrency:
  group: \${{ github.workflow }}-\${{ github.event_name == 'pull_request' && format('pr-{0}', github.event.pull_request.number) || github.ref }}
  cancel-in-progress: \${{ github.event_name == 'pull_request' }}
permissions:
  contents: read
jobs:
  "test":
    name: "workspace graph"
    runs-on: "ubuntu-latest"
    steps:
      - uses: "actions/checkout@11d5960a326750d5838078e36cf38b85af677262"
        with:
          "persist-credentials": "false"
      - name: "Validate GitHub Actions workflows"
        uses: "docker://rhysd/actionlint@sha256:6f03470d0152251d7f07f7c4dc019dbe7024c72cd952f839544c7798843efa8f"
        with:
          "args": ".github/workflows/ci.yml"
      - uses: "pnpm/action-setup@0977fd99725f1db4007ccb2928dbb4e90d06cc86"
      - uses: "actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020"
        with:
          "node-version": "26.4.0"
          "cache": "pnpm"
      - run: "pnpm install --frozen-lockfile --ignore-scripts"
      - name: "Install jj"
        uses: "taiki-e/install-action@e67fa11c4b9316fa714ddf0abed07a0c3143b95b"
        with:
          "tool": "jj-cli@0.39.0"
      - name: "Initialize colocated jj repository"
        id: setup
        run: "jj git init --colocate"
      - name: "Workspace targets"
        if: \${{ !cancelled() && steps.setup.conclusion == 'success' }}
        run: "pnpm exec smthrs ci '//packages/...' --jobs 2 --verbose"
      - name: "Script gates"
        if: \${{ !cancelled() && steps.setup.conclusion == 'success' }}
        run: "pnpm exec smthrs test '//scripts/...' --verbose"
  "browser":
    runs-on: "ubuntu-latest"
    timeout-minutes: 10
    steps:
      - uses: "actions/checkout@11d5960a326750d5838078e36cf38b85af677262"
        with:
          "persist-credentials": "false"
      - uses: "pnpm/action-setup@0977fd99725f1db4007ccb2928dbb4e90d06cc86"
      - uses: "actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020"
        with:
          "node-version": "26.4.0"
          "cache": "pnpm"
      - id: setup
        run: "pnpm install --frozen-lockfile --ignore-scripts"
      - name: "Browser bundle guard"
        if: \${{ !cancelled() && steps.setup.conclusion == 'success' }}
        run: "pnpm exec smthrs test '//scripts:browserContract' --verbose"
  "rust":
    runs-on: "ubuntu-latest"
    continue-on-error: false
    steps:
      - uses: "actions/checkout@11d5960a326750d5838078e36cf38b85af677262"
        with:
          "persist-credentials": "false"
          "submodules": "recursive"
      - uses: "pnpm/action-setup@0977fd99725f1db4007ccb2928dbb4e90d06cc86"
      - uses: "actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020"
        with:
          "node-version": "26.4.0"
      - run: "pnpm install --frozen-lockfile --ignore-scripts"
      - name: "Install pinned Rust toolchain"
        run: "rustup toolchain install"
      - id: setup
        uses: "Swatinem/rust-cache@6323deb102c322ba6fcbdcafc7e3dddab59af2b6"
      - name: "Cargo gates"
        if: \${{ !cancelled() && steps.setup.conclusion == 'success' }}
        run: "pnpm exec smthrs lint '//crates/flows-jj' --verbose"
`

const attrsOf = (input: unknown): never => GithubCiGen(input as typeof goldenAttrs)[Target.TargetTypeId].attrs as never

/** The Effect AST node shapes the attrs are built from. Every other node is a leaf. */
interface AstNode {
  readonly _tag: string
  readonly literal?: unknown
  readonly propertySignatures?: ReadonlyArray<{ readonly name: PropertyKey; readonly type: AstNode }>
  readonly indexSignatures?: ReadonlyArray<{ readonly type: AstNode }>
  readonly elements?: ReadonlyArray<AstNode>
  readonly rest?: ReadonlyArray<AstNode>
  readonly types?: ReadonlyArray<AstNode>
  readonly thunk?: () => AstNode
}

/** The nodes one AST node contains. */
const children = (node: AstNode): ReadonlyArray<AstNode> => [
  ...(node.propertySignatures ?? []).map((property) => property.type),
  ...(node.indexSignatures ?? []).map((signature) => signature.type),
  ...(node.elements ?? []),
  ...(node.rest ?? []),
  ...(node.types ?? []),
  ...(node.thunk === undefined ? [] : [node.thunk()])
]

/**
 * Every field a schema declares, at any depth, as `[name, type]`.
 *
 * The walk starts at the AST rather than at the schema value: `Schema.Struct`
 * returns a callable, so a traversal that rejects everything whose `typeof` is
 * not `"object"` finds no field at all and makes the rule below vacuous.
 */
const fieldsOf = (schema: { readonly ast: unknown }): ReadonlyArray<readonly [string, AstNode]> => {
  const seen = new Set<AstNode>()
  const walk = (node: AstNode): ReadonlyArray<readonly [string, AstNode]> => {
    if (seen.has(node)) return []
    seen.add(node)
    return [
      ...(node.propertySignatures ?? []).map((property) => [String(property.name), property.type] as const),
      ...children(node).flatMap(walk)
    ]
  }
  return walk(schema.ast as AstNode)
}

/** Whether a type can hold a string at any depth, which is what a command needs. */
const holdsString = (node: AstNode, seen = new Set<AstNode>()): boolean => {
  if (seen.has(node)) return false
  seen.add(node)
  if (node._tag === "String") return true
  if (node._tag === "Literal") return typeof node.literal === "string"
  return children(node).some((child) => holdsString(child, seen))
}

describe("the declaration surface", () => {
  /**
   * Will's ruling, 2026-08-19: "We should never ever ever ever ever in a
   * PACKAGE.ts file hardcode bash commands like this to run node scripts or even
   * run node --test. It needs to be a real target."
   *
   * The rule is enforced by the schema, not by review. A step declares a verb
   * and a target pattern; there is no `run`, no `uses`, no `command`, no
   * `script`, and no `args` anywhere in the attrs, so a gate that is not a
   * target cannot reach the pipeline at all. Adding one back would fail here.
   */
  it("admits no free-form command anywhere in the attrs", () => {
    const declared = fieldsOf(Attrs)
    // A positive control first: the walk reaches the nested shapes, so an empty
    // result cannot make the rule below pass by finding nothing.
    expect(declared.map(([name]) => name)).toEqual(
      expect.arrayContaining(["jobs", "steps", "pattern", "verb", "toolchain", "gates"])
    )
    // And a command smuggled two levels down is found, not only a top-level one.
    expect(
      fieldsOf(Schema.Struct({ jobs: Schema.Array(Schema.Struct({ command: Schema.String })) }))
        .map(([name]) => name)
    ).toEqual(["jobs", "command"])
    const forbidden = [
      "run",
      "uses",
      "command",
      "commands",
      "script",
      "shell",
      "args",
      "argv",
      "install",
      "entrypoint"
    ]
    const suspects = declared.filter(([name]) => forbidden.includes(name))
    // `install` is a toolchain's "run the package manager" toggle, the one
    // command-shaped name in the tree, and a boolean cannot carry a script.
    expect(suspects.map(([name, type]) => [name, type._tag])).toEqual([["install", "Boolean"]])
    expect(suspects.filter(([, type]) => holdsString(type)).map(([name]) => name)).toEqual([])
    // The two things a step CAN say, and nothing else.
    expect(Object.keys(TargetStep.fields).sort()).toEqual(["name", "parallelism", "pattern", "secrets", "verb"])
    // A gate is a target invocation too, not a command to match in the text.
    expect(Object.keys(Gate.fields).sort()).toEqual(["job", "name", "pattern", "verb"])
    // A job says what it requires and what it runs.
    expect(Object.keys(Job.fields).sort())
      .toEqual([
        "continueOnError",
        "environment",
        "id",
        "matrix",
        "name",
        "needs",
        "permissions",
        "publishesToCache",
        "runsOn",
        "steps",
        "timeoutMinutes",
        "toolchain"
      ])
  })

  it("refuses a step whose verb is not a CLI verb value", () => {
    expect(() =>
      GithubCiGen({
        ...goldenAttrs,
        gates: [],
        jobs: [{
          id: "test",
          runsOn: "ubuntu-latest",
          toolchain: CiToolchain.Needs({ runtimes: [node] }),
          steps: [{ verb: { name: "curl" }, pattern: "//..." }]
        }]
      } as never)
    ).toThrow()
  })

  it("keeps the review verb out of the ci aggregate while giving it a value", () => {
    // `review` is a verb a pipeline may declare and the aggregate `ci` never
    // plans. A model call needs a full-history checkout, a model binary, and a
    // credential, none of which the unattended `ci` verb has, so the reviews
    // are asked for by name or not at all.
    expect(Verb.Review).toEqual({ name: "review" })
    expect(Verb.kind(Verb.Review)).toBe("review")
    expect(Verb.command(Verb.Review)).toBe("review")
    expect(Verb.isVerb(Verb.Review)).toBe(true)
    expect(Verb.isPipelineVerb(Verb.Review)).toBe(true)
    expect(Verb.all).not.toContain(Verb.Review)
  })

  it("keeps explicit Run separate from the aggregate verbs", () => {
    expect(Verb.Run).toEqual({ name: "run" })
    expect(Verb.all.map(Verb.kind)).toEqual(["build", "test", "lint", "docs"])
    expect(Verb.isPipelineVerb(Verb.Run)).toBe(true)
    expect(Verb.isVerb(Verb.Run)).toBe(false)
    expect(Verb.isPipelineVerb(Verb.Ci)).toBe(true)
    expect(Verb.isVerb(Verb.Ci)).toBe(false)
  })
})

describe("renderStep", () => {
  it("closes a nameless block scalar before the field that follows it", () => {
    // A step with a `name` puts `run: |` in the middle of its fields, which
    // every current job does. A step without one puts it first, and the body
    // has to follow it there too: emitted last, the script would land under
    // `shell:` and YAML would read an empty `run` and a three-line `shell`.
    const lines = renderStep({ run: "a\nb", shell: "bash" }, "      ")
    expect(lines).toEqual(["      - run: |", "          a", "          b", "        shell: \"bash\""])
    const steps = parseWorkflow(["jobs:", "  probe:", "    runs-on: ubuntu-latest", "    steps:", ...lines].join("\n"))
      .jobs[0]!.steps
    expect(steps.map((step) => [step.run, step.shell])).toEqual([["a\nb", "bash"]])
  })

  it("refuses a step that declares nothing to run", () => {
    // Every field is optional on the rendered shape, so a caller can build a
    // step that names no action at all. YAML would accept the empty item and
    // the job would silently do nothing, so the renderer refuses it instead.
    expect(() => renderStep({}, "      ")).toThrow("a CI step must declare uses or run")
  })

  it("keeps a named multi-line script under its own key", () => {
    const lines = renderStep({ name: "Probe", run: "a\nb", shell: "bash" }, "      ")
    expect(lines).toEqual([
      "      - name: \"Probe\"",
      "        run: |",
      "          a",
      "          b",
      "        shell: \"bash\""
    ])
    const steps = parseWorkflow(["jobs:", "  probe:", "    runs-on: ubuntu-latest", "    steps:", ...lines].join("\n"))
      .jobs[0]!.steps
    expect(steps.map((step) => [step.name, step.run, step.shell])).toEqual([["Probe", "a\nb", "bash"]])
  })
})

describe("render", () => {
  it("matches the golden multi-job pipeline byte for byte", () => {
    expect(render(attrsOf(goldenAttrs))).toBe(golden)
  })

  it("renders output the workflow reader can read back", () => {
    const workflow = parseWorkflow(golden)
    expect(workflow.jobs.map((job) => job.id)).toEqual(["test", "browser", "rust"])
  })

  it("derives the install from the declared package manager, never from an attr", () => {
    expect(golden).toContain("      - run: \"pnpm install --frozen-lockfile --ignore-scripts\"\n")
    // Every job that runs a target installs first, because the workspace binary
    // is what runs the target.
    for (const job of parseWorkflow(golden).jobs) {
      const commands = job.steps.map((step) => step.run ?? step.uses ?? "")
      expect(commands.findIndex((command) => command.startsWith("pnpm install --frozen-lockfile")))
        .toBeLessThan(commands.findIndex((command) => command.startsWith("pnpm exec smthrs")))
    }
  })

  it("passes a declared known-red list to every target step, and none when undeclared", () => {
    expect(golden).not.toContain("--known-red")
    const rendered = render(attrsOf({ ...goldenAttrs, knownRed: ".github/ci-known-red.json" }))
    const steps = parseWorkflow(rendered).jobs.flatMap((job) => job.steps.map((step) => step.run ?? ""))
      .filter((command) => command.startsWith("pnpm exec smthrs"))
    expect(steps.length).toBeGreaterThan(1)
    for (const command of steps) {
      expect(command).toMatch(/ --known-red '\.github\/ci-known-red\.json' --verbose$/)
    }
  })

  it("writes per-step results files and uploads them per job, attempt and matrix leg only when declared", () => {
    expect(golden).not.toContain("--results-file")
    expect(golden).not.toContain("smthrs-results")
    const text = render(attrsOf({ ...goldenAttrs, results: true }))
    const workflow = parseWorkflow(text)
    for (const job of workflow.jobs) {
      const commands = job.steps.map((step) => step.run ?? "").filter((command) =>
        command.startsWith("pnpm exec smthrs")
      )
      for (const command of commands) {
        expect(command).toMatch(/ --results-file "\$RUNNER_TEMP\/smthrs-results\/\$GITHUB_ACTION\.json" --verbose$/)
      }
      expect(job.steps[0]!.name).toBe("Start smthrs results")
      expect(job.steps[0]!.condition).toBeUndefined()
      expect(job.steps[0]!.shell).toBe("bash")
      expect(job.steps[0]!.run).toContain(`'{"version":1,"results":[]}' > "$RUNNER_TEMP/smthrs-results/attempt.json"`)
      const upload = job.steps.at(-1)!
      expect(upload.name).toBe("Upload smthrs results")
      expect(upload.condition).toBe("always()")
      expect(upload.uses).toMatch(/^actions\/upload-artifact@[0-9a-f]{40}$/)
      // Non-matrix jobs get a literal 0: strategy.job-index is only defined under a matrix.
      expect(text).toMatch(
        new RegExp(
          `smthrs-results-${job.id}-(0|\\$\\{\\{ strategy\\.job-index \\}\\})-\\$\\{\\{ github\\.run_attempt \\}\\}`
        )
      )
    }
    expect(text).toContain("${{ runner.temp }}/smthrs-results")
  })

  it.each(["/etc/list.json", "../list.json", "ci/../list.json", "a list.json", "it's.json", "ci//list.json"])(
    "refuses the known-red path %s",
    (knownRed) => {
      expect(() => render(attrsOf({ ...goldenAttrs, knownRed }))).toThrow(/not a workspace-relative file path/)
    }
  )

  it("runs the workspace-pinned CLI the install put in the tree, never a fetched one", () => {
    expect(render(attrsOf(goldenAttrs))).not.toContain("dlx")
  })

  it("follows the declared package manager into its own workspace runner", () => {
    const bunRuntime = { name: "bun" as const, version: ">=1.4.0" as const, executable: "bun" }
    const rendered = render(attrsOf({
      ...goldenAttrs,
      packageManager: { name: "bun", version: ">=1.4.0", executable: "bun", runtime: bunRuntime }
    }))
    expect(rendered).toContain("      - run: \"bun install --frozen-lockfile --ignore-scripts\"\n")
    expect(rendered).toContain("        run: \"bun x --bun smthrs test '//scripts/...' --verbose\"\n")
    // Bun installs itself; a second manager-setup action would install the same
    // program twice.
    expect(rendered).not.toContain("pnpm/action-setup")
    expect(rendered).toContain(`      - uses: "${actions.setupNode}"
`)
    expect(rendered).not.toContain("\"cache\": \"pnpm\"")
    expect(rendered).not.toMatch(/^\s+cache:/m)
  })

  it("refuses to render a pipeline that drops a declared gate", () => {
    expect(() =>
      render(attrsOf({
        ...goldenAttrs,
        gates: [...goldenAttrs.gates, { name: "wasm reproducibility", verb: Verb.Test, pattern: "//crates/..." }]
      }))
    ).toThrow(/does not run wasm reproducibility/)
    // A gate pinned to the wrong job is not satisfied by the right invocation
    // in another job.
    expect(() =>
      render(attrsOf({
        ...goldenAttrs,
        gates: [{ name: "browser contract", verb: Verb.Test, pattern: "//scripts:browserContract", job: "rust" }]
      }))
    ).toThrow(/does not run browser contract/)
  })

  it("counts the aggregate verb as every verb it plans", () => {
    // `smthrs ci` over //packages/... satisfies a docs gate on the same pattern,
    // because the aggregate command plans the docs verb too.
    expect(
      render(attrsOf({
        ...goldenAttrs,
        gates: [{ name: "documentation parity", verb: Verb.Docs, pattern: "//packages/...", job: "test" }]
      }))
    ).toContain("pnpm exec smthrs ci '//packages/...'")
    // A wider pattern is a different claim and does not satisfy a narrower gate.
    expect(() =>
      render(attrsOf({
        ...goldenAttrs,
        gates: [{ name: "everything", verb: Verb.Test, pattern: "//..." }]
      }))
    ).toThrow(/does not run everything/)
  })

  it("refuses to render with no jobs declared", () => {
    expect(() => render(attrsOf({ ...goldenAttrs, jobs: [], gates: [] }))).toThrow(/at least one declared job/)
  })

  it("refuses to render an inert workflow with no trigger", () => {
    expect(() =>
      render(attrsOf({
        ...goldenAttrs,
        pushBranches: [],
        pullRequest: false,
        workflowDispatch: false
      }))
    ).toThrow(/at least one workflow trigger/)
  })

  it("renders each supported trigger independently", () => {
    const dispatch = render(attrsOf({
      ...goldenAttrs,
      pushBranches: [],
      pullRequest: false,
      workflowDispatch: true
    }))
    expect(dispatch).toContain("  workflow_dispatch:\n")
    expect(dispatch).not.toContain("  push:\n")
    expect(dispatch).not.toContain("  pull_request:\n")

    const push = render(attrsOf({
      ...goldenAttrs,
      pushBranches: ["main"],
      pullRequest: false,
      workflowDispatch: false
    }))
    expect(push).toContain("  push:\n")
    expect(push).not.toContain("  pull_request:\n")
    expect(push).not.toContain("  workflow_dispatch:\n")
  })

  it("omits disabled install, Rust cache, and jj colocation setup steps", () => {
    const attrs = attrsOf({
      ...goldenAttrs,
      gates: [],
      jobs: [{
        id: "test",
        runsOn: "ubuntu-latest",
        toolchain: CiToolchain.Needs({
          install: false,
          rust: CiToolchain.Rust({ toolchain: RustToolchain.Pinned({}), cache: false }),
          jj: CiToolchain.Jj({ release: "0.39.0", colocate: false })
        }),
        steps: [{ verb: Verb.Test, pattern: "//..." }]
      }]
    }) as typeof goldenAttrs
    const steps = toolchainSteps(attrs, attrs.jobs[0]!)
    expect(steps.some((step) => step.run?.startsWith("pnpm install") === true)).toBe(false)
    expect(steps.some((step) => step.uses === actions.rustCache)).toBe(false)
    expect(steps.some((step) => step.run === "jj git init --colocate")).toBe(false)
  })

  it("refuses a job that runs targets without installing the workspace", () => {
    expect(() =>
      render(attrsOf({
        ...goldenAttrs,
        gates: [],
        jobs: [{
          id: "test",
          runsOn: "ubuntu-latest",
          toolchain: CiToolchain.Needs({ install: false, runtimes: [node] }),
          steps: [{ verb: Verb.Test, pattern: "//..." }]
        }]
      }))
    ).toThrow(/declares install: false/)
  })

  it("refuses to render a workflow missing a declared required job", () => {
    expect(() => render(attrsOf({ ...goldenAttrs, requiredJobs: ["test", "wasm-repro"] })))
      .toThrow(/missing required jobs: wasm-repro/)
  })

  it("refuses duplicate job ids rather than emitting a shadowed job", () => {
    expect(() => render(attrsOf({ ...goldenAttrs, jobs: [...goldenAttrs.jobs, goldenAttrs.jobs[2]!] })))
      .toThrow(/duplicate job id "rust"/)
  })

  it("refuses job shapes GitHub Actions rejects", () => {
    const withJobs = (jobs: unknown): never => attrsOf({ ...goldenAttrs, jobs, gates: [] })
    const toolchain = CiToolchain.Needs({ runtimes: [node] })
    const step = { verb: Verb.Test, pattern: "//..." }
    expect(() => render(withJobs([{ id: "test", runsOn: "ubuntu-latest", toolchain, steps: [] }])))
      .toThrow(/runs no targets/)
    expect(() => render(withJobs([{ id: "a b", runsOn: "ubuntu-latest", toolchain, steps: [step] }])))
      .toThrow(/is not a valid job id/)
  })

  it("refuses a timeout GitHub Actions does not run", () => {
    const withTimeout = (timeoutMinutes: number): unknown => ({
      ...goldenAttrs,
      gates: [],
      jobs: [{
        id: "test",
        runsOn: "ubuntu-latest",
        timeoutMinutes,
        toolchain: CiToolchain.Needs({ runtimes: [node] }),
        steps: [{ verb: Verb.Test, pattern: "//..." }]
      }]
    })
    // The schema rejects an out-of-range value at declaration time.
    for (const timeout of [0, -1, 361, 1440, 1.5]) {
      expect(() => GithubCiGen(withTimeout(timeout) as typeof goldenAttrs)).toThrow()
    }
    // `render` is exported, so it checks again rather than trusting its input.
    const constructed = attrsOf(withTimeout(10)) as unknown as Record<string, unknown>
    for (const timeout of [0, -1, 361, 1.5]) {
      expect(() =>
        render({
          ...constructed,
          jobs: [{
            id: "test",
            runsOn: "ubuntu-latest",
            timeoutMinutes: timeout,
            toolchain: CiToolchain.Needs({ runtimes: [node] }),
            steps: [{ verb: Verb.Test, pattern: "//..." }]
          }]
        } as never)
      ).toThrow(/timeout-minutes/)
    }
    // The boundaries themselves render.
    for (const timeout of [1, 360]) {
      expect(render(attrsOf(withTimeout(timeout)))).toContain(`    timeout-minutes: ${timeout}\n`)
    }
  })

  it("revalidates scalar text and CLI verbs at the exported render boundary", () => {
    const constructed = attrsOf({
      ...goldenAttrs,
      gates: [],
      jobs: [{
        id: "test",
        runsOn: "ubuntu-latest",
        toolchain: CiToolchain.Needs({ runtimes: [node] }),
        steps: [{ verb: Verb.Test, pattern: "//..." }]
      }]
    }) as unknown as Record<string, unknown>
    expect(() => render({ ...constructed, workflowName: "CI\u0001broken" } as never)).toThrow(/control character/)
    expect(() =>
      render({
        ...constructed,
        jobs: [{
          id: "test",
          runsOn: "ubuntu-latest",
          toolchain: CiToolchain.Needs({ runtimes: [node] }),
          steps: [{ verb: "deploy", pattern: "//..." }]
        }]
      } as never)
    ).toThrow(/no CLI verb/)
  })

  it("quotes values that would otherwise change the shape of the YAML", () => {
    const rendered = render(attrsOf({
      ...goldenAttrs,
      workflowName: "CI: main",
      pushBranches: ["main", "release: next"],
      jobs: goldenAttrs.jobs.map((job) => job.id !== "rust" ? job : { ...job, runsOn: "${{ matrix.os }}" })
    }))
    expect(rendered).toContain("name: \"CI: main\"\n")
    expect(rendered).toContain("    branches: [\"main\", \"release: next\"]\n")
    expect(rendered).toContain("    runs-on: \"${{ matrix.os }}\"\n")
    expect(parseWorkflow(rendered).name).toBe("CI: main")
    // A label set is a YAML sequence GitHub reads, so it is not quoted into one
    // nonexistent label.
    expect(
      render(attrsOf({
        ...goldenAttrs,
        jobs: goldenAttrs.jobs.map((job) => job.id !== "rust" ? job : { ...job, runsOn: "[self-hosted, linux]" })
      }))
    ).toContain("    runs-on: [\"self-hosted\", \"linux\"]\n")
  })

  it("keeps every declared string a YAML string", () => {
    const ambiguous = ["true", "false", "null", "yes", "no", "on", "off", "y", "n", "~", "NULL", "Off"]
    for (const value of ambiguous) {
      const rendered = render(attrsOf({ ...goldenAttrs, gates: [], workflowName: value }))
      expect({ value, line: rendered.split("\n")[0] }).toEqual({ value, line: `name: ${JSON.stringify(value)}` })
    }
    for (const value of ["22", "1.5", "1e5", "0x1A", "0777", "12:30", "2026-08-14", ".inf", "-1"]) {
      const rendered = render(attrsOf({
        ...goldenAttrs,
        gates: [],
        pushBranches: [value],
        jobs: goldenAttrs.jobs.map((job) => job.id !== "rust" ? job : { ...job, name: value })
      }))
      expect({ value, rendered: rendered.includes(`    branches: [${JSON.stringify(value)}]\n`) })
        .toEqual({ value, rendered: true })
      expect({ value, rendered: rendered.includes(`    name: ${JSON.stringify(value)}\n`) })
        .toEqual({ value, rendered: true })
    }
    // A runner that resolves to a boolean is a `runs-on` GitHub rejects, and a
    // reserved label inside a label SET drops silently out of the set.
    expect(
      render(attrsOf({
        ...goldenAttrs,
        jobs: goldenAttrs.jobs.map((job) => job.id !== "rust" ? job : { ...job, runsOn: "false" })
      }))
    ).toContain("    runs-on: \"false\"\n")
    expect(
      render(attrsOf({
        ...goldenAttrs,
        jobs: goldenAttrs.jobs.map((job) => job.id !== "rust" ? job : { ...job, runsOn: "[self-hosted, null]" })
      }))
    ).toContain("    runs-on: [\"self-hosted\", \"null\"]\n")
  })

  it("refuses a runs-on collection it cannot render as the label set it declares", () => {
    const withRunner = (runsOn: string): never =>
      attrsOf({
        ...goldenAttrs,
        gates: [],
        jobs: [{
          id: "test",
          runsOn,
          toolchain: CiToolchain.Needs({ runtimes: [node] }),
          steps: [{ verb: Verb.Test, pattern: "//..." }]
        }]
      })
    for (const runsOn of ["[self-hosted, my label]", "{group: ubuntu, labels: [x]}", "[self-hosted,]", "[]"]) {
      expect(() => render(withRunner(runsOn))).toThrow(/is not a runner label set/)
    }
    expect(render(withRunner("[self-hosted, linux]"))).toContain("    runs-on: [\"self-hosted\", \"linux\"]\n")
  })

  /**
   * The generated steps are the only thing the pipeline runs. `--help` made one
   * a usage message that exits 0 — a green pipeline that built and tested
   * nothing — and `*` reached the runner's shell to be expanded against the
   * checkout.
   */
  it("refuses a pattern that is not the CLI's label grammar", () => {
    for (
      const pattern of [
        "--help",
        "-h",
        "*",
        "//*",
        "//packages/*",
        "//packages/*:build",
        "...",
        "packages/smithers/flows/core",
        "//",
        "//..",
        "//packages/../../etc",
        "//packages//core",
        "//packages/smithers/flows/core:",
        "//packages/smithers/flows/core/...:",
        "//packages/smithers/flows/core/...:a:b",
        "//packages/smithers/flows/core/...:--help",
        "//packages/../...:build",
        "//packages/smithers/flows/core:a:b",
        "//packages/smithers/flows/core:--help",
        "//packages/smithers/flows/core build",
        "//packages/smithers/flows/core;rm -rf /",
        "//packages/smithers/flows/core'",
        "//... && curl example.test"
      ]
    ) {
      const attrs = attrsOf({
        ...goldenAttrs,
        gates: [],
        jobs: [{
          id: "test",
          runsOn: "ubuntu-latest",
          toolchain: CiToolchain.Needs({ runtimes: [node] }),
          steps: [{ verb: Verb.Test, pattern }]
        }]
      })
      const message = (() => {
        try {
          render(attrs)
          return "rendered"
        } catch (cause) {
          return (cause as Error).message
        }
      })()
      expect({ pattern, refused: message.includes("is not a target pattern") }).toEqual({ pattern, refused: true })
    }
  })

  it("renders every supported pattern as one quoted shell word", () => {
    // `//packages/...:bunTest` is the recursive pattern narrowed to one target
    // name: the Bun matrix is the packages that declare the key, so the step
    // names the key instead of a central file listing the packages.
    for (
      const pattern of [
        "//...",
        "//packages/...",
        "//packages/smithers/flows/core",
        "//packages/smithers/flows/core:build",
        "//:ci",
        "//...:bunTest",
        "//packages/...:bunTest"
      ]
    ) {
      const rendered = render(attrsOf({
        ...goldenAttrs,
        gates: [],
        jobs: [{
          id: "test",
          runsOn: "ubuntu-latest",
          toolchain: CiToolchain.Needs({ runtimes: [node] }),
          steps: [{ verb: Verb.Test, pattern }]
        }]
      }))
      expect(rendered).toContain(`      - if: \${{ !cancelled() && steps.setup.conclusion == 'success' }}
        run: "pnpm exec smthrs test '${pattern}' --verbose"
`)
      expect(parseWorkflow(rendered).jobs[0]!.steps.map((step) => step.run))
        .toContain(`pnpm exec smthrs test '${pattern}' --verbose`)
    }
  })

  it("refuses a parallelism no runner could honour", () => {
    for (const parallelism of [0, -1, 257, 1.5]) {
      expect(() =>
        GithubCiGen({
          ...goldenAttrs,
          gates: [],
          jobs: [{
            id: "test",
            runsOn: "ubuntu-latest",
            toolchain: CiToolchain.Needs({ runtimes: [node] }),
            steps: [{ verb: Verb.Test, pattern: "//...", parallelism }]
          }]
        } as never)
      ).toThrow()
    }
    const constructed = attrsOf({
      ...goldenAttrs,
      gates: [],
      jobs: [{
        id: "test",
        runsOn: "ubuntu-latest",
        toolchain: CiToolchain.Needs({ runtimes: [node] }),
        steps: [{ verb: Verb.Test, pattern: "//..." }]
      }]
    }) as unknown as Record<string, unknown>
    for (const parallelism of [0, -1, 257, 1.5]) {
      expect(() =>
        render({
          ...constructed,
          jobs: [{
            id: "test",
            runsOn: "ubuntu-latest",
            toolchain: CiToolchain.Needs({ runtimes: [node] }),
            steps: [{ verb: Verb.Test, pattern: "//...", parallelism }]
          }]
        } as never)
      ).toThrow(/parallelism/)
    }
  })

  it("emits only verbs the CLI actually defines", async () => {
    const cli = await Fs.readFile(NodePath.resolve(import.meta.dirname, "../../build-cli/src/Cli.ts"), "utf8")
    const commands = new Set([...cli.matchAll(/\.command\("([\w-]+)"/g)].map((match) => match[1]!))
    expect(commands.size).toBeGreaterThan(0)
    expect(Verb.all.map(Verb.kind).filter((verb) => !commands.has(verb))).toEqual([])
    expect(commands.has("ci")).toBe(true)
    // `review` is not in `Verb.all` — `ci` does not aggregate it — so the
    // command it names is asserted on its own.
    expect(commands.has(Verb.command(Verb.Review))).toBe(true)
    const emitted = new Set<string>()
    for (const verb of [...Verb.all, Verb.Ci]) {
      const rendered = render(attrsOf({
        ...goldenAttrs,
        gates: [],
        jobs: [{
          id: "test",
          runsOn: "ubuntu-latest",
          toolchain: CiToolchain.Needs({ runtimes: [node] }),
          steps: [{ verb, pattern: "//..." }]
        }]
      }))
      for (const [, emittedVerb] of rendered.matchAll(/pnpm exec smthrs ([\w-]+) /g)) emitted.add(emittedVerb!)
    }
    expect([...emitted].filter((verb) => !commands.has(verb))).toEqual([])
  })

  it("refuses to render review on a candidate checkout outside a trusted review host", () => {
    expect(() =>
      render(attrsOf({
        ...goldenAttrs,
        gates: [],
        jobs: [{
          id: "review",
          runsOn: "ubuntu-latest",
          toolchain: CiToolchain.Needs({ runtimes: [node] }),
          steps: [{ verb: Verb.Review, pattern: "//..." }]
        }]
      }))
    ).toThrow(/trusted review host/)
  })

  it("renders the declared checkout depth, beside submodules and never on its own default", () => {
    // `actions/checkout` fetches ONE commit by default, which leaves a pull
    // request with no `refs/remotes/origin/main`. A target expanding
    // `Smithers.gitDiff("origin/main")` then dies at plan time with
    // `bad revision`, taking every target in the same invocation with it. The
    // job that runs those targets declares the depth it needs; every other job
    // keeps its default history depth and disabled credential persistence.
    const withDepth = render(attrsOf({
      ...goldenAttrs,
      gates: [],
      jobs: [{
        id: "deep-history",
        runsOn: "ubuntu-latest",
        continueOnError: true,
        toolchain: CiToolchain.Needs({ runtimes: [node], fetchDepth: 0 }),
        steps: [{ name: "Full history tests", verb: Verb.Test, pattern: "//..." }]
      }]
    }))
    expect(withDepth).toContain(
      `      - uses: "${actions.checkout}"
        with:
          "persist-credentials": "false"
          "fetch-depth": "0"
`
    )
    expect(withDepth).toContain("        run: \"pnpm exec smthrs test '//...' --verbose\"\n")

    const both = render(attrsOf({
      ...goldenAttrs,
      gates: [],
      jobs: [{
        id: "deep",
        runsOn: "ubuntu-latest",
        toolchain: CiToolchain.Needs({ runtimes: [node], submodules: true, fetchDepth: 50 }),
        steps: [{ verb: Verb.Test, pattern: "//..." }]
      }]
    }))
    expect(both).toContain(
      `      - uses: "${actions.checkout}"
        with:
          "persist-credentials": "false"
          "submodules": "recursive"
          "fetch-depth": "50"
`
    )

    const bare = render(attrsOf({
      ...goldenAttrs,
      gates: [],
      jobs: [{
        id: "shallow",
        runsOn: "ubuntu-latest",
        toolchain: CiToolchain.Needs({ runtimes: [node] }),
        steps: [{ verb: Verb.Test, pattern: "//..." }]
      }]
    }))
    expect(bare).not.toContain("fetch-depth")
    expect(bare).toContain(`      - uses: "${actions.checkout}"
        with:
          "persist-credentials": "false"
      - uses: "${actions.setupPnpm}"
`)
  })

  it("does not let a ci step satisfy a review gate", () => {
    // `ci` aggregates lint, build, test, and docs, so a `ci` step performs any
    // gate on one of them. It plans no review target at all, so a `ci` step
    // accepted here would be a coverage claim the pipeline never checks.
    const ciStep: Parameters<typeof satisfiesGate>[0] = { verb: Verb.Ci, pattern: "//..." }
    expect(satisfiesGate(ciStep, { name: "docs", verb: Verb.Docs, pattern: "//..." })).toBe(true)
    expect(satisfiesGate(ciStep, { name: "reviews", verb: Verb.Review, pattern: "//..." })).toBe(false)
    expect(
      satisfiesGate({ verb: Verb.Review, pattern: "//..." }, { name: "reviews", verb: Verb.Review, pattern: "//..." })
    ).toBe(true)
    // And the render refuses a pipeline whose only step is the aggregate.
    expect(() =>
      render(attrsOf({
        ...goldenAttrs,
        gates: [{ name: "reviews", verb: Verb.Review, pattern: "//..." }],
        jobs: [{
          id: "test",
          runsOn: "ubuntu-latest",
          toolchain: CiToolchain.Needs({ runtimes: [node] }),
          steps: [{ verb: Verb.Ci, pattern: "//..." }]
        }]
      }))
    ).toThrow(/reviews \(review \/\/\.\.\.\)/)
  })

  it("refuses a checkout depth that is not a whole number of commits", () => {
    for (const fetchDepth of [-1, 1.5]) {
      expect(() => CiToolchain.Needs({ runtimes: [node], fetchDepth })).toThrow(/fetchDepth/)
    }
  })

  it("derives the browser assertion and the artifact upload from declarations", () => {
    const rendered = render(attrsOf({
      ...goldenAttrs,
      gates: [],
      jobs: [{
        id: "e2e",
        runsOn: "ubuntu-latest",
        toolchain: CiToolchain.Needs({
          runtimes: [node],
          browser: CiToolchain.Browser({ executable: "/usr/bin/google-chrome", reason: "the runner image ships it" }),
          artifacts: CiToolchain.Artifacts({
            artifact: "e2e-artifacts",
            sources: [{ from: "/tmp/shot-*.png" }, { from: "apps/reports", as: "reports" }]
          })
        }),
        steps: [{ verb: Verb.Test, pattern: "//apps/app" }]
      }]
    }))
    expect(rendered).toContain("          if [ ! -x '/usr/bin/google-chrome' ]; then\n")
    expect(rendered).toContain("          '/usr/bin/google-chrome' --version\n")
    expect(rendered).toContain("          mkdir -p \"$RUNNER_TEMP/e2e-artifacts\"\n")
    // Each copy is existence-guarded: a green run leaves no screenshots, and an
    // unexpanded glob handed to a bare `cp` fails the whole job (PR #1631).
    expect(rendered).toContain(
      "          for f in '/tmp/shot-'*'.png'; do if [ -e \"$f\" ]; then cp -R -- \"$f\" \"$RUNNER_TEMP/e2e-artifacts\"; fi; done\n"
    )
    // A fixed source needs the existence guard alone. Looping over one quoted
    // literal is SC2041 to the shellcheck actionlint runs, which failed the
    // required job on run 33442975322 at `.github/workflows/ci.yml:123:9`.
    expect(rendered).toContain(
      "          if [ -e 'apps/reports' ]; then cp -R -- 'apps/reports' \"$RUNNER_TEMP/e2e-artifacts/reports\"; fi\n"
    )
    expect(rendered).not.toContain("cp -R -- '/tmp/shot-'*'.png'")
    expect(rendered).not.toContain("2>/dev/null || true")
    expect(rendered).toContain("          \"if-no-files-found\": \"ignore\"\n")
    const steps = parseWorkflow(rendered).jobs.find((job) => job.id === "e2e")!.steps
    expect(steps.filter((step) => step.condition === "always()").map((step) => [step.name, step.condition])).toEqual([
      ["Collect e2e-artifacts", "always()"],
      ["Upload e2e-artifacts", "always()"]
    ])
    expect(steps.find((step) => step.run?.includes("smthrs test"))?.condition).toBe(independentGate)
  })

  it("installs and verifies the certified npm after Node and before workspace gates", () => {
    const rendered = render(attrsOf({
      ...goldenAttrs,
      gates: [],
      jobs: [{
        id: "test",
        runsOn: "ubuntu-latest",
        toolchain: CiToolchain.Needs({ runtimes: [CiToolchain.Node({ release: "26.4.0", npmRelease: "11.16.0" })] }),
        steps: [{ name: "Required gate", verb: Verb.Test, pattern: "//scripts/..." }]
      }]
    }))
    const steps = parseWorkflow(rendered).jobs[0]!.steps
    const nodeIndex = steps.findIndex((step) => step.uses === actions.setupNode)
    const npmIndex = steps.findIndex((step) => step.name === "Install certified npm")
    expect(npmIndex).toBe(nodeIndex + 1)
    expect(steps[npmIndex]!.run).toBe([
      "npm install --global 'npm@11.16.0' --ignore-scripts --no-audit --no-fund",
      "test \"$(npm --version)\" = '11.16.0'"
    ].join("\n"))
    expect(steps[npmIndex]!.shell).toBe("bash")
    expect(steps[npmIndex]!.condition).toBeUndefined()
    expect(npmIndex).toBeLessThan(steps.findIndex((step) => step.name === "Required gate"))
    expect(() => CiToolchain.Node({ release: "26.4.0", npmRelease: "10.9.3" as never })).toThrow()
  })

  it("points setup-node at a version file instead of naming a release", () => {
    // One number, in a file every environment reads: the setup action through
    // `node-version-file`, a shell bootstrap with no Node to parse JSON, and a
    // developer's fnm or nvm. A literal in the workflow is a second place for
    // the same fact to drift.
    const rendered = render(attrsOf({
      ...goldenAttrs,
      gates: [],
      jobs: [{
        id: "test",
        runsOn: "ubuntu-latest",
        toolchain: CiToolchain.Needs({ runtimes: [CiToolchain.Node({ versionFile: ".node-version" })] }),
        steps: [{ name: "Required gate", verb: Verb.Test, pattern: "//scripts/..." }]
      }]
    }))
    expect(rendered).toContain([
      `      - uses: "${actions.setupNode}"`,
      "        with:",
      "          \"node-version-file\": \".node-version\"",
      "          \"cache\": \"pnpm\""
    ].join("\n"))
    expect(rendered).not.toContain("\"node-version\"")
  })

  it("refuses a Node declaration with both sources or neither, or a path off the checkout", () => {
    for (const options of [{}, { release: "26.4.0" as const, versionFile: ".node-version" }]) {
      expect(() => CiToolchain.Node(options)).toThrow(/exactly one of release or versionFile/)
    }
    for (const versionFile of ["/etc/node-version", "../.node-version", "sub/../../escape"]) {
      expect(() => CiToolchain.Node({ versionFile })).toThrow(/workspace-relative/)
    }
  })

  it("refuses a declared path or diagnostic a shell would reinterpret", () => {
    for (const executable of ["/usr/bin/chrome; rm -rf /", "$(which chrome)", "/usr/bin/../../etc/passwd"]) {
      expect(() => CiToolchain.Browser({ executable, reason: "because" })).toThrow(/is not a usable/)
    }
    expect(() =>
      render(attrsOf({
        ...goldenAttrs,
        gates: [],
        jobs: [{
          id: "e2e",
          runsOn: "ubuntu-latest",
          toolchain: {
            ...CiToolchain.Needs({ runtimes: [node] }),
            browser: { executable: "/usr/bin/chrome", reason: "it's `there`" }
          },
          steps: [{ verb: Verb.Test, pattern: "//..." }]
        }]
      }))
    ).toThrow(/not usable as a generated diagnostic/)
  })

  /**
   * The workflow-lint step runs actionlint, and actionlint runs shellcheck over
   * every generated script. A source with no glob rendered
   * `for f in 'apps/reports'; do ...`, one quoted literal as the whole list,
   * which shellcheck reports as SC2041 ("This is a literal string. To run as a
   * command, use $(..) instead of '..'"). That finding failed the required
   * `test` job on run 33442975322 at `.github/workflows/ci.yml:123:9` while the
   * pipeline it lints was otherwise fine.
   *
   * A loop is what a GLOB needs. A fixed path needs the existence guard alone,
   * and gets it.
   */
  it("collects a fixed artifact source without looping over one literal", () => {
    const steps = artifactSteps({
      artifact: "e2e-artifacts",
      sources: [{ from: "/tmp/shot-*.png" }, { from: "apps/reports", as: "reports" }]
    })
    const script = steps[0]!.run!
    expect(script).toContain(
      "if [ -e 'apps/reports' ]; then cp -R -- 'apps/reports' \"$RUNNER_TEMP/e2e-artifacts/reports\"; fi"
    )
    // The glob still needs the loop: `cp` on an unexpanded pattern exits 1.
    expect(script).toContain(
      "for f in '/tmp/shot-'*'.png'; do if [ -e \"$f\" ]; then cp -R -- \"$f\" \"$RUNNER_TEMP/e2e-artifacts\"; fi; done"
    )
    // No `for` loop anywhere whose whole list is a single quoted literal.
    expect(script.split("\n").filter((line) => /^\s*for \w+ in '[^'*]*';/.test(line))).toEqual([])
  })

  it("renders required artifact collection through the workflow declaration", () => {
    const sources = [{ from: "reports/results.xml", required: true }, { from: "shot-*.png" }]
    const rendered = render(attrsOf({
      ...goldenAttrs,
      gates: [],
      jobs: [{
        id: "evidence",
        runsOn: "ubuntu-latest",
        toolchain: CiToolchain.Needs({
          artifacts: CiToolchain.Artifacts({ artifact: "test-evidence", sources })
        }),
        steps: [{ verb: Verb.Test, pattern: "//apps/app" }]
      }]
    }))
    expect(rendered).toContain("\"if-no-files-found\": \"error\"")
    expect(rendered).toContain("Required artifact source is missing: reports/results.xml")
    const steps = parseWorkflow(rendered).jobs.find((job) => job.id === "evidence")!.steps
    expect(steps.filter((step) => step.name?.includes("test-evidence")).map((step) => step.condition))
      .toEqual(["always()", "always()"])
  })

  it.each(["report.txt", "report-*.txt"])("fails collection for a missing required source: %s", async (from) => {
    const directory = await Fs.mkdtemp(NodePath.join(tmpdir(), "required-artifacts-"))
    try {
      // An optional source can populate the upload without satisfying a required source.
      await Fs.writeFile(NodePath.join(directory, "optional.txt"), "diagnostics")
      const sources = [{ from: "optional.txt" }, { from, required: true }]
      const steps = artifactSteps(CiToolchain.Artifacts({ artifact: "evidence", sources }))
      const result = spawnSync("bash", ["-e", "-c", steps[0]!.run!], {
        cwd: directory,
        env: { ...process.env, RUNNER_TEMP: directory },
        encoding: "utf8"
      })
      expect(result.error).toBeUndefined()
      expect(result.status).toBe(1)
      expect(result.stdout + result.stderr).toContain(`Required artifact source is missing: ${from}`)
      expect(steps[1]!.with!["if-no-files-found"]).toBe("error")
    } finally {
      await Fs.rm(directory, { recursive: true, force: true })
    }
  })

  it.each([undefined, false, true])("renders the upload policy for required: %s", (required) => {
    const sources = [{ from: "report.txt", required }]
    const upload = CiToolchain.Artifacts({ artifact: "evidence", sources })
    expect(upload.sources[0]).toEqual(required === undefined ? { from: "report.txt" } : sources[0])
    expect(artifactSteps(upload)[1]!.with!["if-no-files-found"]).toBe(required ? "error" : "ignore")
  })

  it.each([undefined, false, true])("copies present literal and glob sources with required: %s", async (required) => {
    const directory = await Fs.mkdtemp(NodePath.join(tmpdir(), "present-artifacts-"))
    try {
      await Fs.writeFile(NodePath.join(directory, "report.txt"), "report")
      await Fs.writeFile(NodePath.join(directory, "shot-1.txt"), "first")
      await Fs.writeFile(NodePath.join(directory, "shot-2.txt"), "second")
      const sources = [{ from: "report.txt", as: "renamed.txt", required }, { from: "shot-*.txt", required }]
      const script = artifactSteps(CiToolchain.Artifacts({ artifact: "evidence", sources }))[0]!.run!
      const result = spawnSync("bash", ["-e", "-c", script], {
        cwd: directory,
        env: { ...process.env, RUNNER_TEMP: directory },
        encoding: "utf8"
      })
      expect(result.error).toBeUndefined()
      expect(result.status).toBe(0)
      expect(await Fs.readFile(NodePath.join(directory, "evidence/renamed.txt"), "utf8")).toBe("report")
      expect(await Fs.readFile(NodePath.join(directory, "evidence/shot-1.txt"), "utf8")).toBe("first")
      expect(await Fs.readFile(NodePath.join(directory, "evidence/shot-2.txt"), "utf8")).toBe("second")
    } finally {
      await Fs.rm(directory, { recursive: true, force: true })
    }
  })

  it.each([undefined, false])("allows missing optional sources with required: %s", async (required) => {
    const directory = await Fs.mkdtemp(NodePath.join(tmpdir(), "optional-artifacts-"))
    try {
      const sources = [{ from: "report.txt", required }, { from: "shot-*.txt", required }]
      const steps = artifactSteps(CiToolchain.Artifacts({ artifact: "evidence", sources }))
      const result = spawnSync("bash", ["-e", "-c", steps[0]!.run!], {
        cwd: directory,
        env: { ...process.env, RUNNER_TEMP: directory }
      })
      expect(result.error).toBeUndefined()
      expect(result.status).toBe(0)
      expect(await Fs.readdir(NodePath.join(directory, "evidence"))).toEqual([])
      expect(steps[1]!.with!["if-no-files-found"]).toBe("ignore")
    } finally {
      await Fs.rm(directory, { recursive: true, force: true })
    }
  })

  it.each([false, true])("fails when a present source cannot copy with required: %s", async (required) => {
    const directory = await Fs.mkdtemp(NodePath.join(tmpdir(), "failed-artifacts-"))
    try {
      await Fs.writeFile(NodePath.join(directory, "report.txt"), "report")
      const sources = [{ from: "report.txt", as: "missing-parent/report.txt", required }]
      const script = artifactSteps(CiToolchain.Artifacts({ artifact: "evidence", sources }))[0]!.run!
      const result = spawnSync("bash", ["-e", "-c", script], {
        cwd: directory,
        env: { ...process.env, RUNNER_TEMP: directory }
      })
      expect(result.error).toBeUndefined()
      expect(result.status).toBe(1)
    } finally {
      await Fs.rm(directory, { recursive: true, force: true })
    }
  })

  it("allows an artifact declaration with no sources", () => {
    expect(artifactSteps(CiToolchain.Artifacts({ artifact: "evidence", sources: [] }))[1]!.with!["if-no-files-found"])
      .toBe("ignore")
  })

  it("validates artifact values again at the rendering boundary", () => {
    expect(() => artifactSteps({ artifact: "artifacts; touch pwned", sources: [] })).toThrow(/artifact name/)
    expect(() => artifactSteps({ artifact: "artifacts", sources: [{ from: "$(touch pwned)" }] })).toThrow(
      /artifact source/
    )
  })

  it("maps a declared secret onto the repository secret of the same name", () => {
    const rendered = render(attrsOf({
      ...goldenAttrs,
      cacheUrlSecret: Secret("REMOTE_CACHE_URL"),
      cacheTokenSecret: Secret("PROJECT_CACHE_TOKEN")
    }))
    expect(rendered).toContain(
      "          \"REMOTE_CACHE_URL\": \"${{ secrets.REMOTE_CACHE_URL }}\"\n" +
        "          \"PROJECT_CACHE_TOKEN\": \"${{ secrets.PROJECT_CACHE_TOKEN }}\""
    )
  })
})

describe("the split cache credential", () => {
  const readerJob = {
    id: "reader",
    runsOn: "ubuntu-latest",
    toolchain: CiToolchain.Needs({ runtimes: [node] }),
    steps: [{ name: "Workspace targets", verb: Verb.Ci, pattern: "//packages/..." }]
  }
  const publisherJob = {
    id: "publish",
    runsOn: "ubuntu-latest",
    publishesToCache: true,
    toolchain: CiToolchain.Needs({ runtimes: [node] }),
    steps: [{ name: "Warm the cache", verb: Verb.Ci, pattern: "//packages/..." }]
  }
  /** A workflow with the split declared: one untrusted reader, one trunk writer. */
  const splitAttrs = {
    ...goldenAttrs,
    gates: [],
    cacheUrlSecret: Secret("REMOTE_CACHE_URL"),
    cacheTokenSecret: Secret("CACHE_READ_TOKEN"),
    cacheWriteTokenSecret: Secret("CACHE_WRITE_TOKEN"),
    cacheWriteEnvironment: "cache-publish",
    jobs: [readerJob, publisherJob]
  }

  it("renders the write credential and its guard only into the publishing job", () => {
    const rendered = render(attrsOf(splitAttrs))
    const readerBlock = rendered.slice(rendered.indexOf("  \"reader\":"), rendered.indexOf("  \"publish\":"))
    const publishBlock = rendered.slice(rendered.indexOf("  \"publish\":"))
    expect(publishBlock).toContain(
      "    if: ${{ github.event_name == 'push' && github.ref == 'refs/heads/main' }}"
    )
    expect(publishBlock).toContain("          \"CACHE_READ_TOKEN\": \"${{ secrets.CACHE_READ_TOKEN }}\"")
    expect(publishBlock).toContain("          \"CACHE_WRITE_TOKEN\": \"${{ secrets.CACHE_WRITE_TOKEN }}\"")
    // The guard decides whether the job starts; the environment decides
    // whether GitHub hands it the secret, whatever the workflow file says.
    expect(publishBlock).toContain("    environment: \"cache-publish\"")
    // The reader pulls at full speed and can publish nothing: read entries
    // only, no write entry, no guard.
    expect(readerBlock).toContain("          \"CACHE_READ_TOKEN\": \"${{ secrets.CACHE_READ_TOKEN }}\"")
    expect(readerBlock).not.toContain("CACHE_WRITE_TOKEN")
    expect(readerBlock).not.toMatch(/^    if:/m)
    expect(readerBlock).not.toMatch(/^    environment:/m)
    expect(() => parseWorkflow(rendered)).not.toThrow()
  })

  it("namespaces PR publications for shared and split credentials without namespacing trunk", () => {
    for (const attrs of [splitAttrs, { ...goldenAttrs, cacheTokenSecret: Secret("LEGACY_TOKEN") }]) {
      const rendered = render(attrsOf(attrs))
      expect(rendered).toContain(
        "\"SMITHERS_CACHE_NAMESPACE\": \"${{ github.event_name == 'pull_request' && format('pr-{0}', github.event.pull_request.number) || '' }}\""
      )
      expect(render(attrsOf({ ...attrs, pullRequest: false }))).not.toContain("SMITHERS_CACHE_NAMESPACE")
    }
    const rendered = render(attrsOf(splitAttrs))
    expect(rendered.slice(rendered.indexOf("  \"publish\":"))).not.toContain("SMITHERS_CACHE_NAMESPACE")
    expect(render(goldenAttrs)).not.toContain("SMITHERS_CACHE_NAMESPACE")
  })

  it("guards a multi-trunk workflow with one ref clause per push branch", () => {
    const rendered = render(attrsOf({ ...splitAttrs, pushBranches: ["main", "release"] }))
    expect(rendered).toContain(
      "    if: ${{ github.event_name == 'push' && " +
        "(github.ref == 'refs/heads/main' || github.ref == 'refs/heads/release') }}"
    )
  })

  it("refuses a publishing job with no declared write credential", () => {
    const { cacheWriteTokenSecret: _dropped, cacheWriteEnvironment: _environment, ...withoutWrite } = splitAttrs
    expect(() => render(attrsOf(withoutWrite))).toThrow(/no cacheWriteTokenSecret is declared/)
  })

  it("refuses a write credential outside a GitHub environment", () => {
    const { cacheWriteEnvironment: _dropped, ...withoutEnvironment } = splitAttrs
    expect(() => render(attrsOf(withoutEnvironment))).toThrow(/needs cacheWriteEnvironment/)
    expect(() => render(attrsOf({ ...splitAttrs, cacheWriteEnvironment: "${{ github.ref }}" })))
      .toThrow(/needs cacheWriteEnvironment/)
    const { cacheWriteTokenSecret: _write, ...withoutWrite } = splitAttrs
    expect(() => render(attrsOf({ ...withoutWrite, jobs: [readerJob] })))
      .toThrow(/cacheWriteEnvironment is declared but no cacheWriteTokenSecret/)
  })

  it("refuses a declared write credential no job publishes with", () => {
    expect(() => render(attrsOf({ ...splitAttrs, jobs: [readerJob] })))
      .toThrow(/no job declares publishesToCache/)
  })

  it("refuses read and write credentials naming the same variable", () => {
    expect(() => render(attrsOf({ ...splitAttrs, cacheTokenSecret: Secret("CACHE_WRITE_TOKEN") })))
      .toThrow(/name the same variable/)
  })

  it("refuses a publishing job whose guard can never be true", () => {
    // `pullRequest` stays true, so the workflow keeps a trigger and the
    // refusal is the guard's, not the no-trigger throw's.
    expect(() => render(attrsOf({ ...splitAttrs, pushBranches: [] })))
      .toThrow(/guard can never be true/)
  })

  it("refuses a push branch the guard expression cannot carry", () => {
    expect(() => render(attrsOf({ ...splitAttrs, pushBranches: ["b'ranch"] })))
      .toThrow(/cannot be embedded in the publish guard/)
  })

  it("refuses a gate only a publishing job would satisfy", () => {
    // The publishing job is skipped on every pull request, so a gate it alone
    // carries would go unchecked exactly where gates matter.
    const gated = {
      ...splitAttrs,
      gates: [{ name: "workspace graph", verb: Verb.Test, pattern: "//packages/...", job: "publish" }]
    }
    expect(() => render(attrsOf(gated))).toThrow(/does not run workspace graph/)
  })
})

describe("GithubCiGen target wiring", () => {
  const checkingAttrs = {
    workflowName: "CI",
    pushBranches: ["main"],
    pullRequest: true,
    workflowDispatch: true,
    cancelInProgress: true,
    jobs: [],
    requiredJobs: [],
    gates: [],
    output: ".github/workflows/ci.yml",
    packageManager
  }

  it("defaults to the non-mutating check mode", () => {
    const metadata = Target.metadata(GithubCiGen(checkingAttrs) as never)
    expect((metadata.attrs as { readonly mode: string }).mode).toBe("check")
    // The workflow file is a declared input, so editing it re-keys the target.
    expect(metadata.inputs.map((input) => (input as { readonly path: string }).path))
      .toContain("//.github/workflows/ci.yml")
    expect(metadata.cacheable).toBe(true)
  })

  it("maps the lint verb of a writing target to the checking form", () => {
    const metadata = Target.metadata(GithubCiGen({ ...goldenAttrs }) as never)
    expect((metadata.attrs as { readonly mode: string }).mode).toBe("write")
    expect((metadata.forKind("lint").attrs as { readonly mode: string }).mode).toBe("check")
    // A writing target is not cacheable; its checking form is.
    expect(metadata.cacheable).toBe(false)
    expect(metadata.forKind("lint").cacheable).toBe(true)
    expect((metadata.forKind("build").attrs as { readonly mode: string }).mode).toBe("write")
  })

  it("plans the rendered workflow through the declared generated-file mode", () => {
    const writing = plannedCalls(GithubCiGen({ ...goldenAttrs }) as never)
    expect(writing).toEqual([{
      action: "smithers-build/write-file",
      payload: { path: goldenAttrs.output, contents: golden }
    }])

    const checking = plannedCalls(GithubCiGen({ ...goldenAttrs, mode: "check" }) as never)
    expect(checking).toEqual([{
      action: "smithers-build/check-file",
      payload: { path: goldenAttrs.output, contents: golden }
    }])
  })
})

/**
 * One build matrix over the platforms, instead of one copy-pasted job per
 * platform.
 *
 * The generator emits no `if:` key, so a lane that is allowed to be red cannot
 * say so with a condition. It says so with data: each row carries its own
 * `advisory` bit in an `include:` row, and the job's `continue-on-error` reads
 * that bit out of the matrix context. A platform is promoted from advisory to
 * required by flipping one boolean in PACKAGE.ts, which is a diff a reviewer can
 * read, and the promotion is checked — a job listed in `requiredJobs` whose
 * every lane is advisory is refused rather than rendered.
 */
describe("a platform matrix", () => {
  const toolchain = CiToolchain.Needs({ runtimes: [node] })
  const step = { name: "Package test targets", verb: Verb.Test, pattern: "//packages/..." }
  const matrixJob = {
    id: "packages",
    name: "package suites (${{ matrix.os }})",
    matrix: [
      { os: "ubuntu-latest", advisory: false },
      { os: "macos-latest", advisory: true },
      { os: "windows-latest", advisory: true }
    ],
    timeoutMinutes: 60,
    toolchain,
    steps: [step]
  }
  const withMatrixJob = (job: unknown, requiredJobs: ReadonlyArray<string> = []): never =>
    attrsOf({ ...goldenAttrs, gates: [], requiredJobs, jobs: [job] })

  it("renders one job over every declared platform, with the advisory bit as data", () => {
    const rendered = render(withMatrixJob(matrixJob, ["packages"]))
    expect(rendered).toContain(
      "  \"packages\":\n    name: \"package suites (${{ matrix.os }})\"\n    strategy:\n      fail-fast: false\n      matrix:\n        os: [\"ubuntu-latest\", \"macos-latest\", \"windows-latest\"]\n        include:\n          - os: \"ubuntu-latest\"\n            advisory: false\n          - os: \"macos-latest\"\n            advisory: true\n          - os: \"windows-latest\"\n            advisory: true\n    runs-on: ${{ matrix.os }}\n    timeout-minutes: 60\n    continue-on-error: ${{ matrix.advisory }}\n    steps:\n"
    )
    // Every row runs the same steps, rendered once.
    expect(rendered.split("smthrs test '//packages/...'").length - 1).toBe(1)
    // The rule the whole module rests on survives the new key.
    expect(rendered).not.toMatch(otherCondition)
  })

  it("renders deterministically and reads back as one job", () => {
    const rendered = render(withMatrixJob(matrixJob))
    expect(render(withMatrixJob(matrixJob))).toBe(rendered)
    const workflow = parseWorkflow(rendered)
    expect(workflow.jobs.map((job) => job.id)).toEqual(["packages"])
    expect(workflow.jobs[0]!.runsOn).toBe("${{ matrix.os }}")
    expect(workflow.jobs[0]!.condition).toBeUndefined()
    expect(workflow.jobs[0]!.continueOnError).toBe("${{ matrix.advisory }}")
  })

  it("refuses a job that declares both a runner and a matrix, or neither", () => {
    expect(() => render(withMatrixJob({ ...matrixJob, runsOn: "ubuntu-latest" })))
      .toThrow(/declares both runs-on and a matrix/)
    const { matrix: _matrix, ...noRunner } = matrixJob
    expect(() => render(withMatrixJob(noRunner))).toThrow(/declares no runs-on and no matrix/)
  })

  it("refuses a matrix row that is not one runner label", () => {
    for (const os of ["[self-hosted, linux]", "${{ matrix.os }}", "ubuntu latest"]) {
      expect(() => render(withMatrixJob({ ...matrixJob, matrix: [{ os, advisory: false }] })))
        .toThrow(/is not a runner label; use one label per matrix row/)
    }
    // The schema refuses an empty label before `render` ever sees it.
    expect(() => withMatrixJob({ ...matrixJob, matrix: [{ os: "", advisory: false }] }))
      .toThrow(/length of at least 1/)
  })

  it("quotes matrix labels that resemble YAML scalars", () => {
    for (const os of ["false", "on", "123"]) {
      const source = render(withMatrixJob({ ...matrixJob, matrix: [{ os, advisory: false }] }))
      expect(source).toContain(`os: [${JSON.stringify(os)}]`)
    }
  })

  it("refuses an empty matrix and a repeated platform", () => {
    expect(() => render(withMatrixJob({ ...matrixJob, matrix: [] }))).toThrow(/declares an empty matrix/)
    expect(() =>
      render(withMatrixJob({
        ...matrixJob,
        matrix: [{ os: "ubuntu-latest", advisory: false }, { os: "ubuntu-latest", advisory: true }]
      }))
    ).toThrow(/repeats the matrix platform "ubuntu-latest"/)
  })

  /**
   * A job-level `continue-on-error: true` would make every row advisory while
   * the include rows still claim otherwise: two descriptions of one thing, free
   * to disagree.
   */
  it("refuses a job-level advisory bit beside a per-row one", () => {
    expect(() => render(withMatrixJob({ ...matrixJob, continueOnError: true })))
      .toThrow(/declares continue-on-error beside a matrix/)
  })

  /**
   * `requiredJobs` is the list of lanes the pipeline promises to run. A lane
   * that is advisory everywhere runs nothing the pipeline can fail on, so
   * naming it required is a claim the workflow does not keep.
   */
  it("refuses a required job whose every lane is advisory", () => {
    expect(() =>
      render(withMatrixJob(
        { ...matrixJob, matrix: matrixJob.matrix.map((row) => ({ ...row, advisory: true })) },
        ["packages"]
      ))
    ).toThrow(/required job "packages" is advisory on every platform/)
    expect(() =>
      render(attrsOf({
        ...goldenAttrs,
        gates: [],
        requiredJobs: ["rust"],
        jobs: goldenAttrs.jobs.map((job) => job.id !== "rust" ? job : { ...job, continueOnError: true })
      }))
    ).toThrow(/required job "rust" is advisory on every platform/)
  })

  /**
   * A language toolchain must be installed BEFORE the package manager.
   *
   * `actions/setup-go` prepends its own bin directories to PATH. Emitted after
   * `pnpm/action-setup`, it displaced the pnpm shim corepack had put there, and
   * the job's own `pnpm exec smthrs` still resolved while every nested
   * target the build tool spawned died with `spawn pnpm ENOENT` in under a
   * second. Fifty-one targets failed at once, across every package, and read
   * like fifty-one defects rather than one ordering mistake.
   *
   * Nothing about the YAML shows this: both steps are present and both are
   * well-formed either way. Only the order says whose PATH entry survives, so
   * the order is what this pins.
   */
  it("installs the language toolchains before the package manager claims PATH", () => {
    const rendered = render(attrsOf({
      ...goldenAttrs,
      jobs: goldenAttrs.jobs.map((job) =>
        job.id !== "test" ? job : {
          ...job,
          toolchain: CiToolchain.Needs({
            runtimes: [node],
            go: CiToolchain.Go({ release: "1.26.0" }),
            foundry: CiToolchain.Foundry({ release: "v1.8.1" })
          })
        }
      )
    }))
    const at = (needle: string): number => {
      const index = rendered.indexOf(needle)
      expect(index).toBeGreaterThan(-1)
      return index
    }
    expect(at("actions/setup-go")).toBeLessThan(at("pnpm/action-setup"))
    expect(at("foundry-rs/foundry-toolchain")).toBeLessThan(at("pnpm/action-setup"))
    expect(at("pnpm/action-setup")).toBeLessThan(at("pnpm install --frozen-lockfile"))
  })

  it("still admits no free-form command through the matrix", () => {
    expect(Object.keys(Job.fields).sort())
      .toEqual([
        "continueOnError",
        "environment",
        "id",
        "matrix",
        "name",
        "needs",
        "permissions",
        "publishesToCache",
        "runsOn",
        "steps",
        "timeoutMinutes",
        "toolchain"
      ])
    expect(Object.keys(MatrixRow.fields).sort()).toEqual(["advisory", "os"])
  })
})

describe("system packages", () => {
  it("renders one apt step that is a no-op on a runner without apt-get", () => {
    const apt = CiToolchain.Apt({ packages: ["bubblewrap", "iproute2"] })
    expect(CiToolchain.Needs({ apt }).apt).toEqual(apt)
    const rendered = render({
      ...goldenAttrs,
      jobs: [{
        id: "test",
        name: "test",
        runsOn: "ubuntu-latest",
        toolchain: CiToolchain.Needs({ runtimes: [node], apt }),
        steps: [{ name: "Targets", verb: Verb.Test, pattern: "//packages/..." }]
      }],
      gates: []
    })
    expect(rendered).toContain("- name: \"Install system packages\"")
    expect(rendered).toContain("shell: \"bash\"")
    expect(rendered).toContain("if command -v apt-get >/dev/null 2>&1; then")
    expect(rendered).toContain("sudo apt-get install -y -qq --no-install-recommends 'bubblewrap' 'iproute2'")
    expect(rendered).not.toMatch(otherCondition)
  })

  it("provisions sshd privilege separation only for a declared SSH server", () => {
    for (const packages of [["openssh-server"], ["bubblewrap"]] as const) {
      const rendered = render({
        ...goldenAttrs,
        jobs: [{
          id: "ssh",
          name: "ssh",
          runsOn: "ubuntu-latest",
          toolchain: CiToolchain.Needs({ runtimes: [node], apt: CiToolchain.Apt({ packages }) }),
          steps: [{ verb: Verb.Test, pattern: "//packages/..." }]
        }],
        gates: []
      })
      expect(rendered.includes("sudo install -d -m 0755 /run/sshd")).toBe(packages[0] === "openssh-server")
    }
  })

  it("turns the containerd image store on for a job that declares it, under bash, with no if key", () => {
    const rendered = render({
      ...goldenAttrs,
      jobs: [{
        id: "test",
        name: "test",
        runsOn: "ubuntu-latest",
        toolchain: CiToolchain.Needs({ runtimes: [node], docker: CiToolchain.Docker({ imageStore: "containerd" }) }),
        steps: [{ name: "Targets", verb: Verb.Test, pattern: "//packages/..." }]
      }],
      gates: []
    })
    expect(rendered).toContain("- name: \"Enable the containerd image store\"")
    expect(rendered).toContain("shell: \"bash\"")
    expect(rendered).toContain("containerd-snapshotter")
    expect(rendered).toContain("sudo systemctl restart docker")
    expect(rendered).not.toMatch(otherCondition)
    const without = render({
      ...goldenAttrs,
      jobs: [{
        id: "test",
        name: "test",
        runsOn: "ubuntu-latest",
        toolchain: CiToolchain.Needs({ runtimes: [node] }),
        steps: [{ name: "Targets", verb: Verb.Test, pattern: "//packages/..." }]
      }],
      gates: []
    })
    expect(without).not.toContain("containerd image store")
  })

  it("puts a PostgreSQL server on PATH on every runner, under bash, as the job's last setup step", () => {
    const postgres = CiToolchain.Postgres({ release: "18" })
    expect(CiToolchain.Needs({ postgres }).postgres).toEqual(postgres)
    const rendered = render({
      ...goldenAttrs,
      jobs: [{
        id: "test",
        name: "test",
        runsOn: "ubuntu-latest",
        toolchain: CiToolchain.Needs({
          runtimes: [node],
          apt: CiToolchain.Apt({ packages: ["bubblewrap"] }),
          postgres
        }),
        steps: [{ name: "Targets", verb: Verb.Test, pattern: "//packages/..." }]
      }],
      gates: []
    })
    const step = rendered.slice(rendered.indexOf("- name: \"Install PostgreSQL\""))
    expect(rendered.indexOf("Install system packages")).toBeLessThan(rendered.indexOf("Install PostgreSQL"))
    expect(step).toMatch(/^- name: "Install PostgreSQL"\n\s+id: setup\n/)
    expect(step).toContain("shell: \"bash\"")
    expect(step).toContain("sudo apt-get install -y -qq --no-install-recommends 'postgresql-18'")
    expect(step).toContain("pg_bin=/usr/lib/postgresql/18/bin")
    expect(step).toContain("brew install --quiet 'postgresql@18'")
    expect(step).toContain(`floor=${CiToolchain.postgresFloor}`)
    expect(step).toContain("printf '%s\\n' \"$path_entry\" >> \"$GITHUB_PATH\"")
    expect(rendered).not.toMatch(otherCondition)
    expect(() => CiToolchain.Postgres({ release: "16" as never })).toThrow()
  })

  it("refuses a package name apt would not accept", () => {
    expect(() => CiToolchain.Apt({ packages: ["bubble wrap"] })).toThrow()
    expect(() => CiToolchain.Apt({ packages: [] })).toThrow()
  })
})

describe("affected gates", () => {
  it("binds every affected invocation to a green base and keeps matrix gates full", () => {
    const parsed = Yaml.parse(
      render({ ...goldenAttrs, affected: true, knownRed: ".github/ci-known-red.json", results: true })
    )
    expect(parsed.permissions).toEqual({ contents: "read", actions: "read" })
    const gate = parsed.jobs.test.steps.find((step: any) => step.name === "Workspace targets")
    expect(gate.run).toBe(
      "pnpm exec smthrs affected ci '//packages/...' --base-green --jobs 2 --known-red '.github/ci-known-red.json' --results-file \"$RUNNER_TEMP/smthrs-results/$GITHUB_ACTION.json\" --verbose"
    )
    expect(gate.env.GITHUB_TOKEN).toBe("${{ github.event_name == 'push' && github.token || '' }}")
    const stepToken = (event_name: string) =>
      Function("github", `return ${gate.env.GITHUB_TOKEN.slice(3, -2)}`)({ event_name, token: "synthetic-job-token" })
    expect(stepToken("pull_request")).toBe("")
    expect(stepToken("push")).toBe("synthetic-job-token")
    for (const job of Object.values(parsed.jobs) as any[]) {
      expect(job.steps.find((step: any) => step.uses?.startsWith("actions/checkout")).with["persist-credentials"]).toBe(
        "false"
      )
    }
    expect(parsed.jobs.test.steps[1].env?.GITHUB_TOKEN).toBeUndefined()
    expect(parsed.jobs.test.steps.find((step: any) => step.uses?.startsWith("actions/checkout")).with["fetch-depth"])
      .toBe("2")
    const matrix = Yaml.parse(render({
      ...goldenAttrs,
      affected: true,
      gates: [],
      jobs: [{
        ...goldenAttrs.jobs[0]!,
        runsOn: undefined,
        matrix: [{ os: "ubuntu-latest", advisory: false }]
      }]
    }))
    expect(matrix.jobs.test.steps.find((step: any) => step.name === "Workspace targets").run).not.toContain("affected")
    for (const job of Object.values(parsed.jobs) as Array<any>) {
      for (const step of job.steps) {
        if (step.run?.includes("smthrs affected")) expect(step.run).toContain("--base-green")
      }
    }
  })
})

describe("deploy workflows", () => {
  const deploy = (overrides: Record<string, unknown> = {}, stepOverrides: Record<string, unknown> = {}) => ({
    ...goldenAttrs,
    repository: "git+https://github.com/smithersai/smithers.git",
    pullRequest: false,
    gates: [],
    jobs: [
      { ...goldenAttrs.jobs[0]!, id: "gate", steps: [{ verb: Verb.Test, pattern: "//packages/..." }] },
      {
        id: "deploy",
        runsOn: "ubuntu-latest",
        toolchain: CiToolchain.Needs({ runtimes: [node] }),
        environment: "production",
        needs: ["gate"],
        permissions: { actions: "read" },
        steps: [{
          verb: Verb.Run,
          pattern: "//apps/server:deploy",
          secrets: [Secret("CLOUDFLARE_API_TOKEN")],
          ...stepOverrides
        }],
        ...overrides
      }
    ]
  })
  it.each([
    [{ environment: undefined }, {}, "job \"deploy\": a Run step needs environment"],
    [{}, { verb: Verb.Test }, "environment job holds a non-Run step"],
    [{ needs: undefined }, {}, "environment job needs needs"],
    [{}, { pattern: "//apps/..." }, "Run needs one explicit target"],
    [{}, { pattern: "//apps:all" }, "Run needs one explicit target"],
    [{ needs: ["missing"] }, {}, "deploy needs successful required jobs"],
    [{ continueOnError: true }, {}, "deploy jobs cannot be matrix, advisory or cache publishers"],
    [{}, { secrets: [{ _tag: "Secret", env: "bad'name" }] }, "invalid step secret"]
  ])("refuses unsafe deployment declarations %j", (job, step, message) => {
    expect(() => render(deploy(job, step) as unknown as typeof goldenAttrs)).toThrow(message)
  })
  it("refuses write permissions on the workflow and advisory gate dependencies", () => {
    expect(() => render({ ...deploy(), permissions: { contents: "write" } } as unknown as typeof goldenAttrs)).toThrow(
      "unsafe permission"
    )
    const value = deploy()
    expect(() =>
      render(
        {
          ...value,
          jobs: [{ ...value.jobs[0]!, continueOnError: true }, value.jobs[1]!]
        } as unknown as typeof goldenAttrs
      )
    ).toThrow("deploy needs successful required jobs")
    expect(() => render({ ...value, pushBranches: ["main*"] } as unknown as typeof goldenAttrs)).toThrow(
      "Run needs literal push branches"
    )
  })
  it.each([
    undefined,
    "git+https://gitlab.com/owner/repo.git",
    "git+https://github.com/owner/repo.git?token=x",
    "git+https://github.com/o/repo'quote.git"
  ])("refuses unsafe deployment repository %s", (repository) => {
    expect(() => render({ ...deploy(), repository } as unknown as typeof goldenAttrs)).toThrow(
      "deployment needs the declared GitHub repository"
    )
  })
  it("keeps the repository guard after declaration schema decoding", () => {
    const workflow = Yaml.parse(render(attrsOf(deploy())))
    expect(workflow.jobs.deploy.if).toContain("github.repository == 'smithersai/smithers'")
  })
  it("limits deployment admission to main even when another push branch is declared", () => {
    const workflow = Yaml.parse(
      render({ ...deploy(), pushBranches: ["main", "release"] } as unknown as typeof goldenAttrs)
    )
    expect(workflow.jobs.deploy.if).not.toContain("refs/heads/release")
    expect(workflow.jobs.deploy.if).toContain("github.repository == 'smithersai/smithers'")
  })
  it("refuses deployment workflows triggered by pull requests", () => {
    expect(() => render({ ...deploy(), pullRequest: true } as unknown as typeof goldenAttrs)).toThrow(
      "Run cannot use a pull-request trigger"
    )
  })
  it("keeps deploys behind successful gates and scopes each secret to its Run step", () => {
    const source = render(
      deploy({
        steps: [
          { verb: Verb.Run, pattern: "//apps/server:deploy", secrets: [Secret("CLOUDFLARE_API_TOKEN")] },
          { verb: Verb.Run, pattern: "//apps/server:verify" }
        ]
      }) as unknown as typeof goldenAttrs
    )
    const workflow = Yaml.parse(source)
    expect(workflow.jobs.deploy.needs).toEqual(["gate"])
    expect(workflow.jobs.deploy.environment).toBe("production")
    expect(workflow.jobs.deploy.if).toBe(
      "${{ github.event_name == 'push' && github.ref == 'refs/heads/main' && github.repository == 'smithersai/smithers' }}"
    )
    const allowed = (event: string, ref: string, repo: string) =>
      Function("github", `return ${workflow.jobs.deploy.if.slice(3, -2)}`)({ event_name: event, ref, repository: repo })
    expect(allowed("push", "refs/heads/main", "fork/smithers")).toBe(false)
    expect(allowed("pull_request", "refs/heads/main", "smithersai/smithers")).toBe(false)
    expect(workflow.jobs.deploy.permissions).toEqual({ actions: "read" })
    const run = workflow.jobs.deploy.steps.find((step: any) => step.run?.includes("smthrs run"))
    expect(run.run).toBe("pnpm exec smthrs run '//apps/server:deploy' --outward-only --verbose")
    expect(run.if).toBeUndefined()
    expect(run.env).toEqual({ CLOUDFLARE_API_TOKEN: "${{ secrets.CLOUDFLARE_API_TOKEN }}" })
    expect(workflow.jobs.gate.steps.every((step: any) => step.env?.CLOUDFLARE_API_TOKEN === undefined)).toBe(true)
    expect(workflow.jobs.deploy.steps.filter((step: any) => step.env?.CLOUDFLARE_API_TOKEN)).toHaveLength(1)
    expect(workflow.jobs.deploy.steps.find((step: any) => step.run?.includes("server:verify")).env).toBeUndefined()
    expect(workflow.concurrency.group).toMatch(/^\$\{\{ github.workflow \}\}/)
    expect(Verb.all.map((verb) => verb.name)).not.toContain("run")
  })
})

it("refuses secrets on ordinary gates", () => {
  expect(() =>
    render(
      {
        ...goldenAttrs,
        gates: [],
        jobs: [{
          ...goldenAttrs.jobs[0]!,
          steps: [{
            verb: Verb.Test,
            pattern: "//packages/...",
            secrets: [Secret("DEPLOY_TOKEN")]
          }]
        }]
      } as unknown as typeof goldenAttrs
    )
  ).toThrow("secrets need a Run step")
})
