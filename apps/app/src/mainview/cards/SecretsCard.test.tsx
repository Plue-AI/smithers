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
  expect(html.includes('data-flow="secrets.delete"')).toBe(role !== "member")
  expect(html).not.toContain("data-flow-args")
})
test("row commands share bindings; cancelled Delete and widening write nothing", () => {
  let props!: SecretsViewProps
  const calls: unknown[] = []
  let accept = false
  renderToStaticMarkup(<SecretsCardBody card={card} role="owner" confirm={() => accept} dispatch={(tag, input) => calls.push({ tag, input })}
    View={value => { props = value; return null }} />)
  props.onAction("secrets.delete", { name: "OPEN" })
  props.onAction("secrets.scope", { name: "PINNED" })
  expect(calls).toEqual([])
  accept = true
  props.onAction("secrets.delete", { name: "OPEN" })
  props.onAction("secrets.scope", { name: "PINNED" })
  props.onAction("secrets.set", { name: "PINNED", value: "private" })
  expect(calls).toEqual([{ tag: "secrets.delete", input: { name: "OPEN" } },
    { tag: "secrets.scope", input: { name: "PINNED", scope: "all_branches" } },
    { tag: "secrets.set", input: { name: "PINNED", value: "private" } }])
  expect(JSON.stringify(props)).not.toContain("private")
  expect(JSON.stringify(card)).not.toContain("private")
})
test("member callbacks have no write authority", () => {
  let props!: SecretsViewProps; const calls: unknown[] = []
  renderToStaticMarkup(<SecretsCardBody card={card} dispatch={(tag, input) => calls.push({ tag, input })} View={value => { props = value; return null }} />)
  props.onAction("secrets.delete", { name: "OPEN" }); expect(calls).toEqual([])
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
