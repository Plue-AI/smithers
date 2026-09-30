/**
 * Workspace API operations, terminal sessions and durable remote execution.
 * @since 0.1.0
 */

import { NodeWS } from "@effect/platform-node/NodeSocket"
import { randomUUID } from "node:crypto"
import { Readable } from "node:stream"
import { setTimeout as delay } from "node:timers/promises"
import { Refused, UsageError } from "../../CliError.ts"
import * as Failure from "../Failure.ts"
import {
  APIError,
  type Client,
  esc,
  list,
  object,
  pick,
  positive,
  query,
  str,
  type Values,
  withCause
} from "./Client.ts"
import { lines } from "./Local.ts"
import type { Handler } from "./Resources.ts"
import { type Endpoint, hostKeys, quote, remote } from "./SSH.ts"

const base = (c: Client, o: Values) => c.repoPath(o.repo) + "/workspaces"
const protocol = (message: string) => new Refused({ fault: "infra", code: "backend_protocol", message })
// A command whose outcome this invocation could not confirm: the operator
// reattaches by id, and the inner failure's own words are kept only as cause.
const reattach = (c: Client, error: unknown, requestID: string): Refused => {
  const known = c.failure(error), suffix = `; reattach with --exec-id ${requestID}`
  return withCause(
    known instanceof Refused
      ? new Refused({ fault: known.fault, code: known.code, message: `${known.message}${suffix}` })
      : new Refused({ fault: "infra", code: "exec_unconfirmed", message: `Lost contact with the command${suffix}` }),
    error
  )
}
/**
 * @private
 * @since 1.0.0
 */
export const resolveID = async (c: Client, a: Values, o: Values) => {
  if (a.id) return str(a.id)
  const workspaces = list(await c.request("GET", base(c, o))).map(object)
  const id = str(
    workspaces.find((ws) => ws.status === "running")?.id || workspaces[0]?.id ||
      object(await c.request("POST", base(c, o), { name: "" })).id
  )
  if (!id) throw protocol("Workspace response omitted id")
  return id
}
const sshInfo = async (c: Client, path: string, user: unknown): Promise<Endpoint> => {
  const deadline = Date.now() + (Number(c.env.SMITHERS_WORKSPACE_SSH_POLL_TIMEOUT_MS) || 120_000)
  do {
    let info: Values | undefined
    try {
      info = object(
        await c.request("GET", path + "/ssh" + query({ user: user && user !== "developer" ? user : undefined }))
      )
    } catch (error) {
      if (error instanceof APIError && ![404, 409, 423, 425, 429, 502, 503, 504].includes(error.status)) throw error
    }
    // Host keys are validated outside the retry guard: a malformed advertised
    // key is a refusal, never a transient state to poll through.
    if (info && (info.ssh_command || info.command)) {
      return { command: str(info.ssh_command || info.command), hostKeys: hostKeys(info.host_keys) }
    }
    await delay(Number(c.env.SMITHERS_WORKSPACE_SSH_POLL_INTERVAL_MS) || 3000, undefined, { signal: c.runtime.signal })
  } while (Date.now() < deadline)
  throw new Refused({ fault: "infra", code: "workspace_not_ready", message: "Workspace did not become SSH-ready" })
}
/**
 * @private
 * @since 1.0.0
 */
