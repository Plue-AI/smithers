/**
 * Agent readiness over seven pillars (registration-scores.md section 3). Criteria marked run come
 * from commands this host actually executed; a command the sandbox could not start (missing
 * toolchain) is not counted against the repository and its criterion is left out of the total.
 */
import type { CommandRun, Fix, PillarId, Readiness } from "./schema.ts"
import { ciGatesPulls, has, installCommand, read, type Tree, under, workflowFiles } from "./tree.ts"

interface Criterion {
  readonly pillar: PillarId
  readonly points: number
  /** true met, false unmet, undefined could not be measured here. */
  readonly met: boolean | undefined
  readonly fix: string
}

const MAX: Record<PillarId, number> = {
  verify: 25,
  ci: 15,
  types: 15,
  instructions: 15,
  setup: 15,
  docs: 10,
  safety: 5
}
const PILLARS = Object.keys(MAX) as ReadonlyArray<PillarId>

const ran = (runs: ReadonlyArray<CommandRun>, kind: CommandRun["kind"]): boolean | undefined => {
  const run = runs.find((entry) => entry.kind === kind)
  return run === undefined || run.status === "error" ? undefined : run.status === "passed"
}
const SECRET =
  /-----BEGIN (RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----|\bAKIA[0-9A-Z]{16}\b|\bgh[pousr]_[A-Za-z0-9]{36}\b|\bsk-[A-Za-z0-9]{32,}\b/

/**
 * Whether instructions name a command: the whole argv, or its short form (`npm test` for
 * `npm run test`, `cargo test` for `cargo test --quiet`), on word boundaries.
 */
export const namesCommand = (instructions: string, command: string): boolean => {
  const words = command.split(" ").filter((word) => !word.startsWith("-"))
  const forms = [words.join(" "), ...(words[1] === "run" && words.length === 3 ? [`${words[0]} ${words[2]}`] : [])]
  return forms.some((form) =>
    new RegExp(`(^|[\\s\`'"])${form.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}($|[\\s\`'"])`, "m").test(instructions)
  )
}

export const criteria = (tree: Tree, runs: ReadonlyArray<CommandRun>, installed: boolean | undefined) => {
  const tsconfig = read(tree, "tsconfig.json") ?? ""
  const typedLanguage = has(tree, "go.mod") || has(tree, "Cargo.toml") ||
    tree.paths.some((path) => /\.(java|kt|scala|cs|swift)$/.test(path))
  const strict = /"strict"\s*:\s*true/.test(tsconfig) || has(tree, "mypy.ini") ||
    /\[tool\.(mypy|pyright)\]/.test(read(tree, "pyproject.toml") ?? "") || has(tree, "pyrightconfig.json")
  const lintConfig =
    tree.paths.some((path) =>
      /^(\.eslintrc(\.\w+)?|eslint\.config\.\w+|biome\.jsonc?|\.golangci\.ya?ml|ruff\.toml|\.ruff\.toml|clippy\.toml|\.rubocop\.yml|dprint\.json|\.prettierrc(\.\w+)?)$/
        .test(path)
    ) || /\[tool\.ruff\]/.test(read(tree, "pyproject.toml") ?? "")
  const instructions = ["AGENTS.md", "CLAUDE.md"].map((path) => read(tree, path)).find((text) => text !== undefined)
  const passedCommands = runs.filter((run) => run.status === "passed").map((run) => run.command)
  const readme = tree.files.find((file) => /^readme(\.md|\.rst)?$/i.test(file.path))?.text ?? ""
  const test = ran(runs, "test")
  const list: ReadonlyArray<Criterion> = [
    { pillar: "verify", points: 5, met: runs.some((run) => run.kind === "test"), fix: "Declare a test command" },
    { pillar: "verify", points: 15, met: test, fix: "Make the tests pass in a clean clone" },
    {
      pillar: "verify",
      points: 5,
      met: test === undefined
        ? undefined
        : runs.some((run) => run.kind === "test" && run.status === "passed" && run.ms < 300_000),
      fix: "Keep a test run under five minutes"
    },
    {
      pillar: "ci",
      points: 8,
      met: workflowFiles(tree).length > 0 || has(tree, ".gitlab-ci.yml") || under(tree, ".circleci/"),
      fix: "Run checks in CI"
    },
    { pillar: "ci", points: 7, met: ciGatesPulls(tree), fix: "Run CI on every pull request" },
    { pillar: "types", points: 7, met: typedLanguage || strict, fix: "Turn on strict type checking" },
    { pillar: "types", points: 4, met: lintConfig, fix: "Add a linter and formatter" },
    { pillar: "types", points: 4, met: ran(runs, "lint") ?? ran(runs, "typecheck"), fix: "Make lint pass" },
    { pillar: "instructions", points: 7, met: instructions !== undefined, fix: "Add AGENTS.md with verified commands" },
    {
      pillar: "instructions",
      points: 8,
      met: instructions === undefined
        ? false
        : passedCommands.some((command) => namesCommand(instructions, command)),
      fix: "Name the working test command in AGENTS.md"
    },
    {
      pillar: "setup",
      points: 5,
      met: [
        "pnpm-lock.yaml",
        "package-lock.json",
        "yarn.lock",
        "bun.lock",
        "bun.lockb",
        "Cargo.lock",
        "go.sum",
        "poetry.lock",
        "uv.lock",
        "Gemfile.lock"
      ].some((path) => has(tree, path)),
      fix: "Commit a lockfile"
    },
    {
      pillar: "setup",
      points: 5,
      met: [
        ".tool-versions",
        ".nvmrc",
        ".node-version",
        "rust-toolchain.toml",
        "rust-toolchain",
        ".python-version",
        "flake.nix",
        ".devcontainer/devcontainer.json",
        "mise.toml"
      ].some((path) => has(tree, path)) ||
        /"packageManager"\s*:/.test(read(tree, "package.json") ?? ""),
      fix: "Pin the toolchain version"
    },
    {
      pillar: "setup",
      points: 5,
      met: installCommand(tree) === undefined ? undefined : installed,
      fix: "Make a clean clone install with one command"
    },
    {
      pillar: "docs",
      points: 4,
      met: /\b(test|build|install)\b/i.test(readme) && /```/.test(readme),
      fix: "Document build and test steps in the README"
    },
    {
      pillar: "docs",
      points: 3,
      met: tree.paths.some((path) =>
        /^(ARCHITECTURE\.md|docs\/|CONTRIBUTING\.md|\.github\/CONTRIBUTING\.md)/i.test(path)
      ),
      fix: "Add architecture or contributor docs"
    },
    { pillar: "docs", points: 3, met: under(tree, ".github/ISSUE_TEMPLATE"), fix: "Add issue templates" },
    {
      pillar: "safety",
      points: 3,
      met: !tree.files.some((file) => SECRET.test(file.text)),
      fix: "Remove committed secrets"
    },
    {
      pillar: "safety",
      points: 2,
      met: tree.paths.some((path) => /^(\.github\/)?SECURITY\.md$/i.test(path)),
      fix: "Add a security policy"
    }
  ]
  return list
}

/** Level gates, each needing the one before: discoverable, verified, disciplined, agent-ready, complete. */
const level = (
  list: ReadonlyArray<Criterion>,
  pillars: ReadonlyArray<{ id: PillarId; score: number; max: number }>
) => {
  const met = (fix: string) => list.find((entry) => entry.fix === fix)?.met === true
  const gates = [
    met("Declare a test command") && met("Document build and test steps in the README"),
    met("Make the tests pass in a clean clone") && met("Run checks in CI"),
    met("Make lint pass") && met("Run CI on every pull request") && met("Commit a lockfile"),
    met("Add AGENTS.md with verified commands") && met("Name the working test command in AGENTS.md"),
    pillars.every((pillar) => pillar.max === 0 || pillar.score / pillar.max >= 0.8)
  ]
  let reached = 1
  for (const gate of gates.slice(0, 4)) {
    if (!gate) break
    reached += 1
  }
  return reached === 5 && gates[4] ? 5 : Math.min(reached, 4)
}

export const readiness = (tree: Tree, runs: ReadonlyArray<CommandRun>, installed: boolean | undefined): Readiness => {
  const list = criteria(tree, runs, installed)
  const measured = list.filter((entry) => entry.met !== undefined)
  const pillars = PILLARS.map((id) => {
    const own = measured.filter((entry) => entry.pillar === id)
    return {
      id,
      score: own.filter((entry) => entry.met).reduce((sum, entry) => sum + entry.points, 0),
      max: own.reduce((sum, entry) => sum + entry.points, 0)
    }
  })
  const max = pillars.reduce((sum, pillar) => sum + pillar.max, 0)
  const got = pillars.reduce((sum, pillar) => sum + pillar.score, 0)
  const fixes: ReadonlyArray<Fix> = measured.filter((entry) => entry.met === false)
    .sort((a, b) => b.points - a.points)
    .slice(0, 3)
    .map((entry) => ({ pillar: entry.pillar, title: entry.fix, points: entry.points }))
  return {
    _tag: "readiness",
    score: max === 0 ? 0 : Math.round((got / max) * 100),
    level: level(list, pillars),
    pillars,
    fixes,
    runs
  }
}
