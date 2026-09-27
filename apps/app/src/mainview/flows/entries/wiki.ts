/*
 * The `wiki` flows: the canonical names of the notes pane Will renamed from
 * World to Wiki (2026-09-07). The surface id, the card kind, the store events
 * and the CSS classes keep the `world` prefix so persisted sessions load
 * unchanged; only what a person reads or types says Wiki. entries/world.ts
 * registers the old names as hidden aliases over the same controller calls.
 */
import { Schema } from "effect"
import { WIKI_DISPLAY_NAME } from "../../state/AppState"
import { flow, NoPayload } from "./Declare"
import type { FlowEntry, Namespace, Recommendation } from "../registry"
import type { CommandActions } from "./Declare"

/** The `wiki` namespace row: the slash tree lists it in registry.ts NAMESPACES order. */
export const namespace: Namespace = { id: "wiki", label: WIKI_DISPLAY_NAME, summary: "What Smithers understands" }

/** The Wiki leads connect once something is connected. */
export const recommendations: ReadonlyArray<Recommendation> = [
  { name: "wiki", when: () => true, rank: (state) => (state.hasConnectors ? 1 : 2) }
]

/** Why `wiki.heading` is the human's alone: it scrolls their editor, which is focus. */
export const WIKI_HEADING_USER_ONLY_REASON = "scrolling the open note's editor to a heading is the human's viewport gesture; the agent reads a note with wiki.open"

/** The bare `wiki` surface switch, registered first with the other top-level surfaces. */
export const wikiSurfaceFlows = (actions: CommandActions): ReadonlyArray<FlowEntry> => [
  flow({
    name: "wiki",
    summary: `See what Smithers understands (${WIKI_DISPLAY_NAME})`,
    input: NoPayload,
    handler: () => actions.showWorld()
  })
]

/** Why `wiki.ask` is the human's alone: the question is their turn, as the composer is (entries/chat.ts). */
export const WIKI_ASK_USER_ONLY_REASON = "the question is the human's turn; the model is already the turn, and asking would nest one — it reads a page with wiki.open"

