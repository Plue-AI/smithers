/**
 * Validated SSH transport and durable guest command receipts.
 * @since 0.1.0
 */

import { createHash, randomUUID } from "node:crypto"
import { mkdir } from "node:fs/promises"
import { join } from "node:path"
import type { Readable } from "node:stream"
import { finished } from "node:stream/promises"
import { setTimeout as delay } from "node:timers/promises"
import type { Client } from "./Client.ts"
import { spawn } from "./Process.ts"
/**
 * @private
 * @since 1.0.0
 */
export const quote = (text: string): string => `'${text.replaceAll("'", `'"'"'`)}'`
/**
 * @private
 * @since 1.0.0
 */
export const sshArgs = async (c: Client, command: string, tty = false): Promise<Array<string>> => {
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
  if (quoting || escaped) throw new Error("Invalid SSH quoting")
  if (token) words.push(token)
  if (!["ssh", "ssh.exe"].includes(words.shift()?.toLowerCase() || "")) {
    throw new Error("Workspace SSH executable must be ssh")
  }
  let destination = false
  for (let i = 0; i < words.length; i++) {
    const word = words[i]!
    if (word.startsWith("-o")) {
      const directive = word.slice(2) || words[++i] || "", [key, value, ...rest] = directive.trim().split(/[=\s]+/)
      if (!key || !value || rest.length) throw new Error("Invalid workspace SSH option")
      if (["serveraliveinterval", "serveralivecountmax", "connecttimeout"].includes(key.toLowerCase())) {
        if (!/^\d+$/.test(value)) {
          throw new Error("Invalid SSH timeout")
        }
      } else if (["batchmode", "identitiesonly", "tcpkeepalive", "compression"].includes(key.toLowerCase())) {
        if (!["yes", "no"].includes(value)) {
          throw new Error("Invalid SSH boolean")
        }
      } else throw new Error(`Workspace SSH may not set ${key}`)
    } else if (["-4", "-6", "-t", "-tt", "-T"].includes(word)) continue
    else if (word.startsWith("-")) {
      if (!/^-[pil]/.test(word)) throw new Error("Unsupported SSH flag")
      const value = word.slice(2) || words[++i] || ""
      if (!value || /[\r\n\0]/.test(value)) throw new Error("Invalid SSH argument")
      if (word[1] === "p" && (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 65535)) {
        throw new Error("Invalid SSH port")
      }
      if (word[1] === "l" && !/^[\w.-]+$/.test(value)) throw new Error("Invalid SSH user")
    } else {
      if (destination || !/^[A-Za-z0-9._+@[\]:-]+$/.test(word)) {
        throw new Error("SSH requires one destination and no remote command")
      }
      destination = true
    }
  }
  if (!destination) throw new Error("SSH destination required")
  const directory = join(c.env.XDG_STATE_HOME || join(c.home, ".local", "state"), "smithers")
  await mkdir(directory, { recursive: true, mode: 0o700 })
  return [
    ...(tty ? ["-tt"] : []),
    "-o",
    "BatchMode=yes",
    "-o",
    `ConnectTimeout=${Number(c.env.SMITHERS_WORKSPACE_SSH_CONNECT_TIMEOUT_SECONDS) || 15}`,
    "-o",
    "StrictHostKeyChecking=accept-new",
    "-o",
    `UserKnownHostsFile=${join(directory, "known_hosts")}`,
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
  command: string,
  script: string | undefined,
  timeout = 120_000,
  input?: Readable,
  interactive = false,
  stream = false
): Promise<{ code: number; stdout: Buffer; stderr: Buffer }> => {
  const args = await sshArgs(c, command, interactive)
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
  if (input) input.pipe(child.stdin!)
  else child.stdin?.end()
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
        if (expired) throw new Error("Workspace exec timed out")
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

const workspaceExecLoginHome =
  "if [ -n \"$HOME\" ] && [ ! -w \"$HOME\" ] && [ -n \"$smithers_login_home\" ] && [ \"$smithers_login_home\" != \"$HOME\" ] && [ -w \"$smithers_login_home\" ]; then " +
  "old_home=$HOME; for k in $(env | sed -n 's/^\\([A-Za-z_][A-Za-z0-9_]*\\)=.*/\\1/p'); do eval \"v=\\${$k}\"; " +
  "case \"$v\" in \"$old_home\"|\"$old_home\"/*) export \"$k=$smithers_login_home${v#\"$old_home\"}\";; esac; done; " +
  "new_path=; set -f; saved_ifs=$IFS; IFS=:; for p in $PATH; do case \"$p\" in \"$old_home\"|\"$old_home\"/*) p=\"$smithers_login_home${p#\"$old_home\"}\";; esac; new_path=\"${new_path:+$new_path:}$p\"; done; IFS=$saved_ifs; set +f; " +
  "export PATH=\"$new_path\"; unset old_home k v p new_path saved_ifs; fi; "
/** @private
 * @since 0.1.0
 */
export const durable = async (
  c: Client,
  id: string,
  script: string,
  transport: (request: string) => Promise<string>,
  timeout: number,
  interval = 1000
) => {
  id ||= randomUUID()
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(id)) throw new Error("Invalid exec id")
  const digest = createHash("sha256").update(script).digest("hex")
  const profile = quote("/etc/profile.d/00-smithers-runtime.sh")
  const stateDir =
    "smithers_login_home=$(getent passwd \"$(id -u)\" 2>/dev/null | cut -d: -f6); [ -n \"$smithers_login_home\" ] || smithers_login_home=$HOME; base=\"$smithers_login_home/.local/state/smithers/exec\"; "
  const runner = stateDir + "mkdir -p \"$base\" || exit; d=\"$base/\"" + quote(id) +
    "; mkdir -p \"$d\" || exit; printf %s " + quote(digest) +
    " >\"$d/digest.tmp\"; mv \"$d/digest.tmp\" \"$d/digest\"; " +
    "if [ -r " + profile + " ]; then . " + profile + " >/dev/null 2>&1; fi; " + workspaceExecLoginHome +
    "bash -c " + quote(script) +
    " </dev/null >\"$d/out\" 2>\"$d/err\"; rc=$?; printf '%s\\n' \"$rc\" >\"$d/exit.tmp\"; mv \"$d/exit.tmp\" \"$d/exit\""
  let outOffset = 0, errOffset = 0, attached = false
  const stdout: Array<Buffer> = [], stderr: Array<Buffer> = [], deadline = timeout > 0 ? Date.now() + timeout : Infinity
  for (;;) {
    if (Date.now() >= deadline || c.runtime.signal?.aborted) {
      throw new Error(`Workspace exec interrupted; guest continues. Reattach with --exec-id ${id}`)
    }
    const attachedTest = attached ? "true" : "false"
    const request = stateDir +
      "if [ -z \"$smithers_login_home\" ] || ! mkdir -p \"$base\" 2>/dev/null; then printf 'ERROR: guest exec state directory is not writable\\n'; exit 0; fi; d=\"$base/\"" +
      quote(id) + "; " +
      "current_boot=$(cat /proc/sys/kernel/random/boot_id 2>/dev/null || hostname 2>/dev/null); if [ -z \"$current_boot\" ]; then printf 'ERROR: guest boot identity is unavailable\\n'; exit 0; fi; created=0; lost_reason=; " +
      "if [ -d \"$d\" ]; then if [ ! -f \"$d/digest\" ] || [ \"$(cat \"$d/digest\")\" != " + quote(digest) +
      " ]; then printf 'CONFLICT\\n'; exit 0; fi; " +
      "elif " + attachedTest + "; then lost_reason=state_gone; " +
      "else if ! mkdir \"$d\" 2>/dev/null; then printf 'CONFLICT\\n'; exit 0; fi; created=1; printf %s " +
      quote(digest) +
      " >\"$d/digest.tmp\" && mv \"$d/digest.tmp\" \"$d/digest\"; printf '%s\\n' \"$current_boot\" >\"$d/boot_id.tmp\" && mv \"$d/boot_id.tmp\" \"$d/boot_id\"; fi; " +
      "if [ \"$created\" = 0 ] && [ -z \"$lost_reason\" ] && [ ! -f \"$d/exit\" ]; then if [ -f \"$d/boot_id\" ] && [ \"$(cat \"$d/boot_id\")\" != \"$current_boot\" ]; then lost_reason=guest_restarted; elif [ ! -f \"$d/pid\" ] || ! kill -0 \"$(cat \"$d/pid\")\" 2>/dev/null; then [ -f \"$d/exit\" ] || lost_reason=runner_gone; fi; fi; " +
      "if [ \"$created\" = 1 ]; then if mkdir \"$d/.launch\" 2>/dev/null; then detach=; command -v setsid >/dev/null 2>&1 && detach=setsid; nohup $detach bash -c " +
      quote(runner) +
      " </dev/null >/dev/null 2>&1 & pid=$!; printf '%s\\n' \"$pid\" >\"$d/pid.tmp\"; mv \"$d/pid.tmp\" \"$d/pid\"; rmdir \"$d/.launch\" 2>/dev/null || true; fi; fi; " +
      "if [ -f \"$d/digest\" ] && [ \"$(cat \"$d/digest\")\" != " + quote(digest) +
      " ]; then printf 'CONFLICT\\n'; exit 0; fi; " +
      "printf 'SMITHERS_EXEC_V1\\n'; if [ -n \"$lost_reason\" ]; then printf 'lost:%s\\n' \"$lost_reason\"; elif [ -f \"$d/exit\" ]; then cat \"$d/exit\"; else printf 'running\\n'; fi; " +
      "if [ -f \"$d/out\" ]; then tail -c +%d \"$d/out\" | head -c 65536 | base64 | tr -d '\\n'; fi; printf '\\n'; "
        .replace("%d", String(outOffset + 1)) +
      "if [ -f \"$d/err\" ]; then tail -c +%d \"$d/err\" | head -c 65536 | base64 | tr -d '\\n'; fi; printf '\\nEND\\n'"
        .replace("%d", String(errOffset + 1))
    let response: string
    try {
      response = await transport(request)
    } catch {
      await delay(interval, undefined, { signal: c.runtime.signal })
      continue
    }
    if (response.startsWith("ERROR:")) throw new Error(response.trim())
    if (response.trim() === "CONFLICT") throw new Error(`Exec id ${id} belongs to another command`)
    const fields = response.split("\n")
    if (fields.length !== 6 || fields[0] !== "SMITHERS_EXEC_V1" || fields[4] !== "END" || fields[5] !== "") {
      throw new Error(`Invalid exec receipt for ${id}`)
    }
    attached = true
    const decode = (value: string) => {
      if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
        throw new Error("Invalid exec output")
      }
      return Buffer.from(value, "base64")
    }
    const out = decode(fields[2]!), err = decode(fields[3]!)
    stdout.push(out)
    stderr.push(err)
    c.output(out, err)
    outOffset += out.length
    errOffset += err.length
    if (fields[1]!.startsWith("lost:")) {
      c.runtime.exit?.(125)
      throw new Error(`exec_outcome_lost: ${fields[1]!.slice(5)} for ${id}; command may have partially run`)
    }
    if (fields[1] !== "running" && out.length < 65536 && err.length < 65536) {
      const code = Number(fields[1])
      if (!/^\d+$/.test(fields[1]!) || code > 255) throw new Error("Invalid guest exit status")
      return { code, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) }
    }
    if (out.length < 65536 && err.length < 65536) await delay(interval, undefined, { signal: c.runtime.signal })
  }
}
