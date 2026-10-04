/*
 * THE FORM LAW (apps/app/AGENTS.md; docs/workbench-lanes/flow-forms.md): a
 * flow invoked without its required input renders a form for the missing
 * fields, never a usage sentence. The form is DERIVED here from the flow's
 * own input schema (the `Schema.Struct` every declaration in Flows.ts
 * carries), overlaid with the flow's optional `form` hints — labels,
 * placeholders, and the seam that supplies a field's options. No flow writes
 * a second hand-made form.
 *
 * Pure: no store, no DOM, no Effect runtime. The controller half
 * (state/controller/forms.ts) resolves option providers against the seams
 * and holds the draft in the card's payload.
 */
import { REPO_TOKEN } from "./command-line"
import { splitRunSource } from "./run-command"
import { SchemaRepresentation } from "effect"
import type { JsonSchema, Schema, SchemaAST } from "effect"

/** Reuse Effect's importer; unsupported declarations keep their existing JSON launch path. */
export const declaredInput = (document: unknown): Schema.Top | undefined => {
  if (document === null || typeof document !== "object") return undefined
  try {
    return SchemaRepresentation.fromJsonSchemaDocument(document as JsonSchema.Document<"draft-2020-12">)
  } catch { return undefined }
}

export type FieldKind = "text" | "textarea" | "number" | "boolean" | "select" | "write-only"

/**
 * The seams a select may draw its options from (NO INVENTION: an option is a
 * fact a seam reported, never a guess). Resolved by controller/forms.ts.
 */
export const OPTION_PROVIDERS = [
  /** Smithers Cloud repositories the session has loaded. */
  "cloud-repos",
  /** Bookmarks loaded onto a branches card. */
  "bookmarks",
  /** Cloud workspaces the session has loaded. */
  "workspaces",
  /** The plugin catalog, with the ones already on this workspace's shelf marked. */
  "plugins",
  /** The selected repository's real files, read from the file seam at render. */
  "files",
  /** The configured models; with a seat in the draft, only the ones that seat takes. */
  "models",
  /** The credential NAMES the host listed on the Models card. Never a value. */
  "credentials",
  /** The seats the host listed on the Models card. */
  "seats",
  /** The target repository's open issues (the Fix an issue app's picker). */
  "issues",
  /** The target repository's open pull requests (the Review a PR app's picker). */
  "pull-requests",
  /** The flows the target repository declares (`.smithers/factory.json`). */
  "repository-flows"
] as const
export type OptionProvider = (typeof OPTION_PROVIDERS)[number]

export interface FieldOption {
  readonly value: string
  readonly label: string
  /** The human cannot pick it; `reason` says why (not installed, no credential). */
  readonly disabled?: boolean
  readonly reason?: string
}

/** What a flow may say about one of its fields beyond what the schema already says. */
export interface FieldHint {
  /** Internal optional routing data supplied by an action, never asked of the person. */
  readonly hidden?: boolean
  readonly label?: string
  readonly placeholder?: string
  readonly optionsFrom?: OptionProvider
  /** Overrides the derived control (a provider-fed field that must stay free text keeps `text` and gets a datalist). */
  readonly kind?: FieldKind
  /** Overrides the schema's requiredness (a schema-required string the grammar accepts blank). */
  readonly required?: boolean
}

