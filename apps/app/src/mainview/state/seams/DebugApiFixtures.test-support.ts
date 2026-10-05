import type { DebugApiCard } from "@smthrs/rpc/DebugApiCard"
import type { OpenApiDocument } from "./DebugApiSeam"
/** Literal API fixtures from T-APP-21; they are seam inputs, never a runtime API manifest. */
export const apiFixture: OpenApiDocument = { paths: {
  "/api/stack": { get: { operationId: "getStack", summary: "Stack", tags: ["Stack"], responses: { "200": { type: "object" } } } },
  "/api/secrets": { put: { operationId: "putSecrets", summary: "Secrets", tags: ["Secrets"], requestBody: { required: true, content: { "application/json": { schema: { type: "object" } } } } } },
  "/api/files/{path}": { get: { operationId: "readFile", parameters: [{ in: "path", name: "path", required: true }, { in: "query", name: "line", schema: { type: "integer" } }] } },
  "/api/admin/grant": { post: { operationId: "grantCredits", "x-composition": "plue" } },
  "https://elsewhere.test/api/stack": { get: { operationId: "offOrigin" } }
} }
export const expectedOperations: DebugApiCard["operations"] = [
  { id: "getStack", method: "GET", path: "/api/stack", summary: "Stack", group: "Stack" },
  { id: "putSecrets", method: "PUT", path: "/api/secrets", summary: "Secrets", group: "Secrets" },
  { id: "readFile", method: "GET", path: "/api/files/{path}", summary: "", group: "API" }
]
