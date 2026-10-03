import type { DraftCard } from "@smthrs/rpc/DraftCard"
import { issue } from "./_shared.ts"
const base: DraftCard = {
  title: "Card models",
  prompt: "Publish typed card models",
  acceptance: ["Fixtures parse"],
  place: { mode: "append", options: [{ n: 8, title: "Merge requests", state: "in_review" }] },
  private: true
}
export const fixtures = {
  append: base,
  before: { ...base, place: { ...base.place, mode: "before", n: 8 } },
  amend: { ...base, place: { ...base.place, mode: "amend", n: 8 } },
  issue: { ...base, issue: { ...issue, fixes: true } },
  seed: { ...base, seed: { files: ["packages/rpc/src/TodoCard.ts"] } },
  committed: { ...base, private: false, committed: { n: 12, rev: 1 } }
} satisfies Record<string, DraftCard>
