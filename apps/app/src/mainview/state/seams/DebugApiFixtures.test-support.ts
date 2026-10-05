import type { DebugApiCard } from "@smthrs/rpc/DebugApiCard"
import type { OpenApiDocument } from "./DebugApiSeam"
/** Literal API fixtures from T-APP-21; they are seam inputs, never a runtime API manifest. */
export const apiFixture: OpenApiDocument = { paths: {
  "/api/stack": { get: { operationId: "getStack", summary: "Stack", tags: ["Stack"], responses: { "200": { type: "object" } } } },
  "/api/secrets": { put: { operationId: "putSecrets", summary: "Secrets", tags: ["Secrets"], requestBody: { required: true, content: { "application/json": { schema: { type: "object" } } } } } },
  "/api/files/{path}": { get: { operationId: "readFile", parameters: [{ in: "path", name: "path", required: true }, { in: "query", name: "line", schema: { type: "integer" } }] },
    delete: { operationId: "deleteFile", parameters: [{ in: "path", name: "path", required: true }, { in: "query", name: "line", schema: { type: "integer" } }] } },
  "/api/runs/{run}": { get: { operationId: "getRun", parameters: [{ in: "path", name: "run", required: true, schema: { type: "string", format: "uuid" } }],
    responses: { "200": { content: { "application/json": { schema: { $ref: "#/components/schemas/Run" } } } } } } },
  "/api/admin/grant": { post: { operationId: "grantCredits", "x-composition": "plue" } },
  "/api/admin/system/health": { get: { operationId: "adminHealth" } },
  "/api/future": { "x-composition": "cloud", get: { operationId: "otherComposition" } },
  "/api/stack/other": { get: { operationId: "otherOperationComposition", "x-composition": "cloud" } },
  "/api/auth/sse-ticket": { post: { operationId: "post_api_auth_sse_ticket", summary: "POST /api/auth/sse-ticket", tags: ["Authentication"],
    responses: { "200": { content: { "application/json": { schema: { $ref: "#/components/schemas/MultiSSETicketResponse" } } } } } } },
  "/api/oauth2/token": { post: { operationId: "post_api_oauth2_token", summary: "POST /api/oauth2/token", tags: ["OAuth2"],
    parameters: [{ in: "query", name: "state" }], requestBody: { content: { "application/json": { schema: { type: "object" } } } } } },
  "https://elsewhere.test/api/stack": { get: { operationId: "offOrigin" } }
}, components: { schemas: {
  Run: { type: "object", properties: { phase: { type: "string", enum: ["queued", "done"] }, run: { type: "string", format: "uuid" },
    when: { type: "string", format: "date-time" }, link: { type: "string", format: "uri" }, note: { type: "string" },
    steps: { type: "array", items: { type: "object", properties: { phase: { type: "string", enum: ["queued", "done"] } } } } } },
  MultiSSETicketResponse: { type: "object", required: ["ticket"], properties: { ticket: { type: "string" } } } } } }
export const expectedOperations: DebugApiCard["operations"] = [
  { id: "getStack", method: "GET", path: "/api/stack", summary: "Stack", group: "Stack" },
  { id: "putSecrets", method: "PUT", path: "/api/secrets", summary: "Secrets", group: "Secrets" },
  { id: "readFile", method: "GET", path: "/api/files/{path}", summary: "", group: "API" },
  { id: "deleteFile", method: "DELETE", path: "/api/files/{path}", summary: "", group: "API" },
  { id: "getRun", method: "GET", path: "/api/runs/{run}", summary: "", group: "API" },
  { id: "post_api_auth_sse_ticket", method: "POST", path: "/api/auth/sse-ticket", summary: "POST /api/auth/sse-ticket", group: "Authentication" },
  { id: "post_api_oauth2_token", method: "POST", path: "/api/oauth2/token", summary: "POST /api/oauth2/token", group: "OAuth2" }
]
