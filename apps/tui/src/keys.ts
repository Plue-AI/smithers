import type * as Extension from "./extension.ts"
import type * as Surfaces from "./surfaces.ts"

/**
 * The TUI key contract. Keep labels short: this registry feeds the footer,
 * the which-key panel, the home screen, and the generated key list.
 */

export type KeyContext =
  | "global"
  | "composer"
  | "working"
  | "shell"
  | "panel"
  | "picker"
  | "form"
  | "approval"
  | "selection"
  | "completion"
  | "card"
  | "overview"
  | "review"
  | "checklist"

export interface Binding {
  readonly id: string
  /** Alternative spellings for one action. */
  readonly keys: ReadonlyArray<string>
  /** How the popup and footer spell a long key list. */
  readonly display?: string
  /** One to three words. */
  readonly label: string
  readonly context: KeyContext
  readonly group: string
  /** A contributed key runs this; a built-in key's handler lives in `app.tsx`. */
  readonly action?: Extension.Action
  /** `repo:<name>`, `runtime:<source>` or `plugin:<name>`; absent on built-in keys. */
  readonly owner?: string
}

/** The keys the application handles. Text input is intentionally not listed. */
export const registry: ReadonlyArray<Binding> = [
  // Always available while the composer owns the screen.
  { id: "keys", keys: ["?"], label: "Keys", context: "global", group: "Global" },
  { id: "clear", keys: ["ctrl+c"], label: "Clear", context: "global", group: "Global" },
  { id: "exit", keys: ["ctrl+d"], label: "Exit", context: "global", group: "Global" },
  { id: "timeline", keys: ["ctrl+t"], label: "Timeline", context: "global", group: "Global" },
  { id: "expand", keys: ["ctrl+o"], label: "Expand", context: "global", group: "Global" },
  { id: "editor", keys: ["ctrl+g"], label: "Edit prompt", context: "global", group: "Global" },
  { id: "palette", keys: ["ctrl+k"], label: "Search", context: "global", group: "Global" },
  { id: "summary", keys: ["ctrl+s"], label: "Summary", context: "global", group: "Tabs" },
  // Ctrl+Left/Right stay as aliases; macOS takes them for Spaces by default.
  { id: "next-tab", keys: ["ctrl+]", "ctrl+right"], label: "Next tab", context: "global", group: "Tabs" },
  { id: "previous-tab", keys: ["ctrl+[", "ctrl+left"], label: "Previous tab", context: "global", group: "Tabs" },
  { id: "chat", keys: ["ctrl+\\"], label: "Chat", context: "global", group: "Tabs" },
  { id: "parent", keys: ["ctrl+y"], label: "Back", context: "global", group: "Tabs" },
  { id: "scroll", keys: ["pageup", "pagedown"], label: "Scroll", context: "global", group: "Global" },
  {
    id: "scroll-line",
    keys: ["shift+up", "shift+down"],
    display: "shift+↑/↓",
    label: "Scroll a line",
    context: "global",
    group: "Global"
  },

  { id: "send", keys: ["enter"], label: "Send", context: "composer", group: "Composer" },
  { id: "queue", keys: ["alt+enter"], label: "Queue", context: "composer", group: "Composer" },
  { id: "restore", keys: ["alt+up"], label: "Restore queue", context: "composer", group: "Composer" },
  {
    id: "newline",
    keys: ["shift+enter", "ctrl+j", "linefeed"],
    label: "New line",
    context: "composer",
    group: "Composer"
  },
  { id: "history", keys: ["up", "down"], label: "History", context: "composer", group: "Composer" },
  { id: "model", keys: ["ctrl+l"], label: "Pick model", context: "composer", group: "Composer" },
  { id: "next-model", keys: ["ctrl+p"], label: "Next model", context: "composer", group: "Composer" },
  { id: "previous-model", keys: ["ctrl+shift+p"], label: "Previous model", context: "composer", group: "Composer" },
  { id: "thinking", keys: ["shift+tab"], label: "Thinking level", context: "composer", group: "Composer" },
  { id: "commands", keys: ["/"], label: "Commands", context: "composer", group: "Composer" },
  { id: "mention", keys: ["@"], label: "Mention file", context: "composer", group: "Composer" },
  { id: "shell-input", keys: ["!"], label: "Shell mode", context: "composer", group: "Composer" },
  { id: "cards", keys: ["tab"], label: "Cards", context: "composer", group: "Composer" },

  { id: "steer", keys: ["enter"], label: "Steer", context: "working", group: "Working" },
  { id: "queue-working", keys: ["alt+enter"], label: "Queue", context: "working", group: "Working" },
  { id: "restore-working", keys: ["alt+up"], label: "Restore queue", context: "working", group: "Working" },
  { id: "interrupt", keys: ["esc"], label: "Interrupt", context: "working", group: "Working" },

  { id: "run-shell", keys: ["enter"], label: "Run command", context: "shell", group: "Shell" },
  { id: "cancel-shell", keys: ["esc"], label: "Cancel", context: "shell", group: "Shell" },

  { id: "close-panel", keys: ["esc"], label: "Chat", context: "panel", group: "Panel" },
  { id: "focus-composer", keys: ["i"], label: "Composer", context: "panel", group: "Panel" },
  {
    id: "navigate",
    keys: ["j", "k", "h", "l", "up", "down", "left", "right"],
    display: "hjkl/arrows",
    label: "Navigate",
    context: "panel",
    group: "Panel"
  },
  { id: "expand-row", keys: ["enter", "space"], label: "Expand row", context: "panel", group: "Panel" },
  { id: "diff", keys: ["d"], label: "Diff", context: "panel", group: "Panel" },
  { id: "split", keys: ["v"], label: "Split diff", context: "panel", group: "Panel" },
  { id: "retry", keys: ["r"], label: "Resume", context: "panel", group: "Panel" },
  { id: "continue", keys: ["c"], label: "Continue", context: "panel", group: "Panel" },
  { id: "worker-model", keys: ["m"], label: "Switch model", context: "panel", group: "Panel" },
  { id: "worker-wait", keys: ["w"], label: "Wait for reset", context: "panel", group: "Panel" },
  { id: "stop", keys: ["x"], label: "Stop", context: "panel", group: "Panel" },
  { id: "steer-worker", keys: ["s"], label: "Steer", context: "panel", group: "Panel" },
  { id: "take-over", keys: ["t"], label: "Take over", context: "panel", group: "Panel" },
  { id: "approve-form", keys: ["a"], label: "Action", context: "panel", group: "Panel" },
  { id: "undo", keys: ["u"], label: "Undo", context: "panel", group: "Panel" },
  { id: "next-panel-tab", keys: ["tab"], label: "Next tab", context: "panel", group: "Tabs" },

  { id: "close-picker", keys: ["esc"], label: "Back", context: "picker", group: "Picker" },
  {
    id: "pick-move",
    keys: ["up", "down", "ctrl+p", "ctrl+n"],
    display: "up/down",
    label: "Move",
    context: "picker",
    group: "Picker"
  },
  { id: "pick-page", keys: ["pageup", "pagedown"], label: "Page", context: "picker", group: "Picker" },
  { id: "pick", keys: ["enter"], label: "Choose", context: "picker", group: "Picker" },

  { id: "close-form", keys: ["esc"], label: "Back", context: "form", group: "Form" },
  { id: "next-field", keys: ["tab", "down"], label: "Next", context: "form", group: "Form" },
  { id: "previous-field", keys: ["shift+tab", "up"], label: "Previous", context: "form", group: "Form" },
  { id: "toggle-field", keys: ["space"], label: "Toggle", context: "form", group: "Form" },
  { id: "choose-field", keys: ["left", "right"], display: "←/→", label: "Choose", context: "form", group: "Form" },
  { id: "run-form", keys: ["enter"], label: "Run", context: "form", group: "Form" },

  { id: "allow", keys: ["y"], label: "Allow", context: "approval", group: "Approval" },
  { id: "deny", keys: ["n"], label: "Deny", context: "approval", group: "Approval" },
  { id: "allow-all", keys: ["a"], label: "Allow all", context: "approval", group: "Approval" },

  {
    id: "selection-move",
    keys: ["up", "down", "left", "right", "home", "end"],
    display: "arrows/home/end",
    label: "Move",
    context: "selection",
    group: "Inspection"
  },
  {
    id: "selection-milestone",
    keys: ["[", "]", "shift+left", "shift+right"],
    display: "[/]",
    label: "Milestone",
    context: "selection",
    group: "Inspection"
  },
  { id: "selection-close", keys: ["esc", "enter"], label: "Live", context: "selection", group: "Inspection" },

  {
    id: "complete-move",
    keys: ["up", "down", "ctrl+p", "ctrl+n"],
    display: "up/down",
    label: "Move",
    context: "completion",
    group: "Completion"
  },
  { id: "complete", keys: ["tab"], label: "Complete", context: "completion", group: "Completion" },
  { id: "complete-run", keys: ["enter"], label: "Choose", context: "completion", group: "Completion" },
  { id: "complete-close", keys: ["esc"], label: "Close", context: "completion", group: "Completion" },

  { id: "open-card", keys: ["enter"], label: "Open", context: "card", group: "Cards" },
  {
    id: "card-move",
    keys: ["up", "down", "left", "right", "tab", "shift+tab"],
    display: "↑↓←→",
    label: "Card",
    context: "card",
    group: "Cards"
  },
  { id: "card-diff", keys: ["d"], label: "Diff", context: "card", group: "Cards" },
  { id: "card-undo", keys: ["u"], label: "Undo", context: "card", group: "Cards" },
  { id: "card-files", keys: ["f"], label: "Files", context: "card", group: "Cards" },
  { id: "close-card", keys: ["esc"], label: "Composer", context: "card", group: "Cards" },

  { id: "overview-pane", keys: ["tab"], label: "Pane", context: "overview", group: "Summary" },
  {
    id: "overview-move",
    keys: ["up", "down", "left", "right", "h", "j", "k", "l"],
    display: "↑↓ hjkl",
    label: "Move",
    context: "overview",
    group: "Summary"
  },
  { id: "overview-open", keys: ["enter"], label: "Open", context: "overview", group: "Summary" },
  { id: "overview-peek", keys: ["space"], label: "Peek", context: "overview", group: "Summary" },
  { id: "overview-answer", keys: ["a"], label: "Answer", context: "overview", group: "Summary" },
  { id: "overview-approve", keys: ["y"], label: "Approve", context: "overview", group: "Summary" },
  { id: "overview-deny", keys: ["n"], label: "Deny", context: "overview", group: "Summary" },
  { id: "overview-graph", keys: ["g"], label: "Graph", context: "overview", group: "Summary" },
  { id: "overview-files", keys: ["f"], label: "Files", context: "overview", group: "Summary" },
  { id: "overview-diff", keys: ["d"], label: "Diff", context: "overview", group: "Summary" },
  { id: "overview-undo", keys: ["u"], label: "Undo", context: "overview", group: "Summary" },
  { id: "overview-close", keys: ["esc"], label: "Close", context: "overview", group: "Summary" },

  { id: "review-undo", keys: ["u"], label: "Undo", context: "review", group: "Diff" },
  {
    id: "review-scroll",
    keys: ["up", "down", "j", "k"],
    display: "↑↓",
    label: "Scroll",
    context: "review",
    group: "Diff"
  },
  { id: "review-close", keys: ["esc"], label: "Back", context: "review", group: "Diff" },

  { id: "undo-files", keys: ["enter"], label: "Undo", context: "checklist", group: "Undo" },
  { id: "undo-toggle", keys: ["space"], label: "Toggle", context: "checklist", group: "Undo" },
  { id: "undo-move", keys: ["up", "down"], display: "up/down", label: "Move", context: "checklist", group: "Undo" },
  { id: "undo-back", keys: ["esc"], label: "Back", context: "checklist", group: "Undo" }
]

