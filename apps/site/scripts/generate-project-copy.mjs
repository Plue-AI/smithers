#!/usr/bin/env node
/**
 * Renders the public Smithers copy from src/data/project.json.
 *
 * The JSON is the one human-edited source for the project description,
 * support policy, tagline, overview animation, and introductory commands. This generator owns
 * the root README, the matching regions of the docs overview, and the root
 * manifest description. PACKAGE.ts makes both writing and drift checking part
 * of the target graph.
 */
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const here = dirname(fileURLToPath(import.meta.url))
const site = resolve(here, "..")
const root = resolve(site, "../..")
const check = process.argv.includes("--check")
const project = JSON.parse(readFileSync(join(site, "src/data/project.json"), "utf8"))

const requiredString = (value, path) => {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`project.json ${path} must be a non-empty string`)
  return value
}

const description = requiredString(project.description, "description")
const supportSummary = requiredString(project.support?.summary, "support.summary")
/** The support policy in one line; the support matrix holds the evidence. `docs` is the docs origin for links. */
const supportSection = (docs) => `## Supported platforms

${supportSummary} See the [support matrix](${docs}/docs/reference/support-matrix/).`
const tagline = requiredString(project.tagline, "tagline")
const animation = {
  dark: requiredString(project.animation?.dark, "animation.dark"),
  light: requiredString(project.animation?.light, "animation.light"),
  alt: requiredString(project.animation?.alt, "animation.alt")
}
const cliInstall = requiredString(project.install?.cli, "install.cli")
if (!Array.isArray(project.install?.getStarted) || project.install.getStarted.length === 0) {
  throw new Error("project.json install.getStarted must be a non-empty array")
}
const getStarted = project.install.getStarted.map((command, index) =>
  requiredString(command, `install.getStarted[${index}]`)
)

const logo = String.raw`<pre align="center">
███████╗███╗   ███╗██╗████████╗██╗  ██╗███████╗██████╗ ███████╗
██╔════╝████╗ ████║██║╚══██╔══╝██║  ██║██╔════╝██╔══██╗██╔════╝
███████╗██╔████╔██║██║   ██║   ███████║█████╗  ██████╔╝███████╗
╚════██║██║╚██╔╝██║██║   ██║   ██╔══██║██╔══╝  ██╔══██╗╚════██║
███████║██║ ╚═╝ ██║██║   ██║   ██║  ██║███████╗██║  ██║███████║
╚══════╝╚═╝     ╚═╝╚═╝   ╚═╝   ╚═╝  ╚═╝╚══════╝╚═╝  ╚═╝╚══════╝
</pre>`

const readme = `<!-- Generated from apps/site/src/data/project.json by apps/site/scripts/generate-project-copy.mjs. -->

${logo}

<p align="center"><strong>${tagline}</strong></p>

${description}

## Open Smithers

Open [the Smithers repository](https://smithers.sh/smithersai/smithers) in your browser.
Explore its files, ask for work in chat, and inspect runs and changes in the conversation.
Sign in with GitHub when you are ready to contribute. See
[Pricing](https://smithers.sh/docs/pricing/) for Free and Pro plans and deployment
availability. Follow the [app quickstart](https://smithers.sh/docs/quickstart/).

For local execution and authoring, use the CLI and libraries described below.

${supportSection("https://smithers.sh")}

## Install

The 1.0 release candidate is not on npm. Install it from the source checkout
([Installation](https://smithers.sh/docs/installation/#install-the-cli)):

\`\`\`bash
${cliInstall}
\`\`\`

## Get started

Run these commands from your project directory. Before launching, edit the
scaffolded flow and configure the credential its \`model:\` field requires.
The [CLI quickstart](https://smithers.sh/docs/cli-quickstart/) covers each step.

\`\`\`bash
${getStarted.join("\n")}
\`\`\`

> [!TIP]
> Ask your agent to help you figure out how Smithers can help you and your project, based on everything it knows about you.

## Documentation

Read the [Smithers documentation](https://smithers.sh/docs/) for tutorials, guides, and the full reference. For the top-level build API, keep the [Smithers API cheat sheet](./packages/smithers/build/targets/docs/reference/cheat-sheet.md) handy: one file of TypeScript examples covering the whole \`Smithers.*\` surface.

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md) for local setup, testing, and pull request guidance.

## License

Smithers is MIT licensed. See [LICENSE](./LICENSE) for details.

## Join our community

Join the [Smithers community on Telegram](https://t.me/+ANThR9bHDLAwMjUx).
`

