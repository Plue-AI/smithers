/**
 * Backend flow/run handlers used by the canonical flow and runs groups.
 * @since 0.1.0
 */

import { list, object, positive, str } from "./Client.ts"
import type { Handler } from "./Resources.ts"
/**
 * @private
 * @since 1.0.0
 */
export const runs: Record<string, Handler> = {}
runs["workflow list"] = (c, _a, o) => c.request("GET", c.repoPath(o.repo) + "/workflows")
for (const action of ["dispatch", "run"]) {
  runs[`workflow ${action}`] = async (c, a, o) => {
    const base = c.repoPath(o.repo)
    let id = a.id
    if (action === "run") {
      const response = object(await c.request("GET", base + "/workflows"))
      id = list(response.workflows).map(object).find((flow) =>
        str(flow.name).trim().toLowerCase() === str(a.workflow).trim().toLowerCase()
      )?.id
      if (!id) throw new Error(`Flow ${str(a.workflow)} not found`)
    }
    const inputs = Object.fromEntries(
      list(o.input).map(str).filter((value) => value.includes("=")).map((value) => {
        const i = value.indexOf("=")
        return [value.slice(0, i).trim(), value.slice(i + 1)]
      }).filter(([key]) => key)
    )
    const result = await c.request("POST", `${base}/workflows/${positive(id)}/dispatches`, {
      ref: o.ref || "main",
      ...(Object.keys(inputs).length ? { inputs } : {})
    })
    return result ?? { status: "dispatched" }
  }
}
runs["run list"] = (c, _a, o) => c.request("GET", c.repoPath(o.repo) + "/runs")
for (const action of ["view", "rerun", "cancel"]) {
  runs[`run ${action}`] = (c, a, o) =>
    c.request(
      action === "view" ? "GET" : "POST",
      c.repoPath(o.repo) + `/runs/${positive(a.id)}${action === "view" ? "" : `/${action}`}`
    )
}
runs["run logs"] = (c, a, o) => c.events(c.repoPath(o.repo) + `/runs/${positive(a.id)}/logs`)
runs["run watch"] = async (c, a, o) => {
  const path = c.repoPath(o.repo) + `/runs/${positive(a.id)}`
  let run = object(await c.request("GET", path))
  let events: Array<unknown> | undefined
  if (!["success", "failure", "completed", "failed", "cancelled"].includes(str(run.status))) {
    events = await c.events(path + "/logs")
    run = object(await c.request("GET", path))
  }
  if (["failure", "failed", "cancelled"].includes(str(run.status))) c.runtime.exit?.(1)
  return { ...run, ...(events ? { events } : {}) }
}
runs["workflow watch"] = runs["run watch"]!
