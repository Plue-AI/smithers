/**
 * Capture the checked-out CLI's schemas, help and version pins for docs lint.
 * M-35 retires public CLI and migration pages; source facts remain available.
 * Run with --check to report drift without writing.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, "../../..")
const site = resolve(here, "..")
const dataDir = join(site, "src/data")
const helpDir = join(dataDir, "help")
const migrationPage = join(site, "src/content/docs/docs/migration/1.0.mdx")
const check = process.argv.includes("--check")

// Capture defaults from one known directory, then replace that machine-specific
// path with <cwd> in the published help and manifest.
process.chdir(root)

// Load the same declaration identities as the executable, then build once.
// Capturing every nested command in a fresh process makes a docs refresh pay
// the complete control/build dependency graph's startup cost hundreds of times.
const { installEffectResolution } = await import(join(root, "packages/smithers/build/build-cli/src/effect-resolution.js"))
installEffectResolution()
const { makeCli } = await import(join(root, "packages/smithers/src/Cli.ts"))
const environment = { ...process.env, NO_COLOR: "1" }
const commandTree = makeCli({ environment })
const capture = async (args) => {
  let output = ""
  let status = 0
  await commandTree.serve(args, {
    env: environment,
    stdout: (text) => { output += text },
    exit: (code) => { status = code }
  })
  if (status !== 0) throw new Error(`smthrs ${args.join(" ")} exited ${status}\n${output}`)
  return output.replaceAll(root, "<cwd>").split("\n").map((line) => line.trimEnd()).join("\n").trimEnd() + "\n"
}
const manifest = JSON.parse(await capture(["--llms-full", "--format", "json"]))
if (!Array.isArray(manifest.commands) || manifest.commands.length === 0) {
  throw new Error("The public CLI did not return a canonical command manifest")
}
const unsupported = await import(join(root, "packages/smithers/src/Unsupported.ts"))

// One entry per anchor. Verbs anchor on their own name; flags carry an
// explicit anchor; reserved flow ids link to #flows. `removedVerbs` names only
// spellings the CLI no longer answers, pinned against this manifest by
// packages/smithers/test/Verb.test.ts, so nothing is filtered out here.
const verbs = unsupported.removedVerbs.map((verb) => ({
  kind: "verb",
  anchor: verb.name,
  name: verb.name,
  group: verb.group,
  reason: verb.reason,
  subcommands: verb.subcommands ?? [],
  spellings: verb.subcommands === undefined
    ? [`smthrs ${verb.name}`]
    : verb.subcommands.map((sub) => `smthrs ${verb.name} ${sub}`)
}))
const flags = unsupported.removedFlags.map((flag) => ({
  kind: "flag",
  anchor: flag.anchor,
  name: flag.flag,
  parent: flag.parent,
  reason: flag.reason,
  spellings: [flag.parent === "" ? `--${flag.flag}` : `smthrs ${flag.parent} --${flag.flag}`]
}))
// Anchors written as literals elsewhere in the CLI (Legacy.ts and Project.ts
// link #run-data by hand). Scanning the source keeps the contract complete
// without a registry that someone has to remember to update.
const literalAnchors = new Set()
const scan = (dir) => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) scan(path)
    else if (entry.name.endsWith(".ts") && !entry.name.includes(".test.")) {
      for (const m of readFileSync(path, "utf8").matchAll(/migration\/1\.0#([a-z0-9-]+)|\$\{migrationUrl\}#([a-z0-9-]+)/g)) {
        literalAnchors.add(m[1] ?? m[2])
      }
    }
  }
}
scan(join(root, "packages/smithers/src"))
const removedAnchors = [...new Set([...verbs.map((v) => v.anchor), ...flags.map((f) => f.anchor), "flows"])]
const removed = {
  migrationUrl: unsupported.migrationUrl,
  source: "packages/smithers/src/Unsupported.ts",
  verbs,
  flags,
  reservedFlows: { anchor: "flows", prefix: "system/" },
  anchors: [...new Set([...removedAnchors, ...literalAnchors])].sort(),
  removedAnchors
}

const help = (args) => capture([...args, "--help"])
const topHelp = await help([])

// Versions the prose quotes: the CLI's own, the Effect pin, and the Node floor.
const cliManifest = JSON.parse(readFileSync(join(root, "packages/smithers/package.json"), "utf8"))
const versions = {
  cli: cliManifest.version,
  effect: cliManifest.dependencies?.effect ?? cliManifest.peerDependencies?.effect,
  node: (cliManifest.engines?.node ?? "").match(/\d+\.\d+\.\d+/)?.[0],
  nodeRange: cliManifest.engines?.node
}
for (const [name, value] of Object.entries(versions)) {
  if (!value) throw new Error(`could not read the ${name} version from packages/smithers/package.json`)
}

const outputs = new Map()
outputs.set(join(dataDir, "versions.json"), JSON.stringify(versions, null, 2) + "\n")
outputs.set(join(dataDir, "cli-commands.json"), JSON.stringify(manifest, null, 2) + "\n")
outputs.set(join(dataDir, "removed-commands.json"), JSON.stringify(removed, null, 2) + "\n")
outputs.set(join(helpDir, "smthrs.txt"), topHelp)
const commandPaths = new Set([
  "completions", "mcp", "mcp add", "mcp doctor", "skills", "skills add", "skills list"
])
for (const command of manifest.commands) {
  const tokens = command.name.split(" ")
  if (tokens.some((token) => !/^[a-z][a-z0-9-]*$/.test(token))) throw new Error(`Invalid command path ${command.name}`)
  for (let length = 1; length <= tokens.length; length++) commandPaths.add(tokens.slice(0, length).join(" "))
}
for (const command of [...commandPaths].sort()) {
  const tokens = command.split(" ")
  outputs.set(join(helpDir, ...tokens.slice(0, -1), `${tokens.at(-1)}.txt`), await help(tokens))
}

// M-35: retain source CLI schemas and help, without publishing CLI pages.
const helpFiles = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
  entry.isDirectory() ? helpFiles(join(dir, entry.name)) : [join(dir, entry.name)]
)
const retiredTree = join(site, "src/content/docs/docs/reference/cli")
const stalePages = [
  ...helpFiles(helpDir).filter((path) => path.endsWith(".txt") && !outputs.has(path)),
  ...(existsSync(retiredTree) ? helpFiles(retiredTree).filter((path) => /\.mdx?$/.test(path)) : []),
  ...(existsSync(migrationPage) ? [migrationPage] : [])
]

let drift = 0
for (const [path, content] of outputs) {
  const current = existsSync(path) ? readFileSync(path, "utf8") : undefined
  if (current === content) continue
  drift += 1
  if (check) {
    console.error(`drift: ${path.replace(root + "/", "")} ${current === undefined ? "is missing" : "differs"}`)
  } else {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, content)
    console.log(`wrote ${path.replace(root + "/", "")}`)
  }
}
for (const path of stalePages) {
  drift += 1
  if (check) console.error(`drift: ${path.replace(root + "/", "")} is stale`)
  else {
    rmSync(path)
    console.log(`removed ${path.replace(root + "/", "")}`)
  }
}
if (check && drift > 0) process.exitCode = 1
if (drift === 0) console.log(check ? "up to date" : "nothing to write")