const markers = (name) => ({
  start: `{/* generated:${name} start. Edit apps/site/src/data/project.json; do not edit. */}`,
  end: `{/* generated:${name} end */}`
})

const replaceRegion = (text, name, body, path) => {
  const { start, end } = markers(name)
  const a = text.indexOf(start)
  const b = text.indexOf(end)
  if (a === -1 || b === -1 || b < a) throw new Error(`${relative(root, path)} has no valid generated:${name} region`)
  return text.slice(0, a) + `${start}\n\n${body}\n\n${end}` + text.slice(b + end.length)
}

// M-35 removes the standalone docs overview; refresh must not recreate it.
const docsPath = join(site, "src/content/docs/docs/index.mdx")
const developersPath = join(site, "src/content/docs/docs/developers.mdx")
let developers = readFileSync(developersPath, "utf8")
developers = replaceRegion(developers, "project-support", supportSection(""), developersPath)
// One image candidate, never two. The animations are megabytes each, so the
// page offers the browser a single source: `media` picks the light recording
// for a light reader before any request, and `loading="lazy"` holds even that
// one until the animation nears the viewport. Hiding a second <img> with CSS
// would still download it. Readers who override their system theme with the
// Starlight theme select keep the system-matched recording.
developers = replaceRegion(
  developers,
  "project-animation",
  `<picture>\n` +
    `<source srcset="${animation.light}" media="(prefers-color-scheme: light)" />\n` +
    `<img src="${animation.dark}" class="hero-anim" alt="${animation.alt}" loading="lazy" decoding="async" />\n` +
    `</picture>`,
  developersPath
)
developers = replaceRegion(
  developers,
  "project-quickstart",
  `The 1.0 release candidate is not on npm. Install it from the source checkout.\n\n` +
    `<LinkButton href="/docs/installation/" variant="primary">Install the CLI</LinkButton>\n` +
    `<LinkButton href="/docs/cli-quickstart/" variant="secondary">Read the CLI quickstart</LinkButton>\n\n` +
    `\`\`\`bash\n${cliInstall}\n\`\`\`\n\n` +
    `From your project directory, scaffold a flow, edit its instructions, and configure the credential its \`model:\` field requires before running it:\n\n` +
    `\`\`\`bash\n${getStarted.join("\n")}\n\`\`\`\n\n` +
    `That creates \`flows/change/flow.mdx\`, a flow that lives with your code, and runs it. The [CLI quickstart](/docs/cli-quickstart/) walks through the same steps with what to expect at each one.`,
  developersPath
)

const manifestPath = join(root, "package.json")
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"))
manifest.description = description

const outputs = new Map([
  [join(root, "README.md"), readme],
  [developersPath, developers],
  [manifestPath, JSON.stringify(manifest, null, 2) + "\n"]
])

let drift = 0
if (existsSync(docsPath)) {
  drift += 1
  if (check) console.error(`drift: ${relative(root, docsPath)} is retired`)
  else rmSync(docsPath)
}
for (const [path, content] of outputs) {
  const current = existsSync(path) ? readFileSync(path, "utf8") : undefined
  if (current === content) continue
  drift += 1
  if (check) console.error(`drift: ${relative(root, path)} ${current === undefined ? "is missing" : "differs"}`)
  else {
    writeFileSync(path, content)
    console.log(`wrote ${relative(root, path)}`)
  }
}
if (check && drift > 0) process.exitCode = 1
if (drift === 0) console.log(check ? "up to date" : "nothing to write")
