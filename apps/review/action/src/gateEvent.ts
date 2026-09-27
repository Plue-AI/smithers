/**
 * Decides whether this workflow runs a review for the given GitHub event
 * payload. Two events count:
 *
 *   pull_request   non-draft same-repo PR (forks have no secrets and a
 *                  read-only token; skip them rather than fail), and only for
 *                  actions that change the reviewable diff: opened,
 *                  synchronize, reopened, ready_for_review. Everything else
 *                  (labeled, edited, assigned, …) skips with a reason.
 *   issue_comment  action is "created", comment is on a PR, body starts with
 *                  the magic phrase "@smithers review", and the comment is a
 *                  maintainer's (below).
 *
 * A comment is a maintainer's under the backend's rule, which
 * docs/api/github-maintainer-comment.vectors.json specifies for both: it was
 * not made through a GitHub App (performed_via_github_app), and its author
 * and its writer (the sender) are User accounts whose repository permission
 * is admin or write (maintain reads as write, triage as read) per
 * GET /repos/{owner}/{repo}/collaborators/{login}/permission. The comment's
 * author_association is not used: MEMBER and COLLABORATOR include read and
 * triage accounts. A permission read GitHub does not answer (403, 429, 5xx,
 * network) fails closed.
 *
 * Only "created" comments trigger. Edited and deleted comments never do:
 * re-running a review the diff has not changed for is never needed (post a
 * new comment), and it spares reading who last edited the comment.
 *
 * Returns the PR number (and the head SHA for `pull_request` events, when
 * present) so the orchestrator can pass it to the CLI.
 */
const MAGIC_PHRASE = "@smithers review";
const REVIEWABLE_PR_ACTIONS = new Set(["opened", "synchronize", "reopened", "ready_for_review"]);
const MAINTAINER_PERMISSIONS = new Set(["admin", "write"]);

/** GitHub's answer to one collaborator-permission read. */
export type PermissionAnswer =
  | { status: number; permission?: string }
  | { error: string };

/** Reads one login's repository permission. */
export type PermissionReader = (login: string) => Promise<PermissionAnswer>;

export type GateInputEvent = "pull_request" | "issue_comment";

export type GateDecision =
  | {
      run: true;
      eventName: GateInputEvent;
      prNumber: number;
      headSha?: string;
    }
  | {
      run: false;
      reason: string;
      /** GitHub did not answer a permission read: the skip fails closed. */
      unavailable?: true;
    };

export interface GateInput {
  eventName: string;
  payload: unknown;
  /** Required to admit an issue_comment; without it every comment skips. */
  permissionOf?: PermissionReader;
}