export const workspaceBody = (o: Values) => {
  const body: Values = { name: str(o.name), ...pick(o, ["image"]) }
  if (o.snapshot) body.snapshot_id = o.snapshot
  const resources: Values = {}
  for (const [key, field] of [["cpus", "cpus"], ["memory", "memory_mb"], ["disk", "disk_mb"]]) {
    if (o[key!] !== undefined) resources[field!] = positive(o[key!], key)
  }
  if (Object.keys(resources).length) body.resources = resources
  const allow = list(o.allow).flatMap((value) => str(value).split(",")).map((value) => value.trim()).filter(Boolean)
  const mode = str(o.network || (allow.length ? "allowlist" : "")).toLowerCase()
  if (mode) {
    if (!["proxy", "allowlist", "none"].includes(mode) || (allow.length && mode !== "allowlist")) {
      throw new UsageError({ message: "Invalid workspace network options" })
    }
    body.network = { mode, ...(allow.length ? { allow } : {}) }
  }
  if (o.idleTimeout !== undefined) {
    if (!Number.isInteger(o.idleTimeout) || Number(o.idleTimeout) < 0) {
      throw new UsageError({ message: "Idle timeout must be >= 0" })
    }
    body.idle_timeout_seconds = o.idleTimeout
  }
  const seen = new Set<string>()
  if (list(o.service).length) {
    body.services = list(o.service).map((value) => {
      const raw = str(value),
        index = raw.indexOf("="),
        name = raw.slice(0, index).trim(),
        command = raw.slice(index + 1).trim()
      if (index < 1 || !name || !command || /[ /\\]/.test(name) || seen.has(name)) {
        throw new UsageError({ message: "Services must have unique NAME=COMMAND values" })
      }
      seen.add(name)
      return { name, mode: "service", exec: ["/bin/sh", "-lc", command] }
    })
  }
  return body
}
/**
 * @private
 * @since 1.0.0
 */
export const workspaces: Record<string, Handler> = {}
workspaces["workspace create"] = async (c, _a, o) => {
  const created = await c.request("POST", base(c, o), workspaceBody(o))
  if (!o.wait) return created
  const id = str(object(created).id)
  if (!id) throw protocol("Workspace response omitted id")
  const deadline = Date.now() + Number(o.waitTimeout || 600) * 1000
  do {
    const ws = object(await c.request("GET", base(c, o) + `/${esc(id)}`))
    if (ws.status === "running") return ws
    if (["failed", "error"].includes(str(ws.status))) {
      throw new Refused({
        fault: "infra",
        code: "workspace_failed",
        message: Failure.terminalSafe(
          `${str(ws.failure_code) || "workspace_failed"}: ${
            str(ws.failure_message) || "Provisioning failed"
          }; workspace ${id} remains`
        )
      })
    }
    await delay(Number(c.env.SMITHERS_WORKSPACE_CREATE_POLL_INTERVAL_MS) || 3000, undefined, {
      signal: c.runtime.signal
    })
  } while (Date.now() < deadline)
  throw new Refused({ fault: "infra", code: "workspace_not_ready", message: `Workspace ${id} did not become running` })
}
workspaces["workspace list"] = (c, _a, o) => c.request("GET", base(c, o))
workspaces["workspace view"] = async (c, a, o) => {
  const path = base(c, o) + `/${esc(a.id)}`, ws = object(await c.request("GET", path))
  let ssh: unknown = null
  if (ws.status === "running") {
    try {
      ssh = await c.request("GET", path + "/ssh")
    } catch { /* detail may still be provisioning */ }
  }
  const started = Date.parse(str(ws.suspended_at && ws.updated_at ? ws.updated_at : ws.created_at)),
    minutes = Math.floor((Date.now() - started) / 60000)
  const info = object(ssh), host = info.host || info.ssh_host || ws.ssh_host
  const sshView = ssh || ws.ssh_host
    ? {
      command: info.command || info.ssh_command || (host ? `ssh ${str(host)}` : "SSH details available"),
      host: host || null,
      port: info.port || 22,
      username: info.username ?? null
    }
    : null
  return {
    ...ws,
    ssh: sshView,
    uptime: ws.status === "running" && Number.isFinite(started)
      ? minutes >= 60 ? `${Math.floor(minutes / 60)}h ${minutes % 60}m` : `${minutes}m`
      : null,
    persistence: ws.persistence || "persistent",
    snapshot_id: ws.snapshot_id ?? null,
    idle_timeout_seconds: ws.idle_timeout_seconds ?? 1800
  }
}
workspaces["workspace delete"] = async (c, a, o) => {
  await c.confirm(o.yes, `delete workspace ${str(a.id)}`)
  await c.request("DELETE", base(c, o) + `/${esc(a.id)}`)
  return { status: "deleted", id: a.id }
}
workspaces["workspace fork"] = (c, a, o) => c.request("POST", base(c, o) + `/${esc(a.id)}/fork`, { name: str(o.name) })
workspaces["workspace snapshots"] = async (c, a, o) =>
  list(await c.pages((cursor) => c.repoPath(o.repo) + "/workspace-snapshots" + query({ limit: 100, cursor }), "", true))
    .filter((item) => object(item).workspace_id === a.id)
