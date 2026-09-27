import { Markdown } from "@smthrs/ui"
import { noteHref, parseWikilinks, pathFromHref } from "@smthrs/ui/vault"
import { useCallback, type ReactNode } from "react"
import type { WikiIndexPage, WikiIndexRow, WikiSpace } from "../state/AppState"
import { attachmentUrl } from "./WikiNavigation"

/*
 * The reading view of a wiki page (#1922): the Markdown rendered, every
 * `[[wikilink]]` a link that opens its page (the alias as its label, the
 * heading carried along), every `![[embed]]` an image inline (an attachment
 * of an image type), a download (any other attachment) or a link (a page),
 * and a target the space has no page for marked as unresolved. Resolution is
 * the backend's: the navigation index says which page each of this page's
 * links reaches (`metadata.links[].page_id`); nothing here resolves a target
 * by its own rules. The occurrences themselves are read with the vault's
 * fence-aware scanner, so a link inside code stays text, as the index also
 * excludes it.
 */

export interface WikiPageLink {
  readonly target: string
  readonly heading?: string
  readonly alias?: string
  readonly embed: boolean
  readonly pageId?: number
}

/** The sentinel href of a target the space has no page for; the stylesheet marks it, a click does nothing. */
export const UNRESOLVED_HREF = "#unresolved/"

/** The href a wikilink renders as: the page's note href, with the heading it names after `?h=`. */
export const wikiLinkHref = (path: string, heading?: string): string =>
  heading === undefined || heading === "" ? noteHref(path) : `${noteHref(path)}?h=${encodeURIComponent(heading)}`

/** What a rendered wikilink's href names: the page path and the heading, or the unresolved target, or nothing (an ordinary link). */
export const readWikiHref = (href: string): { readonly path: string; readonly heading?: string } | { readonly unresolved: string } | undefined => {
  if (href.startsWith(UNRESOLVED_HREF)) return { unresolved: decodeURIComponent(href.slice(UNRESOLVED_HREF.length)) }
  const [note, query] = href.split("?h=")
  const path = pathFromHref(note ?? "")
  if (path === "") return undefined
  return query === undefined ? { path } : { path, heading: decodeURIComponent(query) }
}

/** The index page one of this page's links reaches, by the server's resolution of that occurrence. */
export const resolveWikiLink = (
  links: ReadonlyArray<WikiPageLink>,
  index: WikiIndexRow | undefined,
  occurrence: { readonly target: string; readonly heading: string; readonly alias: string; readonly embed: boolean }
): WikiIndexPage | undefined => {
  const link = links.find((candidate) => candidate.target === occurrence.target && candidate.embed === occurrence.embed &&
    (candidate.heading ?? "") === occurrence.heading && (candidate.alias ?? "") === occurrence.alias)
    ?? links.find((candidate) => candidate.target === occurrence.target && candidate.embed === occurrence.embed)
    ?? links.find((candidate) => candidate.target === occurrence.target)
  return link?.pageId === undefined ? undefined : index?.pages.find((page) => page.id === link.pageId)
}

type Segment = { readonly kind: "markdown"; readonly text: string } | { readonly kind: "image"; readonly page: WikiIndexPage; readonly alt: string }

/**
 * The body as segments: Markdown with its wikilinks rewritten to links the
 * shared renderer draws, split around every image embed, which is its own
 * block. Pure, so the tests read the same rewrite the view renders.
 */
