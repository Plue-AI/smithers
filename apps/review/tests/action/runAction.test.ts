import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { jwksCache } from "../../src/server/sessions/jwksCache.ts";
import { createReviewWorker } from "../../src/server/worker.ts";
import { buildTestEnv } from "../server/helpers/buildTestEnv.ts";
import { rsaKeypair } from "../server/helpers/rsaKeypair.ts";
import { serveJwks } from "../server/helpers/serveJwks.ts";
import { signTestJwt } from "../server/helpers/signTestJwt.ts";

const RUN_ACTION = fileURLToPath(new URL("../../action/src/runAction.ts", import.meta.url));
const FAKE_GH = fileURLToPath(new URL("./fixtures/fake-gh", import.meta.url));
// Prepended to PATH so the action's `node` spawn runs a fake review CLI.
const REVIEW_BIN = fileURLToPath(new URL("./fixtures/review-bin", import.meta.url));
// Package root so bun can resolve tsconfig paths from the correct base
const PKG_ROOT = fileURLToPath(new URL("../../", import.meta.url));

interface SpawnResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

function spawnAction(env: Record<string, string>): SpawnResult {
  const result = Bun.spawnSync(["bun", RUN_ACTION], {
    cwd: PKG_ROOT,
    env: { ...process.env, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
    exitCode: result.exitCode ?? 1,
  };
}

describe("runAction (subprocess)", () => {
  let tmp = "";

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "smithers-runaction-"));
  });

  afterEach(async () => {
    if (tmp) {
      await rm(tmp, { recursive: true, force: true });
      tmp = "";
    }
  });

  test("exits 0 with a notice when GITHUB_EVENT_PATH is empty", () => {
    const result = spawnAction({ GITHUB_EVENT_PATH: "" });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("::notice::");
    expect(result.stdout).toContain("GITHUB_EVENT_PATH is empty");
  });

  test("exits 0 with a notice when GITHUB_EVENT_PATH is unset", () => {
    const env: Record<string, string> = { ...(process.env as Record<string, string>) };
    delete env.GITHUB_EVENT_PATH;
    const result = Bun.spawnSync(["bun", RUN_ACTION], {
      cwd: PKG_ROOT,
      env,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toContain("GITHUB_EVENT_PATH is empty");
  });

  test("exits 0 with a skip notice when the event is a draft PR", async () => {
    const payload = {
      action: "opened",
      pull_request: {
        number: 1,
        draft: true,
        head: { sha: "abc", repo: { full_name: "octo/widgets" } },
        base: { repo: { full_name: "octo/widgets" } },
      },
    };
    const eventPath = join(tmp, "event.json");
    await writeFile(eventPath, JSON.stringify(payload));

    const result = spawnAction({
      GITHUB_EVENT_NAME: "pull_request",
      GITHUB_EVENT_PATH: eventPath,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("::notice::");
    expect(result.stdout).toMatch(/skipped/i);
  });

  test("exits 0 with a skip notice for a fork PR", async () => {
    const payload = {
      action: "opened",
      pull_request: {
        number: 2,
        draft: false,
        head: { sha: "abc", repo: { full_name: "fork/widgets" } },
        base: { repo: { full_name: "octo/widgets" } },
      },
    };
    const eventPath = join(tmp, "event.json");
    await writeFile(eventPath, JSON.stringify(payload));

    const result = spawnAction({
      GITHUB_EVENT_NAME: "pull_request",
      GITHUB_EVENT_PATH: eventPath,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("::notice::");
    expect(result.stdout).toMatch(/skipped/i);
  });

  const commenter = { login: "alice", type: "User" };
  const commentPayload = {
    action: "created",
    issue: { number: 7, pull_request: { url: "https://api.github.com/repos/octo/widgets/pulls/7" } },
    comment: { body: "@smithers review", user: commenter, performed_via_github_app: null },
    sender: commenter,
  };

  /** Runs the action on commentPayload; the GitHub API answers alice's permission. */
  async function spawnCommentAction(
    ghEnv: Record<string, string>,
    eventPath: string,
    permission = "write",
  ): Promise<SpawnResult> {
    const env: Record<string, string> = { ...(process.env as Record<string, string>) };
    // No OIDC vars → a run that passes the fork check fails deterministically
    // at fetchOidcToken. Status comments go to the fake gh.
    delete env.ACTIONS_ID_TOKEN_REQUEST_URL;
    delete env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
    const github = Bun.serve({ port: 0, fetch: () => Response.json({ permission }) });
    try {
      // Async spawn: the GitHub API answers from this process's event loop.
      const child = Bun.spawn(["bun", RUN_ACTION], {
        cwd: PKG_ROOT,
        env: {
          ...env,
          GITHUB_EVENT_NAME: "issue_comment",
          GITHUB_EVENT_PATH: eventPath,
          GITHUB_WORKSPACE: PKG_ROOT,
          GITHUB_REPOSITORY: "octo/widgets",
          GITHUB_API_URL: `http://127.0.0.1:${github.port}`,
          GH_TOKEN: "job-token",
          SMITHERS_GH_BIN: FAKE_GH,
          ...ghEnv,
        },
        stdout: "pipe",
        stderr: "pipe",
      });
      const [exitCode, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      return { stdout, stderr, exitCode };
    } finally {
      github.stop(true);
    }
  }

  test("skips a comment from an account without write access before any gh call", async () => {
    const eventPath = join(tmp, "event.json");
    const ghLog = join(tmp, "gh.log");
    await writeFile(eventPath, JSON.stringify(commentPayload));
    const result = await spawnCommentAction({ SMITHERS_FAKE_GH_LOG: ghLog }, eventPath, "read");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(`::notice::smithers review skipped: @alice's repository permission is "read"`);
    expect(await Bun.file(ghLog).exists()).toBe(false);
  });

  test("exits 0 with a skip notice when a comment-triggered PR is a fork", async () => {
    const eventPath = join(tmp, "event.json");
    await writeFile(eventPath, JSON.stringify(commentPayload));
    const result = await spawnCommentAction({ SMITHERS_FAKE_GH_STDOUT: '{"isCrossRepository":true}' }, eventPath);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("::notice::");
    expect(result.stdout).toContain("fork pull requests are not reviewed");
  });

  test("continues past the fork check for a same-repo comment-triggered PR", async () => {
    const eventPath = join(tmp, "event.json");
    await writeFile(eventPath, JSON.stringify(commentPayload));
    const result = await spawnCommentAction({ SMITHERS_FAKE_GH_STDOUT: '{"isCrossRepository":false}' }, eventPath);
    // Fork check passed → the next step (fetchOidcToken) fails without OIDC vars.
    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).not.toContain("fork pull requests are not reviewed");
    expect(result.stderr).toContain("ACTIONS_ID_TOKEN_REQUEST_URL");
  });

  test("fails closed when the PR's fork status cannot be resolved", async () => {
    const eventPath = join(tmp, "event.json");
    await writeFile(eventPath, JSON.stringify(commentPayload));
    const result = await spawnCommentAction({ SMITHERS_FAKE_GH_EXIT: "7" }, eventPath);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("could not determine whether PR #7 is a fork PR");
  });

  /** The real review worker for octo/widgets in `mode`, plus the runner's OIDC endpoint, on one local origin. */
  async function startReviewService(mode: "auto" | "comment") {
    jwksCache.clear();
    const keypair = await rsaKeypair(`runaction-${mode}-mode`);
    const jwks = serveJwks([keypair.publicJwk]);
    const env = await buildTestEnv();
    await env.DB.prepare(
      "INSERT INTO repos (repo, mode, prs_per_month, spend_cap_usd, created_at, repository_id, owner_id) VALUES (?, ?, ?, ?, ?, '1', '7')",
    )
      .bind("octo/widgets", mode, 5, 25, Date.now())
      .run();
    const worker = createReviewWorker({
      jwksUrl: jwks.url,
      fetchUpstream: fetch,
      now: () => Date.now(),
      anthropicBaseUrl: "http://unused",
      waitUntil: () => undefined,
    });
    const oidcToken = await signTestJwt(keypair, {
      iss: "https://token.actions.githubusercontent.com",
      aud: "smithers-review",
      exp: Math.floor(Date.now() / 1000) + 600,
      iat: Math.floor(Date.now() / 1000),
      repository: "octo/widgets",
      repository_id: "1", repository_owner_id: "7",
      repository_owner: "octo",
      ref: "refs/pull/42/merge",
      event_name: "pull_request",
    });
    const service = Bun.serve({
      port: 0,
      fetch: (request) =>
        new URL(request.url).pathname === "/oidc" ? Response.json({ value: oidcToken }) : worker.fetch(request, env),
    });
    return {
      env,
      port: service.port,
      stop: () => {
        service.stop(true);
        jwks.stop();
      },
    };
  }

  test("skips a comment-mode PR push without a status comment or a quota slot", async () => {
    const service = await startReviewService("comment");
    const env = service.env;
    try {
      const payload = {
        action: "synchronize",
        pull_request: {
          number: 42,
          draft: false,
          head: { sha: "deadbeef", repo: { full_name: "octo/widgets" } },
          base: { repo: { full_name: "octo/widgets" } },
        },
      };
      const eventPath = join(tmp, "event.json");
      await writeFile(eventPath, JSON.stringify(payload));
      const ghLog = join(tmp, "gh.log");
      // Async spawn: the worker answers from this process's event loop.
      const child = Bun.spawn(["bun", RUN_ACTION], {
        cwd: PKG_ROOT,
        env: {
          ...process.env,
          GITHUB_EVENT_NAME: "pull_request",
          GITHUB_EVENT_PATH: eventPath,
          GITHUB_REPOSITORY: "octo/widgets",
          GITHUB_WORKSPACE: PKG_ROOT,
          GITHUB_RUN_ID: "",
          ACTIONS_ID_TOKEN_REQUEST_URL: `http://127.0.0.1:${service.port}/oidc`,
          ACTIONS_ID_TOKEN_REQUEST_TOKEN: "runner-token",
          SMITHERS_REVIEW_SERVICE_URL: `http://127.0.0.1:${service.port}`,
          SMITHERS_GH_BIN: FAKE_GH,
          SMITHERS_FAKE_GH_LOG: ghLog,
          SMITHERS_FAKE_GH_STDOUT: "",
          SMITHERS_FAKE_GH_EXIT: "0",
        },
        stdout: "pipe",
        stderr: "pipe",
      });
      const [exitCode, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" });
      expect(stdout).toContain('::notice::smithers review skipped: this repo is in comment mode');
      expect(await Bun.file(ghLog).exists()).toBe(false);
      const reviewed = await env.DB.prepare("SELECT COUNT(*) AS c FROM reviewed_prs").first<{ c: number }>();
      expect(reviewed?.c).toBe(0);
      const sessions = await env.DB.prepare("SELECT COUNT(*) AS c FROM sessions").first<{ c: number }>();
      expect(sessions?.c).toBe(0);
    } finally {
      service.stop();
    }
  }, 20_000);

  test("a review whose CLI exits 0 with failed file reviews posts a partial status, not a pass", async () => {
    const service = await startReviewService("auto");
    try {
      const payload = {
        action: "opened",
        pull_request: {
          number: 42,
          draft: false,
          head: { sha: "deadbeef", repo: { full_name: "octo/widgets" } },
          base: { repo: { full_name: "octo/widgets" } },
        },
      };
      const eventPath = join(tmp, "event.json");
      await writeFile(eventPath, JSON.stringify(payload));
      const ghLog = join(tmp, "gh.log");
      const env: Record<string, string> = { ...(process.env as Record<string, string>) };
      delete env.ANTHROPIC_API_KEY;
      delete env.OPENAI_API_KEY;
      // Async spawn: the worker answers from this process's event loop.
      const child = Bun.spawn(["bun", RUN_ACTION], {
        cwd: PKG_ROOT,
        env: {
          ...env,
          PATH: `${REVIEW_BIN}${delimiter}${env.PATH ?? ""}`,
          RUNNER_TEMP: tmp,
          GITHUB_EVENT_NAME: "pull_request",
          GITHUB_EVENT_PATH: eventPath,
          GITHUB_REPOSITORY: "octo/widgets",
          GITHUB_WORKSPACE: PKG_ROOT,
          GITHUB_RUN_ID: "",
          ACTIONS_ID_TOKEN_REQUEST_URL: `http://127.0.0.1:${service.port}/oidc`,
          ACTIONS_ID_TOKEN_REQUEST_TOKEN: "runner-token",
          SMITHERS_REVIEW_SERVICE_URL: `http://127.0.0.1:${service.port}`,
          SMITHERS_GH_BIN: FAKE_GH,
          SMITHERS_FAKE_GH_LOG: ghLog,
          SMITHERS_FAKE_GH_STDOUT: "",
          SMITHERS_FAKE_GH_EXIT: "0",
          // What the CLI writes when 7 of 8 file reviews failed: exit 0, not `failed`.
          SMITHERS_FAKE_REVIEW_SUMMARY: JSON.stringify({
            status: "completed_with_warnings",
            reviewStatus: "completed_with_warnings",
            files: 8,
            findings: 2,
            inline: 1,
            failedFileReviews: 7,
          }),
        },
        stdout: "pipe",
        stderr: "pipe",
      });
      const [exitCode, , stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" });
      const posts = (await readFile(ghLog, "utf8"))
        .split("--- fake gh call ---\n")
        .slice(1)
        .map((call) => call.trim().split("\n"))
        .filter((lines) => lines[2] === "POST");
      const statuses = posts.map((lines) => (JSON.parse(lines.slice(6).join("\n")) as { body: string }).body);
      expect(statuses).toEqual([
        "<!-- smithers-review-status -->\n🔍 smithers review started",
        "<!-- smithers-review-status -->\n⚠️ smithers review partial: 7 file reviews failed; reviewed 8 files, 2 findings (1 inline)",
      ]);
    } finally {
      service.stop();
    }
  }, 20_000);

  test("reviews on the session's metered proxy even when the job env carries provider keys", async () => {
    const service = await startReviewService("auto");
    try {
      const payload = {
        action: "opened",
        pull_request: {
          number: 42,
          draft: false,
          head: { sha: "deadbeef", repo: { full_name: "octo/widgets" } },
          base: { repo: { full_name: "octo/widgets" } },
        },
      };
      const eventPath = join(tmp, "event.json");
      await writeFile(eventPath, JSON.stringify(payload));
      const envLog = join(tmp, "review-env.log");
      const child = Bun.spawn(["bun", RUN_ACTION], {
        cwd: PKG_ROOT,
        env: {
          ...(process.env as Record<string, string>),
          ANTHROPIC_API_KEY: "sk-ant-caller",
          OPENAI_API_KEY: "sk-oai-caller",
          OPENROUTER_API_KEY: "sk-or-caller",
          SMITHERS_REVIEW_SEAT: "openrouter:caller-model",
          SMITHERS_REVIEW_CHEAP_SEAT: "openrouter:caller-model",
          SMITHERS_REVIEW_VERIFY_SEAT: "openrouter:caller-model",
          SMITHERS_REVIEW_NARRATE_SEAT: "openrouter:caller-model",
          SMITHERS_REVIEW_QUIZ_SEAT: "openrouter:caller-model",
          PATH: `${REVIEW_BIN}${delimiter}${process.env.PATH ?? ""}`,
          RUNNER_TEMP: tmp,
          GITHUB_EVENT_NAME: "pull_request",
          GITHUB_EVENT_PATH: eventPath,
          GITHUB_REPOSITORY: "octo/widgets",
          GITHUB_WORKSPACE: PKG_ROOT,
          GITHUB_RUN_ID: "",
          ACTIONS_ID_TOKEN_REQUEST_URL: `http://127.0.0.1:${service.port}/oidc`,
          ACTIONS_ID_TOKEN_REQUEST_TOKEN: "runner-token",
          SMITHERS_REVIEW_SERVICE_URL: `http://127.0.0.1:${service.port}`,
          SMITHERS_GH_BIN: FAKE_GH,
          SMITHERS_FAKE_GH_LOG: join(tmp, "gh.log"),
          SMITHERS_FAKE_GH_STDOUT: "",
          SMITHERS_FAKE_GH_EXIT: "0",
          SMITHERS_FAKE_REVIEW_ENV_LOG: envLog,
          SMITHERS_FAKE_REVIEW_SUMMARY: JSON.stringify({ status: "success", reviewStatus: "success", files: 1, findings: 0 }),
        },
        stdout: "pipe",
        stderr: "pipe",
      });
      const [exitCode, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" });
      expect(stdout).not.toContain("own ANTHROPIC_API_KEY");
      expect(stdout).not.toContain("own OPENAI_API_KEY");
      const seen = Object.fromEntries(
        (await readFile(envLog, "utf8")).trim().split("\n").map((line) => line.split(/=(.*)/s).slice(0, 2)),
      );
      const { ANTHROPIC_API_KEY, ANTHROPIC_BASE_URL, ...rest } = seen;
      expect(ANTHROPIC_API_KEY).toStartWith("srs_");
      expect(ANTHROPIC_BASE_URL).not.toBe("");
      expect(rest).toEqual({
        OPENAI_API_KEY: "",
        OPENROUTER_API_KEY: "",
        SMITHERS_REVIEW_SEAT: "",
        SMITHERS_REVIEW_CHEAP_SEAT: "",
        SMITHERS_REVIEW_VERIFY_SEAT: "",
        SMITHERS_REVIEW_NARRATE_SEAT: "",
        SMITHERS_REVIEW_QUIZ_SEAT: "",
      });
    } finally {
      service.stop();
    }
  }, 20_000);

  test("throws and exits non-zero when OIDC vars are missing for a valid PR event", async () => {
    // When a valid PR event passes the gate, runAction calls fetchOidcToken
    // which throws if the OIDC env vars are not set.
    const payload = {
      action: "opened",
      pull_request: {
        number: 42,
        draft: false,
        head: { sha: "deadbeef", repo: { full_name: "octo/widgets" } },
        base: { repo: { full_name: "octo/widgets" } },
      },
    };
    const eventPath = join(tmp, "event.json");
    await writeFile(eventPath, JSON.stringify(payload));

    const env: Record<string, string> = { ...(process.env as Record<string, string>) };
    delete env.ACTIONS_ID_TOKEN_REQUEST_URL;
    delete env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
    delete env.GH_TOKEN;
    delete env.GITHUB_TOKEN;
    delete env.GH_ENTERPRISE_TOKEN;
    delete env.GITHUB_ENTERPRISE_TOKEN;
    env.GITHUB_EVENT_NAME = "pull_request";
    env.GITHUB_EVENT_PATH = eventPath;
    env.GITHUB_REPOSITORY = "octo/widgets";
    env.GITHUB_WORKSPACE = PKG_ROOT;
    env.GITHUB_RUN_ID = "";
    env.SMITHERS_GH_BIN = FAKE_GH;
    env.SMITHERS_FAKE_GH_STDOUT = "";
    env.SMITHERS_FAKE_GH_EXIT = "0";
    const ghLog = join(tmp, "gh.log");
    env.SMITHERS_FAKE_GH_LOG = ghLog;

    // Refuse to launch this valid event with a real GitHub executable.
    expect(env.SMITHERS_GH_BIN).toBe(FAKE_GH);
    const result = Bun.spawnSync(["bun", RUN_ACTION], {
      cwd: PKG_ROOT,
      env,
      stdout: "pipe",
      stderr: "pipe",
    });
    // Gate passes (valid PR) → fetchOidcToken throws → process.exit(1)
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString()).toContain("ACTIONS_ID_TOKEN_REQUEST_URL");

    const calls = (await readFile(ghLog, "utf8")).split("--- fake gh call ---\n").slice(1);
    // "started" waits for a session, so the failure is the only status comment.
    expect(calls).toHaveLength(2);
    const endpoint = "repos/octo/widgets/issues/42/comments";
    expect(calls[0]!.trim().split("\n")).toEqual([
      "api",
      "--paginate",
      endpoint,
      "--jq",
      '.[] | select(.user.login == "github-actions[bot]" and .user.type == "Bot") | select(.body | startswith("<!-- smithers-review-status -->")) | .id',
    ]);
    const lines = calls[1]!.trim().split("\n");
    expect(lines.slice(0, 6)).toEqual(["api", "--method", "POST", endpoint, "--input", "-"]);
    const status = (JSON.parse(lines.slice(6).join("\n")) as { body: string }).body;
    expect(status).toStartWith("<!-- smithers-review-status -->\n❌ smithers review failed before it could start:");
    expect(status).toContain("ACTIONS_ID_TOKEN_REQUEST_URL");
    // Not the 5s default: a cold bun subprocess boot runs 3-6s on loaded CI
    // runners.
  }, 20_000);
});

// Session rejection never launches a review.
{
const app = fileURLToPath(new URL("../../", import.meta.url));
const action = join(app, "action/src/runAction.ts");
const gh = fileURLToPath(new URL("./fixtures/fake-gh", import.meta.url));

test.each([
  [402, "repo monthly spend cap exhausted", "repository inference budget exhausted", 1],
  [402, "api key spend cap exhausted", "API key inference budget exhausted", 1],
  [503, "jwks-unavailable", "review service unavailable; retry later", 3],
] as const)("session HTTP %i %s skips neutrally", async (status, error, expected, attempts) => {
  const dir = await mkdtemp(join(tmpdir(), "review-session-status-"));
  let calls = 0;
  const service = Bun.serve({ port: 0, fetch(request) {
    if (new URL(request.url).pathname === "/oidc") return Response.json({ value: "fixture-token" });
    calls++;
    return Response.json({ error }, { status });
  } });
  try {
    const event = join(dir, "event.json");
    const log = join(dir, "gh.log");
    await writeFile(event, JSON.stringify({ action: "opened", pull_request: {
      number: 42, head: { repo: { full_name: "octo/widgets" } }, base: { repo: { full_name: "octo/widgets" } },
    } }));
    const child = Bun.spawn(["bun", action], { cwd: app, env: {
      ...process.env,
      GITHUB_EVENT_NAME: "pull_request", GITHUB_EVENT_PATH: event,
      GITHUB_REPOSITORY: "octo/widgets", GITHUB_WORKSPACE: app,
      ACTIONS_ID_TOKEN_REQUEST_URL: `http://127.0.0.1:${service.port}/oidc`,
      ACTIONS_ID_TOKEN_REQUEST_TOKEN: "fixture-runner",
      SMITHERS_REVIEW_SERVICE_URL: `http://127.0.0.1:${service.port}`,
      SMITHERS_GH_BIN: gh, SMITHERS_FAKE_GH_LOG: log,
      SMITHERS_FAKE_GH_STDOUT: "", SMITHERS_FAKE_GH_EXIT: "0",
    }, stdout: "pipe", stderr: "pipe" });
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
    expect(stdout).toContain(expected);
    expect(stdout).not.toContain("monthly PR quota is spent");
    expect(await readFile(log, "utf8")).toContain(expected);
    expect(calls).toBe(attempts);
  } finally {
    service.stop(true);
    await rm(dir, { recursive: true, force: true });
  }
}, 20_000);

}
