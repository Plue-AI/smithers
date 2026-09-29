/**
 * Validated SSH transport.
 * @since 0.1.0
 */

import { createHash, randomUUID } from "node:crypto"
import { mkdir, rename, writeFile } from "node:fs/promises"
import { join } from "node:path"
import type { Readable } from "node:stream"
import { finished } from "node:stream/promises"
import { Refused } from "../../CliError.ts"
import * as Failure from "../Failure.ts"
import type { Client } from "./Client.ts"
import { spawn } from "./Process.ts"
/**
 * @private
 * @since 1.0.0
 */
export const quote = (text: string): string => `'${text.replaceAll("'", `'"'"'`)}'`
/**
 * A workspace SSH endpoint as the authenticated API answers it: the command and
 * the gateway host keys (`algorithm base64`) it advertises.
 *
 * @private
 * @since 1.0.0
 */
export interface Endpoint {
  readonly command: string
  readonly hostKeys: ReadonlyArray<string>
}
const hostKeyAlias = "smithers-workspace"
// The endpoint comes from the backend: a malformed one is the backend's
// fault, and connecting anyway would trust it.
const endpointRefused = (message: string) => new Refused({ fault: "infra", code: "ssh_endpoint_refused", message })
/**
 * The advertised host keys of an API `/ssh` response, validated as
 * `algorithm base64` pairs.
 *
 * @private
 * @since 1.0.0
 */
export const hostKeys = (value: unknown): Array<string> =>
  (Array.isArray(value) ? value : []).map((entry) => {
    const key = entry !== null && typeof entry === "object" ? entry as Record<string, unknown> : {}
    const line = typeof key.known_hosts_line === "string" && key.known_hosts_line.trim()
      ? key.known_hosts_line.trim()
      : `${String(key.algorithm ?? "")} ${String(key.public_key ?? "")}`
    if (!/^[a-z0-9@.-]+ [A-Za-z0-9+/]+={0,2}$/.test(line)) throw endpointRefused("Invalid workspace SSH host key")
    return line
  })
/**
 * @private
 * @since 1.0.0
 */
