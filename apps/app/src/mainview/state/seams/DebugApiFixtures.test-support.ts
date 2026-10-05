import type { DebugApiCard } from "@smthrs/rpc/DebugApiCard"
import type { OpenApiDocument } from "./DebugApiSeam"
/** Literal API fixtures from T-APP-21; they are seam inputs, never a runtime API manifest. */
export const apiFixture: OpenApiDocument = { paths: {
  "/api/stack": { get: { operationId: "getStack", summary: "Stack", tags: ["Stack"], responses: { "200": { type: "object" } } } },
  "/api/secrets": { put: { operationId: "putSecrets", summary: "Secrets", tags: ["Secrets"], requestBody: { required: true, content: { "application/json": { schema: { type: "object" } } } } } },
  "/api/files/{path}": { get: { operationId: "readFile", parameters: [{ in: "path", name: "path", required: true }, { in: "query", name: "line", schema: { type: "integer" } }] } },
  "/api/admin/grant": { post: { operationId: "grantCredits", "x-composition": "plue" } },
  "/api/admin/system/health": { get: { operationId: "adminHealth" } },
  "/api/future": { "x-composition": "cloud", get: { operationId: "otherComposition" } },
  "/api/stack/other": { get: { operationId: "otherOperationComposition", "x-composition": "cloud" } },
  "/api/auth/sse-ticket": { post: { operationId: "post_api_auth_sse_ticket", summary: "POST /api/auth/sse-ticket", tags: ["Authentication"],
    responses: { "200": { content: { "application/json": { schema: { $ref: "#/components/schemas/MultiSSETicketResponse" } } } } } } },
  "https://elsewhere.test/api/stack": { get: { operationId: "offOrigin" } }
}, components: { schemas: { MultiSSETicketResponse: { type: "object", required: ["ticket"], properties: { ticket: { type: "string" } } } } } }
export const expectedOperations: DebugApiCard["operations"] = [
  { id: "getStack", method: "GET", path: "/api/stack", summary: "Stack", group: "Stack" },
  { id: "putSecrets", method: "PUT", path: "/api/secrets", summary: "Secrets", group: "Secrets" },
  { id: "readFile", method: "GET", path: "/api/files/{path}", summary: "", group: "API" },
  { id: "post_api_auth_sse_ticket", method: "POST", path: "/api/auth/sse-ticket", summary: "POST /api/auth/sse-ticket", group: "Authentication" }
]
