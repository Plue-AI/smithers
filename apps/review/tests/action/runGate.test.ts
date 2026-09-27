import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const RUN_GATE = fileURLToPath(new URL("../../action/src/runGate.ts", import.meta.url));
// Package root so bun can resolve tsconfig paths
const PKG_ROOT = fileURLToPath(new URL("../../", import.meta.url));

interface SpawnResult {
  stdout: string;
  exitCode: number;
}

function spawnGate(env: Record<string, string>): SpawnResult {
  const result = Bun.spawnSync(["bun", RUN_GATE], {
    cwd: PKG_ROOT,
    env: { ...process.env, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    stdout: result.stdout.toString(),
    exitCode: result.exitCode ?? 1,
  };
}

/** A GitHub API answering every collaborator-permission read with `answer`. */
function serveGitHubPermissions(answer: { status: number; permission?: string }) {
  const reads: { path: string; authorization: string | null }[] = [];
  const server = Bun.serve({
    port: 0,
    fetch: (request) => {
      reads.push({ path: new URL(request.url).pathname, authorization: request.headers.get("authorization") });
      return answer.status === 200
        ? Response.json({ permission: answer.permission })
        : new Response("", { status: answer.status });
    },
  });
  return { url: `http://127.0.0.1:${server.port}`, reads, stop: () => server.stop(true) };
}

/** Spawns the gate without blocking, so this process's GitHub API answers. */
async function spawnGateAsync(env: Record<string, string>): Promise<SpawnResult> {
  const child = Bun.spawn(["bun", RUN_GATE], { cwd: PKG_ROOT, env: { ...process.env, ...env }, stdout: "pipe", stderr: "pipe" });
  const [exitCode, stdout] = await Promise.all([child.exited, new Response(child.stdout).text()]);
  return { stdout, exitCode };
}

describe("runGate (subprocess)", () => {
  let tmp = "";
  let outputFile = "";

  afterEach(async () => {
    if (tmp) {
      await rm(tmp, { recursive: true, force: true });
      tmp = "";
      outputFile = "";
    }
  });

  async function setup() {
    tmp = await mkdtemp(join(tmpdir(), "smithers-rungate-"));
    outputFile = join(tmp, "github-output");
    await writeFile(outputFile, "");
    return { outputFile, tmp };
  }

  async function readOutput(path: string): Promise<Record<string, string>> {
    const text = await Bun.file(path).text();
    const result: Record<string, string> = {};
    for (const line of text.split("\n")) {
      const idx = line.indexOf("=");
      if (idx > 0) result[line.slice(0, idx)] = line.slice(idx + 1);
    }
    return result;
  }

  test("writes should-run=false and exits 0 when GITHUB_EVENT_PATH is empty", async () => {
    const { outputFile } = await setup();
    const result = spawnGate({
      GITHUB_EVENT_NAME: "",
      GITHUB_EVENT_PATH: "",
      GITHUB_OUTPUT: outputFile,
    });
    expect(result.exitCode).toBe(0);
    const out = await readOutput(outputFile);
    expect(out["should-run"]).toBe("false");
  });

  test("writes only should-run=true for a valid open PR event", async () => {
    const { outputFile, tmp } = await setup();
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

    const result = spawnGate({
      GITHUB_EVENT_NAME: "pull_request",
      GITHUB_EVENT_PATH: eventPath,
      GITHUB_OUTPUT: outputFile,
    });
    expect(result.exitCode).toBe(0);
    const out = await readOutput(outputFile);
    expect(out["should-run"]).toBe("true");
    expect(out).toEqual({ "should-run": "true" });
  });

  test("writes should-run=false for a draft PR", async () => {
    const { outputFile, tmp } = await setup();
    const payload = {
      action: "opened",
      pull_request: {
        number: 7,
        draft: true,
        head: { sha: "aaa", repo: { full_name: "octo/widgets" } },
        base: { repo: { full_name: "octo/widgets" } },
      },
    };
    const eventPath = join(tmp, "event.json");
    await writeFile(eventPath, JSON.stringify(payload));

    const result = spawnGate({
      GITHUB_EVENT_NAME: "pull_request",
      GITHUB_EVENT_PATH: eventPath,
      GITHUB_OUTPUT: outputFile,
    });
    expect(result.exitCode).toBe(0);
    const out = await readOutput(outputFile);
    expect(out["should-run"]).toBe("false");
    expect(result.stdout).toMatch(/notice/i);
  });

  test("writes should-run=false and exits 0 when the event file contains invalid JSON", async () => {
    const { outputFile, tmp } = await setup();
    const eventPath = join(tmp, "event.json");
    await writeFile(eventPath, "not-json{{{{");

    const result = spawnGate({
      GITHUB_EVENT_NAME: "pull_request",
      GITHUB_EVENT_PATH: eventPath,
      GITHUB_OUTPUT: outputFile,
    });
    expect(result.exitCode).toBe(0);
    const out = await readOutput(outputFile);
    expect(out["should-run"]).toBe("false");
    expect(result.stdout).toContain("::notice::");
  });

  test("writes should-run=false for an unsupported event type", async () => {
    const { outputFile, tmp } = await setup();
    const eventPath = join(tmp, "event.json");
    await writeFile(eventPath, JSON.stringify({ ref: "refs/heads/main" }));

    const result = spawnGate({
      GITHUB_EVENT_NAME: "push",
      GITHUB_EVENT_PATH: eventPath,
      GITHUB_OUTPUT: outputFile,
    });
    expect(result.exitCode).toBe(0);
    const out = await readOutput(outputFile);
    expect(out["should-run"]).toBe("false");
  });

  const commenter = { login: "alice", type: "User" };
  const commentPayload = {
    action: "created",
    issue: { number: 7, pull_request: {} },
    comment: { body: "@smithers review", user: commenter, performed_via_github_app: null },
    sender: commenter,
  };

  for (const [permission, shouldRun] of [["write", "true"], ["admin", "true"], ["read", "false"]] as const) {
    test(`reads the commenter's permission with the job token: ${permission} → should-run=${shouldRun}`, async () => {
      const { outputFile, tmp } = await setup();
      const eventPath = join(tmp, "event.json");
      await writeFile(eventPath, JSON.stringify(commentPayload));
      const github = serveGitHubPermissions({ status: 200, permission });
      try {
        const result = await spawnGateAsync({
          GITHUB_EVENT_NAME: "issue_comment",
          GITHUB_EVENT_PATH: eventPath,
          GITHUB_OUTPUT: outputFile,
          GITHUB_API_URL: github.url,
          GITHUB_REPOSITORY: "octo/widgets",
          GH_TOKEN: "job-token",
        });
        expect(result.exitCode).toBe(0);
        expect(await readOutput(outputFile)).toEqual({ "should-run": shouldRun });
        expect(github.reads).toEqual([
          { path: "/repos/octo/widgets/collaborators/alice/permission", authorization: "Bearer job-token" },
        ]);
        if (shouldRun === "false") {
          expect(result.stdout).toContain(
            `::notice::smithers review skipped: @alice's repository permission is "read"; write, maintain, or admin is required`,
          );
        }
      } finally {
        github.stop();
      }
    });
  }

  test("fails closed with a warning when GitHub does not answer the permission read", async () => {
    const { outputFile, tmp } = await setup();
    const eventPath = join(tmp, "event.json");
    await writeFile(eventPath, JSON.stringify(commentPayload));
    const github = serveGitHubPermissions({ status: 502 });
    try {
      const result = await spawnGateAsync({
        GITHUB_EVENT_NAME: "issue_comment",
        GITHUB_EVENT_PATH: eventPath,
        GITHUB_OUTPUT: outputFile,
        GITHUB_API_URL: github.url,
        GITHUB_REPOSITORY: "octo/widgets",
        GH_TOKEN: "job-token",
      });
      expect(result.exitCode).toBe(0);
      expect(await readOutput(outputFile)).toEqual({ "should-run": "false" });
      expect(result.stdout).toContain(
        "::warning::smithers review skipped: could not read @alice's permission (GitHub answered 502); failing closed",
      );
    } finally {
      github.stop();
    }
  });

  test("fails closed with a warning without a job token", async () => {
    const { outputFile, tmp } = await setup();
    const eventPath = join(tmp, "event.json");
    await writeFile(eventPath, JSON.stringify(commentPayload));
    const result = spawnGate({
      GITHUB_EVENT_NAME: "issue_comment",
      GITHUB_EVENT_PATH: eventPath,
      GITHUB_OUTPUT: outputFile,
      GITHUB_REPOSITORY: "octo/widgets",
      GH_TOKEN: "",
    });
    expect(result.exitCode).toBe(0);
    expect(await readOutput(outputFile)).toEqual({ "should-run": "false" });
    expect(result.stdout).toContain("::warning::smithers review skipped: no GitHub token");
  });
});
