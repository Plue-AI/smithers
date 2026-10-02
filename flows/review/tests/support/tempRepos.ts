import { afterEach } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

/**
 * Throwaway git repositories for one test file, removed after every test.
 * `track` registers any other temp directory for the same cleanup.
 */
export function tempRepos() {
  const tempDirs: string[] = [];
  afterEach(() => {
    while (tempDirs.length > 0) {
      rmSync(tempDirs.pop()!, { recursive: true, force: true, maxRetries: 30, retryDelay: 100 });
    }
  });

  function git(dir: string, args: string[]) {
    execFileSync("git", args, { cwd: dir, stdio: "pipe" });
  }

  function write(path: string, content: string) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  }

  function track(dir: string) {
    tempDirs.push(dir);
  }

  function initRepo(): string {
    const dir = mkdtempSync(join(tmpdir(), "ocr-unit-"));
    tempDirs.push(dir);
    git(dir, ["init"]);
    git(dir, ["config", "user.email", "t@example.com"]);
    git(dir, ["config", "user.name", "T"]);
    git(dir, ["config", "diff.renames", "true"]);
    return dir;
  }

  return { git, write, track, initRepo };
}