/** A flow's `form` declaration: per-field hints, and the two grammar inverses when the positional default is wrong. */
export interface FormHints {
  readonly submitLabel?: string
  readonly fields?: Readonly<Record<string, FieldHint>>
  /** The filled payload back to the one slash line the flow's grammar parses. */
  readonly args?: (payload: Readonly<Record<string, unknown>>) => string
  /** What a slash line that failed to parse still gave, by field. */
  readonly partial?: (args: string) => Readonly<Record<string, unknown>>
  /**
   * The flow's OWN rule over what the invocation already named, stated on the
   * card before the form asks for the rest.
   *
   * A value the line carried is the same value the field carries, so it earns
   * the same refusal — `/triggers.register --tokens 500000` reached the Tokens
   * field and was told nothing, while 500000 typed into that field and
   * prepared was refused with the range (walk W1). The sentence is the rule's
   * own: a door routes here, it never writes a second copy of the copy.
   */
  readonly refuse?: (payload: Readonly<Record<string, unknown>>) => string | undefined
  /**
   * The optional fields what the invocation already named makes required
   * (a setup step that needs its own inputs). The form then asks for those
   * that are missing, and only those.
   */
  readonly requires?: (payload: Readonly<Record<string, unknown>>) => ReadonlyArray<string>
}

export interface FormField {
  readonly name: string
  readonly label: string
  readonly kind: FieldKind
  readonly required: boolean
  readonly placeholder?: string
  readonly disabledReason?: string
  readonly options?: ReadonlyArray<FieldOption>
  readonly optionsFrom?: OptionProvider
}

/** One field's value as the draft holds it. */
export type FieldValue = string | number | boolean
export type FormDraft = Readonly<Record<string, FieldValue>>

/** Array text follows the flow grammar: command lists use words, file payloads use JSON.
 * @category models
 * @since 0.1.0
 */
export type ArrayEncoding = "words" | "json"

/** A payload value as trimmed text for an assembler; undefined when absent or blank. */
export const text = (payload: Readonly<Record<string, unknown>>, key: string): string | undefined => {
  const value = payload[key]
  if (value === undefined || value === null || typeof value === "boolean") return undefined
  const trimmed = String(value).trim()
  return trimmed === "" ? undefined : trimmed
}

/** `--name value` when the value is present, for the flag grammars. */
export const flag = (payload: Readonly<Record<string, unknown>>, key: string, name: string = key): string | undefined => {
  const value = text(payload, key)
  return value === undefined ? undefined : `--${name} ${value}`
}

/** The present parts as one slash line. */
export const line = (...parts: ReadonlyArray<string | undefined>): string =>
  parts.filter((part): part is string => part !== undefined && part !== "").join(" ")

/** "runId" → "Run id", "confirmName" → "Confirm name". */
export const humanize = (name: string): string => {
  const words = name.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[-_]+/g, " ").toLowerCase()
  return words.charAt(0).toUpperCase() + words.slice(1)
}

/** `Schema.optional(S)` is `Union([S, Undefined])` marked optional: the control is S's. */
const unwrapOptional = (ast: SchemaAST.AST): { readonly ast: SchemaAST.AST; readonly optional: boolean } => {
  const optional = ast.context?.isOptional === true
  if (ast._tag === "Union") {
    const rest = ast.types.filter((member) => member._tag !== "Undefined")
    if (rest.length === 1 && rest[0] !== undefined) return { ast: rest[0], optional: optional || rest.length < ast.types.length }
  }
  return { ast, optional }
}

const literalOptions = (ast: SchemaAST.AST): ReadonlyArray<FieldOption> | undefined => {
  if (ast._tag === "Literal") return [{ value: String(ast.literal), label: String(ast.literal) }]
  if (ast._tag === "Union" && ast.types.length > 0 && ast.types.every((member) => member._tag === "Literal")) {
    return ast.types.map((member) => {
      const literal = String((member as SchemaAST.Literal).literal)
      return { value: literal, label: literal }
    })
  }
  return undefined
}

const controlOf = (ast: SchemaAST.AST): Pick<FormField, "kind" | "options"> => {
  // Effect's JSON representation of Number also names non-finite values as
  // strings. A JSON launch can send only the finite numeric branch.
  const numeric = (node: SchemaAST.AST): boolean => node._tag === "Number" ||
    (node._tag === "Literal" && ["Infinity", "-Infinity", "NaN"].includes(String(node.literal))) ||
    (node._tag === "Union" && node.types.every(numeric))
  if (ast._tag === "Union" && ast.types.some(type => type._tag === "Number") && numeric(ast)) return { kind: "number" }
  switch (ast._tag) {
    case "Number":
      return { kind: "number" }
    case "Boolean":
      return { kind: "boolean" }
    default: {
      const options = literalOptions(ast)
      return options === undefined ? { kind: "text" } : { kind: "select", options }
    }
  }
}

