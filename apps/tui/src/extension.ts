/**
 * The extension contract both extension tracks share: what a repository flow
 * or agent declares, and the UI a cell, a flow, an agent or a plugin
 * contributes. Everything here is serializable data; the TUI owns rendering,
 * focus and keys, and an action runs only when a person or an agent chooses it.
 *
 * Agents are markdown flows (`flows/<name>/flow.mdx` or `SKILL.md`): the
 * registry already parses their prompt, `model`, `effort`, `flows`,
 * `capabilities` and `budget`. There is no second agent or graph model.
 */
import { Schema } from "effect"
import * as Panels from "./panels.ts"

const short = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(240))
const line = (max: number) =>
  Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(max), Schema.isPattern(/^[^\r\n]+$/))

/** What choosing a key, a status item or a row does; defined beside `Row` so rows can carry one. */
export const Action = Panels.Action
export type Action = Panels.Action

const modifiers = new Set(["ctrl", "alt", "shift"])
/** Why `key` cannot be contributed in `context`, or undefined when it can. */
export const keyProblem = (key: string, context: "global" | "panel"): string | undefined => {
  const parts = key.split("+")
  const base = parts.at(-1) ?? ""
  if (base === "" || parts.slice(0, -1).some((part) => !modifiers.has(part))) return `Unreadable key ${key}`
  if (context === "global" && !parts.includes("ctrl") && !parts.includes("alt")) {
    return `Global key ${key} needs ctrl or alt`
  }
  return undefined
}

const KeyFields = Schema.Struct({
  id: short,
  /** The `keys.ts` token spelling: `alt+r`, `ctrl+shift+e`. */
  key: line(40),
  label: line(24),
  action: Action,
  /** `global` keys work everywhere and need a modifier; `panel` keys work on the owner's own surface. */
  context: Schema.optional(Schema.Literals(["global", "panel"]))
})
export const Key = KeyFields.check(
  Schema.makeFilter((key) => keyProblem(key.key, key.context ?? "global") ?? true)
)
export type Key = typeof Key.Type

export const Status = Schema.Struct({
  id: short,
  text: line(24),
  tone: Schema.optional(Schema.Literals(["info", "success", "warning", "danger"])),
  action: Schema.optional(Action)
})
export type Status = typeof Status.Type

/** One unit of UI. A panel's `placement` picks a tab (the default) or a live transcript card. */
export const Contribution = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("panel"), placement: Schema.Literals(["tab", "card"]), panel: Panels.Panel }),
  Schema.Struct({ kind: Schema.Literal("status"), status: Status }),
  Schema.Struct({ kind: Schema.Literal("key"), key: Key })
])
export type Contribution = typeof Contribution.Type

/**
 * What `ui.publish` accepts. A bare panel, the original input, stays a tab.
 * The panel's own limits (`Panels.decode`) still apply.
 */
export const decode = (value: unknown): Contribution => {
  const input = typeof value === "object" && value !== null && !("kind" in value)
    ? { kind: "panel", placement: "tab", panel: value }
    : typeof value === "object" && value !== null && (value as { kind?: unknown }).kind === "panel" &&
        !("placement" in value)
    ? { ...value, placement: "tab" }
    : value
  const contribution = Schema.decodeUnknownSync(Contribution)(input)
  return contribution.kind === "panel" ? { ...contribution, panel: Panels.decode(contribution.panel) } : contribution
}

/** The TUI's projection of a registry `FlowDescriptor`: metadata only, never the body. */
export interface Descriptor {
  readonly name: string
  readonly description: string
  readonly modelInvocable: boolean
  /** `markdown` bodies are prompts, so the flow is also an agent. */
  readonly kind: "markdown" | "module"
  /** The declared seat (`model:`), unresolved. */
  readonly seat?: string
  readonly fallbackSeats?: ReadonlyArray<string>
  readonly effort?: string
  /** The flows the agent may call (`flows:` or `allowed-tools:`); empty means the host's default catalog. */
  readonly flows: ReadonlyArray<string>
  readonly capabilities: ReadonlyArray<string>
  readonly path: string
  /** Raw `metadata.tui`; decoded by {@link declared}. */
  readonly tui?: unknown
}

