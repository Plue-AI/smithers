/**
 * The CLI reference pages match the shipped command tree.
 *
 * The generated Incur manifest and help describe the canonical parser; their
 * separate generation gate checks them against the executable. `Verb.ts`
 * describes the retained Effect CLI handlers, whose reference pages remain
 * useful for compatibility. Reading these artifacts avoids starting the CLI's
 * control runtime merely to check its documentation.
 */
import assert from "node:assert/strict"
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { describe, it } from "node:test"

import { repoRoot as root } from "../workspace-packages.mjs"

const compare = (required, accepted, pages) => {
  const expected = new Set(required)
  const available = new Set(accepted)
  const documented = new Set(pages)
  return [
    ...[...documented].filter((page) => !available.has(page)).map((page) => `reference/cli/${page}.mdx documents no shipped verb: ${page}`),
    ...[...expected].filter((verb) => !documented.has(verb)).map((verb) => `shipped verb has no reference/cli page: ${verb}`)
  ]
}

const indexedCommands = (page) => new Set(page.split("\n")
  .filter((line) => line.startsWith("|"))
  .flatMap((line) => [...(line.split("|")[1] ?? "").matchAll(/`([^`]+)`/g)])
  .flatMap((match) => match[1].split(/\s/, 1)[0].split("/")))

const cliPages = (directory) =>
  readdirSync(directory)
    .filter((name) => name.endsWith(".mdx") && name !== "index.mdx")
    .map((name) => name.slice(0, -4))

const markdownFiles = (directory) =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (["node_modules", "dist", "coverage", ".git", ".flows"].includes(entry.name)) return []
    const path = join(directory, entry.name)
    return entry.isDirectory() ? markdownFiles(path) : entry.isFile() && /\.mdx?$/.test(entry.name) ? [path] : []
  })

const untaggedCliCommands = (source) => [...source.matchAll(/(?:npm (?:install|i)|npx|pnpm (?:add|dlx)|bun (?:add|x))\b[^`\n]*/g)]
  .map(([command]) => command)
  .filter((command) => !command.includes("--filter") && /@smthrs\/cli(?=[\s";]|$)/.test(command))

describe("the CLI reference", () => {
  const pagesDirectory = join(root, "apps/site/src/content/docs/docs/reference/cli")
  const manifest = JSON.parse(readFileSync(join(root, "apps/site/src/data/cli-commands.json"), "utf8"))
  const canonical = [...new Set(manifest.commands.map((command) => command.name.split(" ")[0]))]
  const help = readFileSync(join(root, "apps/site/src/data/help/smthrs.txt"), "utf8")
  const retired = new Set(JSON.parse(readFileSync(join(root, "apps/site/docs/retired-pages.json"), "utf8"))
      .filter(path => path.includes("/reference/cli/"))
      .map(path => path.split("/").at(-1).replace(/\.mdx$/, "")))

  // d655971f6 generates one page per canonical command from --help and keeps
  // no pages for compatibility verbs; `index` lives at index-command.mdx
  // because index.mdx is the listing.
  it("documents every canonical command, the durable groups among them, on its own page", () => {
    const durableGroups = ["flow", "runs", "approvals"]
    for (const group of durableGroups) assert.ok(canonical.includes(group), `${group} must be a public command`)
    const pages = cliPages(pagesDirectory).map((page) => page === "index-command" ? "index" : page)
    assert.deepEqual(compare(canonical.filter(command => !retired.has(command)), canonical, pages), [])
  })

  it("indexes every retained public command and preserves help for retired pages", () => {
    assert.equal(manifest.version, "incur.v1")
    assert.ok(canonical.length > 0)
    const indexed = indexedCommands(readFileSync(join(pagesDirectory, "index.mdx"), "utf8"))
    assert.deepEqual(canonical.filter((command) => !retired.has(command) && !indexed.has(command)), [])
    for (const command of retired) {
      assert.ok(canonical.includes(command), `${command}: retained source manifest`)
      assert.ok(readFileSync(join(root, `apps/site/src/data/help/${command}.txt`), "utf8").length > 0, `${command}: retained help`)
    }
  })

  it("accepts a canonical page that has no legacy handler", () => {
    assert.deepEqual(compare(["status"], ["status", "runs"], ["status", "runs"]), [])
  })

  it("rejects an added page for a nonexistent verb", () => {
    const directory = mkdtempSync(join(tmpdir(), "smithers-cli-reference-"))
    try {
      writeFileSync(join(directory, "run.mdx"), "")
      writeFileSync(join(directory, "imaginary.mdx"), "")
      assert.deepEqual(compare(["run"], ["run"], cliPages(directory)), [
        "reference/cli/imaginary.mdx documents no shipped verb: imaginary"
      ])
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it("rejects a removed page for a shipped verb", () => {
    const directory = mkdtempSync(join(tmpdir(), "smithers-cli-reference-"))
    try {
      writeFileSync(join(directory, "run.mdx"), "")
      assert.deepEqual(compare(["run", "status"], ["run", "status"], cliPages(directory)), [
        "shipped verb has no reference/cli page: status"
      ])
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it("names the dist-tag the update command actually reads", () => {
    const files = [
      ...markdownFiles(join(root, "packages/smithers/docs")),
      ...markdownFiles(join(root, "apps/docs/cli/src/content/docs")),
      ...markdownFiles(join(root, "apps/site/src/content/docs/docs"))
    ]
    const stale = files.flatMap((file) => {
      const contents = readFileSync(file, "utf8")
      return /(?:the |against the? )?`rc` and `latest`|under the `rc` tag|compares `rc` first|available \(rc\)/.test(contents)
        ? [file.slice(root.length + 1)]
        : []
    })

    assert.deepEqual(stale, [], `update documentation must name the next dist-tag:\n${stale.join("\n")}`)
  })

  it("keeps installation commands on a published CLI tag", () => {
    const files = [
      ...markdownFiles(join(root, "packages")),
      ...markdownFiles(join(root, "apps/site/src/content/docs"))
    ]
    const stale = files.flatMap((file) => untaggedCliCommands(readFileSync(file, "utf8"))
      .map(() => file.slice(root.length + 1)))
    assert.deepEqual(stale, [], `CLI install commands need an explicit tag: ${stale.join(", ")}`)
  })

  it("checks each install command without absorbing adjacent inline prose", () => {
    assert.deepEqual(untaggedCliCommands("`npx smthrs <verb>` runs `@smthrs/cli`."), [])
    assert.deepEqual(untaggedCliCommands("`@smthrs/cli`, which makes `npx smthrs <verb>` work."), [])
    assert.deepEqual(untaggedCliCommands("`npm install @smthrs/cli@next`; `pnpm add @smthrs/cli`"), ["pnpm add @smthrs/cli"])
    assert.deepEqual(untaggedCliCommands("```sh\nbun add @smthrs/cli\nnpx --package @smthrs/cli smthrs\n```"), [
      "bun add @smthrs/cli", "npx --package @smthrs/cli smthrs"
    ])
  })

  it("documents the public help, schema, and presentation flags", () => {
    const page = readFileSync(join(pagesDirectory, "index.mdx"), "utf8")
    for (const flag of ["--help", "--schema", "--format", "--silent", "--audience"]) {
      assert.match(help, new RegExp(`^  ${flag}(?:\\s|,|$)`, "m"), `${flag} must be accepted by the public parser`)
      assert.match(page, new RegExp("`" + flag + "(?:\\s|`)"), `${flag} needs an explanation in the CLI reference`)
    }
  })

  it("distinguishes the ordinary review flow from the model-review target command", () => {
    const page = readFileSync(join(root, "apps/site/src/content/docs/docs/reference/cli/review.mdx"), "utf8")
    const flow = readFileSync(join(root, "flows/review/README.md"), "utf8")
    assert.ok(page.includes('title: "smthrs review"'))
    assert.ok(flow.includes("`/review`"))
    assert.ok(flow.includes("`smthrs review <pattern>`"))
    assert.ok(flow.includes("model-review targets"))
    assert.ok(flow.includes("smthrs flow start review"))
    assert.ok(!flow.includes("`smithers-review`"))
    assert.ok(!flow.includes("review` subcommand was removed"))
  })

})