/**
 * The form's fields, in schema order, excluding explicitly hidden optional
 * routing data. Required input always remains visible. A non-struct schema
 * derives nothing.
 *
 * @category derivation
 */
export const formFieldsFor = (input: Schema.Top, hints: FormHints | undefined = undefined): ReadonlyArray<FormField> => {
  const ast = input.ast
  if (ast._tag !== "Objects") return []
  return ast.propertySignatures.filter(signature => hints?.fields?.[String(signature.name)]?.hidden !== true || !unwrapOptional(signature.type).optional).map((signature) => {
    const name = String(signature.name)
    const { ast: inner, optional } = unwrapOptional(signature.type)
    const control = controlOf(inner)
    const hint = hints?.fields?.[name]
    // A provider-fed field is a select unless the flow keeps it free text (a model id with a datalist).
    const kind = hint?.kind ?? (hint?.optionsFrom === undefined ? control.kind : "select")
    return {
      name,
      label: hint?.label ?? humanize(name),
      kind,
      required: hint?.required ?? !optional,
      ...(hint?.placeholder === undefined ? {} : { placeholder: hint.placeholder }),
      ...(control.options === undefined || kind !== "select" ? {} : { options: control.options }),
      ...(hint?.optionsFrom === undefined ? {} : { optionsFrom: hint.optionsFrom })
    }
  })
}

const tokensOf = (args: string | undefined): Array<string> =>
  (args ?? "").trim().split(/\s+/).filter((token) => token !== "")

/**
 * Whether this token is the repository the field asks for.
 *
 * `repo` is the one name the whole app gives a repository target (RepoContext,
 * and every trailing-`owner/repo` grammar), and `owner/name` is the one shape
 * it takes. Counting slots alone spent `codeplanesmithers/canary-sandbox` on
 * the schedule name behind it (R102 follow-up), which no schedule is called.
 */
const namesARepository = (field: FormField, token: string): boolean =>
  field.name === "repo" && REPO_TOKEN.test(token)

/** What the positional read made of a line the grammar refused. */
export interface PositionalRead {
  /** The values it placed, by field. */
  readonly payload: Readonly<Record<string, unknown>>
  /**
   * The optional slots it passed over so the required slots behind them could
   * have the tokens that were left — the fields the line never named.
   */
  readonly skipped: ReadonlyArray<string>
}

/**
 * What a slash line that did not parse still gave, by field: the tokens fill
 * the non-boolean fields positionally in schema order, a `--flag` ends the
 * positional read, a token that is not a number ends it at a number field,
 * and whatever is left over rides the last text field filled (the grammars
 * take "the rest of the line" for their last text). A flow whose grammar is
 * not positional supplies its own `partial`.
 *
 * Which slot a token lands in is decided by the declaration, not by position
 * alone: an OPTIONAL slot only takes a token the required slots behind it can
 * spare. `/triggers.pause canary-w1-not-registered` spent its one token on the
 * optional repository that leads `ScheduleTarget`, so the form came back
 * asking for the schedule name the person had just typed and holding it under
 * Repo instead (walk W1, W1-d-doors.json `pauseFormFields`). Counting the
 * required slots ahead is the same rule every trailing-`owner/repo` grammar
 * applies, derived from the input schema rather than written per door.
 *
 * A slot passed over that way is reported in `skipped`, because it is a field
 * the line did not name: the card still has something to ask for, whatever
 * `missingFields` says about the required ones (controller/forms.ts).
 *
 * @category derivation
 */
