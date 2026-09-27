/**
 * Workspace initialization and generators backed by the existing scaffolds.
 * @since 1.0.0
 */

import { openPackageIndex, runPackageVerb, type RuntimeConfig } from "@smthrs/build-cli/Cli"
import * as CreateApp from "@smthrs/build-cli/CreateApp"
import * as Reporter from "@smthrs/build-cli/Reporter"
import * as TargetInstall from "@smthrs/targets/Install"
import * as Target from "@smthrs/targets/Target"
import { Cli, z } from "incur"
import { existsSync } from "node:fs"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import * as Init from "../Init.ts"
import * as Project from "../Project.ts"
import * as Presentation from "./Presentation.ts"

/**
 * Follow-ups after a workspace or target is scaffolded.
 * @category constants
 * @since 1.0.0
 */
export const scaffolded: Presentation.FollowUps = Presentation.runs({
  otherwise: [
    { command: "targets", description: "Inspect available workspace targets" },
    { command: "flow list", description: "Inspect discovered flows" }
  ]
})
const safe = <A>(context: Presentation.Failing, body: () => Promise<A>) =>
  Presentation.guard(context, body, { next: scaffolded })

const localOptions = z.object({ root: z.string().optional().describe("Project directory") })

/**
 * Initialize without replacing an existing workspace, package declaration, or flow.
 * @category constructors
 * @since 1.0.0
 */
export const initialize = async (
  root: string,
  name: string,
  environment: Readonly<Record<string, string | undefined>>
) => {
  const problem = Init.nameProblem(name)
  if (problem !== undefined) throw new Error(problem)
  await mkdir(root, { recursive: true })
  const created: Array<string> = []
  const retained: Array<string> = []
  const create = async (file: string, contents: string) => {
    try {
      await writeFile(join(root, file), contents, { flag: "wx" })
      created.push(file)
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== "EEXIST") throw cause
      retained.push(file)
    }
  }
  let repository = pathToFileURL(root).href
  let manager = "pnpm@11.25.0"
  try {
    const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8")) as {
      repository?: string | { url?: string }
      packageManager?: string
    }
    const declared = typeof manifest.repository === "string" ? manifest.repository : manifest.repository?.url
    if (declared) repository = declared
    if (manifest.packageManager !== undefined) manager = manifest.packageManager
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause
  }
  const workspace = existsSync(join(root, ".smithers", "WORKSPACE.ts")) ? ".smithers/WORKSPACE.ts" : "WORKSPACE.ts"
  if (existsSync(join(root, workspace))) retained.push(workspace)
  else {
    if (!/^(?:pnpm|yarn|bun)@[^\s]+$/.test(manager)) {
      throw new Error(
        `Cannot infer a supported workspace toolchain from ${manager}; declare WORKSPACE.ts explicitly or use smthrs generate flow`
      )
    }
    // A generated workspace declares nodeModules, which only an install can
    // produce, and no install runs under Bun. Refuse before writing anything.
    if (manager.startsWith("bun@")) {
      throw new Error(
        `unsupported: ${TargetInstall.bunInstallUnsupportedMessage}; declare WORKSPACE.ts explicitly to run tools under Bun, or use smthrs generate flow`
      )
    }
    await create(
      "package.json",
      `${JSON.stringify({ name, private: true, type: "module", packageManager: manager }, null, 2)}\n`
    )
    const runtime = "S.Runtime.Node({ version: \">=26.4.0\" })"
    const packageManager = manager.startsWith("yarn@") ?
      `S.PackageManager.Yarn({ manifest: packageJson, lockfile: S.file("//yarn.lock"), version: ${
        JSON.stringify(manager.slice(5))
      } })`
      : `S.PackageManager.Pnpm({ manifest: packageJson, lockfile: S.file("//pnpm-lock.yaml"), version: ${
        JSON.stringify(manager.slice(5))
      } })`
    await create(
      "WORKSPACE.ts",
      `import { Smithers as S } from "@smthrs/targets"\n\nconst packageJson = S.file("//package.json")\nconst runtime = ${runtime}\n\nexport const Workspace = S.Workspace(${
        JSON.stringify(name)
      }, {\n  repository: ${
        JSON.stringify(repository)
      },\n  cache: S.Cache({ directory: ".flows" }),\n  runtime,\n  packageManager: ${packageManager},\n  nodeModules: S.Npm.NodeModules({ packageJson })\n})\n`
    )
  }
  await create(
    "PACKAGE.ts",
    `import { Smithers as S } from "@smthrs/targets"\n\nexport const Package = S.Package({\n  targets: {\n    sources: S.Filegroup({ srcs: S.glob(["src/**"]), summary: "Project source files" })\n  }\n})\n`
  )
  const flow = Init.scaffold(root, name, environment)
  return { root, created, retained, flow, next: ["smthrs targets", `smthrs flow plan ${name}`] }
}