export interface KeyEventLike {
  readonly name: string
  readonly ctrl?: boolean
  readonly shift?: boolean
  readonly meta?: boolean
  readonly option?: boolean
}

export const normalizeName = (name: string): string =>
  name === "kpenter" || name === "return" ? "enter" : name === "escape" ? "esc" : name

/** Canonical terminal spelling, useful for tests and dispatch. */
export const token = (event: KeyEventLike): string => {
  const modifiers = [
    event.ctrl === true ? "ctrl" : undefined,
    event.meta === true || event.option === true ? "alt" : undefined,
    event.shift === true ? "shift" : undefined
  ].filter((value): value is string => value !== undefined)
  return [...modifiers, normalizeName(event.name)].join("+")
}

const tokenParts = (value: string): { readonly modifiers: ReadonlySet<string>; readonly name: string } => {
  const parts = value.split("+")
  return { modifiers: new Set(parts.slice(0, -1)), name: normalizeName(parts.at(-1) ?? "") }
}

export const matches = (event: KeyEventLike, key: string): boolean => {
  const expected = tokenParts(key)
  const actual = tokenParts(token(event))
  return actual.name === expected.name &&
    actual.modifiers.size === expected.modifiers.size &&
    [...actual.modifiers].every((modifier) => expected.modifiers.has(modifier))
}

