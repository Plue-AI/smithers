import { flowArgs } from "../flows/FlowArgs"
import { flowAction } from "../flows/FlowAction"
import { GitBranch } from "lucide-react"
import type { Card } from "../state/AppState"
import type { CardFamily, RunCommand } from "./CardFamily"
import { settledPill } from "./CardFamily"
import { moveRowFocus } from "./CommitCards"

export const BranchesCardBody = ({
  card,
  onRunCommand
}: {
  readonly card: Extract<Card, { kind: "branches" }>
  readonly onRunCommand: RunCommand
}) => (
  <div className="world-card-list">
    <ul className="world-card-list" onKeyDown={moveRowFocus}>
      {card.payload.bookmarks.length === 0 ?
        <li className="world-card-empty">No branches in {card.payload.repo} yet.</li> :
        (
          card.payload.bookmarks.map((bookmark) => (
            <li key={bookmark.name} className="world-card-row">
              <button
                type="button"
                className="branches-row-open"
                data-row-open
                aria-label={`Commits on ${bookmark.name}`}
                {...flowAction(onRunCommand, "commits.list", flowArgs("commits.list", { branch: bookmark.name, repo: card.payload.repo }))}
              >
                <GitBranch size={14} aria-hidden="true" />
                <span className="world-card-title">{bookmark.name}</span>
                {bookmark.head !== null ? <span className="world-card-path">{bookmark.head.slice(0, 8)}</span> : null}
              </button>
            </li>
          ))
        )}
    </ul>
  </div>
)

export const branchesCardFamily: CardFamily<"branches"> = {
  branches: { render: (card, actions) => <BranchesCardBody card={card} onRunCommand={actions.onRunCommand} />, pill: settledPill }
}
