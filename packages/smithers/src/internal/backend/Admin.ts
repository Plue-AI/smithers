/**
 * Administrator command plumbing; the backend owns authorization and transitions.
 * @since 0.1.0
 */

import { esc, pick, query, str, type Values } from "./Client.ts"
import type { Handler } from "./Resources.ts"
import { observeOrigin } from "./Session.ts"

/**
 * @private
 * @since 1.0.0
 */
export const admin: Record<string, Handler> = {}
const operations: Array<
  {
    name: string
    method: string
    path: string
    arg?: string
    query?: Array<string>
    body?: Array<string>
    required?: Array<string>
    destructive?: boolean
    observe?: boolean
    fixed?: Values
  }
> = [
  {
    "name": "status",
    "method": "GET",
    "path": "/api/admin/system/status"
  },
  {
    "name": "analytics summary",
    "method": "GET",
    "path": "/api/admin/analytics/summary",
    "query": [
      "range",
      "include-synthetic"
    ]
  },
  {
    "name": "sessions list",
    "method": "GET",
    "path": "/api/admin/agent-sessions",
    "query": [
      "status",
      "include-synthetic",
      "limit"
    ]
  },
  {
    "name": "sessions cancel",
    "method": "POST",
    "path": "/api/admin/agent-sessions/{target}/cancel",
    "arg": "id",
    "body": [
      "reason"
    ],
    "destructive": true
  },
  {
    "name": "workspaces list",
    "method": "GET",
    "path": "/api/admin/workspaces",
    "query": [
      "status",
      "kind",
      "owner",
      "include-synthetic",
      "limit"
    ]
  },
  {
    "name": "workspaces stop",
    "method": "POST",
    "path": "/api/admin/workspaces/{target}/stop",
    "arg": "id",
    "destructive": true
  },
  {
    "name": "workspaces suspend",
    "method": "POST",
    "path": "/api/admin/workspaces/{target}/suspend",
    "arg": "id",
    "destructive": true
  },
  {
    "name": "tokens list",
    "method": "GET",
    "path": "/api/admin/tokens",
    "query": [
      "unused-days",
      "scope",
      "expiring-days",
      "limit"
    ]
  },
  {
    "name": "users set-synthetic",
    "method": "PATCH",
    "path": "/api/admin/users/{target}",
    "arg": "username",
    "body": [
      "value"
    ],
    "required": [
      "value"
    ]
  },
  {
    "name": "audit list",
    "method": "GET",
    "path": "/api/admin/audit-logs",
    "query": [
      "since"
    ],
    "required": [
      "since"
    ]
  },
  {
    "name": "alerts channels list",
    "method": "GET",
    "path": "/api/v1/alerts/channels",
    "observe": true
  },
  {
    "name": "alerts channels add",
    "method": "POST",
    "path": "/api/v1/alerts/channels",
    "body": [
      "type",
      "display-name",
      "target",
      "route"
    ],
    "required": [
      "type",
      "display-name",
      "target",
      "route"
    ],
    "observe": true
  },
  {
    "name": "alerts channels remove",
    "method": "DELETE",
    "path": "/api/v1/alerts/channels/{target}",
    "arg": "id",
    "destructive": true,
    "observe": true
  },
  {
    "name": "alerts channels send-code",
    "method": "POST",
    "path": "/api/v1/alerts/channels/{target}/send-code",
    "arg": "id",
    "observe": true
  },
  {
    "name": "alerts channels verify",
    "method": "POST",
    "path": "/api/v1/alerts/channels/{target}/verify",
    "arg": "id",
    "body": [
      "code"
    ],
    "required": [
      "code"
    ],
    "observe": true
  },
  {
    "name": "alerts channels set-route",
    "method": "PATCH",
    "path": "/api/v1/alerts/channels/{target}",
    "arg": "id",
    "body": [
      "route"
    ],
    "required": [
      "route"
    ],
    "observe": true
  },
  {
    "name": "alerts policies list",
    "method": "GET",
    "path": "/api/v1/alerts/policies",
    "observe": true
  },
  {
    "name": "alerts policies enable",
    "method": "PATCH",
    "path": "/api/v1/alerts/policies/{target}",
    "arg": "name",
    "observe": true,
    "fixed": {
      "enabled": true
    }
  },
  {
    "name": "alerts policies disable",
    "method": "PATCH",
    "path": "/api/v1/alerts/policies/{target}",
    "arg": "name",
    "observe": true,
    "fixed": {
      "enabled": false
    }
  },
  {
    "name": "deploys observe list",
    "method": "GET",
    "path": "/api/v1/deploys/observe",
    "observe": true
  },
  {
    "name": "deploys observe rollback",
    "method": "POST",
    "path": "/api/v1/deploys/observe/{target}/rollback",
    "arg": "id",
    "destructive": true,
    "observe": true
  },
  {
    "name": "deploys observe redeploy",
    "method": "POST",
    "path": "/api/v1/deploys/observe/{target}/redeploy",
    "arg": "id",
    "destructive": true,
    "observe": true
  },
  {
    "name": "deploys observe restart",
    "method": "POST",
    "path": "/api/v1/deploys/observe/{target}/restart",
    "arg": "id",
    "destructive": true,
    "observe": true
  },
  {
    "name": "deploys platform list",
    "method": "GET",
    "path": "/api/v1/deploys/platform",
    "observe": true
  },
  {
    "name": "deploys platform rollback",
    "method": "POST",
    "path": "/api/v1/deploys/platform/{target}/rollback",
    "arg": "component",
    "body": [
      "revision"
    ],
    "required": [
      "revision"
    ],
    "destructive": true,
    "observe": true
  },
  {
    "name": "deploys platform status",
    "method": "GET",
    "path": "/api/v1/deploys/platform/{target}/status",
    "arg": "component",
    "observe": true
  }
]
for (const op of operations) {
  admin[`admin ${op.name}`] = async (c, a, o) => {
    const target = op.arg ? str(a[op.arg]) : ""
    if (op.arg && (!target.trim() || [".", ".."].includes(target) || /[/\\\r\n]/.test(target))) {
      throw new Error(`${op.arg} must be a single target`)
    }
    if (op.destructive) await c.confirm(o.yes, `${op.name} ${target}`)
    const path = op.path.replace("{target}", esc(target)) + query(pick(o, op.query ?? []))
    let body = op.body || op.fixed ? { ...op.fixed, ...pick(o, op.body ?? []) } : undefined
    if (op.name === "users set-synthetic") body = { synthetic: o.value === "true" }
    const options = op.observe
      ? {
        origin: observeOrigin(str(c.session.config().observe_url)),
        token: c.session.require().token,
        headers: op.method === "GET" ? {} : { "X-Confirm": target || str(o["display-name"]) }
      }
      : undefined
    return c.request(op.method, path, body, options)
  }
}
admin["admin user list"] = (c, _a, o) =>
  c.request("GET", "/api/admin/users" + query({ page: o.page, per_page: o.limit }))