export const bindingFor = (
  event: KeyEventLike,
  context?: KeyContext,
  list: ReadonlyArray<Binding> = registry
): Binding | undefined =>
  list.find((binding) =>
    (context === undefined || binding.context === context || binding.context === "global") &&
    binding.keys.some((key) => matches(event, key))
  )

/** The context's own keys first, then the global ones. */
export const bindingsFor = (context: KeyContext, list: ReadonlyArray<Binding> = registry): ReadonlyArray<Binding> => [
  ...list.filter((binding) => binding.context === context),
  ...(context === "global" ? [] : list.filter((binding) => binding.context === "global"))
]

/** One spelling per key: `shift+ctrl+P` and `ctrl+shift+p` are the same key. */
const canonical = (key: string): string => {
  const { modifiers, name } = tokenParts(key.toLowerCase())
  return [...["ctrl", "alt", "shift"].filter((modifier) => modifiers.has(modifier)), name].join("+")
}

/**
 * The built-in binding a contributed key would shadow. A global key fires in
 * every context, so any built-in spelling collides; a panel key collides only
 * with the view's own and the global keys.
 */
export const taken = (key: string, context: "global" | "panel"): Binding | undefined => {
  const wanted = canonical(key)
  return [...registry, ...(context === "global" ? [editing] : [])].find((binding) =>
    (context === "global" || binding.context === "global" || binding.context === "panel") &&
    binding.keys.some((each) => canonical(each) === wanted)
  )
}

