/** Pull-request analyses over GitHub REST rows. Pure: the host reads, these decide. */
import type { CiEstimate, Intake } from "./schema.ts"
import { cla, contributing, read, type Tree } from "./tree.ts"

export interface Pull {
  readonly number: number
  readonly title: string
  readonly body: string
  readonly external: boolean
  readonly created: number
  readonly merged: number | null
  readonly closed: number | null
}

const INTERNAL = new Set(["OWNER", "MEMBER", "COLLABORATOR"])
const object = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {}
const time = (value: unknown) =>
  typeof value === "string" && !Number.isNaN(Date.parse(value)) ? Date.parse(value) / 1000 : null

export const parsePulls = (value: unknown): ReadonlyArray<Pull> =>
  (Array.isArray(value) ? value : []).flatMap((entry) => {
    const row = object(entry)
    if (typeof row.number !== "number" || typeof row.title !== "string") return []
    const author = object(row.user)
    const bot = typeof author.type === "string" && author.type === "Bot"
    return [{
      number: row.number,
      title: row.title.slice(0, 200),
      body: typeof row.body === "string" ? row.body.slice(0, 1500) : "",
      external: !bot && !INTERNAL.has(String(row.author_association)),
      created: time(row.created_at) ?? 0,
      merged: time(row.merged_at),
      closed: time(row.closed_at)
    }]
  })

/** Hours from opening to the first review, from `/pulls/{n}/reviews` rows. */
export const firstReviewHours = (pull: Pull, reviews: unknown): number | null => {
  const times = (Array.isArray(reviews) ? reviews : []).flatMap((entry) => time(object(entry).submitted_at) ?? [])
  return times.length === 0 ? null : Math.max(0, (Math.min(...times) - pull.created) / 3600)
}

const median = (values: ReadonlyArray<number>) => {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2
}

export const CONTRIBUTION_OPTIONS = ["Open, reviewed", "Open, unreviewed", "Maintainers only"] as const

export const intake = (tree: Tree, pulls: ReadonlyArray<Pull>, reviewHours: ReadonlyArray<number>): Intake => {
  const closed = pulls.filter((pull) => pull.closed !== null)
  const external = pulls.filter((pull) => pull.external)
  const merged = closed.filter((pull) => pull.merged !== null).length
  const reviewed = reviewHours.length > 0
  const chosen = external.length === 0 || external.length / Math.max(1, pulls.length) < 0.05
    ? CONTRIBUTION_OPTIONS[2]
    : reviewed
    ? CONTRIBUTION_OPTIONS[0]
    : CONTRIBUTION_OPTIONS[1]
  const hours = median(reviewHours)
  return {
    _tag: "intake",
    choice: {
      options: [chosen, ...CONTRIBUTION_OPTIONS.filter((option) => option !== chosen)].slice(0, 2),
      chosen,
      by: "detected",
      evidence: [`${external.length} of ${pulls.length} recent pull requests from outside contributors`]
    },
    pulls: pulls.length,
    external: external.length,
    merged,
    firstReviewHours: hours === null ? null : Math.round(hours * 10) / 10,
    contributing: contributing(tree),
    cla: cla(tree)
  }
}

// ---- CI estimate -------------------------------------------------------------

export interface WorkspacePackage {
  readonly name: string
  readonly dir: string
  readonly dependencies: ReadonlyArray<string>
}

/** A workspace glob as a directory pattern: `**` spans segments, `*` stays inside one. */
const glob = (pattern: string) =>
  new RegExp(
    `^${
      pattern.replace(/\/$/, "").split("**").map((part) =>
        part.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]+")
      ).join(".*")
    }$`
  )

