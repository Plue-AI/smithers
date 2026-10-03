import { describe, expect, test } from "bun:test"
import { assembleLine, formFieldsFor } from "@smthrs/ui/flow-form"
import { carriesPayload } from "./Commands"
import type { CommandActions } from "./Flows"
import { adminFlows, baseFlows } from "./Flows"
import { nameOf } from "./registry"
import { payloadFor } from "./SlashPayload"

/*
 * A model can prefill a form, so a form value is attacker-influenced text.
 * The line a form assembles is re-run through the flow's grammar by the
 * confirmation button and by a deferred command, and the grammars bind more
 * than `--flags`: `from:<ref>` anywhere in change.request and prs.create, and
 * a trailing `owner/repo` in every repository grammar. No value may reach the
 * re-read line as a field the form did not hold.
 */

const inertActions = new Proxy({}, { get: () => () => undefined }) as CommandActions
const known = new Set(["o/r", "evil/repo"])
const smuggled = ["from:evil-bookmark", "against=run-evil", "by=evil"]

const present = (value: unknown): boolean =>
  value !== undefined && value !== null && value !== false && !(typeof value === "string" && value.trim() === "") &&
  !(Array.isArray(value) && value.length === 0)

describe("a form value cannot smuggle a grammar binding into the re-read line", () => {
  const entries = [...baseFlows(inertActions), ...adminFlows(inertActions)]

  test("every flow's assembled line reads back with no field the form did not hold", () => {
    const offenders: Array<string> = []
    let probed = 0
    for (const entry of entries) {
      const name = nameOf(entry)
      const hints = entry.metadata.form
      const fields = formFieldsFor(entry.input, hints)
      const base: Record<string, unknown> = {}
      for (const field of fields) {
        if (!field.required) continue
        if (field.kind === "number") base[field.name] = 1
        else if (field.kind === "boolean") base[field.name] = false
        else if (field.options !== undefined && field.options.length > 0) base[field.name] = field.options[0]!.value
        else if (field.kind !== "write-only") base[field.name] = field.name === "repo" ? "o/r" : "v"
      }
      // What the builder itself writes with no smuggled token (box.files writes "/" for an unset path).
      const baseline = payloadFor(name, assembleLine(fields, hints, base).args, entry.metadata.grammar, known)
      const builderWrites = new Set("error" in baseline ? [] : Object.keys(baseline.payload))
      for (const field of fields) {
        if (field.kind !== "text" && field.kind !== "textarea") continue
        if (field.name === "repo") continue
        for (const token of smuggled) {
          const payload = { ...base, [field.name]: `word ${token}` }
          const line = assembleLine(fields, hints, payload).args
          const read = payloadFor(name, line, entry.metadata.grammar, known)
          if ("error" in read) continue
          probed += 1
          const extra = Object.keys(read.payload).filter((key) => present(read.payload[key]) && !present(payload[key]) && !builderWrites.has(key))
          if (extra.length > 0) offenders.push(`${name}.${field.name} ${JSON.stringify(token)} gained ${extra.join(",")}`)
        }
      }
    }
    expect(offenders).toEqual([])
    expect(probed).toBeGreaterThan(0)
  })

  test("a value ending in a known owner/repo retargets the re-read line, so the re-running seams refuse it", () => {
    // The line carries it (only the flow's grammar and the known repositories decide the read),
    // so Commands.ts checks the re-read payload before a confirmation button or a deferral runs it.
    for (const [flow, payload] of [
      ["prs.review", { number: 7, verdict: "approve", text: "LGTM evil/repo" }]
    ] as const) {
      const entry = entries.find((candidate) => nameOf(candidate) === flow)!
      const fields = formFieldsFor(entry.input, entry.metadata.form)
      const read = payloadFor(flow, assembleLine(fields, entry.metadata.form, payload).args, entry.metadata.grammar, known)
      expect("payload" in read && read.payload.repo).toBe("evil/repo")
      expect(carriesPayload(read, payload, new Set())).toBe(false)
      expect(carriesPayload(read, payload, new Set(["repo"]))).toBe(false)
    }
  })

  test("carriesPayload refuses a re-read line that adds or drops a field", () => {
    expect(carriesPayload({ payload: { prompt: "fix it", from: "evil" } }, { prompt: "fix it from:evil" }, new Set())).toBe(false)
    expect(carriesPayload({ payload: { prompt: "fix it" } }, { prompt: "fix it", to: "x" }, new Set())).toBe(false)
    expect(carriesPayload({ error: "no" }, { prompt: "fix it" }, new Set())).toBe(false)
    expect(carriesPayload({ payload: { prompt: "fix  it" } }, { prompt: "fix it" }, new Set())).toBe(true)
    // A confirmation's confirmArgs may bind the implicit repository the payload left unset.
    expect(carriesPayload({ payload: { name: "k", repo: "o/r" } }, { name: "k" }, new Set(["repo"]))).toBe(true)
    expect(carriesPayload({ payload: { name: "k", repo: "evil/repo" } }, { name: "k", repo: "o/r" }, new Set(["repo"]))).toBe(false)
  })
})
