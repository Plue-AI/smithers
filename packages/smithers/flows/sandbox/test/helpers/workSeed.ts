/**
 * Builds a `SandboxConformance` work seed with the host's own `git`: a repo
 * whose one commit holds `workSeedFiles`, bundled so a guest can check it out
 * without the network.
 */
import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { type WorkSeed, workSeedFiles } from "../../src/SandboxConformance/index.ts"

export const gitIdentity = {
  GIT_AUTHOR_NAME: "Seed",
  GIT_AUTHOR_EMAIL: "seed@sandbox.invalid",
  GIT_COMMITTER_NAME: "Seed",
  GIT_COMMITTER_EMAIL: "seed@sandbox.invalid"
}

export const makeWorkSeed = (): WorkSeed => {
  const repo = mkdtempSync(join(tmpdir(), "smthrs-work-seed-"))
  try {
    const git = (...args: Array<string>) =>
      execFileSync("git", ["-c", "commit.gpgsign=false", ...args], {
        cwd: repo,
        env: { ...process.env, ...gitIdentity },
        encoding: "utf8"
      }).trim()
    git("init", "-q")
    for (const [path, bytes] of Object.entries(workSeedFiles)) {
      mkdirSync(dirname(join(repo, path)), { recursive: true })
      writeFileSync(join(repo, path), bytes, { mode: 0o644 })
    }
    git("add", "-A")
    git("commit", "-q", "-m", "work seed")
    const base = git("rev-parse", "HEAD")
    git("bundle", "create", "-q", join(repo, "seed.bundle"), "--all")
    return { bundle: new Uint8Array(readFileSync(join(repo, "seed.bundle"))), base }
  } finally {
    rmSync(repo, { recursive: true, force: true })
  }
}
