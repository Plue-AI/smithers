import type { TodoCard } from "@smthrs/rpc/TodoCard"
import type { InboxRun } from "../cards/RunsInbox"
/** TODO state is inventory context; the run's journal remains authoritative when Inspect opens. */
const statusOf = (todo: TodoCard): string => todo.state === "merged" || todo.state === "in_review" ? "completed"
  : todo.state === "failed" ? "failed" : todo.state === "dropped" ? "cancelled"
  : todo.state === "needs_you" ? "waiting-approval" : todo.state === "paused" ? "parked" : "running"
/** Run ids are host-local. Deduplicate only within the same recorded workspace. */
export const monitorRuns = (box: readonly InboxRun[], todos: readonly TodoCard[], workspaceId?: string): InboxRun[] => {
  const rows = new Map<string, InboxRun>()
  for (const row of box) rows.set(JSON.stringify([row.workspaceId ?? workspaceId, row.runId]), { ...row, workspaceId: row.workspaceId ?? workspaceId })
  for (const todo of todos) {
    if (!todo.run || !todo.branch) continue
    const key = JSON.stringify([todo.branch.id, todo.run.id])
    const previous = rows.get(key)
    const at = Date.parse(todo.prompt_revisions[0]?.at ?? "")
    rows.set(key, { runId: todo.run.id, workspaceId: todo.branch.id, flowId: "todo", status: statusOf(todo),
      createdAt: Number.isFinite(at) ? at : 0, turns: 0, calls: 0, ...previous, todo: todo.n, title: `T${todo.n} · ${todo.title}` })
  }
  return [...rows.values()].sort((a,b) => b.createdAt - a.createdAt || JSON.stringify([a.workspaceId,a.runId]).localeCompare(JSON.stringify([b.workspaceId,b.runId])))
}
