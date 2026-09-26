/** One independently keyed source/review pair per page, using ordinary flows. */
import * as AgentAction from "@smthrs/agent/AgentAction"
import { Flow } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import { Schema } from "effect"
import { Input, Receipt, WikiError } from "./schema.ts"
import { Assess, Collect, ReviewPage, validateOrRepairReview, Write } from "./workflow.ts"

export default Flow.make("smithers/Wiki", {
  description:
    "Capture declared public source dependencies, independently review each engineering wiki page against its code, and write a provenance-bearing snapshot without modifying human intent.",
  capabilities: ["fs:read:**", "fs:write:**"],
  effects: {
    reads: ["factory/wiki/**", "packages/**", "apps/app/**"],
    writes: [".flows/wiki/**"],
    mode: "expected",
    onConflict: "serialize",
    tier: "sealed"
  },
  payload: Input,
  success: Receipt,
  error: Schema.Union([WikiError, AgentAction.AgentFailure]),
  body: (input) =>
    Node.bindPlanned(
      Node.all(Object.fromEntries(input.pages.map((spec, index) => [`page-${index}`, Collect.call({ spec })]))),
      (evidence) =>
        Node.bindPlanned(
          Node.all(Object.fromEntries(input.pages.map((_, index) => [
            `page-${index}`,
            input.mode === "preview"
              ? Node.succeed(null) :
              ReviewPage.call({ evidence: evidence[`page-${index}`]! })
          ]))),
          (reviews) =>
            Node.bindPlanned(
              Node.all(Object.fromEntries(input.pages.map((_, index) => [
                `page-${index}`,
                input.mode === "preview" ?
                  Assess.call({ evidence: evidence[`page-${index}`]!, review: null, reviewer: null })
                  : validateOrRepairReview(evidence[`page-${index}`]!, reviews[`page-${index}`]!).pipe(
                    Node.bindPlanned((review) =>
                      Assess.call({ evidence: evidence[`page-${index}`]!, review, reviewer: input.reviewer })
                    )
                  )
              ]))),
              (pages) => Write.call({ pages, mode: input.mode })
            )
        )
    )
})
