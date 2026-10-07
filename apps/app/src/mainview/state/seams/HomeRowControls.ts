import type { HomeCard as HomeModel } from "@smthrs/rpc/HomeCard"
import { actionFor } from "../../flows/rowAction"

/** Normalize source row descriptors; HomeContainer filters and binds them through cardActions. */
export const withHomeRowControls = (model: HomeModel): HomeModel => {
  const open = model.items.filter(row => row.state !== "merged" && row.state !== "dropped")
  return { ...model, items: model.items.map(row => {
    if (row.state === "merged" || row.state === "dropped") return row
    const index = open.indexOf(row)
    const args = { n: String(row.n) }
    const actions = row.actions.flatMap(action => {
      // Older served snapshots label every wait Answer. Keep the shared wait policy at the client boundary.
      if (row.state !== "needs_you" || action.tag !== "todo.answer" || row.needs_you === undefined) return [action]
      const primary = actionFor(row, { role: "member" })
      return primary ? [{ ...primary, ...(primary.tag === "branch" ? { args: { name: row.branch.name } } : {}) }] : []
    })
    if (row.branch.name && !actions.some(action => action.tag === "branch" && action.args?.door === "branch"))
      actions.push({ tag: "branch", label: row.branch.name, args: { name: row.branch.name, door: "branch" } })
    for (const direction of ["up", "down"] as const) {
      if (direction === "up" && index === 0 || direction === "down" && index === open.length - 1) continue
      if (!actions.some(action => action.tag === "stack.move" && action.args?.direction === direction))
        actions.push({ tag: "stack.move", label: direction === "up" ? "Move up" : "Move down", args: { ...args, direction } })
    }
    if (!actions.some(action => action.tag === "todo.drop")) actions.push({ tag: "todo.drop", label: "Drop", args })
    return { ...row, actions }
  }) }
}
