import { afterEach, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const bin = fileURLToPath(new URL("../../bin/smithers-review.mjs", import.meta.url));
const dirs: string[] = [];

afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function cleanRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), "review-seat-credentials-"));
  dirs.push(repo);
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, stdio: "pipe" });
  git("init");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Test User");
  writeFileSync(join(repo, "file.txt"), "unchanged\n");
  git("add", "file.txt");
  git("commit", "-m", "initial");
  // With no change set, enabled seats are admitted without making provider calls.
  return repo;
}

function run(repo: string, flags: readonly string[], seats: Record<string, string | undefined>) {
  const summary = join(repo, "summary.json");
  const env: Record<string, string> = { ...process.env } as Record<string, string>;
  for (const key of [
    "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "OPENROUTER_API_KEY",
    "SMITHERS_REVIEW_SEAT", "SMITHERS_REVIEW_CHEAP_SEAT", "SMITHERS_REVIEW_VERIFY_SEAT",
    "SMITHERS_REVIEW_NARRATE_SEAT", "SMITHERS_REVIEW_QUIZ_SEAT",
  ]) delete env[key];
  for (const [key, value] of Object.entries(seats)) if (value !== undefined) env[key] = value;
  env.SMITHERS_REVIEW_SUMMARY_PATH = summary;
  const result = Bun.spawnSync(["node", bin, repo, ...flags, "--db", join(repo, "review.db")], {
    env, stdout: "pipe", stderr: "pipe",
  });
  return {
    exitCode: result.exitCode,
    stderr: result.stderr.toString(),
    summary: JSON.parse(readFileSync(summary, "utf8")) as { status: string; error?: string },
  };
}

test.each([
  {
    name: "review only",
    flags: ["--no-narrate", "--no-verify", "--quiz", "off"],
    seats: { SMITHERS_REVIEW_SEAT: "openai:gpt-6-sol", OPENAI_API_KEY: "synthetic-key" },
    missing: "OPENAI_API_KEY",
  },
  {
    name: "narration only",
    flags: ["--no-review", "--quiz", "off"],
    seats: {
      SMITHERS_REVIEW_SEAT: "openai:gpt-6-sol",
      SMITHERS_REVIEW_VERIFY_SEAT: "openrouter:vendor/model",
      SMITHERS_REVIEW_NARRATE_SEAT: "anthropic:claude-haiku-4-5",
      ANTHROPIC_API_KEY: "synthetic-key",
    },
    missing: "ANTHROPIC_API_KEY",
  },
])("$name requires only its active credential", ({ flags, seats, missing }) => {
  const repo = cleanRepo();
  const enabled = run(repo, flags, seats);
  expect(enabled.exitCode).toBe(0);
  expect(enabled.summary.status).not.toBe("failed");

  const missingActive = run(repo, flags, { ...seats, [missing]: undefined });
  expect(missingActive.exitCode).toBe(1);
  expect(missingActive.summary).toMatchObject({ status: "failed" });
  expect(missingActive.summary.error).toContain(missing);
}, 180_000);

test("default run refuses a missing active review credential", () => {
  const result = run(cleanRepo(), [], {});
  expect(result.exitCode).toBe(1);
  expect(result.summary.error).toContain("ANTHROPIC_API_KEY");
}, 180_000);

test("walkthrough-only run needs no provider credential", () => {
  const result = run(cleanRepo(), ["--no-review", "--no-narrate", "--quiz", "off"], {});
  expect(result.exitCode).toBe(0);
  expect(result.summary.status).not.toBe("failed");
}, 180_000);

test("verification override needs its credential only when verification is enabled", () => {
  const repo = cleanRepo();
  const seats = {
    SMITHERS_REVIEW_SEAT: "openai:gpt-6-sol",
    SMITHERS_REVIEW_VERIFY_SEAT: "anthropic:claude-sonnet-4-5",
    OPENAI_API_KEY: "synthetic-key",
  };
  const withoutVerification = run(repo, ["--no-narrate", "--no-verify", "--quiz", "off"], seats);
  expect(withoutVerification.exitCode).toBe(0);
  const withVerification = run(repo, ["--no-narrate", "--quiz", "off"], seats);
  expect(withVerification.exitCode).toBe(1);
  expect(withVerification.summary.error).toContain("ANTHROPIC_API_KEY");
}, 180_000);

test.each(["on", "auto"] as const)("quiz %s checks its override without review or narration", (mode) => {
  const repo = cleanRepo();
  const flags = ["--no-review", "--no-narrate", "--quiz", mode];
  const seats = {
    SMITHERS_REVIEW_SEAT: "anthropic:claude-sonnet-4-5",
    SMITHERS_REVIEW_QUIZ_SEAT: "openai:gpt-6-sol",
    OPENAI_API_KEY: "synthetic-key",
  };
  expect(run(repo, flags, seats).exitCode).toBe(0);
  const missing = run(repo, flags, { ...seats, OPENAI_API_KEY: undefined });
  expect(missing.exitCode).toBe(1);
  expect(missing.summary.error).toContain("OPENAI_API_KEY");
}, 180_000);
