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
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, it } from "node:test"

import { repoRoot as root } from "../workspace-packages.mjs"

const indexedCommands = (page) => new Set(page.split("\n")
  .filter((line) => line.startsWith("|"))
  .flatMap((line) => [...(line.split("|")[1] ?? "").matchAll(/`([^`]+)`/g)])
  .flatMap((match) => match[1].split(/\s/, 1)[0].split("/")))

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
  const reference = join(root, "packages/smithers/docs/reference/cli/README.md")
  const manifest = JSON.parse(readFileSync(join(root, "apps/site/src/data/cli-commands.json"), "utf8"))
  const canonical = [...new Set(manifest.commands.map((command) => command.name.split(" ")[0]))]
  const help = readFileSync(join(root, "apps/site/src/data/help/smthrs.txt"), "utf8")
  const retired = new Set(JSON.parse(readFileSync(join(root, "apps/site/docs/retired-pages.json"), "utf8"))
      .filter(path => path.includes("/reference/cli/"))
      .map(path => path.split("/").at(-1).replace(/\.mdx$/, "")))

  it("documents durable public command groups in the package reference", () => {
    const documented = indexedCommands(readFileSync(reference, "utf8"))
    for (const group of ["flow", "runs"]) {
      assert.ok(canonical.includes(group), `${group} must be a public command`)
      assert.ok(documented.has(group), `${group} must be documented in the package`)
    }
  })

  it("indexes every public command and preserves help for retained compatibility commands", () => {
    assert.equal(manifest.version, "incur.v1")
    assert.ok(canonical.length > 0)
    const indexed = indexedCommands(readFileSync(reference, "utf8"))
    assert.deepEqual(canonical.filter((command) => !retired.has(command) && !indexed.has(command)), [])
    for (const command of [...retired].filter((command) => canonical.includes(command))) {
      assert.ok(readFileSync(join(root, `apps/site/src/data/help/${command}.txt`), "utf8").length > 0, `${command}: retained help`)
    }
  })

  it("names the dist-tag the update command actually reads", () => {
    const files = [
      ...markdownFiles(join(root, "packages/smithers/docs")),
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
    const page = readFileSync(reference, "utf8")
    for (const flag of ["--help", "--schema", "--format", "--silent", "--audience"]) {
      assert.match(help, new RegExp(`^  ${flag}(?:\\s|,|$)`, "m"), `${flag} must be accepted by the public parser`)
      assert.match(page, new RegExp("`" + flag + "(?:\\s|`)"), `${flag} needs an explanation in the CLI reference`)
    }
  })

  it("distinguishes the ordinary review flow from the model-review target command", () => {
    const page = readFileSync(reference, "utf8")
    const flow = readFileSync(join(root, "flows/review/README.md"), "utf8")
    assert.ok(page.includes("build/test/lint/docs/review/ci/run"))
    assert.ok(flow.includes("`/review`"))
    assert.ok(flow.includes("`smthrs review <pattern>`"))
    assert.ok(flow.includes("model-review targets"))
    assert.ok(flow.includes("smthrs flow start review"))
    assert.ok(!flow.includes("`smithers-review`"))
    assert.ok(!flow.includes("review` subcommand was removed"))
  })

})
