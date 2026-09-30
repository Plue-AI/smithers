/*
 * The `wiki` flows: the shared wiki operations (`@smthrs/ui/app-operations/wiki`)
 * bound to the controller. The surface id, the card kind, the store events
 * and the CSS classes keep the `world` prefix so persisted sessions load
 * unchanged; only what a person reads or types says Wiki. entries/world.ts
 * registers the old names as hidden aliases over the same controller calls.
 */
import { WIKI_DISPLAY_NAME, wikiOperations, wikiSurfaceOperations } from "@smthrs/ui/app-operations/wiki"
import { bind, type CommandActions } from "./Declare"
import type { FlowEntry, Namespace, Recommendation } from "../registry"

/** The `wiki` namespace row: the slash tree lists it in registry.ts NAMESPACES order. */
export const namespace: Namespace = { id: "wiki", label: WIKI_DISPLAY_NAME, summary: "What Smithers understands" }

/** The Wiki leads connect once something is connected. */
export const recommendations: ReadonlyArray<Recommendation> = [
  { name: "wiki", when: () => true, rank: (state) => (state.hasConnectors ? 1 : 2) }
]

/** The bare `wiki` surface switch, registered first with the other top-level surfaces. */
export const wikiSurfaceFlows = (actions: CommandActions): ReadonlyArray<FlowEntry> =>
  bind(wikiSurfaceOperations, { wiki: () => actions.showWorld() })

/** The `wiki.*` flows: the shared wiki operations bound to the controller. */
export const wikiFlows = (actions: CommandActions): ReadonlyArray<FlowEntry> =>
  bind(wikiOperations, {
    /* The answer is the conversation's next turn, the same turn the composer sends. */
    "wiki.ask": ({ question }) => { actions.send(question) },
    /* StackSeam.refreshWiki refreshes on stack changes; this is the manual door and the Retry. */
    "wiki.create": ({ repo }) => actions.refreshWiki(repo),
    "wiki.cloud": ({ repo, page, space }) => actions.listCloudWiki(repo, page, space),
    "wiki.cloud.open": ({ slug, repo, space }) => actions.openCloudWiki(repo, slug, undefined, space),
    "wiki.sync": ({ documentId }) => actions.retryCloudWiki(documentId),
    "wiki.edit": ({ documentId, body }, _signal, _call, gesture) =>
      gesture?.wikiEditPrepared?.() ?? actions.changeWorldDocument(documentId, body),
    "wiki.card.select": ({ cardId, documentId }) => actions.selectWikiCardDocument(cardId, documentId),
    "wiki.card.view": ({ cardId, view }) => actions.setWikiCardView(cardId, view),
    "wiki.new-note": () => actions.createWorldDocument(),
    "wiki.select": ({ documentId }) => actions.selectWorldDocument(documentId),
    /* wiki.open, wiki.backlinks and wiki.graph embed their card for either actor. */
    "wiki.open": ({ path }) => actions.openWorldDocument(path),
    "wiki.backlinks": ({ path }) => actions.showWorldLinks(path),
    "wiki.graph": ({ path }) => actions.showWorldGraph(path),
    "wiki.heading": ({ line, cardId }) => actions.jumpToHeading(line, cardId),
    "wiki.delete": ({ documentId }) => actions.removeWorldDocument(documentId),
    "wiki.delete.confirm": () => actions.confirmWorldDelete(),
    "wiki.delete.cancel": () => actions.cancelWorldDelete(),
    "wiki.space": ({ space, repo }) => actions.setWikiSpace(space, repo),
    "wiki.view": ({ view }) => actions.setWikiPageView(view),
    "wiki.cloud.new": ({ title, repo }) => actions.createCloudWikiPage(title, repo),
    "wiki.cloud.rename": ({ slug, path, repo }) =>
      slug === undefined || slug === "" ? "Choose a page to rename." : actions.renameCloudWikiPage(slug, path, repo),
    "wiki.cloud.delete": ({ slug, repo }) => actions.deleteCloudWikiPage(slug, repo),
    "wiki.history": ({ slug, repo, page, space }) => actions.showWikiHistory(slug, repo, page, space),
    "wiki.attach": ({ path, repo }, _signal, _call, gesture) => actions.attachCloudWiki(path ?? "", repo, gesture),
    "wiki.pane": () => actions.showWikiPane()
  })
