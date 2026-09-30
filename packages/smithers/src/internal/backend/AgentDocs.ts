/**
 * Local, cached documentation lookup for agent ask; no model or second agent loop.
 * @since 0.1.0
 */

import { mkdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import * as CliError from "../../CliError.ts"
import * as Failure from "../Failure.ts"
import { auth } from "./Auth.ts"
import { APIError, object, refusalOf, str, type Values } from "./Client.ts"
import type { Handler } from "./Resources.ts"
/**
 * @private
 * @since 1.0.0
 */
export const ask: Handler = async (c, a, o) => {
  const prompt = str(a.prompt)
  const capture = async (command: string, args: Array<string>) => {
    try {
      return { ok: true, output: await c.exec(command, args) }
    } catch (error) {
      return { ok: false, error: Failure.operatorSentence(error) }
    }
  }
  const root = await capture("jj", ["root"]),
    jjRemotes = await capture("jj", ["git", "remote", "list"]),
    jjStatus = await capture("jj", ["status"])
  let repoSlug: string | null = null
  try {
    repoSlug = c.repo(o.repo)
  } catch (error) {
    if (o.repo) throw error /* outside checkout */
  }
  let login: Values = {}
  try {
    login = object(await auth["auth status"]!(c, {}, { context: true }))
  } catch { /* context remains useful while signed out */ }
  let remoteRepo: Values = {
    checked: false,
    message: repoSlug ? "Skipped because Smithers auth is unavailable" : "No Smithers repo detected"
  }
  if (repoSlug && login.logged_in) {
    try {
      await c.request("GET", c.repoPath(repoSlug))
      remoteRepo = { checked: true, available: true }
    } catch (error) {
      remoteRepo = {
        checked: true,
        available: false,
        message: Failure.operatorSentence(error instanceof APIError ? refusalOf(error, (v) => c.redact(v)) : error)
      }
    }
  }
  const warnings = [
    ...(!repoSlug ? ["Could not determine the current Smithers repository from local remotes."] : []),
    ...(!root.ok ? ["No local jj repository was detected from the current working directory."] : []),
    ...(!jjRemotes.ok ? ["Failed to collect jj git remote list"] : []),
    ...(!jjStatus.ok ? ["Failed to collect jj status"] : [])
  ]
  const repo_context: Values = {
    collectedAt: new Date().toISOString(),
    cwd: process.cwd(),
    repoRoot: root.output || null,
    repoSlug,
    repoSource: o.repo ? "override" : repoSlug ? "detected" : "unavailable",
    jjRemotes,
    jjStatus,
    auth: {
      loggedIn: login.logged_in === true,
      host: login.host || "",
      message: login.logged_in ? "Logged in" : "Not logged in",
      verified: login.logged_in === true && login.verified !== false,
      ...(login.username ? { user: login.username } : {}),
      ...(login.token_source ? { tokenSource: login.token_source } : {})
    },
    remoteRepo,
    warnings,
    backend: { backend: "local", cwd: root.output || process.cwd() }
  }
  const url = c.env.SMITHERS_AGENT_DOCS_URL || "https://smithers.sh/llms-full.txt"
  if (!prompt) {
    return {
      backend: "local",
      repo_context,
      docs_status: {
        url,
        status: "unavailable",
        source: "none",
        warning: "Smithers docs refresh was skipped for lightweight summary mode."
      }
    }
  }
  const cache = join(
    c.env.XDG_CACHE_HOME ||
      (process.platform === "darwin" ? join(c.home, "Library", "Caches") : join(c.home, ".cache")),
    "smithers",
    "agent",
    "docs"
  )
  let text = "", metadata: Values = {}, status: Values = { url, status: "unavailable", source: "none" }
  try {
    metadata = object(JSON.parse(await readFile(join(cache, "llms-full.json"), "utf8")))
    if (metadata.url === url) text = await readFile(join(cache, "llms-full.txt"), "utf8")
  } catch { /* no cache */ }
  try {
    const response = await fetch(url, {
      headers: {
        ...(metadata.etag ? { "if-none-match": str(metadata.etag) } : {}),
        ...(metadata.lastModified ? { "if-modified-since": str(metadata.lastModified) } : {})
      },
      signal: AbortSignal.timeout(Number(c.env.SMITHERS_AGENT_DOCS_TIMEOUT_MS) || 3000)
    })
    if (response.status === 304 && text) {
      status = { url, status: "fresh", source: "cache", fetchedAt: metadata.fetchedAt }
    } else {
      if (!response.ok) {
        throw new CliError.Refused({
          fault: "dependency",
          code: "docs_unavailable",
          message: `the docs server answered HTTP ${response.status}`
        })
      }
      text = await c.text(response, 32 * 1024 * 1024)
      metadata = {
        url,
        fetchedAt: new Date().toISOString(),
        etag: response.headers.get("etag"),
        lastModified: response.headers.get("last-modified")
      }
      status = { ...metadata, status: "fresh", source: "network" }
      await mkdir(cache, { recursive: true })
      await writeFile(join(cache, "llms-full.txt"), text)
      await writeFile(join(cache, "llms-full.json"), JSON.stringify(metadata))
    }
  } catch (error) {
    status = {
      url,
      status: text ? "stale" : "unavailable",
      source: text ? "cache" : "none",
      warning: Failure.isDesigned(error)
        ? `Docs refresh failed: ${Failure.operatorSentence(error)}`
        : "Docs refresh failed"
    }
  }
  const chunks: Array<{ id: string; title: string; lineStart: number; lineEnd: number; text: string }> = []
  let title = "Smithers Docs", buffer: Array<string> = [], start = 1
  const headings: Array<string> = []
  const flush = (end: number) => {
    if (buffer.join("\n").trim()) {
      chunks.push({ id: String(chunks.length), title, lineStart: start, lineEnd: end, text: buffer.join("\n").trim() })
    }
    buffer = []
    start = end + 1
  }
  const sourceLines = text.replaceAll("\r\n", "\n").split("\n")
  for (const [index, line] of sourceLines.entries()) {
    const heading = /^(#{1,6}) (.+)$/.exec(line.trim())
    if (heading) {
      flush(index)
      headings.length = heading[1]!.length
      headings[headings.length - 1] = heading[2]!
      title = headings.filter(Boolean).join(" > ")
      start = index + 1
      continue
    }
    if (buffer.length && [...buffer, line].join("\n").length > 1500) flush(index)
    buffer.push(line)
  }
  flush(sourceLines.length)
  const normalized = prompt.trim().toLowerCase(),
    tokens = [...new Set(normalized.split(/[^a-z0-9_./:-]+/).filter((token) => token.length >= 2))]
  const count = (text: string, token: string) => text.split(token).length - 1
  const docs_results = chunks.map((chunk) => {
    const body = chunk.text.toLowerCase(), title = chunk.title.toLowerCase()
    const score = (title.includes(normalized) ? 12 : 0) + (body.includes(normalized) ? 8 : 0) +
      tokens.reduce((sum, token) => sum + count(title, token) * 5 + count(body, token), 0)
    const first = tokens.map((token) => body.indexOf(token)).find((index) => index >= 0) || 0
    const line = body.slice(0, first).split("\n").length - 1
    return {
      id: chunk.id,
      title: chunk.title,
      lineStart: chunk.lineStart,
      lineEnd: chunk.lineEnd,
      score,
      snippet: chunk.text.split("\n").slice(Math.max(0, line - 2), line + 10).join("\n")
    }
  }).filter((result) => result.score > 0).sort((a, b) => b.score - a.score).slice(0, 4)
  return {
    backend: "local",
    repo_context,
    docs_status: status,
    docs_results,
    response: docs_results.length
      ? docs_results.map((result, index) =>
        `[${index + 1}] ${result.title} (lines ${result.lineStart}-${result.lineEnd})\n${result.snippet}`
      ).join("\n\n")
      : str(status.warning) || "No Smithers docs sections matched the prompt"
  }
}