export const sshArgs = async (c: Client, endpoint: Endpoint, tty = false): Promise<Array<string>> => {
  const command = endpoint.command
  // The gateway must prove a key the authenticated API advertised; never trust on first use.
  if (endpoint.hostKeys.length === 0) throw endpointRefused("Workspace SSH host keys unavailable; refusing to connect")
  const words: Array<string> = []
  let token = "", quoting = "", escaped = false
  for (const char of command) {
    if (escaped) {
      token += char
      escaped = false
    } else if (char === "\\" && quoting !== "'") escaped = true
    else if (quoting) {
      if (char === quoting) quoting = ""
      else token += char
    } else if (char === "'" || char === "\"") quoting = char
    else if (/\s/.test(char)) {
      if (token) words.push(token)
      token = ""
    } else token += char
  }
  if (quoting || escaped) throw endpointRefused("Invalid SSH quoting")
  if (token) words.push(token)
  if (!["ssh", "ssh.exe"].includes(words.shift()?.toLowerCase() || "")) {
    throw endpointRefused("Workspace SSH executable must be ssh")
  }
  let destination = false
  for (let i = 0; i < words.length; i++) {
    const word = words[i]!
    if (word.startsWith("-o")) {
      const directive = word.slice(2) || words[++i] || "", [key, value, ...rest] = directive.trim().split(/[=\s]+/)
      if (!key || !value || rest.length) throw endpointRefused("Invalid workspace SSH option")
      if (["serveraliveinterval", "serveralivecountmax", "connecttimeout"].includes(key.toLowerCase())) {
        if (!/^\d+$/.test(value)) {
          throw endpointRefused("Invalid SSH timeout")
        }
      } else if (["batchmode", "identitiesonly", "tcpkeepalive", "compression"].includes(key.toLowerCase())) {
        if (!["yes", "no"].includes(value)) {
          throw endpointRefused("Invalid SSH boolean")
        }
      } else throw endpointRefused(`Workspace SSH may not set ${Failure.terminalSafe(key)}`)
    } else if (["-4", "-6", "-t", "-tt", "-T"].includes(word)) continue
    else if (word.startsWith("-")) {
      if (!/^-[pil]/.test(word)) throw endpointRefused("Unsupported SSH flag")
      const value = word.slice(2) || words[++i] || ""
      if (!value || /[\r\n\0]/.test(value)) throw endpointRefused("Invalid SSH argument")
      if (word[1] === "p" && (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 65535)) {
        throw endpointRefused("Invalid SSH port")
      }
      if (word[1] === "l" && !/^[\w.-]+$/.test(value)) throw endpointRefused("Invalid SSH user")
    } else {
      if (destination || !/^[A-Za-z0-9._+@[\]:-]+$/.test(word)) {
        throw endpointRefused("SSH requires one destination and no remote command")
      }
      destination = true
    }
  }
  if (!destination) throw endpointRefused("SSH destination required")
  const directory = join(c.env.XDG_STATE_HOME || join(c.home, ".local", "state"), "smithers")
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const lines = endpoint.hostKeys.map((key) => `${hostKeyAlias} ${key}\n`).join("")
  const knownHosts = join(
    directory,
    `workspace-known-hosts-${createHash("sha256").update(lines).digest("hex").slice(0, 16)}`
  )
  const temporary = `${knownHosts}.${randomUUID()}.tmp`
  await writeFile(temporary, lines, { mode: 0o600 })
  await rename(temporary, knownHosts)
  return [
    ...(tty ? ["-tt"] : []),
    "-o",
    "BatchMode=yes",
    "-o",
    `ConnectTimeout=${Number(c.env.SMITHERS_WORKSPACE_SSH_CONNECT_TIMEOUT_SECONDS) || 15}`,
    "-o",
    "StrictHostKeyChecking=yes",
    "-o",
    `HostKeyAlias=${hostKeyAlias}`,
    "-o",
    `UserKnownHostsFile=${knownHosts}`,
    "-o",
    "GlobalKnownHostsFile=/dev/null",
    "-o",
    "LogLevel=ERROR",
    "-o",
    "ServerAliveInterval=30",
    "-o",
    "ServerAliveCountMax=10",
    ...words
  ]
}
/**
 * @private
 * @since 1.0.0
 */
export const remote = async (
  c: Client,
  endpoint: Endpoint,
  script: string | undefined,
  timeout = 120_000,
  input?: Readable,
  interactive = false,
  stream = false
): Promise<{ code: number; stdout: Buffer; stderr: Buffer }> => {
  const args = await sshArgs(c, endpoint, interactive)
  if (script !== undefined) args.push(script)
  const child = spawn("ssh", args, {
    env: c.env,
    stdio: interactive ? "inherit" : "pipe",
    signal: c.runtime.signal
  })
  const stdout: Array<Buffer> = [], stderr: Array<Buffer> = []
  child.stdout?.on("data", (chunk: Buffer) => {
    stdout.push(chunk)
    if (stream) c.output(chunk, Buffer.alloc(0))
  })
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr.push(chunk)
    if (stream) c.output(Buffer.alloc(0), chunk)
  })
  // `pipe` forwards no source error: a failed stdin source stops the guest
  // and is the result, rather than leaving it waiting for end of input.
  let inputError: unknown
  if (input) {
    input.on("error", (error) => {
      inputError ??= error
      child.kill()
    })
    input.pipe(child.stdin!)
  } else child.stdin?.end()
  let expired = false
  const timer = timeout > 0
    ? setTimeout(() => {
      expired = true
      child.kill()
    }, timeout)
    : undefined
  try {
    // Output is complete once both streams end, not when the exit arrives.
    const [code] = await Promise.all([
      child.exited.catch((error: unknown) => {
        if (inputError !== undefined) throw inputError
        if (expired) throw new Refused({ fault: "user", code: "timed_out", message: "Workspace exec timed out" })
        throw error
      }),
      child.stdout && finished(child.stdout),
      child.stderr && finished(child.stderr)
    ])
    return { code, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) }
  } finally {
    clearTimeout(timer)
  }
}