/**
 * The composer's own text-editing keys (OpenTUI's textarea defaults). They are
 * not listed in `registry`, but `app.tsx` handles contributed keys before the
 * composer sees an event, so a contributed global key must never take one.
 */
const editing: Binding = {
  id: "edit-text",
  keys: [
    "ctrl+a",
    "ctrl+e",
    "ctrl+shift+a",
    "ctrl+shift+e",
    "alt+a",
    "alt+e",
    "alt+shift+a",
    "alt+shift+e",
    "ctrl+f",
    "ctrl+b",
    "ctrl+w",
    "ctrl+u",
    "ctrl+backspace",
    "ctrl+delete",
    "ctrl+shift+d",
    "ctrl+-",
    "ctrl+.",
    "alt+d",
    "alt+delete",
    "alt+f",
    "alt+b",
    "alt+left",
    "alt+right",
    "alt+shift+f",
    "alt+shift+b",
    "alt+shift+left",
    "alt+shift+right"
  ],
  label: "Edit text",
  context: "composer",
  group: "Composer"
}

const ownerName = (owner: string): string => owner.slice(owner.indexOf(":") + 1)

/** The registry plus contributed keys (`contributions.ts` already refused collisions), grouped by owner. */
export const bindings = (
  contributed: ReadonlyArray<{ readonly owner: string; readonly key: Extension.Key }>,
  summary?: Surfaces.SummaryKey
): ReadonlyArray<Binding> => [
  ...registry.map((binding) =>
    binding.id !== "summary" || summary === undefined ? binding : {
      ...binding,
      label: summary.kind === "focus" ? "Switch focus" : summary.kind === "show"
        ? summary.surface === "chat" ? "Chat" : "Back"
        : "Summary"
    }
  ),
  ...contributed.map(({ owner, key }): Binding => ({
    id: key.id,
    keys: [key.key],
    label: key.label,
    context: key.context === "panel" ? "panel" : "global",
    group: ownerName(owner),
    action: key.action,
    owner
  }))
]

export const hintsFor = (context: KeyContext, list: ReadonlyArray<Binding> = registry): ReadonlyArray<Binding> => {
  const preferred: Record<KeyContext, ReadonlyArray<string>> = {
    global: ["palette", "summary", "next-tab", "keys"],
    composer: ["palette", "summary", "next-tab", "keys"],
    working: ["interrupt", "steer", "queue-working", "keys"],
    shell: ["run-shell", "cancel-shell", "keys"],
    panel: ["navigate", "expand-row", "close-panel", "keys"],
    picker: ["pick-move", "pick", "close-picker"],
    form: ["next-field", "run-form", "close-form"],
    approval: ["allow", "deny", "allow-all"],
    selection: ["selection-move", "selection-milestone", "selection-close"],
    completion: ["complete-move", "complete", "complete-run", "complete-close"],
    card: ["card-move", "open-card", "close-card", "keys"],
    overview: [
      "overview-pane",
      "overview-move",
      "overview-peek",
      "overview-open",
      "overview-answer",
      "overview-close",
      "overview-graph"
    ],
    review: ["review-undo", "review-close"],
    checklist: ["undo-files", "undo-back"]
  }
  const available = bindingsFor(context, list)
  const builtIn = preferred[context].map((id) => available.find((binding) => binding.id === id)).filter(
    (binding): binding is Binding => binding !== undefined
  )
  const typing = context === "picker" || context === "form" || context === "approval" || context === "completion" ||
    context === "review" || context === "checklist"
  // Every contributed key, after the built-in ones; `fit` drops what the footer has no room for.
  const contributed = typing ? [] : available.filter((binding) => binding.owner !== undefined)
  return [...builtIn, ...contributed]
}

