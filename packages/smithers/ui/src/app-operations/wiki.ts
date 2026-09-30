/*
 * The `wiki` operations: the canonical names of the notes pane renamed from
 * World to Wiki (2026-09-07). Only what a person reads or types says Wiki;
 * the GUI keeps its `world` ids so persisted sessions load unchanged.
 */
import { Schema } from "effect"
import { NoInput, operation } from "./index"

/** The product name of Smithers' understanding of a repository. */
export const WIKI_DISPLAY_NAME = "Wiki"

/** Why `wiki.heading` is the human's alone: it scrolls their editor, which is focus. */
export const WIKI_HEADING_USER_ONLY_REASON = "scrolling the open note's editor to a heading is the human's viewport gesture; the agent reads a note with wiki.open"

/** Why `wiki.attach` is the human's alone: the file comes from their own file dialog. */
export const WIKI_ATTACH_USER_ONLY_REASON = "the file comes from the human's own file dialog; a model has no file to give"

/** Why `wiki.ask` is the human's alone: the question is their turn, as the composer is. */
export const WIKI_ASK_USER_ONLY_REASON = "the question is the human's turn; the model is already the turn, and asking would nest one — it reads a page with wiki.open"

/** Why answering the delete confirmation is the human's alone. */
const CONFIRM_ANSWER_REASON = "a confirm-dialog answer is the human's"

const Space = Schema.Literals(["public", "private"])

/** The bare `wiki` surface switch, registered first with the other top-level surfaces. */
export const wikiSurfaceOperations = [
  operation({
    name: "wiki",
    summary: `See what Smithers understands (${WIKI_DISPLAY_NAME})`,
    input: NoInput
  })
] as const

