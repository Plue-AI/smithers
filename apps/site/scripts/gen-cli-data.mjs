/**
 * Generates the CLI data the docs import instead of retyping it.
 *
 *   node apps/site/scripts/gen-cli-data.mjs          # write
 *   node apps/site/scripts/gen-cli-data.mjs --check  # fail on drift, write nothing
 *
 * Outputs, all committed:
 *   apps/site/src/content/docs/docs/reference/cli/index.mdx   canonical command table
 *   apps/site/src/content/docs/docs/reference/cli/<verb>.mdx  one --help page per canonical command
 *                                              without a hand-written page
 *   apps/site/src/data/versions.json           cli, effect, and node versions from packages/smithers/package.json
 *   apps/site/src/data/cli-commands.json       canonical Incur command/schema manifest
 *   apps/site/src/data/removed-commands.json   remaining historical 0.x verbs and flags
 *                                              with the anchor its CLI error links to
 *   apps/site/src/data/help/<verb>.txt         `smthrs <verb> --help`, trailing alignment spaces removed
 *   apps/site/src/data/help/<verb>/<sub>.txt   the same for each subcommand
 *   apps/site/src/data/help/smthrs.txt       `smthrs --help`, verbatim
 *
 * The removed-command list and the anchors come from
 * packages/smithers/src/Unsupported.ts, which is also what the CLI reads when it
 * refuses a 0.x spelling. A page that renders this JSON therefore carries every
 * anchor the shipped error messages link to.
 *
 * The migration page's "Removed commands and flags" section is rendered from the
 * JSON between two marker comments; this script rewrites that region too, so the
 * anchors on the page and the anchors in the binary cannot drift apart.
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

// Keep the reference table tied to the same command identities and help as
// the binary. Bootstrap the old unmarked table once, then own only the region.
const indexPage = join(site, "src/content/docs/docs/reference/cli/index.mdx")
const indexStart = "{/* generated:cli-commands start. Run `node apps/site/scripts/gen-cli-data.mjs`; do not edit. */}"
const indexEnd = "{/* generated:cli-commands end */}"
const cell = (text) => text.replaceAll("|", "&#124;").replace(/[\r\n]+/g, " ")
// mvp.md Appendix B.6 cuts product CLI pages; §16 defers triggers and §8 defers TUI.
// Retain command help and schemas while omitting their public pages.
const cutPageCommands = new Set([
  "admin", "artifact", "cache", "egress", "label", "notification", "org", "stack", "triggers", "tui", "variable", "webhook"
])
const commandNames = [...new Set(manifest.commands.map((command) => command.name.split(" ")[0]))]
  .filter((command) => !cutPageCommands.has(command)).sort()
// `index.mdx` is the overview, so the `index` command's page takes another slug.
const pageSlug = (command) => command === "index" ? "index-command" : command
const table = [indexStart, "", "| Command | Purpose |", "| --- | --- |"]
for (const command of commandNames) {
  const captured = outputs.get(join(helpDir, `${command}.txt`))
  const description = captured?.split("\n", 1)[0].split(" \u2014 ").slice(1).join(" \u2014 ")
  if (!description) throw new Error(`No canonical help description for ${command}`)
  table.push(`| [\`${command}\`](/docs/reference/cli/${pageSlug(command)}/) | ${cell(description)} |`)
}
table.push("", indexEnd)
const indexContents = readFileSync(indexPage, "utf8")
const existingStart = indexContents.indexOf(indexStart)
const existingEnd = indexContents.indexOf(indexEnd)
if ((existingStart === -1) !== (existingEnd === -1)) throw new Error("CLI index has incomplete generated markers")
const tableStart = existingStart === -1 ? indexContents.indexOf("| Command | Purpose |") : existingStart
const tableEnd = existingEnd === -1 ? indexContents.indexOf("\n\n", tableStart) : existingEnd + indexEnd.length
if (tableStart === -1 || tableEnd < tableStart) throw new Error("CLI index has no command table")
outputs.set(indexPage, indexContents.slice(0, tableStart) + table.join("\n") + indexContents.slice(tableEnd))

