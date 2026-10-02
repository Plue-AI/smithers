import type { ReviewRunOutput } from "../workflow/reviewRunOutputSchema.ts";

/** Review coverage and diagnostics carried by the standalone walkthrough. */
export interface ReviewOutcome {
  readonly status: ReviewRunOutput["status"];
  readonly warnings: ReviewRunOutput["warnings"];
  readonly files: ReadonlyArray<{
    readonly path: string;
    readonly status: "reviewed" | "not_reviewed";
    readonly reason: string;
  }>;
}