/** The registry fields {@link project} reads; a `FlowDescriptor` satisfies it. */
export interface Source {
  readonly name: string
  readonly description: string
  readonly modelInvocable: boolean
  readonly body: { readonly _tag: string }
  readonly model: { readonly _tag: "Some"; readonly value: string | ReadonlyArray<string> } | { readonly _tag: "None" }
  readonly flows: ReadonlyArray<string>
  readonly capabilities: ReadonlyArray<string>
  readonly path: string
  readonly frontmatter: { readonly [key: string]: unknown }
}

export const project = (source: Source): Descriptor => {
  const metadata = source.frontmatter["metadata"]
  const tui = typeof metadata === "object" && metadata !== null && !Array.isArray(metadata)
    ? (metadata as Record<string, unknown>)["tui"]
    : undefined
  const effort = source.frontmatter["effort"]
  const model = source.model._tag === "Some" ? source.model.value : undefined
  return {
    name: source.name,
    description: source.description,
    modelInvocable: source.modelInvocable,
    kind: source.body._tag === "Markdown" ? "markdown" : "module",
    ...(model === undefined
      ? {}
      : typeof model === "string"
      ? { seat: model }
      : { seat: model[0], fallbackSeats: model.slice(1) }),
    ...(typeof effort === "string" && effort !== "" ? { effort } : {}),
    flows: [...source.flows],
    capabilities: [...source.capabilities],
    path: source.path,
    ...(tui === undefined ? {} : { tui })
  }
}

export const isAgent = (descriptor: Descriptor): boolean => descriptor.kind === "markdown"

/**
 * A frontmatter flag. The registry parses frontmatter with YAML's failsafe
 * schema, so `status: true` arrives as the string `"true"`.
 */
const Flag = Schema.Union([Schema.Boolean, Schema.Literals(["true", "false"])])
const flag = (value: boolean | "true" | "false" | undefined): boolean => value === true || value === "true"

/**
 * `metadata.tui` in a flow's frontmatter: a mapping, or the same mapping as a
 * JSON string where `metadata` must map strings to strings (SKILL.md). A key
 * without an action runs its owner.
 */
export const Manifest = Schema.Struct({
  keys: Schema.optional(
    Schema.Array(Schema.Struct({
      key: line(40),
      label: line(24),
      action: Schema.optional(Action),
      context: Schema.optional(Schema.Literals(["global", "panel"]))
    })).check(Schema.isMaxLength(8))
  ),
  /** Show the owner's latest run or tab as a status item. */
  status: Schema.optional(Flag),
  /** Show the owner's runs as live transcript cards. */
  card: Schema.optional(Flag)
})

export interface Declared {
  /** `repo:<name>`; runtime owners are `runtime:<source>`, plugins `plugin:<name>`. */
  readonly owner: string
  readonly keys: ReadonlyArray<Key>
  readonly status: boolean
  readonly card: boolean
  /** One line each; a problem drops the whole manifest, never half of it. */
  readonly problems: ReadonlyArray<string>
}

export const declared = (descriptor: Descriptor): Declared => {
  const owner = `repo:${descriptor.name}`
  const none: Declared = { owner, keys: [], status: false, card: false, problems: [] }
  if (descriptor.tui === undefined) return none
  try {
    const manifest = Schema.decodeUnknownSync(Manifest)(
      typeof descriptor.tui === "string" ? JSON.parse(descriptor.tui) : descriptor.tui
    )
    // A key without an action runs its owner. An agent's key starts it at once, its label the prompt.
    const own = (label: string): Action =>
      isAgent(descriptor)
        ? { kind: "agent", agent: descriptor.name, prompt: label }
        : { kind: "flow", flow: descriptor.name }
    const keys = (manifest.keys ?? []).map((key) =>
      Schema.decodeUnknownSync(Key)({
        id: `${owner}/${key.key}`,
        key: key.key,
        label: key.label,
        context: key.context ?? "global",
        action: key.action ?? own(key.label)
      })
    )
    return { owner, keys, status: flag(manifest.status), card: flag(manifest.card), problems: [] }
  } catch (error) {
    const message = error instanceof Error ? error.message.split("\n")[0] : String(error)
    return { ...none, problems: [`${descriptor.name}: ${message}`] }
  }
}
