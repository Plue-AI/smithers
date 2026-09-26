import { spawn } from "node:child_process"
import { createHmac, randomBytes } from "node:crypto"
import { mkdir, readFile, realpath, rename, writeFile } from "node:fs/promises"
import { dirname, isAbsolute, relative, resolve, sep } from "node:path"
import { ReleaseError } from "./schema.ts"

export interface CommandOptions {
  readonly env?: Readonly<Record<string, string>>
  readonly signal?: AbortSignal
}
export type RunCommand = (command: string, args: ReadonlyArray<string>, options?: CommandOptions) => Promise<string>

/** Argument arrays only; subprocess interruption belongs to the action's scope. */
export const commandRunner = (root: string): RunCommand => async (command, args, options = {}) =>
  new Promise((accept, reject) => {
    const child = spawn(command, [...args], {
      cwd: root,
      env: { ...process.env, ...options.env },
      stdio: ["ignore", "pipe", "pipe"],
      signal: options.signal,
      detached: process.platform !== "win32"
    })
    let killTimer: ReturnType<typeof setTimeout> | undefined
    const stop = () => {
      if (!child.pid) return
      const kill = (signal: NodeJS.Signals) => {
        try {
          if (process.platform === "win32") child.kill(signal)
          else process.kill(-child.pid!, signal)
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ESRCH") child.kill(signal)
        }
      }
      kill("SIGTERM")
      killTimer ??= setTimeout(() => kill("SIGKILL"), 1000)
    }
    options.signal?.addEventListener("abort", stop, { once: true })
    let stdout = ""
    let stderr = ""
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString()
      if (stdout.length > 16_000_000) stop()
    })
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(-32_000)
    })
    child.once("error", reject)
    child.once("close", (code) => {
      options.signal?.removeEventListener("abort", stop)
      if (!options.signal?.aborted && killTimer) clearTimeout(killTimer)
      if (code === 0 && stdout.length <= 16_000_000) accept(stdout)
      else {
        // pnpm can report registry failures on stdout. Preserve both streams
        // so a confirmed 404 remains distinguishable from an auth/network error.
        let diagnostic = `${command} exited ${code}: ${stdout.slice(-6000)}\n${stderr.slice(-6000)}`
        for (const [key, value] of Object.entries({ ...process.env, ...options.env })) {
          if (/token|secret|password|api.?key/i.test(key) && value && value.length >= 4) {
            diagnostic = diagnostic.split(value).join("<redacted>")
          }
        }
        reject(new ReleaseError({ step: command, message: diagnostic }))
      }
    })
  })

/** Reject traversal and symlink escapes for existing files and new descendants. */
export const inside = async (root: string, path: string): Promise<string> => {
  if (isAbsolute(path) || path.includes("\\") || path.split("/").some((part) => part === "..")) {
    throw new Error(`Unsafe relative path: ${path}`)
  }
  const base = await realpath(root)
  const target = resolve(base, path)
  if (target === base || !target.startsWith(base + sep)) throw new Error(`Path escapes workspace: ${path}`)
  let existing = target
  for (;;) {
    try {
      const actual = await realpath(existing)
      if (actual !== base && !actual.startsWith(base + sep)) throw new Error(`Symlink escapes workspace: ${path}`)
      return target
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
      existing = dirname(existing)
    }
  }
}

export const atomicWrite = async (root: string, path: string, contents: string | Uint8Array): Promise<void> => {
  const destination = await inside(root, path)
  await mkdir(dirname(destination), { recursive: true })
  const temporary = `${destination}.${randomBytes(8).toString("hex")}.tmp`
  await writeFile(temporary, contents, { flag: "wx" })
  await rename(temporary, destination)
}

export const maybeRead = async (path: string): Promise<string | undefined> => {
  try {
    return await readFile(path, "utf8")
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
    throw error
  }
}

export const json = <A>(text: string): A => JSON.parse(text) as A
export const relativePath = (root: string, path: string) => relative(root, path).split(sep).join("/")

/** OAuth 1.0 signing for the old workflow's optional X publisher. */
export const postTweet = async (text: string, replyTo: string | undefined, signal?: AbortSignal): Promise<string> => {
  const required = ["X_API_KEY", "X_API_SECRET", "X_ACCESS_TOKEN", "X_ACCESS_SECRET"] as const
  for (const name of required) if (!process.env[name]) throw new Error(`Missing ${name}`)
  const escape = (value: string) =>
    encodeURIComponent(value).replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)
  const url = "https://api.x.com/2/tweets"
  const oauth: Record<string, string> = {
    oauth_consumer_key: process.env.X_API_KEY!,
    oauth_nonce: randomBytes(24).toString("hex"),
    oauth_signature_method: "HMAC-SHA1",
    oauth_timestamp: String(Math.floor(Date.now() / 1000)),
    oauth_token: process.env.X_ACCESS_TOKEN!,
    oauth_version: "1.0"
  }
  const parameters = Object.keys(oauth).sort().map((key) => `${escape(key)}=${escape(oauth[key]!)}`).join("&")
  const key = `${escape(process.env.X_API_SECRET!)}&${escape(process.env.X_ACCESS_SECRET!)}`
  oauth.oauth_signature = createHmac("sha1", key).update(`POST&${escape(url)}&${escape(parameters)}`).digest("base64")
  const response = await fetch(url, {
    method: "POST",
    headers: {
      authorization: `OAuth ${
        Object.keys(oauth).sort().map((name) => `${escape(name)}="${escape(oauth[name]!)}"`).join(", ")
      }`,
      "content-type": "application/json"
    },
    body: JSON.stringify({ text, ...(replyTo === undefined ? {} : { reply: { in_reply_to_tweet_id: replyTo } }) }),
    signal: signal ?? AbortSignal.timeout(30_000)
  })
  if (!response.ok) throw new Error(`X rejected the tweet with HTTP ${response.status}`)
  const body = await response.json() as { data?: { id?: string } }
  if (!body.data?.id || !/^\d+$/.test(body.data.id)) {
    throw new Error("X returned no tweet ID; reconcile the pending post before resuming")
  }
  return body.data.id
}
