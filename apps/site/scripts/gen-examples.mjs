/**
 * Generates one docs page per example program in examples/src.
 *
 *   node apps/site/scripts/gen-examples.mjs          # write
 *   node apps/site/scripts/gen-examples.mjs --check  # fail on drift, write nothing
 *
 * A page is the example's own leading doc comment as prose, then the program
 * as a titled code fence. The examples are the tested programs
 * `pnpm run test:examples` runs, so the page shows code that is proven to run
 * at this commit, and the generated copy is committed so the site builds
 * without the generator. `smithers-build lint //apps/site:examplesPages`
 * fails when an example changed and its page did not.
 *
 * A companion file `NN-slug-host.ts` beside `NN-slug.ts` is appended to that
 * example's page as a second fence rather than getting a page of its own.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const here = dirname(fileURLToPath(import.meta.url))
const site = resolve(here, "..")
const root = resolve(site, "../..")
const srcDir = join(root, "examples/src")
const outDir = join(site, "src/content/docs/docs/examples")
const check = process.argv.includes("--check")

const files = readdirSync(srcDir).filter((name) => /^\d+-.*\.ts$/.test(name)).sort()
const primary = files.filter((name) => !(name.endsWith("-host.ts") && files.includes(name.replace(/-host\.ts$/, ".ts"))))

/** The leading `/** ... *\/` block as paragraphs, and the source that follows it. */
const split = (source) => {
  const m = source.match(/^\/\*\*\n([\s\S]*?)\n \*\/\n/)
  if (m === null) return { paragraphs: [], code: source }
  const text = m[1].split("\n").map((line) => line.replace(/^ \* ?/, "")).join("\n")
  const paragraphs = text.split(/\n\s*\n/).map((p) => p.replace(/\n/g, " ").trim()).filter((p) => p && !p.startsWith("@since") && !p.startsWith("@category"))
  return { paragraphs, code: source.slice(m[0].length).replace(/^\n+/, "") }
}

const firstSentence = (text) => {
  const m = text.match(/^(.*?[.!?])(\s|$)/)
  return (m ? m[1] : text).replace(/`/g, "").replace(/"/g, "'")
}

const packageReferences = (code) => [...new Set(
  [...code.matchAll(/from\s+["'](@smthrs\/[^/"']+)/g)].map((match) => match[1])
)].sort()

const outputs = new Map()
for (const name of primary) {
  const stem = name.replace(/\.ts$/, "")
  const [, number, slug] = stem.match(/^(\d+)-(.*)$/)
  const { paragraphs, code } = split(readFileSync(join(srcDir, name), "utf8"))
  const companion = `${stem}-host.ts`
  const lines = [
    "---",
    `title: "${slug.replace(/-/g, " ").replace(/^./, (c) => c.toUpperCase())}"`,
    `description: "${firstSentence(paragraphs[0] ?? `The ${stem} example.`)}"`,
    `editUrl: "https://github.com/smithersai/smithers/edit/main/examples/src/${name}"`,
    "sidebar:",
    `  order: ${Number(number)}`,
    "---",
    "",
    `{/* Generated from examples/src/${name} by \`node apps/site/scripts/gen-examples.mjs\`; edit the example, not this page. */}`,
    ""
  ]
  for (const p of paragraphs) lines.push(p, "")
  lines.push(
    "## Run the test",
    "",
    `The complete program is [\`examples/src/${name}\`](https://github.com/smithersai/smithers/blob/main/examples/src/${name}). Clone the repository and follow [CONTRIBUTING.md](https://github.com/smithersai/smithers/blob/main/CONTRIBUTING.md) to install and build its packages.`,
    "",
    ...(existsSync(join(root, "examples/test", `${stem}.test.ts`)) ? [
      "From the repository root, run this example's assertions:",
      "",
      "```bash",
      `pnpm --filter @smthrs/examples exec vitest run test/${stem}.test.ts`,
      "```",
      "",
      "Vitest reports the assertions that passed, failed, or were skipped. Examples that call live providers need the credentials described below; a skipped test does not verify a provider call."
    ] : ["This program has no dedicated test file. Read its setup requirements before running it; importing an example alone may only define its exports."]),
    "",
    "## Related reference",
    "",
    packageReferences(code).map((pkg) => `[\`${pkg}\`](/docs/reference/api/${pkg.replace("@smthrs/", "")}/)`).join(" · "),
    "",
    "## Source",
    "",
    `\`\`\`ts title="examples/src/${name}"`,
    code.trimEnd(),
    "```",
    ""
  )
  if (files.includes(companion)) {
    const host = split(readFileSync(join(srcDir, companion), "utf8"))
    lines.push(`## Companion: ${companion}`, "")
    for (const p of host.paragraphs) lines.push(p, "")
    lines.push(`\`\`\`ts title="examples/src/${companion}"`, host.code.trimEnd(), "```", "")
  }
  outputs.set(join(outDir, `${stem}.mdx`), lines.join("\n"))
}

// Pages for examples that no longer exist are removed, so the tree never
// carries a page whose program is gone.
const stale = existsSync(outDir)
  ? readdirSync(outDir).filter((name) => /^\d+-.*\.mdx$/.test(name)).map((name) => join(outDir, name)).filter((p) => !outputs.has(p))
  : []

let drift = 0
for (const [path, content] of outputs) {
  const current = existsSync(path) ? readFileSync(path, "utf8") : undefined
  if (current === content) continue
  drift += 1
  if (check) console.error(`drift: ${path.replace(root + "/", "")} ${current === undefined ? "is missing" : "differs"}`)
  else {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, content)
  }
}
for (const path of stale) {
  drift += 1
  if (check) console.error(`drift: ${path.replace(root + "/", "")} has no example`)
  else unlinkSync(path)
}
console.log(`gen-examples: ${outputs.size} page(s), ${drift} ${check ? "drifted" : "written or removed"}`)
if (check && drift > 0) process.exitCode = 1
