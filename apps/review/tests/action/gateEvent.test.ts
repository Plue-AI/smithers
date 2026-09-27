import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  gateEvent,
  githubPermissionReader,
  permissionReaderFromEnv,
  type PermissionAnswer,
  type PermissionReader,
} from "../../action/src/gateEvent.ts";

interface Vector {
  name: string;
  action: string;
  author: { login: string; type: string };
  sender: { login: string; type: string } | null;
  viaApp?: boolean;
  changes?: string[];
  permissions: Record<string, string | number | null>;
  expect: "maintainer" | "not" | "unavailable";
}

// The rule's cases, shared with the backend's Go test.
const spec = JSON.parse(
  readFileSync(new URL("../../../../docs/api/github-maintainer-comment.vectors.json", import.meta.url), "utf8"),
) as { vectors: Vector[] };

/** Answers from `permissions` the way GitHub would, recording each read. */
function reader(permissions: Vector["permissions"], reads: string[] = []): PermissionReader {
  return async (login): Promise<PermissionAnswer> => {
    reads.push(login);
    if (!(login in permissions)) return { status: 404 };
    const answer = permissions[login];
    if (answer === null) return { error: "connection reset" };
    return typeof answer === "number" ? { status: answer } : { status: 200, permission: answer };
  };
}

const issuePr = (number: number) => ({
  number,
  pull_request: { url: "https://api.github.com/repos/octo/widgets/pulls/7" },
});
const alice = { login: "alice", type: "User" };

/** A PR comment by `alice`, sent by her. */
function commentEvent(fields: { action?: string; body?: string; comment?: Record<string, unknown>; sender?: unknown } = {}) {
  return {
    action: fields.action ?? "created",
    issue: issuePr(7),
    comment: { body: fields.body ?? "@smithers review", user: alice, performed_via_github_app: null, ...fields.comment },
    sender: "sender" in fields ? fields.sender : alice,
  };
}

