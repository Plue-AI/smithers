/**
 * The ordered checklist `smthrs suggest` runs against a repository, and the
 * suggestions it streams.
 *
 * Every check is a small, specific read of the repository: which package
 * manager and scripts it declares, which test runner and lint configuration
 * it carries, whether it has CI files, flows, a `PACKAGE.ts`, a GitHub
 * remote, a monorepo layout, an `AGENTS.md`, a changelog. The checks are
 * deterministic and cost no model call, which is what lets a suggestion be
 * printed the moment its check matches, while the scan continues. The model
 * is spent on the implementation, not on the reading.
 *
 * The order is low-hanging fruit first, then the heavier suggestions. A heavy
 * one is still streamed (a `--json` consumer sees the whole list) but is
 * marked `followUp`, so the interactive pick offers it only after a smaller
 * suggestion has landed.
 *
 * Pure over an injected {@link Repository}, so the whole table is a unit
 * test over an in-memory tree; {@link repository} is the Node reader.
 *
 * @since 1.0.0-rc.0
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"

/**
 * What the checks read.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export interface Repository {
  readonly root: string
  /** Whether a project-relative path exists. */
  readonly exists: (path: string) => boolean
  /** The text of a project-relative file, or `undefined` when it cannot be read. */
  readonly read: (path: string) => string | undefined
  /** The entry names of a project-relative directory; empty when it is not one. */
  readonly list: (path: string) => ReadonlyArray<string>
}

/**
 * A question offered after a suggestion lands.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export interface FollowUp {
  readonly id: "ci" | "incremental"
  readonly question: string
}

/**
 * One way Smithers can help this repository.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export interface Suggestion {
  readonly id: string
  readonly title: string
  /** One line, citing the files that triggered it. */
  readonly why: string
  readonly effort: "small" | "medium" | "large"
  /** Held back from the first pick; offered after a smaller one has landed. */
  readonly followUp: boolean
  readonly followUps: ReadonlyArray<FollowUp>
  /** The project-relative files the check read. */
  readonly files: ReadonlyArray<string>
}

/**
 * The follow-up every implementable suggestion offers.
 *
 * @category constants
 * @since 1.0.0-rc.0
 */
export const followUps: Readonly<Record<FollowUp["id"], FollowUp>> = {
  ci: { id: "ci", question: "Run this in CI?" },
  incremental: {
    id: "incremental",
    question: "Make it incremental, so unchanged inputs reuse their recorded result?"
  }
}

/**
 * What the reads found, in the shape the implementation prompt cites.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export interface Evidence {
  readonly packageManager: string | undefined
  readonly scripts: Readonly<Record<string, string>>
  readonly testRunner: string | undefined
  readonly lint: ReadonlyArray<string>
  readonly ci: ReadonlyArray<string>
  readonly flows: ReadonlyArray<string>
  readonly packageFile: boolean
  readonly github: boolean
  readonly git: boolean
  readonly monorepo: ReadonlyArray<string>
  readonly agentsFile: string | undefined
  readonly changelog: string | undefined
  readonly language: ReadonlyArray<string>
}

const scriptsOf = (manifest: string | undefined): Readonly<Record<string, string>> => {
  if (manifest === undefined) return {}
  try {
    const parsed: unknown = JSON.parse(manifest)
    const scripts = typeof parsed === "object" && parsed !== null && "scripts" in parsed ? parsed.scripts : undefined
    if (typeof scripts !== "object" || scripts === null) return {}
    return Object.fromEntries(
      Object.entries(scripts).filter((entry): entry is [string, string] => typeof entry[1] === "string")
    )
  } catch {
    return {}
  }
}

const manifestField = (manifest: string | undefined, field: string): unknown => {
  if (manifest === undefined) return undefined
  try {
    const parsed: unknown = JSON.parse(manifest)
    return typeof parsed === "object" && parsed !== null && field in parsed
      ? (parsed as Record<string, unknown>)[field]
      : undefined
  } catch {
    return undefined
  }
}

const firstExisting = (repository: Repository, paths: ReadonlyArray<string>): string | undefined =>
  paths.find((path) => repository.exists(path))

const lockfiles: ReadonlyArray<readonly [file: string, manager: string]> = [
  ["pnpm-lock.yaml", "pnpm"],
  ["bun.lock", "bun"],
  ["bun.lockb", "bun"],
  ["yarn.lock", "yarn"],
  ["package-lock.json", "npm"]
]

const lintFiles = [
  "eslint.config.js",
  "eslint.config.mjs",
  "eslint.config.ts",
  ".eslintrc",
  ".eslintrc.js",
  ".eslintrc.cjs",
  ".eslintrc.json",
  "biome.json",
  "biome.jsonc",
  "dprint.json",
  ".prettierrc",
  "ruff.toml",
  ".golangci.yml",
  "clippy.toml"
]

const runnerFiles: ReadonlyArray<readonly [file: string, runner: string]> = [
  ["vitest.config.ts", "vitest"],
  ["vitest.config.mts", "vitest"],
  ["vitest.config.js", "vitest"],
  ["vitest.workspace.ts", "vitest"],
  ["jest.config.js", "jest"],
  ["jest.config.ts", "jest"],
  ["jest.config.mjs", "jest"],
  ["bunfig.toml", "bun test"],
  ["pytest.ini", "pytest"],
  ["Cargo.toml", "cargo test"],
  ["go.mod", "go test"]
]

/**
 * Reads the facts every check consults, once.
 *
 * @category constructors
 * @since 1.0.0-rc.0
 */
