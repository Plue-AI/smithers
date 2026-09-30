import { expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import type { Card } from "../state/AppState"
import { SecretsCardBody } from "./SecretsCard"

const card: Extract<Card, { kind: "secrets" }> = {
  id: "secrets", kind: "secrets", title: "Secrets", status: "active", createdAt: 0, ordinal: 0,
  payload: { repo: "ada/repo", scope: "repository", secrets: [
    { name: "OPEN", mainOnly: false, hosts: [], matchHeaders: [], updatedAt: null },
    { name: "PINNED", mainOnly: true, hosts: ["a.example.com", "b.example.com"], matchHeaders: ["authorization"], updatedAt: null }
  ] }
}
const html = renderToStaticMarkup(SecretsCardBody({ card, onRunCommand: () => undefined }))

test("each row shows its main-only flag and bound host count", () => {
  expect(html).toContain('<tr data-testid="secret-OPEN"><td class="world-card-title">OPEN</td><td>no</td><td>0</td>')
  expect(html).toContain('<tr data-testid="secret-PINNED"><td class="world-card-title">PINNED</td><td>yes</td><td>2</td>')
  expect(html).not.toContain("every session")
})

test("Add secret, and each row's Main only / Every run, Bind, Rotate and Delete address that secret", () => {
  expect(html).toContain("Add secret")
  expect(html).toContain('aria-label="Limit to main OPEN" data-flow="secrets.scope" data-flow-args="OPEN main-only ada/repo"')
  expect(html).toContain('aria-label="Give to every run PINNED" data-flow="secrets.scope" data-flow-args="PINNED all ada/repo"')
  expect(html).toContain('aria-label="Bind OPEN" data-flow="secrets.bind" data-flow-args="{&quot;name&quot;:&quot;OPEN&quot;,&quot;repo&quot;:&quot;ada/repo&quot;}"')
  expect(html).toContain('aria-label="Rotate OPEN" data-flow="secrets.set" data-flow-args="{&quot;name&quot;:&quot;OPEN&quot;,&quot;repo&quot;:&quot;ada/repo&quot;}"')
  expect(html).toContain('aria-label="Delete PINNED" data-flow="secrets.delete" data-flow-args="PINNED ada/repo"')
  expect(html.match(/>Bind</g)).toHaveLength(2)
  expect(html).not.toContain('type="password"')
})

test("no secrets shows only the add button", () => {
  const empty = renderToStaticMarkup(SecretsCardBody({ card: { ...card, payload: { ...card.payload, secrets: [] } }, onRunCommand: () => undefined }))
  expect(empty).toContain("Add secret")
  expect(empty).not.toContain("<table")
})
