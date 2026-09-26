/**
 * The one store for contributed UI: status items, keys and plugin panels from
 * every owner, plus what repository flows declare in `metadata.tui`.
 *
 * Owners, in precedence order after the built-in keys:
 * - `plugin:<name>`: built-in TUI plugins at the composition root.
 * - `repo:<name>`: `Extension.declared` for each listed flow. Recomputed on
 *   every registry listing and never persisted.
 * - `runtime:<source>`: cells, through `ui.publish`. The app persists these.
 *
 * Runtime panels stay in the workspace, which persists them; this store holds
 * the rest. Publishing never runs an action; only a person or an agent does.
 */
import * as Extension from "./extension.ts"
import type * as Panels from "./panels.ts"

export const limits = { keysPerOwner: 8, status: 24, shownStatus: 3 } as const

/** A typed, one-line refusal: the cell that published gets exactly this text. */
export class Refusal extends Error {
  constructor(readonly code: "invalid" | "limit" | "collision", message: string) {
    super(message)
  }
}

export interface Owned<A> {
  readonly owner: string
  readonly value: A
}
export interface Placed {
  readonly owner: string
  readonly placement: "tab" | "card"
  readonly panel: Panels.Panel
}
export interface Snapshot {
  /** Plugin panels; runtime panels live in the workspace. */
  readonly panels: ReadonlyArray<Placed>
  /** Repository flows whose runs show as live transcript cards. */
  readonly cards: ReadonlyArray<string>
  /** Repository flows that asked for a status item; `snapshot(live)` resolves them. */
  readonly watched: ReadonlyArray<string>
  readonly status: ReadonlyArray<{ readonly owner: string; readonly status: Extension.Status }>
  readonly keys: ReadonlyArray<{ readonly owner: string; readonly key: Extension.Key }>
  /** One line each; the footer shows them as one danger item. */
  readonly problems: ReadonlyArray<string>
}

type Keyed = Extract<Extension.Contribution, { kind: "status" | "key" }>

