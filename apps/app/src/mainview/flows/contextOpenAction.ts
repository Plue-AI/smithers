import type { ContextItem } from "@smthrs/rpc/CardPrimitives"
import type { CardActionDefinition } from "./cardActions"

/** Context doors preserve the revision selected by the host. */
export const contextOpenAction = (item: ContextItem): CardActionDefinition | undefined => {
  if (item.kind === "file") return {
    tag: "file", label: item.label,
    command_input: { path: item.ref, ...(item.revision === undefined ? {} : item.reason === undefined && !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(item.revision)
      ? { branch: item.revision } : { revision: item.revision }) }
  }
  if (item.kind === "page" && /^[1-9][0-9]*$/.test(item.revision ?? "") && Number.isSafeInteger(Number(item.revision))) return {
    tag: "wiki.page", label: item.label, command_input: { name: item.ref, revision: Number(item.revision) }
  }
  if (item.kind === "run") return { tag: "run.inspect", label: item.label, command_input: { id: item.ref } }
  if (item.kind === "todo") {
    const match = /^(?:T)?([1-9][0-9]*)$/.exec(item.ref)
    const n = Number(match?.[1])
    if (Number.isSafeInteger(n) && n > 0) return { tag: "todo", label: item.label, command_input: { n } }
  }
  if (item.kind === "issue") {
    const n = Number(item.ref.replace(/^#/, ""))
    if (Number.isSafeInteger(n) && n > 0) return { tag: "issue", label: item.label, command_input: { number: n } }
  }
  return undefined
}