/** The `wiki.*` operations: notes, repository Wiki pages and their confirmations. */
export const wikiOperations = [
  operation({
    /*
     * Ask the codebase (PRODUCT.md D-18): opened without a question it renders
     * its form; the answer is the conversation's next turn, which cites the
     * Wiki (wiki.open).
     */
    name: "wiki.ask",
    summary: "Ask the codebase a question; the answer cites the Wiki",
    userOnly: true,
    userOnlyReason: WIKI_ASK_USER_ONLY_REASON,
    args: "<question>",
    form: { submitLabel: "Ask", fields: { question: { label: "Question" } } },
    input: Schema.Struct({ question: Schema.String })
  }),
  operation({
    /* The stack refreshes the Wiki; this door asks for it now and is the Retry of a failed refresh. */
    name: "wiki.create",
    summary: "Refresh the repository Wiki in the background",
    args: "<owner/repo>",
    requires: ["signed-in"],
    confirm: "refresh the repository Wiki",
    input: Schema.Struct({ repo: Schema.NonEmptyString }),
    /* Typed owner/repo, with the loaded repositories offered: the grammar reads only that shape. */
    form: { fields: { repo: { optionsFrom: "cloud-repos", kind: "text", label: "Repository" } } }
  }),
  operation({
    name: "wiki.cloud",
    summary: "Browse the repository Wiki",
    args: "<owner/repo> [page] [--space public|private]",
    input: Schema.Struct({ repo: Schema.String, page: Schema.optional(Schema.Number), space: Schema.optional(Space) }),
    form: { fields: { repo: { optionsFrom: "cloud-repos", kind: "text" }, space: { hidden: true } } }
  }),
  operation({
    name: "wiki.cloud.open",
    summary: "Open a collaborative repository Wiki page in the conversation",
    args: "<slug> <owner/repo> [--space public|private]",
    input: Schema.Struct({ slug: Schema.String, repo: Schema.String, space: Schema.optional(Space) }),
    form: { fields: { space: { hidden: true } } }
  }),
  operation({
    name: "wiki.sync",
    summary: "Refresh a cloud Wiki page and retry its saved edits",
    args: "<documentId>",
    input: Schema.Struct({ documentId: Schema.String })
  }),
  operation({
    name: "wiki.edit",
    summary: "Edit a Wiki page as Markdown",
    args: "<documentId> <JSON Markdown string>",
    input: Schema.Struct({ documentId: Schema.String, body: Schema.String }),
    form: { fields: { body: { label: "Markdown" } }, args: (payload) => `${payload.documentId} ${JSON.stringify(payload.body)}` }
  }),
  operation({
    name: "wiki.card.select",
    summary: "Select a page in an embedded Wiki card",
    hidden: true,
    args: "<cardId> <documentId>",
    input: Schema.Struct({ cardId: Schema.String, documentId: Schema.String })
  }),
  operation({
    name: "wiki.card.view",
    summary: "Show a Wiki page outline or its Markdown document",
    hidden: true,
    args: "<cardId> <outline|read|document>",
    input: Schema.Struct({ cardId: Schema.String, view: Schema.Literals(["outline", "read", "document"]) })
  }),
  operation({
    name: "wiki.new-note",
    summary: `Create a ${WIKI_DISPLAY_NAME} note`,
    input: NoInput
  }),
  operation({
    name: "wiki.select",
    summary: `Open a ${WIKI_DISPLAY_NAME} note`,
    hidden: true,
    args: "<documentId>",
    input: Schema.Struct({ documentId: Schema.String })
  }),
  /*
   * The vault kit's three reads (Librarian L5; wiki.open is the citation
   * door). Each takes a note by path, file stem or title, so a `[[wikilink]]`
   * target and a citation ref both resolve.
   */
  operation({
    name: "wiki.open",
    summary: `Open a ${WIKI_DISPLAY_NAME} note by path or title`,
    args: "<path>",
    input: Schema.Struct({ path: Schema.String })
  }),
  operation({
    name: "wiki.backlinks",
    summary: "Notes that link to a note, and where it links out",
    args: "<path>",
    input: Schema.Struct({ path: Schema.String })
  }),
  operation({
    name: "wiki.graph",
    summary: `The ${WIKI_DISPLAY_NAME} link graph, whole or around one note`,
    args: "[path]",
    input: Schema.Struct({ path: Schema.optional(Schema.String) })
  }),
  operation({
    /* Scrolling the human's own viewport is a focus gesture; a model reads a note with wiki.open. */
    name: "wiki.heading",
    summary: "Scroll the open note to a heading",
    hidden: true,
    userOnly: true,
    userOnlyReason: WIKI_HEADING_USER_ONLY_REASON,
    args: "<line> [cardId]",
    input: Schema.Struct({ line: Schema.String, cardId: Schema.optional(Schema.String) })
  }),
  operation({
    name: "wiki.delete",
    summary: `Delete a ${WIKI_DISPLAY_NAME} note`,
    hidden: true,
    args: "<documentId>",
    input: Schema.Struct({ documentId: Schema.String })
  }),
  operation({
    /* Deleting a note asks first; a model may ASK and may never answer for the human. */
    name: "wiki.delete.confirm",
    summary: "Delete the note Smithers asked about",
    hidden: true,
    userOnly: true,
    userOnlyReason: CONFIRM_ANSWER_REASON,
    input: NoInput
  }),
  operation({
    name: "wiki.delete.cancel",
    summary: "Keep the note Smithers asked about",
    hidden: true,
    userOnly: true,
    userOnlyReason: CONFIRM_ANSWER_REASON,
    input: NoInput
  }),
  operation({
    /*
     * The wiki spaces (#1922): one wiki per repository with a public part and
     * a private part. Every wiki door reads and writes the shown space unless
     * the line names one.
     */
    name: "wiki.space",
    summary: "Show the public or the private part of the repository Wiki",
    args: "public|private [owner/repo]",
    input: Schema.Struct({ space: Space, repo: Schema.optional(Schema.String) }),
    form: { fields: { repo: { hidden: true } } }
  }),
  operation({
    name: "wiki.view",
    summary: "Show the Wiki page rendered, or its editor",
    args: "read|edit",
    input: Schema.Struct({ view: Schema.Literals(["read", "edit"]) })
  }),
  operation({
    name: "wiki.cloud.new",
    summary: "Create a page in the repository Wiki",
    args: "<title> [owner/repo]",
    requires: ["signed-in"],
    input: Schema.Struct({ title: Schema.String, repo: Schema.optional(Schema.String) }),
    form: { submitLabel: "Create", fields: { title: { label: "Title" }, repo: { hidden: true } } }
  }),
  operation({
    name: "wiki.cloud.rename",
    summary: "Move a Wiki page to another path",
    args: "<slug> <path> [owner/repo]",
    requires: ["signed-in"],
    /* The page's button carries its slug; the form asks for the one thing it lacks, the path. */
    input: Schema.Struct({ slug: Schema.optional(Schema.String), path: Schema.String, repo: Schema.optional(Schema.String) }),
    form: { submitLabel: "Rename", fields: { slug: { hidden: true }, path: { label: "Path", placeholder: "Guides/Start.md" }, repo: { hidden: true } } }
  }),
  operation({
    /* Deleting a page is consequential: a model may ask, the human confirms. Its history stays. */
    name: "wiki.cloud.delete",
    summary: "Delete a Wiki page; its history stays",
    args: "<slug> [owner/repo]",
    requires: ["signed-in"],
    confirm: "delete the Wiki page",
    input: Schema.Struct({ slug: Schema.String, repo: Schema.optional(Schema.String) })
  }),
  operation({
    name: "wiki.history",
    summary: "Show a Wiki page's history: every revision, renames and the deletion included",
    args: "<slug> [owner/repo] [--space public|private]",
    input: Schema.Struct({ slug: Schema.String, repo: Schema.optional(Schema.String), page: Schema.optional(Schema.Number), space: Schema.optional(Space) }),
    form: { fields: { repo: { hidden: true }, page: { hidden: true }, space: { hidden: true } } }
  }),
  operation({
    /* The file comes from the human's own dialog (the gesture); a model has no file to give. */
    name: "wiki.attach",
    summary: "Attach a file to the repository Wiki",
    userOnly: true,
    userOnlyReason: WIKI_ATTACH_USER_ONLY_REASON,
    args: "<slug> [path] [owner/repo]",
    requires: ["signed-in"],
    input: Schema.Struct({ slug: Schema.String, path: Schema.optional(Schema.String), repo: Schema.optional(Schema.String) })
  }),
  operation({
    /*
     * The Wiki pane beside the chat (#1922). A surface switch is the human's
     * own act (THE EMBED LAW); a model reads the same wiki through `wiki` and
     * the wiki.* reads, which answer as embedded cards.
     */
    name: "wiki.pane",
    summary: `Open the ${WIKI_DISPLAY_NAME} beside the chat`,
    userOnly: true,
    userOnlyReason: "a surface switch; the model reads the wiki with wiki and wiki.cloud, which answer as embedded cards",
    input: NoInput
  })
] as const
