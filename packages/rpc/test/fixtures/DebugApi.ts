import type { Action } from "../../src/CardAction.ts"
import type { DebugApiCard, DebugApiView } from "../../src/DebugApiCard.ts"
import { type Story, story } from "./_story.ts"

const operations: DebugApiCard["operations"] = [
  { id: "getHealth", method: "GET", path: "/api/health", summary: "Read install health", group: "Install" },
  { id: "getTodo", method: "GET", path: "/api/todos/{n}", summary: "Read a TODO", group: "TODOs" },
  { id: "dropTodo", method: "POST", path: "/api/todos/{n}/drop", summary: "Drop a TODO", group: "TODOs" },
  { id: "headTodo", method: "HEAD", path: "/api/todos/{n}", summary: "Check a TODO exists", group: "TODOs" },
  { id: "putSecret", method: "PUT", path: "/api/secrets/{name}", summary: "Set a secret", group: "Secrets" },
  { id: "patchSettings", method: "PATCH", path: "/api/settings", summary: "Change settings", group: "Settings" },
  { id: "deleteSecret", method: "DELETE", path: "/api/secrets/{name}", summary: "Delete a secret", group: "Secrets" }
]
const send = (operation: string, input: Action["input"]): Action => ({
  tag: "debug-api",
  label: "Send",
  args: { operation },
  primary: true,
  input
})
const n = [{ name: "n", label: "n", kind: "text" as const, required: true }]
const request = {
  method: "GET",
  url: "http://mac-mini.local:8080/api/todos/12",
  headers: [["accept", "application/json"]] as [string, string][]
}
type DebugApiStory = Story<DebugApiCard, DebugApiView>
export const fixtures = {
  operations: story<DebugApiCard, DebugApiView>("Every documented operation", { operations }, {
    expect: ["Read install health", "/api/todos/{n}/drop", "Delete a secret"]
  }),
  get_200: story<DebugApiCard, DebugApiView>(
    "A selected GET with its response",
    {
      operations,
      selected: "getTodo",
      exchange: {
        request,
        response: {
          status: 200,
          headers: [["content-type", "application/json"]],
          body: "{\"n\":12,\"state\":\"working\"}",
          duration_ms: 18
        }
      }
    },
    {
      actions: [send("getTodo", n)],
      view: { maximized: false, selected: "getTodo" },
      expect: ["Read a TODO", "http://mac-mini.local:8080/api/todos/12", "{\"n\":12,\"state\":\"working\"}"]
    }
  ),
  pending_mutation: story<DebugApiCard, DebugApiView>(
    "A mutation waiting for its confirmation",
    { operations, selected: "dropTodo", pending: { method: "POST", path: "/api/todos/12/drop" } },
    {
      actions: [{
        tag: "debug-api",
        label: "Confirm POST /api/todos/12/drop",
        args: { operation: "dropTodo", confirm: "true" },
        primary: true
      }],
      view: { maximized: false, selected: "dropTodo" },
      expect: ["/api/todos/12/drop"]
    }
  ),
  patch_body: story<DebugApiCard, DebugApiView>("A JSON body as a multiline field", {
    operations,
    selected: "patchSettings"
  }, {
    actions: [send("patchSettings", [{ name: "body", label: "Body", kind: "text", required: true, multiline: true }])],
    view: { maximized: false, selected: "patchSettings" },
    expect: ["Change settings"]
  }),
  request_only: story<DebugApiCard, DebugApiView>("A request awaiting its response", {
    operations, selected: "getTodo", exchange: { request }
  }, { expect: ["http://mac-mini.local:8080/api/todos/12"] }),
  network_failure: story<DebugApiCard, DebugApiView>("A failure without an HTTP status", {
    operations, exchange: { request, failure: { class: "network", message: "Connection refused" } }
  }, { expect: ["network", "Connection refused"] }),
  empty_response: story<DebugApiCard, DebugApiView>("An empty response with duplicate headers", {
    operations, exchange: {
      request: { ...request, method: "PATCH", body: '{"capacity":2}' },
      response: { status: 204, headers: [["vary", "accept"], ["vary", "origin"]], body: "", duration_ms: 0 }
    }
  }, { expect: ['{"capacity":2}', "origin"] }),
  disabled: story<DebugApiCard, DebugApiView>("Send unavailable", {
    operations, selected: "getTodo"
  }, {
    actions: [{ ...send("getTodo", n), disabled: { reason: "Sign in again" } }],
    expect: ["Read a TODO"]
  }),
  unauthorized: story<DebugApiCard, DebugApiView>(
    "A typed 401 failure",
    {
      operations,
      selected: "getTodo",
      exchange: { request, failure: { class: "unauthorized", message: "Sign in again", status: 401 } }
    },
    {
      actions: [send("getTodo", n)],
      view: { maximized: false, selected: "getTodo" },
      expect: ["Sign in again"]
    }
  )
} satisfies Record<string, DebugApiStory>