export const positionalRead = (
  fields: ReadonlyArray<FormField>,
  hints: FormHints | undefined,
  args: string | undefined
): PositionalRead => {
  if (hints?.partial !== undefined) return { payload: hints.partial(args ?? ""), skipped: [] }
  const source = fields.some((field) => field.name === "sourceCard") ? splitRunSource(args) : { args, sourceCard: undefined }
  const tokens = tokensOf(source.args)
  const flag = tokens.findIndex((token) => token.startsWith("--"))
  const positional = flag === -1 ? tokens : tokens.slice(0, flag)
  const payload: Record<string, unknown> = source.sourceCard === undefined ? {} : { sourceCard: source.sourceCard }
  const slots = fields.filter((field) => field.kind !== "boolean" && field.name !== "sourceCard")
  const skipped: Array<string> = []
  let lastText: string | undefined
  let index = 0
  let slot = 0
  for (; slot < slots.length; slot += 1) {
    const field = slots[slot]!
    const token = positional[index]
    if (token === undefined) break
    // An optional slot is skipped while the required slots behind it need every token left,
    // unless the token is shaped like the repository that slot names — no schedule is called `owner/name`.
    const requiredAhead = slots.slice(slot + 1).filter((candidate) => candidate.required).length
    if (!field.required && positional.length - index <= requiredAhead && !namesARepository(field, token)) {
      skipped.push(field.name)
      continue
    }
    if (field.kind === "number") {
      const value = Number(token)
      if (!Number.isFinite(value)) break
      payload[field.name] = value
    } else {
      payload[field.name] = token
      lastText = field.name
    }
    index += 1
  }
  if (slot === slots.length && lastText !== undefined && positional.length > index) {
    payload[lastText] = [payload[lastText], ...positional.slice(index)].join(" ")
  }
  return { payload, skipped }
}

/** `positionalRead`'s values alone, for the callers that only place them. */
export const partialPayload = (
  fields: ReadonlyArray<FormField>,
  hints: FormHints | undefined,
  args: string | undefined
): Readonly<Record<string, unknown>> => positionalRead(fields, hints, args).payload

/** What the input schema says about one property, past `Schema.optional`. */
interface PropertyShape {
  readonly optional: boolean
  readonly tag: SchemaAST.AST["_tag"]
  readonly ast: SchemaAST.AST
}

/** The flow's input struct as the submission reads it: one shape per property, in schema order. */
const inputShape = (input: Schema.Top): ReadonlyMap<string, PropertyShape> => {
  const ast = input.ast
  const shape = new Map<string, PropertyShape>()
  if (ast._tag !== "Objects") return shape
  for (const signature of ast.propertySignatures) {
    const { ast: inner, optional } = unwrapOptional(signature.type)
    shape.set(String(signature.name), { optional, tag: inner._tag, ast: inner })
  }
  return shape
}

/**
 * One field's draft value as its property's schema takes it. A structure's
 * control is one line of text, so the inverse of the control is a parse: an
 * object field holds JSON, and a list field holds the space-separated items
 * `assembleArgs` writes and every list grammar reads. Text that is not the
 * JSON an object field needs is the form's refusal, not the flow's problem.
 */
const asProperty = (shape: PropertyShape | undefined, value: FieldValue, arrays: ArrayEncoding): { readonly value: unknown } | { readonly invalid: true } => {
  if (typeof value !== "string" || shape === undefined) return { value }
  if (shape.tag === "Arrays" && arrays === "words") return { value: value.trim() === "" ? [] : value.trim().split(/\s+/) }
  if (shape.ast._tag === "Literal" && String(shape.ast.literal) === value) return { value: shape.ast.literal }
  if (shape.ast._tag === "Union") {
    const literal = shape.ast.types.find(member => member._tag === "Literal" && String(member.literal) === value)
    if (literal?._tag === "Literal") return { value: literal.literal }
  }
  if (shape.tag !== "Objects" && shape.tag !== "Arrays") return { value }
  try {
    return { value: JSON.parse(value) }
  } catch {
    return { invalid: true }
  }
}