function obj(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

export async function gateEvent({ eventName, payload, permissionOf }: GateInput): Promise<GateDecision> {
  const top = obj(payload) ?? {};

  if (eventName === "pull_request") {
    const action = typeof top.action === "string" ? top.action : "";
    if (!REVIEWABLE_PR_ACTIONS.has(action)) {
      return {
        run: false,
        reason: `pull_request action "${action || "(missing)"}" does not change the diff (reviewed on: opened, synchronize, reopened, ready_for_review)`,
      };
    }
    const pr = obj(top.pull_request);
    if (!pr) return { run: false, reason: "pull_request event missing pull_request payload" };
    if (pr.draft === true) return { run: false, reason: "pull request is a draft" };
    const head = obj(pr.head);
    const base = obj(pr.base);
    const headFull = obj(head?.repo)?.full_name;
    const baseFull = obj(base?.repo)?.full_name ?? obj(top.repository)?.full_name;
    if (typeof headFull !== "string" || !headFull || typeof baseFull !== "string" || !baseFull) {
      return { run: false, reason: "pull request repository unavailable" };
    }
    if (headFull.toLowerCase() !== baseFull.toLowerCase()) {
      return { run: false, reason: "fork pull requests are not reviewed" };
    }
    const number = pr.number;
    if (typeof number !== "number") {
      return { run: false, reason: "pull_request event missing pull request number" };
    }
    const sha = typeof head?.sha === "string" ? head.sha : undefined;
    return { run: true, eventName: "pull_request", prNumber: number, headSha: sha };
  }

  if (eventName === "issue_comment") {
    const action = typeof top.action === "string" ? top.action : "";
    if (action !== "created") {
      // Only a freshly posted comment triggers a review. Editing or deleting a
      // comment that starts with the magic phrase would otherwise re-run (and
      // could be spammed to re-run) a review the diff has not changed for.
      return {
        run: false,
        reason: `issue_comment action "${action || "(missing)"}" is not "created"`,
      };
    }
    const issue = obj(top.issue);
    const comment = obj(top.comment);
    if (!issue || !obj(issue.pull_request)) {
      return { run: false, reason: "comment is not on a pull request" };
    }
    const rawBody = comment?.body;
    const body = typeof rawBody === "string" ? rawBody.trim().toLowerCase() : "";
    if (!body.startsWith(MAGIC_PHRASE)) {
      return { run: false, reason: `comment does not start with "${MAGIC_PHRASE}"` };
    }
    const denied = await commentDenial(top, comment, permissionOf);
    if (denied) return denied;
    const number = issue.number;
    if (typeof number !== "number") {
      return { run: false, reason: "issue_comment payload missing PR number" };
    }
    return { run: true, eventName: "issue_comment", prNumber: number };
  }

  return { run: false, reason: `unsupported event "${eventName}"` };
}

function actor(value: unknown): { login: string; type: string } | null {
  const fields = obj(value);
  const login = fields?.login;
  return typeof login === "string" && login.trim() ? { login, type: String(fields?.type ?? "") } : null;
}

// 403 is GitHub's secondary rate limit; the job's token always reads
// repository metadata, so it is not an answer about the account.
function transient(status: number): boolean {
  return status >= 500 || status === 429 || status === 403;
}

/** Why a created comment is not a maintainer's, or null when it is. */
async function commentDenial(
  top: Record<string, unknown>,
  comment: Record<string, unknown> | null,
  permissionOf: PermissionReader | undefined,
): Promise<GateDecision | null> {
  const viaApp = comment?.performed_via_github_app;
  if (viaApp !== undefined && viaApp !== null) {
    return { run: false, reason: "comment was posted through a GitHub App" };
  }
  // The author, then the writer, each wholly before the next, in the
  // backend's order: the first "no" or unanswered read decides.
  const read = new Set<string>();
  for (const writer of [actor(comment?.user), actor(top.sender)]) {
    if (!writer) return { run: false, reason: "comment author or sender unavailable" };
    if (writer.type !== "User") {
      return { run: false, reason: `@${writer.login} is a ${writer.type || "non-user"} account, not a person` };
    }
    if (read.has(writer.login.toLowerCase())) continue;
    read.add(writer.login.toLowerCase());
    if (!permissionOf) {
      return { run: false, reason: "no GitHub token to read the commenter's permission; failing closed", unavailable: true };
    }
    const answer = await permissionOf(writer.login);
    if ("error" in answer || transient(answer.status)) {
      const why = "error" in answer
        ? answer.error
        : answer.status === 403
          ? "GitHub answered 403: a rate limit, or the job's token may not read collaborator permissions"
          : `GitHub answered ${answer.status}`;
      return { run: false, reason: `could not read @${writer.login}'s permission (${why}); failing closed`, unavailable: true };
    }
    if (answer.status !== 200 || !MAINTAINER_PERMISSIONS.has(answer.permission ?? "")) {
      const held = answer.status === 200 ? `"${answer.permission ?? ""}"` : `unknown (GitHub answered ${answer.status})`;
      return { run: false, reason: `@${writer.login}'s repository permission is ${held}; write, maintain, or admin is required` };
    }
  }
  return null;
}

/**
 * Reads permissions with the job's GITHUB_TOKEN. Every GITHUB_TOKEN can read
 * repository metadata, which is all the endpoint needs.
 */
export function githubPermissionReader({
  apiUrl,
  token,
  repository,
  fetch: fetchImpl = fetch,
}: {
  apiUrl: string;
  token: string;
  repository: string;
  fetch?: typeof fetch;
}): PermissionReader {
  const base = apiUrl.replace(/\/+$/, "");
  return async (login) => {
    try {
      const response = await fetchImpl(
        `${base}/repos/${repository}/collaborators/${encodeURIComponent(login)}/permission`,
        {
          headers: {
            accept: "application/vnd.github+json",
            authorization: `Bearer ${token}`,
            "x-github-api-version": "2022-11-28",
          },
          signal: AbortSignal.timeout(15_000),
        },
      );
      if (response.status !== 200) return { status: response.status };
      const body = (await response.json()) as { permission?: unknown };
      return { status: 200, permission: typeof body.permission === "string" ? body.permission : undefined };
    } catch (error) {
      return { error: (error as Error).message };
    }
  };
}

/** The reader the composite steps use, or undefined without a token. */
export function permissionReaderFromEnv(env: Record<string, string | undefined> = process.env): PermissionReader | undefined {
  const token = env.GH_TOKEN?.trim();
  const repository = env.GITHUB_REPOSITORY?.trim();
  if (!token || !repository) return undefined;
  return githubPermissionReader({ apiUrl: env.GITHUB_API_URL?.trim() || "https://api.github.com", token, repository });
}
