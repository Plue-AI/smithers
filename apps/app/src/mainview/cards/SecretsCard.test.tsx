import { secretInput } from "../flows/SecretPayload"
import { expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import type { Card } from "../state/AppState"
import type { SecretsViewProps } from "@smthrs/rpc/SecretsCard"
import { SecretsCardBody } from "./SecretsCard"

const card: Extract<Card, { kind: "secrets" }> = {
  id: "secrets", kind: "secrets", title: "Secrets", status: "active", createdAt: 0, ordinal: 0,
  payload: { repo: "ada/repo", scope: "repository", secrets: [
    { name: "OPEN", mainOnly: false, hosts: [], matchHeaders: [], updatedAt: null },
    { name: "PINNED", mainOnly: true, hosts: ["a.example.com"], matchHeaders: ["authorization"], updatedAt: null }
  ] }
}
for (const role of ["owner", "maintainer", "member"] as const) test(`${role} sees the mounted View with scoped actions`, () => {
  const html = renderToStaticMarkup(<SecretsCardBody card={card} role={role} dispatch={() => {}} />)
  expect(html).toContain('data-kind="secrets"')
  expect(html).toContain("all branches"); expect(html).toContain("main only"); expect(html).toContain("a.example.com")
  expect(html).not.toContain("Bind"); expect(html).not.toContain("Rotate"); expect(html).not.toContain("<table")
  expect(html.includes('type="password"')).toBe(role !== "member")
  expect(html.includes('data-flow="secrets"')).toBe(role !== "member")
  expect(html).not.toContain("data-flow-args")
})
test("row commands share bindings; cancelled Delete and widening write nothing", () => {
  let props!: SecretsViewProps
  const calls: unknown[] = []
  let accept = false
  renderToStaticMarkup(<SecretsCardBody card={card} role="owner" confirm={() => accept} dispatch={(tag, input) => calls.push({ tag, input })}
    View={value => { props = value; return null }} />)
  props.onAction("secrets", secretInput("delete", { name: "OPEN" }))
  props.onAction("secrets", secretInput("scope", { name: "PINNED" }))
  expect(calls).toEqual([])
  accept = true
  props.onAction("secrets", secretInput("delete", { name: "OPEN" }))
  props.onAction("secrets", secretInput("scope", { name: "PINNED" }))
  props.onAction("secrets", secretInput("set", { name: "PINNED", value: "private" }))
  expect(calls).toEqual([{ tag: "secrets", input: { operation: "delete", name: "OPEN" } },
    { tag: "secrets", input: { operation: "scope", name: "PINNED", scope: "all_branches" } },
    { tag: "secrets", input: { operation: "set", name: "PINNED", value: "private" } }])
  expect(JSON.stringify(props)).not.toContain("private")
  expect(JSON.stringify(card)).not.toContain("private")
})
test("member callbacks have no write authority", () => {
  let props!: SecretsViewProps; const calls: unknown[] = []
  renderToStaticMarkup(<SecretsCardBody card={card} dispatch={(tag, input) => calls.push({ tag, input })} View={value => { props = value; return null }} />)
  props.onAction("secrets", secretInput("delete", { name: "OPEN" })); expect(calls).toEqual([])
  expect(props.actions).toEqual([]); expect(props.model.secrets[0]?.actions).toEqual([])
})

test("Secrets card action copy uses product words", async () => {
  const { lintText } = await import("./productWords")
  let props!: SecretsViewProps
  renderToStaticMarkup(<SecretsCardBody card={card} role="owner" dispatch={() => {}} View={value => { props = value; return null }} />)
  const actions = [...props.actions, ...props.model.secrets.flatMap(secret => secret.actions)]
  expect(actions.map(action => action.label)).toEqual(["Add", "Replace", "main only", "Delete", "Replace", "all branches", "Delete"])
  for (const action of actions) {
    expect(lintText(action.label)).toEqual([])
    if (action.disabled) expect(lintText(action.disabled.reason)).toEqual([])
  }
})

test("a declared file path shows on its row and travels with Add and Replace", () => {
  const filed: typeof card = { ...card, payload: { ...card.payload, secrets: [
    { name: "ANTHROPIC_API_KEY", mainOnly: false, hosts: ["api.anthropic.com"], matchHeaders: ["x-api-key"], updatedAt: null, path: "~/.config/anthropic/key" },
    { name: "OPEN", mainOnly: false, hosts: [], matchHeaders: [], updatedAt: null }
  ] } }
  expect(renderToStaticMarkup(<SecretsCardBody card={filed} role="maintainer" dispatch={() => {}} />)).toContain("~/.config/anthropic/key")
  let props!: SecretsViewProps
  const calls: unknown[] = []
  renderToStaticMarkup(<SecretsCardBody card={filed} role="maintainer" dispatch={(tag, input) => calls.push({ tag, input })} View={value => { props = value; return null }} />)
  expect(props.model.secrets[0]?.path).toBe("~/.config/anthropic/key")
  const replace = props.model.secrets[0]!.actions.find(action => action.label === "Replace")!
  expect(replace.input?.find(field => field.name === "path")?.value).toBe("~/.config/anthropic/key")
  props.onAction("secrets", secretInput("set", { door: "add", name: "NPM_TOKEN", value: "v", scope: "all_branches", hosts: "", path: "~/.npmrc" }))
  props.onAction("secrets", secretInput("set", { name: "ANTHROPIC_API_KEY", value: "v", hosts: "", path: "" }))
  props.onAction("secrets", secretInput("set", { name: "OPEN", value: "v", hosts: "", path: "" }))
  expect(calls).toEqual([
    { tag: "secrets", input: { operation: "set", name: "NPM_TOKEN", value: "v", scope: "all_branches", hosts: "", path: "~/.npmrc" } },
    { tag: "secrets", input: { operation: "set", name: "ANTHROPIC_API_KEY", value: "v", path: "" } },
    { tag: "secrets", input: { operation: "set", name: "OPEN", value: "v" } }
  ])
})

test("a known model key defaults to its provider host and header", async () => {
  const { secretsBinding } = await import("./SecretsCard")
  expect(secretsBinding("secrets", secretInput("set", { name: "ANTHROPIC_API_KEY" }))).toEqual({ hosts: "api.anthropic.com", headers: "x-api-key" })
  expect(secretsBinding("secrets", secretInput("set", { name: "OPENAI_API_KEY", hosts: "" }))).toEqual({ hosts: "api.openai.com", headers: "authorization" })
  expect(secretsBinding("secrets", secretInput("set", { name: "ANTHROPIC_API_KEY", hosts: "proxy.example.com" }))).toEqual({ hosts: "proxy.example.com", headers: "x-api-key" })
  expect(secretsBinding("secrets", secretInput("set", { name: "NPM_TOKEN", hosts: "registry.npmjs.org" }))).toEqual({ hosts: "registry.npmjs.org", headers: "authorization" })
  expect(secretsBinding("secrets", secretInput("set", { name: "NPM_TOKEN" }))).toEqual({})
  expect(secretsBinding("secrets", secretInput("delete", { name: "ANTHROPIC_API_KEY" }))).toEqual({})
})