workspaces["workspace watch"] = async (c, a, o) => {
  const path = base(c, o) + `/${esc(a.id)}`
  const ws = object(await c.request("GET", path))
  return { ...ws, events: await c.events(path + "/stream", "done", ["deleted", "error"], "status") }
}
workspaces["workspace ssh"] = async (c, a, o) => {
  const id = await resolveID(c, a, o), ssh = await sshInfo(c, base(c, o) + `/${esc(id)}`, "")
  const result = await remote(c, ssh, undefined, 0, undefined, true)
  c.runtime.exit?.(result.code)
  return { connected: result.code === 0, workspace_id: id }
}
const seedCredential = (c: Client, agents: Array<string>): string => {
  const normalized = [...new Set(agents.map((value) => value.trim().toLowerCase()).filter(Boolean))]
  if (normalized.includes("codex")) {
    throw new Refused({
      fault: "user",
      code: "not_signed_in",
      message: "Run `codex login --device-auth` on the workspace; Codex subscriptions are never sent to a workspace"
    })
  }
  if (normalized.some((agent) => agent !== "claude")) {
    throw new UsageError({ message: "seedAgentAuth accepts claude API keys only" })
  }
  if (normalized.length === 0) throw new UsageError({ message: "seedAgentAuth accepts claude API keys only" })
  const key = c.env.ANTHROPIC_API_KEY ?? ""
  if (!/^sk-ant-api[0-9a-z-]*-(?=[A-Za-z0-9._-]*[A-Za-z0-9])[A-Za-z0-9._-]+$/.test(key)) {
    throw new Refused({
      fault: "user",
      code: "not_signed_in",
      message: "ANTHROPIC_API_KEY is required; Claude subscriptions are never sent to a workspace"
    })
  }
  c.protect(key)
  return key
}
const seed = async (c: Client, ssh: Endpoint, key: string) => {
  const path = "/home/developer/.smithers/claude-env.sh"
  const data = `export ANTHROPIC_API_KEY=${quote(key)}\n`
  const script = `set -e; umask 077; mkdir -p ${quote(path.slice(0, path.lastIndexOf("/")))}; printf %s ${
    quote(Buffer.from(data).toString("base64"))
  } | base64 -d > ${quote(path)}; chmod 600 ${quote(path)}; if [ "$(id -u)" = 0 ]; then chown -R developer:developer ${
    quote(path.slice(0, path.lastIndexOf("/")))
  }; fi`
  const result = await remote(c, ssh, "bash -s", 120_000, Readable.from([script]))
  if (result.code) {
    throw new Refused({ fault: "dependency", code: "seed_failed", message: "Agent credential seeding failed" })
  }
}
const interrupted = () =>
  new Refused({ fault: "user", code: "interrupted", message: "Command interrupted; execution ended" })
