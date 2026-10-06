/** Detect declared checks for the coding host from tracked source files. */
export interface CheckCommand {
  readonly kind: "test" | "lint" | "build" | "typecheck" | "format"
  readonly argv: ReadonlyArray<string>
  readonly source: string
}
export const FILE_BYTES = 256 * 1024
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
const json = (text: string | undefined): Record<string, unknown> => {
  try {
    const value: unknown = text === undefined ? undefined : JSON.parse(text)
    return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {}
  } catch {
    return {}
  }
}

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