/** A filled form as the flow's named payload, or the honest refusal one of its controls earned. */
export type Submission =
  | { readonly payload: Record<string, unknown> }
  | { readonly error: string }

/**
 * The filled form as the flow's OWN named payload — the record a submission
 * runs with, validated by the declaration's input schema.
 *
 * Field identity survives here, which the positional line cannot promise: a
 * value the human left blank is ABSENT rather than shifting the next field's
 * value into it, a prefilled free-text field the human cleared submits as the
 * clear it shows, a field the schema requires and a `required: false` hint
 * lets stand blank submits as the empty string that hint means, and a
 * structured field parses back out of the text its control holds.
 * `assembleArgs` still writes the slash line, but only as display copy —
 * nothing reparses it into the payload.
 *
 * @category derivation
 */
export const submissionPayload = (
  input: Schema.Top,
  fields: ReadonlyArray<FormField>,
  given: Readonly<Record<string, unknown>>,
  draft: FormDraft,
  arrays: ArrayEncoding = "words"
): Submission => {
  const shape = inputShape(input)
  const represented = new Set(fields.map((field) => field.name))
  // What the form could not represent stays exactly as the invocation gave it.
  const payload: Record<string, unknown> = Object.fromEntries(
    Object.entries(given).filter(([name]) => !represented.has(name))
  )
  for (const field of fields) {
    if (field.kind === "write-only") continue
    const property = shape.get(field.name)
    const value = draft[field.name]
    if (value !== undefined) {
      if (field.kind === "number") {
        if (String(value).trim() === "" && !field.required) continue
        const number = typeof value === "number" ? value : Number(String(value).trim())
        if (!Number.isFinite(number) || String(value).trim() === "") return { error: `${field.label}: not a number` }
        payload[field.name] = number
        continue
      }
      const converted = asProperty(property, value, arrays)
      if ("invalid" in converted) return { error: `${field.label} is not valid JSON. Fix it before submitting the form.` }
      payload[field.name] = converted.value
      continue
    }
    const blankStands = property !== undefined && !property.optional && property.tag === "String"
    // A field the invocation filled and the human then cleared submits as the clear it shows.
    if (blankStands || (field.kind === "text" && typeof given[field.name] === "string")) payload[field.name] = ""
  }
  return { payload }
}

const coerce = (field: FormField, value: unknown, arrays: ArrayEncoding): FieldValue | undefined => {
  if (value === undefined || value === null) return undefined
  if (Array.isArray(value)) return arrays === "json" ? JSON.stringify(value) : value.map(String).join(" ")
  switch (field.kind) {
    case "number": {
      const number = typeof value === "number" ? value : Number(String(value).trim())
      return Number.isFinite(number) && String(value).trim() !== "" ? number : undefined
    }
    case "boolean":
      return typeof value === "boolean" ? value : ["true", "on", "yes", "1"].includes(String(value).trim().toLowerCase())
    default:
      return typeof value === "object" ? JSON.stringify(value) : String(value)
  }
}

/**
 * The draft the card starts with: every given field coerced to its control's
 * value. Anything the form cannot represent stays only in `given`.
 *
 * @category derivation
 */
export const draftFrom = (fields: ReadonlyArray<FormField>, given: Readonly<Record<string, unknown>>, arrays: ArrayEncoding = "words"): Record<string, FieldValue> => {
  const draft: Record<string, FieldValue> = {}
  for (const field of fields) {
    if (field.kind === "write-only") continue
    const value = coerce(field, given[field.name] ?? (field.kind === "boolean" && field.required ? false : undefined), arrays)
    if (value !== undefined) draft[field.name] = value
  }
  return draft
}

const blank = (value: FieldValue | undefined): boolean =>
  value === undefined || (typeof value === "string" && value.trim() === "")

