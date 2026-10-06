import type { Action } from "@smthrs/rpc/CardAction"
import type { NeedsYouKind, TodoState } from "@smthrs/rpc/CardPrimitives"

/** The primary TODO row action on every surface (§14.5.2); providers retain execution authority. */
export const actionFor = (
  entry: { readonly n?: number; readonly state?: TodoState | null; readonly needs_you?: { readonly kind: NeedsYouKind };
    readonly first_in_order?: boolean; readonly place?: number; readonly merge?: { readonly state: string }; readonly pr?: { readonly draft: boolean } },
  viewer: { readonly role: "owner" | "maintainer" | "member" }
): Action | undefined => {
  if (entry.n === undefined || !Number.isSafeInteger(entry.n) || entry.n < 1) return undefined
  const args = { n: String(entry.n) }
  if (entry.state === "needs_you") {
    switch (entry.needs_you?.kind) {
      case "question":
      case "approval": return { tag: "todo.answer", label: "Answer", args, primary: true }
      case "conflict":
      case "moved_off": return { tag: "branch", label: "Resolve", args: { name: `T${entry.n}` }, primary: true }
      case "foreign_push": return { tag: "todo", label: "Review", args, primary: true }
    }
  }
  if (entry.state === "failed") return { tag: "todo.retry", label: "Retry", args, primary: true }
  if (entry.state === "paused") return { tag: "todo.resume", label: "Resume", args, primary: true }
  if (entry.state === "in_review" && entry.first_in_order === true && entry.place === 1
    && entry.merge?.state === "ready" && entry.pr?.draft === false && (viewer.role === "owner" || viewer.role === "maintainer")) {
    return { tag: "merge", label: "Merge", args, primary: true }
  }
  return undefined
}
