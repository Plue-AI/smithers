/** What one exported source tree says about itself. Pure over paths and file texts. */
import type { CheckCommand } from "./schema.ts"

const SOURCE = /\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|kt|rb|php|cs|c|cc|cpp|h|hpp|swift|scala|sh)$/
/** Vendored, generated and build output: never the owner's code or docs. */
export const EXCLUDED =
  /(^|\/)(node_modules|dist|build|out|vendor|third_party|\.git|coverage|__snapshots__|__generated__|generated)\/|\.min\.js$|\.pb\.go$|_pb2\.py$|\.d\.ts$|_generated\.\w+$/

/** Read limits shared by the host and the calibration recorder: one file, the whole tree, and unreadable extensions. */
export const FILE_BYTES = 256 * 1024
export const TREE_BYTES = 48 * 1024 * 1024
export const BINARY =
  /\.(png|jpe?g|gif|webp|ico|pdf|zip|gz|tgz|jar|woff2?|ttf|otf|eot|mp[34]|mov|wasm|so|dylib|dll|exe|bin|lockb)$/i

export const isSource = (path: string) => SOURCE.test(path) && !EXCLUDED.test(path)

export interface SourceFile {
  readonly path: string
  readonly text: string
}
export interface Tree {
  /** Every tracked path, including ones too large or too binary to read. */
  readonly paths: ReadonlyArray<string>
  /** The readable text files. */
  readonly files: ReadonlyArray<SourceFile>
}

export const read = (tree: Tree, path: string): string | undefined =>
  tree.files.find((file) => file.path === path)?.text
const has = (tree: Tree, path: string) => tree.paths.includes(path)
const under = (tree: Tree, prefix: string) => tree.paths.some((path) => path.startsWith(prefix))
const json = (text: string | undefined): Record<string, unknown> => {
  try {
    const value: unknown = text === undefined ? undefined : JSON.parse(text)
    return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {}
  } catch {
    return {}
  }
}

// ---- license ---------------------------------------------------------------

export const LICENSE_OPTIONS = ["MIT", "Apache-2.0", "GPL-3.0", "BSD-3-Clause", "MPL-2.0", "AGPL-3.0", "None"] as const
const LICENSE_TEXT: ReadonlyArray<readonly [string, ReadonlyArray<RegExp>]> = [
  ["AGPL-3.0", [/GNU AFFERO GENERAL PUBLIC LICENSE/i]],
  ["LGPL-3.0", [/GNU LESSER GENERAL PUBLIC LICENSE/i, /Version 3/i]],
  ["GPL-3.0", [/GNU GENERAL PUBLIC LICENSE/i, /Version 3/i]],
  ["LGPL-2.1", [/GNU LESSER GENERAL PUBLIC LICENSE/i, /Version 2\.1/i]],
  ["GPL-2.0", [/GNU GENERAL PUBLIC LICENSE/i, /Version 2/i]],
  ["Apache-2.0", [/Apache License/i, /Version 2\.0/i]],
  ["MPL-2.0", [/Mozilla Public License,? (Version|v\.?) ?2\.0/i]],
  ["BSD-3-Clause", [/Redistribution and use in source and binary forms/i, /Neither the name/i]],
  ["BSD-2-Clause", [/Redistribution and use in source and binary forms/i]],
  ["ISC", [/Permission to use, copy, modify, and\/or distribute this software/i]],
  ["MIT", [/Permission is hereby granted, free of charge/i]],
  ["Unlicense", [/This is free and unencumbered software/i]]
]
export const LICENSE_FILES = /^(LICEN[CS]E|COPYING)(\.(md|txt|rst))?$/i

/** Every license the tree's own texts name, strongest evidence first. */
export const licenseCandidates = (tree: Tree): ReadonlyArray<{ spdx: string; evidence: string }> => {
  const found: Array<{ spdx: string; evidence: string }> = []
  for (const file of tree.files.filter((entry) => LICENSE_FILES.test(entry.path))) {
    const match = LICENSE_TEXT.find(([, patterns]) => patterns.every((pattern) => pattern.test(file.text)))
    if (match !== undefined) found.push({ spdx: match[0], evidence: file.path })
  }
  const declared = json(read(tree, "package.json")).license
  if (typeof declared === "string" && declared.trim() !== "") {
    found.push({ spdx: declared.trim(), evidence: "package.json" })
  }
  const cargo = /^\s*license\s*=\s*"([^"]+)"/m.exec(read(tree, "Cargo.toml") ?? "")
  if (cargo !== null) found.push({ spdx: cargo[1]!, evidence: "Cargo.toml" })
  const pyproject = /^\s*license\s*=\s*(?:\{\s*text\s*=\s*)?"([^"]+)"/m.exec(read(tree, "pyproject.toml") ?? "")
  if (pyproject !== null) found.push({ spdx: pyproject[1]!, evidence: "pyproject.toml" })
  const seen = new Set<string>()
  return found.filter((entry) => !seen.has(entry.spdx) && seen.add(entry.spdx))
}