/** The `wiki.*` flows: notes and their confirms. */
export const wikiFlows = (actions: CommandActions): ReadonlyArray<FlowEntry> => [
  flow({
    /*
     * The Ask the codebase app (PRODUCT.md D-18): opened without a question it
     * renders its form — the question box and Ask — and the answer is the
     * conversation's next turn, which cites the Wiki (the Librarian's pages,
     * wiki.open). The same turn the composer sends, under the app's name.
     */
    name: "wiki.ask",
    summary: "Ask the codebase a question; the answer cites the Wiki",
    userOnly: true,
    userOnlyReason: WIKI_ASK_USER_ONLY_REASON,
    args: "<question>",
    form: { submitLabel: "Ask", fields: { question: { label: "Question" } } },
    input: Schema.Struct({ question: Schema.String }),
    handler: ({ question }) => { actions.send(question) }
  }),
  flow({
    /* The stack refreshes the Wiki (StackSeam.refreshWiki); this door asks for it now and is the Retry of a failed refresh. */
    name: "wiki.create",
    summary: "Refresh the repository Wiki in the background",
    args: "<owner/repo>",
    requires: ["signed-in"],
    confirm: "refresh the repository Wiki",
    input: Schema.Struct({ repo: Schema.NonEmptyString }),
    /* Typed owner/repo, with the loaded repositories offered: the grammar reads only that shape. */
    form: { fields: { repo: { optionsFrom: "cloud-repos", kind: "text", label: "Repository" } } },
    handler: ({ repo }) => actions.refreshWiki(repo)
  }),
  flow({
    name: "wiki.cloud",
    summary: "Browse the repository Wiki",
    args: "<owner/repo> [page]",
    input: Schema.Struct({ repo: Schema.String, page: Schema.optional(Schema.Number) }),
    form: { fields: { repo: { optionsFrom: "cloud-repos", kind: "text" } } },
    handler: ({ repo, page }) => actions.listCloudWiki(repo, page)
  }),
  flow({
    name: "wiki.cloud.open",
    summary: "Open a collaborative repository Wiki page in the conversation",
    args: "<slug> <owner/repo>",
    input: Schema.Struct({ slug: Schema.String, repo: Schema.String }),
    handler: ({ slug, repo }) => actions.openCloudWiki(repo, slug)
  }),
  flow({
    name: "wiki.sync",
    summary: "Refresh a cloud Wiki page and retry its saved edits",
    args: "<documentId>",
    input: Schema.Struct({ documentId: Schema.String }),
    handler: ({ documentId }) => actions.retryCloudWiki(documentId)
  }),
  flow({
    name: "wiki.edit",
    summary: "Edit a Wiki page as Markdown",
    args: "<documentId> <JSON Markdown string>",
    input: Schema.Struct({ documentId: Schema.String, body: Schema.String }),
    form: { fields: { body: { label: "Markdown" } }, args: (payload) => `${payload.documentId} ${JSON.stringify(payload.body)}` },
    handler: ({ documentId, body }, _signal, _call, gesture) =>
      gesture?.wikiEditPrepared?.() ?? actions.changeWorldDocument(documentId, body)
  }),
  flow({
    name: "wiki.card.select",
    summary: "Select a page in an embedded Wiki card",
    hidden: true,
    args: "<cardId> <documentId>",
    input: Schema.Struct({ cardId: Schema.String, documentId: Schema.String }),
    handler: ({ cardId, documentId }) => actions.selectWikiCardDocument(cardId, documentId)
  }),
  flow({
    name: "wiki.card.view",
    summary: "Show a Wiki page outline or its Markdown document",
    hidden: true,
    args: "<cardId> <outline|document>",
    input: Schema.Struct({ cardId: Schema.String, view: Schema.Literals(["outline", "document"]) }),
    handler: ({ cardId, view }) => actions.setWikiCardView(cardId, view)
  }),
  flow({
    name: "wiki.new-note",
    summary: `Create a ${WIKI_DISPLAY_NAME} note`,
    input: NoPayload,
    handler: () => actions.createWorldDocument()
  }),
  flow({
    name: "wiki.select",
    summary: `Open a ${WIKI_DISPLAY_NAME} note`,
    hidden: true,
    args: "<documentId>",
    input: Schema.Struct({ documentId: Schema.String }),
    handler: ({ documentId }) => actions.selectWorldDocument(documentId)
  }),
  /*
   * The vault kit's three flows (Librarian L5; 07-librarian.md §8 registers
   * wiki.open as the citation door). Each takes a note by path, file stem
   * or title, so a `[[wikilink]]` target and a citation ref both resolve.
   * wiki.open, wiki.backlinks and wiki.graph embed their existing card for
   * either actor, preserving the conversation and composer.
   */
  flow({
    name: "wiki.open",
    summary: `Open a ${WIKI_DISPLAY_NAME} note by path or title`,
    args: "<path>",
    input: Schema.Struct({ path: Schema.String }),
    handler: ({ path }) => actions.openWorldDocument(path)
  }),
  flow({
    name: "wiki.backlinks",
    summary: "Notes that link to a note, and where it links out",
    args: "<path>",
    input: Schema.Struct({ path: Schema.String }),
    handler: ({ path }) => actions.showWorldLinks(path)
  }),
  flow({
    name: "wiki.graph",
    summary: `The ${WIKI_DISPLAY_NAME} link graph, whole or around one note`,
    args: "[path]",
    input: Schema.Struct({ path: Schema.optional(Schema.String) }),
    handler: ({ path }) => actions.showWorldGraph(path)
  }),
  flow({
    /*
     * The outline's heading click: the open note's editor scrolls to the
     * heading's source line. Scrolling the human's own viewport is a focus
     * gesture, so the agent has no door; it reads a note with wiki.open.
     */
    name: "wiki.heading",
    summary: "Scroll the open note to a heading",
    hidden: true,
    userOnly: true,
    userOnlyReason: WIKI_HEADING_USER_ONLY_REASON,
    args: "<line> [cardId]",
    input: Schema.Struct({ line: Schema.String, cardId: Schema.optional(Schema.String) }),
    handler: ({ line, cardId }) => actions.jumpToHeading(line, cardId)
  }),
  flow({
    name: "wiki.delete",
    summary: `Delete a ${WIKI_DISPLAY_NAME} note`,
    hidden: true,
    args: "<documentId>",
    input: Schema.Struct({ documentId: Schema.String }),
    handler: ({ documentId }) => actions.removeWorldDocument(documentId)
  }),
  flow({
    /*
     * §10.6 / §28.4: deleting a note asks first, and the answer is an act of
     * its own, the same shape `admin.grant` uses. The agent may ASK (it can
     * offer to tidy a note) and may never answer for the human.
     */
    name: "wiki.delete.confirm",
    summary: "Delete the note Smithers asked about",
    hidden: true,
    userOnly: true,
    userOnlyReason: "a confirm-dialog answer is the human's",
    input: NoPayload,
    handler: () => actions.confirmWorldDelete()
  }),
  flow({
    name: "wiki.delete.cancel",
    summary: "Keep the note Smithers asked about",
    hidden: true,
    userOnly: true,
    userOnlyReason: "a confirm-dialog answer is the human's",
    input: NoPayload,
    handler: () => actions.cancelWorldDelete()
  })
]
