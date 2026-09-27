import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runReview } from "../../action/src/runReview.ts";

const FAKE_NODE = fileURLToPath(
  new URL(process.platform === "win32" ? "./fixtures/fake-node.cmd" : "./fixtures/fake-node", import.meta.url),
);

afterEach(() => {
  delete process.env.SMITHERS_FAKE_NODE_LOG;
  delete process.env.SMITHERS_FAKE_NODE_EXIT;
});

// Every test here spawns a real process. Bun's 5 s default is a cold-start
// budget, not a correctness one: the first spawn on a loaded machine has
// exceeded it. Each test carries an explicit budget instead.
const SPAWN_BUDGET = 30_000;

describe("runReview", () => {
  test("resolves with 0 when the process exits 0", async () => {
    const code = await runReview({
      // smithersRoot must be a real directory (spawn cwd must exist)
      smithersRoot: tmpdir(),
      workspace: tmpdir(),
      prNumber: 42,
      inferenceEnv: { ANTHROPIC_BASE_URL: "http://proxy", ANTHROPIC_API_KEY: "srs_tok" },
      publishUrl: "https://review.test",
      publishToken: "srs_tok",
      nodePath: FAKE_NODE,
    });
    expect(code).toBe(0);
  }, SPAWN_BUDGET);

  test("resolves with non-zero when the process exits non-zero", async () => {
    process.env.SMITHERS_FAKE_NODE_EXIT = "7";
    const code = await runReview({
      smithersRoot: tmpdir(),
      workspace: tmpdir(),
      prNumber: 7,
      inferenceEnv: {},
      publishUrl: "https://review.test",
      publishToken: "srs_tok",
      nodePath: FAKE_NODE,
    });
    expect(code).toBe(7);
  }, SPAWN_BUDGET);

  test("passes the CLI path derived from smithersRoot as the first argument", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "smithers-root-"));
    const log = join(tmp, "node-log.json");
    process.env.SMITHERS_FAKE_NODE_LOG = log;
    try {
      await runReview({
        smithersRoot: tmp,
        workspace: tmpdir(),
        prNumber: 99,
        inferenceEnv: {},
        publishUrl: "https://review.test",
        publishToken: "srs_tok",
        nodePath: FAKE_NODE,
      });
      const logged = (await Bun.file(log).json()) as { cwd: string; args: string[] };
      expect(logged.args[0]).toBe(join(tmp, "apps", "review", "bin", "smithers-review.mjs"));
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  }, SPAWN_BUDGET);

  test("passes workspace, --pr, prNumber, and --publish as arguments", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "smithers-root-"));
    const log = join(tmp, "node-log.json");
    process.env.SMITHERS_FAKE_NODE_LOG = log;
    try {
      await runReview({
        smithersRoot: tmp,
        workspace: "/some/workspace",
        prNumber: 55,
        inferenceEnv: {},
        publishUrl: "https://review.test",
        publishToken: "srs_tok",
        nodePath: FAKE_NODE,
      });
      const logged = (await Bun.file(log).json()) as { cwd: string; args: string[] };
      expect(logged.args[1]).toBe("/some/workspace");
      expect(logged.args[2]).toBe("--pr");
      expect(logged.args[3]).toBe("55");
      expect(logged.args[4]).toBe("--publish");
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  }, SPAWN_BUDGET);

  test("appends --quiz <mode> when quiz is set, and omits it otherwise", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "smithers-root-"));
    const log = join(tmp, "node-log.json");
    process.env.SMITHERS_FAKE_NODE_LOG = log;
    try {
      await runReview({
        smithersRoot: tmp,
        workspace: "/some/workspace",
        prNumber: 55,
        inferenceEnv: {},
        publishUrl: "https://review.test",
        publishToken: "srs_tok",
        quiz: "on",
        nodePath: FAKE_NODE,
      });
      let logged = (await Bun.file(log).json()) as { args: string[] };
      expect(logged.args.slice(-2)).toEqual(["--quiz", "on"]);

      await runReview({
        smithersRoot: tmp,
        workspace: "/some/workspace",
        prNumber: 55,
        inferenceEnv: {},
        publishUrl: "https://review.test",
        publishToken: "srs_tok",
        nodePath: FAKE_NODE,
      });
      logged = (await Bun.file(log).json()) as { args: string[] };
      expect(logged.args).not.toContain("--quiz");
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  }, SPAWN_BUDGET);

  test("appends --concurrency <n> when concurrency is set, and omits it otherwise", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "smithers-root-"));
    const log = join(tmp, "node-log.json");
    process.env.SMITHERS_FAKE_NODE_LOG = log;
    const base = {
      smithersRoot: tmp,
      workspace: "/some/workspace",
      prNumber: 55,
      inferenceEnv: {},
      publishUrl: "https://review.test",
      publishToken: "srs_tok",
      nodePath: FAKE_NODE,
    };
    try {
      await runReview({ ...base, concurrency: 4 });
      let logged = (await Bun.file(log).json()) as { args: string[] };
      expect(logged.args.slice(-2)).toEqual(["--concurrency", "4"]);

      await runReview(base);
      logged = (await Bun.file(log).json()) as { args: string[] };
      expect(logged.args).not.toContain("--concurrency");
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  }, SPAWN_BUDGET);

  test("never hands the CLI the job's OIDC token request", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "smithers-root-"));
    const log = join(tmp, "node-log.json");
    process.env.SMITHERS_FAKE_NODE_LOG = log;
    process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN = "request-token";
    process.env.ACTIONS_ID_TOKEN_REQUEST_URL = "https://token.test";
    try {
      await runReview({
        smithersRoot: tmp,
        workspace: "/some/workspace",
        prNumber: 1,
        inferenceEnv: {},
        publishUrl: "https://review.test",
        publishToken: "srs_tok",
        nodePath: FAKE_NODE,
      });
      const logged = (await Bun.file(log).json()) as { oidc: string[] };
      expect(logged.oidc).toEqual([]);
    } finally {
      delete process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
      delete process.env.ACTIONS_ID_TOKEN_REQUEST_URL;
      await rm(tmp, { recursive: true, force: true });
    }
  }, SPAWN_BUDGET);

  test("runs with smithersRoot as cwd, not the workspace", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "smithers-root-"));
    const log = join(tmp, "node-log.json");
    process.env.SMITHERS_FAKE_NODE_LOG = log;
    try {
      await runReview({
        smithersRoot: tmp,
        workspace: "/some/workspace",
        prNumber: 1,
        inferenceEnv: {},
        publishUrl: "https://review.test",
        publishToken: "srs_tok",
        nodePath: FAKE_NODE,
      });
      const logged = (await Bun.file(log).json()) as { cwd: string; args: string[] };
      // cwd should be smithersRoot; use realpath to resolve macOS symlinks (/tmp → /private/tmp)
      expect(logged.cwd).toBe(await realpath(tmp));
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  }, SPAWN_BUDGET);
});