/** Three options to show: the answer first, then the most common others. */
export const licenseOptions = (chosen: string): ReadonlyArray<string> =>
  [chosen, ...["MIT", "Apache-2.0", "GPL-3.0"].filter((option) => option !== chosen)].slice(0, 3)

// ---- checks ----------------------------------------------------------------

export const CHECK_OPTIONS = ["GitHub Actions", "Makefile", "Scripts", "None yet"] as const
export type CheckRunner = typeof CHECK_OPTIONS[number]

export const workflowFiles = (tree: Tree) =>
  tree.paths.filter((path) => /^\.github\/workflows\/[^/]+\.ya?ml$/.test(path))

/** Where checks can run, each with its evidence. Several means Jev decides which one is primary. */
export const checkRunners = (tree: Tree): ReadonlyArray<{ runner: CheckRunner; evidence: string }> => [
  ...(workflowFiles(tree).length > 0 ? [{ runner: "GitHub Actions" as const, evidence: workflowFiles(tree)[0]! }] : []),
  ...(has(tree, "Makefile") && /^(test|check|lint|build)\s*:/m.test(read(tree, "Makefile") ?? "")
    ? [{ runner: "Makefile" as const, evidence: "Makefile" }]
    : []),
  ...(Object.keys(scripts(tree)).some((name) => /^(test|lint|check|build|typecheck)$/.test(name)) ||
      has(tree, "justfile") || has(tree, "Taskfile.yml") || has(tree, "tox.ini") || has(tree, "noxfile.py")
    ? [{ runner: "Scripts" as const, evidence: has(tree, "package.json") ? "package.json" : "task runner" }]
    : [])
]

/** Whether any workflow runs on pull requests. */
export const ciGatesPulls = (tree: Tree) =>
  workflowFiles(tree).some((path) => /\bpull_request(_target)?\b/.test(read(tree, path) ?? ""))

const scripts = (tree: Tree): Record<string, unknown> => {
  const value = json(read(tree, "package.json")).scripts
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : {}
}

export const packageManager = (tree: Tree): "pnpm" | "yarn" | "bun" | "npm" =>
  has(tree, "pnpm-lock.yaml") ?
    "pnpm" :
    has(tree, "yarn.lock") ?
    "yarn" :
    has(tree, "bun.lockb") || has(tree, "bun.lock")
    ? "bun"
    : "npm"

/** The commands the tree declares for each kind of check, first source wins. */
export const checkCommands = (tree: Tree): ReadonlyArray<CheckCommand> => {
  const commands: Array<CheckCommand> = []
  const add = (kind: CheckCommand["kind"], argv: ReadonlyArray<string>, source: string) => {
    if (!commands.some((command) => command.kind === kind)) commands.push({ kind, argv: [...argv], source })
  }
  const pm = packageManager(tree), declared = scripts(tree)
  for (
    const [kind, names] of [
      ["test", ["test"]],
      ["lint", ["lint"]],
      ["typecheck", ["typecheck", "check-types", "tsc"]],
      ["build", ["build"]]
    ] as const
  ) {
    const name = names.find((candidate) => typeof declared[candidate] === "string")
    if (name !== undefined && !/no test specified/.test(String(declared[name]))) {
      add(kind, [pm, "run", name], "package.json")
    }
  }
  const makefile = read(tree, "Makefile") ?? ""
  for (const kind of ["test", "lint", "build"] as const) {
    if (new RegExp(`^${kind}\\s*:`, "m").test(makefile)) add(kind, ["make", kind], "Makefile")
  }
  if (has(tree, "Cargo.toml")) {
    add("test", ["cargo", "test", "--quiet"], "Cargo.toml")
    add("lint", ["cargo", "clippy", "--quiet"], "Cargo.toml")
    add("build", ["cargo", "build", "--quiet"], "Cargo.toml")
  }
  if (has(tree, "go.mod")) {
    add("test", ["go", "test", "./..."], "go.mod")
    add("lint", ["go", "vet", "./..."], "go.mod")
    add("build", ["go", "build", "./..."], "go.mod")
  }
  if (has(tree, "pyproject.toml") || has(tree, "setup.py") || has(tree, "pytest.ini")) {
    add("test", ["python3", "-m", "pytest", "-q"], has(tree, "pyproject.toml") ? "pyproject.toml" : "setup.py")
  }
  return commands
}

