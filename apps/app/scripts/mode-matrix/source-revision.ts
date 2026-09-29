const commandOutput = async (argv: readonly string[], cwd: string): Promise<string | undefined> => {
  try {
    const child = Bun.spawn([...argv], { cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe" })
    const [stdout, code] = await Promise.all([new Response(child.stdout).text(), child.exited])
    return code === 0 ? stdout.trim() : undefined
  } catch { return undefined }
}

export const sourceRevision = async (rootDir: string): Promise<string> => {
  const diff = await commandOutput(["jj", "diff", "--summary"], rootDir)
  if (diff !== undefined) {
    // jj creates an empty working-copy commit after pushing main. The package
    // contains its parent in that state; nonempty edits still use @ exactly.
    const revision = await commandOutput(["jj", "log", "-r", diff === "" ? "@-" : "@", "--no-graph", "-T", "commit_id"], rootDir)
    if (revision && /^[0-9a-f]{40,64}$/.test(revision)) return revision
  }
  const gitRevision = await commandOutput(["git", "rev-parse", "HEAD"], rootDir)
  if (gitRevision && /^[0-9a-f]{40,64}$/.test(gitRevision)) {
    const status = await commandOutput(["git", "status", "--porcelain"], rootDir)
    if (status === "") return gitRevision
  }
  throw new Error("cannot identify the exact source revision")
}
