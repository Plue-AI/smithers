import { describe, expect, test } from "bun:test"
import { existsSync, readFileSync, statSync } from "node:fs"
import { resolve } from "node:path"
import { fileURLToPath } from "node:url"
import ts from "typescript"
import { dryRunChecks, workerRolloutHost, type WorkerRolloutOptions } from "./rollout"

const deployURL = new URL("./deploy.ts", import.meta.url)

// #3476, item 3: every invoked repository file must exist in its command's cwd.
// Read syntax only: importing deploy.ts would build and publish the Worker.
const dependencies = (source: string, sourceURL = deployURL): string[] => {
  const file = ts.createSourceFile(sourceURL.pathname, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const declarations = new Map<string, ts.Expression>()
  const visit = (node: ts.Node, inspect: (node: ts.Node) => void): void => {
    inspect(node)
    ts.forEachChild(node, child => visit(child, inspect))
  }
  visit(file, node => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer)
      declarations.set(node.name.text, node.initializer)
  })
  const text = (node: ts.Expression): string => {
    if (ts.isStringLiteralLike(node)) return node.text
    if (ts.isIdentifier(node) && declarations.has(node.text)) return text(declarations.get(node.text)!)
    if (ts.isTemplateExpression(node))
      return node.head.text + node.templateSpans.map(span => text(span.expression) + span.literal.text).join("")
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "fileURLToPath") {
      const url = node.arguments[0]
      if (url && ts.isNewExpression(url) && ts.isIdentifier(url.expression) && url.expression.text === "URL" &&
        url.arguments?.length === 2 && url.arguments[1]!.getText(file) === "import.meta.url")
        return fileURLToPath(new URL(text(url.arguments[0]!), sourceURL))
    }
    throw new Error(`Cannot statically resolve deploy dependency: ${node.getText(file)}`)
  }
  const commands = (node: ts.Expression): string[] => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      const helper = declarations.get(node.expression.text)
      // Command helpers supply a fixed executable/script prefix; spread args
      // after that prefix are CLI arguments, such as wrangler's deployment flags.
      if (helper && ts.isArrowFunction(helper) && ts.isArrayLiteralExpression(helper.body)) {
        const spread = helper.body.elements.findIndex(ts.isSpreadElement)
        const prefix = spread < 0 ? helper.body.elements : helper.body.elements.slice(0, spread)
        const argv = prefix.map(element => text(element))
        if (spread >= 0 && (!["node", "bun"].includes(argv[0]!) || !/^[^-].*\.[cm]?[jt]sx?$/.test(argv[1] ?? "")))
          throw new Error(`Cannot statically inspect deploy command: ${node.getText(file)}`)
        return argv
      }
    }
    if (ts.isArrayLiteralExpression(node)) return node.elements.map(element => text(element))
    throw new Error(`Cannot statically inspect deploy command: ${node.getText(file)}`)
  }
  const paths: string[] = []
  visit(file, node => {
    if (!ts.isCallExpression(node) || !ts.isIdentifier(node.expression) || node.expression.text !== "run") return
    const [command, options] = node.arguments
    if (!command || !options || !ts.isObjectLiteralExpression(options))
      throw new Error(`Cannot statically inspect deploy options: ${node.getText(file)}`)
    const cwd = options.properties.find(property => ts.isPropertyAssignment(property) && property.name.getText(file) === "cwd")
    if (!cwd || !ts.isPropertyAssignment(cwd)) throw new Error("Deploy command has no explicit cwd")
    const directory = text(cwd.initializer)
    const argv = commands(command)
    if (argv.length < 2) throw new Error("Deploy command has no static script or package command")
    if (argv[0] === "pnpm" && argv[1] === "run") paths.push(resolve(directory, "package.json"))
    for (const arg of argv) {
      if (!arg.startsWith("-") && (arg.includes("/") || /\.[cm]?[jt]sx?$/.test(arg)))
        paths.push(resolve(directory, arg))
    }
  })
  return [...new Set(paths)]
}

