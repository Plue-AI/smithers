/**
 * Raw API, configuration and remote agent conversation commands.
 * @since 0.1.0
 */

import { Refused, UsageError } from "../../CliError.ts"
import { createReadStream } from "node:fs"
import { esc, list, object, query, str } from "./Client.ts"
import type { Handler } from "./Resources.ts"
/**
 * @private
 * @since 1.0.0
 */
export const misc: Record<string, Handler> = {}
misc.api = async (c, a, o) => {
  const method = str(o.method).toUpperCase() || "GET"
  if (!["GET", "POST", "PUT", "PATCH", "DELETE"].includes(method)) {
    throw new UsageError({ message: "Invalid HTTP method" })
  }
  const pairs = (values: unknown, separator: string) =>
    Object.fromEntries(
      list(values).map(str).map((value) => {
        const index = value.indexOf(separator)
        if (index < 0) {
          throw new UsageError({
            message: separator === "=" ? "Fields require an equals sign" : "Headers require a colon"
          })
        }
        return [value.slice(0, index).trim(), value.slice(index + 1).trim()]
      })
    )
  let body: unknown = list(o.field).length ? pairs(o.field, "=") : undefined
  if (o.input !== undefined) {
    if (list(o.field).length) throw new UsageError({ message: "Use --input or --field, together they are not allowed" })
    let text: string
    if (o.input === "-") text = await c.stdin("JSON input")
    else {
      const chunks: Array<Buffer> = []
      let size = 0
      try {
        for await (const chunk of createReadStream(str(o.input))) {
          const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
          size += bytes.length
          if (size > 4 * 1024 * 1024) {
            throw new Refused({ fault: "user", code: "input_too_large", message: "JSON input exceeds 4 MiB" })
          }
          chunks.push(bytes)
        }
      } catch (error) {
        if (error instanceof Refused) throw error
        throw new Refused({ fault: "user", code: "input_unreadable", message: "Cannot read JSON input file" })
      }
      text = Buffer.concat(chunks).toString("utf8")
    }
    try {
      body = JSON.parse(text)
    } catch {
      throw new UsageError({ message: "Input must contain one valid JSON value" })
    }
  }
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
    ) throw new UsageError({ message: "Unknown config key" })
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
        token_set: !!c.env.SMITHERS_TOKEN,
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
    if (!session.id) {
      throw new Refused({ fault: "infra", code: "backend_protocol", message: "Agent conversation response omitted id" })
    }
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
