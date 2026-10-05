import { headingLine } from "../../cards/MarkdownLinks"
import type { Docs } from "../../../docs/Docs"
import { docsPage, unknownDocsPage } from "../../../docs/Docs"
import type { Card } from "../AppState"
import type { ControllerContext } from "./context"

/*
 * The in-app docs (M-35). `docs [page]` embeds one page as a read-only
 * Markdown card for either actor, the way `wiki.open` embeds a note;
 * `docs.read <page>` hands the agent the same page as data. A slug no page
 * answers is a refusal that names every page there is.
 */
export interface DocsController {
  /** `docs [page]`: embed the page (the toc's first when none is named) and tell the agent what was embedded. */
  readonly docsTargetAvailable: (target: string) => boolean
  readonly docsAvailable: () => boolean
  readonly openDocsPage: (page?: string) => string | { readonly value: string }
  /** `docs.read <page>`: the page's title, summary and Markdown as JSON. */
  readonly readDocsPage: (page: string) => string | { readonly value: string }
}

export const createDocsController = (
  ctx: ControllerContext,
  deps: { readonly nextOrdinal: () => number; readonly docs: () => Docs; readonly available: () => boolean }
): DocsController => {
  const openDocsPage = (page?: string): string | { readonly value: string } => {
    if (!deps.available()) return "Docs catalog is unavailable"
    const docs = deps.docs()
    const wanted = page?.trim() || docs.pages[0]!.slug
    const [slug, anchor] = wanted.split("#", 2)
    const requested = docsPage(docs, slug!)
    const found = requested ?? docs.pages[0]!
    const id = `docs-${found.slug}`
    const existing = ctx.store.collections.cards.get(id)
    const card: Extract<Card, { kind: "docs" }> = {
      id,
      kind: "docs",
      title: found.title,
      status: "active",
      createdAt: existing?.createdAt ?? Date.now(),
      ordinal: deps.nextOrdinal(),
      payload: { page: found.slug, markdown: found.markdown, summary: found.summary,
        toc: docs.pages.map(({ slug, title }) => ({ slug, title })),
        ...(requested && anchor ? { anchor } : {}),
        ...(requested ? {} : { not_found: slug }) }
    }
    ctx.store.dispatch({ type: "card.upsert", actor: ctx.commandActor, card })
    return { value: `Embedded the ${found.title} docs page.` }
  }

  const readDocsPage = (page: string): string | { readonly value: string } => {
    if (!deps.available()) return "Docs catalog is unavailable"
    const docs = deps.docs()
    const found = docsPage(docs, page.trim())
    if (found === undefined) return unknownDocsPage(docs, page.trim())
    return { value: JSON.stringify({ title: found.title, summary: found.summary, markdown: found.markdown }) }
  }

  const docsTargetAvailable = (target: string) => {
    if (!deps.available()) return false
    const [slug, anchor] = target.split("#", 2)
    const found = docsPage(deps.docs(), slug!)
    return found !== undefined && (!anchor || headingLine(found.markdown, anchor) !== undefined)
  }
  return { docsTargetAvailable, docsAvailable: deps.available, openDocsPage, readDocsPage }
}
