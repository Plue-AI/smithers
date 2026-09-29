/** The Smithers surface: the directory's apps, every flow run, newest first, then the discovered flows. */
import type { Listed, Run } from "./flows.ts"
import type * as Home from "./home.ts"
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

/** The factory's issue list, when the repository's stack was read from Cloud. */
export interface Factory {
  readonly metrics: string
  readonly rows: ReadonlyArray<Panels.Row>
}

/** The one row a signed-out person sees in place of the factory's issues. */
const signIn: Panels.Row = {
  id: "factory:sign-in",
  label: "Sign in to see the factory: smthrs auth login",
  details: []
}

export const panel = (
  listed: ReadonlyArray<Listed>,
  runs: ReadonlyArray<Run>,
  apps: ReadonlyArray<Home.App> = [],
  /** The issue list, or `signed-out` when the repository is known but no Cloud session is. */
  input?: Factory | "signed-out"
): Panels.Panel => {
  const factory = input === "signed-out" ? undefined : input
  const newest = [...runs].sort((a, b) => b.startedAt - a.startedAt)
  const active = newest.filter((run) => {
    const shown = status(run)
    return shown === "running" || shown === "requested"
  })
  const discovered = new Set(listed.map((flow) => flow.name))
  return {
    id,
    title: "Smithers",
    // The factory's measured numbers lead, when its stack was read.
    summary: factory !== undefined && factory.metrics !== ""
      ? factory.metrics
      : `${apps.length === 0 ? "" : `${apps.length} apps · `}${listed.length} flows · ${active.length} active`,
    rows: [
      ...input === "signed-out" ? [signIn] : factory?.rows ?? [],
      // The apps the homepage declares (home.ts): the same list the app home shows as tiles. A row runs its flow when this directory discovers it.
      ...apps.map((app) => ({
        id: `app:${app.flow}`,
        label: app.title,
        details: text(app.flow),
        ...(discovered.has(app.flow)
          ? { action: { label: app.title, action: { kind: "flow" as const, flow: app.flow } } }
          : {})
      })),
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
