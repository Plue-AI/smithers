/** The Smithers surface: every flow run, newest first, then the discovered flows. */
import type { Listed, Run } from "./flows.ts"
import type * as Panels from "./panels.ts"

const status = (run: Run): NonNullable<Panels.Row["status"]> =>
  run.status === "running" || run.status === "waiting"
    ? "running"
    : run.status === "done" || run.status === "failed" || run.status === "cancelled"
    ? run.status
    : "requested"

const text = (value: string | undefined): Array<Panels.Block> =>
  value === undefined || value === "" ? [] : [{ kind: "text", text: value.slice(0, 200_000) }]

/** The panel id; the surface is `ui:smithers`, owned `plugin:smithers`. */
export const id = "smithers"

export const panel = (listed: ReadonlyArray<Listed>, runs: ReadonlyArray<Run>): Panels.Panel => {
  const newest = [...runs].sort((a, b) => b.startedAt - a.startedAt)
  const active = newest.filter((run) => {
    const shown = status(run)
    return shown === "running" || shown === "requested"
  })
  return {
    id,
    title: "Smithers",
    summary: `${listed.length} flows · ${active.length} active`,
    rows: [
      ...newest.map((run) => ({
        id: `run:${run.id}`,
        label: run.flow,
        status: status(run),
        details: text(run.message ?? run.answer)
      })),
      ...listed.map((flow) => ({ id: `flow:${flow.name}`, label: flow.name, details: text(flow.description) }))
    ]
  }
}
