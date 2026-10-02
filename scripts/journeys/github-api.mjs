import { required } from "./lib.mjs"

// Headers, credentials, request bodies and error bodies are deliberately absent
// from receipts. Request IDs let an operator investigate a rejected call.
export function githubApi({ token, actor = "owner", fetchImpl = fetch, log = async () => {} }) {
  required(token, `GitHub token for ${actor}`)
  return async (method, path, body) => {
    if (!/^\/(?:user|repos\/smithers-mvp-canary\/[A-Za-z0-9_./%-]+)$/.test(path) || /(?:\.\.|%2e|%2f|%5c)/i.test(path)) {
      throw new Error("Refused GitHub API path outside the canary owner")
    }
    await log({ event: "github.request", actor, method, path })
    let response
    try {
      response = await fetchImpl(`https://api.github.com${path}`, {
        method, redirect: "error", signal: AbortSignal.timeout(30_000),
        headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${token}`, "X-GitHub-Api-Version": "2026-03-10", ...(body ? { "Content-Type": "application/json" } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {})
      })
    } catch {
      await log({ event: "github.failure", actor, method, path, reason: "transport" })
      throw new Error(`GitHub ${method} ${path}: transport failed`)
    }
    await log({ event: "github.response", actor, method, path, status: response.status,
      requestId: response.headers?.get("x-github-request-id") ?? null,
      retryAt: response.headers?.get("x-ratelimit-reset") ?? null })
    if (!response.ok) {
      const error = new Error(`GitHub ${method} ${path}: HTTP ${response.status}; authentication and rate limits block the recording`)
      error.status = response.status
      throw error
    }
    if (response.status === 204) return null
    try { return await response.json() } catch {
      await log({ event: "github.failure", actor, method, path, reason: "invalid-json" })
      throw new Error(`GitHub ${method} ${path}: HTTP ${response.status}; invalid JSON response`)
    }
  }
}
