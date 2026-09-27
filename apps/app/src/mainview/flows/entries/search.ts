/*
 * The `search` flows (Search and Command Palette Spec 2026-09-07 §6): one
 * flow per palette prefix, each with its three doors. The palette is the
 * button door and reads the same seam synchronously; the slash and agent
 * doors run these handlers, which answer the items as data and, for a human,
 * embed the `search-results` card. Only indexed modes are registered.
 * Qualifiers (`section:`,
 * `status:`, `is:`, `path:`) ride inside the query, as §1 writes them.
 */
import { Schema } from "effect"
import type { PaletteMode } from "../SearchQuery"
import { flow } from "./Declare"
import type { FlowEntry, Namespace } from "../registry"
import type { CommandActions } from "./Declare"

/** The `search` namespace row: the slash tree lists it in registry.ts NAMESPACES order. */
export const namespace: Namespace = {
  id: "search",
  label: "Search",
  summary: "Find files, flows, targets, runs, changes, issues, boxes and secret names"
}

/** What every `search.*` flow takes: the query (qualifiers inside it), and the bounds a caller may set. */
export interface SearchArgs {
  readonly query: string
  readonly limit?: number
  /** `search.open` only: the kinds to keep, comma-separated in the slash form. */
  readonly kinds?: ReadonlyArray<string>
  readonly repo?: string
}

const Query = Schema.Struct({ query: Schema.String })
const OptionalQuery = Schema.Struct({ query: Schema.optional(Schema.String), kinds: Schema.optional(Schema.String) })

/** One `search.*` flow over one palette mode. */
const search = (
  actions: CommandActions,
  name: string,
  mode: PaletteMode,
  summary: string,
  args: string,
  extra: { readonly requires?: ReadonlyArray<string>; readonly runtime?: ReadonlyArray<"cloud"> } = {}
): FlowEntry =>
  flow({
    name,
    summary,
    args,
    ...extra,
    input: Query,
    handler: ({ query }) => actions.search(name, mode, { query })
  })

/** The `search.*` flows registered as one aggregator block. */
export const searchFlows = (actions: CommandActions): ReadonlyArray<FlowEntry> => [
  flow({
    name: "search.open",
    summary: "Search everything by name: files, flows, targets, runs, changes, issues, boxes, secret names",
    args: "[query] [--kinds file,run,…]",
    input: OptionalQuery,
    handler: ({ query, kinds }) =>
      actions.search("search.open", "all", {
        query: query ?? "",
        ...(kinds === undefined ? {} : { kinds: kinds.split(",").map((kind) => kind.trim()).filter((kind) => kind !== "") })
      })
  }),
  search(actions, "search.files", "path", "Find files by fuzzy path among the directories the app has listed", "<query> [path:… -path:…]"),
  search(actions, "search.flows", "flows", "The slash tree as data: every flow this session may run", "<query>"),
  search(actions, "search.targets", "targets", "Find targets by label, and the flows the factory projection declares", "<query>"),
  search(actions, "search.wiki", "wiki", "Find wiki pages and notes by title", "<query>"),
  search(actions, "search.history", "history", "Find changes in the history", "<query>"),
  search(actions, "search.runs", "runs", "Find runs by id, flow or status", "<query> [status:…]"),
  search(actions, "search.changes", "changes", "Find changes by id or title", "<query>"),
  search(actions, "search.issues", "issues", "Find issues by number or title", "<query> [is:open|closed]"),
  search(actions, "search.boxes", "boxes", "Find boxes by name, repository or state", "<query>", { requires: ["signed-in"], runtime: ["cloud"] }),
  search(actions, "search.secrets", "secrets", "Find secret names and the hosts they bind to; values never exist on the wire", "<query>", { requires: ["signed-in"], runtime: ["cloud"] }),
]
