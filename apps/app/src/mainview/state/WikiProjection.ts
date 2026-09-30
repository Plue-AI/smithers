import type { Card, WorldDocument } from "./AppState"
import { linkGraphOf, linksOf, neighbourhoodOf } from "../wiki/VaultAdapter"

type LinksCard = Extract<Card, { kind: "wiki-links" }>
type GraphCard = Extract<Card, { kind: "wiki-graph" }>

/** Card identity and selection persist; link decorations use the supplied document revision. */
export const projectWikiLinks = (card: LinksCard, documents: ReadonlyArray<WorldDocument>): LinksCard => {
  const document = documents.find(note => note.path === card.payload.path)
  const links = document === undefined ? undefined : linksOf(documents, document.path)
  const titled = (paths: ReadonlyArray<string>) => paths.map(path => ({ path, title: documents.find(note => note.path === path)?.title ?? path }))
  return { ...card, payload: { ...card.payload,
    title: document?.title ?? card.payload.title,
    backlinks: titled(links?.backlinks ?? []),
    linksOut: titled(links?.linksOut ?? []),
    unresolved: [...(links?.unresolved ?? [])]
  } }
}

/** A missing focus produces an empty view, never an unrelated whole-vault graph. */
export const projectWikiGraph = (card: GraphCard, documents: ReadonlyArray<WorldDocument>): GraphCard => {
  const whole = linkGraphOf(documents)
  const graph = card.payload.path === null ? whole : neighbourhoodOf(whole, card.payload.path) ?? { notes: [], links: [] }
  return { ...card, payload: { ...card.payload,
    notes: graph.notes.map(note => ({ path: note.path, title: note.title, linksOut: [...note.linksOut], backlinks: [...(note.backlinks ?? [])], missing: note.frontmatter?.missing === true })),
    links: graph.links.map(link => ({ source: link.source, target: link.target }))
  } }
}

/** A persisted snapshot is displayed only when its account and space are known. */
export const projectWikiCardRows = (
  card: Extract<Card, { kind: "world" }>,
  documents: ReadonlyArray<WorldDocument>,
  login: string | null | undefined
) => card.payload.documents.flatMap(entry => {
  const document = documents.find(row => entry.id === undefined ? row.path === entry.path : row.id === entry.id)
  const index = card.payload.index
  if (document?.cloud !== undefined) {
    if (login == null || login !== document.cloud.accountLogin ||
      (index !== undefined && (document.cloud.repo !== index.repo || (document.cloud.visibility ?? "public") !== (index.space ?? "public")))) return []
  }
  if (index !== undefined) {
    if (document !== undefined && document.cloud === undefined) return []
    // A legacy payload without a loaded, scoped page cannot establish which
    // space supplied its title/path. Fresh listing rows carry explicit scope.
    if (document?.cloud === undefined && (entry.cloud === undefined || entry.cloud.repo !== index.repo ||
      entry.cloud.visibility !== (index.space ?? "public") || entry.cloud.accountLogin !== login || login == null)) return []
  } else if (document === undefined && (entry.cloud !== undefined || entry.id?.startsWith("wiki:") === true)) return []
  return [{ entry, document }]
})
