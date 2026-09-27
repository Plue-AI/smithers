import { expect, test } from "bun:test"
import { isValidElement, type ReactNode } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import type { Card } from "../state/AppState"
import { EnvCardBody } from "./EnvCard"

const card: Extract<Card, { kind: "env" }> = { id: "env", kind: "env", title: "Environment", status: "active", createdAt: 0, ordinal: 0,
  payload: { repo: "ada/repo", vars: [], setupScript: null } }

test("environment actions open the form and the card's repository secrets", () => {
  const calls: [string, string | undefined][] = []
  const body = EnvCardBody({ card, onRunCommand: (name, args) => { calls.push([name, args]) } })
  const click = (node: ReactNode): void => {
    if (Array.isArray(node)) { node.forEach(click); return }
    if (!isValidElement<{ children?: ReactNode; onClick?: () => void; "data-flow"?: string }>(node)) return
    if (node.props["data-flow"]) node.props.onClick?.()
    click(node.props.children)
  }
  click(body)
  expect(calls).toEqual([["env.set", undefined], ["secrets.list", "ada/repo"]])
  const html = renderToStaticMarkup(body)
  expect(html).toContain("Add variable")
  expect(html).not.toContain("/env.set")
  expect(html).not.toContain("/secrets.list")
})

test("a refused subscription token offers its removal", () => {
  const calls: [string, string | undefined][] = []
  const refused = { ...card, payload: { ...card.payload, reconnect: true } }
  const body = EnvCardBody({ card: refused, onRunCommand: (name, args) => { calls.push([name, args]) } })
  expect(renderToStaticMarkup(body)).toContain("Remove token")
  expect(renderToStaticMarkup(EnvCardBody({ card, onRunCommand: () => undefined }))).not.toContain("Remove token")
  const click = (node: ReactNode): void => {
    if (Array.isArray(node)) { node.forEach(click); return }
    if (!isValidElement<{ children?: ReactNode; onClick?: () => void; "data-flow"?: string }>(node)) return
    if (node.props["data-flow"]) node.props.onClick?.()
    click(node.props.children)
  }
  click(body)
  expect(calls[0]).toEqual(["env.remove-token", "ada/repo"])
})
