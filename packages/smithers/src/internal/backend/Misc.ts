/**
 * Raw API, configuration and remote agent conversation commands.
 * @since 0.1.0
 */

import { esc, list, object, query, str } from "./Client.ts"
import type { Handler } from "./Resources.ts"
/**
 * @private
 * @since 1.0.0
 */
export const misc: Record<string, Handler> = {}
misc.api = async (c, a, o) => {
  const method = str(o.method).toUpperCase() || "GET"
  if (!["GET", "POST", "PUT", "PATCH", "DELETE"].includes(method)) throw new Error("Invalid HTTP method")
  const pairs = (values: unknown, separator: string) =>
    Object.fromEntries(
      list(values).map(str).map((value) => {
        const index = value.indexOf(separator)
        if (index < 0) throw new Error(`Expected key${separator}value`)
        return [value.slice(0, index).trim(), value.slice(index + 1).trim()]
      })
    )
  const body = list(o.field).length ? pairs(o.field, "=") : undefined
  const response = await c.response(method, str(a.endpoint), body, { headers: pairs(o.header, ":") })
  const text = await c.text(response)
  if (!text) return null
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}
for (const action of ["get", "set", "list", "show"]) {
  misc[`config ${action}`] = async (c, a) => {
    const config = c.session.config(false), key = a.key === "api_url" ? "api_origin" : str(a.key)
    delete config.token
    if (
      ["get", "set"].includes(action) && !["api_origin", "observe_url", "git_protocol"].includes(key)
    ) throw new Error("Unknown config key")
    if (action === "get") return { [str(a.key)]: config[key] }
    if (action === "set") {
      c.session.saveConfig({ [key]: a.value })
      return { set: a.key, value: a.value }
    }
    if (action === "list") return config
    const effective = c.session.config()
    delete effective.token
    return {
      effective,
      config_file: { path: c.session.configPath, ...config },
      env_overrides: {
        SMITHERS_TOKEN: c.env.SMITHERS_TOKEN ? "(set)" : "(not set)",
        SMITHERS_API_ORIGIN: c.env.SMITHERS_API_ORIGIN || null
      }
    }
  }
}
for (const action of ["list", "view", "run", "chat"]) {
  const handler: Handler = async (c, a, o) => {
    const path = c.repoPath(o.repo) + "/agent/sessions"
    if (action === "list") return c.request("GET", path + query({ page: o.page, per_page: o["per-page"] }))
    if (action === "view") return c.request("GET", path + `/${esc(a.id)}`)
    const session = action === "run"
      ? object(await c.request("POST", path, { title: o.title || str(a.prompt).slice(0, 60) }))
      : { id: a.id }
    if (!session.id) throw new Error("Agent conversation response omitted id")
    const message = await c.request("POST", path + `/${esc(session.id)}/messages`, {
      role: "user",
      parts: [{ type: "text", content: action === "run" ? a.prompt : a.message }],
      agent_provider: o.provider || "smithers",
      agent_transport: o.transport || "workflow"
    })
    return action === "run" ? session : message
  }
  misc[`agent session ${action}`] = handler
  misc[`agent ${action}`] = handler
}
