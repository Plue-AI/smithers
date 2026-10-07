import { docsCard, readDocsPage as readPage } from "@smthrs/rpc/DocsPages"
import { headingLine } from "../../cards/MarkdownLinks"
import type { Docs } from "../../../docs/Docs"
import { docsPage } from "../../../docs/Docs"
import type { ControllerContext } from "./context"

/*
 * The in-app docs (M-35). `docs [page]` embeds one page as a read-only
 * Markdown card for either actor, the way `wiki.open` embeds a note;
 * `docs {mode:"read", page}` hands the agent the same page as data. A slug no page
 * answers opens the first page with a not-found state. The card and the read
 * are @smthrs/rpc/DocsPages, which the model host binds for the app agent too.
 */
export interface DocsController {
  /** `docs [page]`: embed the page (the toc's first when none is named) and tell the agent what was embedded. */
  readonly docsTargetAvailable: (target: string) => boolean
  readonly docsAvailable: () => boolean
  readonly openDocsPage: (page?: string) => string | { readonly value: string }
  /** `docs {mode:"read", page}`: the page's title, summary and Markdown as JSON. */
  readonly readDocsPage: (page: string) => string | { readonly value: string }
}

export const createDocsController = (
  ctx: ControllerContext,
  deps: { readonly nextOrdinal: () => number; readonly docs: () => Docs; readonly available: () => boolean }
): DocsController => {
  const openDocsPage = (page?: string): string | { readonly value: string } => {
    if (!deps.available()) return "Docs catalog is unavailable"
    const { card, value } = docsCard(deps.docs().pages, page, deps.nextOrdinal(), Date.now())
    const existing = ctx.store.collections.cards.get(card.id)
    ctx.store.dispatch({ type: "card.upsert", actor: ctx.commandActor, card: { ...card, createdAt: existing?.createdAt ?? card.createdAt } })
    return { value }
  }

  const readDocsPage = (page: string): string | { readonly value: string } => {
    if (!deps.available()) return "Docs catalog is unavailable"
    const read = readPage(deps.docs().pages, page)
    return "error" in read ? read.error : read
  }

  const docsTargetAvailable = (target: string) => {
    if (!deps.available()) return false
    const [slug, anchor] = target.split("#", 2)
    const found = docsPage(deps.docs(), slug!)
    return found !== undefined && (!anchor || headingLine(found.markdown, anchor) !== undefined)
  }
  return { docsTargetAvailable, docsAvailable: deps.available, openDocsPage, readDocsPage }
}