/** The required fields the draft has not filled, in schema order. */
export const missingFields = (fields: ReadonlyArray<FormField>, draft: FormDraft): Array<string> =>
  fields.filter((field) => field.required && field.kind !== "boolean" && blank(draft[field.name])).map((field) => field.name)

/** The slash line a filled form assembles to, and the values it could not carry. */
export interface AssembledLine {
  /** The line the flow's grammar parses. */
  readonly args: string
  /**
   * The fields whose values the line left out because the grammar would not
   * read them back as themselves. A caller that runs the line re-parsed as
   * text loses these; a caller that shows the line beside a named payload
   * must name them (`displayLine`).
   */
  readonly withheld: ReadonlyArray<string>
}

/**
 * The filled form as the one slash line the flow's grammar parses. The
 * default is positional in schema order — blanks skipped, an array
 * space-joined, every true boolean as a trailing `--name` — which is the shape
 * most grammars in SlashPayload.ts take; a flow whose grammar differs supplies
 * `args`.
 *
 * The grammars split on whitespace and have no quoting, so the line carries a
 * value only when it reads back as itself. On the default path a value
 * carrying a `--flag` or `sourceCard=` token, a `sourceCard` or list item that
 * is not one token, and any value the positional read (`positionalRead`, with
 * the flow's `partial`) would place in another field ends the line before it:
 * a multi-word value short of the final slot (JSON included, unless the flow's
 * `partial` reads it balanced), a value behind an unset slot, or a value an
 * optional slot would pass to a required one. Everything from the first such
 * value on is `withheld`.
 *
 * A flow's own `args` builder gets the same refusal: a value whose `--flag` or
 * `sourceCard=` token, or whose whitespace in a `sourceCard`, the builder
 * writes unquoted (not as its JSON string literal) is withheld; a value with a
 * `name=` binding or a `from:<ref>` token is withheld however it is quoted;
 * and when the flow declares `partial` every carried value must read back
 * through it.
 *
 * These checks know the grammars' shared tokens, not every flow's grammar: a
 * value ending in an `owner/repo` token can still be read as a trailing
 * repository by that flow's grammar. A caller that re-runs the line as text
 * must compare the grammar's read of it with the named payload (apps/app
 * Commands.ts `carriesPayload`).
 *
 * @category derivation
 */
export const assembleLine = (
  fields: ReadonlyArray<FormField>,
  hints: FormHints | undefined,
  payload: Readonly<Record<string, unknown>>
): AssembledLine => {
  payload = publicFormPayload(fields, payload)
  if (hints?.args !== undefined) return builtLine(fields, hints, hints.args, payload)
  const groups = [...fields.filter((field) => field.name === "sourceCard"), ...fields.filter((field) => field.name !== "sourceCard")]
    .flatMap((field): Array<LineGroup> => {
      const value = payload[field.name]
      if (value === undefined || value === null) return []
      if (field.kind === "boolean") return value === true || value === "true" ? [{ field, kind: "flag", text: `--${field.name}` }] : []
      if (Array.isArray(value)) {
        const items = value.map(String).filter((item) => item.trim() !== "").map((item) => item.trim())
        return items.length === 0 ? [] : [{ field, kind: "items", text: items.join(" "), items }]
      }
      const text = String(value).trim()
      if (text === "") return []
      return [{ field, kind: field.name === "sourceCard" ? "source" : "text", text }]
    })
  // A flag goes last: the grammars read one anywhere, and the positional read stops at the first.
  const flags = groups.filter((group) => group.kind === "flag").map(lineText)
  const values = groups.filter((group) => group.kind !== "flag")
  let length = values.findIndex((group) => !isOneValue(group))
  if (length === -1) length = values.length
  while (length > 0 && !readsBackAsWritten(fields, hints, values.slice(0, length), flags)) length -= 1
  const withheld = [...new Set(values.slice(length).map((group) => group.field.name))]
  return { args: [...values.slice(0, length).map(lineText), ...flags].join(" "), withheld }
}