export class Store {
  private runtimes = new Map<string, { readonly owner: string; readonly contribution: Keyed }>()
  private declared: ReadonlyArray<Extension.Declared> = []
  private declaredText = "[]"
  private plugins = new Map<string, ReadonlyArray<Extension.Contribution>>()
  private listeners = new Set<() => void>()
  constructor(
    private options: {
      /** The built-in binding a key would shadow (`Keys.taken`). */
      readonly taken: (key: string, context: "global" | "panel") => { readonly label: string } | undefined
    }
  ) {}
  subscribe = (listener: () => void): () => void => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }
  private changed() {
    for (const listener of this.listeners) listener()
  }

  /** A cell's status item or key. Throws a `Refusal` and stores nothing when it cannot be shown. */
  runtime = (owner: string, value: Extension.Contribution): void => {
    if (value.kind === "panel") throw new Refusal("invalid", "Panels publish through the workspace")
    const contribution = validate(value)
    const id = contribution.kind === "status" ? contribution.status.id : contribution.key.id
    const slot = `${owner}\0${contribution.kind}\0${id}`
    const others = [...this.runtimes.entries()].filter(([key]) => key !== slot).map(([, entry]) => entry)
    if (contribution.kind === "status") {
      if (others.filter((entry) => entry.contribution.kind === "status").length >= limits.status) {
        throw new Refusal("limit", `Limit of ${limits.status} status items reached; reuse an id`)
      }
    } else {
      const own = others.filter((entry) => entry.owner === owner && entry.contribution.kind === "key")
      if (own.length >= limits.keysPerOwner) {
        throw new Refusal("limit", `Limit of ${limits.keysPerOwner} keys per owner reached; reuse an id`)
      }
      const problem = this.collision(contribution.key, this.effective(others).keys)
      if (problem !== undefined) throw new Refusal("collision", problem)
    }
    this.runtimes.set(slot, { owner, contribution })
    this.changed()
  }

  /** Every `repo:` contribution, replaced at once from a registry listing. */
  repo = (declared: ReadonlyArray<Extension.Declared>): void => {
    const text = JSON.stringify(declared)
    if (text === this.declaredText) return
    this.declared = declared
    this.declaredText = text
    this.changed()
  }

  /** A built-in plugin's whole set; an empty list removes it. */
  plugin = (name: string, contributions: ReadonlyArray<Extension.Contribution>): void => {
    const next = contributions.map(validate)
    // A plugin pushes on every render of its state; an unchanged set changes nothing.
    if (JSON.stringify(next) === JSON.stringify(this.plugins.get(name) ?? [])) return
    if (next.length === 0) this.plugins.delete(name)
    else this.plugins.set(name, next)
    this.changed()
  }

  /** A new session starts without the old session's runtime items. */
  clearRuntime = (): void => {
    if (this.runtimes.size === 0) return
    this.runtimes.clear()
    this.changed()
  }

  snapshot = (live: (name: string) => Extension.Status | undefined = () => undefined): Snapshot => {
    const effective = this.effective([...this.runtimes.values()])
    const watched = this.declared.filter((each) => each.status).map((each) => name(each.owner))
    return {
      panels: [...this.plugins.entries()].flatMap(([plugin, contributions]) =>
        contributions.flatMap((each) =>
          each.kind === "panel" ? [{ owner: `plugin:${plugin}`, placement: each.placement, panel: each.panel }] : []
        )
      ),
      cards: this.declared.filter((each) => each.card).map((each) => name(each.owner)),
      watched,
      status: [
        ...this.pluginEntries().flatMap(({ owner, contribution }) =>
          contribution.kind === "status" ? [{ owner, status: contribution.status }] : []
        ),
        ...watched.flatMap((flow) => {
          const status = live(flow)
          return status === undefined ? [] : [{ owner: `repo:${flow}`, status }]
        }),
        ...[...this.runtimes.values()].flatMap(({ owner, contribution }) =>
          contribution.kind === "status" ? [{ owner, status: contribution.status }] : []
        )
      ],
      keys: effective.keys,
      problems: effective.problems
    }
  }

  private pluginEntries() {
    return [...this.plugins.entries()].flatMap(([plugin, contributions]) =>
      contributions.map((contribution) => ({ owner: `plugin:${plugin}`, contribution }))
    )
  }

  /** Why `key` cannot join `held`, or undefined. */
  private collision(
    key: Extension.Key,
    held: ReadonlyArray<{ readonly owner: string; readonly key: Extension.Key }>
  ): string | undefined {
    const context = key.context ?? "global"
    const builtIn = this.options.taken(key.key, context)
    if (builtIn !== undefined) return `${key.key} is the built-in ${builtIn.label} key`
    // Two owners never share a spelling, whatever the context: the popup could not tell them apart.
    const holder = held.find((each) => same(each.key.key, key.key))
    return holder === undefined ? undefined : `${key.key} is taken by ${holder.owner}`
  }

  /** Keys in precedence order (plugin, repo, runtime); a later collision becomes a problem. */
  private effective(runtimes: ReadonlyArray<{ readonly owner: string; readonly contribution: Keyed }>) {
    const keys: Array<{ owner: string; key: Extension.Key }> = []
    const problems: Array<string> = []
    const offer = (owner: string, key: Extension.Key) => {
      const problem = this.collision(key, keys)
      if (problem === undefined) keys.push({ owner, key })
      else problems.push(`${name(owner)}: ${problem}`)
    }
    for (const { owner, contribution } of this.pluginEntries()) {
      if (contribution.kind === "key") offer(owner, contribution.key)
    }
    for (const each of this.declared) {
      problems.push(...each.problems)
      for (const key of each.keys) offer(each.owner, key)
    }
    for (const { owner, contribution } of runtimes) if (contribution.kind === "key") offer(owner, contribution.key)
    return { keys, problems }
  }
}

const name = (owner: string): string => owner.slice(owner.indexOf(":") + 1)

const sameParts = (key: string) => {
  const parts = key.toLowerCase().split("+")
  const base = parts.at(-1) ?? ""
  return [...["ctrl", "alt", "shift"].filter((modifier) => parts.slice(0, -1).includes(modifier)), base].join("+")
}
const same = (a: string, b: string): boolean => sameParts(a) === sameParts(b)

/** Decodes again, so a hand-built value meets the same limits as a published one. */
const validate = <C extends Extension.Contribution>(value: C): C => {
  if (value.kind === "key") {
    const problem = Extension.keyProblem(value.key.key, value.key.context ?? "global")
    if (problem !== undefined) throw new Refusal("invalid", problem)
  }
  try {
    return Extension.decode(value) as C
  } catch (error) {
    const message = error instanceof Error ? error.message.split("\n")[0]! : String(error)
    throw new Refusal("invalid", message)
  }
}
