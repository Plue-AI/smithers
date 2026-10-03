import type { CardProps } from "@smthrs/rpc/CardAction"
import { useState, useRef, type CSSProperties } from "react"
import { ChevronDown } from "lucide-react"
import type { BranchTreeNodeCard } from "@smthrs/rpc/BranchTreeNodeCard"
import { BranchNode, AncestorCrumb } from "./cards/views/BranchNode"
export type BranchTreeView = { selected_branch?: string }
export type BranchTreeProps = { nodes: BranchTreeNodeCard[]; view: BranchTreeView; onAction: CardProps<unknown>["onAction"]; onView: (patch: Partial<BranchTreeView>) => void }

function flatten(nodes: BranchTreeNodeCard[], depth = 0): { node: BranchTreeNodeCard; depth: number }[] {
  return nodes.flatMap(node => [{ node, depth }, ...flatten(node.children, depth + 1)])
}

function renderNode({ node, depth, view, onAction, onView }: { node: BranchTreeNodeCard; depth: number } & Pick<BranchTreeProps, "view" | "onAction" | "onView">) {
  return <li key={node.id} data-depth={depth} data-kind={node.kind} style={{ "--depth": depth } as CSSProperties}>
    <BranchNode node={node} selected={view.selected_branch} onAction={onAction} onView={onView} />
    </li>
}

function orderedRows(nodes: BranchTreeNodeCard[]) {
  const rows = flatten(nodes)
  return [...rows.filter(row => row.node.kind !== "earlier"), ...rows.filter(row => row.node.kind === "earlier").map(row => ({ ...row, depth: 0 }))]
}

export function BranchTree({ nodes, view, onAction, onView }: BranchTreeProps) {
  return <nav className="mvp-tree" aria-label="Branches" data-keyboard-pane="Branches">
    <ol>{orderedRows(nodes).map(row => renderNode({ ...row, view, onAction, onView }))}
    </ol>
    </nav>
}

function ancestry(nodes: BranchTreeNodeCard[], selected?: string): BranchTreeNodeCard[] {
  for (const node of nodes) {
    if (node.id === selected) return [node]
    const path = ancestry(node.children, selected)
    if (path.length) return [node, ...path]
  }
  return []
}

function renderAncestor({ node, onAction, onView }: { node: BranchTreeNodeCard } & Pick<BranchTreeProps, "onAction" | "onView">) {
  return <AncestorCrumb key={node.id} node={node} onAction={onAction} onView={onView} />
}

export function BranchCrumbs({ nodes, view, onAction, onView }: BranchTreeProps) {
  const [open, setOpen] = useState(false)
  const trigger = useRef<HTMLButtonElement>(null)
  const controls = useRef<HTMLButtonElement[]>([])
  const path = ancestry(nodes, view.selected_branch)
  const rows = orderedRows(nodes).filter(row => !row.node.action?.disabled)
  const parents = rows.map(row => rows.findIndex(candidate => candidate.node.id === ancestry(nodes, row.node.id).at(-2)?.id))
  if (!path.length) return null
  return <div className="mvp-crumbs" onKeyDown={event => {
    if (event.key === "Escape") { setOpen(false); trigger.current?.focus(); return }
    if (!open) return
    const index = +(event.target as HTMLElement).dataset.focusIndex! 
    if (event.key === "ArrowDown") { controls.current[(index >= 0 ? index + 1 : 0) % controls.current.length]?.focus(); event.preventDefault() }
    if (event.key === "ArrowUp") { controls.current[(index >= 0 ? index + controls.current.length - 1 : controls.current.length - 1) % controls.current.length]?.focus(); event.preventDefault() }
    if (event.key === "ArrowLeft") { if (parents[index]! >= 0) controls.current[parents[index]!]?.focus(); else trigger.current?.focus(); event.preventDefault() }
  }}>
    <nav className="mvp-crumb-path" aria-label="Branch">{path.slice(0, -1).map(node => renderAncestor({ node, onAction, onView }))}<button type="button" className="mvp-crumb mvp-crumb-here" ref={trigger} data-focus-index="-1" aria-expanded={open} onClick={() => setOpen(!open)}>{path.at(-1)?.name}<ChevronDown size={12} aria-hidden="true" />
    </button>
    </nav>{open ? <nav className="mvp-tree" aria-label="Branches" ref={element => { controls.current = element ? Array.from(element.querySelectorAll<HTMLButtonElement>("button:not(:disabled)")) : []; controls.current.forEach((control, index) => { control.dataset.focusIndex = String(index) }) }}>
    <ol>{orderedRows(nodes).map(row => renderNode({ ...row, view, onAction, onView }))}
    </ol>
    </nav> : null}
    </div>
}