workspaces["workspace exec"] = async (c, a, o) => {
  const timeout = o.timeout === undefined ? 0 : Number(o.timeout)
  if (!str(o.command).trim() || !Number.isFinite(timeout) || timeout < 0) {
    throw new UsageError({ message: "A command and non-negative timeout are required" })
  }
  if (o.stdin || (o.user && o.user !== "developer")) {
    throw new UsageError({
      message: "Use workspace ssh or workspace shell for interactive input or another guest user"
    })
  }
  if (o.detach && timeout > 0) throw new UsageError({ message: "--detach cannot be combined with --timeout" })
  const entries = list(o.env).map(str)
  if (entries.some((value) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(value))) {
    throw new UsageError({ message: "--env expects KEY=VALUE" })
  }
  const environment = Object.fromEntries(
    entries.map((value) => [value.slice(0, value.indexOf("=")), value.slice(value.indexOf("=") + 1)])
  )
  const requestID = str(o["exec-id"]) || randomUUID()
  if (requestID.length > 128 || !requestID.trim()) throw new UsageError({ message: "Invalid exec id" })
  const credential = o.seedAgentAuth === undefined ? undefined : seedCredential(c, str(o.seedAgentAuth).split(","))
  const id = await resolveID(c, a, o), path = base(c, o) + `/${esc(id)}/command-runs`
  if (credential !== undefined) {
    const ssh = await sshInfo(c, base(c, o) + `/${esc(id)}`, "developer")
    await seed(c, ssh, credential)
  }
  let receipt: Values
  try {
    receipt = object(
      await c.request("POST", path, {
        operation_id: requestID,
        args: ["/bin/bash", "-lc", str(o.command)],
        ...(o.cwd ? { directory: str(o.cwd) } : {}),
        environment
      })
    )
  } catch (error) {
    throw reattach(c, error, requestID)
  }
  if (typeof receipt.operationId !== "string" || !receipt.operationId) {
    throw protocol(`Command response omitted operationId; reattach with --exec-id ${requestID}`)
  }
  // A detached command keeps running under its durable receipt; the same
  // command with --exec-id reattaches to it.
  if (o.detach) {
    return { workspace_id: id, operation_id: receipt.operationId, exec_id: requestID, state: str(receipt.state) }
  }
  const runPath = `${path}/${esc(receipt.operationId)}`
  const deadline = timeout > 0 ? Date.now() + timeout * 1000 : Infinity
  const interval = Number(c.env.SMITHERS_WORKSPACE_COMMAND_POLL_INTERVAL_MS) || 1000
  let cancellationAttempted = false
  const cancel = async () => {
    cancellationAttempted = true
    const signal = AbortSignal.timeout(30_000)
    let run = object(await c.request("POST", runPath + "/cancel", undefined, { signal }))
    while (["accepted", "dispatching", "running", "waiting"].includes(str(run.state))) {
      if (run.operationId !== receipt.operationId) throw protocol("Mismatched command receipt")
      await delay(interval, undefined, { signal })
      run = object(await c.request("GET", runPath, undefined, { signal }))
    }
    if (run.operationId !== receipt.operationId || !["cancelled", "completed", "failed"].includes(str(run.state))) {
      throw new Refused({
        fault: "infra",
        code: "cancel_unconfirmed",
        message: "Command cancellation could not be confirmed"
      })
    }
  }
  try {
    for (;;) {
      if (c.runtime.signal?.aborted || Date.now() >= deadline) {
        await cancel()
        throw interrupted()
      }
      const signal = timeout > 0
        ? AbortSignal.any([
          AbortSignal.timeout(Math.max(1, Math.ceil(deadline - Date.now()))),
          ...(c.runtime.signal ? [c.runtime.signal] : [])
        ])
        : c.runtime.signal
      const run = object(await c.request("GET", runPath, undefined, signal ? { signal } : undefined))
      if (run.operationId !== receipt.operationId) throw protocol("Mismatched command receipt")
      if (run.state === "completed") {
        const result = object(run.result)
        if (
          !Number.isInteger(result.exit_code) || typeof result.stdout !== "string" ||
          typeof result.stderr !== "string" || typeof result.output_truncated !== "boolean"
        ) {
          throw protocol("Invalid command result")
        }
        c.output(Buffer.from(result.stdout), Buffer.from(result.stderr))
        c.flushOutput()
        c.runtime.exit?.(Number(result.exit_code))
        // A live run already streamed the child's output: the receipt omits it.
        const { stdout, stderr, ...receiptResult } = result
        return {
          workspace_id: id,
          operation_id: receipt.operationId,
          ...receiptResult,
          ...(c.live ? {} : { stdout, stderr })
        }
      }
      if (["failed", "uncertain", "cancelled"].includes(str(run.state))) {
        const state = str(run.state)
        throw new Refused({
          fault: state === "cancelled" ? "user" : "infra",
          code: `command_${state}`,
          message: Failure.terminalSafe(str(c.redact(str(run.error)))).trim() || `Command ${state}`
        })
      }
      if (!["accepted", "dispatching", "running", "waiting"].includes(str(run.state))) {
        throw protocol("Invalid command state")
      }
      // Check abort in the loop so cancellation uses its own live request signal.
      await delay(Math.min(interval, Math.max(1, deadline - Date.now())))
    }
  } catch (error) {
    if (
      !cancellationAttempted && (c.runtime.signal?.aborted || Date.now() >= deadline)
    ) {
      try {
        await cancel()
      } catch (cancelError) {
        throw reattach(c, cancelError, requestID)
      }
      throw interrupted()
    }
    throw reattach(c, error, requestID)
  }
}
workspaces["workspace shell"] = async (c, a, o) => {
  const id = await resolveID(c, a, o), path = c.repoPath(o.repo) + "/workspace/sessions"
  const cols = Number(o.cols) || process.stdout.columns || 80, rows = Number(o.rows) || process.stdout.rows || 24
  const session = object(await c.request("POST", path, { cols, rows, workspace_id: id }))
  if (!session.id) throw protocol("Terminal response omitted id")
  const auth = await c.session.require(),
    url = auth.api_url.replace(/^http/, "ws") + `${path}/${esc(session.id)}/terminal`
  const socket = new NodeWS.WebSocket(url, { headers: { Authorization: `token ${auth.token}`, Origin: auth.api_url } })
  const raw = process.stdin.isRaw
  const input = (chunk: Buffer) => socket.send(chunk, { binary: true })
  const resize = () =>
    socket.send(
      JSON.stringify({ type: "resize", cols: process.stdout.columns || cols, rows: process.stdout.rows || rows })
    )
  const abort = () => socket.close()
  try {
    await new Promise<void>((resolve, reject) => {
      socket.once("error", reject)
      socket.once("open", () => {
        if (process.stdin.isTTY) process.stdin.setRawMode(true)
        resize()
        process.stdin.on("data", input)
        process.stdout.on("resize", resize)
        c.runtime.signal?.addEventListener("abort", abort, { once: true })
      })
      socket.on("message", (data, binary) => {
        if (!binary) {
          try {
            const message = object(JSON.parse(data.toString()))
            if (message.type === "status" && ["stopped", "failed"].includes(str(message.status))) {
              socket.close()
              if (message.status === "failed") c.runtime.exit?.(1)
              return
            }
          } catch { /* terminal text */ }
        }
        process.stdout.write(data.toString())
      })
      socket.once("close", () => resolve())
      process.stdin.once("end", abort)
    })
  } finally {
    process.stdin.off("data", input)
    process.stdin.off("end", abort)
    process.stdout.off("resize", resize)
    process.stdin.pause()
    if (process.stdin.isTTY) process.stdin.setRawMode(!!raw)
    c.runtime.signal?.removeEventListener("abort", abort)
    socket.close()
    await c.request("POST", `${path}/${esc(session.id)}/destroy`)
  }
}
/**
 * Run Claude as the box's developer, including images whose SSH user is root.
 * @private
 * @since 1.0.0
 */
