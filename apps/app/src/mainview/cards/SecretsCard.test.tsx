import { expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import type { Card } from "../state/AppState"
import { SecretsCardBody } from "./SecretsCard"

const card = (reconnect: boolean): Extract<Card, { kind: "secrets" }> => ({
  id: "secrets", kind: "secrets", title: "Secrets", status: "active", createdAt: 0, ordinal: 0,
  payload: { repo: "ada/repo", scope: "repository", secrets: [
    { name: "OK", hosts: [], matchHeaders: [], updatedAt: null },
    { name: "CLAUDE", hosts: [], matchHeaders: [], updatedAt: null, ...(reconnect ? { reconnect: true } : {}) }
  ] }
})

test("a secret holding a refused subscription token offers its removal", () => {
  const html = renderToStaticMarkup(SecretsCardBody({ card: card(true), onRunCommand: () => undefined }))
  expect(html.match(/Remove token/g)).toHaveLength(1)
  expect(html).toContain("env.remove-token")
  expect(renderToStaticMarkup(SecretsCardBody({ card: card(false), onRunCommand: () => undefined }))).not.toContain("Remove token")
})
