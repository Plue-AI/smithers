/** The repository wiki, refreshed on one retained commit of the mythical stack. */
import { Flow } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import { Schema } from "effect"
import { RefreshWiki } from "../planning-wiki.ts"
import { CodingError } from "../schema.ts"
import { admitStackBase } from "../stack.ts"
import { ImportDocs, ReadPublishedWiki, WikiRefreshInput, WikiRefreshResult } from "../wiki-refresh.ts"

/**
 * The stack service runs this on the repository's wiki workspace after every
 * fold: it stands on the folded tip, imports the dependency documentation the
 * workspace declares, refreshes the verified wiki the project declares
 * (reusing every unchanged page's last review), and answers the pages the
 * service publishes.
 */
export default Flow.make("coding/Wiki", {
  description:
    "Refresh the repository wiki on one retained commit of the mythical stack and answer its verified pages.",
  capabilities: ["*"],
  effects: { reads: ["**"], writes: ["**"], mode: "expected", onConflict: "serialize", tier: "irreversible" },
  payload: WikiRefreshInput,
  success: WikiRefreshResult,
  error: Schema.Union([CodingError, RefreshWiki.errorSchema]),
  body: (input) =>
    admitStackBase(input.base).pipe(
      Node.andThen(ImportDocs.call({})),
      Node.andThen(RefreshWiki.child({ pool: input.prior ?? null })),
      Node.bindPlanned((refreshed) => ReadPublishedWiki.call({ base: input.base, refreshed }))
    )
})