/**
 * `assembleLine`'s line alone.
 *
 * @category derivation
 */
export const assembleArgs = (
  fields: ReadonlyArray<FormField>,
  hints: FormHints | undefined,
  payload: Readonly<Record<string, unknown>>
): string => assembleLine(fields, hints, payload).args

/**
 * The line as display copy beside a named payload: the withheld fields named
 * after it, so the echo never hides a value the run carried.
 *
 * @category derivation
 */
export const displayLine = (line: AssembledLine): string =>
  line.withheld.length === 0 ? line.args : `${line.args} (+${line.withheld.join(", ")})`.trim()

type LineGroup = {
  readonly field: FormField
  readonly kind: "flag" | "source" | "items" | "text"
  readonly text: string
  readonly items?: ReadonlyArray<string>
}

const lineText = (group: LineGroup): string => group.kind === "source" ? `sourceCard=${group.text}` : group.text

/**
 * A token the app's grammars read as something other than text: a `--flag`,
 * a `sourceCard=` or other `name=` binding (`against=`, `by=`, `lineage=`),
 * or the `from:<ref>` a change or pull request reads anywhere in its line.
 */
const smuggles = (token: string): boolean =>
  token.startsWith("--") || /^[A-Za-z]+=/.test(token) || /^from:/i.test(token)

/** The flag or `sourceCard=` tokens a JSON string literal keeps inside one value (fileArgs, JSON payloads). */
const quotable = (token: string): boolean => token.startsWith("--") || /^sourceCard=/i.test(token)

/** Whether a group is one value no token of which the grammar reads as a flag, a binding, or a second item. */
const isOneValue = (group: LineGroup): boolean => {
  if (group.kind === "flag") return true
  if (group.kind === "source") return !/\s/.test(group.text) && !group.text.startsWith("--")
  if (group.kind === "items") return group.items!.every((item) => !/\s/.test(item) && !smuggles(item))
  return !group.text.split(/\s+/).some(smuggles)
}

const collapse = (value: unknown): string => String(value).trim().split(/\s+/).join(" ")

const parsedJson = (value: unknown): unknown => {
  if (typeof value !== "string") return value
  try {
    return JSON.parse(value)
  } catch {
    return undefined
  }
}

/** Whether the grammar's read of a field is the value written: whitespace-collapsed text, a number, or equal JSON. */
const readsAs = (got: unknown, want: unknown): boolean => {
  if (got === undefined || got === null) return false
  const asText = (value: unknown) => Array.isArray(value) ? collapse(value.map(String).join(" ")) : typeof value === "object" ? JSON.stringify(value) : collapse(value)
  if (asText(got) === asText(want)) return true
  if (typeof want === "number" || typeof got === "number") return Number(got) === Number(want) && String(want).trim() !== ""
  const left = parsedJson(got)
  const right = parsedJson(want)
  return left !== undefined && typeof left === "object" && JSON.stringify(left) === JSON.stringify(right)
}

/**
 * Whether the positional read of this exact line places every value in its own
 * field and no value in any other.
 */
const readsBackAsWritten = (
  fields: ReadonlyArray<FormField>,
  hints: FormHints | undefined,
  groups: ReadonlyArray<LineGroup>,
  flags: ReadonlyArray<string>
): boolean => {
  const expected = new Map<string, string>()
  for (const group of groups) expected.set(group.field.name, group.field.kind === "number" ? String(Number(group.text)) : group.text)
  const read = positionalRead(fields, hints, [...groups.map(lineText), ...flags].join(" ")).payload
  const booleans = new Set(fields.filter((field) => field.kind === "boolean").map((field) => field.name))
  const readNames = Object.keys(read).filter((name) => read[name] !== undefined && !booleans.has(name))
  if (readNames.some((name) => !expected.has(name))) return false
  for (const [name, value] of expected) if (!readsAs(read[name], value)) return false
  return true
}

