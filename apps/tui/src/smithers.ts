/** The Smithers surface: the factory's issues and the apps its homepage declares. Runs live in Summary, flows in `/flows`. */
import type * as Home from "./home.ts"
import type * as Panels from "./panels.ts"

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

/** The factory's first row: the composer command that files a TODO. */
const fileTodo: Panels.Row = { id: "factory:todo", label: "File a TODO", details: text("/todo <title>") }

export const panel = (
  apps: ReadonlyArray<Home.App>,
  /** The flows this directory discovers: an app row runs only one of these. */
  discovered: ReadonlySet<string>,
  /** The issue list, or `signed-out` when the repository is known but no Cloud session is. */
  input?: Factory | "signed-out"
): Panels.Panel => {
  const factory = input === "signed-out" ? undefined : input
  return {
    id,
    title: "Smithers",
    // The factory's measured numbers lead, when its stack was read.
    summary: factory !== undefined && factory.metrics !== ""
      ? factory.metrics
      : apps.length === 0
      ? "Factory"
      : `${apps.length} apps`,
    rows: [
      ...input === "signed-out" ? [signIn] : factory === undefined ? [] : [fileTodo, ...factory.rows],
      // The apps the homepage declares (home.ts): the same list the app home shows as tiles. A row runs its flow when this directory discovers it.
      ...apps.map((app) => ({
        id: `app:${app.flow}`,
        label: app.title,
        details: text(app.flow),
        ...(discovered.has(app.flow)
          ? { action: { label: app.title, action: { kind: "flow" as const, flow: app.flow } } }
          : {})
      }))
    ]
  }
}