export const evidence = (repository: Repository): Evidence => {
  const manifest = repository.read("package.json")
  const scripts = scriptsOf(manifest)
  const declaredManager = manifestField(manifest, "packageManager")
  const lock = lockfiles.find(([file]) => repository.exists(file))
  const packageManager = typeof declaredManager === "string"
    ? declaredManager.split("@")[0]
    : lock?.[1] ?? (manifest === undefined ? undefined : "npm")
  const testScript = scripts["test"]
  const runnerFile = runnerFiles.find(([file]) => repository.exists(file))
  const testRunner = testScript !== undefined
    ? /vitest/.test(testScript)
      ? "vitest"
      : /jest/.test(testScript)
      ? "jest"
      : /bun test/.test(testScript)
      ? "bun test"
      : testScript
    : runnerFile?.[1]
  const lint = lintFiles.filter((file) => repository.exists(file))
  const workflows = repository.list(".github/workflows").filter((name) => /\.ya?ml$/.test(name)).map((name) =>
    `.github/workflows/${name}`
  )
  const ci = [
    ...workflows,
    ...[".gitlab-ci.yml", ".circleci/config.yml", "Jenkinsfile"].filter((file) => repository.exists(file))
  ]
  const flows = repository.list("flows").filter((name) => repository.exists(`flows/${name}/flow.mdx`)).map((name) =>
    `flows/${name}/flow.mdx`
  )
  const git = repository.exists(".git")
  const gitConfig = git ? repository.read(".git/config") : undefined
  const github = (gitConfig !== undefined && gitConfig.includes("github.com")) || repository.exists(".github")
  const workspaces = manifestField(manifest, "workspaces")
  const monorepo = [
    ...(repository.exists("pnpm-workspace.yaml") ? ["pnpm-workspace.yaml"] : []),
    ...(Array.isArray(workspaces) ? ["package.json#workspaces"] : []),
    ...["packages", "apps"].filter((directory) => repository.list(directory).length > 0)
  ]
  const language = [
    ...(manifest === undefined ? [] : ["javascript"]),
    ...(repository.exists("tsconfig.json") ? ["typescript"] : []),
    ...(repository.exists("Cargo.toml") ? ["rust"] : []),
    ...(repository.exists("go.mod") ? ["go"] : []),
    ...(repository.exists("pyproject.toml") ? ["python"] : [])
  ]
  return {
    packageManager,
    scripts,
    testRunner,
    lint,
    ci,
    flows,
    packageFile: repository.exists("PACKAGE.ts"),
    github,
    git,
    monorepo,
    agentsFile: firstExisting(repository, ["AGENTS.md", "CLAUDE.md"]),
    changelog: firstExisting(repository, ["CHANGELOG.md", ".changeset"]),
    language
  }
}

