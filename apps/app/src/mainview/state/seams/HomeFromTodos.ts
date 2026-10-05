import type { HomeCard as HomeModel, HomeItem } from "@smthrs/rpc/HomeCard"
import type { Action } from "@smthrs/rpc/CardAction"
import { PlaceholderAvatarUrl, type TodoState } from "@smthrs/rpc/CardPrimitives"
import type { TodoCard } from "@smthrs/rpc/TodoCard"

// Wire-model projection (seam layer): the row actions are HomeCard data, bound later by HomeContainer through cardActions.
/**
 * Home from GET /api/todos (T-APP-01) on a host that serves no `home` topic: a row per unmerged TODO in the served
 * order with the controls its state offers, every state counted, a machine per TODO branch that is awake or waking,
 * and main's row without sync facts, which the list does not carry.
 */
export const homeFromTodos = (repository: string, todos: ReadonlyArray<TodoCard>): HomeModel => {
  const counts: Record<TodoState, number> = { queued: 0, starting: 0, working: 0, needs_you: 0, paused: 0, failed: 0, in_review: 0, merged: 0, dropped: 0 }
  for (const todo of todos) counts[todo.state] += 1
  const open = todos.filter(todo => todo.state !== "merged" && todo.state !== "dropped")
  const items = open.map((todo): HomeItem => {
    const args = { n: String(todo.n) }
    const actions: Action[] = [{ tag: "todo", label: todo.title, args: { ...args, door: "title" } }]
    if (todo.state === "needs_you") actions.push({ tag: "todo.answer", label: "Answer", args, primary: true })
    if (todo.state === "in_review") actions.push(todo.merge.state === "ready" ? { tag: "merge", label: "Merge", args, primary: true } : { tag: "todo", label: "Review", args })
    if (todo.state === "failed") actions.push({ tag: "todo.retry", label: "Retry", args })
    if (todo.state === "paused") actions.push({ tag: "todo.resume", label: "Resume", args })
    const wait = todo.waits[0]
    return {
      n: todo.n, title: todo.title, state: todo.state, owner: todo.owner, merge: todo.merge,
      ...(todo.place === undefined ? {} : { place: todo.place }),
      ...(todo.queue === undefined ? {} : { queue: todo.queue }),
      ...(todo.step === undefined ? {} : { step: todo.step }),
      ...(todo.rebase_pending === undefined ? {} : { rebase_pending: todo.rebase_pending }),
      ...(todo.approval_cleared === undefined ? {} : { approval_cleared: todo.approval_cleared }),
      ...(todo.lessons === undefined ? {} : { lessons: todo.lessons }),
      ...(wait === undefined ? {} : { needs_you: { kind: wait.kind, prompt: wait.prompt } }),
      ...(todo.pr === undefined ? {} : { pr: { number: todo.pr.number, draft: todo.pr.draft } }),
      // A queued TODO has no branch yet; the row names none rather than invent one.
      branch: todo.branch === undefined ? { id: "", name: "" } : { id: todo.branch.id, name: todo.branch.name },
      present: todo.present, amendments: Math.max(0, todo.prompt_revisions.length - 1), actions
    }
  })
  const slots = open.flatMap(todo => todo.branch !== undefined && (todo.branch.machine.state === "awake" || todo.branch.machine.state === "waking")
    ? [{ branch: todo.branch.name, awake: todo.branch.machine.state === "awake",
        actor: { kind: "agent" as const, id: `agent:${todo.branch.id}`, agent: "coding" as const, avatar_url: PlaceholderAvatarUrl, for_member: todo.owner, todo: todo.n, color_index: 6 as const } }]
    : [])
  return {
    repository,
    main: { sha: "", title: "main", last_success_at: new Date(0).toISOString(), health: "limited" },
    attention: [], items, counts, merged_since_last_look: [],
    machines: { in_use: slots.length, capacity: 0, slots }, background_runs: []
  }
}
