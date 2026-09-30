/**
 * The merge queue: every worker that reported READY commits is one member.
 * Members land one at a time on top of each other; a member that conflicts or
 * fails its checks is quarantined, and the next round relaunches it as a fix.
 */
import * as MergeQueue from "@smthrs/patterns/MergeQueue"
import { Data, Effect } from "effect"
import { execFile } from "node:child_process"
import { chmod, mkdir, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import type { InFlight, LandReport, WorkerResult } from "./schema.ts"

const run = promisify(execFile)
const lockScript = join(homedir(), "Smithers-Ops/dispatch/vcs_lock.py")
const scriptDir = join(homedir(), "Smithers-Ops/burndown/landings")
const claimScript = join(homedir(), "smithers/scripts/issue-claim.mjs")

export class LandFailed extends Data.TaggedError("LandFailed")<{
  readonly key: string
  readonly log: string
}> {}

/** One landing: the worker's commits in issue order and the claims they carry. */
export interface Member {
  readonly key: string
  readonly repo: string
  readonly commits: ReadonlyArray<{ readonly issue: number; readonly commit: string }>
}

const shellQuote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`

/** Runs under the VCS lock, with one deadline shared by discovery and all checks. */
export const checksProgram = String.raw`
import { existsSync, readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve, relative, sep } from "node:path";
import { execFileSync, spawn } from "node:child_process";
const [repo, ...changes] = process.argv.slice(1);
const sourceRoot = process.cwd();
let root = sourceRoot;
let snapshot;
let activeChild;
for (const [signal, code] of [["SIGTERM", 143], ["SIGINT", 130], ["SIGHUP", 129]]) {
  process.on(signal, () => {
    if (activeChild?.pid) {
      try { process.kill(-activeChild.pid, "SIGKILL"); } catch (error) { if (error.code !== "ESRCH") console.error(error); }
    }
    if (snapshot) rmSync(snapshot, { recursive: true, force: true });
    console.error("CHECK_CANCELLED " + signal);
    process.exit(code);
  });
}
const deadline = Date.now() + 900_000;
const remaining = () => {
  const ms = deadline - Date.now();
  if (ms <= 0) throw new Error("CHECK_TIMEOUT: overall 15-minute limit");
  return ms;
};
try {
if (process.env.BURNDOWN_CHECK_REVISION) {
  snapshot = mkdtempSync(resolve(tmpdir(), "burndown-check-"));
  root = resolve(snapshot, "tree");
  const gitDirectory = execFileSync("jj", ["git", "root"], { encoding: "utf8", timeout: remaining() }).trim();
  const sha = execFileSync("jj", ["--ignore-working-copy", "log", "--no-graph", "-r", process.env.BURNDOWN_CHECK_REVISION, "-T", "commit_id"], { encoding: "utf8", timeout: remaining() }).trim();
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error("Invalid landing commit: " + sha);
  const archive = resolve(snapshot, "tree.tar");
  execFileSync("git", ["--git-dir", gitDirectory, "archive", "--format=tar", "--output", archive, sha], { timeout: remaining() });
  execFileSync("mkdir", [root], { timeout: remaining() });
  execFileSync("tar", ["-xf", archive, "-C", root], { timeout: remaining() });
  console.log("CHECK_REVISION " + sha);
}
const paths = [...new Set(changes.flatMap(change =>
  execFileSync("jj", ["--ignore-working-copy", "diff", "--name-only", "-r", change], {
    encoding: "utf8", timeout: remaining(), maxBuffer: 16 << 20
  }).trim().split("\n").filter(Boolean)))].sort();
const packages = new Map();
for (const path of paths) {
  const absolute = resolve(root, path);
  if (absolute !== root && !absolute.startsWith(root + sep)) throw new Error("Unsafe changed path: " + path);
  if (repo === "plue") {
    if (!path.endsWith(".go") && !["go.mod", "go.sum"].includes(path)) {
      console.log("SKIP " + path + ": no Go package");
      continue;
    }
    const directory = dirname(path);
    packages.set(directory, { go: directory === "." ? "./..." : "./" + directory + "/..." });
    continue;
  }
  let directory = dirname(absolute);
  while (directory !== root) {
    const manifest = resolve(directory, "package.json");
    if (existsSync(manifest) || existsSync(resolve(directory, "PACKAGE.ts"))) {
      const label = relative(root, directory);
      if (!existsSync(manifest)) {
        console.log("SKIP " + label + ": no package.json scripts");
      } else {
        const pkg = JSON.parse(readFileSync(manifest, "utf8"));
        if (typeof pkg.name !== "string" || !pkg.name) throw new Error("Missing package name: " + label);
        packages.set(label, { name: pkg.name, scripts: pkg.scripts ?? {} });
      }
      break;
    }
    directory = dirname(directory);
  }
  if (directory === root) console.log("SKIP " + path + ": no workspace package (root checks excluded)");
}
async function check(command, args) {
  console.log("CHECK " + JSON.stringify([command, ...args]));
  await new Promise((accept, reject) => {
    const budget = remaining();
    const child = spawn(command, args, { cwd: root, env: { ...process.env, CI: "true" }, stdio: "inherit", detached: true });
    activeChild = child;
    const timer = setTimeout(() => {
      try { process.kill(-child.pid, "SIGKILL"); } catch (error) { if (error.code !== "ESRCH") console.error(error); }
      reject(new Error("CHECK_TIMEOUT: overall 15-minute limit"));
    }, budget);
    child.once("error", error => { activeChild = undefined; clearTimeout(timer); reject(error); });
    child.once("close", (code, signal) => {
      activeChild = undefined;
      clearTimeout(timer);
      if (code === 0) accept();
      else reject(new Error("CHECK_FAILED " + command + " exit=" + code + " signal=" + signal));
    });
  });
}
if (snapshot && repo !== "plue" && [...packages.values()].some(pkg => pkg.scripts.typecheck || pkg.scripts.check || pkg.scripts.test)) {
  await check("pnpm", ["install", "--offline", "--frozen-lockfile"]);
}
  for (const [label, pkg] of [...packages].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) {
    if (pkg.go) {
      await check("go", ["vet", pkg.go]);
      await check("go", ["test", pkg.go]);
    } else {
      const script = pkg.scripts.typecheck ? "typecheck" : pkg.scripts.check ? "check" : undefined;
      if (script) await check("pnpm", ["--filter", pkg.name, "run", script]);
      else console.log("SKIP " + label + ": no typecheck/check script");
      if (pkg.scripts.test) await check("pnpm", ["--filter", pkg.name, "run", "test"]);
      else console.log("SKIP " + label + ": no test script");
    }
  }
  console.log("CHECKS_PASSED");
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  if (snapshot) rmSync(snapshot, { recursive: true, force: true });
}
`

/** Keep a byte-bounded failure receipt for MergeQueue quarantine and fix relaunch. */
export const landingFailure = (key: string, cause: unknown): LandFailed => {
  const error = cause as { code?: number; stdout?: string; stderr?: string; message?: string }
  const log = error.code === 6 && error.stderr !== undefined
    ? error.stderr
    : `${error.stdout ?? ""}\n${error.stderr ?? ""}\n${error.message ?? String(cause)}`
  return new LandFailed({ key, log: Buffer.from(log).subarray(-4000).toString("utf8") })
}

/**
 * The script run under the repository's VCS lock. It rebases the member's
 * commits onto current `main@origin`, refuses conflicts, moves `main` to the
 * last one, pushes, and prints `LANDED <issue> <commit>` per issue.
 */
export const landingScript = (member: Member): string => {
  const commits = member.commits.map((c) => shellQuote(c.commit)).join(" ")
  return `#!/bin/sh
set -eu
jj git fetch >/dev/null 2>&1 || jj git fetch
changes=""
for c in ${commits}; do
  changes="$changes $(jj --ignore-working-copy log --no-graph -r "$c" -T 'change_id')"
done
revs=""
for ch in $changes; do revs="$revs -r $ch"; done
jj rebase $revs -d main@origin
for ch in $changes; do
  if [ -n "$(jj log --no-graph -r "$ch & conflicts()" -T 'change_id')" ]; then
    echo "CONFLICT $ch"; exit 3
  fi
  if [ -z "$(jj log --no-graph -r "$ch & main@origin::" -T 'change_id')" ]; then
    echo "NOT_ON_MAIN $ch"; exit 4
  fi
done
last=$(echo $changes | awk '{print $NF}')
for ch in $changes; do
  if [ -z "$(jj --ignore-working-copy log --no-graph -r "$ch & ::$last" -T 'change_id')" ]; then
    echo "NOT_IN_LANDING $ch"; exit 4
  fi
done
checks_log=${shellQuote(join(scriptDir, `${member.key}.checks.log`))}
if BURNDOWN_CHECK_REVISION="$last" node --input-type=module -e ${shellQuote(checksProgram)} ${
    shellQuote(member.repo.split("/")[1]!)
  } $changes >"$checks_log" 2>&1; then
  cat "$checks_log"
else
  tail -c 4000 "$checks_log" >&2
  exit 6
fi
verified=$(sed -n 's/^CHECK_REVISION //p' "$checks_log" | head -n 1)
current=$(jj --ignore-working-copy log --no-graph -r "$last" -T 'commit_id')
if [ -z "$verified" ] || [ "$current" != "$verified" ]; then
  echo "CHECK_REVISION_CHANGED $verified != $current" >>"$checks_log"
  tail -c 4000 "$checks_log" >&2
  exit 6
fi
jj --ignore-working-copy bookmark set main -r "$verified"
jj --ignore-working-copy git push --bookmark main
jj git fetch >/dev/null 2>&1 || true
pushed=$(jj log --no-graph -r main@origin -T 'change_id')
[ "$pushed" = "$last" ] || { echo "PUSH_NOT_VISIBLE $pushed != $last"; exit 5; }
i=0
for ch in $changes; do
  i=$((i+1))
  echo "LANDED $i $(jj log --no-graph -r "$ch" -T 'commit_id')"
done
`
}

const landOne = (member: Member) =>
  Effect.tryPromise({
    try: async () => {
      await mkdir(scriptDir, { recursive: true })
      const path = join(scriptDir, `${member.key}.sh`)
      await writeFile(path, landingScript(member))
      await chmod(path, 0o755)
      const repoName = member.repo.split("/")[1]!
      const { stdout } = await run("python3", [lockScript, repoName, path], { maxBuffer: 16 << 20 })
      const landed = [...stdout.matchAll(/^LANDED (\d+) ([0-9a-f]{40})$/gm)].map((m) => ({
        issue: member.commits[Number(m[1]) - 1]!.issue,
        sha: m[2]!
      }))
      if (landed.length !== member.commits.length) {
        throw new Error(`landing printed ${landed.length} of ${member.commits.length}:\n${stdout}`)
      }
      for (const { issue, sha } of landed) {
        await run("gh", [
          "issue",
          "close",
          String(issue),
          "-R",
          member.repo,
          "-c",
          `Landed on main in ${sha} by the burndown merge queue (${member.key}).`
        ]).catch(() => undefined)
        await run("node", [
          claimScript,
          "release",
          `${member.repo}#${issue}`,
          "--by",
          `burndown-${member.key}`,
          "--note",
          `landed ${sha}`
        ])
          .catch(() => undefined)
      }
      return landed
    },
    catch: (cause) => landingFailure(member.key, cause)
  })

/** Lands every ready worker, serially, quarantining the ones that fail. */
export const landAll = (ready: ReadonlyArray<WorkerResult>, inFlight: ReadonlyArray<InFlight>) =>
  Effect.gen(function*() {
    const members: Array<Member> = ready.flatMap((result) => {
      const item = inFlight.find((i) => i.assignment.key === result.key)
      return item === undefined || result.commits.length === 0
        ? []
        : [{ key: result.key, repo: item.assignment.repo, commits: result.commits }]
    })
    if (members.length === 0) return { landed: [], quarantined: [] } satisfies LandReport
    const outcome = yield* MergeQueue.run(null, {
      failurePolicy: "quarantine",
      concurrency: 1,
      members: members.map((member) => ({ id: member.key, run: () => landOne(member) }))
    })
    return {
      landed: outcome.landed.map((l) => l.id),
      quarantined: outcome.quarantined.map((q) => ({ key: q.id, error: q.error.log }))
    } satisfies LandReport
  }).pipe(Effect.mapError(String))