/** The install command a clean clone needs before its checks, if the tree names one. */
export const installCommand = (tree: Tree): ReadonlyArray<string> | undefined => {
  if (has(tree, "package.json")) {
    const pm = packageManager(tree)
    return pm === "npm" ?
      (has(tree, "package-lock.json") ? ["npm", "ci"] : ["npm", "install"]) :
      pm === "yarn"
      ? ["yarn", "install", "--frozen-lockfile"]
      : [pm, "install", "--frozen-lockfile"]
  }
  if (has(tree, "go.mod")) return ["go", "mod", "download"]
  if (has(tree, "Cargo.toml")) return ["cargo", "fetch"]
  return undefined
}

// ---- theme -----------------------------------------------------------------

const LOGO = /(^|\/)(logo|icon|brand|mark)[^/]*\.(svg|png)$/i
export const themeCandidates = (tree: Tree, repo: string) => {
  const readme = tree.files.find((file) => /^readme(\.md|\.rst|\.txt)?$/i.test(file.path))?.text ?? ""
  const heading = /^#\s+(.+)$/m.exec(readme)?.[1]?.replace(/<[^>]+>|!\[[^\]]*\]\([^)]*\)|\[|\]\([^)]*\)/g, "").trim()
  const pkg = json(read(tree, "package.json")).name
  const names = [
    ...(heading !== undefined && heading !== "" && heading.length <= 40 ? [heading] : []),
    ...(typeof pkg === "string" && pkg !== "" ? [pkg.replace(/^@[^/]+\//, "")] : []),
    repo.split("/")[1]!
  ]
  const seen = new Set<string>()
  const logo = tree.paths.filter((path) => LOGO.test(path) && !/node_modules|test|fixture/.test(path))
    .sort((a, b) => a.split("/").length - b.split("/").length || (a.endsWith(".svg") ? -1 : 1))[0] ?? null
  return { names: names.filter((name) => !seen.has(name.toLowerCase()) && seen.add(name.toLowerCase())), logo }
}

const HEX = /#([0-9a-fA-F]{6})\b/g
/** Brand colors: the most used saturated hex colors in the logo, then in theme and style files. */
export const themeColors = (tree: Tree, logo: string | null): ReadonlyArray<string> => {
  const sources = [
    ...(logo?.endsWith(".svg") ? [read(tree, logo) ?? ""] : []),
    ...tree.files.filter((file) =>
      /(theme|brand|colors?|tailwind\.config|variables)\.(css|scss|ts|js|json)$/i.test(file.path)
    )
      .map((file) => file.text)
  ]
  const counts = new Map<string, number>()
  for (const text of sources) {
    for (const match of text.matchAll(HEX)) {
      const hex = `#${match[1]!.toLowerCase()}`
      if (saturation(hex) >= 0.25) counts.set(hex, (counts.get(hex) ?? 0) + 1)
    }
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([hex]) => hex)
}
const saturation = (hex: string) => {
  const [r, g, b] = [1, 3, 5].map((index) => parseInt(hex.slice(index, index + 2), 16) / 255) as [
    number,
    number,
    number
  ]
  const max = Math.max(r, g, b), min = Math.min(r, g, b)
  return max === 0 ? 0 : (max - min) / max
}

// ---- contribution files ----------------------------------------------------

export const contributing = (tree: Tree) =>
  tree.paths.some((path) => /^(\.github\/|docs\/)?CONTRIBUTING(\.md|\.rst|\.txt)?$/i.test(path))
export const cla = (tree: Tree) =>
  tree.paths.some((path) => /(^|\/)(CLA|cla)(\.md|\.txt)?$/.test(path)) ||
  workflowFiles(tree).some((path) => /\bcla\b|contributor-assistant|cla-assistant/i.test(read(tree, path) ?? ""))

export { has, under }