admin["admin user create"] = (c, _a, o) => c.request("POST", "/api/admin/users", pick(o, ["username", "email"]))
for (const action of ["enable", "disable"]) {
  admin[`admin user ${action}`] = (c, a) =>
    c.request("PATCH", `/api/admin/users/${esc(a.username)}`, { suspended: action === "disable" })
}
admin["admin user delete"] = async (c, a, o) => {
  await c.confirm(o.yes, `delete user ${str(a.username)}`)
  await c.request("DELETE", `/api/admin/users/${esc(a.username)}`)
  return { status: "suspended", username: a.username }
}
admin["admin user erase"] = async (c, a, o) => {
  await c.confirm(o.yes, `erase user ${str(a.username)} and all of its data`)
  return c.request("POST", `/api/admin/users/${esc(a.username)}/erase`, { request_date: o["request-date"] })
}
admin["admin health"] = (c) => c.request("GET", "/api/admin/system/health")
admin["admin runs list"] = (c, _a, o) =>
  c.request("GET", c.repoPath(o.repo) + "/workflows/runs" + query({ page: o.page, per_page: o.limit }))
admin["beta waitlist join"] = (c, _a, o) =>
  c.request("POST", "/api/alpha/waitlist", pick(o, ["email", "note", "source"]), { anonymous: true })
admin["beta waitlist list"] = (c, _a, o) =>
  c.request("GET", "/api/admin/alpha/waitlist" + query(pick(o, ["page", "per-page", "status"])))
admin["beta waitlist approve"] = (c, _a, o) =>
  c.request("POST", "/api/admin/alpha/waitlist/approve", { email: str(o.email).trim() })
admin["beta whitelist list"] = (c) => c.request("GET", "/api/admin/alpha/whitelist")
admin["beta whitelist add"] = (c, _a, o) =>
  c.request("POST", "/api/admin/alpha/whitelist", { identity_type: o.type, identity_value: str(o.value).trim() })
admin["beta whitelist remove"] = async (c, _a, o) => {
  await c.request("DELETE", `/api/admin/alpha/whitelist/${esc(o.type)}/${esc(str(o.value).trim())}`)
  return { removed: true, identity_type: o.type, identity_value: str(o.value).trim() }
}