const present = (value: unknown): boolean =>
  value !== undefined && value !== null && !(typeof value === "string" && value.trim() === "") && !(Array.isArray(value) && value.length === 0)

const valueText = (value: unknown): string =>
  Array.isArray(value) ? value.map(String).join(" ") : typeof value === "object" ? JSON.stringify(value) : String(value).trim()

/**
 * Whether a flow's builder wrote this value where its grammar cannot read a
 * flag or a binding out of it: no such token, or the value written as its
 * JSON string literal (quoted, as `fileArgs` and JSON payloads write it).
 */
const placedSafely = (field: FormField, value: unknown, args: string): boolean => {
  const text = valueText(value)
  const tokens = text.split(/\s+/)
  // A binding reads out of a quoted value too: the grammars split on whitespace.
  if (tokens.some((token) => smuggles(token) && !quotable(token))) return false
  const unsafe = tokens.some(quotable) || (field.name === "sourceCard" && /\s/.test(text))
  return !unsafe || args.includes(JSON.stringify(text))
}

/** A flow `args` builder's line, withholding every value it would write where the grammar misreads it. */
const builtLine = (
  fields: ReadonlyArray<FormField>,
  hints: FormHints,
  build: (payload: Readonly<Record<string, unknown>>) => string,
  payload: Readonly<Record<string, unknown>>
): AssembledLine => {
  const carried: Record<string, unknown> = { ...payload }
  const withheld: Array<string> = []
  const checked = fields.filter((field) => field.kind !== "boolean")
  for (;;) {
    const args = build(carried).trim()
    const live = checked.filter((field) => present(carried[field.name]))
    let refused = live.filter((field) => !placedSafely(field, carried[field.name], args))
    if (refused.length === 0 && hints.partial !== undefined) {
      const read = hints.partial(args)
      refused = live.filter((field) => !readsAs(read[field.name], carried[field.name]))
      const spilled = checked.some((field) => !live.includes(field) && present(read[field.name]))
      if (refused.length === 0 && spilled && live.length > 0) refused = [live[live.length - 1]!]
    }
    if (refused.length === 0) return { args, withheld }
    for (const field of refused) {
      delete carried[field.name]
      withheld.push(field.name)
    }
  }
}

/** Write-only properties are never an input to a durable command or form. */
export const publicFormPayload = (fields: ReadonlyArray<FormField>, payload: Readonly<Record<string, unknown>>, payloadField?: string): Record<string, unknown> => {
  // Leave other forms' input (including malformed input their schema refuses)
  // untouched. Object.entries would normalize a non-object into a valid map.
  if (!fields.some(field => field.kind === "write-only")) return payload
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return {}
  if (payloadField !== undefined) {
    const nested = payload[payloadField]
    return nested !== null && typeof nested === "object" && !Array.isArray(nested)
      ? { ...payload, [payloadField]: publicFormPayload(fields, nested as Record<string, unknown>) } : { ...payload }
  }
  const privateNames = new Set(fields.filter(field => field.kind === "write-only").map(field => field.name))
  return Object.fromEntries(Object.entries(payload).filter(([name]) => !privateNames.has(name)))
}

/** Required fields with the labels shown by either renderer.
 * @category derivation
 * @since 0.1.0
 */
export const missingLabels = (fields: ReadonlyArray<FormField>, draft: FormDraft): Array<string> => {
  const missing = new Set(missingFields(fields, draft))
  return fields.filter(field => missing.has(field.name)).map(field => field.label)
}

/** Prepare a file-flow payload after checking the form's required inputs.
 * @category derivation
 * @since 0.1.0
 */
export const fileSubmission = (input: Schema.Top, fields: ReadonlyArray<FormField>, given: Readonly<Record<string, unknown>>, draft: FormDraft): Submission => {
  const missing = missingLabels(fields, draft)
  return missing.length > 0 ? { error: `Needs: ${missing.join(", ")}` } : submissionPayload(input, fields, given, draft, "json")
}
