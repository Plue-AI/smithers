/*
 * The `wiki` flows: the shared wiki operations (`@smthrs/ui/app-operations/wiki`)
 * bound to the controller. The surface id, the card kind, the store events
 * and the CSS classes keep the `world` prefix so persisted sessions load
 * unchanged; only what a person reads or types says Wiki. entries/world.ts
 * registers the old names as hidden aliases over the same controller calls.
 */
import { wikiCard } from "../../state/seams/DesignWorld/subjects"
import { WIKI_DISPLAY_NAME, wikiOperations, wikiSurfaceOperations } from "@smthrs/ui/app-operations/wiki"
import { Schema } from "effect"
import { bind, flow, type CommandActions } from "./Declare"
import type { FlowEntry, Namespace, Recommendation } from "../registry"

/** The `wiki` namespace row: the slash tree lists it in registry.ts NAMESPACES order. */
export const namespace: Namespace = { id: "wiki", label: WIKI_DISPLAY_NAME, summary: "What Smithers understands" }

/** The Wiki leads connect once something is connected. */
export const recommendations: ReadonlyArray<Recommendation> = [
  { name: "wiki", when: () => true, rank: (state) => (state.hasConnectors ? 1 : 2) }
]

/** The bare `wiki` surface switch, registered first with the other top-level surfaces. */
export const wikiSurfaceFlows = (actions: CommandActions): ReadonlyArray<FlowEntry> =>
  /* MOCK SEAM (DesignWorld/subjects.ts): the seeded wiki's first page stands in for the repository wiki. */
  bind(wikiSurfaceOperations, { wiki: async () => {
    const page = actions.design.world().wiki[0]
    return page === undefined ? actions.showWorld() : { value: await actions.presentSubject(wikiCard(page.id, page.title)) }
  } })

/** The `wiki.*` flows: the shared wiki operations bound to the controller. */
export const wikiFlows = (actions: CommandActions): ReadonlyArray<FlowEntry> =>
  [...bind(wikiOperations.filter(operation => operation.name !== "wiki.ask"), {
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
  }), flow({
    name: "wiki.save", summary: "Save this answer as a page", args: "<name>",
    input: Schema.Struct({ name: Schema.NonEmptyString, text: Schema.optional(Schema.String) }),
    grammar: args => {
      if (!args?.trim().startsWith("{")) return { payload: args?.trim() ? { name: args.trim() } : {} }
      try {
        const payload: unknown = JSON.parse(args)
        return payload && typeof payload === "object" && !Array.isArray(payload)
          ? { payload: payload as Record<string, unknown> } : { error: "Invalid page input" }
      } catch { return { error: "Invalid page input" } }
    },
    form: { submitLabel: "Save", fields: { text: { hidden: true } }, args: payload => JSON.stringify(payload) },
    // Keep the existing shared operation as the authority. Its current contract is a refresh;
    // T-APP-02 cannot manufacture a page write when wiki.create accepts only a repository.
    handler: () => "Saving answers is unavailable."
  })]
