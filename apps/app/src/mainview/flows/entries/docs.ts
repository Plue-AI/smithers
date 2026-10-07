/*
 * The `docs` flows (M-35): the in-app docs, one Markdown page per file under
 * src/docs/pages. `/docs` embeds a page as a read-only card in the
 * conversation for either actor; a link in it to another page runs `docs`
 * again. The same command's read mode returns the page to the agent, so it answers
 * "how do I" from the source the card renders. It returns data and embeds
 * nothing, so it stays out of the slash listing and is disclosed to the
 * agent instead (as setup.guide is).
 */
import { Schema } from "effect"
import { flow, type CommandActions } from "./Declare"
import type { FlowEntry } from "../registry"

export const docsFlows = (actions: CommandActions): ReadonlyArray<FlowEntry> => {
  const available = typeof actions.docsAvailable === "function" && actions.docsAvailable()
  return [
  flow({
    name: "docs",
     slash: "/docs", cli: null, journey: [], group: "Ask", visibility: available ? "core" : "hidden", actors: ["person","app_agent"], minimumRole: "member", http: null, summary: "Read the docs in the app",
    args: "[page]",
    hidden: !available,
    agent: "run", input: Schema.Struct({ page: Schema.optional(Schema.String), mode: Schema.optional(Schema.Literals(["read"])) }),
    form: { fields: { mode: { hidden: true } }, requires: payload => payload.mode === "read" ? ["page"] : [],
      args: payload => payload.mode === "read" ? JSON.stringify(payload) : String(payload.page ?? "") },
    handler: ({ page, mode }) => mode === "read" ? actions.readDocsPage(page ?? "") : actions.openDocsPage(page)
  })
]
}
