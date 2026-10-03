import { installRequestId } from "../state/seams/InstallRequestId"
/*
 * The vault kit's contract (packages/smithers/ui/src/vault/types.ts) served
 * from the Wiki pane's documents (the `worldDocuments` collection). The
 * backlinks rail, the outline and the knowledge graph render whatever a
 * VaultAdapter answers; this adapter answers the person's notes.
 *
 * Links are the `[[wikilink]]` targets each note already records
 * (`document.links`, written by the editor and by the chain's remember).
 * A target resolves to a note by path, by file stem, or by title; a target
 * no note answers stays in the graph as a node flagged `missing`, so a
 * dangling link is visible instead of silently dropped.
 *
 * write() is for notes only: generated pages (Librarian L6) do not exist in
 * this collection yet, and when they do they refuse here with the reason.
 */
import { noteLabel, parseWikilinks, restoreWikilinks } from "@smthrs/ui/vault"
import type { VaultAdapter, VaultLink, VaultNoteMeta } from "@smthrs/ui/vault"
import type { WorldDocument } from "../state/AppState"
import type { AppStore } from "../state/AppStore"

/** What a note must carry to be linked; AppState's WorldDocument satisfies it. */
export interface LinkableNote {
  readonly id: string
  readonly path: string
  readonly title: string
  readonly body: string
  readonly links: ReadonlyArray<string>
  readonly updatedAt: number
}

/** The links of one note as the rail shows them: who links here, where it links out, and the targets no note answers. */
export interface NoteLinks {
  readonly backlinks: ReadonlyArray<string>
  readonly linksOut: ReadonlyArray<string>
  readonly unresolved: ReadonlyArray<string>
}

/** The graph payload: every note, every dangling target as a `missing` node, and one edge per resolved or dangling link. */
export interface LinkGraph {
  readonly notes: ReadonlyArray<VaultNoteMeta>
  readonly links: ReadonlyArray<VaultLink>
}

const stem = (path: string): string => noteLabel(path).toLowerCase()

/**
 * The note a `[[target]]` names: its exact path, its path without `.md`,
 * its file stem, or its title, the first match in that order. Case does not
 * matter for stems and titles: `[[world]]` reaches World.md.
 */
export const resolveLink = <N extends LinkableNote>(notes: ReadonlyArray<N>, target: string): N | undefined => {
  const wanted = target.trim()
  if (wanted === "") return undefined
  const lower = wanted.toLowerCase()
  return notes.find((note) => note.path === wanted)
    ?? notes.find((note) => note.path === `${wanted}.md`)
    ?? notes.find((note) => stem(note.path) === lower)
    ?? notes.find((note) => note.title.toLowerCase() === lower)
}

/** The path a dangling target would have as a note: the target itself, with `.md` when it names no file. */
export const missingPath = (target: string): string => (/\.[a-z0-9]+$/i.test(target) ? target : `${target}.md`)

/** Each note's outgoing links resolved to paths, with the dangling targets kept as their would-be paths. */
const outgoing = <N extends LinkableNote>(notes: ReadonlyArray<N>, note: N): { readonly resolved: string[]; readonly unresolved: string[] } => {
  const resolved: string[] = []
  const unresolved: string[] = []
  for (const target of note.links) {
    const found = resolveLink(notes, target)
    if (found === undefined) {
      if (target.trim() !== "" && !unresolved.includes(target)) unresolved.push(target)
    } else if (found.path !== note.path && !resolved.includes(found.path)) {
      resolved.push(found.path)
    }
  }
  return { resolved, unresolved }
}

/** The whole link graph in one pass; the same rows `links()` and `tree()` are cut from. */
export const linkGraphOf = <N extends LinkableNote>(notes: ReadonlyArray<N>): LinkGraph => {
  const backlinks = new Map<string, string[]>()
  const links: VaultLink[] = []
  const missing = new Map<string, string>()
  const metas: VaultNoteMeta[] = []
  const out = new Map<string, { readonly resolved: string[]; readonly unresolved: string[] }>()
  for (const note of notes) out.set(note.path, outgoing(notes, note))
  for (const note of notes) {
    const { resolved, unresolved } = out.get(note.path) ?? { resolved: [], unresolved: [] }
    for (const target of resolved) {
      links.push({ source: note.path, target, kind: "link" })
      const rows = backlinks.get(target) ?? []
      if (!rows.includes(note.path)) rows.push(note.path)
      backlinks.set(target, rows)
    }
    for (const target of unresolved) {
      const path = missingPath(target)
      missing.set(path, target)
      links.push({ source: note.path, target: path, kind: "link" })
    }
  }
  for (const note of notes) {
    const { resolved, unresolved } = out.get(note.path) ?? { resolved: [], unresolved: [] }
    metas.push({
      path: note.path,
      title: note.title,
      linksOut: [...resolved, ...unresolved.map(missingPath)],
      backlinks: backlinks.get(note.path) ?? [],
      mtimeMs: note.updatedAt
    })
  }
  for (const [path, target] of missing) {
    metas.push({ path, title: target, linksOut: [], backlinks: links.filter((link) => link.target === path).map((link) => link.source), frontmatter: { missing: true } })
  }
  return { notes: metas, links }
}

