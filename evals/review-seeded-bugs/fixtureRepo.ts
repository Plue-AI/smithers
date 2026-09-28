/**
 * Materializes one corpus fixture as a real git repository.
 *
 * A fixture is repository content, so it is untrusted input to the git
 * commands run over it. Two kinds of entry are refused outright rather than
 * copied: git control files (`.git`, `.gitattributes`, `.gitmodules`), which
 * can make a later git command run a configured program, and symbolic links,
 * which can pull a host file into a prompt a live run sends to a provider.
 *
 * @since 1.0.0
 */
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { basename, join } from "node:path";

/** Entry names git reads as configuration or control data, in lower case. */
const gitControlNames: ReadonlySet<string> = new Set([".git", ".gitattributes", ".gitmodules"]);

/**
 * Whether `name` is a git control name. The comparison ignores case because
 * macOS and Windows filesystems do, so git honors `.GITATTRIBUTES` there.
 */
const isGitControlName = (name: string): boolean => gitControlNames.has(name.toLowerCase());

/** Throws when `path` is an entry a fixture must not carry. */
function refuseUnsafeEntry(path: string): void {
  if (isGitControlName(basename(path))) {
    throw new Error(`Fixture entry ${path} is a git control file; fixtures must not carry one`);
  }
  if (lstatSync(path).isSymbolicLink()) {
    throw new Error(`Fixture entry ${path} is a symbolic link; fixtures must carry regular files only`);
  }
}

/**
 * Every path under `root` a fixture must not carry, in walk order.
 *
 * @since 1.0.0
 * @category guards
 */
export function unsafeEntries(root: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (isGitControlName(entry.name) || entry.isSymbolicLink()) {
      found.push(path);
      continue;
    }
    if (entry.isDirectory()) found.push(...unsafeEntries(path));
  }
  return found;
}

/** Git with no system or global configuration, so a host setting cannot shape the fixture. */
const gitEnvironment = (home: string): NodeJS.ProcessEnv => ({
  ...process.env,
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  HOME: home,
});

function git(args: string[], cwd: string, home: string): void {
  execFileSync("git", args, { cwd, stdio: "pipe", env: gitEnvironment(home) });
}

function copyDirectoryContents(from: string, to: string): void {
  mkdirSync(to, { recursive: true });
  for (const entry of readdirSync(from, { withFileTypes: true })) {
    cpSync(join(from, entry.name), join(to, entry.name), {
      recursive: true,
      force: true,
      filter: (source) => {
        refuseUnsafeEntry(source);
        return true;
      },
    });
  }
}

function clearWorktree(repoDir: string): void {
  for (const entry of readdirSync(repoDir, { withFileTypes: true })) {
    if (entry.name === ".git") continue;
    rmSync(join(repoDir, entry.name), { recursive: true, force: true });
  }
}

/**
 * A real git repository under `workRoot` whose first commit is the fixture's
 * `base/` and whose worktree is its `head/`.
 *
 * @since 1.0.0
 * @category constructors
 */
export function materializeFixture(fixtureDir: string, workRoot: string): string {
  const baseDir = join(fixtureDir, "base");
  const headDir = join(fixtureDir, "head");
  if (!existsSync(baseDir) || !existsSync(headDir)) {
    throw new Error(`Fixture ${basename(fixtureDir)} must have base/ and head/ directories`);
  }
  // The copy filter only sees entries inside base/ and head/; a symlinked
  // fixture, base/, or head/ directory would be followed before it runs.
  for (const path of [fixtureDir, baseDir, headDir]) refuseUnsafeEntry(path);
  const repoDir = join(workRoot, "repo");
  const home = join(workRoot, "home");
  mkdirSync(home, { recursive: true });
  copyDirectoryContents(baseDir, repoDir);
  git(["init"], repoDir, home);
  git(["config", "user.email", "review-seeded-bugs@example.com"], repoDir, home);
  git(["config", "user.name", "Review Seeded Bugs"], repoDir, home);
  git(["config", "commit.gpgsign", "false"], repoDir, home);
  git(["add", "."], repoDir, home);
  git(["commit", "-m", "base"], repoDir, home);
  clearWorktree(repoDir);
  copyDirectoryContents(headDir, repoDir);
  return repoDir;
}