/** A footer hint's columns: `key label`. */
export const hintWidth = (binding: Binding, measure: (text: string) => number = (text) => text.length): number =>
  measure(primaryKey(binding)) + 1 + measure(binding.label)

/**
 * The hints that fit `columns` whole, in priority order, two columns apart.
 * None is ever clipped. When one is left out, `?` stays, last, because the
 * popup it opens lists every key.
 */
export const fit = (
  hints: ReadonlyArray<Binding>,
  columns: number,
  measure?: (text: string) => number
): ReadonlyArray<Binding> => {
  const cost = (list: ReadonlyArray<Binding>) =>
    list.reduce((total, binding, index) => total + (index === 0 ? 0 : 2) + hintWidth(binding, measure), 0)
  if (cost(hints) <= columns) return hints
  const popup = hints.find((binding) => binding.id === "keys")
  const rest = hints.filter((binding) => binding !== popup)
  const reserved = popup === undefined ? 0 : hintWidth(popup, measure) + 2
  const kept: Array<Binding> = []
  for (const binding of rest) {
    if (cost([...kept, binding]) + reserved > columns) break
    kept.push(binding)
  }
  return popup === undefined || cost([...kept, popup]) > columns ? kept : [...kept, popup]
}

/** Footer hints for a form: the focused field's own key sits between Next and Run. */
export const formHints = (field: "text" | "textarea" | "number" | "boolean" | "select" | "write-only" | undefined) => {
  const byId = (id: string) => registry.find((binding) => binding.id === id)!
  const own = field === "select" ? [byId("choose-field")] : field === "boolean" ? [byId("toggle-field")] : []
  const [next, ...rest] = hintsFor("form")
  return [next!, ...own, ...rest]
}

/** Footer hints for `/flows`: Enter runs the selection, unless it runs only after a restart. */
export const catalogHints = (runnable: boolean): ReadonlyArray<Binding> => {
  const byId = (id: string) => registry.find((binding) => binding.id === id)!
  return [
    ...(runnable ? [{ ...byId("pick"), label: "Run" }] : []),
    { ...byId("close-picker"), label: "Back" }
  ]
}

/**
 * Footer hints for a focused panel: the keys this panel acts on first, then
 * the panel basics. `action` relabels `a` with the selected row's action.
 */
export const panelHints = (
  panel: {
    readonly retry?: boolean
    readonly continue?: boolean
    readonly stop?: boolean
    readonly diff?: boolean
    readonly undo?: boolean
    readonly action?: string
  }
): ReadonlyArray<Binding> => {
  const byId = (id: string) => registry.find((binding) => binding.id === id)!
  return [
    ...(panel.retry === true ? [byId("retry")] : []),
    ...(panel.continue === true ? [byId("continue")] : []),
    ...(panel.stop === true ? [byId("stop")] : []),
    ...(panel.diff === true ? [byId("diff")] : []),
    ...(panel.undo === true ? [byId("undo")] : []),
    ...(panel.action === undefined ? [] : [{ ...byId("approve-form"), label: panel.action }]),
    byId("close-panel"),
    ...hintsFor("panel").filter((binding) => binding.id !== "close-panel")
  ]
}

export const displayKeys = (binding: Binding): string =>
  binding.display ?? binding.keys.filter((key) => key !== "linefeed").join("/")

/** The footer shows only the first spelling. */
export const primaryKey = (binding: Binding): string => binding.display ?? binding.keys[0]!

/** Every binding by group, for the `?` popup. */
export const groups = (
  bindings: ReadonlyArray<Binding> = registry
): ReadonlyArray<{ readonly group: string; readonly bindings: ReadonlyArray<Binding> }> =>
  [...new Set(bindings.map((binding) => binding.group))].map((group) => ({
    group,
    bindings: bindings.filter((binding) => binding.group === group)
  }))

/** Registry completeness invariant used by tests and development assertions. */
export const duplicateKeys = (): ReadonlyArray<string> => {
  const seen = new Set<string>()
  const duplicates = new Set<string>()
  for (const binding of registry) {
    for (const key of binding.keys) {
      const scoped = `${binding.context}:${key}`
      if (seen.has(scoped)) duplicates.add(scoped)
      seen.add(scoped)
    }
  }
  return [...duplicates]
}
