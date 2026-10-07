// Regenerates src/debugApi/install-operations.fixture.json, the committed literal inventory C-UI-10 reviews
// (T-APP-21). Run after adding, removing or renaming an install API operation, then review the diff:
//   bun scripts/debug-api-inventory.ts
import { readFileSync, writeFileSync } from "node:fs"
import { parse } from "yaml"
import { createDebugApiSeam, installOperations } from "../src/mainview/state/seams/DebugApiSeam"
import type { OpenApiDocument } from "../src/mainview/state/seams/DebugApiSeam"

const root = new URL("../../../", import.meta.url)
const document = parse(readFileSync(new URL("docs/api/openapi.yaml", root), "utf8")) as OpenApiDocument
const rows = installOperations(document).map(({ id, method, path }) => "  " + JSON.stringify({ id, method, path }))
writeFileSync(new URL("apps/app/src/debugApi/install-operations.fixture.json", root), "[\n" + rows.join(",\n") + "\n]\n")
console.log(`${rows.length} install operations written`)

// Test expectations are read only from the committed literal, never regenerated
// while a check runs. Review this output when the release schema changes.
const seam = createDebugApiSeam({ document: async () => document,
  gates: () => ({ view: true, catalog: true, authorizer: true }), origin: "http://localhost",
  fetch: async () => { throw Error("Inventory must not send a request") } })
try {
  await seam.open()
  const forms = seam.get().model.operations.map(operation => {
    seam.select(operation.id)
    return "  " + JSON.stringify({ id: operation.id, fields: seam.get().fields })
  })
  writeFileSync(new URL("apps/app/src/debugApi/install-fields.fixture.json", root), "[\n" + forms.join(",\n") + "\n]\n")
} finally { seam.dispose() }
