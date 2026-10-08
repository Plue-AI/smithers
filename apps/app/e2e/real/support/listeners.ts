import { spawnSync } from "node:child_process"
import { request } from "node:http"
import { connect as tcpConnect } from "node:net"

/**
 * The listener probe of C-INS-01 (T-INS-04, mvp.md M-28): which TCP sockets
 * an install's processes listen on, and what a connection to one of this
 * Mac's addresses meets. It reads `lsof` and opens plain sockets; it never
 * goes through the browser, so it also answers for addresses and `Host`
 * values no page can reach.
 */

/** One listening TCP socket, as `lsof -nP -iTCP -sTCP:LISTEN` names it. `address` is `*` for every interface. */
export type Listener = { readonly command: string; readonly pid: number; readonly address: string; readonly port: number }

const LSOF = "/usr/sbin/lsof"

/** Parses `lsof -Fpcn` field output: a `p` and `c` line open each process, an `n` line names each socket. */
export const parseListeners = (output: string): Listener[] => {
  const found: Listener[] = []
  let pid = 0
  let command = ""
  for (const line of output.split("\n")) {
    const value = line.slice(1)
    if (line.startsWith("p")) { pid = Number(value); command = "" }
    else if (line.startsWith("c")) command = value
    else if (line.startsWith("n")) {
      const split = value.lastIndexOf(":")
      const port = Number(value.slice(split + 1))
      if (split < 1 || !Number.isInteger(port) || !Number.isInteger(pid) || pid < 1) throw new Error(`Unreadable lsof listener: ${JSON.stringify(line)}`)
      found.push({ command, pid, address: value.slice(0, split).replace(/^\[(.*)\]$/, "$1"), port })
    }
  }
  return found
}

const lsof = (pids: readonly number[], format: readonly string[]): string => {
  if (pids.length === 0 || pids.some(pid => !Number.isInteger(pid) || pid < 1)) throw new Error(`Listener probe needs process ids: ${JSON.stringify(pids)}`)
  const listed = spawnSync(LSOF, ["-nP", "-iTCP", "-sTCP:LISTEN", "-a", "-p", pids.join(","), ...format], { encoding: "utf8" })
  // lsof exits 1 when any process it was asked about lists nothing: one that does not listen, or one that has
  // exited since the tree was read. What the others listen on is still on stdout.
  if (listed.error || (listed.status !== 0 && listed.status !== 1)) throw listed.error ?? new Error(`lsof exited ${listed.status}: ${listed.stderr}`)
  return listed.stdout
}

/** The listening TCP sockets of these processes. */
export const listeners = (pids: readonly number[]): Listener[] => parseListeners(lsof(pids, ["-Fpcn"]))

/** The same listing as `lsof` prints it, kept as evidence. */
export const listenerReport = (pids: readonly number[]): string => lsof(pids, [])

/** Parses `ps -axo pid=,ppid=` into the process ids at and below `root`. */
export const descendants = (root: number, table: string): number[] => {
  const children = new Map<number, number[]>()
  for (const line of table.split("\n")) {
    const [pid, parent] = line.trim().split(/\s+/).map(Number)
    if (pid === undefined || parent === undefined || !Number.isInteger(pid) || !Number.isInteger(parent)) continue
    children.set(parent, [...(children.get(parent) ?? []), pid])
  }
  const tree: number[] = []
  const pending = [root]
  while (pending.length > 0) {
    const pid = pending.pop()!
    if (tree.includes(pid)) continue
    tree.push(pid)
    pending.push(...(children.get(pid) ?? []))
  }
  return tree.sort((a, b) => a - b)
}

/** An install's process tree: its root process and everything it started, without the `ps` that read it. */
export const processTree = (root: number): number[] => {
  const ps = spawnSync("/bin/ps", ["-axo", "pid=,ppid="], { encoding: "utf8" })
  if (ps.error || ps.status !== 0) throw ps.error ?? new Error(`ps exited ${ps.status}: ${ps.stderr}`)
  return descendants(root, ps.stdout).filter(pid => pid !== ps.pid)
}

/** Whether a listener accepts loopback connections only. */
export const loopbackOnly = (listener: Listener): boolean =>
  listener.address === "::1" || /^127\.\d+\.\d+\.\d+$/.test(listener.address)

export type Connection =
  | { readonly outcome: "connected"; readonly banner: string }
  | { readonly outcome: "refused" | "timeout" }

/**
 * Opens one TCP connection. `connected` carries what the server said first
 * within `banner` ms (an SSH server announces itself; HTTP and PostgreSQL
 * wait for the client). `refused` is the kernel's answer for an address with
 * no listener, which is how a loopback-only install meets the LAN.
 */
export const connect = (address: string, port: number, options: { readonly timeout?: number; readonly banner?: number } = {}): Promise<Connection> =>
  new Promise((resolve, reject) => {
    const socket = tcpConnect({ host: address, port, family: 4 })
    let banner = ""
    const settle = (connection: Connection) => { socket.destroy(); resolve(connection) }
    socket.setTimeout(options.timeout ?? 3000, () => settle({ outcome: "timeout" }))
    socket.on("data", chunk => { banner += chunk.toString("latin1") })
    socket.on("connect", () => { setTimeout(() => settle({ outcome: "connected", banner }), options.banner ?? 300) })
    socket.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "ECONNREFUSED") settle({ outcome: "refused" })
      else { socket.destroy(); reject(error) }
    })
  })

export type Exchange = { readonly status: number; readonly headers: Record<string, string | string[] | undefined>; readonly body: string }

/**
 * One plain-HTTP request to `address:port` whose `Host` (and any other
 * header) is exactly what the caller names, so the answer for a host or an
 * `Origin` the owner never set is read off the wire.
 */
export const exchange = (address: string, port: number, options: {
  readonly host: string; readonly method?: string; readonly path?: string
  readonly headers?: Record<string, string>; readonly body?: string
}): Promise<Exchange> =>
  new Promise((resolve, reject) => {
    const outgoing = request({
      host: address, port, family: 4, method: options.method ?? "GET", path: options.path ?? "/", agent: false, timeout: 10_000,
      headers: { ...options.headers, Host: options.host, ...(options.body === undefined ? {} : { "Content-Length": String(Buffer.byteLength(options.body)) }) }
    }, response => {
      const chunks: Buffer[] = []
      response.on("data", chunk => chunks.push(chunk))
      response.on("end", () => resolve({ status: response.statusCode ?? 0, headers: response.headers, body: Buffer.concat(chunks).toString("utf8") }))
      response.on("error", reject)
    })
    outgoing.on("timeout", () => outgoing.destroy(new Error(`No answer from ${address}:${port} for Host ${options.host}`)))
    outgoing.on("error", reject)
    outgoing.end(options.body)
  })