// One reference page per canonical top-level command that has no hand-written
// page: its `--help` and each subcommand's, imported from the captures above.
// Only a file carrying `pageOwner` is ever overwritten or removed.
const cliPages = join(site, "src/content/docs/docs/reference/cli")
const pageOwner = "# GENERATED by apps/site/scripts/gen-cli-data.mjs from --help. Do not edit."
const ownsPage = (path) => existsSync(path) && readFileSync(path, "utf8").includes(pageOwner)
const generatedPages = new Set()
for (const command of commandNames) {
  const path = join(cliPages, `${pageSlug(command)}.mdx`)
  if (existsSync(path) && !ownsPage(path)) continue
  generatedPages.add(path)
  const paths = [...commandPaths].filter((entry) => entry === command || entry.startsWith(`${command} `)).sort()
  const imports = paths.map((entry, index) =>
    `import help${index} from "../../../../../data/help/${entry.split(" ").join("/")}.txt?raw"`
  )
  const sections = paths.map((entry, index) =>
    `${index === 0 ? "" : `## ${entry}\n\n`}<Code lang="text" code={help${index}} />`
  )
  const description = outputs.get(join(helpDir, `${command}.txt`)).split("\n", 1)[0].split(" — ").slice(1).join(" — ")
  outputs.set(path, [
    "---",
    pageOwner,
    `title: ${JSON.stringify(`smthrs ${command}`)}`,
    `description: ${JSON.stringify(description)}`,
    "---",
    "",
    `import { Code } from "@astrojs/starlight/components"`,
    ...imports,
    "",
    sections.join("\n\n"),
    ""
  ].join("\n"))
}
const helpFiles = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
  entry.isDirectory() ? helpFiles(join(dir, entry.name)) : [join(dir, entry.name)]
)
const stalePages = [
  ...readdirSync(cliPages).map((name) => join(cliPages, name)).filter((path) => ownsPage(path) && !generatedPages.has(path)),
  ...helpFiles(helpDir).filter((path) => path.endsWith(".txt") && !outputs.has(path))
]

// The generated region of the migration page: one `###` per anchor. Reason
// and spellings come from the source; the "1.0 path" sentence is hand-written
// in migration-paths.json, and a missing entry fails the run so a new removal
// cannot ship without its replacement named.
const pathsFile = join(dataDir, "migration-paths.json")
const { paths, flagGroups } = JSON.parse(readFileSync(pathsFile, "utf8"))
const missingPaths = removedAnchors.filter((anchor) => !(anchor in paths))
if (missingPaths.length > 0) {
  throw new Error(`migration-paths.json has no "1.0 path" for: ${missingPaths.join(", ")}`)
}
const start = "{/* generated:removed-commands start. Run `bun apps/site/scripts/gen-cli-data.mjs`; do not edit. */}"
const end = "{/* generated:removed-commands end */}"
const sentence = (text) => `${text[0].toUpperCase()}${text.slice(1)}${/[.!?]$/.test(text) ? "" : "."}`
const list = (items) =>
  items.length === 1 ? items[0] : items.length === 2 ? `${items[0]} and ${items[1]}` : `${items.slice(0, -1).join(", ")}, and ${items.at(-1)}`
const code = (items) => items.map((item) => `\`${item}\``)
const ordered = []
const groupOf = new Map()
for (const verb of verbs) {
  if (!ordered.includes(verb.anchor)) ordered.push(verb.anchor)
  groupOf.set(verb.anchor, verb.group)
}
for (const flag of flags) if (!ordered.includes(flag.anchor)) ordered.push(flag.anchor)
ordered.push("flows")
for (const anchor of ordered) if (!groupOf.has(anchor)) groupOf.set(anchor, flagGroups[anchor] ?? "Removed flags")
const section = [start, ""]
let group
for (const anchor of ordered) {
  if (groupOf.get(anchor) !== group) {
    group = groupOf.get(anchor)
    section.push(`**${group}.**`, "")
  }
  section.push(`### ${anchor}`, "")
  if (anchor === "flows") {
    section.push(paths[anchor], "")
    continue
  }
  const verbEntries = verbs.filter((v) => v.anchor === anchor)
  const flagEntries = flags.filter((f) => f.anchor === anchor)
  const reason = verbEntries[0]?.reason ?? flagEntries[0].reason
  const parts = []
  if (verbEntries.length > 0) parts.push(list(code(verbEntries.flatMap((v) => v.spellings))))
  if (flagEntries.length > 0) {
    const flagText = flagEntries.length === 1 ? "the flag " : "the flags "
    // A flag whose reason differs from the entry's reason carries its own, in parentheses.
    const spelled = flagEntries.map((f) =>
      f.reason === reason ? code(f.spellings)[0] : `${code(f.spellings)[0]} (${f.reason.replace(/ \((.+)\)$/, "; $1")})`
    )
    parts.push(flagText + list(spelled))
  }
  const line = `**Reason:** ${sentence(reason)} **Removed:** ${parts.join(", and ")}. **1.0 path:** ${paths[anchor]}`
  section.push(line, "")
}
section.push(end)
const region = section.join("\n")

if (existsSync(migrationPage)) {
  const page = readFileSync(migrationPage, "utf8")
  const a = page.indexOf(start)
  const b = page.indexOf(end)
  if (a === -1 || b === -1) {
    throw new Error(`${migrationPage} has no generated region; add the start and end markers under the removed-commands heading`)
  }
  const next = page.slice(0, a) + region + page.slice(b + end.length)
  const headings = new Set([...next.matchAll(/^### ([a-z0-9-]+)\s*$/gm)].map((m) => m[1]))
  const absent = removed.anchors.filter((anchor) => !headings.has(anchor))
  if (absent.length > 0) {
    throw new Error(`the CLI links to anchors the migration page does not carry: ${absent.map((x) => "#" + x).join(", ")}`)
  }
  outputs.set(migrationPage, next)
}

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