const isFile = (path: string): boolean => existsSync(path) && statSync(path).isFile()
const missingDependencies = (source: string): string[] => dependencies(source).filter(path => !isFile(path))
// Exercise the real helper boundaries with an inert command recorder. Never
// launch a script, publish, persist a receipt, or read Cloudflare/the network.
const rolloutCommands = async () => {
  const commands: Array<{ argv: readonly string[]; cwd: string }> = []
  const serverDir = fileURLToPath(new URL("..", deployURL))
  const run: WorkerRolloutOptions["run"] = async (argv, options) => {
    commands.push({ argv, cwd: options.cwd })
    return { exitCode: 0, output: "" }
  }
  const release = { version: "inventory", revision: "inventory" }
  const host = workerRolloutHost({ serverDir, accountId: "", worker: "", token: "", previous: release, run,
    publish: async () => { throw new Error("Inventory cannot publish") },
    record: async () => { throw new Error("Inventory cannot persist") },
    get: async path => path.endsWith("/deployments")
      ? { success: true, result: { deployments: [{ versions: [{ version_id: release.version, percentage: 100 }] }] } }
      : { success: true, result: { id: release.version } },
    sleep: async () => { throw new Error("Inventory cannot sleep") }
  })
  // Include baseline/candidate checks, restored checks, and rollback itself.
  for (const phase of ["baseline", "candidate", "restored"] as const)
    for (const name of phase === "restored" ? host.rollbackChecks : host.checks)
      expect(await host.check(name, release, phase)).toEqual({ status: "passed" })
  await host.restore(release)
  const rollback = commands.at(-1)!
  const beforeDryRun = commands.length
  expect(await dryRunChecks({ serverDir, accountId: "", run })).toEqual({ checks: [{ name: "CN-18", status: "passed" }] })
  return { commands, rollback, dryRun: commands.slice(beforeDryRun) }
}

const deployDependencies = async (): Promise<string[]> => {
  const { commands } = await rolloutCommands()
  // Repository scripts are the fixed second argv entry; URLs and other CLI
  // arguments are deliberately not interpreted as local script paths.
  const indirect = commands.map(({ argv, cwd }) => {
    if (!["bun", "node"].includes(argv[0]!) || !/\.[cm]?[jt]sx?$/.test(argv[1] ?? ""))
      throw new Error("Cannot inspect rollout script command")
    return resolve(cwd, argv[1]!)
  })
  return [...new Set([...dependencies(readFileSync(deployURL, "utf8")), ...indirect])]
}

