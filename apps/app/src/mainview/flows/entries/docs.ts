/*
 * The `docs` flows (M-35): the in-app docs, one Markdown page per file under
 * src/docs/pages. `/docs` embeds a page as a read-only card in the
 * conversation for either actor; a link in it to another page runs `docs`
 * again. `docs.read` is the agent's read of the same page, so it answers
 * "how do I" from the source the card renders. It returns data and embeds
 * nothing, so it stays out of the slash listing and is disclosed to the
 * agent instead (as setup.guide is).
 */
import { Schema } from "effect"
import { flow, type CommandActions } from "./Declare"
import type { FlowEntry } from "../registry"

export const docsFlows = (actions: CommandActions): ReadonlyArray<FlowEntry> => [
  flow({
    name: "docs",
    summary: "Read the docs in the app",
    args: "[page]",
    hidden: !actions.docsAvailable(),
    input: Schema.Struct({ page: Schema.optional(Schema.String) }),
    handler: ({ page }) => actions.openDocsPage(page)
  }),
  flow({
    name: "docs.read",
    summary: "Read a docs page's title, summary and Markdown",
    args: "<page>",
    hidden: true,
    discloseToAgent: actions.docsAvailable(),
    input: Schema.Struct({ page: Schema.String }),
    handler: ({ page }) => actions.readDocsPage(page)
  })
]
