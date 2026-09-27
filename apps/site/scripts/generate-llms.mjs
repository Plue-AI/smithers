#!/usr/bin/env node
/**
 * generate-llms.mjs
 *
 * Writes public/llms.txt (curated link index for agents, per llmstxt.org)
 * and public/llms-full.txt (the full prose of every docs page) from the
 * Starlight content tree. Deterministic: no clock, no network. `--check`
 * reports drift instead of writing.
 *
 * Usage: node apps/site/scripts/generate-llms.mjs [--check]
 */
import { readdirSync, readFileSync, writeFileSync, existsSync } from "node:fs"
import { join, dirname, relative } from "node:path"
import { fileURLToPath } from "node:url"
import { docsText } from "./docs-text.mjs"

const siteRoot = join(dirname(fileURLToPath(import.meta.url)), "..")
const docsRoot = join(siteRoot, "src/content/docs/docs")
const checkMode = process.argv.includes("--check")
const origin = "https://smithers.sh"
const project = JSON.parse(readFileSync(join(siteRoot, "src/data/project.json"), "utf8"))
const versions = JSON.parse(readFileSync(join(siteRoot, "src/data/versions.json"), "utf8"))

function fm(text, key) {
  const m = text.match(new RegExp(`^${key}:\\s*"([^"]*)"\\s*$`, "m")) ?? text.match(new RegExp(`^${key}:\\s*([^\\n]+)$`, "m"))
  return m ? m[1].trim() : null
}
function orderOf(text) {
  const m = text.match(/^sidebar:\s*\n\s*order:\s*(\d+)/m)
  return m ? Number(m[1]) : 1000
}

const pages = []
function walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) walk(join(dir, entry.name))
    else if (entry.name.endsWith(".mdx")) {
      const path = join(dir, entry.name)
      const text = readFileSync(path, "utf8")
      const rel = relative(docsRoot, path)
      let route = "/" + rel.replace(/\.mdx$/, "").replace(/\/index$/, "").replace(/^index$/, "")
      const slug = fm(text, "slug")
      if (slug) route = "/" + slug.replace(/^docs\/?/, "").replace(/\/$/, "")
      route = "/docs" + (route === "/" ? "/" : route + "/")
      const raw = Object.fromEntries([...text.matchAll(/^import (\w+) from ["']([^"']+)\?raw["']/gm)]
        .map(([, name, file]) => [name, readFileSync(join(dirname(path), file), "utf8")]))
      const body = docsText(text, { raw, versions })
      pages.push({
        rel,
        route,
        title: fm(text, "title") ?? rel,
        description: fm(text, "description") ?? "",
        order: orderOf(text),
        group: rel.split("/")[0].replace(/\.mdx$/, "") === rel.replace(/\.mdx$/, "") ? "" : rel.split("/")[0],
        body
      })
    }
  }
}
walk(docsRoot)

const groups = ["how-it-works", "learn", "tui", "app", "tutorials", "guides", "concepts", "reference", "troubleshooting", "migration", "examples"]
const groupLabel = {
  "how-it-works": "How Smithers works",
  learn: "Tutorials: GUI, TUI, CLI, API",
  tui: "TUI reference",
  app: "The app",
  tutorials: "Tutorials",
  guides: "How-to guides",
  concepts: "Concepts",
  reference: "Reference",
  troubleshooting: "Troubleshooting",
  migration: "Migration",
  examples: "Examples"
}
const byGroup = (g) => pages.filter((p) => p.group === g).sort((a, b) => a.order - b.order || a.title.localeCompare(b.title))
const startOrder = ["index.mdx", "quickstart.mdx", "pricing.mdx", "self-hosting.mdx", "developers.mdx", "installation.mdx", "cli-quickstart.mdx"]
const root = pages.filter((p) => p.group === "").sort((a, b) => startOrder.indexOf(a.rel) - startOrder.indexOf(b.rel))
const link = (p) => `- [${p.title}](${origin}${p.route})${p.description ? `: ${p.description}` : ""}`

const sections = []
sections.push("# Smithers\n")
sections.push(`> ${project.description}\n`)
sections.push("## Start here\n\n" + root.map(link).join("\n"))
for (const g of groups) {
  if (g === "examples") continue
  const list = byGroup(g)
  if (list.length > 0) sections.push(`## ${groupLabel[g]}\n\n` + list.map(link).join("\n"))
}
sections.push("## Optional\n\n" + byGroup("examples").map(link).join("\n"))
const llmsTxt = sections.join("\n\n") + "\n"

const ordered = [...root, ...groups.flatMap((g) => byGroup(g))]
const llmsFull =
  "# Smithers documentation (full)\n\n" +
  ordered.map((p) => `# ${p.title}\n${origin}${p.route}\n\n${p.body}`).join("\n\n---\n\n") +
  "\n"

const outputs = [
  [join(siteRoot, "public", "llms.txt"), llmsTxt],
  [join(siteRoot, "public", "llms-full.txt"), llmsFull]
]
let drift = 0
for (const [path, content] of outputs) {
  if (checkMode) {
    if (!existsSync(path) || readFileSync(path, "utf8") !== content) {
      console.error(`drift: ${relative(siteRoot, path)}`)
      drift++
    }
  } else {
    writeFileSync(path, content)
    console.log(`wrote ${relative(siteRoot, path)} (${content.length} bytes)`)
  }
}
// exitCode rather than an exit call: exiting can drop the queued drift lines on a
// macOS pipe, which reads as a failure with no reason.
if (checkMode && drift > 0) {
  console.error(`generate-llms: ${drift} file(s) out of date; run node apps/site/scripts/generate-llms.mjs`)
  process.exitCode = 1
}
