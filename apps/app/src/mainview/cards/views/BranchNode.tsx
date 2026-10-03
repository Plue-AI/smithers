import { GitBranch } from "lucide-react"
import type { BranchTreeNodeCard } from "@smthrs/rpc/BranchTreeNodeCard"
import type { BranchTreeProps } from "../../BranchTree"
import { ActorChip } from "./ActorChip"
import { StateWord } from "./StateWord"

export function BranchNode({ node, selected, onAction, onView }: { node: BranchTreeNodeCard; selected?: string } & Pick<BranchTreeProps, "onAction" | "onView">) {
  const action = node.action
  const navigate = () => onView({ selected_branch: node.id })
  const content = <>{node.state ? <StateWord state={node.state} /> : <GitBranch size={14} aria-hidden="true" />}{node.todo ? <span>T{node.todo}
    </span> : null}<span className="mvp-tree-name">{node.kind === "earlier" ? node.archive_count === undefined ? "Earlier" : `Earlier · ${node.archive_count}` : node.name}
    </span>
    <span className="mvp-tree-presence">{node.present.map((actor, index) => <ActorChip key={index} actor={actor} size="s" live />)}
    </span>
    </>
  return <>{action ? <button type="button" className="mvp-tree-row" data-node={node.id} aria-label={`${action.label} ${node.name}${node.todo ? ` T${node.todo}` : ""}${node.state ? ` ${node.state}` : ""}`} aria-current={selected === node.id ? "page" : undefined} data-flow={action.tag} disabled={Boolean(action.disabled)} onClick={() => onAction(action.tag, action.args ?? {})}>{content}
    </button> : <button type="button" className="mvp-tree-row" data-node={node.id} aria-current={selected === node.id ? "page" : undefined} onClick={navigate}>{content}
    </button>}{action?.disabled ? <span className="mvp-disabled-reason">{action.disabled.reason}
    </span> : null}
    </>
}

export function AncestorCrumb({ node, onAction, onView }: { node: BranchTreeNodeCard } & Pick<BranchTreeProps, "onAction" | "onView">) {
  const action = node.action
  const navigate = () => onView({ selected_branch: node.id })
  return <span>
    {action ? <button type="button" className="mvp-crumb" data-branch={node.id} data-flow={action.tag} disabled={Boolean(action.disabled)} onClick={() => onAction(action.tag, action.args ?? {})}>{node.name}</button>
    : <button type="button" className="mvp-crumb" data-branch={node.id} onClick={navigate}>{node.name}</button>}
    {action?.disabled ? <span className="mvp-disabled-reason">{action.disabled.reason}</span> : null}
    <span aria-hidden="true"> / </span>
  </span>
}