/**
 * One entry of the checklist: a check over the evidence that either matches,
 * with the suggestion it makes, or does not.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export interface Rule {
  readonly id: string
  readonly match: (facts: Evidence, repository: Repository) => Suggestion | undefined
}

const cite = (files: ReadonlyArray<string>): string => files.join(", ")

const both: ReadonlyArray<FollowUp> = [followUps.ci, followUps.incremental]

/** The scripts that name a task someone runs by hand again and again. */
const repeatedScriptPattern = /^(release|publish|deploy|docs|generate|gen|codegen|migrate|changelog|bench)(:|$)/

/**
 * The checklist, in the order the scan runs it.
 *
 * @category constants
 * @since 1.0.0-rc.0
 */
export const checks: ReadonlyArray<Rule> = [
  {
    id: "test-target",
    // The runner's own configuration files are filtered by what is on disk,
    // not by what the runner could carry. Citing `vitest.config.mts` beside
    // `vitest.config.ts` in a repository that has only the second names a
    // file the agent is then told triggered the suggestion, and a brief that
    // lists a file nobody wrote is a brief the model has to invent a reason
    // for.
    match: (facts, repository) => {
      if (facts.testRunner === undefined) return undefined
      const files = [
        ...(facts.scripts["test"] === undefined ? [] : ["package.json"]),
        ...runnerFiles.filter(([file, runner]) => runner === facts.testRunner && repository.exists(file)).map((
          [file]
        ) => file)
      ]
      return {
        id: "test-target",
        title: "A test target that reruns only what changed",
        why: `${facts.testRunner} is the test runner (${
          cite(files)
        }), so a target keyed on its inputs skips the tests whose inputs did not change`,
        effort: "small",
        followUp: false,
        followUps: both,
        files
      }
    }
  },
  {
    id: "lint-target",
    match: (facts) =>
      facts.lint.length === 0 ? undefined : {
        id: "lint-target",
        title: "A lint target over the files that changed",
        why: `the repository configures a linter (${
          cite(facts.lint)
        }), so a flow can lint and fix only the changed files`,
        effort: "small",
        followUp: false,
        followUps: both,
        files: facts.lint
      }
  },
  {
    id: "agents-md",
    match: (facts) => {
      if (facts.agentsFile !== undefined) return undefined
      const files = facts.monorepo.length > 0 ? facts.monorepo : facts.packageFile ? ["PACKAGE.ts"] : ["package.json"]
      if (facts.monorepo.length === 0 && !facts.packageFile && Object.keys(facts.scripts).length === 0) return undefined
      return {
        id: "agents-md",
        title: "An AGENTS.md generated from the packages",
        why: `there is no AGENTS.md or CLAUDE.md, and the layout (${
          cite(files)
        }) is enough to write one that agents read first`,
        effort: "small",
        followUp: false,
        followUps: [followUps.ci],
        files
      }
    }
  },
  {
    id: "release-notes",
    match: (facts) =>
      !facts.git ? undefined : {
        id: "release-notes",
        title: "A release-notes flow from the commits since the last tag",
        why: `the repository is under git (.git${
          facts.changelog === undefined ? "" : `, ${facts.changelog}`
        }), so a flow can group the commits since the last tag into notes`,
        effort: "small",
        followUp: false,
        followUps: [followUps.ci],
        files: [".git", ...(facts.changelog === undefined ? [] : [facts.changelog])]
      }
  },
  {
    id: "pr-review",
    match: (facts) => {
      if (!facts.github) return undefined
      const files = [".git/config", ...facts.ci]
      return {
        id: "pr-review",
        title: "A review flow for pull requests",
        why: `the remote is on GitHub (${
          cite(files)
        }), so a flow can review each pull request's diff against the repository's own conventions`,
        effort: "medium",
        followUp: false,
        followUps: [followUps.ci],
        files
      }
    }
  },
  {
    id: "repeated-script",
    match: (facts) => {
      const names = Object.keys(facts.scripts).filter((name) => repeatedScriptPattern.test(name))
      if (names.length === 0) return undefined
      return {
        id: "repeated-script",
        title: `A flow for the repeated task \`${names[0]}\` reveals`,
        why: `package.json scripts ${names.map((name) => `\`${name}\``).join(", ")} name a task that is run by hand`,
        effort: "medium",
        followUp: false,
        followUps: both,
        files: ["package.json"]
      }
    }
  },
  {
    id: "changelog",
    match: (facts) =>
      facts.changelog === undefined || !facts.git ? undefined : {
        id: "changelog",
        title: "Keep the changelog current from merged changes",
        why: `${facts.changelog} exists, so a flow can add an entry for each change that lands`,
        effort: "small",
        followUp: false,
        followUps: [followUps.ci],
        files: [facts.changelog]
      }
  },
  {
    id: "build-graph",
    match: (facts) =>
      facts.monorepo.length === 0 || facts.packageFile ? undefined : {
        id: "build-graph",
        title: "The whole build as PACKAGE.ts targets",
        why: `the repository is a monorepo (${
          cite(facts.monorepo)
        }) with no PACKAGE.ts, so every package's check, lint, and test could become one cached graph`,
        effort: "large",
        followUp: true,
        followUps: [followUps.ci],
        files: facts.monorepo
      }
  },
  {
    id: "sandboxed-review",
    match: (facts) =>
      !facts.github ? undefined : {
        id: "sandboxed-review",
        title: "A sandboxed review that runs the tests on each pull request",
        why: `the remote is on GitHub and ${
          facts.testRunner === undefined
            ? "the review can run in a sandbox"
            : `${facts.testRunner} can run in a sandbox`
        }, so a review flow can execute the change instead of only reading it`,
        effort: "large",
        followUp: true,
        followUps: [followUps.ci],
        files: [".git/config", ...(facts.testRunner === undefined ? [] : ["package.json"])]
      }
  }
]

