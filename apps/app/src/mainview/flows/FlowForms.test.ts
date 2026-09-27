import { describe, expect, test } from "bun:test"
import { FORM_OPTION_PROVIDERS } from "@smthrs/rpc/Cards"
import { Schema } from "effect"
import { assembleArgs, draftFrom, formFieldsFor, missingFields, OPTION_PROVIDERS, partialPayload, positionalRead } from "@smthrs/ui/flow-form"
import type { FormHints } from "@smthrs/ui/flow-form"

/*
 * THE FORM LAW (apps/app/AGENTS.md; docs/workbench-lanes/flow-forms.md): the
 * form is DERIVED from the flow's own input schema, never a second
 * hand-written form. These pin the derivation per schema kind, the hint
 * overlay, the prefill from a partial slash line, and the args assembly that
 * turns the filled form back into the one slash line the grammar parses.
 */

const AgentCreate = Schema.Struct({
  id: Schema.String,
  harness: Schema.String,
  model: Schema.String,
  purpose: Schema.optional(Schema.String)
})

const Mixed = Schema.Struct({
  runId: Schema.String,
  seq: Schema.Number,
  follow: Schema.Boolean,
  kind: Schema.optional(Schema.Literals(["container", "vm", "desktop"])),
  paths: Schema.Array(Schema.String)
})

describe("formFieldsFor — one control per schema field", () => {
  test("string → text, number → number, boolean → boolean, literals → select, optional → not required, arrays → text", () => {
    const fields = formFieldsFor(Mixed, undefined)
    expect(fields.map((field) => [field.name, field.kind, field.required])).toEqual([
      ["runId", "text", true],
      ["seq", "number", true],
      ["follow", "boolean", true],
      ["kind", "select", false],
      ["paths", "text", true]
    ])
    // A select's options are the literals themselves, and nothing else.
    expect(fields[3]?.options).toEqual([
      { value: "container", label: "container" },
      { value: "vm", label: "vm" },
      { value: "desktop", label: "desktop" }
    ])
    // Labels are the field names humanized; no hint, no invention.
    expect(fields.map((field) => field.label)).toEqual(["Run id", "Seq", "Follow", "Kind", "Paths"])
    expect(fields.every((field) => field.placeholder === undefined && field.optionsFrom === undefined)).toBe(true)
  })

  test("the hints overlay labels, placeholders, option providers, and a kind or required override", () => {
    const hints: FormHints = {
      fields: {
        id: { label: "Agent id", placeholder: "reviewer" },
        harness: { optionsFrom: "open-repos" },
        model: { optionsFrom: "models", kind: "text" },
        purpose: { required: true }
      }
    }
    const fields = formFieldsFor(AgentCreate, hints)
    expect(fields).toEqual([
      { name: "id", label: "Agent id", kind: "text", required: true, placeholder: "reviewer" },
      { name: "harness", label: "Harness", kind: "select", required: true, optionsFrom: "open-repos" },
      { name: "model", label: "Model", kind: "text", required: true, optionsFrom: "models" },
      { name: "purpose", label: "Purpose", kind: "text", required: true }
    ])
  })

  test("a schema that is not a struct derives no fields", () => {
    expect(formFieldsFor(Schema.String, undefined)).toEqual([])
  })
})