export const claudeScript = (prompt: string) => {
  const developer = [
    "set -euo pipefail",
    "export PATH=/home/developer/.local/bin:/usr/local/bin:/usr/bin:/bin:$PATH",
    "export TERM=${TERM:-dumb} CI=${CI:-1} NPM_CONFIG_PREFIX=/home/developer/.local",
    "command -v node >/dev/null && command -v npm >/dev/null || { echo 'Node.js and npm must be on PATH' >&2; exit 1; }",
    "command -v claude >/dev/null || npm install -g @anthropic-ai/claude-code >/home/developer/.smithers/claude-install.log 2>&1",
    ". /home/developer/.smithers/claude-env.sh",
    "test -n \"${ANTHROPIC_API_KEY:-}\" || { echo 'ANTHROPIC_API_KEY required' >&2; exit 1; }",
    "cd /home/developer/workspace",
    "prompt=$(cat /home/developer/.smithers/issue-prompt.txt)",
    "exec </dev/null claude -p --dangerously-skip-permissions --no-session-persistence --output-format json \"$prompt\""
  ].join("\n")
  return [
    "set -euo pipefail",
    "export PATH=/home/developer/.local/bin:$PATH",
    "command -v jj >/dev/null || { echo 'jj is not installed in this workspace' >&2; exit 1; }",
    "cd /home/developer/workspace; [ -d .jj ] || jj git init",
    "umask 077; mkdir -p /home/developer/.smithers /home/developer/.local/bin",
    `printf %s ${
      quote(Buffer.from(prompt).toString("base64"))
    } | base64 -d > /home/developer/.smithers/issue-prompt.txt`,
    "if [ \"$(id -u)\" = 0 ]; then",
    "chown -R developer:developer /home/developer/workspace /home/developer/.smithers /home/developer/.local",
    `if command -v runuser >/dev/null; then exec runuser -u developer -- env -i HOME=/home/developer USER=developer LOGNAME=developer PATH=/home/developer/.local/bin:/usr/local/bin:/usr/bin:/bin TERM=dumb CI=1 bash -lc ${
      quote(developer)
    }; fi`,
    `exec su - developer -c ${quote(developer)}`,
    "fi",
    `exec bash -lc ${quote(developer)}`
  ].join("\n")
}
workspaces["workspace issue"] = async (c, a, o) => {
  const number = positive(a.number),
    repository = c.repoPath(o.repo),
    issue = object(await c.request("GET", `${repository}/issues/${number}`))
  const workspace = object(await c.request("POST", base(c, o), { name: `issue-${number}` })), id = str(workspace.id)
  if (!id) throw protocol("Workspace response omitted id")
  const ssh = await sshInfo(c, base(c, o) + `/${esc(id)}`, "")
  try {
    await seed(c, ssh, seedCredential(c, ["claude"]))
  } catch (error) {
    const existing = await remote(c, ssh, "test -s /home/developer/.smithers/claude-env.sh")
    if (existing.code) throw error
  }
  const labels = list(issue.labels).map((label) => str(object(label).name)).filter(Boolean)
  const prompt = `Fix issue #${number}: ${str(issue.title)}${
    labels.length ? `\nLabels: ${labels.join(", ")}` : ""
  }\n\n${str(issue.body)}\n\nWhen done, commit your changes with jj. Do not create a landing request.`
  const result = await remote(c, ssh, claudeScript(prompt), 30 * 60_000, undefined, false, true)
  if (result.code) {
    c.runtime.exit?.(result.code)
    const diagnostics = await remote(
      c,
      ssh,
      "command -v node; command -v npm; command -v claude; tail -n 80 /home/developer/.smithers/claude-install.log 2>/dev/null || true"
    )
    throw new Refused({
      fault: "dependency",
      code: "agent_failed",
      message: `Claude Code failed; workspace ${id} remains.\nWorkspace diagnostics:\n${
        Failure.terminalSafeLines(diagnostics.stdout.toString())
      }`
    })
  }
  const target = str(o.target) || "main",
    revset = `(::@ ~ ::present(bookmarks(exact:${JSON.stringify(target)}))) ~ empty()`
  const changes = await remote(
    c,
    ssh,
    `cd /home/developer/workspace && jj log --ignore-working-copy -r ${quote(revset)} --reversed --no-graph -T ${
      quote("change_id ++ \"\\n\"")
    }`
  )
  if (changes.code) {
    throw new Refused({ fault: "dependency", code: "tool_failed", message: "Could not read workspace changes" })
  }
  const change_ids = lines(changes.stdout.toString())
  if (!change_ids.length) return { workspace_id: id, issue: number, status: "completed", change_ids }
  const landing = object(
    await c.request("POST", repository + "/landings", {
      title: `fix: ${str(issue.title)} (#${number})`,
      body: `Closes #${number}\n\n${str(issue.body)}`,
      target_bookmark: target,
      change_ids
    })
  )
  return { workspace_id: id, issue: number, status: "completed", change_ids, landing_request: landing.number }
}
/**
 * @private
 * @since 1.0.0
 */
export const workspaceSSH = async (c: Client, id: string, options: Values) =>
  sshInfo(c, base(c, options) + `/${esc(id)}`, options.user)
