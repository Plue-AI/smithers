import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { parse } from "yaml"
import { createDebugApiSeam, installOperations } from "../mainview/state/seams/DebugApiSeam"
import type { OpenApiDocument } from "../mainview/state/seams/DebugApiSeam"
import expected from "./install-operations.fixture.json"

const document = parse(readFileSync(new URL("../../../../docs/api/openapi.yaml", import.meta.url), "utf8")) as OpenApiDocument

test("release OpenAPI install composition matches the committed literal operation inventory", () => {
  const actual: { id: string; method: string; path: string }[] = installOperations(document).map(({ id, method, path }) => ({ id, method, path }))
  expect(actual).toEqual(expected)
  expect(installOperations(document).map(operation => operation.id)).not.toContain("post_api_admin_grant")
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