describe("partialPayload — prefill from whatever the slash line gave", () => {
  const fields = formFieldsFor(AgentCreate, undefined)

  test("tokens fill the fields positionally, in schema order; nothing given fills nothing", () => {
    expect(partialPayload(fields, undefined, "reviewer codex")).toEqual({ id: "reviewer", harness: "codex" })
    expect(partialPayload(fields, undefined, undefined)).toEqual({})
    expect(partialPayload(fields, undefined, "   ")).toEqual({})
  })

  test("leftover tokens ride the last text field, a flag stops the positional read, a non-number stops a number field", () => {
    expect(partialPayload(fields, undefined, "reviewer codex gpt-5.6-terra Reviews diffs for correctness")).toEqual({
      id: "reviewer",
      harness: "codex",
      model: "gpt-5.6-terra",
      purpose: "Reviews diffs for correctness"
    })
    expect(partialPayload(fields, undefined, "reviewer --model x")).toEqual({ id: "reviewer" })
    const mixed = formFieldsFor(Mixed, undefined)
    expect(partialPayload(mixed, undefined, "run-1 abc")).toEqual({ runId: "run-1" })
    expect(partialPayload(mixed, undefined, "run-1 3")).toEqual({ runId: "run-1", seq: 3 })
  })

  test("a flow's own partial reader wins over the positional default", () => {
    const hints: FormHints = { partial: (args) => ({ id: args.trim().toUpperCase() }) }
    expect(partialPayload(fields, hints, "reviewer codex")).toEqual({ id: "REVIEWER CODEX" })
  })

  /*
   * Walk W1 (W1-d-doors.json `pauseFormFields`): `/triggers.pause
   * canary-w1-not-registered` opened the pause form with Repo holding the
   * schedule's name and Slug empty, because the prefill spent the one token it
   * had on the OPTIONAL repository that happened to lead the schema. A
   * positional read only spends a token on an optional slot when the required
   * slots behind it still have tokens of their own.
   */
  const ScheduleTarget = Schema.Struct({ repo: Schema.optional(Schema.String), slug: Schema.String })

  test("an optional slot only takes a token the required slots behind it can spare", () => {
    const schedule = formFieldsFor(ScheduleTarget, undefined)
    expect(partialPayload(schedule, undefined, "canary-w1-not-registered")).toEqual({ slug: "canary-w1-not-registered" })
    expect(partialPayload(schedule, undefined, "codeplanesmithers/canary-sandbox nightly"))
      .toEqual({ repo: "codeplanesmithers/canary-sandbox", slug: "nightly" })
  })

  /*
   * R102 follow-up. Counting slots alone put `codeplanesmithers/canary-sandbox`
   * under Slug, and no schedule is named `owner/name`. A token of the
   * repository's own shape (RepoContext.REPO_TOKEN, the shape every trailing
   * `owner/repo` grammar already reads) fills the repository slot it would
   * otherwise skip, and the form asks for the name that is genuinely missing.
   */
  test("a repository-shaped token fills the repository slot rather than the name behind it", () => {
    const schedule = formFieldsFor(ScheduleTarget, undefined)
    expect(partialPayload(schedule, undefined, "codeplanesmithers/canary-sandbox"))
      .toEqual({ repo: "codeplanesmithers/canary-sandbox" })
    // A name that only looks path-ish is still a name: the shape has to be exactly `owner/name`.
    expect(partialPayload(schedule, undefined, "nightly/build/2")).toEqual({ slug: "nightly/build/2" })
    // And the leading slot has to be the repository's; a required slot never yields its token.
    const runTarget = Schema.Struct({ slug: Schema.String, repo: Schema.optional(Schema.String) })
    expect(partialPayload(formFieldsFor(runTarget, undefined), undefined, "codeplanesmithers/canary-sandbox"))
      .toEqual({ slug: "codeplanesmithers/canary-sandbox" })
  })

  /*
   * A slot the read passed over is a field the line never named, and the card
   * has to be able to say so: `missingFields` counts only the REQUIRED ones,
   * so without this report `/triggers.register one two three` looks complete
   * and re-earns the grammar's usage sentence (R102c B1c,
   * controller/forms.ts). The report names the slots, not a count.
   */
  test("the read reports the optional slots it passed over", () => {
    const schedule = formFieldsFor(ScheduleTarget, undefined)
    expect(positionalRead(schedule, undefined, "canary-w1-not-registered").skipped).toEqual(["repo"])
    expect(positionalRead(schedule, undefined, "codeplanesmithers/canary-sandbox nightly").skipped).toEqual([])
    expect(positionalRead(schedule, undefined, "codeplanesmithers/canary-sandbox").skipped).toEqual([])
    expect(positionalRead(schedule, undefined, undefined).skipped).toEqual([])
  })
})

describe("draftFrom and missingFields", () => {
  const fields = formFieldsFor(Mixed, undefined)

  test("the draft holds one primitive per given field, coerced to the field's kind; the rest is what the form still needs", () => {
    const draft = draftFrom(fields, { runId: "run-1", seq: "4", follow: "true", paths: ["a", "b"] })
    expect(draft).toEqual({ runId: "run-1", seq: 4, follow: true, paths: "a b" })
    expect(missingFields(fields, draft)).toEqual([])
    // A boolean is answered either way (unchecked is false), so it is never missing.
    expect(missingFields(fields, { runId: "run-1" })).toEqual(["seq", "paths"])
    // A required field given as blank is still missing; an optional one never is.
    expect(missingFields(fields, { runId: "", seq: 1, follow: false, paths: "x" })).toEqual(["runId"])
  })
})

describe("assembleArgs — the filled form is one slash line again", () => {
  test("the default is positional in schema order: blanks skipped, a true boolean as --name, arrays space-joined", () => {
    const fields = formFieldsFor(Mixed, undefined)
    expect(assembleArgs(fields, undefined, { runId: "run-1", seq: 2, follow: true, paths: "a b" })).toBe("run-1 2 --follow a b")
    expect(assembleArgs(fields, undefined, { runId: "run-1", seq: 2, follow: false, kind: "vm", paths: "a" })).toBe("run-1 2 vm a")
  })

  test("a flow's own assembler wins", () => {
    const fields = formFieldsFor(AgentCreate, undefined)
    const hints: FormHints = { args: (payload) => `${String(payload.id)} --model ${String(payload.model)}` }
    expect(assembleArgs(fields, hints, { id: "reviewer", model: "gpt" })).toBe("reviewer --model gpt")
  })
})

describe("the option providers", () => {
  test("a flow may name exactly the providers a stored form card decodes", () => {
    // Cards.ts validates `optionsFrom` on the wire: a provider named here and not there renders a card the store refuses.
    expect([...OPTION_PROVIDERS]).toEqual([...FORM_OPTION_PROVIDERS])
  })
})

test("numeric literal options submit as schema values in the GUI", async () => {
  const { submissionPayload } = await import("@smthrs/ui/flow-form")
  const input = Schema.Struct({ attempts: Schema.Literals([1, 2]) })
  const fields = formFieldsFor(input)
  expect(submissionPayload(input, fields, {}, { attempts: fields[0]!.options![1]!.value }))
    .toEqual({ payload: { attempts: 2 } })
})
