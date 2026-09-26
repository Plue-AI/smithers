import { afterEach, expect, test } from "bun:test";
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import * as SeatResolver from "@smthrs/agent/SeatResolver";
import { resolveInferenceEnv } from "../../action/src/resolveInferenceEnv.ts";
import { layerNode } from "../../src/workflow/reviewLayer.ts";
import { startFixtureProvider } from "../workflow/fixtures/fixtureProvider.ts";

/**
 * The shipped bin, run with exactly the environment the GitHub action hands it.
 *
 * Every flow suite composes the review in-process, so none of them can see a
 * credential the action never passes. This one spawns `bin/smithers-review.mjs`
 * under the keys `action/src/runReview.ts` sets over `resolveInferenceEnv`,
 * with no `process.env` underneath, against a local provider. Node, not Bun:
 * the durable composition builds an undici client Bun cannot tear down.
 */

const packageRoot = fileURLToPath(new URL("../..", import.meta.url));
const bin = join(packageRoot, "bin", "smithers-review.mjs");
const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true, maxRetries: 30, retryDelay: 200 });
  }
});

function tempRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "review-action-env-"));
  tempDirs.push(dir);
  const run = (args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "pipe" });
  run(["init"]);
  run(["config", "user.email", "test@example.com"]);
  run(["config", "user.name", "Test User"]);
  run(["config", "commit.gpgsign", "false"]);
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "src/file0.ts"), "export const value0 = 0;\n");
  writeFileSync(join(dir, ".gitignore"), ".smithers-review/\n");
  run(["add", "."]);
  run(["commit", "-m", "base"]);
  writeFileSync(join(dir, "src/file0.ts"), "export const value0 = 0;\nexport const next0 = 1;\n");
  return dir;
}

/** The keys `action/src/runReview.ts` sets for the child, minus the job's own `process.env`. */
function actionEnv(inference: Record<string, string>, summaryPath: string): Record<string, string> {
  return {
    PATH: process.env.PATH ?? "",
    HOME: process.env.HOME ?? "",
    ...inference,
    SMITHERS_REVIEW_PUBLISH_URL: "http://127.0.0.1:1",
    SMITHERS_REVIEW_PUBLISH_TOKEN: "srs_fixture",
    GH_TOKEN: "",
    SMITHERS_REVIEW_SUMMARY_PATH: summaryPath,
  };
}

test("the proxy environment composes every agent action with no judge credential", () => {
  const inference = resolveInferenceEnv({ anthropicBaseUrl: "http://127.0.0.1:1", sessionToken: "srs_fixture" });
  const env = actionEnv(inference.env, "/unused/summary.json");
  expect(Object.keys(env).filter((key) => key.includes("GATEWAY"))).toEqual([]);
  expect(() => layerNode({ filename: "/unused/review.db", seats: SeatResolver.layerNoop(), environment: env }))
    .not.toThrow();
});

test("the bin reviews a change under the proxy environment the action passes", async () => {
  const repo = tempRepo();
  const summaryPath = join(repo, ".smithers-review", "summary.json");
  mkdirSync(join(repo, ".smithers-review"), { recursive: true });
  const provider = await startFixtureProvider(() => ({
    status: "success",
    message: "",
    summary: null,
    comments: [{
      path: "src/file0.ts",
      content: "Running `pnpm test` fails on this branch because `next0` is never exported from the barrel.",
      severity: "major",
      category: "correctness",
      confidence: "confirmed",
      startLine: 2,
      endLine: 2,
      existingCode: "",
      suggestionCode: "",
      thinking: "",
    }],
    warnings: [],
  }));
  try {
    const inference = resolveInferenceEnv({ anthropicBaseUrl: provider.url, sessionToken: "srs_fixture" });
    const env = actionEnv(inference.env, summaryPath);
    expect("AI_GATEWAY_API_KEY" in env).toBe(false);
    const child = spawn("node", [
      bin, repo, "--no-narrate", "--no-verify", "--quiz", "off", "--db", join(repo, ".smithers-review", "review.db"),
    ], { cwd: packageRoot, env, stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (data) => { stderr += data.toString(); });
    child.stdout.resume();
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });

    expect(code, stderr).toBe(0);
    const summary = JSON.parse(readFileSync(summaryPath, "utf8"));
    expect(summary.status).toBe("success");
    expect(summary.findings).toBe(1);
    expect(provider.requests()).toBe(1);
  } finally {
    await provider.close();
  }
}, 240_000);
