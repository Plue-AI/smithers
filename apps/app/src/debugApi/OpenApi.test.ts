import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { parse } from "yaml"
import { CREDENTIAL_OPERATIONS, createDebugApiSeam, installOperations } from "../mainview/state/seams/DebugApiSeam"
import type { OpenApiDocument } from "../mainview/state/seams/DebugApiSeam"
import expected from "./install-operations.fixture.json"

const document = parse(readFileSync(new URL("../../../../docs/api/openapi.yaml", import.meta.url), "utf8")) as OpenApiDocument

test("release OpenAPI install composition matches the committed literal operation inventory", () => {
  const actual: { id: string; method: string; path: string }[] = installOperations(document).map(({ id, method, path }) => ({ id, method, path }))
  expect(actual).toEqual(expected)
  expect(installOperations(document).map(operation => operation.id)).not.toContain("post_api_admin_grant")
  expect(actual.filter(operation => /^\/api\/admin(?:\/|$)/.test(operation.path))).toEqual([])
})
test("every pinned credential operation is a release install operation", () => {
  const ids = installOperations(document).map(operation => operation.id)
  expect([...CREDENTIAL_OPERATIONS].filter(id => !ids.includes(id))).toEqual([])
})
for (const id of ["post_api_auth_sse_ticket", "post_api_v1_sse_ticket"]) test(`release ${id} ticket never renders in the response pane`, async () => {
  const ticket = `${"5e".repeat(32)}.eyJzZXNzaW9uX2hhc2giOiJhYmMifQ`
  const seam = createDebugApiSeam({ document: async () => document, gates: () => ({ view: true, catalog: true, authorizer: true }),
    origin: "http://mini.local", fetch: async () => Response.json({ ticket, expires_at: "2026-10-05T12:00:00Z" }) })
  await seam.open(id)
  await seam.send({ operationId: id })
  await seam.send({ operationId: id, intent: "confirm", confirmation: seam.get().confirmation })
  expect(seam.get().model.exchange?.response?.status).toBe(200)
  expect(JSON.stringify(seam.get())).not.toContain("5e5e5e")
  seam.dispose()
})
test("release install request form comes from the document and Send remains dark by default", async () => {
  const seam = createDebugApiSeam({ document: async () => document, gates: () => ({ view: true, catalog: true, authorizer: true }),
    origin: "http://mini.local", fetch: async () => { throw Error("No request on open") } })
  await seam.open("get_api_install")
  expect(seam.get().fields).toEqual([])
  seam.select("put_api_install")
  expect(seam.get().fields).toEqual([{ name: "body", label: "JSON", kind: "text", multiline: true, required: true }])
  seam.dispose()
})