/** Workspace packages from npm/pnpm/yarn workspaces, Cargo workspace members, or nested go modules. */
export const workspacePackages = (tree: Tree): ReadonlyArray<WorkspacePackage> => {
  const root = (() => {
    try {
      return object(JSON.parse(read(tree, "package.json") ?? "{}"))
    } catch {
      return {}
    }
  })()
  const declared = Array.isArray(root.workspaces) ? root.workspaces : Array.isArray(object(root.workspaces).packages)
    ? object(root.workspaces).packages as Array<unknown>
    : []
  const pnpm = [...(read(tree, "pnpm-workspace.yaml") ?? "").matchAll(/^\s*-\s*['"]?([^'"\n#]+?)['"]?\s*$/gm)].map((
    match
  ) => match[1]!)
  const cargo = [
    ...((/\[workspace\][\s\S]*?members\s*=\s*\[([\s\S]*?)\]/.exec(read(tree, "Cargo.toml") ?? "")?.[1]) ?? "").matchAll(
      /"([^"]+)"/g
    )
  ]
    .map((match) => match[1]!)
  const patterns = [...declared.filter((entry): entry is string => typeof entry === "string"), ...pnpm, ...cargo]
    .filter((pattern) => !pattern.startsWith("!"))
    .map(glob)
  const manifests = tree.paths.filter((path) =>
    /(^|\/)(package\.json|Cargo\.toml|go\.mod)$/.test(path) && path.includes("/")
  )
  return manifests.flatMap((path) => {
    const dir = path.slice(0, path.lastIndexOf("/"))
    if (/node_modules|vendor|fixtures?\//.test(dir)) return []
    if (!path.endsWith("go.mod") && !patterns.some((pattern) => pattern.test(dir))) return []
    const text = read(tree, path) ?? ""
    if (path.endsWith("package.json")) {
      try {
        const manifest = object(JSON.parse(text))
        const dependencies = [manifest.dependencies, manifest.devDependencies].flatMap((value) =>
          Object.keys(object(value))
        )
        return [{ name: typeof manifest.name === "string" ? manifest.name : dir, dir, dependencies }]
      } catch {
        return [{ name: dir, dir, dependencies: [] }]
      }
    }
    return [{
      name: /^\s*name\s*=\s*"([^"]+)"/m.exec(text)?.[1] ?? /^module\s+(\S+)/m.exec(text)?.[1] ?? dir,
      dir,
      dependencies: []
    }]
  })
}

/** Packages whose sources changed, plus every package that depends on one of them. */
export const affectedPackages = (packages: ReadonlyArray<WorkspacePackage>, changed: ReadonlyArray<string>) => {
  const owner = (path: string) =>
    packages.filter((entry) => path.startsWith(`${entry.dir}/`)).sort((a, b) => b.dir.length - a.dir.length)[0]
  const direct = new Set(changed.flatMap((path) => owner(path)?.name ?? []))
  // A change outside every package (root config, lockfile) can affect all of them.
  if (changed.some((path) => owner(path) === undefined)) return packages.length
  let grew = true
  while (grew) {
    grew = false
    for (const entry of packages) {
      if (!direct.has(entry.name) && entry.dependencies.some((name) => direct.has(name))) {
        direct.add(entry.name)
        grew = true
      }
    }
  }
  return direct.size
}

/** Share of a cold CI run that stays with caching: checkout, install and setup. */
export const FIXED_SHARE = 0.2

/** Median wall minutes of successful pull-request runs, from `/actions/runs` rows. */
export const ciMinutes = (value: unknown): number | null => {
  const runs = object(value).workflow_runs
  const minutes = (Array.isArray(runs) ? runs : []).flatMap((entry) => {
    const row = object(entry)
    const start = time(row.run_started_at), end = time(row.updated_at)
    return start === null || end === null || end <= start ? [] : [(end - start) / 60]
  })
  return median(minutes)
}

export const ciEstimate = (pr: number, baselineMinutes: number, packages: number, affected: number): CiEstimate => {
  const share = packages <= 1 ? 1 : affected / packages
  const estimate = baselineMinutes * (FIXED_SHARE + (1 - FIXED_SHARE) * share)
  const round = (value: number) => Math.max(1, Math.round(value))
  return {
    _tag: "ci",
    pr,
    baselineMinutes: round(baselineMinutes),
    estimateMinutes: round(estimate),
    affected,
    packages
  }
}
