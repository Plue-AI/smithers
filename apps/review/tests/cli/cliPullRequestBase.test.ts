import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const bin = fileURLToPath(new URL("../../bin/smithers-review.mjs", import.meta.url));
const gitEnv = {
  ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_"))),
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_TERMINAL_PROMPT: "0",
};

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, env: gitEnv, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "review-pr-base-"));
  const bare = join(dir, "remote.git");
  const author = join(dir, "author");
  const clone = join(dir, "clone");
  git(dir, "init", "--bare", bare);
  git(dir, "init", "-b", "main", author);
  git(author, "remote", "add", "origin", bare);
  git(author, "config", "user.name", "Review Test");
  git(author, "config", "user.email", "review@example.test");
  writeFileSync(join(author, "base.ts"), "export const base = 0;\n");
  git(author, "add", ".");
  git(author, "commit", "-m", "base A");
  git(author, "push", "-u", "origin", "main");
  git(bare, "symbolic-ref", "HEAD", "refs/heads/main");
  git(dir, "clone", bare, clone);
  const staleBase = git(clone, "rev-parse", "origin/main");
  writeFileSync(join(author, "base.ts"), "export const base = 1;\n");
  git(author, "add", ".");
  git(author, "commit", "-m", "base B");
  git(author, "push", "origin", "main");
  const baseSha = git(author, "rev-parse", "HEAD");
  git(author, "switch", "-c", "feature");
  writeFileSync(join(author, "feature.ts"), "export const feature = true;\n");
  git(author, "add", ".");
  git(author, "commit", "-m", "feature");
  git(author, "push", "origin", "feature");
  const headSha = git(author, "rev-parse", "HEAD");
  // The PR head is present while origin/main still points to A.
  git(clone, "fetch", "origin", "feature");
  expect(git(clone, "cat-file", "-t", headSha)).toBe("commit");
  expect(git(clone, "rev-parse", "origin/main")).toBe(staleBase);
  expect(staleBase).not.toBe(baseSha);

  const gh = join(dir, "gh.cjs");
  writeFileSync(gh, `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
if (args[0] === "pr" && args[1] === "view") {
  process.stdout.write(process.env.TEST_PR_JSON);
} else if (args[0] === "api" && args.includes("repos/acme/repo/git/ref/heads/main")) {
  process.stdout.write(process.env.TEST_PR_BASE_SHA);
} else if (args[0] === "api" && args.includes("--paginate")) {
  process.stdout.write(JSON.stringify({ filename: "feature.ts", additions: 1, deletions: 0, patch: "@@ -0,0 +1 @@\\n+export const feature = true;" }) + "\\n");
} else if (args[0] === "api" && args.includes("POST")) {
  fs.writeFileSync(process.env.TEST_PR_POST, fs.readFileSync(0));
  process.stdout.write(JSON.stringify({ html_url: "https://github.test/review/1" }));
} else {
  process.stderr.write("unexpected gh call: " + args.join(" "));
  process.exit(2);
}
`);
  chmodSync(gh, 0o755);
  return { dir, bare, author, clone, gh, staleBase, baseSha, headSha };
}