describe("deploy script dependencies", () => {
  test("every invoked script and package exists at the command's cwd", async () => {
    const inventory = await deployDependencies()
    expect(inventory.length).toBeGreaterThan(0)
    expect(inventory.filter(path => !isFile(path))).toEqual([])
  })

  test.each(["build-probe.ts", "site-probe.ts", "workers-health.ts"])(
    "reports missing rollout canary %s without running it", async name => {
      const missing = fileURLToPath(new URL(`./canary/${name}`, deployURL))
      const inventory = await deployDependencies()
      // Inject absence instead of deleting tracked files or launching a canary.
      expect(inventory.filter(path => path === missing || !isFile(path))).toEqual([missing])
    }
  )

  test("records the dry-run health script and rollback's local wrangler", async () => {
    const { dryRun, rollback } = await rolloutCommands()
    const serverDir = fileURLToPath(new URL("..", deployURL))
    expect(dryRun).toEqual([{ argv: ["bun", "scripts/canary/workers-health.ts"], cwd: serverDir }])
    expect(rollback).toEqual({ argv: ["node", resolve(serverDir, "node_modules/wrangler/bin/wrangler.js"),
      "rollback", "inventory", "--yes", "--message", "Automatic rollback: required rollout check failed"], cwd: serverDir })
  })

  test("refuses a spread helper without a fixed script prefix", () => {
    expect(() => dependencies(`
      const scripts = (...args: string[]) => ["bun", "--silent", ...args]
      run(scripts("scripts/deleted-3476.ts"), { cwd: "/repo" })
    `)).toThrow("Cannot statically inspect deploy command")
    expect(() => dependencies(`
      const scripts = (...args: string[]) => ["bun", "--preload", "scripts/preload.ts", ...args]
      run(scripts("scripts/missing.ts"), { cwd: "/repo" })
    `)).toThrow("Cannot statically inspect deploy command")
  })

  test("parses multiline commands, comments and separate working directories", () => {
    const source = `
      const serverDir = fileURLToPath(new URL("..", import.meta.url))
      const uiDir = fileURLToPath(new URL("../../app", import.meta.url))
      // run(["node", "scripts/comment-only.mjs"], { cwd: uiDir })
      /* run(["bun", "scripts/block-comment.ts"], { cwd: serverDir }) */
      const prose = 'run(["node", "scripts/string-only.mjs"], { cwd: uiDir })'
      await run([
        "bun", // command
        "scripts/check.ts",
      ], { cwd: serverDir })
      await run(['node', 'scripts/check.ts'], {
        cwd: uiDir,
      })
    `
    expect(dependencies(source)).toEqual([
      fileURLToPath(new URL("./check.ts", deployURL)),
      fileURLToPath(new URL("../../app/scripts/check.ts", deployURL))
    ])
  })

  test("resolves command helper script templates and package commands", () => {
    const source = `
      const serverDir = fileURLToPath(new URL("..", import.meta.url))
      const siteDir = fileURLToPath(new URL("../../site", import.meta.url))
      const wrangler = (...args: string[]) => [
        "node", \`\${serverDir}node_modules/wrangler/bin/wrangler.js\`, ...args
      ]
      const checker = () => ["bun", "scripts/check.ts"]
      await run(wrangler("deploy", "--outdir", outdir), { cwd: serverDir })
      await run(["pnpm", "run", "build"], { cwd: siteDir })
      await run(checker(), { cwd: serverDir })
    `
    expect(dependencies(source)).toEqual([
      fileURLToPath(new URL("../node_modules/wrangler/bin/wrangler.js", deployURL)),
      fileURLToPath(new URL("../../site/package.json", deployURL)),
      fileURLToPath(new URL("./check.ts", deployURL))
    ])
  })

  test("reports a deleted dependency without executing it", () => {
    expect(missingDependencies(`
      const serverDir = fileURLToPath(new URL("..", import.meta.url))
      await run(["bun", "scripts/missing-deploy-dependency-3476.ts"], { cwd: serverDir })
    `)).toEqual([fileURLToPath(new URL("./missing-deploy-dependency-3476.ts", deployURL))])
  })

  test("a directory cannot satisfy an invoked script dependency", () => {
    expect(missingDependencies(`
      const serverDir = fileURLToPath(new URL("..", import.meta.url))
      await run(["bun", "scripts/"], { cwd: serverDir })
    `)).toEqual([resolve(fileURLToPath(new URL("./", deployURL)))])
  })

  test("refuses commands and working directories it cannot inspect", () => {
    expect(() => dependencies('run(["bun", "scripts/check.ts"], { cwd: process.cwd() })'))
      .toThrow("Cannot statically resolve deploy dependency")
    expect(() => dependencies('run(dynamicCommand, { cwd: "/repo" })'))
      .toThrow("Cannot statically inspect deploy command")
    expect(() => dependencies('run(["bun", "scripts/check.ts"], options)'))
      .toThrow("Cannot statically inspect deploy options")
    expect(() => dependencies('run(["bun", "scripts/check.ts"], {})'))
      .toThrow("Deploy command has no explicit cwd")
    expect(() => dependencies('run(["bun"], { cwd: "/repo" })'))
      .toThrow("Deploy command has no static script or package command")
  })
})
