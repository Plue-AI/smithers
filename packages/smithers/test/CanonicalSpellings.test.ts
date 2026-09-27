/**
 * Every command the CLI prints is spelled the way the canonical tree names it.
 *
 * Hidden transition aliases (`ls`, `ps`, `up`, `status`, `logs`, `approve`,
 * `run --resume`, ...) still run, but a message that teaches one teaches a
 * spelling the help and docs no longer show. The scan reads every string a
 * source file under `packages/smithers` can print, including the argument
 * lists handed to a shell-quoting helper, and resolves each `smthrs ...`
 * spelling against the canonical Incur manifest.
 */
import { readdirSync, readFileSync } from "node:fs"
import { join, relative } from "node:path"
import ts from "typescript"
import { describe, expect, it } from "vitest"
import { makeCli } from "../src/Cli.ts"
import { cli } from "../src/Command.ts"
import * as Unsupported from "../src/Unsupported.ts"

const packageRoot = join(import.meta.dirname, "..")

const capture = async (args: ReadonlyArray<string>): Promise<string> => {
  const environment = { ...process.env, NO_COLOR: "1" } as Record<string, string>
  let output = ""
  await makeCli({ environment }).serve([...args], {
    env: environment,
    stdout: (text) => {
      output += text
    },
    exit: () => {}
  })
  return output
}

interface Manifest {
  readonly commands: ReadonlyArray<{
    readonly name: string
    readonly schema?: { readonly options?: { readonly properties?: Record<string, unknown> } }
  }>
  readonly globals?: { readonly properties?: Record<string, unknown> }
}

const kebab = (name: string): string => name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)

const sources = (): ReadonlyArray<string> => {
  const files: Array<string> = []
  const walk = (directory: string, inSource: boolean): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) {
        if (["node_modules", "dist", "test", "fixtures"].includes(entry.name)) continue
        walk(path, inSource || entry.name === "src")
      } else if (
        inSource && /\.tsx?$/.test(entry.name) && !entry.name.endsWith(".d.ts") && !entry.name.includes(".test.")
      ) {
        files.push(path)
      }
    }
  }
  walk(packageRoot, false)
  return files
}

/** A substitution the scan cannot read; it ends a command path like any positional. */
const hole = "\u2026"

const printedTexts = (file: string): ReadonlyArray<{ readonly line: number; readonly text: string }> => {
  const contents = readFileSync(file, "utf8")
  // Every finding needs a literal spelling `smthrs`, so a file that never
  // spells it has nothing to read. Parsing only the files that do keeps the
  // scan of ~2,000 sources inside the test budget on a loaded runner.
  if (!contents.includes("smthrs")) return []
  const source = ts.createSourceFile(file, contents, ts.ScriptTarget.Latest, true)
  const texts: Array<{ line: number; text: string }> = []
  const literal = (node: ts.Node): string | undefined =>
    ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) ? node.text : undefined
  const visit = (node: ts.Node): void => {
    const line = source.getLineAndCharacterOfPosition(node.getStart()).line + 1
    const text = literal(node)
    if (text !== undefined) texts.push({ line, text })
    else if (ts.isTemplateExpression(node)) {
      texts.push({ line, text: [node.head.text, ...node.templateSpans.map((span) => span.literal.text)].join(hole) })
    } else if (ts.isCallExpression(node) && node.arguments.length > 0 && literal(node.arguments[0]!) === "smthrs") {
      // `shellCommand("smthrs", "runs", "logs", runId)` prints a command
      // no single literal spells.
      texts.push({ line, text: node.arguments.map((argument) => literal(argument) ?? hole).join(" ") })
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return texts
}

describe("printed command spellings", () => {
  it("name only canonical, non-hidden commands and their declared options", async () => {
    const manifest = JSON.parse(await capture(["--llms-full", "--format", "json"])) as Manifest
    const canonical = new Map(manifest.commands.map((command) => [command.name, command]))
    const paths = new Set(
      manifest.commands.flatMap((command) => {
        const words = command.name.split(" ")
        return words.map((_, index) => words.slice(0, index + 1).join(" "))
      })
    )
    const topLevel = new Set([...paths].filter((path) => !path.includes(" ")))
    // Every word the compatibility tree answers that the canonical one does not.
    const hidden = new Set(
      [
        ...cli.subcommands.flatMap((group) => group.commands.map((command) => command.name)),
        ...Unsupported.removedVerbs.map((verb) => verb.name)
      ].filter((name) => !topLevel.has(name))
    )
    const sharedFlags = new Set(
      [...(await capture(["--help"])).matchAll(/--([a-z][a-z0-9-]*)/g)].map((match) => match[1]!)
    )
    for (const name of Object.keys(manifest.globals?.properties ?? {})) sharedFlags.add(kebab(name))

    const findings: Array<string> = []
    for (const file of sources()) {
      for (const { line, text } of printedTexts(file)) {
        for (const match of text.matchAll(/(?<![\w@/.-])smthrs +(?=\S)/g)) {
          const tokens = text.slice(match.index + match[0].length).split(/\s+/)
          const where = `${relative(packageRoot, file)}:${line}: smthrs ${tokens.slice(0, 4).join(" ")}`
          const first = tokens[0]!.replace(/[`'".,;:)]+$/, "")
          if (hidden.has(first)) {
            findings.push(`${where} (hidden command ${first})`)
            continue
          }
          if (!topLevel.has(first)) continue
          let path = first
          let index = 1
          while (index < tokens.length && paths.has(`${path} ${tokens[index]!.replace(/[`'".,;:)]+$/, "")}`)) {
            path = `${path} ${tokens[index]!.replace(/[`'".,;:)]+$/, "")}`
            if (/[`'".,;:)]$/.test(tokens[index]!)) break
            index++
          }
          const options = new Set(
            Object.keys(canonical.get(path)?.schema?.options?.properties ?? {}).map(kebab)
          )
          for (; index < tokens.length; index++) {
            const token = tokens[index]!
            if (token === "smthrs" || token === "&&" || token === "|" || token === "#") break
            const flag = /^--([a-z][a-z0-9-]*)/.exec(token)?.[1]
            if (flag !== undefined && !options.has(flag) && !sharedFlags.has(flag)) {
              findings.push(`${where} (undeclared option --${flag} on ${path})`)
            }
            if (/[`;)]$/.test(token)) break
          }
        }
      }
    }
    expect(hidden.size).toBeGreaterThan(0)
    expect(findings).toEqual([])
  })
})