const generatorOptions = z.object({
  workspace: z.string().default(process.cwd()),
  target: z.string().optional().describe("Declared generator label; required when more than one matches"),
  plan: z.boolean().default(false).describe("Show the generator plan without writing files")
})

const generateTarget = async (
  kind: "package" | "ci",
  options: z.output<typeof generatorOptions>,
  config: RuntimeConfig,
  name?: string
) => {
  const index = await openPackageIndex(options, config)
  const candidates = index.targets().filter((row) => {
    const rule = Target.metadata(row.target).target
    return kind === "package" ? rule === "NewPackage" : rule === "Github.Workflow" || rule === "GithubCiGen"
  })
  const selected = options.target === undefined ? candidates : candidates.filter((row) => row.label === options.target)
  if (selected.length !== 1) {
    throw new Error(
      selected.length === 0
        ? `No declared ${kind} generator matches; add a ${
          kind === "package" ? "S.NewPackage" : "S.Github.Workflow"
        } target to PACKAGE.ts${options.target ? ` (${options.target})` : ""}`
        : `Choose a generator with --target: ${selected.map((row) => row.label).join(", ")}`
    )
  }
  const outcome = await runPackageVerb(
    "auto",
    [selected[0]!.label],
    {
      workspace: options.workspace,
      plan: options.plan,
      cache: false,
      write: true,
      ...(name === undefined ? {} : { name })
    },
    config,
    Reporter.make({
      renderer: "plain",
      terminal: config.stderr ?? Reporter.terminalOf(process.stderr),
      env: config.environment ?? process.env
    })
  )
  if ("ok" in outcome && !outcome.ok) {
    config.exit?.(1)
    throw new Error(`${kind} generator failed; inspect the target diagnostics`)
  }
  return outcome
}

/**
 * Commands use configured target generators so repository policy remains authoritative.
 * @category constructors
 * @since 1.0.0
 */
export const createGenerateCli = (config: RuntimeConfig = {}) =>
  Cli.create("generate", { description: "Scaffold apps, flows, packages, and CI configuration" })
    .command("app", {
      description: "Create an application from a bundled template",
      mcp: { annotations: { readOnlyHint: false } },
      args: z.object({ directory: z.string() }),
      options: z.object({ template: z.string().default("default") }),
      run: (c) =>
        safe(
          c,
          () => CreateApp.scaffold({ directory: c.args.directory, template: c.options.template })
        )
    })
    .command("flow", {
      description: "Create a durable Markdown flow without replacing an existing flow",
      mcp: { annotations: { readOnlyHint: false } },
      args: z.object({ name: z.string().min(1) }),
      options: localOptions,
      run: (c) =>
        safe(c, async () => {
          const problem = Init.nameProblem(c.args.name)
          if (problem !== undefined) throw new Error(problem)
          return Init.scaffold(
            Project.root(c.options.root, process.cwd()),
            c.args.name,
            config.environment ?? process.env
          )
        })
    })
    .command("package", {
      description: "Run the workspace's declared package scaffold with its configured defaults",
      mcp: { annotations: { readOnlyHint: false } },
      args: z.object({ name: z.string().min(1) }),
      options: generatorOptions,
      run: (c) => safe(c, () => generateTarget("package", c.options, config, c.args.name))
    })
    .command("ci", {
      description: "Generate CI files using the workspace's declared GitHub workflow target",
      mcp: { annotations: { readOnlyHint: false } },
      options: generatorOptions,
      run: (c) => safe(c, () => generateTarget("ci", c.options, config))
    })
