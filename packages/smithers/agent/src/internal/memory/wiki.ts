/**
 * The wiki as `memory` reads it: the repository's page catalog, its skills,
 * and the dependency documentation a wiki refresh imported.
 *
 * - Pages are the `pages` of `.smithers/coding-project.json`, each read from
 *   its owning `document`.
 * - Skills are `.agents/skills/<name>/SKILL.md`, read where they live, so
 *   nothing is copied and nothing drifts.
 * - Dependency pages are the Markdown a wiki refresh imported under
 *   `.flows/wiki/deps/<name>/`, from the `docs` the workspace declares.
 * - Decisions pages are `factory/wiki/decisions/<item>.md`, the steering a
 *   person gave runs on one item, which `memory/mine` appends. They are
 *   pages; one the catalog already lists is read once, as its catalog page.
 *
 * Every read is best effort: a missing catalog is an empty wiki. A link, a
 * file a linked parent directory leads outside the root to, or a catalog
 * document outside the root or in a private tree, is never read.
 *
 * @since 1.0.0
 */

import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Path from "effect/Path"
import { headOf, inside, linked, normalizePath, unreadable } from "./repo.ts"

/**
 * One wiki candidate.
 *
 * @since 1.0.0
 * @private
 */
export interface Page {
  readonly kind: "page" | "skill" | "dep"
  readonly id: string
  readonly title: string
  readonly text: string
  /** A page whose inputs no longer hash to the source; omitted as `stale`. */
  readonly stale?: boolean | undefined
  /** The repository files the page explains, from its catalog spec. */
  readonly inputs?: ReadonlyArray<string> | undefined
}

/**
 * The most of one page a candidate carries.
 *
 * @since 1.0.0
 * @private
 */
export const pageBytes = 32 * 1024

/**
 * Where a wiki refresh imports declared dependency documentation.
 *
 * @since 1.0.0
 * @private
 */
export const depsDirectory = ".flows/wiki/deps"

/**
 * Where `memory/mine` appends each item's decisions page.
 *
 * @since 1.0.0
 * @private
 */
export const decisionsDirectory = "factory/wiki/decisions"

const catalogPath = ".smithers/coding-project.json"
const skillsDirectory = ".agents/skills"

// A link is never read, nor a file a linked parent directory leads outside
// `root` to: its target may lie anywhere.
const text = (root: string, file: string) =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    if (yield* linked(fs, file)) return undefined
    const real = yield* inside(fs, path, yield* fs.realPath(root), file).pipe(
      Effect.catch(unreadable<string | undefined>(undefined))
    )
    if (real === undefined) return undefined
    // A catalog entry naming a directory, or anything but a file, is skipped.
    const info = yield* fs.stat(file).pipe(Effect.catch(unreadable<FileSystem.File.Info | undefined>(undefined)))
    if (info?.type !== "File") return undefined
    return yield* fs.readFileString(file).pipe(
      Effect.map((value): string | undefined => headOf(value, pageBytes)),
      Effect.catch(unreadable(undefined))
    )
  })

const pages = (root: string) =>
  Effect.gen(function*() {
    const path = yield* Path.Path
    const found: Array<Page> = []
    const documents = new Set<string>()
    const raw = yield* text(root, path.join(root, catalogPath))
    if (raw === undefined) return { found, documents }
    // Any JSON value parses, `null` included; only an object's `pages` array counts.
    const parsed = yield* Effect.try(() => JSON.parse(raw) as { pages?: unknown } | null).pipe(Effect.option)
    const specs = parsed._tag === "Some" && Array.isArray(parsed.value?.pages) ? parsed.value.pages : []
    for (const spec of specs as ReadonlyArray<Record<string, unknown>>) {
      // A document outside the root, or in a private tree, is never read.
      const document = typeof spec.document === "string" ? normalizePath(spec.document) : null
      if (typeof spec.id !== "string" || document === null) continue
      const body = yield* text(root, path.join(root, document))
      if (body === undefined) continue
      documents.add(document)
      found.push({
        kind: "page",
        id: spec.id,
        title: typeof spec.title === "string" ? spec.title : spec.id,
        text: body,
        inputs: Array.isArray(spec.inputs) ? spec.inputs.filter((input) => typeof input === "string") : []
      })
    }
    return { found, documents }
  })

const decisions = (root: string, listed: ReadonlySet<string>) =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const names = yield* fs.readDirectory(path.join(root, decisionsDirectory)).pipe(
      Effect.catch(unreadable<Array<string>>([]))
    )
    const found: Array<Page> = []
    for (const name of names.filter((file) => file.endsWith(".md")).sort()) {
      const relative = path.join(decisionsDirectory, name)
      if (listed.has(relative)) continue
      const body = yield* text(root, path.join(root, relative))
      if (body === undefined) continue
      const item = name.slice(0, -".md".length)
      found.push({ kind: "page", id: `decisions/${item}`, title: `Decisions: ${item}`, text: body })
    }
    return found
  })

const directory = (root: string, relative: string, kind: "skill" | "dep") =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const base = path.join(root, relative)
    const names = yield* fs.readDirectory(base).pipe(Effect.catch(unreadable<Array<string>>([])))
    const found: Array<Page> = []
    for (const name of names.sort()) {
      // Each entry is a directory of pages; a stray file is not a source.
      const info = yield* fs.stat(path.join(base, name)).pipe(Effect.catch(unreadable(undefined)))
      if (info?.type !== "Directory") continue
      const files = kind === "skill"
        ? ["SKILL.md"]
        : (yield* fs.readDirectory(path.join(base, name)).pipe(Effect.catch(unreadable<Array<string>>([])))).filter((file) => /\.mdx?$/i.test(file)).sort()
      for (const file of files) {
        const body = yield* text(root, path.join(base, name, file))
        if (body === undefined) continue
        const id = kind === "skill" ? name : `${name}/${file}`
        found.push({ kind, id, title: id, text: body })
      }
    }
    return found
  })

/**
 * Every catalog page, decisions page, skill and dependency page of `root`,
 * in that order.
 *
 * @since 1.0.0
 * @private
 */
export const catalog = (root: string) =>
  Effect.gen(function*() {
    const listed = yield* pages(root)
    const groups = yield* Effect.all([
      decisions(root, listed.documents),
      directory(root, skillsDirectory, "skill"),
      directory(root, depsDirectory, "dep")
    ])
    return [...listed.found, ...groups.flat()] satisfies ReadonlyArray<Page>
  })
