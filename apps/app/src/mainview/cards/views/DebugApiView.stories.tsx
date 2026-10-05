import type { DebugApiViewProps } from "@smthrs/rpc/DebugApiCard"
import { DebugApiView } from "./DebugApiView"
// Inline cases replace the RPC fixture layer; the production View needs no decoder.
const operations: DebugApiViewProps["model"]["operations"] = [
  {id: "getHealth", method: "GET", path: "/api/health", summary: "Read install health", group: "Install"},
  {id: "getTodo", method: "GET", path: "/api/todos/{n}", summary: "Read a TODO", group: "TODOs"},
  {id: "dropTodo", method: "POST", path: "/api/todos/{n}/drop", summary: "Drop a TODO", group: "TODOs"},
  {id: "headTodo", method: "HEAD", path: "/api/todos/{n}", summary: "Check a TODO exists", group: "TODOs"},
  {id: "putSecret", method: "PUT", path: "/api/secrets/{name}", summary: "Set a secret", group: "Secrets"},
  {id: "patchSettings", method: "PATCH", path: "/api/settings", summary: "Change settings", group: "Settings"},
  {id: "deleteSecret", method: "DELETE", path: "/api/secrets/{name}", summary: "Delete a secret", group: "Secrets"},
]
const request: NonNullable<DebugApiViewProps["model"]["exchange"]>["request"] = {method: "GET", url: "http://mac-mini.local:8080/api/todos/12", headers: [["accept", "application/json"]]}
const cases = {
  empty: {model: {operations: []}, actions: [], gestures: {}, view: {maximized: false}, expect: []},
  pending_put: {model: {operations, selected: "putSecret", pending: {method: "PUT", path: "/api/secrets/key"}}, actions: [{tag: "debug-api", label: "Confirm PUT /api/secrets/key", args: {operation: "putSecret", confirm: "true"}, primary: true}], gestures: {}, view: {maximized: false}, expect: ["/api/secrets/key"]},
  pending_patch: {model: {operations, selected: "patchSettings", pending: {method: "PATCH", path: "/api/settings"}}, actions: [{tag: "debug-api", label: "Confirm PATCH /api/settings", args: {operation: "patchSettings", confirm: "true"}, primary: true}], gestures: {}, view: {maximized: false}, expect: ["/api/settings"]},
  pending_delete: {model: {operations, selected: "deleteSecret", pending: {method: "DELETE", path: "/api/secrets/key"}}, actions: [{tag: "debug-api", label: "Confirm DELETE /api/secrets/key", args: {operation: "deleteSecret", confirm: "true"}, primary: true}], gestures: {}, view: {maximized: false}, expect: ["/api/secrets/key"]},
  forbidden: {model: {operations, exchange: {request, failure: {class: "forbidden", message: "Access denied", status: 403}}}, actions: [], gestures: {}, view: {maximized: false}, expect: ["forbidden", "Access denied"]},
  hostile: {model: {operations, exchange: {request, response: {status: 200, headers: [], body: "<img src=x onerror=\"window.__pwned=1\">", duration_ms: 1}, failure: {class: "network", message: "<script>window.__pwned=1</script>"}}}, actions: [], gestures: {}, view: {maximized: false}, expect: ["<img src=x onerror=\"window.__pwned=1\">", "<script>window.__pwned=1</script>"]},
  operations: {model: {operations}, actions: [], gestures: {}, view: {maximized: false}, expect: ["Read install health", "/api/todos/{n}/drop", "Delete a secret"]},
  get_200: {model: {operations, selected: "getTodo", exchange: {request, response: {status: 200, headers: [["content-type", "application/json"]], body: "{\"n\":12,\"state\":\"working\"}", duration_ms: 18}}}, actions: [{tag: "debug-api", label: "Send", args: {operation: "getTodo"}, primary: true, input: [{name: "n", label: "n", kind: "text", required: true}]}], gestures: {}, view: {maximized: false, selected: "getTodo"}, expect: ["Read a TODO", "http://mac-mini.local:8080/api/todos/12", "{\"n\":12,\"state\":\"working\"}"]},
  pending_mutation: {model: {operations, selected: "dropTodo", pending: {method: "POST", path: "/api/todos/12/drop"}}, actions: [{tag: "debug-api", label: "Confirm POST /api/todos/12/drop", args: {operation: "dropTodo", confirm: "true"}, primary: true}], gestures: {}, view: {maximized: false, selected: "dropTodo"}, expect: ["/api/todos/12/drop"]},
  patch_body: {model: {operations, selected: "patchSettings"}, actions: [{tag: "debug-api", label: "Send", args: {operation: "patchSettings"}, primary: true, input: [{name: "body", label: "Body", kind: "text", required: true, multiline: true}]}], gestures: {}, view: {maximized: false, selected: "patchSettings"}, expect: ["Change settings"]},
  request_only: {model: {operations, selected: "getTodo", exchange: {request}}, actions: [], gestures: {}, view: {maximized: false}, expect: ["http://mac-mini.local:8080/api/todos/12"]},
  network_failure: {model: {operations, exchange: {request, failure: {class: "infra", message: "API request failed"}}}, actions: [], gestures: {}, view: {maximized: false}, expect: ["infra", "API request failed"]},
  empty_response: {model: {operations, exchange: {request: {method: "PATCH", url: "http://mac-mini.local:8080/api/todos/12", headers: [["accept", "application/json"]], body: "{\"capacity\":2}"}, response: {status: 204, headers: [["vary", "accept"], ["vary", "origin"]], body: "", duration_ms: 0}}}, actions: [], gestures: {}, view: {maximized: false}, expect: ["{\"capacity\":2}", "origin"]},
  disabled: {model: {operations, selected: "getTodo"}, actions: [{tag: "debug-api", label: "Send", args: {operation: "getTodo"}, primary: true, input: [{name: "n", label: "n", kind: "text", required: true}], disabled: {reason: "Sign in again"}}], gestures: {}, view: {maximized: false}, expect: ["Read a TODO"]},
  unauthorized: {model: {operations, selected: "getTodo", exchange: {request, failure: {class: "permission", code: "unauthenticated", message: "Sign in again", status: 401}}}, actions: [{tag: "debug-api", label: "Send", args: {operation: "getTodo"}, primary: true, input: [{name: "n", label: "n", kind: "text", required: true}]}], gestures: {}, view: {maximized: false, selected: "getTodo"}, expect: ["Sign in again"]},
} satisfies Record<string, Omit<DebugApiViewProps, "onAction" | "onView"> & { expect: string[] }>

export const stories: import("./stories").ViewStory[] = Object.entries(cases).map(([name, story]) => {
  const ops = story.model.operations
  const groups = [...new Set(ops.map(o => o.group))]
  return {
    name, actions: story.actions, expect: story.expect,
    interactions: groups.flatMap((g, gi) => ops.filter(o => o.group === g).map((o, oi) => ({
      selector: `nav section:nth-of-type(${gi + 1}) button:nth-of-type(${oi + 1})`, patch: { selected: o.id }
    }))),
    render: (callbacks, actions = story.actions) => <DebugApiView {...story} actions={actions as DebugApiViewProps["actions"]} {...callbacks} />
  }
})