function run(f: ReturnType<typeof fixture>, name: string, target: string[], baseSha: string | null = f.baseSha) {
  const summary = join(f.dir, `${name}.json`);
  const preview = join(f.dir, `${name}.html`);
  const posted = join(f.dir, `${name}-posted.json`);
  const result = Bun.spawnSync(
    ["node", bin, f.clone, ...target, "--no-review", "--no-narrate", "--no-verify", "--quiz", "off", "--out", preview, "--db", join(f.dir, `${name}.db`)],
    {
      cwd: f.clone,
      env: {
        ...gitEnv,
        SMITHERS_GH_BIN: f.gh,
        SMITHERS_REVIEW_SUMMARY_PATH: summary,
        TEST_PR_POST: posted,
        TEST_PR_BASE_SHA: baseSha ?? "",
        TEST_PR_JSON: JSON.stringify({
          number: 1,
          url: "https://github.test/acme/repo/pull/1",
          baseRefName: "main",
          // `gh pr view` can return a stale baseRefOid; current branch ref wins.
          baseRefOid: f.staleBase,
          headRefName: "feature",
          headRefOid: f.headSha,
          title: "Feature",
          body: "Add feature.ts",
        }),
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  return { code: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString(), summary, preview, posted };
}

function expectOnlyFeature(runResult: ReturnType<typeof run>, posted: boolean) {
  if (runResult.code !== 0) throw new Error(runResult.stderr.slice(-1500));
  const preview = readFileSync(runResult.preview, "utf8");
  expect(preview.includes("feature.ts")).toBe(true);
  expect(preview.includes("base.ts")).toBe(false);
  const summary = JSON.parse(readFileSync(runResult.summary, "utf8"));
  expect(summary.files).toBe(1);
  expect(summary.status).toBe("skipped");
  expect(summary.tokens).toEqual({ input: 0, output: 0, total: 0 });
  if (posted) {
    const payload = JSON.parse(readFileSync(runResult.posted, "utf8"));
    expect(payload.body).toContain("### Reading order");
    const readingOrder = payload.body.split("### Reading order")[1].split("generated by smithers review")[0];
    expect([...readingOrder.matchAll(/- `([^`]+)`/g)].map((match: RegExpMatchArray) => match[1])).toEqual(["feature.ts"]);
    expect(payload.body).toContain("| `feature.ts` |");
    expect(payload.body).not.toContain("`base.ts`");
  }
}

test("--pr reviews exactly the feature with an existing stale origin/main and already-present head", () => {
  const f = fixture();
  try {
    expectOnlyFeature(run(f, "stale", ["--pr", "1"]), true);
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
}, 120_000);

test("--pr with a fresh base and an explicit revision range each review only the feature", () => {
  const f = fixture();
  try {
    git(f.clone, "fetch", "origin", "main");
    expect(git(f.clone, "rev-parse", "origin/main")).toBe(f.baseSha);
    expectOnlyFeature(run(f, "fresh", ["--pr", "1"]), true);
    expectOnlyFeature(run(f, "range", ["--from", f.baseSha, "--to", f.headSha]), false);
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
}, 240_000);

test("--pr fails clearly when its immutable base revision is unavailable", () => {
  const f = fixture();
  try {
    const missing = "f".repeat(40);
    const result = run(f, "missing", ["--pr", "1"], missing);
    expect(result.code).toBe(1);
    const error = `smithers-review: could not obtain PR base commit ${missing} from any remote`;
    expect(result.stderr).toContain(error);
    expect(JSON.parse(readFileSync(result.summary, "utf8"))).toMatchObject({ status: "failed", error });
    expect(existsSync(result.preview)).toBe(false);
    expect(existsSync(result.posted)).toBe(false);
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
}, 120_000);

test("--pr fetches a missing immutable base commit without moving the stale tracking branch", () => {
  const f = fixture();
  try {
    git(f.clone, "cat-file", "-t", f.headSha);
    git(f.author, "switch", "main");
    git(f.author, "commit", "--allow-empty", "-m", "new base with unchanged tree");
    git(f.author, "push", "origin", "main");
    const laterBase = git(f.author, "rev-parse", "HEAD");
    expect(() => git(f.clone, "cat-file", "-t", laterBase)).toThrow();
    expectOnlyFeature(run(f, "fetch-base", ["--pr", "1"], laterBase), true);
    expect(git(f.clone, "cat-file", "-t", laterBase)).toBe("commit");
    expect(git(f.clone, "rev-parse", "origin/main")).toBe(f.staleBase);
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
}, 120_000);

test("--pr fetches its base from another configured remote when origin lacks the commit", () => {
  const f = fixture();
  try {
    const upstream = join(f.dir, "upstream.git");
    git(f.dir, "init", "--bare", upstream);
    git(f.author, "remote", "add", "upstream", upstream);
    git(f.clone, "remote", "add", "upstream", upstream);
    git(f.author, "switch", "main");
    git(f.author, "commit", "--allow-empty", "-m", "upstream base with unchanged tree");
    git(f.author, "push", "upstream", "main");
    const upstreamBase = git(f.author, "rev-parse", "HEAD");
    expect(() => git(f.bare, "cat-file", "-t", upstreamBase)).toThrow();
    expect(() => git(f.clone, "cat-file", "-t", upstreamBase)).toThrow();
    expectOnlyFeature(run(f, "alternate-base", ["--pr", "1"], upstreamBase), true);
    expect(git(f.clone, "cat-file", "-t", upstreamBase)).toBe("commit");
    expect(git(f.clone, "rev-parse", "origin/main")).toBe(f.staleBase);
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
}, 120_000);

test("--pr rejects missing, invalid, and noncommit base IDs before preview or publication", () => {
  const f = fixture();
  try {
    const blobPath = join(f.clone, "blob.txt");
    writeFileSync(blobPath, "not a commit\n");
    const blobSha = git(f.clone, "hash-object", "-w", blobPath);
    for (const [name, sha] of [["missing-id", null], ["invalid-id", "main"], ["blob-id", blobSha]] as const) {
      const result = run(f, name, ["--pr", "1"], sha);
      const error = sha === blobSha
        ? `smithers-review: could not obtain PR base commit ${blobSha} from any remote`
        : "smithers-review: PR metadata has no valid immutable base commit ID";
      expect(result.code).toBe(1);
      expect(result.stderr).toContain(error);
      expect(JSON.parse(readFileSync(result.summary, "utf8"))).toMatchObject({ status: "failed", error });
      expect(existsSync(result.preview)).toBe(false);
      expect(existsSync(result.posted)).toBe(false);
    }
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
}, 180_000);