/**
 * Runs the checklist, yielding each suggestion the moment its check matches.
 *
 * An async generator rather than an array, so a renderer can print the first
 * suggestion before the last check has run and a `--json` consumer reads one
 * document per match as it happens.
 *
 * @category constructors
 * @since 1.0.0-rc.0
 */
export async function* scan(repository: Repository): AsyncGenerator<Suggestion, void, undefined> {
  const facts = evidence(repository)
  for (const check of checks) {
    const suggestion = check.match(facts, repository)
    if (suggestion !== undefined) yield suggestion
    // Yield to the event loop between checks, so a renderer's frame and an
    // abort signal get their turn while the scan continues.
    await new Promise<void>((resolve) => setImmediate(resolve))
  }
}

/**
 * The Node reader over one project root.
 *
 * @category constructors
 * @since 1.0.0-rc.0
 */
export const repository = (root: string): Repository => ({
  root,
  exists: (path) => existsSync(join(root, path)),
  read: (path) => {
    try {
      return readFileSync(join(root, path), "utf8")
    } catch {
      return undefined
    }
  },
  list: (path) => {
    try {
      const full = join(root, path)
      return statSync(full).isDirectory() ? readdirSync(full).sort() : []
    } catch {
      return []
    }
  }
})

/**
 * An in-memory reader, for tests and for the `--json` fixtures.
 *
 * `files` maps project-relative paths to their text; a directory exists when
 * a file lives under it.
 *
 * @category constructors
 * @since 1.0.0-rc.0
 */
export const memoryRepository = (root: string, files: Readonly<Record<string, string>>): Repository => {
  const paths = Object.keys(files)
  const isDirectory = (path: string): boolean => paths.some((file) => file.startsWith(`${path}/`))
  return {
    root,
    exists: (path) => Object.hasOwn(files, path) || isDirectory(path),
    read: (path) => (Object.hasOwn(files, path) ? files[path] : undefined),
    list: (path) =>
      [
        ...new Set(
          paths.filter((file) => file.startsWith(`${path}/`)).map((file) => file.slice(path.length + 1).split("/")[0]!)
        )
      ].sort()
  }
}
