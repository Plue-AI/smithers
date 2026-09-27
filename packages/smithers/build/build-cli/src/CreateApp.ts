/**
 * `smithers-build create-app <dir>`: copy a `@smthrs/create-app` template into a new
 * directory.
 *
 * The templates ship inside `@smthrs/create-app`, so the CLI resolves them
 * through Node rather than knowing a path. Scaffolding is a file copy plus one
 * substitution: `__APP_NAME__` becomes the directory's own name.
 *
 * @since 0.1.0
 */

import * as NodeFs from "node:fs/promises"
import { createRequire } from "node:module"
import * as NodePath from "node:path"

/** File extensions whose contents carry the app name. */
const substituted = new Set([".css", ".html", ".json", ".jsonc", ".md", ".mjs", ".ts", ".tsx"])

/** The placeholder a template writes wherever the app's own name belongs. */
const placeholder = "__APP_NAME__"

/** npm's name grammar, minus the scoped form: a directory name is the app name. */
const appName = /^[a-z0-9][a-z0-9._-]*$/

/**
 * What one scaffold did.
 *
 * @category models
 * @since 0.1.0
 */
export interface ScaffoldReport {
  readonly directory: string
  readonly name: string
  readonly template: string
  readonly files: number
}

/**
 * What one scaffold takes.
 *
 * @category models
 * @since 0.1.0
 */
export interface ScaffoldOptions {
  readonly directory: string
  /** Template name. Defaults to `default`. */
  readonly template?: string | undefined
  /** Template directory. Defaults to the one inside the resolved `@smthrs/create-app`. */
  readonly templateRoot?: string | undefined
}

/**
 * Locates the `template` directory of the installed `@smthrs/create-app`.
 *
 * @category constructors
 * @since 0.1.0
 */
export const templateRoot = (): string => {
  const require = createRequire(import.meta.url)
  let manifest: string
  try {
    manifest = require.resolve("@smthrs/create-app/package.json")
  } catch {
    throw new Error("create-app templates ship in @smthrs/create-app; install it and try again")
  }
  return NodePath.join(NodePath.dirname(manifest), "template")
}

/**
 * The template names a template directory offers, sorted.
 *
 * @category constructors
 * @since 0.1.0
 */
export const templates = async (root: string): Promise<ReadonlyArray<string>> => {
  const entries = await NodeFs.readdir(root, { withFileTypes: true })
  return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort()
}

/**
 * Directories a template never ships, however dirty the checkout is.
 *
 * A template is an ordinary directory, so anything a tool leaves in it is
 * copied. Running the template's own suite from the checkout writes
 * `node_modules/.vite`, and that debris was copied into every scaffolded app.
 * `.smithers` is deliberately absent: templates ship one.
 */
const skipped = new Set(["node_modules", "dist", ".wrangler", ".flows"])

/** Copies `from` into `to`, substituting the app name, and counts the files. */
const copy = async (from: string, to: string, name: string): Promise<number> => {
  await NodeFs.mkdir(to, { recursive: true })
  let files = 0
  for (const entry of await NodeFs.readdir(from, { withFileTypes: true })) {
    if (skipped.has(entry.name)) continue
    const source = NodePath.join(from, entry.name)
    // npm drops literal .gitignore files from packages; templates ship _gitignore instead.
    const target = NodePath.join(to, entry.name === "_gitignore" ? ".gitignore" : entry.name)
    if (entry.isDirectory()) {
      files += await copy(source, target, name)
      continue
    }
    if (substituted.has(NodePath.extname(entry.name))) {
      const contents = await NodeFs.readFile(source, "utf8")
      await NodeFs.writeFile(target, contents.replaceAll(placeholder, name))
    } else {
      await NodeFs.copyFile(source, target)
    }
    files += 1
  }
  return files
}

/**
 * Copies one template into a new directory.
 *
 * @example
 * ```ts
 * import { scaffold } from "@smthrs/build-cli/CreateApp"
 *
 * await scaffold({ directory: "./ledger", template: "default" })
 * ```
 *
 * @category constructors
 * @since 0.1.0
 */
export const scaffold = async (options: ScaffoldOptions): Promise<ScaffoldReport> => {
  const template = options.template ?? "default"
  const root = options.templateRoot ?? templateRoot()
  const available = await templates(root)
  if (!available.includes(template)) {
    throw new Error(`unknown template ${JSON.stringify(template)}; available: ${available.join(", ")}`)
  }

  const directory = NodePath.resolve(options.directory)
  const name = NodePath.basename(directory)
  if (!appName.test(name)) {
    throw new Error(`${JSON.stringify(name)} is not a usable app name; use lowercase letters, digits, ., _, and -`)
  }
  // An existing empty directory is fine; anything in it is not, because the
  // copy would merge into a tree the caller did not expect it to touch.
  const existing = await NodeFs.readdir(directory).catch(() => [])
  if (existing.length > 0) throw new Error(`${directory} is not empty`)

  const files = await copy(NodePath.join(root, template), directory, name)
  return { directory, name, template, files }
}
