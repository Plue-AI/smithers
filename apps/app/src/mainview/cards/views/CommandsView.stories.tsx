import type { Action } from "@smthrs/rpc/CardAction"
import { fixtures } from "@smthrs/rpc/fixtures/Commands"
import { CommandsView } from "./CommandsView"
import { appendixCases } from "./CommandsCases"
import { fixtureStories, type ViewStory } from "./stories"

const suppliedActions: readonly Action[] = [{ tag: "help", label: "Open", args: { source: "fixture" } }, { tag: "help", label: "Retry", disabled: { reason: "Unavailable" } }]

const formActions: readonly Action[] = [{ tag: "search", label: "Search", args: { query: "needle", scope: "code", token: "", notes: "" }, input: [
  { name: "query", label: "Query", kind: "text", required: true },
  { name: "scope", label: "Scope", kind: "choice", choices: ["code", "wiki"], required: true },
  { name: "token", label: "Token", kind: "secret", required: false },
  { name: "notes", label: "Notes", kind: "text", multiline: true, required: false },
] }]

export const stories: ViewStory[] = [
  ...fixtureStories(fixtures, (fixture, callbacks) => <CommandsView {...fixture} {...callbacks} />),
  { name: "Appendix A", expect: ["Ask", "Switch light or dark"], render: callbacks => <CommandsView gestures={{}} view={{ maximized: false }} model={appendixCases} actions={[]} {...callbacks} /> },
  { name: "Empty", expect: [], render: callbacks => <CommandsView gestures={{}} view={{ maximized: false }} model={{ groups: [] }} actions={[]} {...callbacks} /> },
  { name: "Empty group", expect: ["Ask"], render: callbacks => <CommandsView gestures={{}} view={{ maximized: false }} model={{ groups: [{ label: "Ask", advanced: false, commands: [] }] }} actions={[]} {...callbacks} /> },
  { name: "Inert text", expect: ["<script>alert(1)</script>"], render: callbacks => <CommandsView gestures={{}} view={{ maximized: false }} model={{ groups: [{ label: "Ask", advanced: false, commands: [{ tag: "help", synopsis: "<script>alert(1)</script>", description: "<img src=x onerror=alert(1)>", agent: "never" }] }] }} actions={[]} {...callbacks} /> },
  { name: "Supplied action", expect: ["Open", "Unavailable"], actions: suppliedActions, interactions: [{ selector: "button", action: { tag: "help", args: { source: "fixture" } } }], render: (callbacks, actions = suppliedActions) => <CommandsView gestures={{}} view={{ maximized: false }} model={{ groups: [] }} actions={actions as readonly Action[]} {...callbacks} /> },
  { name: "Action input", expect: ["Query", "Scope", "Token", "Notes"], actions: formActions, interactions: [
    { selector: '[name="query"]', event: "input", value: "needle" },
    { selector: '[name="scope"]', event: "change", value: "code" },
    { selector: '[name="token"]', event: "input", value: "" },
    { selector: '[name="notes"]', event: "input", value: "" },
  ], render: (callbacks, actions = formActions) => <CommandsView gestures={{}} view={{ maximized: false }} model={{ groups: [] }} actions={actions as readonly Action[]} {...callbacks} /> },

]