describe("gateEvent", () => {
  describe("pull_request", () => {
    test.each([null, {}, { full_name: "" }])("skips missing head repository %j", async (repo) => {
      expect((await gateEvent({ eventName: "pull_request", payload: {
        action: "opened", pull_request: { number: 1, head: { repo }, base: { repo: { full_name: "octo/widgets" } } },
      } })).run).toBe(false);
    });

    test("runs non-draft same-repo PR and surfaces the head sha", async () => {
      const decision = await gateEvent({
        eventName: "pull_request",
        payload: {
          action: "synchronize",
          pull_request: {
            number: 42,
            draft: false,
            head: { sha: "abc123", repo: { full_name: "octo/widgets" } },
            base: { repo: { full_name: "octo/widgets" } },
          },
        },
      });
      expect(decision.run).toBe(true);
      if (decision.run) {
        expect(decision.eventName).toBe("pull_request");
        expect(decision.prNumber).toBe(42);
        expect(decision.headSha).toBe("abc123");
      }
    });

    test("skips drafts", async () => {
      const d = await gateEvent({
        eventName: "pull_request",
        payload: {
          action: "opened",
          pull_request: {
            number: 1,
            draft: true,
            head: { repo: { full_name: "octo/widgets" } },
            base: { repo: { full_name: "octo/widgets" } },
          },
        },
      });
      expect(d.run).toBe(false);
      if (!d.run) expect(d.reason).toMatch(/draft/i);
    });

    test("skips fork PRs", async () => {
      const d = await gateEvent({
        eventName: "pull_request",
        payload: {
          action: "opened",
          pull_request: {
            number: 1,
            draft: false,
            head: { repo: { full_name: "drive-by/fork" }, sha: "x" },
            base: { repo: { full_name: "octo/widgets" } },
          },
        },
      });
      expect(d.run).toBe(false);
      if (!d.run) expect(d.reason).toMatch(/fork/i);
    });

    test("skips actions that do not change the diff", async () => {
      const d = await gateEvent({
        eventName: "pull_request",
        payload: {
          action: "labeled",
          pull_request: {
            number: 3,
            draft: false,
            head: { sha: "abc", repo: { full_name: "octo/widgets" } },
            base: { repo: { full_name: "octo/widgets" } },
          },
        },
      });
      expect(d.run).toBe(false);
      if (!d.run) expect(d.reason).toMatch(/does not change the diff/);
    });

    test("runs ready_for_review on a non-draft same-repo PR", async () => {
      const d = await gateEvent({
        eventName: "pull_request",
        payload: {
          action: "ready_for_review",
          pull_request: {
            number: 5,
            draft: false,
            head: { sha: "def456", repo: { full_name: "octo/widgets" } },
            base: { repo: { full_name: "octo/widgets" } },
          },
        },
      });
      expect(d.run).toBe(true);
      if (d.run) {
        expect(d.prNumber).toBe(5);
        expect(d.headSha).toBe("def456");
      }
    });

    test("rejects payload missing pull_request", async () => {
      const d = await gateEvent({ eventName: "pull_request", payload: { action: "opened" } });
      expect(d.run).toBe(false);
    });
  });

  describe("issue_comment", () => {
    test("the shared vectors: a created comment runs only when it is a maintainer's", async () => {
      expect(spec.vectors.length).toBeGreaterThan(0);
      const fields = ["name", "action", "author", "sender", "viaApp", "changes", "permissions", "expect"];
      for (const vector of spec.vectors) {
        // A field this test does not read would pass untested.
        expect(Object.keys(vector).filter((key) => !fields.includes(key))).toEqual([]);
        expect(["maintainer", "not", "unavailable"]).toContain(vector.expect);
        const reads: string[] = [];
        const decision = await gateEvent({
          eventName: "issue_comment",
          payload: {
            action: vector.action,
            issue: issuePr(7),
            changes: Object.fromEntries((vector.changes ?? []).map((part) => [part, { from: "earlier" }])),
            comment: {
              body: "@smithers review",
              user: vector.author,
              performed_via_github_app: vector.viaApp ? { id: 1, slug: "some-app" } : null,
            },
            sender: vector.sender,
          },
          permissionOf: reader(vector.permissions, reads),
        });
        if (vector.action !== "created") {
          // Only created comments trigger, before any permission read.
          expect({ name: vector.name, decision, reads }).toEqual({
            name: vector.name,
            decision: { run: false, reason: `issue_comment action "${vector.action}" is not "created"` },
            reads: [],
          });
          continue;
        }
        expect({ name: vector.name, run: decision.run, unavailable: !decision.run && decision.unavailable === true }).toEqual({
          name: vector.name,
          run: vector.expect === "maintainer",
          unavailable: vector.expect === "unavailable",
        });
      }
    });

    test("runs for a maintainer's comment beginning with @smithers review", async () => {
      const reads: string[] = [];
      const d = await gateEvent({
        eventName: "issue_comment",
        payload: commentEvent({ body: "@smithers review please" }),
        permissionOf: reader({ alice: "write" }, reads),
      });
      expect(d).toEqual({ run: true, eventName: "issue_comment", prNumber: 7 });
      expect(reads).toEqual(["alice"]);
    });

    test("magic phrase comparison is case-insensitive", async () => {
      const d = await gateEvent({
        eventName: "issue_comment",
        payload: commentEvent({ body: "@Smithers Review" }),
        permissionOf: reader({ alice: "admin" }),
      });
      expect(d.run).toBe(true);
    });

    test("author_association no longer admits a read or triage member", async () => {
      const d = await gateEvent({
        eventName: "issue_comment",
        payload: commentEvent({ comment: { author_association: "MEMBER" } }),
        permissionOf: reader({ alice: "read" }),
      });
      expect(d).toEqual({
        run: false,
        reason: `@alice's repository permission is "read"; write, maintain, or admin is required`,
      });
    });

    test("a comment posted through a GitHub App skips without a read", async () => {
      const reads: string[] = [];
      const d = await gateEvent({
        eventName: "issue_comment",
        payload: commentEvent({ comment: { performed_via_github_app: { id: 1, slug: "some-app" } } }),
        permissionOf: reader({ alice: "admin" }, reads),
      });
      expect(d).toEqual({ run: false, reason: "comment was posted through a GitHub App" });
      expect(reads).toEqual([]);
    });

    test("a bot sender skips without a read", async () => {
      const reads: string[] = [];
      const bot = { login: "github-actions[bot]", type: "Bot" };
      const d = await gateEvent({
        eventName: "issue_comment",
        payload: commentEvent({ comment: { user: bot }, sender: bot }),
        permissionOf: reader({ "github-actions[bot]": "write" }, reads),
      });
      expect(d).toEqual({ run: false, reason: "@github-actions[bot] is a Bot account, not a person" });
      expect(reads).toEqual([]);
    });

    test("fails closed when GitHub does not answer", async () => {
      for (const [answer, why] of [
        [502, "GitHub answered 502"],
        [403, "GitHub answered 403: a rate limit, or the job's token may not read collaborator permissions"],
        [null, "connection reset"],
      ] as const) {
        const d = await gateEvent({
          eventName: "issue_comment",
          payload: commentEvent(),
          permissionOf: reader({ alice: answer }),
        });
        expect(d).toEqual({
          run: false,
          reason: `could not read @alice's permission (${why}); failing closed`,
          unavailable: true,
        });
      }
    });

    test("fails closed without a token to read permissions", async () => {
      const d = await gateEvent({ eventName: "issue_comment", payload: commentEvent() });
      expect(d).toEqual({
        run: false,
        reason: "no GitHub token to read the commenter's permission; failing closed",
        unavailable: true,
      });
      expect(permissionReaderFromEnv({ GITHUB_REPOSITORY: "octo/widgets" })).toBeUndefined();
      expect(permissionReaderFromEnv({ GH_TOKEN: "t" })).toBeUndefined();
    });

    test("skips edited and deleted comment actions (no re-trigger on unchanged diff)", async () => {
      for (const action of ["edited", "deleted"]) {
        const d = await gateEvent({
          eventName: "issue_comment",
          payload: commentEvent({ action }),
          permissionOf: reader({ alice: "admin" }),
        });
        expect(d).toEqual({ run: false, reason: `issue_comment action "${action}" is not "created"` });
      }
    });

    test("skips issue_comment payloads with no action", async () => {
      const { action: _, ...payload } = commentEvent();
      const d = await gateEvent({ eventName: "issue_comment", payload, permissionOf: reader({ alice: "admin" }) });
      expect(d.run).toBe(false);
    });

    test("skips comments on issues that are not PRs", async () => {
      const d = await gateEvent({
        eventName: "issue_comment",
        payload: { ...commentEvent(), issue: { number: 7 } },
        permissionOf: reader({ alice: "admin" }),
      });
      expect(d).toEqual({ run: false, reason: "comment is not on a pull request" });
    });

    test("skips comments that do not begin with the magic phrase, without a read", async () => {
      const reads: string[] = [];
      const d = await gateEvent({
        eventName: "issue_comment",
        payload: commentEvent({ body: "lgtm" }),
        permissionOf: reader({ alice: "admin" }, reads),
      });
      expect(d).toEqual({ run: false, reason: 'comment does not start with "@smithers review"' });
      expect(reads).toEqual([]);
    });
  });

  describe("githubPermissionReader", () => {
    test("reads the collaborator permission with the job token", async () => {
      const requests: Request[] = [];
      const read = githubPermissionReader({
        apiUrl: "https://ghe.example/api/v3/",
        token: "job-token",
        repository: "octo/widgets",
        fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
          requests.push(new Request(input, init));
          return Response.json({ permission: "write", role_name: "maintain" });
        }) as typeof fetch,
      });
      expect(await read("a b")).toEqual({ status: 200, permission: "write" });
      expect(requests[0]?.url).toBe("https://ghe.example/api/v3/repos/octo/widgets/collaborators/a%20b/permission");
      expect(requests[0]?.headers.get("authorization")).toBe("Bearer job-token");
    });

    test("returns GitHub's status, or the failure", async () => {
      const status = githubPermissionReader({
        apiUrl: "https://api.github.com",
        token: "t",
        repository: "octo/widgets",
        fetch: (async () => new Response("", { status: 404 })) as unknown as typeof fetch,
      });
      expect(await status("ghost")).toEqual({ status: 404 });
      const broken = githubPermissionReader({
        apiUrl: "https://api.github.com",
        token: "t",
        repository: "octo/widgets",
        fetch: (async () => {
          throw new Error("getaddrinfo ENOTFOUND");
        }) as unknown as typeof fetch,
      });
      expect(await broken("alice")).toEqual({ error: "getaddrinfo ENOTFOUND" });
    });
  });

  test("unsupported events skip", async () => {
    const d = await gateEvent({ eventName: "push", payload: {} });
    expect(d.run).toBe(false);
  });

  test("null payload skips without throwing", async () => {
    const d = await gateEvent({ eventName: "pull_request", payload: null });
    expect(d.run).toBe(false);
  });
});
