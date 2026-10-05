import { lazy, createElement, type ComponentType } from "react"

function viewModule<T extends ComponentType<any>>(load: () => Promise<{ default: T }>) {
  let pending: Promise<{ default: T }> | undefined
  const preload = () => pending ??= load().catch(error => { pending = undefined; throw error })
  return Object.assign(lazy(preload), { preload })
}

export const MarkdownEditorSurface = viewModule(() => import("./MarkdownEditorSurface").then(m => ({ default: m.MarkdownEditorSurface })))
export const KnowledgeGraphSurface = viewModule(() => import("./KnowledgeGraphSurface").then(m => ({ default: m.KnowledgeGraphSurface })))
export const FlowGraphSurface = viewModule(() => import("./cards/FlowGraphSurface").then(m => ({ default: m.FlowGraphSurface })))
export const FlowRunGraphSurface = viewModule(() => import("./cards/FlowRunGraphSurface").then(m => ({ default: m.FlowRunGraphSurface })))
export const CodeSurface = viewModule(() => import("./cards/CodeEditorSurface").then(m => ({ default: m.CodeEditorSurface })))
export const DiffSurface = viewModule(() => import("./cards/DiffSurface").then(m => ({ default: m.DiffSurface })).catch(() => ({ default: ({ patch }: { path: string; oldPath?: string; patch: string }) => createElement("pre", { className: "world-card-path" }, patch) })))

/** Load the same chunk that Suspense will consume when this destination opens. */
export async function preloadViewModule(name: string, payload: Record<string, unknown>) {
  const module = name === "wiki.graph" ? KnowledgeGraphSurface
    : ["prs.view", "prs.tab", "commits.read", "change.view", "change.facet", "files.implementation-diff"].includes(name) ? DiffSurface
    : name === "files.read" ? (/\.mdx?$/i.test(String(payload.path)) ? MarkdownEditorSurface : CodeSurface)
    : ["wiki", "wiki.open", "wiki.edit", "wiki.card.view", "conversation.edit"].includes(name) ? MarkdownEditorSurface
    : undefined
  await module?.preload()
}
