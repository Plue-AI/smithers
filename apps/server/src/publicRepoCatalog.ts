/** The private-alpha catalog shared by the public site and the app backend. */
export const PUBLIC_REPOS_PATH = "/api/public/repos"

/**
 * Availability is curated; submitting a request never adds a repository here.
 * At launch only Smithers is available. The roster grows as maintainers sign
 * in with GitHub and install the Smithers GitHub App on their repositories.
 * The catalog order is the response order.
 */
export const AVAILABLE_REPOS = [
  {
    name: "smithersai/smithers",
    title: "Smithers",
    url: "https://github.com/smithersai/smithers",
    // The one-sentence explanation the app's welcome reads. Curated, never fetched.
    summary: "Smithers is a durable workflow framework that lets agents plan, run, and review changes to a code repository.",
    // The Smithers Cloud mirror namespace that answers anonymous reads. The
    // backend serves the public mirror under this path and refuses the GitHub
    // name without credentials. Never part of the public catalog response.
    cloudRepo: "smithers-canary/smithers"
  }
] as const

/**
 * Repositories the landing page shows as coming soon: Smithers' direct
 * production dependencies and the VCS the engine runs on. One opens when its
 * maintainers register it — sign in with GitHub, then install the Smithers
 * GitHub App on the repository. Until then no reader treats them as available:
 * the Worker's routed app page and the Cloud mirror lookup only consult
 * AVAILABLE_REPOS. The order here is the response and card order.
 */
export const COMING_SOON_REPOS = [
  { name: "Effect-TS/effect", title: "Effect", url: "https://github.com/Effect-TS/effect" },
  { name: "wevm/incur", title: "incur", url: "https://github.com/wevm/incur" },
  { name: "bombshell-dev/clack", title: "clack", url: "https://github.com/bombshell-dev/clack" },
  { name: "jj-vcs/jj", title: "jj", url: "https://github.com/jj-vcs/jj" },
  // Second-ring dependencies: incur depends on the MCP SDK; jj depends on gitoxide.
  { name: "modelcontextprotocol/typescript-sdk", title: "MCP TypeScript SDK", url: "https://github.com/modelcontextprotocol/typescript-sdk" },
  { name: "GitoxideLabs/gitoxide", title: "gitoxide", url: "https://github.com/GitoxideLabs/gitoxide" },
  // The web app's own dependencies: its client store, flow canvas, desktop shell, and docs theme.
  { name: "TanStack/db", title: "TanStack DB", url: "https://github.com/TanStack/db" },
  { name: "xyflow/xyflow", title: "xyflow", url: "https://github.com/xyflow/xyflow" },
  { name: "blackboardsh/electrobun", title: "Electrobun", url: "https://github.com/blackboardsh/electrobun" },
  { name: "withastro/starlight", title: "Starlight", url: "https://github.com/withastro/starlight" }
] as const

export interface PublicRepoStats {
  readonly stars: number
  readonly forks: number
  /** GitHub's open_issues_count includes both issues and pull requests. */
  readonly openIssuesAndPulls: number
  readonly language: string | null
  readonly license: string | null
}

export interface PublicRepository {
  readonly name: string
  readonly title: string
  readonly url: string
  /** The curated one-sentence explanation of what the repository is. */
  readonly summary: string
  readonly stats: PublicRepoStats | null
}

/** A coming-soon repository has no app to open, so it carries no summary. */
export interface PublicComingSoonRepository {
  readonly name: string
  readonly title: string
  readonly url: string
  readonly stats: PublicRepoStats | null
}

export interface PublicRepoCatalog {
  readonly repos: ReadonlyArray<PublicRepository>
  /** Follows `repos`; absent from responses served before this field shipped. */
  readonly comingSoon?: ReadonlyArray<PublicComingSoonRepository>
}
