/**
 * The report another account recorded for a public repository at its current
 * commit (`Registration.Report` on `/api/workflow/rpc`, #3239): the TUI shows
 * it as the cached result and launches nothing. No answer, a refusal or a
 * malformed report is no report.
 */
export interface CachedReport {
  readonly repo: string
  readonly commit: string
  readonly report: Record<string, unknown>
}

export interface Lookup {
  readonly baseUrl: string
  readonly fetch: (url: string, init?: RequestInit) => Promise<Response>
  /** The Smithers Cloud repository (and its box) the call is made on. */
  readonly cloudRepo: string
  readonly workspaceId: string
  /** The public GitHub repository, `owner/name`. */
  readonly repo: string
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

/** The cached report of `repo`, else undefined (also when the read fails). */
export const lookup = async (input: Lookup): Promise<CachedReport | undefined> => {
  try {
    const repo = input.repo.toLowerCase()
    const response = await input.fetch(`${input.baseUrl}/api/workflow/rpc`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ repo: input.cloudRepo, procedure: "Registration.Report", payload: { repo }, workspaceId: input.workspaceId })
    })
    if (!response.ok) return undefined
    const body: unknown = await response.json()
    if (!isRecord(body) || body["ok"] !== true || !isRecord(body["payload"])) return undefined
    const shared = body["payload"]["report"]
    if (!isRecord(shared) || typeof shared["commit"] !== "string" || shared["commit"] === "") return undefined
    const report = shared["report"]
    if (!isRecord(report) || report["repo"] !== repo) return undefined
    return { repo, commit: shared["commit"], report }
  } catch {
    return undefined
  }
}

/** The one line marking a cached result: where it came from. */
export const label = (cached: CachedReport): string => `Cached · ${cached.commit.slice(0, 7)}`