export const wikiPageSegments = (body: string, links: ReadonlyArray<WikiPageLink>, index: WikiIndexRow | undefined): ReadonlyArray<Segment> => {
  const segments: Array<Segment> = []
  let markdown = ""
  let cursor = 0
  for (const occurrence of parseWikilinks(body)) {
    const at = body.indexOf(occurrence.raw, cursor)
    if (at === -1) continue
    markdown += body.slice(cursor, at)
    cursor = at + occurrence.raw.length
    const page = resolveWikiLink(links, index, occurrence)
    const label = occurrence.alias || (occurrence.target ? `${occurrence.target}${occurrence.heading ? `#${occurrence.heading}` : ""}` : `#${occurrence.heading}`)
    if (page === undefined) {
      // A same-page heading link names no page: it scrolls this page.
      if (occurrence.target === "" && occurrence.heading !== "") { markdown += `[${label}](${wikiLinkHref("", occurrence.heading)})`; continue }
      markdown += `[${label}](${UNRESOLVED_HREF}${encodeURIComponent(occurrence.target || occurrence.raw)})`
      continue
    }
    if (occurrence.embed && page.attachment !== undefined && /^image\//.test(page.attachment.mediaType)) {
      if (markdown.trim() !== "") segments.push({ kind: "markdown", text: markdown })
      markdown = ""
      segments.push({ kind: "image", page, alt: occurrence.alias || page.path })
      continue
    }
    // The label is what the author wrote: the alias, else the target as typed.
    markdown += `[${label}](${wikiLinkHref(page.path, occurrence.heading)})`
  }
  markdown += body.slice(cursor)
  if (markdown.trim() !== "") segments.push({ kind: "markdown", text: markdown })
  return segments
}

/** Whether a rendered heading is the one a link names: the text, case and outer spaces aside. */
const sameHeading = (rendered: string | null, wanted: string): boolean => (rendered ?? "").trim().toLowerCase() === wanted.trim().toLowerCase()

export const WikiPageView = ({ body, links, index, repo, space, focusHeading, onOpen, onFocused }: {
  readonly body: string
  readonly links: ReadonlyArray<WikiPageLink>
  readonly index: WikiIndexRow | undefined
  readonly repo: string
  readonly space: WikiSpace
  /** A heading to bring into view once rendered (a `[[Page#Heading]]` link that opened this page). */
  readonly focusHeading?: string
  /** A wikilink was activated: the page it names (by path) and the heading, if any. */
  readonly onOpen: (path: string, heading?: string) => void
  readonly onFocused?: () => void
}) => {
  const segments = wikiPageSegments(body, links, index)
  const scrollTo = (root: HTMLElement, heading: string): boolean => {
    // The shared renderer draws a heading as `.sui-md-heading`, not an h-element.
    const target = [...root.querySelectorAll<HTMLElement>(".sui-md-heading, h1, h2, h3, h4, h5, h6")].find((node) => sameHeading(node.textContent, heading))
    if (target === undefined) return false
    target.scrollIntoView({ block: "start" })
    return true
  }
  // A ref callback runs on every commit: the heading a link named is scrolled to as soon as it is drawn.
  const bind = useCallback((root: HTMLDivElement | null) => {
    if (root === null || focusHeading === undefined) return
    if (scrollTo(root, focusHeading)) onFocused?.()
  }, [focusHeading, onFocused])
  const onLinkClick = (href: string, event: { readonly currentTarget: HTMLAnchorElement }) => {
    const named = readWikiHref(href)
    if (named === undefined) { window.open(href, "_blank", "noopener"); return }
    if ("unresolved" in named) return
    if (named.path === "") {
      const root = event.currentTarget.closest<HTMLElement>(".wiki-page")
      if (root !== null && named.heading !== undefined) scrollTo(root, named.heading)
      return
    }
    onOpen(named.path, named.heading)
  }
  return (
    <div className="wiki-page" data-testid="wiki-page" ref={bind}>
      {segments.map((segment, at) => segment.kind === "image"
        ? <figure key={at} className="wiki-embed" data-testid="wiki-embed">
          <img src={attachmentUrl(repo, space, segment.page)} alt={segment.alt} />
        </figure>
        : <Markdown key={at} className="wiki-page-markdown" content={segment.text} onLinkClick={onLinkClick} />)}
    </div>
  )
}

/** The links of one index page in the view's shape, or none while the index has not listed it. */
export const pageLinksOf = (index: WikiIndexRow | undefined, pageId: number | undefined): ReadonlyArray<WikiPageLink> =>
  pageId === undefined ? [] : index?.pages.find((page) => page.id === pageId)?.links ?? []

export type { ReactNode }