/**
 * The graph cut to one note and everything one hop away, the focused form
 * `wiki.graph <path>` renders. Undefined when no note answers the path.
 */
export const neighbourhoodOf = (graph: LinkGraph, path: string): LinkGraph | undefined => {
  const centre = resolveLink(graph.notes.map((note) => ({ ...note, id: note.path, body: "", links: note.linksOut, updatedAt: note.mtimeMs ?? 0 })), path)
  if (centre === undefined) return undefined
  const keep = new Set<string>([centre.path])
  for (const link of graph.links) {
    if (link.source === centre.path) keep.add(link.target)
    if (link.target === centre.path) keep.add(link.source)
  }
  return {
    notes: graph.notes.filter((note) => keep.has(note.path)),
    links: graph.links.filter((link) => keep.has(link.source) && keep.has(link.target))
  }
}

/** The links of the note at `path`, or undefined when no note is there. */
export const linksOf = <N extends LinkableNote>(notes: ReadonlyArray<N>, path: string): NoteLinks | undefined => {
  const note = resolveLink(notes, path)
  if (note === undefined) return undefined
  const { resolved, unresolved } = outgoing(notes, note)
  const backlinks = notes
    .filter((candidate) => candidate.path !== note.path && outgoing(notes, candidate).resolved.includes(note.path))
    .map((candidate) => candidate.path)
  return { backlinks, linksOut: resolved, unresolved }
}

/** The notes the store holds, in path order, the order the pane lists them. */
export const notesOf = (store: AppStore): ReadonlyArray<WorldDocument> =>
  [...store.collections.worldDocuments.values()].sort((left, right) => left.path.localeCompare(right.path))

/**
 * The VaultAdapter over the store. Reads are synchronous underneath and
 * wrapped in promises to meet the contract; a write lands through the
 * transition dispatcher as the user's act, so provenance and revision are
 * recorded like every editor keystroke.
 */
export const createVaultAdapter = (store: AppStore): VaultAdapter => {
  const find = (path: string): WorldDocument | undefined => resolveLink(notesOf(store), path)
  return {
    tree: async () => linkGraphOf(notesOf(store)).notes.filter((note) => note.frontmatter?.missing !== true),
    read: async (path) => {
      const note = find(path)
      if (note === undefined) throw new Error(`There is no Wiki note at ${path}.`)
      return note.body
    },
    write: async (path, content) => {
      const existing = find(path)
      const body = restoreWikilinks(content)
      const links = [...new Set(parseWikilinks(body).map((link) => link.target).filter(Boolean))]
      const document = existing === undefined
        ? {
          id: installRequestId(),
          path: missingPath(path),
          title: noteLabel(path),
          body,
          links,
          tags: [],
          sources: ["user:world-editor"],
          confidence: 1
        }
        : {
          id: existing.id,
          path: existing.path,
          title: existing.title,
          body,
          links,
          tags: existing.tags,
          sources: [...new Set([...existing.sources, "user:world-editor"])],
          confidence: existing.confidence
        }
      await store.dispatch({ type: "world.document.upserted", actor: "user", select: false, document }).isPersisted.promise
      return { mtimeMs: store.collections.worldDocuments.get(document.id)?.updatedAt }
    },
    links: async (path) => {
      const found = linksOf(notesOf(store), path)
      if (found === undefined) throw new Error(`There is no Wiki note at ${path}.`)
      return { backlinks: [...found.backlinks], linksOut: [...found.linksOut] }
    },
    graph: async () => {
      const graph = linkGraphOf(notesOf(store))
      return { notes: [...graph.notes], links: [...graph.links] }
    }
  }
}
