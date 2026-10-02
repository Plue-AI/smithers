/*
 * Showcase coverage: every flow the app's registry declares (flows/Flows.ts,
 * built with inert actions the way flows/FlowOrder.test.ts builds it), sorted
 * into three buckets against the recorded cases:
 *
 *   recorded     a recorded case invoked it (the harness saw it run)
 *   unrecorded   registered on the test host; no case shows it yet
 *   unavailable  cannot run in this environment, with the reason
 *
 * `bun e2e/showcase/coverage.ts [out-dir]` prints the table for the records
 * under <out-dir>/cases (default showcase-out).
 */
import { existsSync, readdirSync, readFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { adminFlows, baseFlows, guideFlows, type CommandActions } from "../../src/mainview/flows/Flows"
import { nameOf } from "../../src/mainview/flows/registry"
import type { ShowcaseRecord } from "./showcase"

/** Flows that cannot run on the T1 test host, by exact name or `namespace.*`. */
export const UNAVAILABLE: Readonly<Record<string, string>> = {
  "chat.dictate": "needs a microphone",
  "box.terminal": "needs a live cloud sandbox terminal",
  "code.*": "needs a live cloud sandbox language server",
  "billing.upgrade": "external Stripe checkout",
  "billing.portal": "external Stripe portal",
  "cloud.sign-in": "local host only (host-held Cloud session)",
  "cloud.sign-out": "local host only (host-held Cloud session)"
}

const inert = (flags: { readonly pluginLibrary: boolean }): CommandActions =>
  new Proxy({}, { get: (_, key) => key === "snapshot" ? () => flags : () => undefined }) as CommandActions

const registered = (actions: CommandActions) =>
  [...baseFlows(actions), ...adminFlows(actions), ...guideFlows(actions)]

export interface CatalogFlow {
  readonly name: string
  readonly namespace: string
  readonly summary: string
  readonly hidden: boolean
  /** Why it cannot run here; undefined when it can. */
  readonly unavailable?: string
}

const unavailableReason = (name: string): string | undefined =>
  UNAVAILABLE[name] ?? UNAVAILABLE[`${name.split(".")[0]}.*`]

/** Every declared flow, with the default build's release flags deciding what is off. */
export const flowCatalog = (): ReadonlyArray<CatalogFlow> => {
  const defaults = new Set(registered(inert({ pluginLibrary: false })).map(nameOf))
  const seen = new Set<string>()
  const rows: Array<CatalogFlow> = []
  for (const entry of registered(inert({ pluginLibrary: true }))) {
    const name = nameOf(entry)
    if (seen.has(name)) continue
    seen.add(name)
    const off = defaults.has(name) ? undefined : "off in the default build (release flag)"
    const reason = off ?? unavailableReason(name)
    rows.push({
      name,
      namespace: name.split(".")[0]!,
      summary: entry.metadata.summary,
      hidden: entry.metadata.hidden === true,
      ...(reason === undefined ? {} : { unavailable: reason })
    })
  }
  return rows
}

export type Bucket = "recorded" | "unrecorded" | "unavailable"

export interface CoverageRow extends CatalogFlow {
  readonly bucket: Bucket
  /** The cases that show it. */
  readonly cases: ReadonlyArray<string>
}

export interface Coverage {
  readonly rows: ReadonlyArray<CoverageRow>
  readonly counts: Readonly<Record<Bucket, number>>
  /** Flows a case names that the registry does not declare. */
  readonly unknown: ReadonlyArray<string>
}

export const coverage = (records: ReadonlyArray<ShowcaseRecord>): Coverage => {
  const catalog = flowCatalog()
  const known = new Set(catalog.map(flow => flow.name))
  // Only the flows a case asserts ran count; `observed` is gesture intent, not proof.
  const shownBy = new Map<string, Array<string>>()
  for (const record of records) {
    for (const name of new Set(record.flows)) {
      shownBy.set(name, [...shownBy.get(name) ?? [], record.id])
    }
  }
  // What the test host actually registered across the recorded sessions (admin and
  // host-scoped flows register only for some sessions or hosts).
  const registered = new Set(records.flatMap(record => record.registered))
  const rows = catalog.map((flow): CoverageRow => {
    const cases = shownBy.get(flow.name) ?? []
    const unavailable = flow.unavailable ?? (registered.size > 0 && !registered.has(flow.name) ? "not registered on the test host" : undefined)
    const bucket: Bucket = cases.length > 0 ? "recorded" : unavailable !== undefined ? "unavailable" : "unrecorded"
    return { ...flow, ...(unavailable === undefined ? {} : { unavailable }), bucket, cases }
  })
  const counts = { recorded: 0, unrecorded: 0, unavailable: 0 }
  for (const row of rows) counts[row.bucket]++
  const unknown = [...new Set(records.flatMap(record => record.flows))].filter(name => !known.has(name))
  return { rows, counts, unknown }
}

export const readRecords = (out: string): ReadonlyArray<ShowcaseRecord> => {
  const dir = join(out, "cases")
  if (!existsSync(dir)) return []
  return readdirSync(dir).filter(file => file.endsWith(".json")).sort()
    .map(file => JSON.parse(readFileSync(join(dir, file), "utf8")) as ShowcaseRecord)
}

if (import.meta.main) {
  const out = resolve(process.argv[2] ?? join(__dirname, "../../showcase-out"))
  const result = coverage(readRecords(out))
  const namespaces = [...new Set(result.rows.map(row => row.namespace))].sort()
  const pad = (text: string | number, width: number) => String(text).padEnd(width)
  console.log(`${pad("namespace", 14)}${pad("recorded", 10)}${pad("unrecorded", 12)}unavailable`)
  for (const namespace of namespaces) {
    const rows = result.rows.filter(row => row.namespace === namespace)
    const count = (bucket: Bucket) => rows.filter(row => row.bucket === bucket).length
    console.log(`${pad(namespace, 14)}${pad(count("recorded"), 10)}${pad(count("unrecorded"), 12)}${count("unavailable")}`)
  }
  console.log(`\n${result.rows.length} flows: ${result.counts.recorded} recorded, ${result.counts.unrecorded} unrecorded, ${result.counts.unavailable} unavailable`)
  if (result.unknown.length > 0) {
    console.error(`cases name flows the registry does not declare: ${result.unknown.join(", ")}`)
    process.exit(1)
  }
}
